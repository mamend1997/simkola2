'use strict';
/**
 * ==================================================================
 * CONTROL PLANE SaaS — SIMKEU Multi-Tenant
 * ------------------------------------------------------------------
 * Database terpisah (data/saas.sqlite) berisi:
 *   tenants        daftar sekolah (kode 4 karakter, paket, masa aktif, lifetime)
 *   saas_users     akun Super Admin Pusat (terpisah dari akun sekolah)
 *   sessions       SEMUA sesi login (sekolah & super admin) + tenant_id
 *   saas_payments  tagihan & pengajuan perpanjangan (QRIS manual)
 *   saas_settings  pengaturan global: QRIS, harga paket, SMTP backup, dsb.
 *
 * Data sekolah TIDAK ada di sini — setiap sekolah punya berkas SQLite
 * sendiri (lihat dbm.openTenantConn / dbm.runAsTenant).
 * ==================================================================
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const lib = require('./lib');
const dbm = require('./db');
if (dbm.DB_DRIVER === 'mysql') {
  module.exports = require('./mysql-saas');
} else {
const paygw = require('./paygw');
const clean = v => String(v === null || v === undefined ? '' : v).trim();

const S = dbm.controlDb;
S.pragma('journal_mode = WAL');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_code TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  paket TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',
  is_lifetime_free INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  registered_at TEXT,
  contact_nama TEXT, contact_email TEXT, contact_telp TEXT, alamat TEXT,
  db_file TEXT,
  logo TEXT, app_nama TEXT, tema TEXT,
  features TEXT,
  trial INTEGER NOT NULL DEFAULT 0,
  catatan TEXT,
  portal_status TEXT NOT NULL DEFAULT 'aktif',
  portal_note TEXT, portal_locked_at TEXT, portal_locked_by TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS saas_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'super_admin',
  aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT, last_login TEXT,
  mfa_secret TEXT, mfa_pending_secret TEXT,
  mfa_recovery TEXT NOT NULL DEFAULT '[]',
  mfa_enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  tenant_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'tenant',
  expires_at TEXT,
  ta_id INTEGER,
  alert_pending INTEGER NOT NULL DEFAULT 0,
  welcome TEXT,
  imp_by INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS saas_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  paket_tujuan TEXT,
  no_invoice TEXT,
  jenis TEXT NOT NULL DEFAULT 'perpanjangan',
  durasi INTEGER NOT NULL DEFAULT 30,
  nominal REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  bukti_url TEXT,
  pengirim TEXT,
  catatan TEXT,
  alasan TEXT,
  source TEXT DEFAULT 'tenant',
  periode_mulai TEXT,
  periode_akhir TEXT,
  dibuat_at TEXT,
  direview_at TEXT,
  direview_oleh TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS saas_settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS saas_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_nama TEXT, aksi TEXT,
  modul TEXT, detail TEXT, tenant_id INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS saas_backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, tenant_id INTEGER, nama_berkas TEXT,
  ukuran INTEGER, status TEXT, pesan TEXT, pemicu TEXT, tujuan TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_saas_pay_tenant ON saas_payments(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_saas_sess ON sessions(token);
CREATE TABLE IF NOT EXISTS saas_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  harga_bulan REAL NOT NULL DEFAULT 0,
  harga_tahun REAL NOT NULL DEFAULT 0,
  fitur TEXT,
  self_trial INTEGER NOT NULL DEFAULT 0,
  trial_hari INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1,
  urutan INTEGER NOT NULL DEFAULT 0,
  keterangan TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reg_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  email TEXT,
  hasil TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reg_attempts_ip ON reg_attempts(ip, created_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_identity ON auth_attempts(identity_hash, result, created_at);
CREATE TABLE IF NOT EXISTS kasera_event (
  event_id TEXT PRIMARY KEY,
  tipe TEXT, status TEXT, order_id TEXT, jumlah REAL,
  tenant_id INTEGER, sasaran TEXT, hasil TEXT, pesan TEXT,
  diterima_at TEXT, diproses_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kasera_event_waktu ON kasera_event(diterima_at);
`;

S.exec(SCHEMA);

/* ---------------- migrasi kolom control plane ---------------- */
(function migrateControl() {
  const cols = t => { try { return S.pragma(`table_info("${t}")`).map(c => c.name); } catch (e) { return []; } };
  const add = (t, name, ddl) => { if (!cols(t).includes(name)) { try { S.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${ddl}`); } catch (e) { } } };
  add('saas_payments', 'paket_tujuan', 'TEXT');
  add('saas_users', 'mfa_secret', 'TEXT');
  add('saas_users', 'mfa_pending_secret', 'TEXT');
  add('saas_users', 'mfa_recovery', "TEXT NOT NULL DEFAULT '[]'");
  add('saas_users', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0');
  /* ---- pembayaran hybrid: kolom gateway QRIS dinamis ---- */
  add('saas_payments', 'channel', "TEXT DEFAULT 'manual'");
  add('saas_payments', 'provider', 'TEXT');
  add('saas_payments', 'order_id', 'TEXT');
  add('saas_payments', 'qr_string', 'TEXT');
  add('saas_payments', 'qr_url', 'TEXT');
  add('saas_payments', 'checkout_url', 'TEXT');
  add('saas_payments', 'gateway_status', 'TEXT');
  add('saas_payments', 'paid_at', 'TEXT');
  add('saas_payments', 'expires_at', 'TEXT');
  try { S.exec('CREATE INDEX IF NOT EXISTS idx_pay_order ON saas_payments(order_id)'); } catch (e) { }
  add('saas_packages', 'self_trial', 'INTEGER NOT NULL DEFAULT 0');
  add('saas_packages', 'trial_hari', 'INTEGER');
  add('tenants', 'npsn', 'TEXT');
  add('tenants', 'server_ip', 'TEXT');
  // halaman publik (portal) — status akses ditentukan Super Admin Pusat
  add('tenants', 'portal_slug', 'TEXT');
  add('tenants', 'portal_status', "TEXT NOT NULL DEFAULT 'aktif'");
  add('tenants', 'portal_note', 'TEXT');
  add('tenants', 'portal_locked_at', 'TEXT');
  add('tenants', 'portal_locked_by', 'TEXT');
  // kredensial awal hasil pendaftaran — ditampilkan SEKALI di dashboard sekolah baru
  add('sessions', 'welcome', 'TEXT');
  /* harga langganan KHUSUS per sekolah (override harga paket; 0 = ikut paket) */
  add('tenants', 'harga_bulanan', 'INTEGER DEFAULT 0');
  add('tenants', 'harga_tahunan', 'INTEGER DEFAULT 0');
  add('tenants', 'harga_catatan', 'TEXT');
})();

/**
 * Migrasi format fitur paket lama ({std:1}) → peta fitur lengkap (array kode fitur).
 * Dijalankan sekali (flag `mig_pkgfitur_v1`); paket yang SUDAH memakai array tidak diubah.
 */
function migratePackageFeatures() {
  try {
    if (S.prepare("SELECT v FROM saas_settings WHERE k='mig_pkgfitur_v1'").get()) return;
    for (const p of S.prepare('SELECT * FROM saas_packages').all()) {
      let arr = null;
      try { const o = JSON.parse(p.fitur || 'null'); if (Array.isArray(o) && o.length) arr = o; } catch (e) { arr = null; }
      let next = arr;
      if (!next) {
        const def = DEFAULT_PACKAGES.find(d => d.kode === p.kode);
        if (def) next = def.fitur;
        else {
          const map = packageFeatureMap(p);
          next = Object.keys(map).filter(k => map[k]);
        }
      }
      if (Array.isArray(next)) S.prepare('UPDATE saas_packages SET fitur=? WHERE id=?').run(JSON.stringify(next), p.id);
    }
    const basic = S.prepare("SELECT * FROM saas_packages WHERE kode='basic'").get();
    if (basic && !Number(basic.self_trial)) S.prepare('UPDATE saas_packages SET self_trial=1 WHERE id=?').run(basic.id);
    S.prepare("INSERT OR REPLACE INTO saas_settings (k,v) VALUES ('mig_pkgfitur_v1','1')").run();
  } catch (e) { console.error('[mig-pkgfitur]', e.message); }
}

/* ---------------- pengaturan control plane ---------------- */
function get(k, d = '') {
  const r = S.prepare('SELECT v FROM saas_settings WHERE k=?').get(k);
  return r ? r.v : d;
}
function set(k, v) {
  S.prepare('INSERT INTO saas_settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(String(k), String(v ?? ''));
}
function settings() {
  const out = {};
  for (const r of S.prepare('SELECT k,v FROM saas_settings').all()) out[r.k] = r.v;
  return out;
}

const DEFAULT_SETTINGS = {
  saas_nama: 'SIMKOLA',
  saas_logo: '',
  saas_favicon: '',
  saas_tema: '#4F46E5',
  // paket default untuk pendaftaran mandiri
  paket_default: 'basic',
  // anti-spam pendaftaran
  captcha_provider: 'off',        // off | recaptcha | turnstile
  captcha_site_key: '',
  captcha_secret: '',
  reg_limit_per_hour: '2',
  reg_block_hours: '24',
  // verifikasi nomor WhatsApp pendaftar dengan kode OTP 4 digit (WA Gateway pusat)
  daftar_otp_aktif: '1',
  daftar_otp_menit: '10',
  daftar_otp_jeda: '60',
  daftar_otp_demo: '1',
  // nomor WhatsApp admin untuk informasi layanan
  wa_admin_number: '',
  // pembayaran perpanjangan
  qris_image: '',
  qris_nama: '',
  qris_nomor: '',
  qris_instruksi: 'Setelah melakukan pembayaran, unggah bukti transfer pada halaman perpanjangan. Verifikasi dilakukan maksimal 1x24 jam kerja.',
  /* ---- metode pembayaran hybrid ---- */
  pay_gateway_aktif: '0',
  pay_manual_aktif: '1',
  pay_gateway_provider: 'sandbox',
  pay_gateway_mode: 'sandbox',
  pay_gateway_merchant: '',
  pay_gateway_key: '',
  pay_gateway_key2: '',
  pay_gateway_callback: '',
  pay_gateway_expire_menit: '60',
  harga_bulan: '150000',
  harga_tahun: '1500000',
  trial_hari: '7',
  // auto-backup email (panel super admin)
  mail_aktif: '0',
  mail_to: '', mail_host: '', mail_port: '587', mail_secure: '0',
  mail_from: '', mail_user: '', mail_pass: '',
  backup_slots: '06:00,15:00',
  backup_last: ''
};
function initSettings() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    S.prepare('INSERT OR IGNORE INTO saas_settings (k,v) VALUES (?,?)').run(k, v);
  }
  // migrasi sekali: masa uji coba bawaan lama (30 hari) → 7 hari
  try {
    const flag = S.prepare("SELECT v FROM saas_settings WHERE k='mig_trial7'").get();
    if (!flag) {
      const cur = S.prepare("SELECT v FROM saas_settings WHERE k='trial_hari'").get();
      if (cur && String(cur.v) === '30') S.prepare("UPDATE saas_settings SET v='7' WHERE k='trial_hari'").run();
      S.prepare("INSERT OR REPLACE INTO saas_settings (k,v) VALUES ('mig_trial7','1')").run();
    }
  } catch (e) { }
}
initSettings();
S.transaction(() => {
  const flag = S.prepare("SELECT v FROM saas_settings WHERE k='mig_brand_simkola_v1'").get();
  if (flag) return;
  const current = S.prepare("SELECT v FROM saas_settings WHERE k='saas_nama'").get();
  if (current && ['SIMKEU', 'SIMKEU CLOUD'].includes(String(current.v || '').trim().toUpperCase())) {
    S.prepare("UPDATE saas_settings SET v='SIMKOLA' WHERE k='saas_nama'").run();
  }
  S.prepare("INSERT INTO saas_settings (k,v) VALUES ('mig_brand_simkola_v1','1')").run();
})();

/* stempel waktu lama pada control plane (audit Super Admin, log backup, dsb.)
   digeser ke WIB sekali saja — tabel `sessions` dilewati (umurnya pendek). */
try { dbm.migrateLegacyTimestamps(S, 'saas_settings'); } catch (e) { console.error('[tz-migrasi]', e.message); }

function appName() { return String(get('saas_nama', 'SIMKOLA') || 'SIMKOLA').trim() || 'SIMKOLA'; }
/**
 * Sub-judul aplikasi default (baris kecil di bawah nama aplikasi pada bilah samping).
 * Dipakai sekolah yang belum mengisi sub-judulnya sendiri di menu Tema & Branding.
 */
const APP_SUB_DEFAULT = 'Sistem Keuangan';
function appSub() { return String(get('saas_sub', APP_SUB_DEFAULT) || APP_SUB_DEFAULT).trim().slice(0, 60) || APP_SUB_DEFAULT; }
function appLogo() { return String(get('saas_logo', '') || '').trim(); }
function tema() { return String(get('saas_tema', '#4F46E5') || '#4F46E5').trim(); }
function priceOf(durasi) {
  return Number(get(String(Number(durasi) >= 365 ? 'harga_tahun' : 'harga_bulan', '0')) || 0);
}
function defaultPriceMonth() { return Number(get('harga_bulan', '150000') || 0); }
function trialDays() { return Math.max(0, Number(get('trial_hari', '30') || 0)); }

/* ---------------- daftar fitur (feature flagging) ---------------- */
const FEATURES = [
  { key: 'dashboard', label: 'Dashboard', std: 1 },
  { key: 'transaksi', label: 'Transaksi Keuangan & Approval', std: 1 },
  { key: 'rekon', label: 'Rekonsiliasi Bank', std: 1 },
  { key: 'mutasi_kas', label: 'Mutasi Bank & Cash', std: 1 },
  { key: 'tutup_bulanan', label: 'Tutup BKU Bulanan', std: 1 },
  { key: 'piutang', label: 'Piutang Pegawai & SPP', std: 1 },
  { key: 'bku', label: 'Master BKU (Buku Kas Umum)', std: 1 },
  // ---- buku pembantu dipisah agar dapat dikontrol satu per satu ----
  { key: 'pembantu_kas', label: 'Buku Pembantu Kas / Tunai', std: 1 },
  { key: 'pembantu_bank', label: 'Buku Pembantu Bank', std: 1 },
  { key: 'pembantu_pajak', label: 'Buku Pembantu Pajak', std: 1 },
  { key: 'pembantu_bhp', label: 'Rekapitulasi Barang Habis Pakai (BHP)', std: 1 },
  { key: 'pembantu_modal', label: 'Rekapitulasi Barang Modal', std: 1 },
  { key: 'coa', label: 'Kode Rekening (CoA)', std: 1 },
  { key: 'anggaran', label: 'Anggaran RAPBS', std: 1 },
  { key: 'saldo_awal', label: 'Saldo Awal', std: 1 },
  { key: 'aset', label: 'Aset Riil & Ledger', std: 1 },
  { key: 'import', label: 'Import Excel BKU', std: 1 },
  { key: 'tahun_ajaran', label: 'Tahun Pelajaran & Rollover', std: 1 },
  { key: 'laporan', label: 'Laporan & Export', std: 1 },
  { key: 'pengguna', label: 'Pengguna & Hak Akses', std: 1 },
  // ---- kontrol tampilan & identitas dipisah satu per satu (ronde 26) ----
  { key: 'identitas', label: 'Identitas Sekolah (NPSN, kontak & legalitas)', std: 1 },
  { key: 'portal_publik', label: 'Portal Publik (slug, subdomain & custom domain)', std: 1 },
  { key: 'tema', label: 'Tema & Branding (warna, logo, mode gelap)', std: 1 },
  { key: 'desain_cetak', label: 'Desain Templat Cetak (kop surat & ukuran kuitansi)', std: 1 },
  { key: 'trash', label: 'Kotak Sampah', std: 1 },
  { key: 'audit', label: 'Audit Log', std: 1 },
  { key: 'backup', label: 'Backup & Restore Manual', std: 1 },
  { key: 'panduan', label: 'Petunjuk Pengguna', std: 1 },
  { key: 'piutang_lain', label: 'Piutang Sertifikasi', std: 0 },
  { key: 'piutang_lainnya', label: 'Piutang Lainnya', std: 0 },
  // data siswa, kelas & iuran adalah fitur INTI (semua paket) — sekolah butuh
  // master kelas/tingkat untuk tagihan dan laporan per tingkat.
  { key: 'siswa', label: 'Data Siswa', std: 1 },
  { key: 'kelas', label: 'Data Kelas & Tingkat', std: 1 },
  { key: 'program', label: 'Program Keahlian', std: 1 },
  { key: 'mutasi_kelas', label: 'Mutasi Kelas', std: 1 },
  { key: 'iuran', label: 'Grup Iuran, SPP & Antrean Posting', std: 1 },
  { key: 'pegawai', label: 'Data Pegawai', std: 0 },
  { key: 'payroll', label: 'Payroll & Leger Honor', std: 0 },
  { key: 'ekskul', label: 'Honor Pembina Ekskul', std: 0 },
  { key: 'beasiswa', label: 'Beasiswa SPP', std: 0 },
  { key: 'catatan', label: 'Catatan Pegawai & Orang Tua', std: 0 },
  { key: 'tarif_honor', label: 'Nominal Tunjangan & Honor', std: 0 },
  { key: 'backup_cloud', label: 'Auto-Backup Cloud & Email', std: 0 }
];
const FEATURE_MAP = FEATURES.reduce((m, f) => { m[f.key] = f; return m; }, {});
/**
 * Fitur baru yang "mewarisi" nilai fitur lama saat paket/tenant belum memiliki kuncinya.
 * Contoh: paket lama hanya punya `sekolah` → identitas/tema/desain_cetak/portal_publik ikut nilainya.
 */
const FEATURE_PARENT = {
  identitas: 'sekolah', portal_publik: 'sekolah', tema: 'sekolah', desain_cetak: 'sekolah',
  pembantu_kas: 'bku', pembantu_bank: 'bku', pembantu_pajak: 'bku', pembantu_bhp: 'bku', pembantu_modal: 'bku'
};

/**
 * Pemetaan alamat URL → fitur. Dipakai untuk MEMBLOKIR akses langsung
 * (direct URL) ketika fitur dimatikan Super Admin. Urutan penting:
 * awalan paling spesifik lebih dulu.
 */
const PATH_FEATURES = [
  ['/piutang-lainnya', 'piutang_lainnya'], ['/piutang-lain', 'piutang_lain'],
  ['/catatan-pegawai', 'catatan'], ['/catatan-orangtua', 'catatan'], ['/pesan-orangtua', 'catatan'],
  ['/mutasi-kelas', 'mutasi_kelas'], ['/program-keahlian', 'program'],
  ['/siswa-nonaktif', 'siswa'], ['/siswa', 'siswa'],
  ['/kelas', 'kelas'],
  ['/iuran', 'iuran'], ['/pembayaran-online', 'iuran'], ['/spp', 'iuran'],
  ['/payroll', 'payroll'], ['/pegawai', 'pegawai'],
  ['/ekskul', 'ekskul'], ['/beasiswa', 'beasiswa'],
  ['/tarif-honor', 'tarif_honor'],
  ['/pengaturan-backup', 'backup_cloud'],
  ['/backup', 'backup'],
  ['/tutup-bulanan', 'tutup_bulanan'], ['/rekon', 'rekon'], ['/mutasi-kas', 'mutasi_kas'],
  ['/transaksi', 'transaksi'], ['/approval', 'transaksi'],
  ['/import', 'import'], ['/anggaran', 'anggaran'], ['/saldo-awal', 'saldo_awal'],
  ['/bku', 'bku'], ['/coa', 'coa'], ['/aset', 'aset'],
  ['/tahun-ajaran', 'tahun_ajaran'],
  ['/laporan', 'laporan'], ['/cetak', 'laporan'], ['/export', 'laporan'],
  ['/pengguna', 'pengguna'], ['/audit', 'audit'], ['/trash', 'trash'],
  ['/sekolah/domain', 'portal_publik'], ['/sekolah/portal', 'portal_publik'],
  ['/portal-publik', 'portal_publik'],
  ['/desain-cetak', 'desain_cetak'], ['/tema', 'tema'], ['/sekolah', 'identitas'],
  ['/tampilan-menu', 'pengguna'], ['/petunjuk', 'panduan'],
  ['/piutang', 'piutang']
];

function featureDefaults(paket) {
  const out = {};
  for (const f of FEATURES) out[f.key] = paket === 'pro' ? 1 : (f.std ? 1 : 0);
  return out;
}
function parseFeatures(raw, paket) {
  const base = featureDefaults(paket);
  let obj = {};
  try { obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch (e) { obj = {}; }
  const out = {};
  for (const f of FEATURES) {
    let v = obj[f.key];
    const parent = FEATURE_PARENT[f.key];
    if (v === undefined && parent && obj[parent] !== undefined) v = obj[parent];
    out[f.key] = (v === undefined) ? base[f.key] : (Number(v) ? 1 : 0);
  }
  return out;
}
function tenantFeatures(t) {
  if (!t) return featureDefaults('pro');
  return parseFeatures(t.features, t.paket || 'standard');
}
function enabledKeys(t) {
  const f = tenantFeatures(t);
  return FEATURES.filter(x => f[x.key]).map(x => x.key);
}
/** fitur yang dimatikan untuk path ini (null = tidak dibatasi) */
function blockedFeature(t, pathname) {
  if (!t) return null;
  const on = tenantFeatures(t);
  for (const [prefix, key] of PATH_FEATURES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/') || pathname.startsWith(prefix + '?')) {
      return on[key] ? null : (FEATURE_MAP[key] ? FEATURE_MAP[key].label : key);
    }
  }
  return null;
}

/* ---------------- tenant (sekolah) ---------------- */
/* Paket langganan dinamis (CRUD di panel Super Admin). `PAKET` tetap tersedia
   sebagai label cepat dan selalu disegarkan dari tabel saas_packages. */
const PAKET = { basic: 'Basic', standard: 'Standard', pro: 'Pro' };

const DEFAULT_PACKAGES = [
  {
    kode: 'basic', nama: 'Basic', bulan: 100000, tahun: 1000000, default: 1, selfTrial: 1,
    ket: 'BKU, transaksi, laporan, piutang, aset, backup',
    fitur: ['dashboard', 'transaksi', 'rekon', 'mutasi_kas', 'tutup_bulanan', 'piutang', 'bku', 'coa',
      'anggaran', 'saldo_awal', 'aset', 'import', 'tahun_ajaran', 'laporan', 'pengguna', 'sekolah',
      'trash', 'audit', 'backup', 'panduan', 'siswa', 'kelas', 'program', 'mutasi_kelas', 'iuran',
      'identitas', 'portal_publik', 'tema', 'desain_cetak',
      'pembantu_kas', 'pembantu_bank', 'pembantu_pajak', 'pembantu_bhp', 'pembantu_modal']
  },
  {
    kode: 'standard', nama: 'Standard', bulan: 150000, tahun: 1500000, default: 0, selfTrial: 0,
    ket: 'Basic + pegawai, piutang sertifikasi & lainnya, catatan',
    fitur: ['dashboard', 'transaksi', 'rekon', 'mutasi_kas', 'tutup_bulanan', 'piutang', 'bku', 'coa',
      'anggaran', 'saldo_awal', 'aset', 'import', 'tahun_ajaran', 'laporan', 'pengguna', 'sekolah',
      'trash', 'audit', 'backup', 'panduan', 'siswa', 'kelas', 'program', 'mutasi_kelas', 'iuran',
      'pegawai', 'piutang_lain', 'piutang_lainnya', 'catatan', 'tarif_honor',
      'identitas', 'portal_publik', 'tema', 'desain_cetak',
      'pembantu_kas', 'pembantu_bank', 'pembantu_pajak', 'pembantu_bhp', 'pembantu_modal']
  },
  {
    kode: 'pro', nama: 'Pro', bulan: 250000, tahun: 2500000, default: 0, selfTrial: 0,
    ket: 'Semua fitur: payroll, ekskul, beasiswa, auto-backup cloud',
    fitur: FEATURES.map(f => f.key)
  }
];
function seedPackages() {
  const n = S.prepare('SELECT COUNT(*) c FROM saas_packages').get().c;
  if (n) return;
  const ins = S.prepare(`INSERT OR IGNORE INTO saas_packages
    (kode,nama,harga_bulan,harga_tahun,fitur,self_trial,is_default,aktif,urutan,keterangan,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`);
  const now = lib.nowStamp();
  DEFAULT_PACKAGES.forEach((p, i) => ins.run(p.kode, p.nama, p.bulan, p.tahun,
    JSON.stringify(packageFeatureMap({ fitur: JSON.stringify(p.fitur || []) }, p.kode)),
    p.selfTrial ? 1 : 0, p.default, i + 1, p.ket, now, now));
}

/* ---------------- fitur per PAKET (dapat diatur di menu Paket Langganan) ---------------- */
/**
 * Peta fitur satu paket. `fitur` disimpan sebagai JSON:
 *   · array kode fitur  → ["dashboard","transaksi", …]
 *   · objek {kode:0|1}  → format lama
 * Bila kosong/rusak → jatuh ke preset (pro = semua fitur, lainnya = preset standard).
 */
function packageFeatureMap(pkg, kodeFallback) {
  const kode = String((pkg && pkg.kode) || kodeFallback || 'basic').toLowerCase();
  let raw = pkg && pkg.fitur;
  let obj = null;
  try { obj = typeof raw === 'string' ? JSON.parse(raw || 'null') : (raw || null); } catch (e) { obj = null; }
  if (Array.isArray(obj) && obj.length) {
    const set = new Set(obj.map(x => String(x)));
    const out = {};
    for (const f of FEATURES) {
      const parent = FEATURE_PARENT[f.key];
      out[f.key] = set.has(f.key) ? 1 : (parent && set.has(parent) ? 1 : 0);
    }
    return out;
  }
  if (obj && typeof obj === 'object' && Object.keys(obj).length) {
    return parseFeatures(obj, kode === 'pro' ? 'pro' : 'standard');
  }
  return featureDefaults(kode === 'pro' ? 'pro' : 'standard');
}
/** daftar label fitur aktif sebuah paket (untuk kartu di halaman pendaftaran) */
function packageFeatureLabels(pkg) {
  const map = packageFeatureMap(pkg);
  return FEATURES.filter(f => map[f.key]).map(f => f.label);
}
/** paket yang boleh didaftarkan mandiri (langsung aktif dengan masa uji coba) */
function packageSelfTrial(pkg) {
  return !!(pkg && Number(pkg.self_trial));
}
function packageTrialDays(pkg) {
  const raw = pkg && pkg.trial_hari;
  if (raw === null || raw === undefined || raw === '') return trialDays();
  const d = Number(raw);
  return Number.isFinite(d) && d >= 0 ? d : trialDays();
}
function packageRows(opts = {}) {
  try {
    return S.prepare('SELECT * FROM saas_packages' + (opts.all ? '' : ' WHERE aktif=1') + ' ORDER BY urutan, id').all();
  } catch (e) { return []; }
}
function packageByKode(kode) {
  return S.prepare('SELECT * FROM saas_packages WHERE kode=?').get(String(kode || '').trim().toLowerCase()) || null;
}
function packageById(id) { return S.prepare('SELECT * FROM saas_packages WHERE id=?').get(Number(id) || 0) || null; }
function defaultPackage() {
  const d = S.prepare('SELECT * FROM saas_packages WHERE is_default=1 AND aktif=1 ORDER BY urutan LIMIT 1').get();
  return d || packageRows()[0] || { kode: 'basic', nama: 'Basic', harga_bulan: 0, harga_tahun: 0 };
}
function packageLabels() {
  const out = {};
  for (const p of packageRows({ all: true })) out[p.kode] = p.nama;
  return out;
}
function packagePrice(kode, durasi) {
  const p = packageByKode(kode);
  if (p) return Number(Number(durasi) >= 365 ? p.harga_tahun : p.harga_bulan) || 0;
  return priceOf(durasi);
}
/**
 * Harga efektif seorang TENANT: bila Super Admin mengisi harga khusus pada profil
 * sekolah, nilai itu yang dipakai (tagihan & QRIS); 0 / kosong = ikut harga paket.
 */
function hargaTenant(t, kode, durasi) {
  if (!t) return packagePrice(kode, durasi);
  const tahunan = Number(durasi) >= 365;
  const hb = Number(t.harga_bulanan) || 0;
  const ht = Number(t.harga_tahunan) || 0;
  if (tahunan) {
    if (ht > 0) return Math.round(ht);
    if (hb > 0) return Math.round(hb * 12);
  } else if (hb > 0) return Math.round(hb);
  return Math.round(packagePrice(kode, durasi) || 0);
}
function packageSave(d) {
  const nama = String(d.nama || '').trim();
  if (!nama) throw new Error('Nama paket wajib diisi.');
  let kode = String(d.kode || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!kode) kode = nama.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'paket';
  const bulan = Math.max(0, Number(String(d.harga_bulan || '0').replace(/[^\d]/g, '')) || 0);
  const tahun = Math.max(0, Number(String(d.harga_tahun || '0').replace(/[^\d]/g, '')) || 0);
  const now = lib.nowStamp();
  const aktif = d.aktif === undefined ? 1 : (d.aktif ? 1 : 0);
  const selfTrial = d.self_trial ? 1 : 0;
  const trialHari = d.trial_hari === undefined || d.trial_hari === '' ? null
    : Math.max(0, Math.min(365, Number(d.trial_hari) || 0));
  // peta fitur: array kode fitur (checkbox) → JSON; undefined = pertahankan nilai lama
  const fiturJson = Array.isArray(d.fitur) ? JSON.stringify(d.fitur) : null;
  if (d.id && packageById(d.id)) {
    const cur = packageById(d.id);
    S.prepare(`UPDATE saas_packages SET kode=?,nama=?,harga_bulan=?,harga_tahun=?,fitur=?,self_trial=?,trial_hari=?,keterangan=?,urutan=?,aktif=?,updated_at=? WHERE id=?`)
      .run(kode, nama, bulan, tahun, fiturJson === null ? (cur.fitur || '{}') : fiturJson, selfTrial, trialHari,
        String(d.keterangan || ''), Number(d.urutan) || cur.urutan, aktif, now, cur.id);
    return packageById(cur.id);
  }
  if (packageByKode(kode)) throw new Error('Kode paket "' + kode + '" sudah dipakai.');
  const info = S.prepare(`INSERT INTO saas_packages
    (kode,nama,harga_bulan,harga_tahun,fitur,self_trial,trial_hari,is_default,aktif,urutan,keterangan,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)`).run(kode, nama, bulan, tahun,
    fiturJson === null ? JSON.stringify(featureDefaults('standard')) : fiturJson,
    selfTrial, trialHari, aktif,
    Number(d.urutan) || (packageRows({ all: true }).length + 1), String(d.keterangan || ''), now, now);
  return packageById(Number(info.lastInsertRowid));
}
function packageDelete(id) {
  const p = packageById(id);
  if (!p) return null;
  const used = S.prepare('SELECT COUNT(*) c FROM tenants WHERE paket=?').get(p.kode).c;
  if (used) throw new Error(`Paket "${p.nama}" masih dipakai ${used} sekolah. Pindahkan sekolah ke paket lain lebih dulu.`);
  if (Number(p.is_default)) throw new Error('Paket default tidak dapat dihapus. Tandai paket lain sebagai default lebih dulu.');
  S.prepare('DELETE FROM saas_packages WHERE id=?').run(p.id);
  return p;
}
function packageSetDefault(id) {
  const p = packageById(id);
  if (!p) throw new Error('Paket tidak ditemukan.');
  S.prepare('UPDATE saas_packages SET is_default=0').run();
  S.prepare('UPDATE saas_packages SET is_default=1, aktif=1 WHERE id=?').run(p.id);
  set('paket_default', p.kode);
  return packageById(p.id);
}

/* ---------------- kontak admin untuk paket berbayar ---------------- */
function waAdminNumber() {
  return normalizeWa(get('wa_admin_number', '') || '');
}
function normalizeWa(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '62' + s.slice(1);
  if (s.startsWith('8')) s = '62' + s;
  return s;
}
/**
 * Tautan WhatsApp admin untuk paket yang HARUS BAYAR dulu.
 * Pesan otomatis memuat nama paket & harga. null bila nomor admin belum diatur.
 */
function waAdminLink(pkg, extra = {}) {
  const num = waAdminNumber();
  if (!num) return null;
  const nama = String((pkg && pkg.nama) || 'paket langganan');
  const harga = pkg ? Number(pkg.harga_bulan) || 0 : 0;
  const lines = [
    `Halo Admin ${appName()}, saya ingin berlangganan paket *${nama}*.`,
    harga ? `Harga paket: Rp ${harga.toLocaleString('id-ID')} / bulan` : '',
    extra.sekolah ? `Sekolah: ${extra.sekolah}` : '',
    extra.admin ? `Nama admin: ${extra.admin}` : '',
    'Mohon informasi pembayaran & aktivasi. Terima kasih.'
  ].filter(Boolean);
  return 'https://wa.me/' + num + '?text=' + encodeURIComponent(lines.join('\n'));
}

/* ---------------- anti-spam pendaftaran ---------------- */
function clientIpOf(req) {
  const f = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim();
  const ip = f || String((req.socket && req.socket.remoteAddress) || '').trim();
  return ip.replace(/^::ffff:/, '') || 'unknown';
}
function regLimits() {
  return {
    perHour: Math.max(1, Number(get('reg_limit_per_hour', '2')) || 2),
    blockHours: Math.max(0, Number(get('reg_block_hours', '24')) || 24)
  };
}
function regLog(ip, email, hasil) {
  try {
    S.prepare('INSERT INTO reg_attempts (ip,email,hasil,created_at) VALUES (?,?,?,?)').run(String(ip || ''), String(email || ''), String(hasil || ''), lib.nowStamp());
    // pangkas riwayat > 30 hari
    S.prepare("DELETE FROM reg_attempts WHERE created_at < ?").run(lib.addDays ? lib.addDays(lib.todayISO(), -30) : lib.todayISO());
  } catch (e) { }
}
/** status rate limit sebuah IP: { blocked, retryAfter, count } */
function regStatus(ip) {
  const lim = regLimits();
  const now = Date.now();
  const rows = S.prepare("SELECT * FROM reg_attempts WHERE ip=? ORDER BY id DESC LIMIT 50").all(String(ip || ''));
  // blokir aktif?
  const blockedRow = rows.find(r => r.hasil === 'blocked');
  if (blockedRow) {
    const at = new Date(String(blockedRow.created_at).replace(' ', 'T') + 'Z').getTime();
    const until = at + lim.blockHours * 3600 * 1000;
    if (now < until) return { blocked: true, until, retryMin: Math.ceil((until - now) / 60000), count: rows.length };
  }
  const hourAgo = lib.plusMinutesStamp(-60);   // jam WIB, sama dengan created_at
  const count = S.prepare("SELECT COUNT(*) c FROM reg_attempts WHERE ip=? AND created_at>=? AND hasil IN ('sukses','gagal')").get(String(ip || ''), hourAgo).c;
  return { blocked: false, count, limit: lim.perHour };
}
/** catat percobaan; kembalikan { blocked:true } bila melewati batas */
function regHit(ip, email, hasil) {
  const lim = regLimits();
  const st = regStatus(ip);
  if (st.blocked) return { blocked: true, ...st };
  regLog(ip, email, hasil);
  const after = regStatus(ip);
  if (!after.blocked && after.count > lim.perHour && hasil !== 'blocked') {
    regLog(ip, email, 'blocked');
    return { blocked: true, ...regStatus(ip), justBlocked: true };
  }
  return { blocked: false, ...after };
}
/** verifikasi captcha (reCAPTCHA v3 / Cloudflare Turnstile); null = lolos */
async function verifyCaptcha(token, ip) {
  const provider = String(get('captcha_provider', 'off') || 'off');
  if (provider === 'off') return null;
  const secret = String(get('captcha_secret', '') || '');
  if (!secret) return null;   // belum dikonfigurasi → jangan blokir pendaftaran
  const t = String(token || '').trim();
  if (!t) return 'Verifikasi keamanan (captcha) gagal. Muat ulang halaman lalu coba lagi.';
  const url = provider === 'turnstile'
    ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
    : 'https://www.google.com/recaptcha/api/siteverify';
  try {
    const body = new URLSearchParams({ secret, response: t });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const j = await r.json();
    if (!j || j.success !== true) return 'Verifikasi keamanan (captcha) gagal. Silakan coba lagi.';
    // reCAPTCHA v3: skor minimal 0.4
    if (provider === 'recaptcha' && j.score !== undefined && Number(j.score) < 0.4) {
      return 'Permintaan terdeteksi otomatis (skor keamanan rendah). Silakan coba lagi.';
    }
    return null;
  } catch (e) {
    return 'Verifikasi keamanan tidak dapat dihubungi. Coba beberapa saat lagi.';
  }
}
function captchaConfig() {
  return {
    provider: String(get('captcha_provider', 'off') || 'off'),
    siteKey: String(get('captcha_site_key', '') || '')
  };
}

function allTenants() {
  return S.prepare('SELECT * FROM tenants ORDER BY id').all();
}
function tenantById(id) {
  return S.prepare('SELECT * FROM tenants WHERE id=?').get(Number(id) || 0) || null;
}
function tenantByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return S.prepare('SELECT * FROM tenants WHERE upper(school_code)=?').get(c) || null;
}
function codeExists(code, exceptId) {
  const r = S.prepare('SELECT id FROM tenants WHERE upper(school_code)=upper(?)').get(String(code || ''));
  return !!(r && Number(r.id) !== Number(exceptId || 0));
}
function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}
/** kode sekolah unik 4 karakter (SK01, SK02, …) */
/**
 * Kode sekolah 4 karakter ACAK & unik (alfanumerik, tanpa huruf/angka ambigu
 * seperti O/0 dan I/1) — mis. K9B2, 7X4M, 3918. Bukan urutan statis (SK01/SK02).
 */
function nextSchoolCode() {
  const used = new Set(allTenants().map(t => String(t.school_code || '').toUpperCase()));
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = n => Math.floor(Math.random() * n);
  for (let i = 0; i < 4000; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += chars[rnd(chars.length)];
    if (!used.has(c)) return c;
  }
  // cadangan: kombinasi berbasis waktu (tetap 4 karakter)
  for (let i = 0; i < 500; i++) {
    const c = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase()
      .replace(/[^A-Z0-9]/g, '').slice(0, 4).padEnd(4, 'X');
    if (c.length === 4 && !used.has(c)) return c;
  }
  throw new Error('Gagal membuat kode sekolah unik. Coba lagi.');
}

function todayISO() { return lib.todayISO(); }
function addDays(iso, days) {
  const d = new Date(String(iso || todayISO()).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromISO, toISO) {
  const a = new Date(String(fromISO).slice(0, 10) + 'T00:00:00Z');
  const b = new Date(String(toISO).slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/** status lengkap satu sekolah (lifetime selalu menang) */
function statusOf(t) {
  if (!t) return { key: 'none', label: 'Tidak ditemukan', color: 'gray', daysLeft: null };
  const today = todayISO();
  if (Number(t.is_lifetime_free)) {
    return { key: 'lifetime', label: 'Aktif (Lifetime)', color: 'green', daysLeft: null };
  }
  const exp = t.expires_at ? String(t.expires_at).slice(0, 10) : '';
  const days = exp ? daysBetween(today, exp) : null;
  if (days !== null && days < 0) return { key: 'expired', label: 'Kadaluarsa', color: 'red', daysLeft: days };
  if (String(t.status) === 'suspended') return { key: 'suspended', label: 'Ditangguhkan', color: 'red', daysLeft: days };
  if (days !== null && days <= 7) return { key: 'soon', label: 'Segera Berakhir', color: 'amber', daysLeft: days };
  return { key: 'active', label: 'Aktif', color: 'green', daysLeft: days };
}
/** akun yang harus diblokir (lifetime kebal auto-suspend) */
function isBlocked(t) {
  if (!t) return true;
  if (Number(t.is_lifetime_free)) return false;
  const st = statusOf(t);
  return st.key === 'expired' || st.key === 'suspended';
}

function logSaas(user, aksi, modul, detail, tenantId) {
  const t = lib.nowStamp();
  try {
    S.prepare('INSERT INTO saas_audit (user_id,user_nama,aksi,modul,detail,tenant_id,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(user ? user.id : null, user ? user.nama : 'sistem', aksi, modul, detail || '', tenantId || null, t);
  } catch (e) { }
  // masuk juga ke audit log terpusat (menu Audit Logs Super Admin)
  try {
    const tn = tenantId ? ((S.prepare('SELECT nama FROM tenants WHERE id=?').get(Number(tenantId)) || {}).nama || '') : '';
    S.prepare(`INSERT INTO audit_log (tenant_id,tenant_nama,user_id,user_nama,role,ip,aksi,modul,detail,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId ? Number(tenantId) : null, tn,
      user ? user.id : null, user ? user.nama : 'sistem', 'super_admin', '',
      String(aksi || ''), String(modul || ''), String(detail || ''), t);
  } catch (e) { }
}

/**
 * Buat sekolah baru: baris tenant di control plane + database sendiri
 * (skema lengkap, master dasar, akun admin sekolah).
 */
function createTenant(input = {}) {
  const nama = String(input.nama || '').trim();
  if (!nama) throw new Error('Nama sekolah wajib diisi.');
  const email = String(input.admin_email || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email admin sekolah tidak valid.');
  // paket: pilihan valid = kode pada master paket; default mengikuti paket default Super Admin
  let paket = String(input.paket || '').trim().toLowerCase();
  if (!paket || !packageByKode(paket)) paket = defaultPackage().kode;
  let code = normalizeCode(input.school_code);
  if (code) {
    if (code.length !== 4) throw new Error('Kode sekolah harus 4 karakter (huruf/angka).');
    if (codeExists(code)) throw new Error('Kode sekolah ' + code + ' sudah dipakai sekolah lain.');
  } else {
    code = nextSchoolCode();
  }
  const lifetime = Number(input.is_lifetime_free) ? 1 : 0;
  const trial = input.trial === false ? false : !lifetime;
  // fitur & masa uji coba mengikuti PAKET yang dipilih (diatur di menu Paket Langganan)
  const pkgRow = packageByKode(paket);
  const featDefault = packageFeatureMap(pkgRow, paket);
  const pkgTrial = pkgRow && pkgRow.trial_hari !== null && pkgRow.trial_hari !== undefined ? Number(pkgRow.trial_hari) : null;
  const days = Number(input.days || (input.trial === false ? 365 : (pkgTrial !== null ? pkgTrial : trialDays())) || 30);
  const expires = input.expires_at ? String(input.expires_at).slice(0, 10)
    : (lifetime ? null : addDays(todayISO(), days));
  const now = lib.nowStamp();
  // ---- default branding sistem (menu Branding Sistem Super Admin) ----
  // Sekolah baru otomatis memakai nama aplikasi & logo default sistem; admin sekolah tetap bisa mengubahnya.
  const sysNama = String(get('saas_nama', '') || 'SIMKOLA').trim() || 'SIMKOLA';
  const sysLogo = String(get('saas_logo', '') || '').trim();
  const appNama = String(input.app_nama || '').trim() || sysNama;
  const logoAwal = String(input.logo || '').trim() || sysLogo;

  const info = S.prepare(`INSERT INTO tenants
    (school_code,nama,paket,status,is_lifetime_free,expires_at,registered_at,contact_nama,contact_email,contact_telp,alamat,
     db_file,logo,app_nama,tema,features,trial,catatan,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, nama, paket, 'active', lifetime, expires, todayISO(),
      String(input.contact_nama || input.admin_nama || ''), email, String(input.contact_telp || ''),
      String(input.alamat || ''), '', logoAwal,
      appNama, String(input.tema || ''),
      JSON.stringify(featDefault), lifetime ? 0 : (trial ? 1 : 0),
      String(input.catatan || ''), now, now);
  const id = Number(info.lastInsertRowid);
  // berkas database sekolah baru mengikuti folder database utama (DB_PATH),
  // bukan selalu folder data aplikasi — supaya tes dengan DB sementara tidak menulis ke folder live
  // slug portal default dari nama sekolah (mis. "SDN 1 Jakarta" → sdn-1-jakarta)
  try {
    const slugFn = module.exports.slugFromName;
    const slug = slugFn ? slugFn(nama, id) : String(nama).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    S.prepare('UPDATE tenants SET portal_slug=? WHERE id=?').run(slug, id);
  } catch (e) { }
  const file = path.join(path.dirname(dbm.DB_PATH), 'tenants', 'tenant-' + id + '.db');
  S.prepare('UPDATE tenants SET db_file=? WHERE id=?').run(file, id);
  const tenant = tenantById(id);

  dbm.createTenantDatabase({
    id, file, school_code: code, nama,
    jenjang: String(input.jenjang || ''),
    admin_email: email,
    admin_password: String(input.admin_password || 'sekolah123'),
    admin_nama: String(input.admin_nama || 'Administrator Sekolah'),
    alamat: String(input.alamat || ''),
    kepala: String(input.kepala || ''),
    app_nama: appNama,
    logo: logoAwal,
    tema: String(input.tema || '')
  });
  // preset tampilan menu default dari Super Admin (menu yang tampil, urutan & judul)
  try {
    let tpl = {};
    try { tpl = JSON.parse(get('school_menu_default', '{}') || '{}') || {}; } catch (e) { tpl = {}; }
    if (tpl && (Array.isArray(tpl.hidden) || tpl.navUi)) {
      dbm.runAsTenant(tenant, () => {
        dbm.setSetting('nav_hidden', (Array.isArray(tpl.hidden) ? tpl.hidden : []).join(','));
        dbm.setNavUi(tpl.navUi || {});
      });
    }
  } catch (e) { console.error('[menu-default]', e.message); }
  logSaas(input.user, 'TAMBAH SEKOLAH', 'tenant', `Sekolah ${nama} (${code}) paket ${PAKET[paket]}${lifetime ? ' · LIFETIME' : ' · s.d. ' + expires}`, id);
  return tenant;
}

function updateTenant(id, patch = {}) {
  const t = tenantById(id);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  const f = Object.assign({}, t, patch);
  if (patch.school_code !== undefined) {
    const code = normalizeCode(patch.school_code);
    if (code.length !== 4) throw new Error('Kode sekolah harus 4 karakter.');
    if (codeExists(code, id)) throw new Error('Kode sekolah ' + code + ' sudah dipakai.');
    f.school_code = code;
  }
  if (f.paket && !PAKET[f.paket]) throw new Error('Paket tidak dikenal.');
  S.prepare(`UPDATE tenants SET school_code=?,nama=?,paket=?,status=?,is_lifetime_free=?,expires_at=?,
      contact_nama=?,contact_email=?,contact_telp=?,alamat=?,app_nama=?,tema=?,logo=?,catatan=?,features=?,
      harga_bulanan=?,harga_tahunan=?,harga_catatan=?,updated_at=? WHERE id=?`)
    .run(f.school_code, String(f.nama || '').trim() || t.nama, f.paket || 'standard', f.status || 'active',
      Number(f.is_lifetime_free) ? 1 : 0, f.expires_at ? String(f.expires_at).slice(0, 10) : null,
      f.contact_nama || '', f.contact_email || '', f.contact_telp || '', f.alamat || '',
      f.app_nama || '', f.tema || '', f.logo || '', f.catatan || '',
      typeof f.features === 'string' ? f.features : JSON.stringify(f.features || featureDefaults(f.paket || 'standard')),
      Math.max(0, Math.round(Number(String(f.harga_bulanan === undefined ? t.harga_bulanan : f.harga_bulanan).replace(/[^\d]/g, '')) || 0)),
      Math.max(0, Math.round(Number(String(f.harga_tahunan === undefined ? t.harga_tahunan : f.harga_tahunan).replace(/[^\d]/g, '')) || 0)),
      f.harga_catatan === undefined ? (t.harga_catatan || '') : String(f.harga_catatan || ''),
      lib.nowStamp(), id);
  logSaas(patch.user, 'EDIT SEKOLAH', 'tenant', `Memperbarui sekolah ${f.nama} (${f.school_code})`, id);
  return tenantById(id);
}

/**
 * Ubah paket langganan sebuah sekolah (upgrade/downgrade).
 * Fitur mengikuti preset paket (Pro = semua fitur, selain itu preset Standard).
 */
function setPackage(id, kode, user) {
  const t = tenantById(id);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  const p = packageByKode(kode);
  if (!p) throw new Error('Paket tidak ditemukan.');
  const feats = packageFeatureMap(p);
  S.prepare('UPDATE tenants SET paket=?,features=?,updated_at=? WHERE id=?')
    .run(p.kode, JSON.stringify(feats), lib.nowStamp(), id);
  logSaas(user, 'UBAH PAKET', 'tenant', `${t.nama}: ${t.paket} → ${p.kode}`, id);
  return tenantById(id);
}

function setFeatures(id, map, user) {
  const t = tenantById(id);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  const clean = parseFeatures(map, t.paket);
  S.prepare('UPDATE tenants SET features=?,updated_at=? WHERE id=?').run(JSON.stringify(clean), lib.nowStamp(), id);
  const off = Object.keys(clean).filter(k => !clean[k]);
  logSaas(user, 'FITUR SEKOLAH', 'tenant', `${t.nama}: ${Object.keys(clean).length - off.length} fitur aktif` + (off.length ? `, dimatikan: ${off.join(', ')}` : ''), id);
  return clean;
}
function setLifetime(id, on, user) {
  const t = tenantById(id);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  if (Number(on)) {
    S.prepare("UPDATE tenants SET is_lifetime_free=1,status='active',expires_at=NULL,updated_at=? WHERE id=?").run(lib.nowStamp(), id);
    logSaas(user, 'LIFETIME ON', 'tenant', `${t.nama} (${t.school_code}) dibebaskan dari penagihan & auto-suspend`, id);
  } else {
    const exp = t.expires_at && String(t.expires_at).slice(0, 10) >= todayISO() ? t.expires_at : addDays(todayISO(), 30);
    S.prepare("UPDATE tenants SET is_lifetime_free=0,expires_at=?,updated_at=? WHERE id=?").run(exp, lib.nowStamp(), id);
    logSaas(user, 'LIFETIME OFF', 'tenant', `${t.nama} (${t.school_code}) kembali berlangganan, aktif s.d. ${exp}`, id);
  }
  return tenantById(id);
}
function extendTenant(id, days, user, sumber) {
  const t = tenantById(id);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  const base = t.expires_at && String(t.expires_at).slice(0, 10) > todayISO() ? String(t.expires_at).slice(0, 10) : todayISO();
  const end = addDays(base, Number(days));
  S.prepare("UPDATE tenants SET expires_at=?,status='active',updated_at=? WHERE id=?").run(end, lib.nowStamp(), id);
  logSaas(user, 'PERPANJANG', 'tenant', `${t.nama} +${days} hari → aktif s.d. ${end}${sumber ? ' (' + sumber + ')' : ''}`, id);
  return end;
}
function deleteTenant(id, user) {
  const t = tenantById(id);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  if (Number(id) === 1) throw new Error('Sekolah pertama (tenant 1) tidak boleh dihapus — berisi data produksi.');
  S.prepare('DELETE FROM saas_payments WHERE tenant_id=?').run(id);
  S.prepare('DELETE FROM sessions WHERE tenant_id=?').run(id);
  S.prepare('DELETE FROM tenants WHERE id=?').run(id);
  logSaas(user, 'HAPUS SEKOLAH', 'tenant', `${t.nama} (${t.school_code}) dihapus dari daftar`, id);
  try {
    const conn = dbm.openTenantConn(id, t.db_file);
    conn.close();
    if (t.db_file && fs.existsSync(t.db_file)) fs.renameSync(t.db_file, t.db_file + '.dihapus-' + Date.now());
  } catch (e) { }
  return true;
}

/* ---------------- tagihan & pembayaran perpanjangan ---------------- */
const PAY_STATUS = {
  pending: { label: 'Menunggu Verifikasi', color: 'amber' },
  approved: { label: 'Disetujui', color: 'green' },
  rejected: { label: 'Ditolak', color: 'red' },
  issued: { label: 'Tagihan Terbit', color: 'blue' },
  cancelled: { label: 'Dibatalkan', color: 'gray' }
};

function paymentsOf(tenantId, limit = 50) {
  return S.prepare('SELECT * FROM saas_payments WHERE tenant_id=? ORDER BY id DESC LIMIT ?').all(Number(tenantId) || 0, Number(limit) || 50);
}
function paymentsAll(status) {
  const q = `SELECT p.*, t.nama sekolah_nama, t.school_code FROM saas_payments p
    JOIN tenants t ON t.id=p.tenant_id` + (status ? ' WHERE p.status=?' : '') + ' ORDER BY p.id DESC LIMIT 300';
  return status ? S.prepare(q).all(status) : S.prepare(q).all();
}
function paymentById(id) {
  return S.prepare('SELECT p.*, t.nama sekolah_nama, t.school_code FROM saas_payments p JOIN tenants t ON t.id=p.tenant_id WHERE p.id=?').get(Number(id) || 0) || null;
}
function pendingPayment(tenantId) {
  return S.prepare("SELECT * FROM saas_payments WHERE tenant_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(Number(tenantId) || 0) || null;
}
function latestRejected(tenantId) {
  return S.prepare("SELECT * FROM saas_payments WHERE tenant_id=? AND status='rejected' ORDER BY id DESC LIMIT 1").get(Number(tenantId) || 0) || null;
}
function invoiceNo(id) {
  return 'INV-' + todayISO().replace(/-/g, '') + '-' + String(id).padStart(4, '0');
}

/** pengajuan perpanjangan dari sisi sekolah (QRIS manual) */
function submitPayment(tenantId, { durasi, bukti_url, pengirim, catatan, paket }) {
  const t = tenantById(tenantId);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  if (Number(t.is_lifetime_free)) throw new Error('Sekolah ini berstatus Lifetime — tidak perlu perpanjangan.');
  const d = Number(durasi) === 365 ? 365 : 30;
  if (!bukti_url) throw new Error('Bukti transfer wajib diunggah.');
  // paket tujuan (upgrade/downgrade) — kosong berarti paket sekolah saat ini
  let paketTujuan = String(paket || '').trim().toLowerCase();
  if (paketTujuan && !packageByKode(paketTujuan)) throw new Error('Paket tujuan tidak ditemukan.');
  if (!paketTujuan) paketTujuan = String(t.paket || '');
  const p = pendingPayment(tenantId);
  if (p) throw new Error('Masih ada pengajuan yang menunggu verifikasi. Tunggu persetujuan Super Admin sebelum mengirim lagi.');
  const now = lib.nowStamp();
  const nominal = hargaTenant(t, paketTujuan, d);
  const info = S.prepare(`INSERT INTO saas_payments
    (tenant_id,paket_tujuan,no_invoice,jenis,durasi,nominal,status,bukti_url,pengirim,catatan,source,periode_mulai,dibuat_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, paketTujuan, '', 'perpanjangan', d, nominal, 'pending', String(bukti_url),
      String(pengirim || ''), String(catatan || ''), 'tenant', t.expires_at || todayISO(), now, now);
  const id = Number(info.lastInsertRowid);
  S.prepare('UPDATE saas_payments SET no_invoice=? WHERE id=?').run(invoiceNo(id), id);
  const pkg = packageByKode(paketTujuan);
  logSaas(null, 'PENGAJUAN BAYAR', 'pembayaran',
    `${t.nama} mengirim bukti transfer ${d} hari · paket ${pkg ? pkg.nama : paketTujuan} (Rp ${nominal.toLocaleString('id-ID')})`, tenantId);
  return id;
}

/* ==================== PEMBAYARAN HYBRID: QRIS OTOMATIS ==================== */
function gatewayCfg() {
  return {
    provider: clean(get('pay_gateway_provider')) || 'sandbox',
    mode: clean(get('pay_gateway_mode')) || 'sandbox',
    merchant: clean(get('pay_gateway_merchant')),
    key: clean(get('pay_gateway_key')),
    key2: clean(get('pay_gateway_key2')),
    callback: clean(get('pay_gateway_callback')),
    base: clean(get('pay_gateway_base')),
    /* khusus Kasera: auto | transactions | qris */
    kasera_api: clean(get('pay_gateway_kasera_api')) || 'auto',
    expire_menit: Math.max(5, Number(get('pay_gateway_expire_menit')) || 60)
  };
}
/** konfigurasi aman untuk klien (tanpa kredensial) */
function payConfig(baseUrl) {
  const pub = paygw.publicConfig(get);
  pub.callback_url = baseUrl ? `${String(baseUrl).replace(/\/$/, '')}/pay/callback` : '';
  /* endpoint webhook Kasera (didaftarkan pada dashboard Kasera Pay) */
  pub.webhook_url = kaseraWebhookUrl(baseUrl);
  pub.kasera_api = clean(get('pay_gateway_kasera_api')) || 'auto';
  pub.webhook_secret_set = !!clean(get('pay_gateway_callback') || get('pay_gateway_key2')
    || process.env.KASERA_WEBHOOK_SECRET);
  return pub;
}

/**
 * Buat tagihan QRIS dinamis untuk perpanjangan sekolah.
 * Baris saas_payments dibuat lebih dulu agar order dapat dilacak.
 */
async function bayarGateway(tenantId, { durasi, paket, pengirim, catatan, oleh, base_url }) {
  const t = tenantById(tenantId);
  if (!t) throw new Error('Sekolah tidak ditemukan.');
  if (Number(t.is_lifetime_free)) throw new Error('Sekolah ini berstatus Lifetime — tidak perlu perpanjangan.');
  if (String(get('pay_gateway_aktif')) !== '1') throw new Error('Metode QRIS otomatis sedang dinonaktifkan Super Admin.');
  if (pendingPayment(tenantId)) throw new Error('Masih ada pengajuan yang menunggu verifikasi. Selesaikan dulu sebelum membuat QRIS baru.');
  const d = Number(durasi) === 365 ? 365 : 30;
  let paketTujuan = String(paket || '').trim().toLowerCase();
  if (paketTujuan && !packageByKode(paketTujuan)) throw new Error('Paket tujuan tidak ditemukan.');
  if (!paketTujuan) paketTujuan = String(t.paket || '');
  const nominal = hargaTenant(t, paketTujuan, d);
  const cfg = gatewayCfg();
  const oid = paygw.orderNo(t.id);
  const now = lib.nowStamp();
  const info = S.prepare(`INSERT INTO saas_payments
    (tenant_id,paket_tujuan,no_invoice,jenis,durasi,nominal,status,bukti_url,pengirim,catatan,source,periode_mulai,dibuat_at,created_at,channel,provider,order_id,gateway_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, paketTujuan, '', 'perpanjangan', d, nominal, 'pending', '', String(pengirim || ''), String(catatan || ''),
      'tenant', t.expires_at || todayISO(), now, now, 'gateway', cfg.provider, oid, 'PENDING');
  const id = Number(info.lastInsertRowid);
  S.prepare('UPDATE saas_payments SET no_invoice=? WHERE id=?').run(invoiceNo(id), id);

  const charge = await paygw.createCharge(
    {
      ...cfg,
      callback_url: base_url ? `${String(base_url).replace(/\/$/, '')}/pay/callback` : '',
      webhook_url: kaseraWebhookUrl(base_url),
      return_url: base_url || ''
    },
    { order_id: oid, amount: nominal, label: `Langganan ${d} hari — ${t.nama}`, customer: { nama: t.nama, email: t.email || '' } }
  );
  if (!charge.ok) {
    const chargeError = (() => {
      if (typeof charge.error === 'string') return charge.error;
      if (charge.error && typeof charge.error === 'object') {
        const direct = charge.error.message || charge.error.error_message || charge.error.error_description
          || charge.error.detail || charge.error.error;
        if (typeof direct === 'string' && String(direct).trim()) return String(direct).trim();
        try {
          const raw = JSON.stringify(charge.error);
          if (raw && raw !== '{}') return raw;
        } catch (e) { /* abaikan */ }
      }
      return 'tidak diketahui';
    })();
    S.prepare("UPDATE saas_payments SET status='rejected', gateway_status='GAGAL', alasan=? WHERE id=?")
      .run('Gagal membuat QRIS: ' + chargeError, id);
    logSaas(null, 'BAYAR GATEWAY', 'pembayaran', `${t.nama} gagal membuat QRIS (${cfg.provider}): ${chargeError}`, tenantId);
    throw new Error(chargeError === 'tidak diketahui' ? 'Gagal membuat QRIS pada payment gateway.' : chargeError);
  }
  S.prepare('UPDATE saas_payments SET qr_string=?,qr_url=?,checkout_url=?,expires_at=?,gateway_status=? WHERE id=?')
    .run(clean(charge.qr_string), clean(charge.qr_url), clean(charge.checkout_url), clean(charge.expires_at), 'PENDING', id);
  logSaas(null, 'BAYAR GATEWAY', 'pembayaran',
    `${t.nama} membuat QRIS otomatis ${d} hari · Rp ${nominal.toLocaleString('id-ID')} (${cfg.provider}) — order ${oid}`, tenantId);
  return paymentById(id);
}

function gatewayRow(order_id) {
  return S.prepare('SELECT * FROM saas_payments WHERE order_id=?').get(clean(order_id)) || null;
}

/** tandai lunas (callback / polling / simulasi) — idempoten */
function gatewayMarkPaid(order_id, oleh) {
  const p = gatewayRow(order_id);
  if (!p) throw new Error('Transaksi gateway tidak ditemukan.');
  if (p.status === 'approved') return { payment: paymentById(p.id), sudah: true };
  if (p.status !== 'pending') throw new Error('Transaksi ini sudah diproses (' + p.status + ').');
  S.prepare("UPDATE saas_payments SET gateway_status='PAID', paid_at=? WHERE id=?").run(lib.nowStamp(), p.id);
  const res = approvePayment(p.id, { nama: clean(oleh) || 'Payment Gateway' });
  return { payment: paymentById(p.id), sudah: false, end: res.end };
}

/** cek status terkini ke gateway */
async function gatewaySync(order_id) {
  const p = gatewayRow(order_id);
  if (!p) throw new Error('Transaksi gateway tidak ditemukan.');
  if (p.status !== 'pending') return { status: p.status, paid: p.status === 'approved', payment: paymentById(p.id) };
  const st = await paygw.checkStatus(gatewayCfg(), { order_id: p.order_id });
  if (st.ok) S.prepare('UPDATE saas_payments SET gateway_status=? WHERE id=?').run(clean(st.status) || 'PENDING', p.id);
  if (st.paid) {
    const r = gatewayMarkPaid(p.order_id, 'Payment Gateway');
    return { status: 'approved', paid: true, payment: r.payment };
  }
  return { status: p.status, paid: false, gateway_status: st.status || '', error: st.error || '' };
}

/* ==================== WEBHOOK KASERA PAY ====================
   Notifikasi pembayaran dari Kasera (tanpa sesi login). Keaslian dijamin
   HMAC-SHA256 header `kasera-signature-v1` atas BODY MENTAH, lalu event
   dideduplikasi lewat tabel kasera_event (event yang sama tidak diproses 2×).

   Dua sasaran pembayaran:
     · perpanjangan layanan sekolah  → order `SK-<tenant>-…` di saas_payments
     · iuran portal orang tua        → order `IU<tenant>-…` di iuran_checkout
   ============================================================ */
function kaseraWebhookUrl(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return b ? b + '/api/webhook/kasera' : '';
}
/** id sekolah dari nomor pesanan (SK-<id>-… / IU<id>-…) */
function tenantIdFromOrder(order) {
  const m = /^(?:SK|IU)[-_]?(\d+)-/i.exec(String(order || ''));
  return m ? Number(m[1]) || 0 : 0;
}
/** konfigurasi gateway milik satu sekolah (dibaca di dalam konteks DB sekolah) */
function tenantGateway(tenantId) {
  const t = tenantId ? tenantById(tenantId) : null;
  if (!t) return null;
  try {
    const bayariuran = require('./bayariuran');
    return { tenant: t, cfg: dbm.runAsTenant(t, () => bayariuran.cfg(dbm, module.exports)) };
  } catch (e) {
    console.error('[kasera] gagal membaca konfigurasi sekolah', tenantId, e.message);
    return null;
  }
}
/** daftar secret yang dicoba saat memverifikasi tanda tangan webhook */
function kaseraSecretList(tenantCfg) {
  const out = [];
  if (tenantCfg) out.push(...paygw.kaseraSecrets(tenantCfg));
  out.push(...paygw.kaseraSecrets(gatewayCfg()));
  return [...new Set(out.filter(Boolean))];
}
function kaseraEventRow(eventId) {
  return S.prepare('SELECT * FROM kasera_event WHERE event_id=?').get(clean(eventId)) || null;
}
function kaseraEventSave(row) {
  const r = row || {};
  const lama = kaseraEventRow(r.event_id);
  if (lama) {
    S.prepare(`UPDATE kasera_event SET tipe=?,status=?,order_id=?,jumlah=?,tenant_id=?,sasaran=?,hasil=?,pesan=?,diproses_at=? WHERE event_id=?`)
      .run(clean(r.tipe), clean(r.status), clean(r.order_id), Number(r.jumlah) || 0, Number(r.tenant_id) || null,
        clean(r.sasaran), clean(r.hasil), clean(r.pesan), lib.nowStamp(), r.event_id);
    return;
  }
  S.prepare(`INSERT INTO kasera_event(event_id,tipe,status,order_id,jumlah,tenant_id,sasaran,hasil,pesan,diterima_at,diproses_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(clean(r.event_id), clean(r.tipe), clean(r.status), clean(r.order_id), Number(r.jumlah) || 0,
      Number(r.tenant_id) || null, clean(r.sasaran), clean(r.hasil), clean(r.pesan),
      lib.nowStamp(), lib.nowStamp());
}
function kaseraEvents(limit = 12) {
  return S.prepare('SELECT * FROM kasera_event ORDER BY diterima_at DESC, rowid DESC LIMIT ?').all(Math.max(1, Number(limit) || 12));
}

/**
 * Proses satu notifikasi webhook Kasera.
 * @param {{raw:string|Buffer, body:object, headers:object, tenantHint?:number}} input
 * @returns {Promise<{code:number, out:object}>}
 */
async function kaseraHandleWebhook({ raw, body, headers = {}, tenantHint = 0 } = {}) {
  const bahan = raw === undefined || raw === null ? JSON.stringify(body || {}) : raw;
  let payload = body;
  if (!payload || typeof payload !== 'object') {
    try { payload = JSON.parse(String(bahan || '{}')); } catch (e) { payload = {}; }
  }
  const ev = paygw.kaseraEvent(payload);
  const order = clean(ev.order_id);
  const tenantId = Number(tenantHint) || tenantIdFromOrder(order) || 0;
  const sasaranTenant = tenantGateway(tenantId);
  const secrets = kaseraSecretList(sasaranTenant && sasaranTenant.cfg);

  /* ---- 1. verifikasi tanda tangan ---- */
  if (!secrets.length) {
    console.error('[kasera] webhook ditolak: Webhook Secret belum diatur.');
    return { code: 503, out: { ok: false, error: 'Webhook Secret Kasera belum diatur pada pengaturan pembayaran.' } };
  }
  const verif = paygw.kaseraVerifySignature(bahan, headers, secrets);
  if (!verif.ok) {
    console.error('[kasera] webhook ditolak:', verif.reason, '· order', order || '-');
    return { code: 401, out: { ok: false, error: 'Tanda tangan webhook tidak valid.' } };
  }

  /* ---- 2. deduplikasi berdasarkan id event ---- */
  const eventId = clean(ev.event_id) || ('ev-' + lib.token(8));
  const sudah = kaseraEventRow(eventId);
  if (sudah && sudah.hasil === 'ok') {
    return { code: 200, out: { ok: true, duplicate: true, event_id: eventId, pesan: 'Event sudah pernah diproses.' } };
  }
  const dasar = {
    event_id: eventId, tipe: ev.type || '(tanpa tipe)', status: ev.status, order_id: order,
    jumlah: ev.amount, tenant_id: tenantId
  };
  if (!order) {
    kaseraEventSave({ ...dasar, hasil: 'ditolak', pesan: 'external_id tidak ada pada event.' });
    return { code: 400, out: { ok: false, error: 'external_id (nomor pesanan) tidak ada pada event.' } };
  }

  /* ---- 3. bukan pembayaran lunas → hanya dicatat ---- */
  if (!ev.paid) {
    kaseraEventSave({ ...dasar, sasaran: '-', hasil: 'diabaikan', pesan: `Event ${ev.type || 'tanpa tipe'} (${ev.status || '-'}) tidak menandai lunas.` });
    return { code: 200, out: { ok: true, paid: false, event_id: eventId } };
  }

  try {
    /* ---- 4a. perpanjangan layanan (control plane) ---- */
    const pay = gatewayRow(order);
    if (pay) {
      if (Number(ev.amount) > 0 && Number(pay.nominal) > 0 && Number(ev.amount) < Number(pay.nominal)) {
        kaseraEventSave({ ...dasar, sasaran: 'langganan', hasil: 'jumlah-tidak-cocok', pesan: `Dibayar ${ev.amount} < tagihan ${pay.nominal}` });
        return { code: 400, out: { ok: false, error: 'Nominal pembayaran lebih kecil dari tagihan.' } };
      }
      const r = gatewayMarkPaid(order, 'Kasera Pay');
      kaseraEventSave({ ...dasar, tenant_id: pay.tenant_id, sasaran: 'langganan', hasil: 'ok', pesan: r.sudah ? 'Sudah lunas sebelumnya.' : 'Perpanjangan aktif.' });
      logSaas(null, 'WEBHOOK KASERA', 'pembayaran',
        `Order ${order} lunas (${ev.status || 'PAID'}) — perpanjangan sekolah #${pay.tenant_id}`, pay.tenant_id);
      return { code: 200, out: { ok: true, paid: true, sasaran: 'langganan', sudah: !!r.sudah } };
    }

    /* ---- 4b. iuran portal orang tua (database sekolah) ---- */
    const t = tenantId ? tenantById(tenantId) : null;
    if (!t) {
      kaseraEventSave({ ...dasar, sasaran: '-', hasil: 'tidak-ditemukan', pesan: 'Order tidak dikenal.' });
      return { code: 404, out: { ok: false, error: 'Transaksi tidak ditemukan.' } };
    }
    const bayariuran = require('./bayariuran');
    const hasil = dbm.runAsTenant(t, () => {
      const row = bayariuran.byOrder(dbm, order);
      if (!row) return { code: 404, out: { ok: false, error: 'Transaksi iuran tidak ditemukan.' } };
      if (Number(ev.amount) > 0 && Number(row.total) > 0 && Number(ev.amount) < Number(row.total)) {
        return { code: 400, out: { ok: false, error: 'Nominal pembayaran lebih kecil dari tagihan.' } };
      }
      const r = bayariuran.applyPaid(dbm, row, { oleh: 'Kasera Pay', gatewayStatus: ev.status || 'PAID' });
      return { code: 200, out: { ok: true, paid: true, sasaran: 'iuran', sudah: !!r.sudah, baris: r.baris } };
    });
    kaseraEventSave({
      ...dasar, tenant_id: t.id, sasaran: 'iuran',
      hasil: hasil.code === 200 ? 'ok' : (hasil.code === 400 ? 'jumlah-tidak-cocok' : 'tidak-ditemukan'),
      pesan: hasil.code === 200 ? `Iuran ${t.nama} masuk antrean posting.` : (hasil.out.error || '')
    });
    if (hasil.code !== 200) console.error('[kasera] webhook order', order, '→', hasil.out.error);
    return hasil;
  } catch (e) {
    console.error('[kasera] gagal memproses webhook', order, e);
    kaseraEventSave({ ...dasar, sasaran: '-', hasil: 'gagal', pesan: e.message });
    return { code: 500, out: { ok: false, error: e.message } };
  }
}

function approvePayment(id, user) {
  const p = paymentById(id);
  if (!p) throw new Error('Pengajuan tidak ditemukan.');
  if (p.status !== 'pending') throw new Error('Pengajuan ini sudah diproses (' + (PAY_STATUS[p.status] || {}).label + ').');
  const t = tenantById(p.tenant_id);
  const base = t.expires_at && String(t.expires_at).slice(0, 10) > todayISO() ? String(t.expires_at).slice(0, 10) : todayISO();
  const end = extendTenant(t.id, p.durasi, user || { nama: 'Super Admin' }, 'verifikasi pembayaran');
  // bila pengajuan membawa paket tujuan (upgrade/downgrade) → terapkan sekarang
  if (p.paket_tujuan && packageByKode(p.paket_tujuan) && String(p.paket_tujuan) !== String(t.paket)) {
    try { setPackage(t.id, p.paket_tujuan, user || { nama: 'Super Admin' }); } catch (e) { }
  }
  S.prepare(`UPDATE saas_payments SET status='approved', direview_at=?, direview_oleh=?, periode_mulai=?, periode_akhir=?, alasan=''
    WHERE id=?`).run(lib.nowStamp(), (user && user.nama) || 'Super Admin', base, end, id);
  // tagihan "issued" lama untuk sekolah ini dianggap selesai
  S.prepare("UPDATE saas_payments SET status='approved' WHERE tenant_id=? AND status='issued'").run(t.id);
  return { tenant: tenantById(t.id), end };
}
function rejectPayment(id, alasan, user) {
  const p = paymentById(id);
  if (!p) throw new Error('Pengajuan tidak ditemukan.');
  if (p.status !== 'pending') throw new Error('Pengajuan ini sudah diproses.');
  if (!String(alasan || '').trim()) throw new Error('Alasan penolakan wajib diisi.');
  S.prepare("UPDATE saas_payments SET status='rejected', alasan=?, direview_at=?, direview_oleh=? WHERE id=?")
    .run(String(alasan).trim(), lib.nowStamp(), (user && user.nama) || 'Super Admin', id);
  logSaas(user, 'TOLAK BAYAR', 'pembayaran', `${p.sekolah_nama}: ${alasan}`, p.tenant_id);
  return true;
}

/** cron harian: terbitkan tagihan H-7 + tangguhkan yang sudah kedaluwarsa */
function runDailyJobs() {
  const today = todayISO();
  const out = { invoices: 0, suspended: 0 };
  for (const t of allTenants()) {
    if (Number(t.is_lifetime_free)) continue;
    const exp = t.expires_at ? String(t.expires_at).slice(0, 10) : '';
    if (!exp) continue;
    const days = daysBetween(today, exp);
    // 1) tagihan H-7 — juga diterbitkan untuk sekolah yang sudah lewat masa aktif
    //    (tagihan tetap dibutuhkan agar sekolah bisa memperpanjang)
    if (days <= 7) {
      const ada = S.prepare("SELECT id FROM saas_payments WHERE tenant_id=? AND jenis='tagihan' AND periode_mulai=? AND status='issued'")
        .get(t.id, exp);
      if (!ada) {
        const now = lib.nowStamp();
        const info = S.prepare(`INSERT INTO saas_payments
          (tenant_id,no_invoice,jenis,durasi,nominal,status,source,periode_mulai,periode_akhir,dibuat_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(t.id, '', 'tagihan', 30, priceOf(30), 'issued', 'cron', exp, addDays(exp, 30), now, now);
        const id = Number(info.lastInsertRowid);
        S.prepare('UPDATE saas_payments SET no_invoice=? WHERE id=?').run(invoiceNo(id), id);
        logSaas(null, 'TAGIHAN H-7', 'pembayaran', `${t.nama} — tagihan perpanjangan (aktif s.d. ${exp}, ${days} hari lagi)`, t.id);
        out.invoices++;
      }
    }
    // 2) auto-suspend setelah masa berlaku habis (lifetime sudah dilewati di atas)
    if (days < 0 && String(t.status) !== 'suspended') {
      S.prepare("UPDATE tenants SET status='suspended',updated_at=? WHERE id=?").run(lib.nowStamp(), t.id);
      logSaas(null, 'AUTO SUSPEND', 'tenant', `${t.nama} ditangguhkan otomatis (masa aktif berakhir ${exp})`, t.id);
      out.suspended++;
    }
  }
  return out;
}

/* ---------------- sesi login (control plane) ---------------- */
const SESSION_DAYS = 14;
function createSession({ userId, tenantId, kind, alertPending, welcome, expiresMinutes }) {
  const token = lib.token(24);
  /* kedaluwarsa memakai jam WIB yang sama dengan nowStamp() saat pemeriksaan */
  const exp = expiresMinutes ? lib.plusMinutesStamp(Number(expiresMinutes)) : lib.plusDaysStamp(SESSION_DAYS);
  S.prepare('INSERT INTO sessions (token,user_id,tenant_id,kind,expires_at,alert_pending,ta_id,created_at,welcome) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(token, userId || null, tenantId || null, kind || 'tenant', exp, alertPending || 0, null, lib.nowStamp(),
      welcome ? String(welcome) : null);
  return token;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(raw) {
  const input = String(raw || '').toUpperCase().replace(/=+$/g, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of input) {
    const n = BASE32.indexOf(ch);
    if (n < 0) throw new Error('Secret authenticator tidak valid.');
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totpCode(secret, at = Date.now()) {
  const counter = BigInt(Math.floor(Number(at) / 30000));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) | ((hmac[offset + 1] & 255) << 16)
    | ((hmac[offset + 2] & 255) << 8) | (hmac[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, '0');
}
function totpVerify(secret, code, at = Date.now()) {
  const submitted = String(code || '').replace(/\D/g, '');
  if (submitted.length !== 6) return false;
  const expected = Buffer.from(submitted);
  for (const delta of [-30000, 0, 30000]) {
    const actual = Buffer.from(totpCode(secret, Number(at) + delta));
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return true;
  }
  return false;
}
function recoveryDigest(code) {
  return crypto.createHash('sha256').update(String(code || '').toLowerCase().replace(/[^a-f0-9]/g, '')).digest('hex');
}
function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(8).toString('hex');
    return raw.match(/.{1,4}/g).join('-');
  });
}
function recoveryHashes(codes) { return codes.map(recoveryDigest); }

function authIdentityHash(identity) {
  return crypto.createHash('sha256').update(String(identity || '').trim().toLowerCase()).digest('hex');
}
function authIsLimited(identity, { limit = 5, windowMinutes = 15 } = {}) {
  const hash = authIdentityHash(identity);
  const cutoff = lib.plusMinutesStamp(-Math.abs(Number(windowMinutes) || 15));
  const row = S.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE identity_hash=? AND result='failed' AND created_at>=?")
    .get(hash, cutoff);
  return Number(row && row.n || 0) >= Math.max(1, Number(limit) || 5);
}
function authRecord(identity, success) {
  const hash = authIdentityHash(identity);
  const now = lib.nowStamp();
  const tx = S.transaction(() => {
    if (success) S.prepare("DELETE FROM auth_attempts WHERE identity_hash=?").run(hash);
    else S.prepare("INSERT INTO auth_attempts (identity_hash,result,created_at) VALUES (?,'failed',?)").run(hash, now);
    S.prepare('DELETE FROM auth_attempts WHERE created_at<?').run(lib.plusDaysStamp(-2));
  });
  tx();
}

function mfaEnabled(userId) {
  const row = S.prepare('SELECT mfa_enabled FROM saas_users WHERE id=?').get(Number(userId));
  return !!(row && Number(row.mfa_enabled));
}
function mfaStart(userId) {
  const secret = base32Encode(crypto.randomBytes(20));
  const info = S.prepare('UPDATE saas_users SET mfa_pending_secret=? WHERE id=?').run(secret, Number(userId));
  if (!info.changes) throw new Error('Akun Super Admin tidak ditemukan.');
  return secret;
}
function mfaPendingSecret(userId) {
  const row = S.prepare('SELECT mfa_pending_secret FROM saas_users WHERE id=?').get(Number(userId));
  return String(row && row.mfa_pending_secret || '');
}
function mfaEnable(userId, code) {
  return S.transaction(() => {
    const secret = mfaPendingSecret(userId);
    if (!secret || !totpVerify(secret, code)) throw new Error('Kode authenticator tidak valid atau kedaluwarsa.');
    const recovery = newRecoveryCodes();
    const info = S.prepare('UPDATE saas_users SET mfa_secret=?,mfa_pending_secret=NULL,mfa_recovery=?,mfa_enabled=1 WHERE id=? AND mfa_enabled=0')
      .run(secret, JSON.stringify(recoveryHashes(recovery)), Number(userId));
    if (!info.changes) throw new Error('MFA sudah aktif; masuk kembali untuk melanjutkan.');
    return recovery;
  }).immediate();
}
function mfaVerify(userId, code) {
  return S.transaction(() => {
    const row = S.prepare('SELECT mfa_secret,mfa_recovery,mfa_enabled FROM saas_users WHERE id=?').get(Number(userId));
    if (!row || !Number(row.mfa_enabled)) return false;
    if (totpVerify(row.mfa_secret, code)) return true;
    const digest = recoveryDigest(code);
    let codes = [];
    try { codes = JSON.parse(row.mfa_recovery || '[]'); } catch (e) { codes = []; }
    const match = codes.findIndex(x => {
      const a = Buffer.from(String(x || ''));
      const b = Buffer.from(digest);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (match < 0) return false;
    codes.splice(match, 1);
    const info = S.prepare('UPDATE saas_users SET mfa_recovery=? WHERE id=?')
      .run(JSON.stringify(codes), Number(userId));
    return info.changes === 1;
  }).immediate();
}
function mfaRecoveryCount(userId) {
  const row = S.prepare('SELECT mfa_recovery FROM saas_users WHERE id=?').get(Number(userId));
  try { return JSON.parse(row && row.mfa_recovery || '[]').length; } catch (e) { return 0; }
}
/**
 * Kredensial awal pendaftaran (kode sekolah / username / password) disimpan pada
 * baris sesi, BUKAN di URL, lalu diambil SEKALI untuk ditampilkan di dashboard.
 * Mengembalikan objek { kode, sekolah, username, password, nama, at } atau null.
 */
function takeWelcome(token) {
  if (!token) return null;
  let row = null;
  try { row = S.prepare('SELECT welcome FROM sessions WHERE token=?').get(String(token)); } catch (e) { return null; }
  if (!row || !row.welcome) return null;
  let out = null;
  try { out = JSON.parse(String(row.welcome)); } catch (e) { out = null; }
  try { S.prepare('UPDATE sessions SET welcome=NULL WHERE token=?').run(String(token)); } catch (e) { }
  return out;
}
function getSession(token) {
  if (!token) return null;
  const s = S.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  if (String(s.expires_at || '') < lib.nowStamp()) {
    S.prepare('DELETE FROM sessions WHERE token=?').run(token);
    return null;
  }
  return s;
}
function destroySession(token) {
  if (token) S.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
function updateSession(token, patch = {}) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  S.prepare(`UPDATE sessions SET ${keys.map(k => k + '=?').join(',')} WHERE token=?`).run(...keys.map(k => patch[k]), token);
}

/* ---------------- akun super admin pusat ---------------- */
function ensureAdmin() {
  const email = String(process.env.SAAS_ADMIN_EMAIL || 'super@simkeu.id').trim().toLowerCase();
  const pass = String(process.env.SAAS_ADMIN_PASSWORD || 'SuperAdmin2026!');
  const ada = S.prepare('SELECT id FROM saas_users WHERE role=? LIMIT 1').get('super_admin');
  if (ada) return { created: false, email };
  S.prepare('INSERT INTO saas_users (nama,email,password,role,aktif,created_at) VALUES (?,?,?,?,1,?)')
    .run('Super Admin Pusat', email, lib.hashPassword(pass), 'super_admin', lib.nowStamp());
  return { created: true, email, password: pass };
}
function findAdmin(email) {
  return S.prepare('SELECT * FROM saas_users WHERE lower(email)=lower(?)').get(String(email || '').trim()) || null;
}
function adminById(id) {
  return S.prepare('SELECT * FROM saas_users WHERE id=?').get(Number(id) || 0) || null;
}
function setAdminPassword(id, pass) {
  S.prepare('UPDATE saas_users SET password=? WHERE id=?').run(lib.hashPassword(pass), id);
}

/* ---------------- statistik dashboard ---------------- */
function stats() {
  const list = allTenants();
  const today = todayISO();
  let aktif = 0, lifetime = 0, suspended = 0, soon = 0;
  for (const t of list) {
    const st = statusOf(t);
    if (st.key === 'lifetime') { lifetime++; aktif++; }
    else if (st.key === 'expired' || st.key === 'suspended') suspended++;
    else { aktif++; if (st.key === 'soon') soon++; }
  }
  const pendapatan = S.prepare("SELECT COALESCE(SUM(nominal),0) v FROM saas_payments WHERE status='approved' AND direview_at LIKE ?").get(today.slice(0, 7) + '%').v;
  const menunggu = S.prepare("SELECT COUNT(*) c FROM saas_payments WHERE status='pending'").get().c;
  return { total: list.length, aktif, lifetime, suspended, soon, menunggu, pendapatan };
}

/* ---------------- bootstrap control plane ---------------- */


function ensureBootstrap() {
  const admin = ensureAdmin();
  seedPackages();
  migratePackageFeatures();
  // sekolah lama (sebelum fitur slug) → buatkan slug default dari nama sekolah
  try {
    for (const t of allTenants()) {
      if (String(t.portal_slug || '').trim()) continue;
      const slug = module.exports.slugFromName ? module.exports.slugFromName(t.nama, t.id) : null;
      if (slug) S.prepare('UPDATE tenants SET portal_slug=? WHERE id=?').run(slug, t.id);
    }
  } catch (e) { }
  if (!allTenants().length) {
    let nama = 'Sekolah Pertama';
    try {
      const r = dbm.rootDb.prepare("SELECT v FROM settings WHERE k='sekolah_nama'").get();
      if (r && r.v) nama = r.v;
    } catch (e) { }
    const now = lib.nowStamp();
    let slugDefault = 'sekolah-pertama';
    try { slugDefault = module.exports.slugify ? module.exports.slugify(nama) : slugDefault; } catch (e) { }
    S.prepare(`INSERT INTO tenants (id,school_code,nama,paket,status,is_lifetime_free,expires_at,registered_at,
        contact_email,db_file,features,trial,catatan,created_at,updated_at,portal_slug)
      VALUES (1,'SK01',?,'pro','active',1,NULL,?,?,?,?,0,?,?,?,?)`)
      .run(nama, todayISO(), '', dbm.DB_PATH, JSON.stringify(featureDefaults('pro')),
        'Sekolah pertama — data produksi dipindahkan apa adanya (akses gratis seumur hidup).',
        now, now, slugDefault);
    logSaas(null, 'MIGRASI TENANT 1', 'tenant', `Sekolah pertama "${nama}" ditetapkan sebagai tenant 1 (kode SK01, lifetime)`, 1);
  }
  return admin;
}

module.exports = {
  db: S,
  C: S,
  FEATURES, FEATURE_MAP, PATH_FEATURES, PAKET, PAY_STATUS, SESSION_DAYS,
  get, set, settings, appName, appSub, appLogo, tema, priceOf, defaultPriceMonth, trialDays,
  featureDefaults, tenantFeatures, enabledKeys, blockedFeature, parseFeatures,
  DEFAULT_PACKAGES, packageRows, packageByKode, packageById, defaultPackage, packageLabels, packagePrice,
  packageSave, packageDelete, packageSetDefault, seedPackages, setPackage,
  packageFeatureMap, packageFeatureLabels, packageSelfTrial, packageTrialDays,
  regLimits, regStatus, regHit, regLog, clientIpOf, verifyCaptcha, captchaConfig,
  waAdminNumber, waAdminLink, normalizeWa,
  allTenants, tenantById, tenantByCode, nextSchoolCode, normalizeCode, codeExists,
  createTenant, updateTenant, setFeatures, setLifetime, extendTenant, deleteTenant,
  statusOf, isBlocked, todayISO, addDays, daysBetween, logSaas,
  paymentsOf, paymentsAll, paymentById, pendingPayment, latestRejected, submitPayment,
  paygw, payConfig, gatewayCfg, hargaTenant, bayarGateway, gatewayRow, gatewayMarkPaid, gatewaySync,
  kaseraWebhookUrl, kaseraHandleWebhook, kaseraEvents, kaseraSecretList, tenantIdFromOrder,
  approvePayment, rejectPayment, runDailyJobs, stats, invoiceNo,
  createSession, getSession, destroySession, updateSession, takeWelcome,
  authIsLimited, authRecord, mfaEnabled, mfaStart, mfaPendingSecret, mfaEnable, mfaVerify, mfaRecoveryCount,
  ensureAdmin, findAdmin, adminById, setAdminPassword,
  ensureBootstrap
};

/* ==================================================================
   FITUR LANJUTAN control plane (dipasang sebagai properti modul ini)
   ================================================================== */
Object.assign(module.exports, require('./saas_extra')({
  S, lib, dbm, get, set, allTenants, tenantById, logSaas, todayISO, addDays, daysBetween, PAKET, FEATURES
}));
}
