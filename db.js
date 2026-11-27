'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// muat konfigurasi .env sebelum apa pun membaca process.env (DB_PATH, dsb.)
require('./env');
const DB_DRIVER = String(process.env.DB_DRIVER || 'sqlite').trim().toLowerCase();
if (DB_DRIVER !== 'sqlite') {
  if (DB_DRIVER === 'mysql') {
    throw new Error('DB_DRIVER=mysql diminta, tetapi runtime aplikasi belum dipindahkan sepenuhnya ke MySQL. Startup dihentikan agar tidak diam-diam memakai SQLite.');
  }
  throw new Error(`DB_DRIVER "${DB_DRIVER}" tidak didukung. Runtime yang tersedia saat ini: sqlite.`);
}
const Database = require('better-sqlite3');
const { AsyncLocalStorage } = require('async_hooks');
const { hashPassword, nowStamp, todayISO, parseMoney } = require('./lib');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'keuangan.sqlite');
// database CONTROL PLANE (SaaS): daftar sekolah/tenant, tagihan, sesi login, pengaturan QRIS.
// Terpisah total dari database sekolah supaya tidak pernah ikut terhapus saat reset tenant.
// default mengikuti folder database utama → tes dengan DB_PATH sementara otomatis terisolasi
const SAAS_DB_PATH = process.env.SAAS_DB_PATH || path.join(path.dirname(DB_PATH), 'saas.db');

/* ==================================================================
   KONEKSI DATABASE: SATU DATABASE PER SEKOLAH (TENANT) + CONTROL PLANE
   ------------------------------------------------------------------
   Isolasi data antar sekolah dilakukan secara FISIK: setiap tenant punya
   berkas SQLite sendiri (data/tenants/tenant-<id>.sqlite). Sekolah pertama
   tetap memakai data/keuangan.sqlite yang sudah berisi data aslinya.

   Semua kode aplikasi tetap memanggil `db.prepare(...)` / `dbm.mainDb`
   seperti biasa; proxy di bawah mengarahkan query ke koneksi tenant yang
   sedang aktif pada request tersebut (AsyncLocalStorage). Di luar request
   tenant (mis. portal Super Admin) query jatuh ke `rootDb` = tenant pertama.

   Akun berperan "demo" tetap memakai database dummy terpisah (data/demo.sqlite).
   ================================================================== */
const rootDb = new Database(DB_PATH);
rootDb.pragma('journal_mode = WAL');
rootDb.pragma('foreign_keys = ON');

rootDb.__tenantId = 1;

/* ---------------- zona waktu SQL: now_wib() / today_wib() ----------------
   SQLite selalu mengembalikan UTC pada CURRENT_TIMESTAMP/NOW() dan tidak bisa
   diubah per koneksi. Karena itu setiap koneksi diberi dua fungsi SQL yang
   memakai jam WIB (Asia/Jakarta) dari proses ini:
     SELECT now_wib();     → '2026-11-04 12:05:31'
     SELECT today_wib();   → '2026-11-04'
   Jangan memakai CURRENT_TIMESTAMP / datetime('now') di query baru.  */
function registerTimeFns(conn) {
  try {
    if (!conn || typeof conn.function !== 'function') return conn;
    if (conn.__tzFns) return conn;
    conn.function('now_wib', () => nowStamp());
    conn.function('today_wib', () => todayISO());
    conn.__tzFns = true;
  } catch (e) { console.error('[tz-sql]', e.message); }
  return conn;
}
registerTimeFns(rootDb);

const controlDb = new Database(SAAS_DB_PATH);
controlDb.pragma('journal_mode = WAL');
controlDb.pragma('foreign_keys = ON');
registerTimeFns(controlDb);
/* audit log lintas sekolah (dipakai panel Audit Logs Super Admin).
   Dibuat di sini (bukan di saas.js) supaya logAudit() selalu punya tabel tujuan. */
controlDb.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER, tenant_nama TEXT,
  user_id INTEGER, user_nama TEXT, role TEXT,
  ip TEXT, aksi TEXT, modul TEXT, detail TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id);`);

/** metadata request (IP & tenant) untuk audit log — diisi server.js per request */
const metaStore = new AsyncLocalStorage();
function runWithMeta(meta, fn) { return metaStore.run(meta || {}, fn); }
function currentMeta() { return metaStore.getStore() || {}; }

const DEMO_DB_PATH = process.env.DEMO_DB_PATH || path.join(DATA_DIR, 'demo.sqlite');
const dbStore = new AsyncLocalStorage();
let demoConn = null;

/** proxy koneksi: mengikuti koneksi aktif pada request (tenant/demo), fallback ke tenant pertama */
function connProxy(fallback) {
  return new Proxy({}, {
    get(_target, prop) {
      const conn = dbStore.getStore() || fallback;
      const v = conn[prop];
      return typeof v === 'function' ? v.bind(conn) : v;
    },
    has() { return true; }
  });
}
const mainDb = connProxy(rootDb);
const db = connProxy(rootDb);

/** jalankan fn dengan koneksi sandbox demo */
function runAsDemo(fn) { return dbStore.run(demoHandle(), fn); }
function demoHandle() {
  if (!demoConn) {
    const conn = new Database(DEMO_DB_PATH);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    registerTimeFns(conn);
    conn.__demoConn = true;
    demoConn = conn;
  }
  return demoConn;
}
function isDemoContext() { const c = dbStore.getStore(); return !!(c && c.__demoConn); }

/* ==================================================================
   MIGRASI ZONA WAKTU — stempel waktu lama digeser ke WIB
   ------------------------------------------------------------------
   Sebelum aplikasi disetel ke Asia/Jakarta, server (UTC) menulis kolom
   *_at memakai jam UTC sehingga tampil 7 jam lebih awal daripada jam dinding
   Jakarta. Migrasi ini menggeser nilai bertipe DATETIME ('YYYY-MM-DD HH:MM:SS')
   sebanyak +7 jam SATU KALI (ditandai setting `mig_tz_wib_v1`).
   Kolom tanggal murni (mis. `tanggal`, `periode`, `tenants.expires_at`) TIDAK
   ikut karena tidak cocok pola panjang 19 karakter.
   ================================================================== */
const TZ_LEGACY_SHIFT_HOURS = 7;
const TZ_SKIP_TABLES = new Set(['sessions', 'saas_jobs', 'sqlite_sequence']);
function isDateTimeColumn(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'last_login' || n === 'waktu') return true;
  return n.endsWith('_at');
}
function migrateLegacyTimestamps(conn, settingsTable = 'settings') {
  if (!conn) return { skipped: true };
  if (String(process.env.TZ_SHIFT_LEGACY === undefined ? '1' : process.env.TZ_SHIFT_LEGACY) === '0') {
    return { skipped: true, reason: 'TZ_SHIFT_LEGACY=0' };
  }
  try {
    const settingsExists = !!conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(settingsTable);
    if (settingsExists) {
      const r = conn.prepare(`SELECT v FROM "${settingsTable}" WHERE k='mig_tz_wib_v1'`).get();
      if (r && String(r.v || '').trim()) return { skipped: true, already: String(r.v) };
    }
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const job = conn.transaction(() => {
      let total = 0; const detail = [];
      for (const t of tables) {
        if (TZ_SKIP_TABLES.has(t)) continue;
        let cols = [];
        try { cols = conn.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name).filter(isDateTimeColumn); } catch (e) { continue; }
        for (const c of cols) {
          const info = conn.prepare(`UPDATE "${t}" SET "${c}" = strftime('%Y-%m-%d %H:%M:%S', "${c}", '+${TZ_LEGACY_SHIFT_HOURS} hours')
            WHERE typeof("${c}")='text' AND length("${c}")=19 AND "${c}" LIKE '____-__-__ __:__:__'`).run();
          if (info.changes) { total += info.changes; detail.push(`${t}.${c}(${info.changes})`); }
        }
      }
      if (settingsExists) {
        conn.prepare(`INSERT INTO "${settingsTable}" (k,v) VALUES ('mig_tz_wib_v1',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(nowStamp());
      }
      return { total, detail };
    });
    const out = job();
    if (out.total) {
      console.log(`[tz-migrasi] ${out.total} stempel waktu lama digeser +${TZ_LEGACY_SHIFT_HOURS} jam ke WIB`
        + ` (${out.detail.slice(0, 6).join(', ')}${out.detail.length > 6 ? ', …' : ''})`);
    }
    return out;
  } catch (e) {
    console.error('[tz-migrasi]', e.message);
    return { error: e.message };
  }
}

/* ---------------- koneksi per tenant ---------------- */
const tenantConns = new Map();
tenantConns.set(1, rootDb);   // tenant pertama = database lama (data asli, tidak disalin)

/** buka (atau ambil dari cache) koneksi database milik satu sekolah */
function openTenantConn(id, file) {
  const key = Number(id) || 1;
  if (key === 1) return rootDb;
  const cached = tenantConns.get(key);
  if (cached && cached.open) return cached;
  const fp = file || path.join(DATA_DIR, 'tenants', `tenant-${key}.sqlite`);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const conn = new Database(fp);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  registerTimeFns(conn);
  conn.__tenantId = key;
  tenantConns.set(key, conn);
  ensurePublicColumns(conn);
  try { migrateLegacyTimestamps(conn, 'settings'); } catch (e) { }
  return conn;
}
/** kolom tautan publik (BKU & Grup Iuran) — dipastikan ada untuk DB sekolah lama */
function ensurePublicColumns(conn) {
  const cols = t => { try { return conn.pragma(`table_info("${t}")`).map(c => c.name); } catch (e) { return []; } };
  const tc = cols('transaksi');
  if (tc.length && !tc.includes('jumlah_barang')) conn.exec('ALTER TABLE transaksi ADD COLUMN jumlah_barang REAL NOT NULL DEFAULT 1');
  if (tc.length && !tc.includes('harga_satuan')) conn.exec('ALTER TABLE transaksi ADD COLUMN harga_satuan REAL NOT NULL DEFAULT 0');
  if (tc.length && cols('coa').length) conn.exec(`UPDATE transaksi SET harga_satuan=nominal
    WHERE COALESCE(harga_satuan,0)<=0 AND coa_id IN (SELECT id FROM coa WHERE kode IN ('5.2.01','5.2.02'))`);
  const bc = cols('bku');
  const cc = cols('coa');
  if (bc.length && !bc.includes('pemasukan_saldo')) {
    conn.exec('ALTER TABLE bku ADD COLUMN pemasukan_saldo INTEGER NOT NULL DEFAULT 0');
    conn.exec("UPDATE bku SET pemasukan_saldo=1 WHERE COALESCE(jenis,'umum')<>'kegiatan'");
  }
  if (bc.length && !bc.includes('rab')) conn.exec('ALTER TABLE bku ADD COLUMN rab REAL NOT NULL DEFAULT 0');
  if (bc.length && !bc.includes('public_token')) conn.exec('ALTER TABLE bku ADD COLUMN public_token TEXT');
  if (bc.length && !bc.includes('is_public')) conn.exec('ALTER TABLE bku ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
  if (bc.length && cc.length) conn.exec(`CREATE TABLE IF NOT EXISTS bku_rab (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, coa_id INTEGER NOT NULL,
    pagu REAL NOT NULL DEFAULT 0, keterangan TEXT, created_at TEXT, updated_at TEXT, tenant_id INTEGER,
    UNIQUE (bku_id, coa_id)
  )`);
  const gc = cols('iuran_grup');
  if (gc.length && !gc.includes('public_token')) conn.exec('ALTER TABLE iuran_grup ADD COLUMN public_token TEXT');
  if (gc.length && !gc.includes('is_public')) conn.exec('ALTER TABLE iuran_grup ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
  const kc = cols('kelas');
  if (kc.length && !kc.includes('public_token')) conn.exec('ALTER TABLE kelas ADD COLUMN public_token TEXT');
  if (kc.length && !kc.includes('is_public')) conn.exec('ALTER TABLE kelas ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
  if (bc.length && gc.length) conn.exec(`CREATE TABLE IF NOT EXISTS bku_iuran_grup (
    bku_id INTEGER NOT NULL, grup_id INTEGER NOT NULL, tenant_id INTEGER,
    PRIMARY KEY (bku_id, grup_id), UNIQUE (grup_id)
  )`);
  if (bc.length) conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_bku_public_token ON bku(public_token) WHERE public_token IS NOT NULL');
  if (gc.length) conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_iuran_grup_public_token ON iuran_grup(public_token) WHERE public_token IS NOT NULL');
  if (kc.length) conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_kelas_public_token ON kelas(public_token) WHERE public_token IS NOT NULL');
}
/** jalankan fn di dalam konteks database satu sekolah */
function runAsTenant(tenant, fn) {
  const conn = openTenantConn(tenant.id, tenant.db_file);
  return dbStore.run(conn, fn);
}
function currentTenantConn() { return dbStore.getStore() || null; }

/* ---------------- migrasi kolom tenant_id ---------------- */
function tableNamesOf(conn) {
  return conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
}
/**
 * TAHAP 1 — setiap tabel milik sekolah diberi kolom `tenant_id` dan diisi
 * dengan id sekolah tersebut. Idempoten: tabel yang sudah punya kolom dilewati,
 * baris yang sudah terisi tidak diubah.
 */
/**
 * UNIQUE gabungan per sekolah: UNIQUE(tenant_id, kolom).
 * Isolasi data sudah dijamin berkas database per sekolah; index ini menegaskan
 * aturan di dalam satu sekolah (NISN, NIP, no. bukti, no. kuitansi).
 * Hanya dibuat bila kolomnya ada dan data lama tidak duplikat.
 */
const TENANT_UNIQUE_IDX = [
  ['uq_siswa_tenant_nisn', 'siswa', ['tenant_id', 'nisn']],
  ['uq_pegawai_tenant_nip', 'pegawai', ['tenant_id', 'nip']],
  ['uq_transaksi_tenant_bukti', 'transaksi', ['tenant_id', 'no_bukti']],
  ['uq_iuran_tenant_kuitansi', 'iuran_bayar', ['tenant_id', 'no_kwitansi']]
];
function ensureTenantUniqueIndexes(conn) {
  let made = 0;
  for (const [name, table, cols] of TENANT_UNIQUE_IDX) {
    try {
      const t = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!t) continue;
      const have = conn.pragma(`table_info("${table}")`).map(c => c.name);
      if (!cols.every(c => have.includes(c))) continue;
      const cond = cols.filter(c => c !== 'tenant_id').map(c => `COALESCE(${c},'')<>''`).join(' AND ');
      conn.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON "${table}"(${cols.join(', ')}) WHERE ${cond}`);
      made++;
    } catch (e) { /* data lama duplikat → index dilewati */ }
  }
  return made;
}

function migrateTenantColumns(conn, tenantId) {
  const tid = Number(tenantId) || 1;
  let added = 0, filled = 0;
  const tables = tableNamesOf(conn);
  conn.transaction(() => {
    for (const t of tables) {
      let cols = [];
      try { cols = conn.pragma(`table_info("${t}")`); } catch (e) { continue; }
      if (!cols.length) continue;
      if (!cols.some(c => c.name === 'tenant_id')) {
        try { conn.exec(`ALTER TABLE "${t}" ADD COLUMN tenant_id INTEGER`); added++; } catch (e) { continue; }
      }
      try { filled += conn.prepare(`UPDATE "${t}" SET tenant_id=? WHERE tenant_id IS NULL`).run(tid).changes; } catch (e) { }
    }
  })();
  try { ensureTenantUniqueIndexes(conn); } catch (e) { }
  return { tables: tables.length, added, filled };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff',
  aktif INTEGER NOT NULL DEFAULT 1, jabatan TEXT DEFAULT '',
  created_at TEXT, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT);
CREATE TABLE IF NOT EXISTS permissions (
  role TEXT NOT NULL, module TEXT NOT NULL, action TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role, module, action)
);
CREATE TABLE IF NOT EXISTS tahun_ajaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, tanggal_mulai TEXT, tanggal_selesai TEXT,
  aktif INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bku (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL DEFAULT 'umum',
  kode TEXT, tahun_ajaran_id INTEGER, saldo_awal REAL NOT NULL DEFAULT 0,
  pemasukan_saldo INTEGER NOT NULL DEFAULT 0, rab REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aktif', ditutup_at TEXT, ditutup_oleh TEXT,
  saldo_akhir_tutup REAL, berita_acara_no TEXT, urutan INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS coa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kode TEXT NOT NULL, nama TEXT NOT NULL,
  kategori TEXT NOT NULL, aktif INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS anggaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tahun_ajaran_id INTEGER NOT NULL, coa_id INTEGER NOT NULL,
  pagu REAL NOT NULL DEFAULT 0, keterangan TEXT,
  UNIQUE (tahun_ajaran_id, coa_id)
);
CREATE TABLE IF NOT EXISTS bku_rab (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, coa_id INTEGER NOT NULL,
  pagu REAL NOT NULL DEFAULT 0, keterangan TEXT, created_at TEXT, updated_at TEXT, tenant_id INTEGER,
  UNIQUE (bku_id, coa_id)
);
CREATE TABLE IF NOT EXISTS transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, tanggal TEXT NOT NULL,
  jenis TEXT NOT NULL, metode TEXT NOT NULL DEFAULT 'tunai', no_bukti TEXT,
  coa_id INTEGER, nominal REAL NOT NULL DEFAULT 0, jumlah_barang REAL NOT NULL DEFAULT 1,
  harga_satuan REAL NOT NULL DEFAULT 0, uraian TEXT, nama_pihak TEXT,
  nota_url TEXT, status TEXT NOT NULL DEFAULT 'posted', rekon_matched INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT, approved_by INTEGER, approved_at TEXT, catatan_approval TEXT
);
CREATE TABLE IF NOT EXISTS piutang (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama_pegawai TEXT NOT NULL, tanggal_utang TEXT,
  nominal REAL NOT NULL DEFAULT 0, tanggal_bayar TEXT, status TEXT NOT NULL DEFAULT 'belum',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS spp (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tahun_ajaran_id INTEGER NOT NULL, bulan INTEGER NOT NULL,
  total_ditagihkan REAL NOT NULL DEFAULT 0, total_diterima REAL NOT NULL DEFAULT 0, keterangan TEXT,
  UNIQUE (tahun_ajaran_id, bulan)
);
CREATE TABLE IF NOT EXISTS aset (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL,
  saldo REAL NOT NULL DEFAULT 0, keterangan TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS rekon_saldo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, tanggal TEXT,
  saldo_koran REAL NOT NULL DEFAULT 0, catatan TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS rekon_saldo_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tahun_ajaran_id INTEGER, tanggal TEXT,
  saldo_koran REAL NOT NULL DEFAULT 0, catatan TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rekon_saldo_global_ta_date
  ON rekon_saldo_global(tahun_ajaran_id, tanggal, id);
CREATE TABLE IF NOT EXISTS koreksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER, bku_id INTEGER,
  aksi TEXT NOT NULL DEFAULT 'edit',
  data_lama TEXT, data_baru TEXT, alasan TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER, requested_nama TEXT, requested_at TEXT,
  reviewed_by INTEGER, reviewed_nama TEXT, reviewed_at TEXT, catatan_review TEXT
);
CREATE TABLE IF NOT EXISTS bku_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bku_id INTEGER, nama_file TEXT, judul_excel TEXT, sheet TEXT,
  jumlah_masuk INTEGER DEFAULT 0, jumlah_keluar INTEGER DEFAULT 0,
  total_masuk REAL DEFAULT 0, total_keluar REAL DEFAULT 0,
  saldo_awal REAL DEFAULT 0, saldo_akhir REAL DEFAULT 0,
  reconciled INTEGER DEFAULT 0, dilewati INTEGER DEFAULT 0,
  user_id INTEGER, user_nama TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_nama TEXT, aksi TEXT,
  modul TEXT, detail TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS piutang_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, piutang_id INTEGER NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, created_by INTEGER
);
CREATE TABLE IF NOT EXISTS pinjaman_mutasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT, aset_id INTEGER,
  tanggal TEXT, keterangan TEXT, jenis TEXT NOT NULL DEFAULT 'masuk',
  nominal REAL NOT NULL DEFAULT 0, created_at TEXT, created_by INTEGER,
  no_bukti TEXT, nama_pihak TEXT, bukti_url TEXT, metode TEXT DEFAULT 'tunai', coa_id INTEGER
);
CREATE TABLE IF NOT EXISTS pegawai (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jabatan TEXT DEFAULT '',
  tipe TEXT NOT NULL DEFAULT 'guru', no_rekening TEXT DEFAULT '', pemilik_rekening TEXT DEFAULT '',
  nip TEXT, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS payroll (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  periode TEXT NOT NULL, pegawai_id INTEGER, nama TEXT NOT NULL, jabatan TEXT DEFAULT '', tipe TEXT DEFAULT 'guru',
  jam_efektif REAL NOT NULL DEFAULT 0, jam_telat REAL NOT NULL DEFAULT 0, honor_jam REAL NOT NULL DEFAULT 0,
  tunjangan_jabatan REAL NOT NULL DEFAULT 0, tunjangan_masa_kerja REAL NOT NULL DEFAULT 0,
  lembur REAL NOT NULL DEFAULT 0, tambahan_penghasilan REAL NOT NULL DEFAULT 0,
  tunjangan_khusus REAL NOT NULL DEFAULT 0, tugas_tambahan REAL NOT NULL DEFAULT 0,
  pot_dana_sosial REAL NOT NULL DEFAULT 0, pot_bpjs_kes REAL NOT NULL DEFAULT 0,
  pot_bpjs_tk REAL NOT NULL DEFAULT 0, pot_sertifikasi REAL NOT NULL DEFAULT 0,
  pot_kasbon REAL NOT NULL DEFAULT 0, kasbon_applied REAL NOT NULL DEFAULT 0,
  piutang_id INTEGER, catatan TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE (periode, pegawai_id)
);
CREATE TABLE IF NOT EXISTS payroll_post (
  id INTEGER PRIMARY KEY AUTOINCREMENT, periode TEXT NOT NULL UNIQUE,
  total_penerimaan REAL DEFAULT 0, total_potongan REAL DEFAULT 0, total_diterima REAL DEFAULT 0,
  dana_sosial REAL DEFAULT 0, trx_umum_id INTEGER, trx_dana_sosial_id INTEGER,
  posted_at TEXT, posted_by TEXT
);
/* status draf leger honor: mode potongan kasbon & catatan (leger tetap draf sampai diposting) */
/* ---------- Leger Honor DINAMIS: kolom bisa ditambah/diubah sekolah ---------- */
CREATE TABLE IF NOT EXISTS payroll_kolom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  tipe TEXT NOT NULL DEFAULT 'penerimaan',
  nilai TEXT NOT NULL DEFAULT 'uang',
  rumus TEXT,
  urutan INTEGER NOT NULL DEFAULT 0,
  sistem INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS payroll_nilai (
  payroll_id INTEGER NOT NULL,
  kolom_kode TEXT NOT NULL,
  nilai REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (payroll_id, kolom_kode)
);
CREATE TABLE IF NOT EXISTS payroll_draft (
  periode TEXT PRIMARY KEY,
  kasbon_auto INTEGER NOT NULL DEFAULT 1,
  kasbon_at TEXT, kasbon_by TEXT, kasbon_total REAL NOT NULL DEFAULT 0,
  catatan TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS beasiswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, tahun_ajaran_id INTEGER,
  nominal REAL NOT NULL DEFAULT 0, keterangan TEXT, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS beasiswa_siswa (
  beasiswa_id INTEGER NOT NULL, siswa_id INTEGER NOT NULL,
  nominal REAL NOT NULL DEFAULT 0, UNIQUE (beasiswa_id, siswa_id)
);
CREATE INDEX IF NOT EXISTS idx_bs_siswa ON beasiswa_siswa(siswa_id);
/* pesan / catatan orang tua dari portal publik */
CREATE TABLE IF NOT EXISTS portal_pesan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER, nama TEXT, kontak TEXT,
  pesan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'baru',
  tahun_ajaran_id INTEGER, created_at TEXT, selesai_at TEXT, selesai_by TEXT,
  sumber TEXT DEFAULT 'siswa', ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_pp_status ON portal_pesan(status);
/* ---------- notifikasi internal (lonceng pada header) ----------
   untuk = kode role penerima ('super_admin', 'kepala_sekolah', 'staff', 'semua').
   Dipakai modul pembayaran iuran portal agar bendahara langsung tahu ada
   pembayaran manual baru yang menunggu verifikasi. */
CREATE TABLE IF NOT EXISTS notif (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  untuk TEXT NOT NULL DEFAULT 'super_admin',
  jenis TEXT, judul TEXT, isi TEXT, href TEXT, ref TEXT,
  dibaca INTEGER NOT NULL DEFAULT 0, created_at TEXT, baca_at TEXT, baca_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_baca ON notif(untuk, dibaca, id);
/* catatan / laporan kekeliruan dari pegawai (login) kepada bendahara */
CREATE TABLE IF NOT EXISTS catatan_pegawai (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, nama TEXT NOT NULL, jabatan TEXT,
  pesan TEXT NOT NULL, terkait TEXT, periode TEXT, status TEXT NOT NULL DEFAULT 'baru',
  balasan TEXT, balas_oleh TEXT, balas_at TEXT, tahun_ajaran_id INTEGER,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cp_status ON catatan_pegawai(status);
/* kode OTP portal publik (pegawai / slip gaji) */
CREATE TABLE IF NOT EXISTS otp_code (
  token TEXT PRIMARY KEY, jenis TEXT NOT NULL, ref TEXT,
  phone TEXT, kode TEXT NOT NULL, expires_at TEXT, tries INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS bku_periode (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bku_id INTEGER NOT NULL, periode TEXT NOT NULL,
  saldo_awal REAL NOT NULL DEFAULT 0,
  total_masuk REAL NOT NULL DEFAULT 0, total_keluar REAL NOT NULL DEFAULT 0,
  saldo_buku REAL NOT NULL DEFAULT 0, saldo_akhir REAL NOT NULL DEFAULT 0,
  metode TEXT NOT NULL DEFAULT 'rollover',
  opnam_tunai REAL, opnam_bank REAL, selisih REAL NOT NULL DEFAULT 0,
  alasan TEXT, metode_penyesuaian TEXT, transaksi_penyesuaian_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ditutup',
  berita_acara_no TEXT, ditutup_at TEXT, ditutup_oleh TEXT,
  UNIQUE (bku_id, periode)
);
CREATE TABLE IF NOT EXISTS piutang_lain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL, kategori TEXT NOT NULL DEFAULT 'Sertifikasi',
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'belum', tanggal_bayar TEXT,
  bku_id INTEGER, created_at TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS piutang_lain_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, piutang_id INTEGER NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, created_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pl_bayar ON piutang_lain_bayar(piutang_id);
CREATE INDEX IF NOT EXISTS idx_trx_bku ON transaksi(bku_id);
CREATE INDEX IF NOT EXISTS idx_trx_coa ON transaksi(coa_id);
CREATE INDEX IF NOT EXISTS idx_trx_status ON transaksi(status);
CREATE INDEX IF NOT EXISTS idx_piutang_nama ON piutang(nama_pegawai);
CREATE INDEX IF NOT EXISTS idx_payroll_periode ON payroll(periode);
CREATE INDEX IF NOT EXISTS idx_pl_nama ON piutang_lain(nama);
CREATE INDEX IF NOT EXISTS idx_trx_tgl ON transaksi(tanggal);
CREATE INDEX IF NOT EXISTS idx_bayar_piutang ON piutang_bayar(piutang_id);
/* ---------- kotak sampah (soft delete 30 hari) ---------- */
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tabel TEXT NOT NULL, row_id INTEGER,
  label TEXT, data TEXT NOT NULL, extra TEXT, alasan TEXT,
  user_id INTEGER, user_nama TEXT, deleted_at TEXT, expired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trash_tabel ON trash(tabel);
/* ---------- akademik ---------- */
CREATE TABLE IF NOT EXISTS program_keahlian (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, program_studi TEXT DEFAULT '',
  ketua TEXT DEFAULT '', aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS kelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, nama_kelas TEXT, tingkat TEXT DEFAULT '',
  wali_kelas TEXT DEFAULT '', program_id INTEGER, tahun_ajaran_id INTEGER,
  aktif INTEGER NOT NULL DEFAULT 1, urutan INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS siswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nisn TEXT, nama TEXT NOT NULL,
  jenis_kelamin TEXT DEFAULT 'L', tanggal_lahir TEXT, kelas_id INTEGER,
  tahun_ajaran_id INTEGER, status TEXT NOT NULL DEFAULT 'aktif',
  keterangan TEXT, parent_phone TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_siswa_kelas ON siswa(kelas_id);
CREATE INDEX IF NOT EXISTS idx_siswa_nama ON siswa(nama);
CREATE INDEX IF NOT EXISTS idx_siswa_nisn ON siswa(nisn);
CREATE TABLE IF NOT EXISTS siswa_mutasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER, kelas_asal_id INTEGER, kelas_tujuan_id INTEGER,
  ta_asal_id INTEGER, ta_tujuan_id INTEGER, status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER, created_at TEXT, applied_at TEXT, applied_by TEXT
);
/* ---------- iuran siswa ---------- */
CREATE TABLE IF NOT EXISTS iuran_grup (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL DEFAULT 'bulanan',
  tahun_ajaran_id INTEGER, keterangan TEXT, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS bku_iuran_grup (
  bku_id INTEGER NOT NULL, grup_id INTEGER NOT NULL, tenant_id INTEGER,
  PRIMARY KEY (bku_id, grup_id), UNIQUE (grup_id)
);
CREATE TABLE IF NOT EXISTS iuran_nominal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grup_id INTEGER NOT NULL, bulan INTEGER,
  nominal REAL NOT NULL DEFAULT 0, tingkat TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS iuran_tagihan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grup_id INTEGER NOT NULL, siswa_id INTEGER NOT NULL,
  tahun_ajaran_id INTEGER, nominal REAL NOT NULL DEFAULT 0, potongan REAL NOT NULL DEFAULT 0,
  keterangan TEXT, created_at TEXT, UNIQUE (grup_id, siswa_id)
);
/* ---------- pengingat tagihan via WhatsApp (broadcast scheduler) ---------- */
CREATE TABLE IF NOT EXISTS wa_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, isi TEXT NOT NULL,
  urutan INTEGER NOT NULL DEFAULT 0, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS wa_reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER, nama TEXT, phone TEXT, kelas TEXT,
  nominal REAL NOT NULL DEFAULT 0, pesan TEXT, status TEXT NOT NULL DEFAULT 'pending',
  error TEXT, mode TEXT NOT NULL DEFAULT 'manual', pemicu TEXT, batch TEXT,
  created_at TEXT, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_log_status ON wa_reminder_log(status, id);
CREATE INDEX IF NOT EXISTS idx_wa_log_created ON wa_reminder_log(created_at);
CREATE TABLE IF NOT EXISTS iuran_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tagihan_id INTEGER, siswa_id INTEGER,
  tanggal TEXT, jumlah REAL NOT NULL DEFAULT 0, potongan REAL NOT NULL DEFAULT 0,
  dibayar REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai', keterangan TEXT,
  bku_id INTEGER, transaksi_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
  kwitansi_no TEXT, print_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT, posted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_iuran_bayar_tag ON iuran_bayar(tagihan_id);
CREATE INDEX IF NOT EXISTS idx_iuran_bayar_tgl ON iuran_bayar(tanggal);
CREATE INDEX IF NOT EXISTS idx_iuran_tagihan_ta_id ON iuran_tagihan(tahun_ajaran_id, id);
CREATE INDEX IF NOT EXISTS idx_iuran_bayar_status_tgl ON iuran_bayar(status, tanggal, id);
/* ---------- pembayaran iuran mandiri dari portal orang tua ----------
   Satu baris = satu keranjang pembayaran (bisa beberapa item tagihan/bulan).
   status: 'menunggu' (menunggu pembayaran gateway / verifikasi bendahara),
           'lunas' (diverifikasi bendahara atau callback gateway sukses),
           'ditolak' (bukti tidak sah), 'batal' (kedaluwarsa / dibatalkan).
   Saat lunas, rincian item dipecah menjadi baris iuran_bayar status 'pending'
   sehingga otomatis muncul di Antrean Posting Iuran. */
CREATE TABLE IF NOT EXISTS iuran_checkout (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siswa_id INTEGER, nama TEXT, kelas TEXT,
  items TEXT, total REAL NOT NULL DEFAULT 0,
  metode TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'menunggu',
  provider TEXT, order_id TEXT, gateway_status TEXT,
  qr_string TEXT, qr_url TEXT, checkout_url TEXT, expires_at TEXT,
  bukti_url TEXT, bukti_nama TEXT, catatan TEXT, alasan TEXT,
  ta_id INTEGER, created_at TEXT, paid_at TEXT, verified_by TEXT, verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_iuran_co_status ON iuran_checkout(status, id);
CREATE INDEX IF NOT EXISTS idx_iuran_co_order ON iuran_checkout(order_id);
CREATE TABLE IF NOT EXISTS ekskul_honor (
  id INTEGER PRIMARY KEY AUTOINCREMENT, periode TEXT, nama_pembina TEXT NOT NULL,
  kehadiran REAL NOT NULL DEFAULT 0, harga_satuan REAL NOT NULL DEFAULT 0,
  keterangan TEXT, status TEXT NOT NULL DEFAULT 'pending', bku_id INTEGER,
  transaksi_id INTEGER, created_at TEXT, posted_at TEXT, posted_by TEXT,
  /* bulan pembukuan ke BKU (boleh BEDA dengan periode kinerja/honor) */
  posting_periode TEXT
);
/* ---------- mutasi bank & cash (tidak lewat BKU) ---------- */
CREATE TABLE IF NOT EXISTS mutasi_kas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, dari TEXT, ke TEXT,
  nominal REAL NOT NULL DEFAULT 0, keterangan TEXT, no_bukti TEXT,
  tahun_ajaran_id INTEGER, created_at TEXT, created_by INTEGER
);
/* ---------- penempatan kelas siswa per tahun pelajaran (riwayat akademik) ----------
   Satu baris = siswa terdaftar di satu kelas pada satu tahun pelajaran.
   Mutasi/penetapan kelas TIDAK lagi menghapus penempatan tahun sebelumnya,
   sehingga rekap akademik tahun asal tetap utuh. Kolom siswa.kelas_id &
   siswa.tahun_ajaran_id hanya cache penempatan TERBARU (lihat siswaSyncCurrent). */
CREATE TABLE IF NOT EXISTS siswa_penempatan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER NOT NULL, kelas_id INTEGER,
  tahun_ajaran_id INTEGER NOT NULL, sumber TEXT NOT NULL DEFAULT 'manual',
  mutasi_id INTEGER, created_at TEXT, updated_at TEXT,
  UNIQUE (siswa_id, tahun_ajaran_id)
);
CREATE INDEX IF NOT EXISTS idx_penempatan_ta ON siswa_penempatan(tahun_ajaran_id, kelas_id);
CREATE INDEX IF NOT EXISTS idx_penempatan_siswa ON siswa_penempatan(siswa_id);
/* ---------- piutang lainnya: kategori fleksibel + tagihan/cicilan ---------- */
CREATE TABLE IF NOT EXISTS piutang_kategori (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, keterangan TEXT DEFAULT '',
  tampil_aset INTEGER NOT NULL DEFAULT 1, aktif INTEGER NOT NULL DEFAULT 1,
  urutan INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS piutang_lainnya (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kategori_id INTEGER, nama TEXT NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'belum', tanggal_bayar TEXT, bku_id INTEGER,
  created_at TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS piutang_lainnya_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, piutang_id INTEGER NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, created_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pln_bayar ON piutang_lainnya_bayar(piutang_id);
CREATE INDEX IF NOT EXISTS idx_pln_nama ON piutang_lainnya(nama);
CREATE INDEX IF NOT EXISTS idx_pln_ta ON piutang_lainnya(tahun_ajaran_id);
/* ---------- riwayat auto-backup (Telegram) ---------- */
CREATE TABLE IF NOT EXISTS cloud_backup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waktu TEXT, nama_berkas TEXT, ukuran INTEGER, file_id TEXT,
  status TEXT NOT NULL DEFAULT 'gagal', pesan TEXT,
  pemicu TEXT NOT NULL DEFAULT 'manual', user_nama TEXT,
  dihapus INTEGER NOT NULL DEFAULT 0, durasi_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cloud_backup_waktu ON cloud_backup(waktu);
/* ---------- Beasiswa multi-grup iuran ---------- */
CREATE TABLE IF NOT EXISTS beasiswa_grup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beasiswa_id INTEGER NOT NULL,
  grup_id INTEGER NOT NULL,
  bulan_mask TEXT,
  UNIQUE(beasiswa_id, grup_id)
);
/* ---------- Petunjuk Pengguna: panduan bergambar + video/PDF ---------- */
CREATE TABLE IF NOT EXISTS panduan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judul TEXT NOT NULL,
  kategori TEXT,
  ringkas TEXT,
  thumbnail TEXT,
  video_url TEXT,
  pdf_url TEXT,
  urutan INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
`;

const DEFAULT_PERMS = {
  // module: [actions]
};
const MODULES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'pengguna', label: 'Manajemen Pengguna' },
  { key: 'sekolah', label: 'Identitas Sekolah' },
  { key: 'tahun_ajaran', label: 'Tahun Ajaran' },
  { key: 'bku', label: 'Master BKU' },
  { key: 'coa', label: 'Kode Rekening (CoA)' },
  { key: 'anggaran', label: 'Anggaran RAPBS/RKAS' },
  { key: 'aset', label: 'Aset Riil' },
  { key: 'saldo_awal', label: 'Saldo Awal' },
  { key: 'transaksi', label: 'Transaksi Keuangan' },
  { key: 'tutup_bulanan', label: 'Tutup BKU Bulanan' },
  { key: 'import', label: 'Import Excel BKU' },
  { key: 'piutang', label: 'Piutang & SPP' },
  { key: 'piutang_lain', label: 'Piutang Lain-lain (Sertifikasi)' },
  { key: 'piutang_lainnya', label: 'Piutang Lainnya' },
  { key: 'iuran', label: 'Iuran Siswa' },
  { key: 'ekskul', label: 'Honor Pembina Ekskul' },
  { key: 'siswa', label: 'Data Siswa' },
  { key: 'kelas', label: 'Data Kelas' },
  { key: 'program', label: 'Program Keahlian' },
  { key: 'mutasi_kelas', label: 'Mutasi Kelas Siswa' },
  { key: 'mutasi_kas', label: 'Mutasi Bank & Cash' },
  { key: 'trash', label: 'Kotak Sampah (Trash Bin)' },
  { key: 'beasiswa', label: 'Master Beasiswa SPP' },
  { key: 'pegawai', label: 'Data Pegawai' },
  { key: 'payroll', label: 'Payroll & Leger Honor' },
  { key: 'rekon', label: 'Rekonsiliasi Bank' },
  { key: 'catatan', label: 'Catatan Pegawai' },
  { key: 'laporan', label: 'Laporan & Export' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'backup', label: 'Backup & Restore' },
  { key: 'panduan', label: 'Petunjuk Pengguna' },
  { key: 'legal', label: 'Legalitas Layanan (ToS & SLA)' }
];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];

const ROLE_LABEL = {
  super_admin: 'Super Admin / Bendahara Utama',
  kepala_sekolah: 'Kepala Sekolah',
  staff: 'Staff / Staf Inputer'
};
/** role akun sekolah (role "demo" sudah dihapus total — lihat migrasi di bootstrap) */
const ROLES = ['super_admin', 'kepala_sekolah', 'staff'];
/** modul yang TIDAK boleh dibuka akun demo secara bawaan (bisa diubah admin lewat Permission Matrix) */
const DEMO_BLOCKED = ['pengguna', 'sekolah', 'backup', 'trash', 'audit', 'tahun_ajaran', 'saldo_awal'];

function defaultAllowed(role, module, action) {
  if (role === 'super_admin') return 1;
  if (role === 'demo') {
    if (DEMO_BLOCKED.includes(module)) return 0;
    // sandbox: semua modul operasional boleh dicoba (tanpa menu sistem)
    return 1;
  }
  const AKADEMIK = ['siswa', 'kelas', 'program', 'mutasi_kelas', 'iuran', 'ekskul'];
  if (role === 'kepala_sekolah') {
    if (action === 'view') return ['dashboard', 'transaksi', 'laporan', 'bku', 'anggaran', 'piutang', 'piutang_lain', 'piutang_lainnya', 'sekolah', 'audit', 'tutup_bulanan', 'import', 'pegawai', 'payroll', 'beasiswa', 'mutasi_kas', 'catatan', 'panduan', 'legal', ...AKADEMIK].includes(module) ? 1 : 0;
    if (action === 'approve' && module === 'transaksi') return 1;
    if (action === 'edit' && module === 'catatan') return 1;
    if (action === 'export' && ['laporan', 'payroll', 'iuran'].includes(module)) return 1;
    return 0;
  }
  if (role === 'staff') {
    if (action === 'view') return ['dashboard', 'transaksi', 'bku', 'piutang', 'piutang_lain', 'piutang_lainnya', 'saldo_awal', 'coa', 'aset', 'pegawai', 'beasiswa', 'mutasi_kas', 'catatan', 'panduan', 'legal', ...AKADEMIK].includes(module) ? 1 : 0;
    if (action === 'create') return ['transaksi', 'piutang', 'piutang_lain', 'piutang_lainnya', 'iuran', 'siswa', 'ekskul', 'catatan'].includes(module) ? 1 : 0;
    if (action === 'edit') return ['transaksi', 'piutang_lain', 'piutang_lainnya', 'iuran', 'siswa'].includes(module) ? 1 : 0;
    return 0;
  }
  return 0;
}

const COA_SEED = [
  ['4.1.01', 'Penerimaan SPP', 'pendapatan'],
  ['4.1.02', 'Infak / Sumbangan Siswa', 'pendapatan'],
  ['4.1.03', 'Pendapatan Lain-lain', 'pendapatan'],
  ['4.1.04', 'Dana BOS / Bantuan Pemerintah', 'pendapatan'],
  ['4.1.05', 'Pendapatan Unit Bisnis', 'pendapatan'],
  ['5.1.01', 'Belanja Pegawai / Honorarium', 'pengeluaran'],
  ['5.2.01', 'Belanja Barang Habis Pakai (BHP)', 'pengeluaran'],
  ['5.2.02', 'Belanja Barang Modal / Inventaris', 'pengeluaran'],
  ['5.2.03', 'Belanja Langganan & Jasa', 'pengeluaran'],
  ['5.2.04', 'Belanja Perjalanan Dinas & Transport', 'pengeluaran'],
  ['5.2.05', 'Kegiatan Kesiswaan & Akademik', 'pengeluaran'],
  ['4.1.06', 'Penerimaan Iuran Siswa', 'pendapatan'],
  ['4.1.07', 'Penerimaan Kegiatan Siswa', 'pendapatan'],
  ['2.1.01', 'Pungutan PPN', 'pajak'],
  ['2.1.02', 'Pungutan PPh Pasal 21', 'pajak'],
  ['2.1.03', 'Pungutan PPh Pasal 22/23', 'pajak'],
  ['2.1.04', 'Penyetoran Pajak', 'pajak'],
  ['9.1.01', 'Tarik Tunai Bank ke Kas Tunai', 'mutasi'],
  ['9.1.02', 'Setor Tunai ke Bank', 'mutasi'],
  ['9.1.03', 'Biaya Administrasi Bank & Pendapatan Bunga', 'mutasi'],
  ['9.1.04', 'Pindah Saldo Antar BKU (Keluar)', 'mutasi'],
  ['9.1.05', 'Pindah Saldo Antar BKU (Masuk)', 'mutasi'],
  ['9.2.01', 'Selisih Kas Lebih (Opnam)', 'mutasi'],
  ['9.2.02', 'Selisih Kas Kurang (Opnam)', 'mutasi']
];

/**
 * Kelompok efektif kode rekening untuk pemilihan transaksi:
 * kode pajak & mutasi kas/administrasi ikut tergolong kelompok PENGELUARAN.
 */
const COA_EXPENSE_KATEGORI = ['pengeluaran', 'pajak', 'mutasi'];
const COA_INCOME_KATEGORI = ['pendapatan', 'mutasi'];
const KATEGORI_EFF = { pajak: 'pengeluaran', mutasi: 'pengeluaran' };
function effKategori(kat) { return KATEGORI_EFF[kat] || kat; }
const KATEGORI_LABEL = {
  pendapatan: ['Pendapatan / Penerimaan Kas Masuk', 'green'],
  pengeluaran: ['Pengeluaran & Belanja (termasuk Pajak, Mutasi Kas & Biaya Administrasi)', 'orange'],
  pajak: ['Kode Pajak (kelompok Pengeluaran)', 'amber'],
  mutasi: ['Mutasi Kas & Biaya Administrasi (kelompok Pengeluaran)', 'blue']
};

/* ==================================================================
   JENJANG PENDIDIKAN & MASTER TINGKAT KELAS
   ------------------------------------------------------------------
   Tingkat disimpan sebagai STRING pada `kelas.tingkat` (mis. "VII", "10",
   "TK-A") supaya sekolah bebas memakai konvensi angka/romawi. Urutan
   tampilan & kenaikan tingkat memakai TINGKAT_MASTER di bawah.
   ================================================================== */
const JENJANG = {
  'PAUD/TK': { label: 'PAUD / TK', preset: ['KB', 'TK-A', 'TK-B'] },
  'SD/MI': { label: 'SD / MI', preset: ['I', 'II', 'III', 'IV', 'V', 'VI'] },
  'SMP/MTs': { label: 'SMP / MTs', preset: ['VII', 'VIII', 'IX'] },
  'SMA/MA': { label: 'SMA / MA', preset: ['X', 'XI', 'XII'] },
  'SMK': { label: 'SMK', preset: ['X', 'XI', 'XII'] },
  'KUSTOM': { label: 'Kustom (pilih sendiri)', preset: [] }
};
/* ---------------- identitas resmi sekolah (kolom legalitas) ---------------- */
const BENTUK_PENDIDIKAN = [
  ['SMK', 'Sekolah Menengah Kejuruan (SMK)'],
  ['SMA', 'Sekolah Menengah Atas (SMA)'],
  ['MA', 'Madrasah Aliyah (MA)'],
  ['SMP', 'Sekolah Menengah Pertama (SMP)'],
  ['MTS', 'Madrasah Tsanawiyah (MTs)'],
  ['SD', 'Sekolah Dasar (SD)'],
  ['MI', 'Madrasah Ibtidaiyah (MI)'],
  ['PAUD', 'PAUD / TK / RA'],
  ['LAIN', 'Lainnya / Custom']
];
const BENTUK_LABEL = BENTUK_PENDIDIKAN.reduce((m, [k, v]) => { m[k] = v; return m; }, {});
const STATUS_SEKOLAH = ['Negeri', 'Swasta'];
const KEPEMILIKAN_OPTIONS = ['Pemerintah Daerah', 'Yayasan', 'Kementerian Agama', 'Pemerintah Pusat', 'Perorangan', 'Lainnya'];
/** data identitas resmi siap pakai (kop surat, kwitansi, footer portal) */
function identitasSekolah() {
  const s = settingsAll();
  return {
    nama: String(s.sekolah_nama || '').trim(),
    npsn: String(s.sekolah_npsn || '').trim(),
    bentuk: String(s.sekolah_bentuk || '').trim(),
    bentuk_label: BENTUK_LABEL[String(s.sekolah_bentuk || '').trim()] || '',
    status: String(s.sekolah_status || '').trim(),
    kepemilikan: String(s.sekolah_kepemilikan || '').trim(),
    alamat: String(s.sekolah_alamat || '').trim(),
    telp: String(s.sekolah_telp || '').trim(),
    email: String(s.sekolah_email || '').trim(),
    website: String(s.sekolah_website || '').trim(),
    kepala: String(s.sekolah_kepala || '').trim(),
    nip_kepala: String(s.sekolah_nip_kepala || '').trim(),
    bendahara: String(s.sekolah_bendahara || '').trim(),
    nip_bendahara: String(s.sekolah_nip_bendahara || '').trim()
  };
}
/** seluruh opsi tingkat standar: pra-sekolah, I..XII, angka 1..12 */
const TINGKAT_MASTER = [
  { kode: 'KB', label: 'Kelompok Bermain' },
  { kode: 'TK-A', label: 'TK A' },
  { kode: 'TK-B', label: 'TK B' },
  { kode: 'I', label: 'Tingkat I' }, { kode: 'II', label: 'Tingkat II' }, { kode: 'III', label: 'Tingkat III' },
  { kode: 'IV', label: 'Tingkat IV' }, { kode: 'V', label: 'Tingkat V' }, { kode: 'VI', label: 'Tingkat VI' },
  { kode: 'VII', label: 'Tingkat VII' }, { kode: 'VIII', label: 'Tingkat VIII' }, { kode: 'IX', label: 'Tingkat IX' },
  { kode: 'X', label: 'Tingkat X' }, { kode: 'XI', label: 'Tingkat XI' }, { kode: 'XII', label: 'Tingkat XII' },
  { kode: 'PAUD', label: 'PAUD' }
];
const TINGKAT_ALIAS = {
  '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V', '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX',
  '10': 'X', '11': 'XI', '12': 'XII', 'TK A': 'TK-A', 'TKA': 'TK-A', 'TK B': 'TK-B', 'TKB': 'TK-B'
};
/** urutan angka tingkat: KB/PAUD = 0, TK-A = 1, I..XII = 1..12 */
function tingkatUrut(t) {
  const raw = String(t || '').trim().toUpperCase();
  if (!raw) return 99;
  const kode = TINGKAT_ALIAS[raw] || raw;
  const idx = ['KB', 'PAUD', 'TK-A', 'TK-B', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].indexOf(kode);
  if (kode === 'KB' || kode === 'PAUD') return 0;
  if (kode === 'TK-A') return 1;
  if (kode === 'TK-B') return 2;
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].indexOf(kode);
  if (roman >= 0) return 3 + roman;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? 3 + n - 1 : 50 + (idx < 0 ? 0 : idx);
}
/** tingkat berikutnya saat naik kelas (XII / TK-B / 12 = lulus → '') */
function tingkatNaik(t) {
  const order = ['KB', 'TK-A', 'TK-B', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const raw = String(t || '').trim().toUpperCase();
  // konvensi ANGKA (7, 8, … 12) dipertahankan sebagai angka
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return (n > 0 && n < 12) ? String(n + 1) : '';
  }
  const kode = TINGKAT_ALIAS[raw] || raw;
  const i = order.indexOf(kode);
  if (i < 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 12) return String(n + 1);
    return '';
  }
  return order[i + 1] || '';
}
const tingkatLabel = t => {
  const raw = String(t || '').trim();
  if (!raw) return '-';
  const m = TINGKAT_MASTER.find(x => x.kode.toUpperCase() === raw.toUpperCase());
  return m ? m.label : raw;
};
/** preset tingkat berdasarkan jenjang (dipakai saat profil sekolah disimpan) */
function jenjangPreset(jenjang) {
  const j = JENJANG[String(jenjang || '').trim()];
  return j ? j.preset.slice() : [];
}
/** daftar tingkat AKTIF sekolah (setting `tingkat_aktif` JSON; kosong = preset jenjang) */
function tingkatAktif() {
  let list = [];
  try { list = JSON.parse(getSetting('tingkat_aktif', '[]') || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list) || !list.length) list = jenjangPreset(getSetting('jenjang_pendidikan', ''));
  if (!list.length) list = ['VII', 'VIII', 'IX'];
  return list.map(x => String(x).trim()).filter(Boolean)
    .sort((a, b) => tingkatUrut(a) - tingkatUrut(b));
}
function setTingkatAktif(list) {
  const clean = [...new Set([].concat(list || []).map(x => String(x).trim()).filter(Boolean))]
    .sort((a, b) => tingkatUrut(a) - tingkatUrut(b));
  setSetting('tingkat_aktif', JSON.stringify(clean));
  return clean;
}
/** aktifkan preset jenjang: bila tingkat_aktif masih kosong atau dipaksa */
function applyJenjangPreset(jenjang, force) {
  const cur = (() => { try { return JSON.parse(getSetting('tingkat_aktif', '[]') || '[]'); } catch (e) { return []; } })();
  if (!force && Array.isArray(cur) && cur.length) return { changed: false, list: tingkatAktif() };
  const preset = jenjangPreset(jenjang);
  if (!preset.length) return { changed: false, list: tingkatAktif() };
  return { changed: true, list: setTingkatAktif(preset) };
}

const BKU_UMUM = ['BKU Umum', 'Buku Kas Pembantu Bank', 'Buku Pembantu Pajak', 'Buku Pembantu Tunai', 'Rekapitulasi Barang Habis Pakai', 'Barang Modal'];
const BKU_KEGIATAN = ['BKU UKK', 'BKU PKL', 'BKU SPMB', 'BKU Bantuan', 'BKU PSTS Ganjil', 'BKU PSTS Genap', 'BKU ASAS', 'BKU ASAT', 'BKU PSAJ', 'Dana Sosial', 'Infak Jumat'];
/** 5 buku pembantu/rekap — saldo TIDAK diinput manual, hanya menerima rekapitulasi otomatis dari transaksi */
const BKU_AUTO_NAMES = ['Buku Kas Pembantu Bank', 'Buku Pembantu Pajak', 'Buku Pembantu Tunai', 'Rekapitulasi Barang Habis Pakai', 'Barang Modal'];
const isAutoBkuNama = n => BKU_AUTO_NAMES.includes(String(n || ''));
/**
 * Kode BKU otomatis berikutnya berdasarkan urutan yang sudah ada.
 * Umum → U01, U02, … · Kegiatan → K01, K02, …
 */
function nextBkuKode(jenis) {
  const pref = String(jenis || 'umum') === 'kegiatan' ? 'K' : 'U';
  let max = 0;
  for (const r of db.prepare('SELECT kode FROM bku WHERE kode LIKE ?').all(pref + '%')) {
    const m = /(\d+)\s*$/.exec(String(r.kode || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return pref + String(max + 1).padStart(2, '0');
}

/* ==========================================================================
   DOMAIN PUBLIK: tautan acak untuk BKU & Grup Iuran (tanpa login)
   --------------------------------------------------------------------------
   Token = 24 karakter hex (96 bit, crypto.randomBytes) sehingga tidak dapat
   ditebak. Halaman publik hanya dilayani bila `is_public = 1` DAN token pada
   URL persis sama. Regenerasi token otomatis menonaktifkan tautan lama.
   ========================================================================== */
const PUBLIC_TABEL = { bku: 'bku', iuran: 'iuran_grup', kelas: 'kelas' };
function newPublicToken() { return crypto.randomBytes(12).toString('hex'); }
/**
 * Pastikan baris punya token publik.
 * `regen = true` selalu membuat token baru (tautan lama langsung mati).
 * → { token, dibuat } atau null bila baris tidak ada.
 */
function publicTokenEnsure(tabel, id, regen) {
  const t = PUBLIC_TABEL[tabel];
  if (!t) return null;
  const row = db.prepare(`SELECT id, public_token FROM ${t} WHERE id=?`).get(id);
  if (!row) return null;
  let token = String(row.public_token || '');
  if (regen || !token) {
    token = newPublicToken();
    db.prepare(`UPDATE ${t} SET public_token=? WHERE id=?`).run(token, id);
    return { token, dibuat: true };
  }
  return { token, dibuat: false };
}
/** aktif/nonaktifkan akses publik satu baris */
function publicSetActive(tabel, id, aktif) {
  const t = PUBLIC_TABEL[tabel];
  if (!t) return false;
  const info = db.prepare(`UPDATE ${t} SET is_public=? WHERE id=?`).run(aktif ? 1 : 0, id);
  return info.changes > 0;
}
/** cari baris berdasarkan token publik (hanya yang aktif) */
function publicFind(tabel, token) {
  const t = PUBLIC_TABEL[tabel];
  const tk = String(token || '').trim();
  if (!t || !/^[a-f0-9]{8,64}$/i.test(tk)) return null;
  return db.prepare(`SELECT * FROM ${t} WHERE public_token=? AND COALESCE(is_public,0)=1`).get(tk) || null;
}


function bootstrap() {
  /* database benar-benar baru (belum punya tabel) → semua data ditulis dengan
     jam WIB sejak awal, jadi migrasi penggeseran stempel waktu dilewati. */
  let brandNew = false;
  try { brandNew = !db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c; } catch (e) { brandNew = true; }
  db.transaction(() => {
    db.exec(SCHEMA);

    /* ---------- geser stempel waktu lama ke WIB (sekali saja) ----------
       Dijalankan SEBELUM seed supaya baris contoh yang baru dibuat (sudah WIB)
       tidak ikut tergeser. Database baru langsung ditandai selesai. */
    try {
      if (brandNew) {
        db.prepare("INSERT INTO settings (k,v) VALUES ('mig_tz_wib_v1',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run('database-baru:' + nowStamp());
      } else {
        migrateLegacyTimestamps(db, 'settings');
      }
    } catch (e) { console.error('[tz-migrasi]', e.message); }

    // settings
    const setif = db.prepare('INSERT OR IGNORE INTO settings (k,v) VALUES (?,?)');
    const defaults = {
      sekolah_nama: 'SMK PGRI Cikoneng',
      sekolah_alamat: 'Jl. Pendidikan No. 1, Kec. Cikoneng, Kab. Ciamis 46271\nTelp. (0265) 123456 • Email: info@smkpgricikoneng.sch.id',
      sekolah_kepala: 'Drs. H. Ahmad Fauzi, M.Pd.',
      sekolah_nip_kepala: '196804121994031005',
      sekolah_bendahara: 'Siti Nurhaliza, S.E.',
      sekolah_nip_bendahara: '198207152008012011',
      // ---- identitas resmi & legalitas (menu Identitas Sekolah) ----
      sekolah_npsn: '',
      sekolah_bentuk: '',
      sekolah_status: '',
      sekolah_kepemilikan: '',
      sekolah_telp: '',
      sekolah_email: '',
      sekolah_website: '',
      sekolah_logo: '',
      approval_threshold: '5000000',
      tampil_piutang_spp: '1',
      tampil_piutang_sertifikasi: '1',
      tampil_piutang_lainnya: '1',
      honor_tugas_jam: '50000',
      honor_pembantu_jam: '50000',
      honor_wali_jam: '50000',
      sertifikasi_per_jam: '12500',
      // kop surat resmi (boleh diubah pada menu Identitas Sekolah)
      kop_baris: 'PERWAKILAN YAYASAN PEMBINA LEMBAGA PENDIDIKAN\nPERSATUAN GURU REPUBLIK INDONESIA\n(YPLP-PGRI) KABUPATEN CIAMIS\nSEKOLAH MENENGAH KEJURUAN PGRI CIKONENG\nAKREDITASI : A - NPSN : 20211525\nJalan Raya No.144 Telp./Fax.:(0265)773258 e-mail:smkpgrickn@yahoo.co.id Cikoneng- Ciamis',
      kop_font: '10',
      kop_font_besar: '15',
      // kop surat dinamis: 'auto' = dari Identitas Sekolah, 'manual' = teks sendiri
      kop_sumber: 'manual',
      // logo kop terpisah (tidak harus logo utama sekolah) + pengaturan font per baris
      kop_logo: '',
      kop_format: '',        // JSON [{"size":12,"bold":1}, …] per baris kop
      // tempat yang dicetak sebelum tanggal pada semua dokumen ("Cikoneng, 2 November 2026")
      print_tempat: 'Cikoneng',
      print_design: '{}',
      // ukuran kertas kwitansi iuran (mm) — default 21 cm x 9,9 cm (1/3 F4)
      kwitansi_w_mm: '210',
      kwitansi_h_mm: '99',
      kwitansi_margin_mm: '6',
      portal_aktif: '1',
      portal_pegawai_aktif: '1',
      portal_slip_aktif: '1',
      /* ---- pembayaran iuran mandiri dari portal orang tua ---- */
      bayar_gateway_aktif: '0',        // 1 = tombol bayar QRIS/gateway tampil di portal
      bayar_manual_aktif: '1',         // 1 = opsi transfer manual + unggah bukti
      bayar_provider: 'sandbox',        // sandbox | midtrans | duitku | xendit | kasera
      bayar_mode: 'sandbox',
      bayar_merchant: '',
      bayar_key: '',
      bayar_key2: '',
      bayar_callback: '',
      bayar_base: '',
      bayar_expire_menit: '60',
      bayar_instruksi: 'Transfer sesuai total tagihan yang dipilih ke rekening sekolah, lalu unggah bukti pembayaran pada formulir di bawah.',
      qris_image: '',                   // gambar QRIS statis sekolah (opsional)
      notif_bayar_aktif: '1',
      // teks halaman portal publik (kosong = memakai default Super Admin)
      portal_page_title: '',
      portal_subtitle: '',
      // judul tab saat tautan bertoken (?token=…) — boleh memakai placeholder {judul}
      portal_token_title: '',
      // alamat (slug) ujung URL portal publik — boleh diubah, default seperti di bawah
      portal_slug: 'portal-tagihan',
      /* bagian nama sekolah pada alamat portal: /<portal_base_slug>/<portal_slug> */
      portal_base_slug: '',
      portal_pegawai_slug: 'portal-pegawai',
      portal_slip_slug: 'portal-slip',
      // gateway WhatsApp untuk OTP portal publik (kosong = mode demo: kode ditampilkan di layar)
      wa_api_url: '',
      wa_api_token: '',
      wa_api_payload: 'form',
      wa_demo_tampil: '1',
      // ukuran kertas kwitansi transaksi (mm) — default 21 cm x 9,9 cm (1/3 F4)
      kw_trx_w_mm: '210',
      kw_trx_h_mm: '99',
      kw_trx_mt_mm: '6',
      kw_trx_mb_mm: '6',
      kw_trx_ml_mm: '8',
      kw_trx_mr_mm: '8',
      app_nama: 'SIMKEU Sekolah',
      app_logo: '',
      // ---- tampilan: warna dasar aplikasi + penataan menu (drag & drop, label, ikon PNG) ----
      tema_warna: '#F97316',
      // mode tampilan: 'light' (bawaan) atau 'dark'
      mode_tema: 'light',
      nav_ui: '{}',
      // ---- akun demo (sandbox): keterangan & penanda reset ----
      demo_catatan: 'Akun ini memakai database DUMMY terpisah. Semua perubahan tidak memengaruhi data sekolah.',
      demo_seed_ver: '1',
      // ---- Auto-Backup Telegram (menu Pengaturan Auto-Backup) ----
      // bot token & chat id khusus sekolah ini; berkas .zip dikirim 2x sehari (06:00 & 15:00)
      tg_token: '',
      tg_chat: '',
      tg_aktif: '1',
      tg_slots: '06:00,15:00',
      tg_last: '',
      // ---- domain khusus (custom domain) — nilai kanonik ada di control plane ----
      custom_domain: '',
      custom_domain_status: '',
      // ---- Pengingat tagihan via WhatsApp (menu Jadwal Pengingat Tagihan) ----
      reminder_aktif: '0',
      reminder_mode: 'tanggal',            // tanggal | tempo | keduanya
      reminder_tanggal: '5',               // tanggal kirim rutin bulanan (1-28)
      reminder_tempo_hari: '3',            // H-X sebelum jatuh tempo
      reminder_jam: '08:00',
      reminder_template: 'Yth. Orang Tua dari {nama_siswa} ({kelas}),\n\nKami menginformasikan bahwa total tunggakan iuran sekolah sebesar {nominal_tunggakan}.\n\nRincian tagihan:\n{rincian_tagihan}\n\nRincian tagihan dan pembayaran dapat diakses melalui link: {link_portal}\n\nTerima kasih.\n{nama_sekolah}',
      reminder_done: '[]',                 // slot jadwal yang sudah dijalankan (anti kirim ganda)
      reminder_last: '',
      reminder_base_url: '',               // alamat publik untuk {link_portal} (fallback APP_BASE_URL)
      iuran_jatuh_tempo: '10',             // tanggal jatuh tempo bawaan (hari ke-1..28)
      portal_token_secret: '',             // dibuat otomatis pada bootstrap
      wa_log_retensi: '90',                // hari retensi riwayat pengiriman
      // ---- jenjang pendidikan & tingkat kelas aktif (preset otomatis) ----
      jenjang_pendidikan: 'SMP/MTs',
      tingkat_aktif: '["VII","VIII","IX"]'
    };
    for (const [k, v] of Object.entries(defaults)) setif.run(k, v);

    // secret tautan portal per siswa (dipakai {link_portal} pada pengingat WhatsApp)
    if (!String(getSetting('portal_token_secret', '') || '').trim()) {
      setSetting('portal_token_secret', require('crypto').randomBytes(24).toString('hex'));
    }

    // tebak JENJANG dari nama sekolah lama (hanya bila masih nilai bawaan)
    (function guessJenjang() {
      try {
        const jNow = db.prepare("SELECT v FROM settings WHERE k='jenjang_pendidikan'").get();
        const tNow = db.prepare("SELECT v FROM settings WHERE k='tingkat_aktif'").get();
        const isDefault = !jNow || jNow.v === 'SMP/MTs';
        const tDefault = !tNow || String(tNow.v || '').replace(/\s/g, '') === '["VII","VIII","IX"]';
        if (!isDefault || !tDefault) return;
        const nama = String((db.prepare("SELECT v FROM settings WHERE k='sekolah_nama'").get() || {}).v || '').toUpperCase();
        let j = '';
        if (/\bPAUD\b|\bTK\b|TAMAN KANAK/.test(nama)) j = 'PAUD/TK';
        else if (/\bSMK\b/.test(nama)) j = 'SMK';
        else if (/\bSMA\b|\bMA\b|MADRASAH ALIYAH/.test(nama)) j = 'SMA/MA';
        else if (/\bSMP\b|\bMTS\b/.test(nama)) j = 'SMP/MTs';
        else if (/\bSD\b|\bMI\b/.test(nama)) j = 'SD/MI';
        if (!j) return;
        const preset = jenjangPreset(j);
        if (!preset.length) return;
        setSetting('jenjang_pendidikan', j);
        setSetting('tingkat_aktif', JSON.stringify(preset));
      } catch (e) { }
    })();

    // migrasi identitas resmi (ronde 26): isi bentuk pendidikan dari jenjang yang sudah ada,
    // NPSN dari teks kop lama, dan status/kepemilikan dari nama sekolah — hanya bila masih kosong.
    (function guessIdentitas() {
      try {
        const get = k => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? String(r.v || '') : ''; };
        const setIfEmpty = (k, v) => { if (!get(k).trim() && v) setSetting(k, v); };
        const map = { SMK: 'SMK', 'SMA/MA': 'SMA', 'SMP/MTs': 'SMP', 'SD/MI': 'SD', 'PAUD/TK': 'PAUD' };
        setIfEmpty('sekolah_bentuk', map[get('jenjang_pendidikan')] || '');
        const kop = get('kop_baris');
        const mNpsn = /NPSN\s*[:.]?\s*(\d{8})/i.exec(kop);
        if (mNpsn) setIfEmpty('sekolah_npsn', mNpsn[1]);
        const nama = get('sekolah_nama').toUpperCase();
        setIfEmpty('sekolah_status', /\bNEGERI\b/.test(nama) ? 'Negeri' : '');
        setIfEmpty('sekolah_kepemilikan', /\bNEGERI\b/.test(nama) ? 'Pemerintah Daerah' : (/YAYASAN|PGRI/.test(nama) ? 'Yayasan' : ''));
      } catch (e) { }
    })();

    // migrasi identitas sekolah lama → SMK PGRI Cikoneng (hanya bila masih nilai bawaan)
    if (db.prepare("SELECT v FROM settings WHERE k='sekolah_nama'").get()?.v === 'SMA NEGERI 1 NUSANTARA') {
      setSetting('sekolah_nama', 'SMK PGRI Cikoneng');
      const al = db.prepare("SELECT v FROM settings WHERE k='sekolah_alamat'").get();
      if (al && /Nusantara/i.test(al.v || '')) {
        setSetting('sekolah_alamat', 'Jl. Pendidikan No. 1, Kec. Cikoneng, Kab. Ciamis 46271\nTelp. (0265) 123456 • Email: info@smkpgricikoneng.sch.id');
      }
    }

    // permissions — INSERT OR IGNORE agar modul baru otomatis terisi tanpa menimpa kustomisasi
    {
      const ins = db.prepare('INSERT OR IGNORE INTO permissions (role,module,action,allowed) VALUES (?,?,?,?)');
      for (const role of ['super_admin', 'kepala_sekolah', 'staff']) {
        for (const m of MODULES) {
          for (const a of ACTIONS) {
            ins.run(role, m.key, a, defaultAllowed(role, m.key, a));
          }
        }
      }
    }

    // role "Akun Demo" DIHAPUS TOTAL (ronde 26): akun demo lama dinonaktifkan & diubah ke staff,
    // baris permission role demo dibersihkan. Tidak ada lagi pilihan role demo di seluruh modul.
    {
      const n = db.prepare("SELECT COUNT(*) c FROM users WHERE role='demo'").get();
      if (n && n.c) {
        db.prepare("UPDATE users SET role='staff', aktif=0 WHERE role='demo'").run();
      }
      db.prepare("DELETE FROM permissions WHERE role='demo'").run();
    }

    // coa (idempoten per kode, agar kode baru ikut masuk ke DB lama)
    {
      const ins = db.prepare('INSERT INTO coa (kode,nama,kategori,aktif) SELECT ?,?,?,1 WHERE NOT EXISTS (SELECT 1 FROM coa WHERE kode=?)');
      COA_SEED.forEach(r => ins.run(r[0], r[1], r[2], r[0]));
    }

    // tahun ajaran + bku
    if (!db.prepare('SELECT COUNT(*) c FROM tahun_ajaran').get().c) {
      const y = new Date().getFullYear();
      const info = db.prepare('INSERT INTO tahun_ajaran (nama,tanggal_mulai,tanggal_selesai,aktif) VALUES (?,?,?,1)')
        .run(`${y}/${y + 1}`, `${y}-07-01`, `${y + 1}-06-30`);
      const taId = Number(info.lastInsertRowid);
      const insB = db.prepare('INSERT INTO bku (nama,jenis,kode,tahun_ajaran_id,saldo_awal,status,urutan,created_at) VALUES (?,?,?,?,0,\'aktif\',?,?)');
      let urut = 1;
      BKU_UMUM.forEach((n, i) => insB.run(n, 'umum', 'U' + String(i + 1).padStart(2, '0'), taId, urut++, nowStamp()));
      BKU_KEGIATAN.forEach((n, i) => insB.run(n, 'kegiatan', 'K' + String(i + 1).padStart(2, '0'), taId, urut++, nowStamp()));
    }

    // aset
    if (!db.prepare('SELECT COUNT(*) c FROM aset').get().c) {
      const ins = db.prepare('INSERT INTO aset (nama,jenis,saldo,keterangan) VALUES (?,?,?,?)');
      ins.run('Kas Bank', 'bank', 0, 'Otomatis dari transaksi transfer');
      ins.run('Kas Tunai', 'tunai', 0, 'Otomatis dari transaksi tunai');
      ins.run('Pinjaman Kegiatan', 'pinjaman', 0, 'Dana kegiatan yang dipinjamkan');
    }

    // kolom tambahan (DB lama)
    const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!userCols.includes('foto')) db.exec('ALTER TABLE users ADD COLUMN foto TEXT');
    // login multi-tenant: username pendek selain email (opsional, email tetap bisa dipakai)
    if (!userCols.includes('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT');
    if (!userCols.includes('tenant_id')) db.exec('ALTER TABLE users ADD COLUMN tenant_id INTEGER');

    const trxCols = db.prepare('PRAGMA table_info(transaksi)').all().map(c => c.name);
    if (!trxCols.includes('is_penyesuaian')) db.exec('ALTER TABLE transaksi ADD COLUMN is_penyesuaian INTEGER NOT NULL DEFAULT 0');
    if (!trxCols.includes('periode_penyesuaian')) db.exec('ALTER TABLE transaksi ADD COLUMN periode_penyesuaian TEXT');
    if (!trxCols.includes('transfer_group')) db.exec('ALTER TABLE transaksi ADD COLUMN transfer_group TEXT');
    if (!trxCols.includes('jumlah_barang')) db.exec('ALTER TABLE transaksi ADD COLUMN jumlah_barang REAL NOT NULL DEFAULT 1');
    if (!trxCols.includes('harga_satuan')) db.exec('ALTER TABLE transaksi ADD COLUMN harga_satuan REAL NOT NULL DEFAULT 0');
    db.exec(`UPDATE transaksi SET harga_satuan=nominal
      WHERE COALESCE(harga_satuan,0)<=0 AND coa_id IN (SELECT id FROM coa WHERE kode IN ('5.2.01','5.2.02'))`);

    // buku pembantu/rekap → mode otomatis (tidak diinput manual, hanya rekapan transaksi)
    const bkuCols = db.prepare('PRAGMA table_info(bku)').all().map(c => c.name);
    if (!bkuCols.includes('pemasukan_saldo')) {
      db.exec('ALTER TABLE bku ADD COLUMN pemasukan_saldo INTEGER NOT NULL DEFAULT 0');
      db.exec("UPDATE bku SET pemasukan_saldo=1 WHERE COALESCE(jenis,'umum')<>'kegiatan'");
    }
    if (!bkuCols.includes('auto_mode')) db.exec('ALTER TABLE bku ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0');
    {
      const mark = db.prepare('UPDATE bku SET auto_mode=1 WHERE nama=?');
      for (const n of BKU_AUTO_NAMES) mark.run(n);
    }

    // SPP: kolom "diterima" manual (nilai historis) — total diterima = manual + transaksi Penerimaan SPP
    const sppCols = db.prepare('PRAGMA table_info(spp)').all().map(c => c.name);
    if (!sppCols.includes('diterima_manual')) {
      db.exec('ALTER TABLE spp ADD COLUMN diterima_manual REAL NOT NULL DEFAULT 0');
      db.exec('UPDATE spp SET diterima_manual = total_diterima');
    }

    // ledger aset (pinjaman kegiatan & akun aset lain): kolom bukti / pihak / no bukti
    const pmCols = db.prepare('PRAGMA table_info(pinjaman_mutasi)').all().map(c => c.name);
    for (const [col, ddl] of [
      ['no_bukti', 'TEXT'], ['nama_pihak', 'TEXT'], ['bukti_url', 'TEXT'], ['metode', "TEXT DEFAULT 'tunai'"]
    ]) if (!pmCols.includes(col)) db.exec(`ALTER TABLE pinjaman_mutasi ADD COLUMN ${col} ${ddl}`);

    // sesi: jumlah draf pengeluaran baru saat login (notifikasi Kepala Sekolah)
    const sesCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    if (!sesCols.includes('alert_pending')) db.exec('ALTER TABLE sessions ADD COLUMN alert_pending INTEGER NOT NULL DEFAULT 0');

    // cicilan piutang: tautan ke baris payroll (potongan kasbon) agar bisa dihitung ulang
    const pbCols = db.prepare('PRAGMA table_info(piutang_bayar)').all().map(c => c.name);
    if (!pbCols.includes('payroll_id')) db.exec('ALTER TABLE piutang_bayar ADD COLUMN payroll_id INTEGER');

    /* ---------- isolasi data per tahun ajaran ---------- */
    // sesi: tahun ajaran yang sedang dipilih pada dropdown header
    const sesCols2 = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    if (!sesCols2.includes('ta_id')) db.exec('ALTER TABLE sessions ADD COLUMN ta_id INTEGER');

    const pCols = db.prepare('PRAGMA table_info(piutang)').all().map(c => c.name);
    if (!pCols.includes('tahun_ajaran_id')) db.exec('ALTER TABLE piutang ADD COLUMN tahun_ajaran_id INTEGER');
    const plCols = db.prepare('PRAGMA table_info(piutang_lain)').all().map(c => c.name);
    if (!plCols.includes('tahun_ajaran_id')) db.exec('ALTER TABLE piutang_lain ADD COLUMN tahun_ajaran_id INTEGER');
    const asCols = db.prepare('PRAGMA table_info(aset)').all().map(c => c.name);
    if (!asCols.includes('tahun_ajaran_id')) db.exec('ALTER TABLE aset ADD COLUMN tahun_ajaran_id INTEGER');
    const pmCols2 = db.prepare('PRAGMA table_info(pinjaman_mutasi)').all().map(c => c.name);
    if (!pmCols2.includes('coa_id')) db.exec('ALTER TABLE pinjaman_mutasi ADD COLUMN coa_id INTEGER');

    // backfill tahun_ajaran_id: cocokkan rentang tanggal, fallback ke tahun ajaran aktif
    {
      const tas = db.prepare('SELECT * FROM tahun_ajaran ORDER BY id').all();
      if (tas.length) {
        const def = (tas.find(t => t.aktif) || tas[tas.length - 1]).id;
        const pick = tgl => {
          const d = String(tgl || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return def;
          const hit = tas.find(t => t.tanggal_mulai && t.tanggal_selesai && d >= String(t.tanggal_mulai).slice(0, 10) && d <= String(t.tanggal_selesai).slice(0, 10));
          if (hit) return hit.id;
          // di luar rentang: pilih tahun ajaran terdekat
          let best = def, dist = Infinity;
          for (const t of tas) {
            const anchor = String(t.tanggal_mulai || t.tanggal_selesai || '').slice(0, 10);
            if (!anchor) continue;
            const dd = Math.abs(new Date(anchor).getTime() - new Date(d).getTime());
            if (dd < dist) { dist = dd; best = t.id; }
          }
          return best;
        };
        const fix = (tbl, col) => {
          const rows = db.prepare(`SELECT id, ${col} tgl FROM ${tbl} WHERE tahun_ajaran_id IS NULL`).all();
          const upd = db.prepare(`UPDATE ${tbl} SET tahun_ajaran_id=? WHERE id=?`);
          for (const r of rows) upd.run(pick(r.tgl), r.id);
        };
        fix('piutang', 'tanggal_utang');
        fix('piutang_lain', 'tanggal');
        // aset: akun milik tahun ajaran default (dibuat sebelum fitur ini ada)
        db.prepare('UPDATE aset SET tahun_ajaran_id=? WHERE tahun_ajaran_id IS NULL').run(def);
      }
    }

    // pegawai: kolom tipe (guru / tu) untuk rekap honor
    const pgCols = db.prepare('PRAGMA table_info(pegawai)').all().map(c => c.name);
    if (!pgCols.includes('tipe')) db.exec("ALTER TABLE pegawai ADD COLUMN tipe TEXT NOT NULL DEFAULT 'guru'");
    if (!pgCols.includes('nip')) db.exec('ALTER TABLE pegawai ADD COLUMN nip TEXT');

    // kelas.nama_kelas (nama tampilan kelas) — disinkronkan dengan kolom lama `nama`
    const klsCols = db.prepare('PRAGMA table_info(kelas)').all().map(c => c.name);
    if (!klsCols.includes('nama_kelas')) {
      db.exec('ALTER TABLE kelas ADD COLUMN nama_kelas TEXT');
      db.exec('UPDATE kelas SET nama_kelas=nama WHERE nama_kelas IS NULL');
    }
    // iuran_nominal.tingkat: nominal berbeda per tingkat kelas ('' = default semua tingkat)
    const iunCols = db.prepare('PRAGMA table_info(iuran_nominal)').all().map(c => c.name);
    if (!iunCols.includes('tingkat')) {
      db.exec("ALTER TABLE iuran_nominal ADD COLUMN tingkat TEXT NOT NULL DEFAULT ''");
    }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_iuran_nominal_grup ON iuran_nominal(grup_id, tingkat)'); } catch (e) { }

    // payroll: tugas tambahan dipecah menjadi 2 komponen berbasis jam (Pembantu Kepsek & Wali Kelas)
    const payCols = db.prepare('PRAGMA table_info(payroll)').all().map(c => c.name);
    if (!payCols.includes('jam_pembantu_kepsek')) db.exec('ALTER TABLE payroll ADD COLUMN jam_pembantu_kepsek REAL NOT NULL DEFAULT 0');
    if (!payCols.includes('jam_wali_kelas')) db.exec('ALTER TABLE payroll ADD COLUMN jam_wali_kelas REAL NOT NULL DEFAULT 0');
    // urutan custom leger honor (drag & drop / geser naik-turun)
    if (!payCols.includes('urutan')) db.exec('ALTER TABLE payroll ADD COLUMN urutan INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE payroll SET urutan=id WHERE COALESCE(urutan,0)=0');
    // sertifikasi kini berbasis JAM (nominal = jam × tarif setting). Data lama (nominal Rp) dikonversi sekali.
    if (!payCols.includes('jam_sertifikasi')) {
      db.exec('ALTER TABLE payroll ADD COLUMN jam_sertifikasi REAL NOT NULL DEFAULT 0');
      const rate = Math.max(1, Number(getSetting('sertifikasi_per_jam', '12500')) || 12500);
      db.prepare(`UPDATE payroll SET jam_sertifikasi = ROUND(COALESCE(pot_sertifikasi,0) / ?, 2)
        WHERE COALESCE(pot_sertifikasi,0) > 0`).run(rate);
    }

    /* ---------- void transaksi (jurnal pembalik) ---------- */
    const trxCols2 = db.prepare('PRAGMA table_info(transaksi)').all().map(c => c.name);
    for (const [col, ddl] of [
      ['void_at', 'TEXT'], ['void_by', 'TEXT'], ['void_alasan', 'TEXT'],
      ['void_reversal_id', 'INTEGER'], ['void_of', 'INTEGER']
    ]) if (!trxCols2.includes(col)) db.exec(`ALTER TABLE transaksi ADD COLUMN ${col} ${ddl}`);

    /* ---------- aset: sakelar tampil di aset riil ---------- */
    const asCols2 = db.prepare('PRAGMA table_info(aset)').all().map(c => c.name);
    if (!asCols2.includes('tampil')) db.exec('ALTER TABLE aset ADD COLUMN tampil INTEGER NOT NULL DEFAULT 1');

    /* ---------- siswa: kolom tambahan ---------- */
    const sisCols = db.prepare('PRAGMA table_info(siswa)').all().map(c => c.name);
    for (const [col, ddl] of [
      ['tanggal_lahir', 'TEXT'], ['keterangan', 'TEXT'], ['updated_at', 'TEXT'],
      // nomor HP/WhatsApp orang tua (dipakai pengingat tagihan) — disimpan ternormalisasi 62…
      ['parent_phone', 'TEXT']
    ]) if (!sisCols.includes(col)) db.exec(`ALTER TABLE siswa ADD COLUMN ${col} ${ddl}`);

    /* ---------- penempatan kelas per tahun pelajaran (riwayat akademik) ----------
       Idempoten (UNIQUE siswa_id + tahun_ajaran_id):
       1) penempatan saat ini diambil dari kolom siswa,
       2) riwayat dari tabel siswa_mutasi (tahun asal & tujuan) — memulihkan siswa yang
          dulu "terpindah" lintas tahun pelajaran sehingga tetap muncul di rekap TA asal. */
    if (db.prepare('PRAGMA table_info(siswa_penempatan)').all().length) {
      db.prepare(`INSERT OR IGNORE INTO siswa_penempatan (siswa_id,kelas_id,tahun_ajaran_id,sumber,created_at,updated_at)
        SELECT s.id, s.kelas_id, s.tahun_ajaran_id, 'awal', ?, ? FROM siswa s
        WHERE s.tahun_ajaran_id IS NOT NULL`).run(nowStamp(), nowStamp());
      db.prepare(`INSERT OR IGNORE INTO siswa_penempatan (siswa_id,kelas_id,tahun_ajaran_id,sumber,mutasi_id,created_at,updated_at)
        SELECT m.siswa_id, m.kelas_asal_id, m.ta_asal_id, 'mutasi-historis', m.id, ?, ? FROM siswa_mutasi m
        WHERE m.status='ditetapkan' AND m.ta_asal_id IS NOT NULL`).run(nowStamp(), nowStamp());
      db.prepare(`INSERT OR IGNORE INTO siswa_penempatan (siswa_id,kelas_id,tahun_ajaran_id,sumber,mutasi_id,created_at,updated_at)
        SELECT m.siswa_id, m.kelas_tujuan_id, m.ta_tujuan_id, 'mutasi-historis', m.id, ?, ? FROM siswa_mutasi m
        WHERE m.status='ditetapkan' AND m.ta_tujuan_id IS NOT NULL`).run(nowStamp(), nowStamp());
    }

    /* ---------- kategori piutang lainnya (modul baru) ---------- */
    if (!db.prepare('SELECT COUNT(*) c FROM piutang_kategori').get().c) {
      db.prepare('INSERT INTO piutang_kategori (nama,keterangan,tampil_aset,aktif,urutan,created_at) VALUES (?,?,1,1,1,?)')
        .run('Piutang Lainnya', 'Kategori umum piutang lainnya', nowStamp());
    }

    /* ---------- iuran bayar: kolom kwitansi / posting ---------- */
    const ibCols = db.prepare('PRAGMA table_info(iuran_bayar)').all().map(c => c.name);
    for (const [col, ddl] of [
      ['kwitansi_no', 'TEXT'], ['print_count', 'INTEGER NOT NULL DEFAULT 0'], ['posted_at', 'TEXT']
    ]) if (!ibCols.includes(col)) db.exec(`ALTER TABLE iuran_bayar ADD COLUMN ${col} ${ddl}`);

    /* ---------- iuran tagihan: pemutihan / piutang tak tertagih ---------- */
    const itCols = db.prepare('PRAGMA table_info(iuran_tagihan)').all().map(c => c.name);
    for (const [col, ddl] of [['writeoff', 'TEXT'], ['writeoff_at', 'TEXT'], ['writeoff_by', 'TEXT']])
      if (!itCols.includes(col)) db.exec(`ALTER TABLE iuran_tagihan ADD COLUMN ${col} ${ddl}`);

    /* ---------- iuran: rincian pembayaran per bulan + CoA default grup ---------- */
    const ibCols3 = db.prepare('PRAGMA table_info(iuran_bayar)').all().map(c => c.name);
    if (!ibCols3.includes('bulan')) db.exec('ALTER TABLE iuran_bayar ADD COLUMN bulan INTEGER');
    const igCols = db.prepare('PRAGMA table_info(iuran_grup)').all().map(c => c.name);
    if (!igCols.includes('coa_id')) db.exec('ALTER TABLE iuran_grup ADD COLUMN coa_id INTEGER');
    // tanggal jatuh tempo (hari ke-1..28) per grup — dipakai mode pengingat "H-X sebelum jatuh tempo"
    if (!igCols.includes('jatuh_tempo')) db.exec('ALTER TABLE iuran_grup ADD COLUMN jatuh_tempo INTEGER');

    /* ---------- pengingat tagihan: template bawaan + setting ---------- */
    if (!db.prepare('SELECT COUNT(*) c FROM wa_template').get().c) {
      const insT = db.prepare('INSERT INTO wa_template (nama,isi,urutan,aktif,created_at) VALUES (?,?,?,1,?)');
      insT.run('Template SPP Bulanan',
        'Yth. Orang Tua dari {nama_siswa} ({kelas}),\n\nKami menginformasikan bahwa total tunggakan iuran sekolah sebesar {nominal_tunggakan}.\n\nRincian tagihan:\n{rincian_tagihan}\n\nRincian tagihan dan pembayaran dapat diakses melalui tautan berikut:\n{link_portal}\n\nTerima kasih.\n{nama_sekolah}', 1, nowStamp());
      insT.run('Template Uang Kegiatan',
        'Yth. Orang Tua/Wali dari {nama_siswa} ({kelas}),\n\nBersama pesan ini kami sampaikan tagihan kegiatan sekolah yang belum diselesaikan dengan total {nominal_tunggakan}.\n\nRincian:\n{rincian_tagihan}\n\nInformasi lengkap & pembayaran: {link_portal}\n\nTerima kasih atas perhatian Bapak/Ibu.\n{nama_sekolah}', 2, nowStamp());
      insT.run('Template Penagihan Ujian',
        'Yth. Orang Tua/Wali dari {nama_siswa} ({kelas}),\n\nMenjelang pelaksanaan ujian, kami mengingatkan tunggakan administrasi sebesar {nominal_tunggakan}:\n\n{rincian_tagihan}\n\nMohon melakukan penyelesaian melalui tautan {link_portal} agar siswa dapat mengikuti seluruh kegiatan ujian.\n\nTerima kasih.\n{nama_sekolah}', 3, nowStamp());
    }

    /* ---------- beasiswa enforcement: pembayaran otomatis + status terkunci ----------
       'sumber' menandai pembayaran iuran yang dibuat otomatis oleh modul Beasiswa
       (tidak masuk antrean BKU, tidak bisa dihapus/diubah dari halaman iuran). */
    const ibCols4 = db.prepare('PRAGMA table_info(iuran_bayar)').all().map(c => c.name);
    if (!ibCols4.includes('sumber')) db.exec("ALTER TABLE iuran_bayar ADD COLUMN sumber TEXT DEFAULT 'manual'");
    if (!ibCols4.includes('beasiswa_id')) db.exec('ALTER TABLE iuran_bayar ADD COLUMN beasiswa_id INTEGER');
    const itCols2 = db.prepare('PRAGMA table_info(iuran_tagihan)').all().map(c => c.name);
    if (!itCols2.includes('beasiswa_locked')) db.exec('ALTER TABLE iuran_tagihan ADD COLUMN beasiswa_locked INTEGER NOT NULL DEFAULT 0');
    if (!itCols2.includes('beasiswa_id')) db.exec('ALTER TABLE iuran_tagihan ADD COLUMN beasiswa_id INTEGER');

    /* ---------- honor ekskul: jenis ekstrakurikuler & bulan posting BKU ---------- */
    const ekCols = db.prepare('PRAGMA table_info(ekskul_honor)').all().map(c => c.name);
    if (!ekCols.includes('jenis')) db.exec("ALTER TABLE ekskul_honor ADD COLUMN jenis TEXT DEFAULT ''");
    /* periode KINERJA/HONOR (kolom periode) dipisahkan dari BULAN POSTING ke BKU
       — mis. honor Oktober dibukukan pada BKU November karena BKU Oktober ditutup. */
    if (!ekCols.includes('posting_periode')) db.exec('ALTER TABLE ekskul_honor ADD COLUMN posting_periode TEXT');

    /* ---------- portal publik: sumber catatan (siswa / piutang pegawai / slip) ---------- */
    const ppCols = db.prepare('PRAGMA table_info(portal_pesan)').all().map(c => c.name);
    if (!ppCols.includes('sumber')) db.exec("ALTER TABLE portal_pesan ADD COLUMN sumber TEXT DEFAULT 'siswa'");
    if (!ppCols.includes('ref')) db.exec('ALTER TABLE portal_pesan ADD COLUMN ref TEXT');
    /* balasan pihak sekolah atas catatan orang tua (modul Rekap Catatan Orang Tua) */
    for (const [col, ddl] of [['balasan', 'TEXT'], ['balas_oleh', 'TEXT'], ['balas_at', 'TEXT']])
      if (!ppCols.includes(col)) db.exec(`ALTER TABLE portal_pesan ADD COLUMN ${col} ${ddl}`);

    /* ---------- domain publik: tautan acak BKU & Grup Iuran (tanpa login) ---------- */
    {
      const bc = db.prepare('PRAGMA table_info(bku)').all().map(c => c.name);
      if (!bc.includes('rab')) db.exec('ALTER TABLE bku ADD COLUMN rab REAL NOT NULL DEFAULT 0');
      if (!bc.includes('public_token')) db.exec('ALTER TABLE bku ADD COLUMN public_token TEXT');
      if (!bc.includes('is_public')) db.exec('ALTER TABLE bku ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
      const gc = db.prepare('PRAGMA table_info(iuran_grup)').all().map(c => c.name);
      if (!gc.includes('public_token')) db.exec('ALTER TABLE iuran_grup ADD COLUMN public_token TEXT');
      if (!gc.includes('is_public')) db.exec('ALTER TABLE iuran_grup ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
      const kc = db.prepare('PRAGMA table_info(kelas)').all().map(c => c.name);
      if (!kc.includes('public_token')) db.exec('ALTER TABLE kelas ADD COLUMN public_token TEXT');
      if (!kc.includes('is_public')) db.exec('ALTER TABLE kelas ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_bku_public_token ON bku(public_token) WHERE public_token IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_iuran_grup_public_token ON iuran_grup(public_token) WHERE public_token IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_kelas_public_token ON kelas(public_token) WHERE public_token IS NOT NULL');
      db.exec(`CREATE TABLE IF NOT EXISTS bku_iuran_grup (
        bku_id INTEGER NOT NULL, grup_id INTEGER NOT NULL, tenant_id INTEGER,
        PRIMARY KEY (bku_id, grup_id), UNIQUE (grup_id)
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS bku_rab (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, coa_id INTEGER NOT NULL,
        pagu REAL NOT NULL DEFAULT 0, keterangan TEXT, created_at TEXT, updated_at TEXT, tenant_id INTEGER,
        UNIQUE (bku_id, coa_id)
      )`);
    }

    // default ukuran kertas & kop (DB lama yang belum punya)
    {
      const setif2 = db.prepare('INSERT OR IGNORE INTO settings (k,v) VALUES (?,?)');
      setif2.run('sertifikasi_per_jam', '12500');
      setif2.run('kwitansi_w_mm', '210');
      setif2.run('kwitansi_h_mm', '99');
      setif2.run('kwitansi_margin_mm', '6');
      setif2.run('portal_aktif', '1');
      setif2.run('portal_pegawai_aktif', '1');
      setif2.run('portal_slip_aktif', '1');
      setif2.run('portal_page_title', '');
      setif2.run('portal_subtitle', '');
      setif2.run('portal_token_title', '');
      // alamat (slug) portal publik — dapat diubah di menu Identitas Sekolah
      setif2.run('portal_slug', 'portal');
      setif2.run('portal_pegawai_slug', 'portal-pegawai');
      setif2.run('portal_slip_slug', 'portal-slip');
      setif2.run('kop_font', '10');
      setif2.run('kop_font_besar', '15');
      // tempat cetak pada baris "Cikoneng, 2 November 2026" (dapat diubah di Desain Templat Cetak)
      setif2.run('print_tempat', 'Cikoneng');
      if (!db.prepare("SELECT 1 FROM settings WHERE k='kop_baris'").get()) {
        setif2.run('kop_baris', 'PERWAKILAN YAYASAN PEMBINA LEMBAGA PENDIDIKAN\nPERSATUAN GURU REPUBLIK INDONESIA\n(YPLP-PGRI) KABUPATEN CIAMIS\nSEKOLAH MENENGAH KEJURUAN PGRI CIKONENG\nAKREDITASI : A - NPSN : 20211525\nJalan Raya No.144 Telp./Fax.:(0265)773258 e-mail:smkpgrickn@yahoo.co.id Cikoneng- Ciamis');
      }
    }

    // sembunyikan duplikasi akun pinjaman/aset lain (nominal sama & tanpa transaksi) agar tidak tampil ganda
    try { dedupeAset(null, { sameNameOnly: true }); } catch (e) { }

    // riwayat cicilan piutang: lengkapi data lama yang sudah lunas
    db.exec(`INSERT INTO piutang_bayar (piutang_id,tanggal,nominal,metode,bku_id,transaksi_id,keterangan,created_at)
      SELECT p.id, COALESCE(p.tanggal_bayar,p.tanggal_utang), p.nominal, 'tunai', p.bku_id, p.transaksi_id,
             'Pelunasan (data lama)', p.created_at
      FROM piutang p
      WHERE p.status='lunas' AND NOT EXISTS (SELECT 1 FROM piutang_bayar b WHERE b.piutang_id=p.id)`);

    /* ---------- pegawai: tanggal lahir & nomor WhatsApp (portal publik) ---------- */
    {
      const pgc = db.prepare('PRAGMA table_info(pegawai)').all().map(c => c.name);
      if (!pgc.includes('tanggal_lahir')) db.exec('ALTER TABLE pegawai ADD COLUMN tanggal_lahir TEXT');
      if (!pgc.includes('whatsapp')) db.exec("ALTER TABLE pegawai ADD COLUMN whatsapp TEXT DEFAULT ''");
    }
    /* ---------- beasiswa: grup iuran, bulan, persentase, deskripsi ---------- */
    {
      const bc = db.prepare('PRAGMA table_info(beasiswa)').all().map(c => c.name);
      if (!bc.includes('deskripsi')) db.exec("ALTER TABLE beasiswa ADD COLUMN deskripsi TEXT DEFAULT ''");
      if (!bc.includes('grup_id')) db.exec('ALTER TABLE beasiswa ADD COLUMN grup_id INTEGER');
      if (!bc.includes('bulan_mask')) db.exec("ALTER TABLE beasiswa ADD COLUMN bulan_mask TEXT DEFAULT ''");
      if (!bc.includes('persen')) db.exec('ALTER TABLE beasiswa ADD COLUMN persen REAL DEFAULT 0');
    }
    /* ---------- alamat portal publik: bentuk lengkap /<nama-sekolah>/<sub-slug> ----------
       Sebelumnya slug tagihan siswa bawaan "portal" (alamat /portal). Sekarang alamat
       selalu menyertakan nama sekolah + sub-slug "portal-tagihan". Nilai yang sudah
       diubah pemilik (slug kustom) TIDAK disentuh. */
    if (getSetting('portal_fullpath_v1', '') !== '1') {
      const cur = String(getSetting('portal_slug', '') || '').trim().toLowerCase();
      if (!cur || cur === 'portal') setSetting('portal_slug', 'portal-tagihan');
      setSetting('portal_fullpath_v1', '1');
    }

    /* ---------- default pengaturan baru (DB lama) ---------- */
    {
      const setif3 = db.prepare('INSERT OR IGNORE INTO settings (k,v) VALUES (?,?)');
      [['portal_pegawai_aktif', '1'], ['portal_slip_aktif', '1'], ['wa_api_url', ''], ['wa_api_token', ''],
      ['wa_api_payload', 'form'], ['wa_demo_tampil', '1'],
      ['kw_trx_w_mm', '210'], ['kw_trx_h_mm', '99'], ['kw_trx_mt_mm', '6'], ['kw_trx_mb_mm', '6'],
      ['kw_trx_ml_mm', '8'], ['kw_trx_mr_mm', '8']].forEach(([k, v]) => setif3.run(k, v));
    }

    // pastikan baris aset dasar tersedia
    {
      const countJenis = j => db.prepare('SELECT COUNT(*) c FROM aset WHERE jenis=?').get(j).c;
      if (!countJenis('bank')) db.prepare("INSERT INTO aset (nama,jenis,saldo,keterangan) VALUES ('Kas Bank','bank',0,'Penyesuaian manual kas bank')").run();
      if (!countJenis('tunai')) db.prepare("INSERT INTO aset (nama,jenis,saldo,keterangan) VALUES ('Kas Tunai','tunai',0,'Penyesuaian manual kas tunai')").run();
      if (!countJenis('pinjaman')) db.prepare("INSERT INTO aset (nama,jenis,saldo,keterangan) VALUES ('Pinjaman Kegiatan','pinjaman',0,'Dana kegiatan yang dipinjamkan')").run();
    }

    /* ---------- notifikasi kelulusan otomatis sudah dihapus dari dashboard ---------- */
    db.exec("DELETE FROM settings WHERE k='graduate_notice'");

    /* ---------- bersihkan salinan piutang yatim (sisa rollover TA yang sudah dihapus) ---------- */
    if (getSetting('cleanup_piutang_yatim_v1', '') !== '1') {
      try {
        const hasil = cleanupOrphanPiutang(null);
        setSetting('cleanup_piutang_yatim_v1', '1');
        if (hasil.deleted) console.log(`[migrasi] piutang yatim dibersihkan: ${hasil.deleted} baris dihapus, ${hasil.moved} cicilan dipindahkan`);
      } catch (e) { console.error('[migrasi] gagal bersihkan piutang yatim:', e.message); }
    }

    /* ---------- kwitansi transaksi: kertas ringkas 210 × 99 mm (1/3 F4 landscape) ---------- */
    if (getSetting('kw_trx_compact_v1', '') !== '1') {
      setSetting('kw_trx_w_mm', 210); setSetting('kw_trx_h_mm', 99);
      setSetting('kw_trx_mt_mm', 4); setSetting('kw_trx_mb_mm', 4);
      setSetting('kw_trx_ml_mm', 6); setSetting('kw_trx_mr_mm', 6);
      setSetting('kw_trx_compact_v1', '1');
    }

    /* ---------- fitur "perlakuan sisa tagihan lulus/DO" dihapus ----------
       Semua tagihan yang dulu dikunci (pemutihan / tak tertagih) dibuka kembali supaya
       pembayaran & koreksi bisa dilakukan di tahun pelajaran mana pun. */
    if (getSetting('buka_kunci_writeoff_v1', '') !== '1') {
      try {
        const info = db.prepare("UPDATE iuran_tagihan SET writeoff=NULL, writeoff_at=NULL, writeoff_by=NULL WHERE COALESCE(writeoff,'')<>''").run();
        setSetting('buka_kunci_writeoff_v1', '1');
        if (info.changes) console.log(`[migrasi] kuncian tagihan tertutup dibuka: ${info.changes} tagihan`);
      } catch (e) { console.error('[migrasi] gagal buka kuncian tagihan:', e.message); }
    }

    /* ---------- sapu bersih data hantu (orphan / phantom) ---------- */
    try {
      const sisa = purgeGhostData(null);
      if (sisa.deleted || sisa.reset) console.log(`[bersih] ${sisa.deleted} baris data hantu dihapus, ${sisa.reset} pembayaran iuran dikembalikan ke antrean`);
    } catch (e) { console.error('[bersih] gagal membersihkan data hantu:', e.message); }

    // admin
    if (!db.prepare('SELECT COUNT(*) c FROM users').get().c) {
      db.prepare('INSERT INTO users (nama,email,password,role,aktif,jabatan,created_at) VALUES (?,?,?,?,1,?,?)')
        .run('Bendahara Utama', 'admin@sekolah.sch.id', hashPassword('admin123'), 'super_admin', 'Bendahara Utama / Super Admin', nowStamp());
    }
    seedPayrollColumns();
  })();
}

/* -------- helpers -------- */
function getSetting(k, d = '') {
  const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
  return r ? r.v : d;
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v ?? ''));
  resetPortalSlugCache();   // alamat portal publik bisa berubah → segarkan cache
}
function settingsAll() {
  const out = {};
  for (const r of db.prepare('SELECT k,v FROM settings').all()) out[r.k] = r.v;
  return out;
}

/* ==================================================================
   TAMPILAN: WARNA TEMA, BRANDING & PENATAAN MENU
   ================================================================== */
const TEMA_DEFAULT = '#F97316';
/** setting tema disimpan sebagai hex; nilai rusak dikembalikan ke bawaan */
function temaWarna() {
  const v = String(getSetting('tema_warna', TEMA_DEFAULT) || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : TEMA_DEFAULT;
}
function appNama() { return String(getSetting('app_nama', 'SIMKEU Sekolah') || 'SIMKEU Sekolah').trim() || 'SIMKEU Sekolah'; }
/**
 * Sub-judul di bawah nama aplikasi pada bilah samping ("Sistem Keuangan").
 * Kosong = ikuti branding sistem dari Super Admin (lihat server.page()).
 */
const APP_SUB_DEFAULT = 'Sistem Keuangan';
function appSub() { return String(getSetting('app_sub', '') || '').trim().slice(0, 60); }
function appLogo() { return String(getSetting('app_logo', '') || '').trim(); }

/** struktur penataan menu: { groups:{gid:urutan}, order:{href:urutan}, labels:{href:teks}, icons:{href:url} } */
function navUi() {
  let raw = {};
  try { raw = JSON.parse(getSetting('nav_ui', '{}') || '{}') || {}; } catch (e) { raw = {}; }
  const out = { groups: {}, order: {}, labels: {}, icons: {} };
  for (const key of ['groups', 'order', 'labels', 'icons']) {
    const src = raw[key];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (key === 'labels' || key === 'icons') {
        const s = String(v == null ? '' : v).trim();
        if (s) out[key][k] = s.slice(0, key === 'icons' ? 500 : 80);
      } else {
        const n = Number(v);
        if (Number.isFinite(n)) out[key][k] = n;
      }
    }
  }
  return out;
}
function setNavUi(obj) { setSetting('nav_ui', JSON.stringify(obj || {})); }

/* ---------- setting GLOBAL (selalu database utama, termasuk saat sesi demo) ---------- */
function mainSetting(k, d = '') {
  const r = mainDb.prepare('SELECT v FROM settings WHERE k=?').get(k);
  return r ? r.v : d;
}
function temaWarnaGlobal() {
  const v = String(mainSetting('tema_warna', TEMA_DEFAULT) || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : TEMA_DEFAULT;
}
function appNamaGlobal() {
  const v = String(mainSetting('app_nama', 'SIMKEU Sekolah') || '').trim();
  return v || 'SIMKEU Sekolah';
}
/** sub-judul aplikasi versi GLOBAL (dipakai bila sekolah belum mengisinya sendiri) */
function appSubGlobal() {
  return String(mainSetting('app_sub', '') || '').trim().slice(0, 60);
}
function appLogoGlobal() { return String(mainSetting('app_logo', '') || '').trim(); }
/** tulis setting GLOBAL (selalu database utama) — dipakai pengaturan tampilan menu */
function setMainSetting(k, v) {
  mainDb.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(String(k), String(v ?? ''));
  portalSlugCacheSet(null);
}
function setNavUiGlobal(obj) { setMainSetting('nav_ui', JSON.stringify(obj || {})); }
function navUiGlobal() {
  let raw = {};
  try { raw = JSON.parse(mainSetting('nav_ui', '{}') || '{}') || {}; } catch (e) { raw = {}; }
  const out = { groups: {}, order: {}, labels: {}, icons: {} };
  for (const key of ['groups', 'order', 'labels', 'icons']) {
    const src = raw[key];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (key === 'labels' || key === 'icons') {
        const s = String(v == null ? '' : v).trim();
        if (s) out[key][k] = s.slice(0, key === 'icons' ? 500 : 80);
      } else {
        const n = Number(v);
        if (Number.isFinite(n)) out[key][k] = n;
      }
    }
  }
  return out;
}

/* ---------- Petunjuk Pengguna ---------- */
function panduanList(opts = {}) {
  let sql = 'SELECT * FROM panduan';
  const args = [];
  if (opts.aktifOnly) sql += ' WHERE aktif=1';
  sql += ' ORDER BY urutan, id';
  const rows = db.prepare(sql).all(...args);
  return opts.kategori ? rows.filter(r => String(r.kategori || '') === String(opts.kategori)) : rows;
}
function panduanById(id) { return id ? db.prepare('SELECT * FROM panduan WHERE id=?').get(Number(id)) : null; }
function panduanSave(data) {
  const id = Number(data.id || 0);
  const f = {
    judul: String(data.judul || '').trim().slice(0, 160),
    kategori: String(data.kategori || '').trim().slice(0, 60),
    ringkas: String(data.ringkas || '').trim().slice(0, 600),
    thumbnail: String(data.thumbnail || '').trim().slice(0, 500),
    video_url: String(data.video_url || '').trim().slice(0, 500),
    pdf_url: String(data.pdf_url || '').trim().slice(0, 500),
    urutan: Number(data.urutan || 0) || 0,
    aktif: data.aktif ? 1 : 0
  };
  if (!f.judul) return null;
  if (id) {
    db.prepare(`UPDATE panduan SET judul=?,kategori=?,ringkas=?,thumbnail=?,video_url=?,pdf_url=?,urutan=?,aktif=?,updated_at=? WHERE id=?`)
      .run(f.judul, f.kategori, f.ringkas, f.thumbnail, f.video_url, f.pdf_url, f.urutan, f.aktif, nowStamp(), id);
    return panduanById(id);
  }
  const info = db.prepare(`INSERT INTO panduan (judul,kategori,ringkas,thumbnail,video_url,pdf_url,urutan,aktif,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.judul, f.kategori, f.ringkas, f.thumbnail, f.video_url, f.pdf_url, f.urutan, f.aktif,
      String(data.oleh || ''), nowStamp(), nowStamp());
  return panduanById(Number(info.lastInsertRowid));
}
function panduanDelete(id) {
  const row = panduanById(id);
  if (row) db.prepare('DELETE FROM panduan WHERE id=?').run(row.id);
  return row;
}
function panduanUrutkan(ids) {
  const upd = db.prepare('UPDATE panduan SET urutan=? WHERE id=?');
  (ids || []).map(Number).filter(Boolean).forEach((id, i) => upd.run(i + 1, id));
}

/* ==================================================================
   ALAMAT (SLUG) PORTAL PUBLIK — dapat diubah dari menu Identitas Sekolah
   ------------------------------------------------------------------
   Tiga portal publik punya ujung alamat yang bisa diatur sendiri:
     portal_slug          → default 'portal'          (tagihan iuran siswa)
     portal_pegawai_slug  → default 'portal-pegawai'  (tagihan piutang pegawai)
     portal_slip_slug     → default 'portal-slip'     (slip gaji / honor)
   ================================================================== */
const PORTAL_SLUG_KEYS = { siswa: 'portal_slug', pegawai: 'portal_pegawai_slug', slip: 'portal_slip_slug' };
const PORTAL_SLUG_DEFAULT = { siswa: 'portal-tagihan', pegawai: 'portal-pegawai', slip: 'portal-slip' };
/* Alamat publik SELALU berbentuk /<nama-sekolah>/<sub-slug>. Bagian nama sekolah
   disimpan pada setting `portal_base_slug` (disinkronkan dari slug kanonik tenant). */
const PORTAL_LEGACY_SEGS = new Set(['portal', 'portal-tagihan', 'portal-pegawai', 'portal-slip']);
/** path aplikasi yang tidak boleh dipakai sebagai slug portal */
const RESERVED_SLUGS = new Set(['login', 'logout', 'assets', 'favicon.ico', 'favicon.svg', 'favicon.png',
  'transaksi', 'laporan', 'backup', 'pengguna', 'sekolah', 'siswa', 'iuran', 'payroll', 'pegawai', 'aset',
  'coa', 'bku', 'import', 'audit', 'trash', 'approval', 'rekon', 'piutang', 'piutang-lain', 'piutang-lainnya',
  'beasiswa', 'ekskul', 'tahun-ajaran', 'anggaran', 'saldo-awal', 'mutasi-kas', 'mutasi-kelas', 'kelas',
  'program-keahlian', 'tutup-bulanan', 'desain-cetak', 'reset-tahun', 'audit-orphan', 'tampilan-menu',
  'tarif-honor', 'catatan-pegawai', 'pesan-orangtua', 'catatan-orangtua', 'siswa-nonaktif', 'portal-pegawai', 'portal-slip',
  'pengaturan-backup', 'tema', 'spp', 'petunjuk',
  // halaman publik bertoken (BKU & Grup Iuran) tidak boleh dipakai sebagai slug portal sekolah
  'publik',
  // multi-tenant: halaman layanan & portal SaaS tidak boleh dipakai sebagai slug portal sekolah
  'super-admin', 'info-layanan', 'perpanjang', 'register', 'daftar', 'akun']);
function normalizePortalSlug(raw, fallback) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (s.length < 3 || s.length > 40) return fallback;
  return s;
}
/* Cache slug per KONEKSI (per sekolah). Dulu satu variabel global sehingga sekolah
   yang berbeda saling menimpa alamat portal saat proses berjalan multi-tenant. */
const portalSlugCacheByConn = new WeakMap();
let portalSlugCacheFallback = null;
function portalCacheSlot() {
  const conn = (typeof dbStore !== 'undefined' && dbStore.getStore()) || null;
  return conn || 'fallback';
}
function portalSlugCacheGet() {
  const slot = portalCacheSlot();
  return slot === 'fallback' ? portalSlugCacheFallback : (portalSlugCacheByConn.get(slot) || null);
}
function portalSlugCacheSet(v) {
  const slot = portalCacheSlot();
  if (slot === 'fallback') portalSlugCacheFallback = v;
  else portalSlugCacheByConn.set(slot, v);
}
/** slugkan teks bebas menjadi satu segmen URL (huruf kecil, tanda hubung) */
function slugifySeg(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
/** bagian nama sekolah pada alamat portal: /<base>/<sub> */
function portalBaseSlug() {
  const v = normalizePortalSlug(getSetting('portal_base_slug', ''), '');
  return v || slugifySeg(getSetting('sekolah_nama', 'sekolah')) || 'sekolah';
}
function setPortalBaseSlug(v) {
  setSetting('portal_base_slug', slugifySeg(v));
  resetPortalSlugCache();
}
/**
 * Alamat publik ketiga portal (RELATIF, sudah lengkap `nama-sekolah/sub-slug`):
 *   { base, siswaSeg, pegawaiSeg, slipSeg, siswa, pegawai, slip }
 * `siswa`, `pegawai`, `slip` = path siap pakai, mis. "smk-pgri-cikoneng/portal-tagihan".
 */
function portalSlugs() {
  const cached = portalSlugCacheGet();
  if (cached) return cached;
  const raw = {};
  for (const [k, key] of Object.entries(PORTAL_SLUG_KEYS)) {
    const v = String(getSetting(key, '') || '').trim();
    raw[k] = v ? normalizePortalSlug(v, PORTAL_SLUG_DEFAULT[k]) : PORTAL_SLUG_DEFAULT[k];
  }
  // pastikan unik antar portal & tidak menabrak path aplikasi
  const used = new Set();
  const seg = {};
  for (const k of ['siswa', 'pegawai', 'slip']) {
    let s = raw[k];
    if (RESERVED_SLUGS.has(s) && s !== PORTAL_SLUG_DEFAULT[k]) s = PORTAL_SLUG_DEFAULT[k];
    let n = 2;
    const base = s;
    while (used.has(s)) s = `${base}-${n++}`;
    used.add(s);
    seg[k] = s;
  }
  const base = portalBaseSlug();
  const out = {
    base,
    siswaSeg: seg.siswa, pegawaiSeg: seg.pegawai, slipSeg: seg.slip,
    siswa: base + '/' + seg.siswa,
    pegawai: base + '/' + seg.pegawai,
    slip: base + '/' + seg.slip
  };
  portalSlugCacheSet(out);
  return out;
}
/** alamat publik satu portal (mis. 'siswa') → 'nama-sekolah/portal-tagihan' */
function portalPath(key) { return portalSlugs()[key] || portalSlugs().siswa; }
/** kosongkan cache slug (dipakai saat slug diubah dari panel Super Admin) */
function resetPortalSlugCache() { portalSlugCacheSet(null); }
/** true bila slug berbeda dari default (dipakai UI) */
function portalSlugIsCustom(key) { return portalSlugs()[key + 'Seg'] !== PORTAL_SLUG_DEFAULT[key]; }
/**
 * Apakah alamat bawaan "/portal" (path kanonik portal tagihan siswa) masih dilayani?
 * Setting `portal_default_alias`:
 *   'auto' (default) → hanya selama slug portal masih "portal" (belum diganti sekolah)
 *   'on'             → selalu dilayani (kompatibilitas tautan lama)
 *   'off'            → tidak pernah dilayani (hanya alamat kustom)
 * Dipakai server.js untuk "menghapus" URL ganda /portal setelah sekolah memilih slug kustom.
 */
function portalDefaultAlias() {
  const mode = String(getSetting('portal_default_alias', 'auto') || 'auto').trim().toLowerCase();
  const custom = portalSlugIsCustom('siswa');
  /* Alamat publik yang sah hanya /<nama-sekolah>/<sub-slug>. Alamat lama (/portal)
     DIALIHKAN (302) ke alamat lengkap; hanya mode 'off' yang menolaknya (404). */
  const on = mode !== 'off';
  return { on, mode: (mode === 'on' || mode === 'off') ? mode : 'auto', custom, slug: portalSlugs().siswaSeg, path: portalSlugs().siswa };
}
/**
 * Path kanonik untuk sebuah request: slug kustom → path internal.
 * Dipakai server.js sebelum pencocokan route (mis. /portal-slip-pegawai → /portal-slip).
 */
function portalRewrite(pathname) {
  const p = String(pathname || '');
  if (!p.startsWith('/')) return null;
  const slugs = portalSlugs();
  const seg = '/' + p.slice(1).split('/')[0];
  for (const [key, canonical] of [['siswa', '/portal'], ['pegawai', '/portal-pegawai'], ['slip', '/portal-slip']]) {
    if (slugs[key + 'Seg'] !== PORTAL_SLUG_DEFAULT[key] && seg === '/' + slugs[key + 'Seg']) {
      return canonical + p.slice(seg.length);
    }
  }
  return null;
}
/** validasi slug yang diisi pengguna; null = valid */
function portalSlugError(raw, key) {
  const s = String(raw || '').trim();
  if (!s) return null;   // kosong = pakai default
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s.toLowerCase())) {
    return 'Alamat hanya boleh huruf kecil, angka, dan tanda hubung (-), panjang 3–40 karakter.';
  }
  const low = s.toLowerCase();
  // nilai default portal ybs. selalu boleh dipakai kembali
  if (low === PORTAL_SLUG_DEFAULT[key]) return null;
  if (RESERVED_SLUGS.has(low)) return `Alamat "/${low}" dipakai halaman lain di aplikasi. Pilih kata lain.`;
  const others = Object.entries(PORTAL_SLUG_KEYS).filter(([k]) => k !== key);
  for (const [k, settingKey] of others) {
    const otherRaw = String(getSetting(settingKey, '') || '').trim();
    const other = otherRaw ? normalizePortalSlug(otherRaw, PORTAL_SLUG_DEFAULT[k]) : PORTAL_SLUG_DEFAULT[k];
    if (other === low) return `Alamat "/${low}" sudah dipakai portal ${k}. Gunakan alamat berbeda.`;
  }
  return null;
}
function logAudit(user, aksi, modul, detail) {
  const t = nowStamp();
  try {
    db.prepare('INSERT INTO audit (user_id,user_nama,aksi,modul,detail,created_at) VALUES (?,?,?,?,?,?)')
      .run(user ? user.id : null, user ? user.nama : 'system', aksi, modul, detail, t);
  } catch (e) { }
  // ---- audit log terpusat (Semua sekolah) ----
  try {
    const conn = dbStore.getStore();
    if (conn && conn.__demoConn) return;              // sandbox demo tidak dicatat
    const meta = currentMeta();
    const tenantId = Number(meta.tenantId || (conn && conn.__tenantId) || 1);
    let tenantNama = meta.tenantNama || '';
    if (!tenantNama) {
      try { tenantNama = (controlDb.prepare('SELECT nama FROM tenants WHERE id=?').get(tenantId) || {}).nama || ''; } catch (e) { }
    }
    controlDb.prepare(`INSERT INTO audit_log (tenant_id,tenant_nama,user_id,user_nama,role,ip,aksi,modul,detail,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, String(tenantNama || ''),
      user ? user.id : null, user ? user.nama : 'sistem', user ? String(user.role || '') : 'sistem',
      String(meta.ip || ''), String(aksi || ''), String(modul || ''), String(detail || ''), t
    );
  } catch (e) { }
}
/** tahun ajaran berdasarkan id */
function tahunById(id) {
  const n = Number(id);
  if (!n) return null;
  return db.prepare('SELECT * FROM tahun_ajaran WHERE id=?').get(n) || null;
}
/** tahun ajaran yang sedang dipakai request: pilihan di header (sesi) → fallback tahun aktif */
function taOf(req) {
  if (!req) return activeTahun();
  if (req.TA !== undefined) return req.TA;
  return tahunById(req.taId) || activeTahun();
}
/** {from,to} tanggal tahun ajaran (fallback: tahun berjalan Juli–Juni) */
function taRange(ta) {
  const y = new Date().getFullYear();
  const from = String((ta && ta.tanggal_mulai) || `${y}-07-01`).slice(0, 10);
  const to = String((ta && ta.tanggal_selesai) || `${y + 1}-06-30`).slice(0, 10);
  return { from, to };
}
/** tahun ajaran yang memuat sebuah tanggal (fallback: tahun aktif) */
function taIdOfDate(tgl) {
  const d = String(tgl || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const hit = db.prepare(`SELECT id FROM tahun_ajaran WHERE COALESCE(tanggal_mulai,'')<>'' AND COALESCE(tanggal_selesai,'')<>''
      AND ? BETWEEN tanggal_mulai AND tanggal_selesai ORDER BY id DESC LIMIT 1`).get(d);
    if (hit) return hit.id;
  }
  const a = activeTahun();
  return a ? a.id : null;
}
/**
 * Tahun ajaran yang SESUAI dengan sebuah tanggal (tanpa fallback).
 * `null` bila tanggal tidak berada di rentang tahun pelajaran mana pun
 * (mis. tanggal salah ketik / rentang tahun pelajaran belum diisi).
 */
function taOfDate(tgl) {
  const d = String(tgl || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return db.prepare(`SELECT * FROM tahun_ajaran
    WHERE COALESCE(tanggal_mulai,'')<>'' AND COALESCE(tanggal_selesai,'')<>''
      AND ? BETWEEN tanggal_mulai AND tanggal_selesai
    ORDER BY tanggal_mulai DESC, id DESC LIMIT 1`).get(d) || null;
}
/**
 * BKU "padanan" pada tahun pelajaran lain: nama & jenis sama.
 * Dipakai agar transaksi yang tanggalnya milik tahun pelajaran lain tetap
 * dibukukan pada buku kas yang sama di tahun pelajaran tanggal tersebut,
 * bukan pada BKU tahun pelajaran yang sedang dibuka di layar.
 */
function bkuPadanan(bku, taId) {
  const b = (bku && typeof bku === 'object') ? bku : db.prepare('SELECT * FROM bku WHERE id=?').get(bku);
  if (!b || !taId) return null;
  return db.prepare(`SELECT * FROM bku
    WHERE tahun_ajaran_id=? AND COALESCE(auto_mode,0)=0
      AND lower(trim(nama))=lower(trim(?)) AND COALESCE(jenis,'')=COALESCE(?,'')
    ORDER BY CASE WHEN status='aktif' THEN 0 ELSE 1 END, id LIMIT 1`).get(Number(taId), b.nama, b.jenis || '') || null;
}
/**
 * Tentukan BKU tujuan penyimpanan transaksi berdasarkan TANGGAL transaksi.
 * Mengembalikan { bku, taTanggal, taSesi, dipindah, alasan } atau { error }.
 * - tanggal di luar semua rentang TA → tetap pakai BKU pilihan pengguna (alasan 'luar-rentang').
 * - tanggal milik TA lain → BKU padanan (nama sama) di TA tersebut.
 */
function resolveBkuTanggal(bku, tanggal, sesiTaId) {
  const taTgl = taOfDate(tanggal);
  const sesi = tahunById(sesiTaId);
  if (!taTgl) {
    return { bku, taTanggal: null, taSesi: sesi, dipindah: false, alasan: 'luar-rentang' };
  }
  if (Number(taTgl.id) === Number(bku.tahun_ajaran_id)) {
    return { bku, taTanggal: taTgl, taSesi: sesi, dipindah: false, alasan: 'sama' };
  }
  const pad = bkuPadanan(bku, taTgl.id);
  if (!pad) {
    return {
      error: `Tanggal transaksi berada pada tahun pelajaran ${taTgl.nama}, tetapi BKU "${bku.nama}" belum ada di tahun pelajaran tersebut. `
        + `Tambahkan BKU tersebut pada Master BKU tahun pelajaran ${taTgl.nama}, atau gunakan tanggal yang sesuai tahun pelajaran BKU ini.`,
      taTanggal: taTgl, taSesi: sesi
    };
  }
  if (pad.status !== 'aktif') {
    return {
      error: `Tanggal transaksi berada pada tahun pelajaran ${taTgl.nama}, dan BKU "${pad.nama}" di tahun pelajaran tersebut berstatus ${pad.status} (terkunci). `
        + `Buka kembali BKU tersebut atau gunakan tanggal lain.`,
      taTanggal: taTgl, taSesi: sesi
    };
  }
  return { bku: pad, taTanggal: taTgl, taSesi: sesi, dipindah: true, alasan: 'beda-ta' };
}
/** daftar tahun ajaran untuk dropdown header */
function taOptions() { return allTahun(); }

function activeTahun() {
  return db.prepare('SELECT * FROM tahun_ajaran WHERE aktif=1 ORDER BY id DESC LIMIT 1').get()
    || db.prepare('SELECT * FROM tahun_ajaran ORDER BY id DESC LIMIT 1').get();
}
/**
 * Semua tahun pelajaran, TERBARU DI ATAS (urutan kronologis menurun).
 * Dipakai konsisten oleh menu Master Tahun Ajaran & seluruh dropdown TA.
 * `aktif` TIDAK memengaruhi urutan (status aktif hanya penanda default login).
 */
function allTahun() {
  return db.prepare(`SELECT * FROM tahun_ajaran
    ORDER BY COALESCE(NULLIF(tanggal_mulai,''), '') DESC, nama DESC, id DESC`).all();
}
function allBku(tahunId) {
  // buku pembantu/rekap (auto_mode=1) tidak ditampilkan sebagai BKU dana — hanya rekapan otomatis
  if (tahunId) return db.prepare('SELECT * FROM bku WHERE tahun_ajaran_id=? AND COALESCE(auto_mode,0)=0 ORDER BY jenis DESC, urutan, id').all(tahunId);
  return db.prepare('SELECT * FROM bku WHERE COALESCE(auto_mode,0)=0 ORDER BY tahun_ajaran_id DESC, jenis DESC, urutan, id').all();
}
function allBkuRaw(tahunId) {
  if (tahunId) return db.prepare('SELECT * FROM bku WHERE tahun_ajaran_id=? ORDER BY jenis DESC, urutan, id').all(tahunId);
  return db.prepare('SELECT * FROM bku ORDER BY tahun_ajaran_id DESC, jenis DESC, urutan, id').all();
}
function bkuIuranGroups(bkuId) {
  return db.prepare(`SELECT g.*, t.nama ta_nama FROM bku_iuran_grup m
    JOIN iuran_grup g ON g.id=m.grup_id
    LEFT JOIN tahun_ajaran t ON t.id=g.tahun_ajaran_id
    WHERE m.bku_id=? ORDER BY t.tanggal_mulai, g.nama, g.id`).all(bkuId);
}
function bkuForIuranGrup(grupId) {
  return db.prepare(`SELECT b.* FROM bku_iuran_grup m
    JOIN bku b ON b.id=m.bku_id WHERE m.grup_id=?`).get(grupId) || null;
}
function bkuRabRows(bkuId) {
  return db.prepare(`SELECT r.*, c.kode, c.nama,
      COALESCE((SELECT SUM(t.nominal) FROM transaksi t
        WHERE t.bku_id=r.bku_id AND t.coa_id=r.coa_id
          AND t.status='posted' AND t.jenis='pengeluaran'),0) realisasi
    FROM bku_rab r JOIN coa c ON c.id=r.coa_id
    WHERE r.bku_id=? ORDER BY c.kode, c.id`).all(bkuId).map(r => ({
    ...r, pagu: Number(r.pagu || 0), realisasi: Number(r.realisasi || 0)
  }));
}
function bkuRabSummary(bkuId) {
  const b = db.prepare('SELECT * FROM bku WHERE id=?').get(bkuId);
  if (!b) return { rows: [], totalPagu: 0, realisasi: 0, sisa: 0, overCount: 0, configured: false, legacy: false };
  const rows = bkuRabRows(bkuId);
  const totalPagu = rows.length ? rows.reduce((sum, r) => sum + r.pagu, 0) : Math.max(0, Number(b.rab || 0));
  const realisasi = Number(db.prepare(`SELECT COALESCE(SUM(nominal),0) total FROM transaksi
    WHERE bku_id=? AND status='posted' AND jenis='pengeluaran'`).get(bkuId).total || 0);
  let overCount = totalPagu > 0 && realisasi > totalPagu ? 1 : 0;
  if (rows.length) {
    const spent = db.prepare(`SELECT t.coa_id, COALESCE(SUM(t.nominal),0) realisasi
      FROM transaksi t WHERE t.bku_id=? AND t.status='posted' AND t.jenis='pengeluaran'
      GROUP BY t.coa_id`).all(bkuId);
    const paguByCoa = new Map(rows.map(r => [Number(r.coa_id), r.pagu]));
    overCount = spent.filter(r => Number(r.realisasi || 0) > Number(paguByCoa.get(Number(r.coa_id)) || 0)).length;
  }
  return {
    rows, totalPagu, realisasi, sisa: totalPagu - realisasi, overCount,
    configured: rows.length > 0 || totalPagu > 0,
    legacy: rows.length === 0 && totalPagu > 0
  };
}
function autoBku(tahunId) {
  if (tahunId) return db.prepare('SELECT * FROM bku WHERE tahun_ajaran_id=? AND COALESCE(auto_mode,0)=1 ORDER BY urutan, id').all(tahunId);
  return db.prepare('SELECT * FROM bku WHERE COALESCE(auto_mode,0)=1 ORDER BY tahun_ajaran_id DESC, urutan, id').all();
}
function bkuIuranReceived(bkuId, range = {}) {
  let sql = `SELECT COALESCE(SUM(COALESCE(p.dibayar,0)),0) diterima
    FROM bku_iuran_grup m
    JOIN iuran_tagihan t ON t.grup_id=m.grup_id
    JOIN iuran_bayar p ON p.tagihan_id=t.id AND p.status<>'void'
    WHERE m.bku_id=?`;
  const args = [bkuId];
  if (range.before) { sql += ' AND p.tanggal<?'; args.push(range.before); }
  if (range.from) { sql += ' AND p.tanggal>=?'; args.push(range.from); }
  if (range.to) { sql += ' AND p.tanggal<=?'; args.push(range.to); }
  const row = db.prepare(sql).get(...args);
  return Number(row.diterima || 0);
}
function bkuUsesIuranSaldo(bkuId) {
  const b = db.prepare('SELECT jenis FROM bku WHERE id=?').get(bkuId);
  return !!b && b.jenis === 'kegiatan';
}
function bkuIncomeEnabled(bkuId) {
  const b = db.prepare('SELECT jenis, pemasukan_saldo FROM bku WHERE id=?').get(bkuId);
  return !!b && (b.jenis !== 'kegiatan' || Number(b.pemasukan_saldo) === 1);
}
function bkuTransactionVisibleSql(trxAlias = 't', bkuAlias = 'b') {
  return `(${trxAlias}.jenis<>'pemasukan' OR COALESCE(${trxAlias}.is_penyesuaian,0)=1
    OR COALESCE(${bkuAlias}.jenis,'')<>'kegiatan'
    OR (COALESCE(${bkuAlias}.pemasukan_saldo,0)=1
      AND NOT EXISTS (SELECT 1 FROM iuran_bayar p WHERE p.transaksi_id=${trxAlias}.id)))`;
}
function bkuRegularIncome(bkuId, range = {}) {
  let sql = `SELECT COALESCE(SUM(t.nominal),0) masuk FROM transaksi t
    WHERE t.bku_id=? AND t.status='posted' AND t.jenis='pemasukan'
      AND COALESCE(t.is_penyesuaian,0)<>1
      AND NOT EXISTS (SELECT 1 FROM iuran_bayar p WHERE p.transaksi_id=t.id)`;
  const args = [bkuId];
  if (range.before) { sql += ' AND t.tanggal<?'; args.push(range.before); }
  if (range.from) { sql += ' AND t.tanggal>=?'; args.push(range.from); }
  if (range.to) { sql += ' AND t.tanggal<=?'; args.push(range.to); }
  return Number(db.prepare(sql).get(...args).masuk || 0);
}
function bkuSaldo(bkuId) {
  const b = db.prepare('SELECT * FROM bku WHERE id=?').get(bkuId);
  if (!b) return 0;
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN jenis='pemasukan' THEN nominal ELSE 0 END),0) masuk,
      COALESCE(SUM(CASE WHEN jenis='pemasukan' AND COALESCE(is_penyesuaian,0)=1 THEN nominal ELSE 0 END),0) masuk_penyesuaian,
      COALESCE(SUM(CASE WHEN jenis='pengeluaran' THEN nominal ELSE 0 END),0) keluar
      FROM transaksi WHERE bku_id=? AND status='posted'`).get(bkuId);
  if (bkuUsesIuranSaldo(bkuId)) {
    return Number(b.saldo_awal || 0) + bkuIuranReceived(bkuId)
      + Number(r.masuk_penyesuaian || 0)
      + (Number(b.pemasukan_saldo) === 1 ? bkuRegularIncome(bkuId) : 0)
      - Number(r.keluar || 0);
  }
  return Number(b.saldo_awal || 0) + r.masuk - r.keluar;
}
function bkuTotals(bkuId, from, to) {
  let q = `SELECT COALESCE(SUM(CASE WHEN jenis='pemasukan' THEN nominal ELSE 0 END),0) masuk,
      COALESCE(SUM(CASE WHEN jenis='pengeluaran' THEN nominal ELSE 0 END),0) keluar
      FROM transaksi WHERE bku_id=? AND status='posted'`;
  const args = [bkuId];
  if (from) { q += ' AND tanggal>=?'; args.push(from); }
  if (to) { q += ' AND tanggal<=?'; args.push(to); }
  return db.prepare(q).get(...args);
}
function bkuVisibleIncomeTotal(bkuId, range = {}) {
  const b = db.prepare('SELECT jenis FROM bku WHERE id=?').get(bkuId);
  if (!b) return 0;
  if (bkuUsesIuranSaldo(bkuId)) {
    let sql = `SELECT COALESCE(SUM(nominal),0) masuk FROM transaksi
      WHERE bku_id=? AND status='posted' AND jenis='pemasukan' AND COALESCE(is_penyesuaian,0)=1`;
    const args = [bkuId];
    if (range.before) { sql += ' AND tanggal<?'; args.push(range.before); }
    if (range.from) { sql += ' AND tanggal>=?'; args.push(range.from); }
    if (range.to) { sql += ' AND tanggal<=?'; args.push(range.to); }
    const adjustment = Number(db.prepare(sql).get(...args).masuk || 0);
    return adjustment + (bkuIncomeEnabled(bkuId) ? bkuRegularIncome(bkuId, range) : 0);
  }
  let sql = `SELECT COALESCE(SUM(nominal),0) masuk FROM transaksi
    WHERE bku_id=? AND status='posted' AND jenis='pemasukan'`;
  const args = [bkuId];
  if (range.before) { sql += ' AND tanggal<?'; args.push(range.before); }
  if (range.from) { sql += ' AND tanggal>=?'; args.push(range.from); }
  if (range.to) { sql += ' AND tanggal<=?'; args.push(range.to); }
  return Number(db.prepare(sql).get(...args).masuk || 0);
}
function globalTotals(taId) {
  const args = [];
  let sql = `SELECT
      COALESCE(SUM(CASE WHEN t.jenis='pemasukan' THEN t.nominal ELSE 0 END),0) masuk,
      COALESCE(SUM(CASE WHEN t.jenis='pengeluaran' THEN t.nominal ELSE 0 END),0) keluar
    FROM transaksi t JOIN bku b ON b.id=t.bku_id
    WHERE t.status='posted' AND ${bkuTransactionVisibleSql('t', 'b')}`;
  if (taId) { sql += ' AND b.tahun_ajaran_id=?'; args.push(taId); }
  return db.prepare(sql).get(...args);
}
/** ukuran berkas database aplikasi (DB + WAL/SHM) dalam byte */
function dbSizeBytes() {
  let total = 0;
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { total += fs.statSync(f).size; } catch (e) { /* berkas belum ada */ }
  }
  return total;
}
/** kuota indikator penyimpanan database di dashboard (default 5 GB) — bisa dioverride lewat env STORAGE_QUOTA_MB */
function storageQuotaBytes() {
  const mb = Number(process.env.STORAGE_QUOTA_MB || 5120);
  return (mb > 0 ? mb : 5120) * 1024 * 1024;
}
function storageInfo() {
  const used = dbSizeBytes();
  const quota = storageQuotaBytes();
  return { used, quota, sisa: Math.max(0, quota - used), pct: quota > 0 ? Math.min(100, (used / quota) * 100) : 0 };
}
function kasBankTunai(taId) {
  let txnSql = `SELECT
     COALESCE(SUM(CASE WHEN t.metode='transfer' AND t.jenis='pemasukan' THEN t.nominal
                       WHEN t.metode='transfer' AND t.jenis='pengeluaran' THEN -t.nominal ELSE 0 END),0) bank,
     COALESCE(SUM(CASE WHEN t.metode='tunai' AND t.jenis='pemasukan' THEN t.nominal
                       WHEN t.metode='tunai' AND t.jenis='pengeluaran' THEN -t.nominal ELSE 0 END),0) tunai
     FROM transaksi t JOIN bku b ON b.id=t.bku_id
     WHERE t.status='posted' AND ${bkuTransactionVisibleSql('t', 'b')}`;
  if (taId) txnSql += ' AND b.tahun_ajaran_id=?';
  const r = taId ? db.prepare(txnSql).get(taId) : db.prepare(txnSql).get();
  const iuranSql = `SELECT
     COALESCE(SUM(CASE WHEN p.metode='transfer' THEN p.dibayar ELSE 0 END),0) bank,
     COALESCE(SUM(CASE WHEN p.metode='tunai' THEN p.dibayar ELSE 0 END),0) tunai
    FROM iuran_bayar p JOIN transaksi t ON t.id=p.transaksi_id
    JOIN bku b ON b.id=t.bku_id
    WHERE p.status='posted' AND t.status='posted' AND t.jenis='pemasukan'
     AND COALESCE(t.is_penyesuaian,0)<>1 AND b.jenis='kegiatan'${taId ? ' AND b.tahun_ajaran_id=?' : ''}`;
  const iuran = taId ? db.prepare(iuranSql).get(taId) : db.prepare(iuranSql).get();
  return {
    bank: Number(r.bank || 0) + Number(iuran.bank || 0),
    tunai: Number(r.tunai || 0) + Number(iuran.tunai || 0)
  };
}
/** Kas riil = otomatis dari transaksi + mutasi bank/cash + penyesuaian manual (tabel aset jenis bank/tunai) */
function asetKas(taId) {
  const auto = kasBankTunai(taId);
  const adj = jenis => {
    const r = taId
      ? db.prepare('SELECT COALESCE(SUM(saldo),0) s FROM aset WHERE jenis=? AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)').get(jenis, taId)
      : db.prepare('SELECT COALESCE(SUM(saldo),0) s FROM aset WHERE jenis=?').get(jenis);
    return Number(r.s || 0);
  };
  // mutasi antar kas/bank tidak masuk BKU, hanya menggeser saldo kas bank & tunai
  const mut = taId
    ? db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN ke='bank' THEN nominal WHEN dari='bank' THEN -nominal ELSE 0 END),0) bank,
        COALESCE(SUM(CASE WHEN ke='tunai' THEN nominal WHEN dari='tunai' THEN -nominal ELSE 0 END),0) tunai
        FROM mutasi_kas WHERE tahun_ajaran_id=?`).get(taId)
    : db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN ke='bank' THEN nominal WHEN dari='bank' THEN -nominal ELSE 0 END),0) bank,
        COALESCE(SUM(CASE WHEN ke='tunai' THEN nominal WHEN dari='tunai' THEN -nominal ELSE 0 END),0) tunai
        FROM mutasi_kas`).get();
  const bankAdj = adj('bank'), tunaiAdj = adj('tunai');
  return {
    bankAuto: auto.bank, tunaiAuto: auto.tunai,
    bankMutasi: Number(mut.bank || 0), tunaiMutasi: Number(mut.tunai || 0),
    bankAdj, tunaiAdj,
    bank: auto.bank + Number(mut.bank || 0) + bankAdj, tunai: auto.tunai + Number(mut.tunai || 0) + tunaiAdj
  };
}
/* ---------- buku bantu akun aset (pinjaman kegiatan & akun aset lainnya) ---------- */
/** Saldo aset lain memakai saldo awal + masuk − keluar; pinjaman memakai keluar − masuk per TA. */
function asetMutasi(asetId) {
  return db.prepare('SELECT * FROM pinjaman_mutasi WHERE aset_id=? ORDER BY tanggal, id').all(asetId);
}
function asetLedger(asetId, taId) {
  const akun = db.prepare("SELECT * FROM aset WHERE id=? AND jenis IN ('pinjaman','lain')").get(asetId);
  if (!akun) return { akun: null, awal: 0, masuk: 0, keluar: 0, saldo: 0, rows: [] };
  const isPinjaman = akun.jenis === 'pinjaman';
  const scopeTaId = Number(taId || akun.tahun_ajaran_id || 0);
  let rows0 = asetMutasi(akun.id);
  if (isPinjaman && scopeTaId) {
    const range = taRange(tahunById(scopeTaId));
    rows0 = rows0.filter(m => {
      const tanggal = String(m.tanggal || '').slice(0, 10);
      return tanggal >= range.from && tanggal <= range.to;
    });
  }
  const awal = isPinjaman ? 0 : Number(akun.saldo || 0);
  let run = awal;
  const rows = rows0.map(m => {
    const nominal = Number(m.nominal || 0);
    run += isPinjaman
      ? (m.jenis === 'keluar' ? nominal : -nominal)
      : (m.jenis === 'masuk' ? nominal : -nominal);
    return { ...m, saldo: run };
  });
  return {
    akun, awal,
    masuk: rows0.filter(r => r.jenis === 'masuk').reduce((s, r) => s + Number(r.nominal || 0), 0),
    keluar: rows0.filter(r => r.jenis === 'keluar').reduce((s, r) => s + Number(r.nominal || 0), 0),
    saldo: run, rows
  };
}
/** semua akun pinjaman kegiatan (boleh lebih dari satu) */
function pinjamanList(taId, opts = {}) {
  const cond = opts.all ? '' : ' AND COALESCE(tampil,1)=1';
  const rows = taId
    ? db.prepare("SELECT * FROM aset WHERE jenis='pinjaman' AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)" + cond + " ORDER BY id").all(taId)
    : db.prepare("SELECT * FROM aset WHERE jenis='pinjaman'" + cond + " ORDER BY id").all();
  return rows.map(a => asetLedger(a.id, taId || a.tahun_ajaran_id));
}
function asetLain(taId, opts = {}) {
  const cond = opts.all ? '' : ' AND COALESCE(tampil,1)=1';
  const rows = taId
    ? db.prepare("SELECT * FROM aset WHERE jenis='lain' AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)" + cond + " ORDER BY id").all(taId)
    : db.prepare("SELECT * FROM aset WHERE jenis='lain'" + cond + " ORDER BY id").all();
  return rows
    .map(a => {
      const lg = asetLedger(a.id);
      return { ...a, saldo_awal: lg.awal, saldo: lg.saldo, masuk: lg.masuk, keluar: lg.keluar, jumlah_mutasi: lg.rows.length };
    });
}
/** akun aset non kas (pinjaman + lain) untuk total aset riil */
function asetNonKasTotal(taId) {
  const cond = taId ? ' AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)' : '';
  const args = taId ? [taId] : [];
  const pinj = pinjamanList(taId).reduce((sum, p) =>
    sum + (Number(p.akun.tampil === undefined ? 1 : p.akun.tampil) !== 0 ? Number(p.saldo || 0) : 0), 0);
  const lainAwal = db.prepare(`SELECT COALESCE(SUM(saldo),0) s FROM aset WHERE jenis='lain' AND COALESCE(tampil,1)=1${cond}`).get(...args).s;
  const mut = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN m.jenis='masuk' THEN m.nominal ELSE 0 END),0) masuk,
      COALESCE(SUM(CASE WHEN m.jenis='keluar' THEN m.nominal ELSE 0 END),0) keluar
    FROM pinjaman_mutasi m JOIN aset a ON a.id=m.aset_id WHERE a.jenis='lain' AND COALESCE(a.tampil,1)=1${cond ? ' AND (a.tahun_ajaran_id=? OR a.tahun_ajaran_id IS NULL)' : ''}`).get(...args);
  return Number(pinj || 0) + Number(lainAwal || 0) + Number(mut.masuk || 0) - Number(mut.keluar || 0);
}
/** akun pinjaman pertama (kompatibilitas modul lama) */
function pinjamanAkun() {
  const acc = db.prepare("SELECT * FROM aset WHERE jenis='pinjaman' ORDER BY id LIMIT 1").get();
  if (!acc) return { akun: null, saldo: 0, awal: 0, masuk: 0, keluar: 0, mutasi: [] };
  const ta = activeTahun();
  const lg = asetLedger(acc.id, acc.tahun_ajaran_id || (ta && ta.id));
  return { akun: acc, awal: lg.awal, masuk: lg.masuk, keluar: lg.keluar, saldo: lg.saldo, mutasi: lg.rows };
}
function piutangSisa(id) {
  const p = db.prepare('SELECT * FROM piutang WHERE id=?').get(id);
  if (!p) return 0;
  const b = db.prepare('SELECT COALESCE(SUM(nominal),0) s FROM piutang_bayar WHERE piutang_id=?').get(id).s;
  return Math.max(0, Number(p.nominal || 0) - Number(b || 0));
}
/** total sisa piutang pegawai — memakai agregasi yang sama dengan portal publik (tanpa dobel salinan rollover) */
function piutangPegawaiTotal(taId) {
  return piutangBucketsAll('umum', taId).reduce((s, b) => s + b.sisa, 0);
}
/** periode 'YYYY-MM' sebuah bulan SPP pada tahun ajaran */
function sppPeriode(ta, bulan) {
  if (!ta) return null;
  const start = String(ta.tanggal_mulai || '').slice(0, 10);
  const sy = start ? Number(start.slice(0, 4)) : new Date().getFullYear();
  const sm = start ? Number(start.slice(5, 7)) : 7;
  const y = Number(bulan) >= sm ? sy : sy + 1;
  return `${y}-${String(bulan).padStart(2, '0')}`;
}
/** total transaksi Penerimaan SPP (CoA 4.1.01) per bulan SPP */
function sppTerimaMap(taId) {
  const ta = db.prepare('SELECT * FROM tahun_ajaran WHERE id=?').get(taId);
  const out = {};
  if (!ta) return out;
  const paid = {};
  for (const r of db.prepare(`SELECT substr(t.tanggal,1,7) p, COALESCE(SUM(t.nominal),0) s
      FROM transaksi t JOIN coa c ON c.id=t.coa_id
      WHERE t.status='posted' AND c.kode='4.1.01' GROUP BY p`).all()) paid[r.p] = Number(r.s || 0);
  for (let b = 1; b <= 12; b++) {
    const p = sppPeriode(ta, b);
    if (paid[p]) out[b] = paid[p];
  }
  return out;
}
/** deret 12 bulan penerimaan SPP (untuk line chart dashboard) */
function sppSeries(taId) {
  const months = BULAN_TA.map(b => ({ bulan: b, label: `${String(NAMA_BULAN[b - 1] || '').slice(0, 3)}`, diterima: 0, ditagihkan: 0 }));
  if (!taId) return months;
  // sumber angka = DATA IURAN RIIL (grup bulanan bernama SPP; bila tidak ada, seluruh grup bulanan)
  const groups = iuranGrupList(taId, {}).filter(g => g.jenis === 'bulanan');
  const sppOnly = groups.filter(g => /\bspp\b/i.test(String(g.nama || '').trim()));
  const use = sppOnly.length ? sppOnly : groups;
  if (!use.length) return months;
  const ids = new Set(use.map(g => g.id));
  const tags = iuranTagihanRows({ taId, aktifOnly: true }).filter(t => ids.has(t.grup_id));
  const pays = iuranPaysMap(tags.map(t => t.id));
  const acc = new Map();
  for (const t of tags) {
    const tingkat = t.tingkat || siswaTingkat(t.siswa_id, t.tahun_ajaran_id);
    for (const m of iuranMonthDetail(t.grup_id, pays.get(t.id) || [], tingkat)) {
      const cur = acc.get(m.bulan) || { tagihan: 0, dibayar: 0 };
      cur.tagihan += Number(m.tagihan || 0);
      cur.dibayar += Number(m.dibayar || 0);
      acc.set(m.bulan, cur);
    }
  }
  return months.map(m => {
    const a = acc.get(m.bulan) || { tagihan: 0, dibayar: 0 };
    return { ...m, diterima: a.dibayar, ditagihkan: a.tagihan };
  });
}
function sppTunggakan(tahunId) {
  const list = tahunId
    ? [db.prepare('SELECT * FROM tahun_ajaran WHERE id=?').get(tahunId)].filter(Boolean)
    : db.prepare('SELECT * FROM tahun_ajaran').all();
  let total = 0;
  for (const ta of list) {
    const paid = sppTerimaMap(ta.id);
    let tung = 0;
    for (const r of db.prepare('SELECT * FROM spp WHERE tahun_ajaran_id=?').all(ta.id)) {
      const diterima = Number(r.diterima_manual || 0) + Number(paid[r.bulan] || 0);
      tung += Math.max(0, Number(r.total_ditagihkan || 0) - diterima);
    }
    total += Math.max(0, tung - beasiswaTotal(ta.id));
  }
  return total;
}
/** total nilai beasiswa SPP aktif (mengurangi piutang/tunggakan SPP) */
function beasiswaTotal(tahunId) {
  if (tahunId) {
    return Number(db.prepare('SELECT COALESCE(SUM(nominal),0) s FROM beasiswa WHERE aktif=1 AND tahun_ajaran_id=?').get(tahunId).s || 0);
  }
  return Number(db.prepare('SELECT COALESCE(SUM(nominal),0) s FROM beasiswa WHERE aktif=1').get().s || 0);
}
function beasiswaList(tahunId) {
  const sel = `SELECT b.*, t.nama ta_nama FROM beasiswa b LEFT JOIN tahun_ajaran t ON t.id=b.tahun_ajaran_id`;
  return tahunId ? db.prepare(sel + ' WHERE b.tahun_ajaran_id=? ORDER BY b.id DESC').all(tahunId)
    : db.prepare(sel + ' ORDER BY b.id DESC').all();
}
function sppTampil() { return getSetting('tampil_piutang_spp', '1') === '1'; }
function sertifikasiTampil() { return getSetting('tampil_piutang_sertifikasi', '1') === '1'; }

/* ---------- piutang lain-lain (sertifikasi) ---------- */
/** daftar piutang lain + akumulasi cicilan & sisa */
function piutangLainRows(taId) {
  const sql = `SELECT p.*,
      COALESCE((SELECT SUM(x.nominal) FROM piutang_lain_bayar x WHERE x.piutang_id=p.id),0) dibayar
    FROM piutang_lain p` + (taId ? ' WHERE (p.tahun_ajaran_id=? OR p.tahun_ajaran_id IS NULL)' : '') +
    ` ORDER BY (p.status='lunas'), COALESCE(p.tanggal,'') DESC, p.id DESC`;
  return db.prepare(sql).all(...(taId ? [taId] : []))
    .map(p => ({ ...p, dibayar: Number(p.dibayar || 0), sisa: Math.max(0, Number(p.nominal || 0) - Number(p.dibayar || 0)) }));
}
function piutangLainSisa(id) {
  const p = db.prepare('SELECT * FROM piutang_lain WHERE id=?').get(id);
  if (!p) return 0;
  const b = Number(db.prepare('SELECT COALESCE(SUM(nominal),0) s FROM piutang_lain_bayar WHERE piutang_id=?').get(id).s || 0);
  return Math.max(0, Number(p.nominal || 0) - b);
}
function piutangLainTotal(kategori, taId) {
  // kategori tunggal ('Sertifikasi') = seluruh piutang lain; kategori lain tetap per baris
  if (!kategori || kategori === 'Sertifikasi') {
    return piutangBucketsAll('lain', taId).reduce((s, b) => s + b.sisa, 0);
  }
  const wh = ['kategori=?'];
  const args = [kategori];
  if (taId) { wh.push('(tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)'); args.push(taId); }
  const rows = db.prepare(`SELECT id FROM piutang_lain WHERE ${wh.join(' AND ')}`).all(...args);
  return rows.reduce((s, r) => s + piutangLainSisa(r.id), 0);
}
/** total piutang sertifikasi yang tampil di laporan (mengikuti sakelar) */
function piutangLainNeraca(taId) {
  return sertifikasiTampil() ? piutangLainTotal('Sertifikasi', taId) : 0;
}

/* ==================================================================
   PIUTANG LAINNYA — kategori fleksibel (CRUD admin) + tagihan/cicilan
   Tabel terpisah dari piutang sertifikasi agar kedua modul tidak saling
   memengaruhi, tetapi alur & perhitungannya identik.
   ================================================================== */
function piutangLainnyaTampil() { return getSetting('tampil_piutang_lainnya', '1') === '1'; }
function piutangKategoriList(opts = {}) {
  const rows = db.prepare(`SELECT * FROM piutang_kategori${opts.aktifOnly ? ' WHERE aktif=1' : ''} ORDER BY urutan, nama`).all();
  return rows.map(k => ({
    ...k,
    jumlah: db.prepare('SELECT COUNT(*) c FROM piutang_lainnya WHERE kategori_id=?').get(k.id).c,
    sisa: Number(db.prepare(`SELECT COALESCE(SUM(MAX(COALESCE(p.nominal,0) -
        COALESCE((SELECT SUM(x.nominal) FROM piutang_lainnya_bayar x WHERE x.piutang_id=p.id),0),0)),0) s
      FROM piutang_lainnya p WHERE p.kategori_id=?`).get(k.id).s || 0)
  }));
}
function piutangKategoriById(id) { return db.prepare('SELECT * FROM piutang_kategori WHERE id=?').get(id); }
function piutangKategoriByNama(nama) {
  return db.prepare('SELECT * FROM piutang_kategori WHERE lower(trim(nama))=lower(trim(?))').get(String(nama || ''));
}
/** daftar tagihan piutang lainnya + akumulasi cicilan & sisa */
function piutangLainnyaRows(taId, opts = {}) {
  const wh = [], args = [];
  if (taId) { wh.push('(p.tahun_ajaran_id=? OR p.tahun_ajaran_id IS NULL)'); args.push(taId); }
  if (opts.kategoriId) {
    const ids = [].concat(opts.kategoriId).map(Number).filter(Boolean);
    if (ids.length) { wh.push(`p.kategori_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
  }
  if (opts.q) { wh.push('(p.nama LIKE ? OR p.keterangan LIKE ?)'); args.push('%' + opts.q + '%', '%' + opts.q + '%'); }
  const sql = `SELECT p.*, k.nama kategori_nama, k.tampil_aset,
      COALESCE((SELECT SUM(x.nominal) FROM piutang_lainnya_bayar x WHERE x.piutang_id=p.id),0) dibayar
    FROM piutang_lainnya p LEFT JOIN piutang_kategori k ON k.id=p.kategori_id
    ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
    ORDER BY (p.status='lunas'), COALESCE(p.tanggal,'') DESC, p.id DESC`;
  return db.prepare(sql).all(...args).map(p => ({
    ...p, dibayar: Number(p.dibayar || 0),
    sisa: Math.max(0, Number(p.nominal || 0) - Number(p.dibayar || 0))
  }));
}
function piutangLainnyaSisa(id) {
  const p = db.prepare('SELECT * FROM piutang_lainnya WHERE id=?').get(id);
  if (!p) return 0;
  const b = Number(db.prepare('SELECT COALESCE(SUM(nominal),0) s FROM piutang_lainnya_bayar WHERE piutang_id=?').get(id).s || 0);
  return Math.max(0, Number(p.nominal || 0) - b);
}
/**
 * Total sisa piutang lainnya.
 * `hanyaTampil` = hanya kategori yang sakelar "Tampilkan di Akun Aset Riil" aktif
 * (dipakai perhitungan aset riil / rekonsiliasi kas).
 */
function piutangLainnyaTotal(taId, opts = {}) {
  const rows = piutangLainnyaRows(taId, opts);
  return rows.reduce((s, r) => {
    if (opts.hanyaTampil && Number(r.tampil_aset) === 0) return s;
    return s + Number(r.sisa || 0);
  }, 0);
}
/** nilai piutang lainnya yang ikut dihitung pada Akun Aset Riil */
function piutangLainnyaAset(taId) {
  if (!piutangLainnyaTampil()) return 0;
  return piutangLainnyaTotal(taId, { hanyaTampil: true });
}
/** rincian per kategori untuk tabel aset riil (hanya yang tampil) */
function piutangLainnyaAsetRows(taId, opts = {}) {
  return piutangKategoriList().filter(k => opts.all || (Number(k.tampil_aset) !== 0 && Number(k.aktif) !== 0))
    .map(k => ({ id: k.id, nama: k.nama, tampil: Number(k.tampil_aset) !== 0, sisa: piutangLainnyaTotal(taId, { kategoriId: k.id }) }));
}
/** rekap piutang lainnya per nama (sama seperti rekap piutang sertifikasi) */
function piutangLainnyaRekap(taId, opts = {}) {
  const map = new Map();
  for (const p of piutangLainnyaRows(taId, opts)) {
    if (opts.hanyaBelum && !(p.sisa > 0)) continue;
    const key = String(p.nama || '').trim().toLowerCase();
    if (!map.has(key)) map.set(key, { nama: String(p.nama || '').trim(), jumlah: 0, aktif: 0, nominal: 0, dibayar: 0, sisa: 0, items: [] });
    const g = map.get(key);
    g.jumlah++;
    g.nominal += Number(p.nominal || 0);
    g.dibayar += Number(p.dibayar || 0);
    g.sisa += Number(p.sisa || 0);
    if (p.sisa > 0) { g.aktif++; g.items.push(p); }
  }
  return [...map.values()].sort((a, b) => (b.sisa - a.sisa) || a.nama.localeCompare(b.nama, 'id'));
}
/** sinkronkan status tagihan piutang lainnya dengan total cicilan */
function piutangLainnyaSyncStatus() {
  let n = 0;
  db.transaction(() => {
    const insuf = `COALESCE(nominal,0) - COALESCE((SELECT SUM(x.nominal) FROM piutang_lainnya_bayar x WHERE x.piutang_id=piutang_lainnya.id),0)`;
    n += db.prepare(`UPDATE piutang_lainnya SET status='lunas',
        tanggal_bayar=COALESCE(tanggal_bayar,(SELECT MAX(x.tanggal) FROM piutang_lainnya_bayar x WHERE x.piutang_id=piutang_lainnya.id),date('now'))
      WHERE status<>'lunas' AND ${insuf} <= 0`).run().changes;
    n += db.prepare(`UPDATE piutang_lainnya SET status='belum', tanggal_bayar=NULL
      WHERE status<>'belum' AND ${insuf} > 0`).run().changes;
  })();
  return n;
}

/**
 * Sinkronisasi status piutang (pegawai & sertifikasi) dengan total cicilan.
 * Sumber kebenaran = tabel pembayaran (piutang_bayar / piutang_lain_bayar);
 * kolom status hanya cache agar halaman master & portal publik selalu sama.
 * Hanya baris yang statusnya tidak sesuai yang di-UPDATE (menghindari tulis sia-sia).
 */
function piutangSyncStatus() {
  let n = 0;
  db.transaction(() => {
    const insuf = `COALESCE(nominal,0) - COALESCE((SELECT SUM(x.nominal) FROM piutang_bayar x WHERE x.piutang_id=piutang.id),0)`;
    const insufLain = `COALESCE(nominal,0) - COALESCE((SELECT SUM(x.nominal) FROM piutang_lain_bayar x WHERE x.piutang_id=piutang_lain.id),0)`;
    n += db.prepare(`UPDATE piutang SET status='lunas',
        tanggal_bayar=COALESCE(tanggal_bayar,(SELECT MAX(x.tanggal) FROM piutang_bayar x WHERE x.piutang_id=piutang.id),date('now'))
      WHERE status<>'lunas' AND ${insuf} <= 0`).run().changes;
    n += db.prepare(`UPDATE piutang SET status='belum', tanggal_bayar=NULL
      WHERE status<>'belum' AND ${insuf} > 0`).run().changes;
    n += db.prepare(`UPDATE piutang_lain SET status='lunas',
        tanggal_bayar=COALESCE(tanggal_bayar,(SELECT MAX(x.tanggal) FROM piutang_lain_bayar x WHERE x.piutang_id=piutang_lain.id),date('now'))
      WHERE status<>'lunas' AND ${insufLain} <= 0`).run().changes;
    n += db.prepare(`UPDATE piutang_lain SET status='belum', tanggal_bayar=NULL
      WHERE status<>'belum' AND ${insufLain} > 0`).run().changes;
  })();
  return n;
}
/** buang semua prefix "Saldo awal TA ... — " (bisa berlapis) dari keterangan piutang */
function stripCarryText(txt) {
  let t = String(txt === undefined || txt === null ? '' : txt).trim();
  for (let i = 0; i < 12; i++) {
    const m = /^saldo\s*awal\s*ta\s+[^\u2014]*\u2014\s*(.*)$/i.exec(t);
    if (!m) break;
    t = String(m[1] || '').trim();
  }
  return t;
}
/** true bila keterangan merupakan salinan saldo awal (hasil rollover tahun pelajaran) */
function isCarryText(txt) { return /^saldo\s*awal\s*ta\s/i.test(String(txt || '').trim()); }

/**
 * Agregasi piutang per pegawai (Current Outstanding Balance).
 * Salinan rollover ("Saldo awal TA ...") TIDAK dihitung sebagai utang baru: baris dengan
 * teks dasar + nominal sama digabung menjadi SATU utang, nominalnya dihitung sekali
 * (jumlah baris asli), sedangkan seluruh pembayaran pada rantai salinan ikut mengurangi.
 * Hasil: transaksi yang sudah lunas pasti bersisa 0 → berstatus LUNAS.
 */
function piutangBuckets(kind, nama) {
  const nm = String(nama || '').trim();
  const isLain = kind === 'lain';
  const rows = isLain
    ? db.prepare(`SELECT p.*, COALESCE((SELECT SUM(x.nominal) FROM piutang_lain_bayar x WHERE x.piutang_id=p.id),0) dibayar
        FROM piutang_lain p WHERE lower(trim(p.nama))=lower(trim(?)) ORDER BY COALESCE(p.tanggal,''), p.id`).all(nm)
    : db.prepare(`SELECT p.*, COALESCE((SELECT SUM(x.nominal) FROM piutang_bayar x WHERE x.piutang_id=p.id),0) dibayar
        FROM piutang p WHERE lower(trim(p.nama_pegawai))=lower(trim(?)) ORDER BY COALESCE(p.tanggal_utang,''), p.id`).all(nm);
  const tglKey = isLain ? 'tanggal' : 'tanggal_utang';
  const map = new Map();
  for (const r of rows) {
    const base = stripCarryText(r.keterangan) || (isLain ? 'Piutang sertifikasi' : 'Piutang pegawai');
    const nominal = Math.round(Number(r.nominal) || 0);
    const key = base.toLowerCase() + '|' + nominal;
    if (!map.has(key)) {
      map.set(key, { base, nominal, originals: 0, carries: 0, paid: 0, rows: [], tanggal: r[tglKey], taId: r.tahun_ajaran_id || null });
    }
    const g = map.get(key);
    if (isCarryText(r.keterangan)) g.carries++; else g.originals++;
    g.paid += Number(r.dibayar || 0);
    g.rows.push(r.id);
    if (String(r[tglKey] || '') < String(g.tanggal || '9999')) g.tanggal = r[tglKey];
  }
  return [...map.values()].map(g => {
    // jumlah utang sebenarnya = jumlah baris asli (salinan tidak menambah utang baru)
    const count = Math.max(1, g.originals);
    const total = g.nominal * count;
    const dibayar = Math.min(g.paid, total);
    const sisa = Math.max(0, total - dibayar);
    return { ...g, count, total, dibayar, sisa, lunas: sisa <= 0, status: sisa <= 0 ? 'lunas' : 'belum' };
  }).sort((a, b) => String(a.tanggal || '').localeCompare(String(b.tanggal || '')) || a.base.localeCompare(b.base, 'id'));
}
/**
 * Agregasi piutang untuk SEMUA pegawai sekaligus (dipakai total laporan/neraca/dashboard).
 * Aturan sama seperti piutangBuckets: baris salinan "Saldo awal TA ..." tidak menambah utang baru.
 * `taId` (opsional) memfilter bucket yang punya baris pada tahun pelajaran tersebut.
 */
function piutangBucketsAll(kind, taId) {
  const isLain = kind === 'lain';
  const rows = isLain
    ? db.prepare(`SELECT p.id,p.nama nama,p.nominal,p.keterangan,p.tahun_ajaran_id,p.tanggal tgl,
        COALESCE((SELECT SUM(x.nominal) FROM piutang_lain_bayar x WHERE x.piutang_id=p.id),0) dibayar
      FROM piutang_lain p`).all()
    : db.prepare(`SELECT p.id,p.nama_pegawai nama,p.nominal,p.keterangan,p.tahun_ajaran_id,p.tanggal_utang tgl,
        COALESCE((SELECT SUM(x.nominal) FROM piutang_bayar x WHERE x.piutang_id=p.id),0) dibayar
      FROM piutang p`).all();
  const map = new Map();
  for (const r of rows) {
    const nama = String(r.nama || '').trim().toLowerCase();
    const base = stripCarryText(r.keterangan) || (isLain ? 'Piutang sertifikasi' : 'Piutang pegawai');
    const nominal = Math.round(Number(r.nominal) || 0);
    const key = nama + '|' + base.toLowerCase() + '|' + nominal;
    if (!map.has(key)) map.set(key, { nama, base, nominal, originals: 0, paid: 0, tanggal: r.tgl, taIds: new Set() });
    const g = map.get(key);
    if (isCarryText(r.keterangan)) { /* salinan: tidak menambah jumlah utang */ } else g.originals++;
    g.paid += Number(r.dibayar || 0);
    if (r.tahun_ajaran_id) g.taIds.add(Number(r.tahun_ajaran_id));
    if (String(r.tgl || '') < String(g.tanggal || '9999')) g.tanggal = r.tgl;
  }
  const out = [];
  for (const g of map.values()) {
    if (taId && !g.taIds.has(Number(taId))) continue;
    const count = Math.max(1, g.originals);
    const total = g.nominal * count;
    out.push({ ...g, taIds: undefined, count, total, dibayar: Math.min(g.paid, total), sisa: Math.max(0, total - Math.min(g.paid, total)) });
  }
  return out;
}
/** ringkasan total utang / dibayar / sisa + status akhir satu pegawai */
function piutangRingkasan(nama) {
  const ring = (kind) => {
    const list = piutangBuckets(kind, nama);
    return {
      list,
      aktif: list.filter(b => b.sisa > 0),
      lunas: list.filter(b => b.sisa <= 0),
      total: list.reduce((s, b) => s + b.total, 0),
      dibayar: list.reduce((s, b) => s + b.dibayar, 0),
      sisa: list.reduce((s, b) => s + b.sisa, 0)
    };
  };
  const umum = ring('umum'), lain = ring('lain');
  const sisa = umum.sisa + lain.sisa;
  return { umum, lain, sisa, status: sisa <= 0 ? 'lunas' : 'belum' };
}

function totalSaldoDana(tahunId) {
  // hanya BKU dana (buku pembantu/rekap otomatis tidak dihitung sebagai saldo dana)
  const list = allBku(tahunId);
  return list.reduce((s, b) => s + bkuSaldo(b.id), 0);
}


/* ================= ROLLOVER TAHUN AJARAN ================= */
/**
 * Pindahkan saldo akhir tahun ajaran sebelumnya menjadi saldo awal tahun ajaran baru.
 * - BKU: saldo_awal = saldo akhir BKU bernama sama di TA sebelumnya (buku pembantu otomatis = 0)
 * - Kas bank/tunai: saldo aset TA baru = kas riil akhir TA sebelumnya
 * - Akun pinjaman & aset lain: dibuat ulang dengan saldo = saldo akhir sebelumnya
 * - Piutang pegawai & piutang sertifikasi yang belum lunas: dicatat sebagai saldo awal (carry forward)
 */
/**
 * Salin daftar BKU dari tahun ajaran sebelumnya (nama, jenis, kode, urutan,
 * penanda buku pembantu otomatis). Saldo awal 0 — pengisian saldo dilakukan
 * oleh rolloverTa() bila opsi rollover dipilih.
 */
function cloneBkuTa(prevTaId, newTaId, opts = {}) {
  const prev = tahunById(prevTaId), next = tahunById(newTaId);
  if (!prev || !next || prev.id === next.id) return { bku: 0 };
  let n = 0;
  const ins = db.prepare(`INSERT INTO bku (nama,jenis,kode,tahun_ajaran_id,saldo_awal,status,urutan,created_at,auto_mode)
    VALUES (?,?,?,?,?,'aktif',?,?,?)`);
  db.transaction(() => {
    let urut = 0;
    for (const b of db.prepare('SELECT * FROM bku WHERE tahun_ajaran_id=? ORDER BY urutan, id').all(prev.id)) {
      urut++;
      const exist = db.prepare('SELECT id FROM bku WHERE tahun_ajaran_id=? AND nama=?').get(next.id, b.nama);
      if (exist) continue;
      ins.run(b.nama, b.jenis || 'umum', b.kode || '', next.id,
        Number(opts.saldo ? b.saldo_awal : 0) || 0, b.urutan || urut, nowStamp(), Number(b.auto_mode) ? 1 : 0);
      n++;
    }
  })();
  return { bku: n };
}

function rolloverTa(prevTaId, newTaId, user) {
  const prev = tahunById(prevTaId), next = tahunById(newTaId);
  if (!prev || !next || prev.id === next.id) return { bku: 0, aset: 0, piutang: 0, piutangLain: 0 };
  const { from } = taRange(next);
  let nBku = 0, nAset = 0, nPiu = 0, nPiuLain = 0, nPiuLainnya = 0;
  db.transaction(() => {
    // ---------- BKU ----------
    const insBku = db.prepare(`INSERT INTO bku (nama,jenis,kode,tahun_ajaran_id,saldo_awal,status,urutan,created_at,auto_mode)
      VALUES (?,?,?,?,?,'aktif',?,?,?)`);
    let urut = 1;
    for (const b of db.prepare('SELECT * FROM bku WHERE tahun_ajaran_id=? ORDER BY urutan, id').all(prev.id)) {
      const closing = Number(bkuSaldo(b.id)) || 0;
      const saldoAwal = Number(b.auto_mode) ? 0 : closing;
      const exist = db.prepare('SELECT * FROM bku WHERE tahun_ajaran_id=? AND nama=?').get(next.id, b.nama);
      if (exist) db.prepare('UPDATE bku SET saldo_awal=? WHERE id=?').run(saldoAwal, exist.id);
      else insBku.run(b.nama, b.jenis, b.kode, next.id, saldoAwal, b.urutan || urut, nowStamp(), Number(b.auto_mode) ? 1 : 0);
      nBku++;
      urut++;
    }

    // ---------- kas bank & tunai ----------
    const kasPrev = asetKas(prev.id);
    for (const [jenis, label, nilai] of [['bank', 'Kas Bank', kasPrev.bank], ['tunai', 'Kas Tunai', kasPrev.tunai]]) {
      const row = db.prepare('SELECT * FROM aset WHERE jenis=? AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL) ORDER BY id LIMIT 1').get(jenis, next.id);
      if (row && Number(row.tahun_ajaran_id || 0) === Number(next.id)) db.prepare('UPDATE aset SET saldo=? WHERE id=?').run(Number(nilai) || 0, row.id);
      else db.prepare("INSERT INTO aset (nama,jenis,saldo,keterangan,tahun_ajaran_id) VALUES (?,?,?,?,?)")
        .run(label, jenis, Number(nilai) || 0, 'Saldo awal dari tahun ajaran ' + (prev.nama || '-'), next.id);
      nAset++;
    }

    // ---------- akun pinjaman & aset lain ----------
    for (const a of db.prepare("SELECT * FROM aset WHERE jenis IN ('pinjaman','lain') AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL) ORDER BY id").all(prev.id)) {
      const lg = asetLedger(a.id, prev.id);
      const exist = db.prepare('SELECT id FROM aset WHERE jenis=? AND nama=? AND tahun_ajaran_id=?').get(a.jenis, a.nama, next.id);
      if (exist) {
        if (a.jenis === 'pinjaman') db.prepare('UPDATE aset SET saldo=0 WHERE id=?').run(exist.id);
        continue;
      }
      db.prepare('INSERT INTO aset (nama,jenis,saldo,keterangan,tahun_ajaran_id) VALUES (?,?,?,?,?)')
        .run(a.nama, a.jenis, a.jenis === 'pinjaman' ? 0 : lg.saldo,
          a.jenis === 'pinjaman' ? (a.keterangan || '') : 'Saldo awal dari tahun ajaran ' + (prev.nama || '-'), next.id);
      nAset++;
    }

    // ---------- piutang pegawai belum lunas ----------
    // keterangan memakai teks DASAR (prefix "Saldo awal TA ..." lama dibuang) agar tidak menumpuk
    // berlapis setiap rollover. Dedupe memakai (nama, teks dasar, nominal).
    const tag = `Saldo awal TA ${next.nama || ''}`.trim();
    const baseText = txt => stripCarryText(txt) || 'piutang pegawai';
    for (const p of db.prepare("SELECT * FROM piutang WHERE (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL) AND status='belum'").all(prev.id)) {
      const sisa = piutangSisa(p.id);
      if (!(sisa > 0)) continue;
      const teks = baseText(p.keterangan);
      const dup = db.prepare(`SELECT id FROM piutang WHERE tahun_ajaran_id=? AND lower(nama_pegawai)=lower(?)
          AND nominal=? AND lower(COALESCE(keterangan,''))=?`).get(next.id, p.nama_pegawai, sisa, teks.toLowerCase())
        || db.prepare(`SELECT id FROM piutang WHERE tahun_ajaran_id=? AND lower(nama_pegawai)=lower(?)
          AND nominal=? AND lower(COALESCE(keterangan,'')) LIKE ?`).get(next.id, p.nama_pegawai, sisa, (tag + ' — ' + teks).toLowerCase());
      if (dup) continue;
      db.prepare('INSERT INTO piutang (nama_pegawai,tanggal_utang,nominal,tanggal_bayar,status,bku_id,keterangan,created_at,tahun_ajaran_id) VALUES (?,?,?,NULL,\'belum\',?,?,?,?)')
        .run(p.nama_pegawai, from, sisa, p.bku_id || null, `${tag} — ${teks}`, nowStamp(), next.id);
      nPiu++;
    }

    // ---------- piutang sertifikasi belum lunas ----------
    for (const p of db.prepare("SELECT * FROM piutang_lain WHERE (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL) AND status='belum'").all(prev.id)) {
      const sisa = piutangLainSisa(p.id);
      if (!(sisa > 0)) continue;
      const teks = baseText(p.keterangan || 'piutang sertifikasi');
      const dup = db.prepare(`SELECT id FROM piutang_lain WHERE tahun_ajaran_id=? AND lower(nama)=lower(?)
          AND nominal=? AND lower(COALESCE(keterangan,''))=?`).get(next.id, p.nama, sisa, teks.toLowerCase());
      if (dup) continue;
      db.prepare('INSERT INTO piutang_lain (nama,kategori,tanggal,nominal,keterangan,status,tanggal_bayar,bku_id,created_at,tahun_ajaran_id) VALUES (?,?,?,?,?,\'belum\',NULL,?,?,?)')
        .run(p.nama, p.kategori || 'Sertifikasi', from, sisa, `${tag} — ${teks}`, p.bku_id || null, nowStamp(), next.id);
      nPiuLain++;
    }

    // ---------- piutang lainnya belum lunas (kategori fleksibel) ----------
    for (const p of db.prepare("SELECT * FROM piutang_lainnya WHERE (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL) AND status='belum'").all(prev.id)) {
      const sisa = piutangLainnyaSisa(p.id);
      if (!(sisa > 0)) continue;
      const teks = baseText(p.keterangan || 'piutang lainnya');
      const dup = db.prepare(`SELECT id FROM piutang_lainnya WHERE tahun_ajaran_id=? AND lower(nama)=lower(?)
          AND nominal=? AND lower(COALESCE(keterangan,''))=?`).get(next.id, p.nama, sisa, teks.toLowerCase());
      if (dup) continue;
      db.prepare(`INSERT INTO piutang_lainnya (kategori_id,nama,tanggal,nominal,keterangan,status,tanggal_bayar,bku_id,created_at,tahun_ajaran_id)
        VALUES (?,?,?,?,?,'belum',NULL,?,?,?)`)
        .run(p.kategori_id || null, p.nama, from, sisa, `${tag} — ${teks}`, p.bku_id || null, nowStamp(), next.id);
      nPiuLainnya++;
    }
  })();
  logAudit(user, 'ROLLOVER TA', 'tahun_ajaran',
    `Rollover ${prev.nama || prev.id} → ${next.nama || next.id}: ${nBku} BKU, ${nAset} akun aset, ${nPiu} piutang pegawai, ${nPiuLain} piutang sertifikasi, ${nPiuLainnya} piutang lainnya`);
  return { bku: nBku, aset: nAset, piutang: nPiu, piutangLain: nPiuLain, piutangLainnya: nPiuLainnya };
}

/** salin master pendukung dari TA sebelumnya ke TA baru (grup iuran + nominal, beasiswa) */
function cloneTaMaster(prevTaId, newTaId, opts = {}) {
  const prev = tahunById(prevTaId), next = tahunById(newTaId);
  if (!prev || !next || prev.id === next.id) return { grup: 0, nominal: 0, beasiswa: 0 };
  let nGrup = 0, nNom = 0, nBea = 0;
  db.transaction(() => {
    if (opts.grup !== false) {
      for (const g of db.prepare('SELECT * FROM iuran_grup WHERE tahun_ajaran_id=? ORDER BY nama').all(prev.id)) {
        const dup = db.prepare('SELECT id FROM iuran_grup WHERE tahun_ajaran_id=? AND lower(nama)=lower(?)').get(next.id, g.nama);
        if (dup) continue;
        const info = db.prepare('INSERT INTO iuran_grup (nama,jenis,tahun_ajaran_id,keterangan,aktif,created_at) VALUES (?,?,?,?,?,?)')
          .run(g.nama, g.jenis, next.id, g.keterangan || '', g.aktif, nowStamp());
        const gid = Number(info.lastInsertRowid);
        nGrup++;
        for (const n of db.prepare('SELECT * FROM iuran_nominal WHERE grup_id=?').all(g.id)) {
          db.prepare('INSERT OR REPLACE INTO iuran_nominal (grup_id,bulan,nominal) VALUES (?,?,?)').run(gid, n.bulan, n.nominal);
          nNom++;
        }
      }
    }
    if (opts.beasiswa !== false) {
      for (const b of db.prepare('SELECT * FROM beasiswa WHERE tahun_ajaran_id=?').all(prev.id)) {
        const dup = db.prepare('SELECT id FROM beasiswa WHERE tahun_ajaran_id=? AND lower(nama)=lower(?)').get(next.id, b.nama);
        if (dup) continue;
        db.prepare('INSERT INTO beasiswa (nama,nominal,tahun_ajaran_id,aktif,created_at) VALUES (?,?,?,?,?)')
          .run(b.nama, b.nominal, next.id, b.aktif, nowStamp());
        nBea++;
      }
    }
  })();
  logAudit(opts.user || null, 'SALIN MASTER TA', 'tahun_ajaran',
    `Salin master ${prev.nama || prev.id} → ${next.nama || next.id}: ${nGrup} grup iuran, ${nNom} nominal, ${nBea} beasiswa`);
  return { grup: nGrup, nominal: nNom, beasiswa: nBea };
}

/**
 * Kelulusan massal MANUAL: siswa kelas tingkat akhir (XII) pada TA tertentu di-set LULUS.
 * Sejak ronde 12 proses ini TIDAK lagi berjalan otomatis saat menambah/mengaktifkan tahun
 * pelajaran — harus dipilih manual (menu Data Siswa → ceklis → Penetapan Status Kelulusan,
 * atau tombol "Luluskan Kelas XII" di halaman Tahun Ajaran).
 */
function autoGraduateStudents(prevTaId, user) {
  const rows = prevTaId
    ? db.prepare(`SELECT s.id, s.nama, k.nama kelas_nama, k.tingkat FROM siswa s
        JOIN siswa_penempatan sp ON sp.siswa_id=s.id AND sp.tahun_ajaran_id=?
        JOIN kelas k ON k.id=sp.kelas_id
        WHERE s.status='aktif' ORDER BY k.nama, s.nama`).all(prevTaId)
        .filter(r => String(r.tingkat || '').trim() && tingkatNaik(r.tingkat) === '')
    : [];
  if (!rows.length) return { n: 0, siswa: [], sisa: 0 };
  let sisa = 0;
  db.transaction(() => {
    const upd = db.prepare("UPDATE siswa SET status='lulus', updated_at=? WHERE id=? AND status='aktif'");
    for (const r of rows) upd.run(nowStamp(), r.id);
    for (const r of rows) {
      const tags = db.prepare(`SELECT t.nominal, COALESCE((SELECT SUM(b.jumlah) FROM iuran_bayar b
          WHERE b.tagihan_id=t.id AND b.status<>'void'),0) paid
        FROM iuran_tagihan t WHERE t.siswa_id=? AND COALESCE(t.writeoff,'')=''`).all(r.id);
      sisa += tags.reduce((a, x) => a + Math.max(0, Number(x.nominal) - Number(x.paid)), 0);
    }
  })();
  logAudit(user || null, 'KELULUSAN OTOMATIS', 'siswa', `${rows.length} siswa kelas XII di-set LULUS (TA id ${prevTaId})`);
  return { n: rows.length, siswa: rows, sisa };
}

/* ================= PENUTUPAN BKU BULANAN (MONTHLY CLOSING) ================= */
const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function periodeOf(tanggal) { return String(tanggal || '').slice(0, 7); }
function periodeLabel(p) {
  if (!p || !/^\d{4}-\d{2}$/.test(p)) return p || '-';
  const [y, m] = p.split('-');
  return `${NAMA_BULAN[Number(m) - 1]} ${y}`;
}
function periodeStart(p) { return p + '-01'; }
function periodeEnd(p) {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${y}-${String(m).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function prevPeriode(p) {
  const [y, m] = p.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function currentPeriode() { return todayISO().slice(0, 7); }
/** tanggal ISO dengan pergeseran hari menurut jam WIB (mis. -1 = kemarin) */
function dateOffsetISO(days) {
  const d = new Date(Date.now() + (Number(days) || 0) * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function periodeRow(bkuId, periode) {
  return db.prepare('SELECT * FROM bku_periode WHERE bku_id=? AND periode=?').get(bkuId, periode);
}
/** status: 'ditutup' | 'dibuka' (re-open untuk koreksi) | 'terbuka' (bulan berjalan) | 'terlewat' (bulan lalu belum ditutup) */
function periodeStatus(bkuId, periode) {
  const row = periodeRow(bkuId, periode);
  if (row) return row.status;
  return periode < currentPeriode() ? 'terlewat' : 'terbuka';
}
/**
 * Cek kunci periode. HANYA periode yang sudah resmi DITUTUP yang memblokir input.
 * Bulan lalu yang belum ditutup ('terlewat') TIDAK lagi memblokir penambahan maupun
 * posting transaksi baru — pengguna boleh mencatat transaksi lalu menutup bulan tersebut
 * kapan saja (lihat menu Tutup BKU Bulanan). Untuk memposting ke bulan yang sudah
 * ditutup, buka kembali periodenya lebih dulu lewat tombol "Buka Kembali".
 * Parameter `mode` dipertahankan agar pemanggil lama tetap kompatibel.
 */
function periodeLockError(bkuId, tanggal, mode) {
  const p = periodeOf(tanggal);
  if (!/^\d{4}-\d{2}$/.test(p)) return null;
  const st = periodeStatus(bkuId, p);
  if (st === 'ditutup') {
    return `BKU bulan ${periodeLabel(p)} sudah ditutup. Transaksi pada periode tersebut terkunci — gunakan tombol "Buka Kembali" pada menu Tutup BKU Bulanan bila perlu memposting transaksi pada bulan itu.`;
  }
  return null;
}
function periodeEditable(bkuId, tanggal) { return periodeLockError(bkuId, tanggal) === null; }

/** Saldo awal bulan = saldo manual + penerimaan grup iuran + mutasi posted sebelum bulan tersebut */
function openingFor(bkuId, periode) {
  const b = db.prepare('SELECT * FROM bku WHERE id=?').get(bkuId);
  if (!b) return 0;
  const usesIuranSaldo = bkuUsesIuranSaldo(bkuId);
  const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN jenis='pengeluaran' THEN -nominal
      WHEN ?=1 AND COALESCE(is_penyesuaian,0)<>1 THEN 0 ELSE nominal END),0) d
    FROM transaksi WHERE bku_id=? AND status='posted' AND tanggal < ?`)
    .get(usesIuranSaldo ? 1 : 0, bkuId, periodeStart(periode));
  const source = Number(b.saldo_awal || 0)
    + (usesIuranSaldo ? bkuIuranReceived(bkuId, { before: periodeStart(periode) }) : 0)
    + (usesIuranSaldo && Number(b.pemasukan_saldo) === 1
      ? bkuRegularIncome(bkuId, { before: periodeStart(periode) }) : 0);
  return source + Number(r.d || 0);
}
function monthTotals(bkuId, periode) {
  const usesIuranSaldo = bkuUsesIuranSaldo(bkuId);
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN jenis='pemasukan' THEN nominal ELSE 0 END),0) masuk,
      COALESCE(SUM(CASE WHEN jenis='pengeluaran' THEN nominal ELSE 0 END),0) keluar
    FROM transaksi WHERE bku_id=? AND status='posted' AND tanggal BETWEEN ? AND ?`)
    .get(bkuId, periodeStart(periode), periodeEnd(periode));
  const masuk = usesIuranSaldo
    ? bkuIuranReceived(bkuId, { from: periodeStart(periode), to: periodeEnd(periode) })
      + Number(db.prepare(`SELECT COALESCE(SUM(nominal),0) masuk FROM transaksi
        WHERE bku_id=? AND status='posted' AND jenis='pemasukan' AND COALESCE(is_penyesuaian,0)=1
          AND tanggal BETWEEN ? AND ?`).get(bkuId, periodeStart(periode), periodeEnd(periode)).masuk || 0)
      + (bkuIncomeEnabled(bkuId)
        ? bkuRegularIncome(bkuId, { from: periodeStart(periode), to: periodeEnd(periode) }) : 0)
    : Number(r.masuk || 0);
  return { masuk, keluar: Number(r.keluar || 0) };
}
/** posisi buku satu BKU pada akhir periode tertentu */
function periodePosisi(bkuId, periode) {
  const saldoAwal = openingFor(bkuId, periode);
  const t = monthTotals(bkuId, periode);
  return { saldoAwal, masuk: t.masuk, keluar: t.keluar, saldoBuku: saldoAwal + t.masuk - t.keluar, periode };
}

function removePeriodAdjustment(bkuId, periode, user, reason) {
  const closing = periodeRow(bkuId, periode);
  if (!closing) return 0;
  const rows = db.prepare(`SELECT * FROM transaksi
    WHERE bku_id=? AND is_penyesuaian=1 AND status<>'void'
      AND (periode_penyesuaian=? OR id=?)`)
    .all(bkuId, periode, closing.transaksi_penyesuaian_id || 0);
  for (const row of rows) {
    trashAdd('transaksi', row, {
      user,
      alasan: reason || `Penyesuaian opnam periode ${periodeLabel(periode)} dibuka kembali`,
      label: `${row.no_bukti || 'Penyesuaian opnam'} — ${row.uraian || ''}`
    });
    db.prepare('DELETE FROM transaksi WHERE id=?').run(row.id);
  }
  if (closing.transaksi_penyesuaian_id || rows.length) {
    db.prepare('UPDATE bku_periode SET transaksi_penyesuaian_id=NULL WHERE id=?').run(closing.id);
  }
  return rows.length;
}

/** Daftar BKU x periode yang punya transaksi tapi belum ditutup (untuk notifikasi) */
function unclosedPeriods(tahunId) {
  const cur = currentPeriode();
  let sql = `SELECT b.id bku_id, b.nama bku_nama, substr(t.tanggal,1,7) periode, COUNT(*) jumlah,
      MIN(t.tanggal) tgl_awal, MAX(t.tanggal) tgl_akhir
    FROM transaksi t JOIN bku b ON b.id=t.bku_id
    WHERE t.status='posted' AND substr(t.tanggal,1,7) < ? AND COALESCE(b.auto_mode,0)=0`;
  const args = [cur];
  if (tahunId) { sql += ' AND b.tahun_ajaran_id=?'; args.push(tahunId); }
  sql += ' GROUP BY b.id, substr(t.tanggal,1,7) ORDER BY periode, b.urutan';
  const rows = db.prepare(sql).all(...args);
  return rows.filter(r => {
    const st = periodeStatus(r.bku_id, r.periode);
    return st === 'terlewat' || st === 'dibuka';
  }).map(r => ({ ...r, status: periodeStatus(r.bku_id, r.periode) }));
}

/**
 * Tutup BKU satu periode.
 * opts: { metode: 'rollover'|'opnam', opnam_tunai, opnam_bank, alasan, metode_penyesuaian, berita_acara_no }
 */
function closePeriode(bkuId, periode, opts, user) {
  const b = db.prepare('SELECT * FROM bku WHERE id=?').get(bkuId);
  if (!b) throw new Error('BKU tidak ditemukan.');
  if (b.status !== 'aktif') throw new Error(`BKU "${b.nama}" sudah ditutup secara keseluruhan, tidak dapat menutup periode bulanan.`);
  removePeriodAdjustment(bkuId, periode, user,
    `Penyesuaian opnam lama diarsipkan saat periode ${periodeLabel(periode)} ditutup ulang`);
  const pos = periodePosisi(bkuId, periode);
  const metode = opts.metode === 'opnam' ? 'opnam' : 'rollover';
  let opnamTunai = null, opnamBank = null, selisih = 0, adjId = null, alasan = '';
  const metodePenyesuaian = opts.metode_penyesuaian === 'transfer' ? 'transfer' : 'tunai';

  if (metode === 'opnam') {
    opnamTunai = Math.round(parseMoney(opts.opnam_tunai) || 0);
    opnamBank = Math.round(parseMoney(opts.opnam_bank) || 0);
    selisih = (opnamTunai + opnamBank) - pos.saldoBuku;
    if (Math.abs(selisih) >= 1) {
      alasan = String(opts.alasan || '').trim();
      if (!alasan) throw new Error('Alasan/keterangan selisih kas wajib diisi.');
      const kodeCoa = selisih > 0 ? '9.2.01' : '9.2.02';
      const coa = db.prepare('SELECT * FROM coa WHERE kode=?').get(kodeCoa);
      const seq = db.prepare('SELECT COUNT(*) c FROM transaksi WHERE bku_id=?').get(bkuId).c + 1;
      const noBukti = `${b.kode || 'BKU'}/ADJ/${periode.replace('-', '')}/${String(seq).padStart(3, '0')}`;
      const uraian = `${selisih > 0 ? 'Selisih Kas Lebih' : 'Selisih Kas Kurang'} (opnam kas ${periodeLabel(periode)}) — ${alasan}`;
      const info = db.prepare(`INSERT INTO transaksi
        (bku_id,tanggal,jenis,metode,no_bukti,coa_id,nominal,uraian,nama_pihak,status,is_penyesuaian,periode_penyesuaian,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'posted',1,?,?,?)`)
        .run(bkuId, periodeEnd(periode), selisih > 0 ? 'pemasukan' : 'pengeluaran', metodePenyesuaian, noBukti,
          coa ? coa.id : null, Math.abs(selisih), uraian, 'Penyesuaian Opnam Kas', periode, user ? user.id : null, nowStamp());
      adjId = Number(info.lastInsertRowid);
    } else {
      alasan = String(opts.alasan || '').trim();
    }
  }

  const saldoAkhir = pos.saldoBuku + selisih;
  const status = opts.status === 'dibuka' ? 'dibuka' : 'ditutup';
  const baNo = opts.berita_acara_no || `BA-OPNAM/${b.kode || 'BKU'}/${periode.replace('-', '')}`;
  db.prepare(`INSERT INTO bku_periode
      (bku_id,periode,saldo_awal,total_masuk,total_keluar,saldo_buku,saldo_akhir,metode,opnam_tunai,opnam_bank,
       selisih,alasan,metode_penyesuaian,transaksi_penyesuaian_id,status,berita_acara_no,ditutup_at,ditutup_oleh)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(bku_id,periode) DO UPDATE SET
        saldo_awal=excluded.saldo_awal, total_masuk=excluded.total_masuk, total_keluar=excluded.total_keluar,
        saldo_buku=excluded.saldo_buku, saldo_akhir=excluded.saldo_akhir, metode=excluded.metode,
        opnam_tunai=excluded.opnam_tunai, opnam_bank=excluded.opnam_bank, selisih=excluded.selisih,
        alasan=excluded.alasan, metode_penyesuaian=excluded.metode_penyesuaian,
        transaksi_penyesuaian_id=excluded.transaksi_penyesuaian_id, status=excluded.status,
        berita_acara_no=excluded.berita_acara_no, ditutup_at=excluded.ditutup_at, ditutup_oleh=excluded.ditutup_oleh`)
    .run(bkuId, periode, pos.saldoAwal, pos.masuk, pos.keluar, pos.saldoBuku, saldoAkhir, metode,
      opnamTunai, opnamBank, selisih, alasan, metode === 'opnam' ? metodePenyesuaian : null, adjId, status,
      baNo, nowStamp(), user ? user.nama : 'system');

  logAudit(user, 'TUTUP BULAN', 'tutup_bulanan',
    `Tutup BKU ${b.nama} periode ${periodeLabel(periode)} — metode ${metode === 'opnam' ? 'Penyesuaian Kas Riil (opnam)' : 'Rollover saldo buku'}; ` +
    `saldo buku ${rpFull(pos.saldoBuku)}, selisih ${rpFull(selisih)}, saldo awal bulan berikutnya ${rpFull(saldoAkhir)}` +
    (alasan ? `; alasan: ${alasan}` : ''));
  if (Math.abs(selisih) >= 1) {
    logAudit(user, 'SELISIH KAS', 'tutup_bulanan',
      `Selisih kas ${selisih > 0 ? 'LEBIH' : 'KURANG'} ${rpFull(Math.abs(selisih))} pada ${b.nama} periode ${periodeLabel(periode)} ` +
      `(buku ${rpFull(pos.saldoBuku)} vs kas riil ${rpFull(opnamTunai + opnamBank)}) — alasan: ${alasan}`);
  }
  return { pos, metode, opnamTunai, opnamBank, selisih, saldoAkhir, adjId, berita_acara_no: baNo, status };
}

function rpFull(n) { return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID'); }

/* daftar periode (bulan) yang punya transaksi pada satu BKU */
function periodeListOf(bkuId) {
  return db.prepare(`SELECT substr(tanggal,1,7) periode, COUNT(*) n FROM transaksi
    WHERE bku_id=? AND status='posted' GROUP BY substr(tanggal,1,7) ORDER BY periode DESC`).all(bkuId);
}

/* ================= PEGAWAI & PAYROLL ================= */
function pegawaiList(aktifOnly) {
  return aktifOnly
    ? db.prepare('SELECT * FROM pegawai WHERE aktif=1 ORDER BY tipe, nama').all()
    : db.prepare('SELECT * FROM pegawai ORDER BY tipe, nama').all();
}
/** tarif standar 1 jam tugas tambahan (Pembantu Kepsek / Wali Kelas) — bisa diubah di Identitas Sekolah */
function sertifikasiJam() {
  const v = Number(getSetting('sertifikasi_per_jam', '12500'));
  return v > 0 ? v : 12500;
}
function honorTugasJam() {
  const v = Number(getSetting('honor_tugas_jam', '50000'));
  return v > 0 ? v : 50000;
}
/** tarif per jam Pembantu Kepsek (fallback ke tarif tugas tambahan lama) */
function honorPembantuJam() {
  const v = Number(getSetting('honor_pembantu_jam', '') || getSetting('honor_tugas_jam', '50000'));
  return v > 0 ? v : 50000;
}
/** tarif per jam Wali Kelas (fallback ke tarif tugas tambahan lama) */
function honorWaliJam() {
  const v = Number(getSetting('honor_wali_jam', '') || getSetting('honor_tugas_jam', '50000'));
  return v > 0 ? v : 50000;
}
/** hitung seluruh komponen honor satu baris leger */
/* ==================================================================
   LEGER HONOR DINAMIS — kolom penerimaan/potongan yang bisa diatur sekolah
   ------------------------------------------------------------------
   · payroll_kolom : definisi kolom (label, tipe penerimaan/potongan/info,
                     satuan uang/jam, rumus opsional, urutan, aktif)
   · payroll_nilai : nilai isian kolom NON-bawaan per baris leger
   Kolom bawaan memakai kolom lama pada tabel `payroll` supaya fitur kasbon,
   posting BKU, dan slip gaji tetap bekerja. Rumus dihitung aman (tanpa eval).
   ================================================================== */
const PAYROLL_DEFAULT_COLS = [
  { kode: 'jam_efektif', label: 'Jam Efektif', tipe: 'info', nilai: 'jam', urutan: 10, sistem: 1 },
  { kode: 'jam_telat', label: 'Jam Telat', tipe: 'info', nilai: 'jam', urutan: 20, sistem: 1 },
  { kode: 'honor_jam', label: 'Honor / Jam', tipe: 'info', nilai: 'uang', urutan: 30, sistem: 1 },
  { kode: 'honor_mengajar', label: 'Honor Mengajar', tipe: 'penerimaan', nilai: 'uang', rumus: 'jam_efektif * honor_jam', urutan: 40, sistem: 1 },
  { kode: 'tunjangan_jabatan', label: 'Tunj. Jabatan', tipe: 'penerimaan', nilai: 'uang', urutan: 50 },
  { kode: 'tunjangan_masa_kerja', label: 'Tunj. Masa Kerja', tipe: 'penerimaan', nilai: 'uang', urutan: 60 },
  { kode: 'lembur', label: 'Lembur', tipe: 'penerimaan', nilai: 'uang', urutan: 70 },
  { kode: 'tambahan_penghasilan', label: 'Tamb. Penghasilan', tipe: 'penerimaan', nilai: 'uang', urutan: 80 },
  { kode: 'tunjangan_khusus', label: 'Tunj. Khusus', tipe: 'penerimaan', nilai: 'uang', urutan: 90 },
  { kode: 'jam_pembantu_kepsek', label: 'Pembantu Kepsek (jam)', tipe: 'info', nilai: 'jam', urutan: 100 },
  { kode: 'pembantu_kepsek', label: 'Honor Pembantu Kepsek', tipe: 'penerimaan', nilai: 'uang', rumus: 'jam_pembantu_kepsek * honor_pembantu', urutan: 110, sistem: 1 },
  { kode: 'jam_wali_kelas', label: 'Wali Kelas (jam)', tipe: 'info', nilai: 'jam', urutan: 120 },
  { kode: 'wali_kelas', label: 'Honor Wali Kelas', tipe: 'penerimaan', nilai: 'uang', rumus: 'jam_wali_kelas * honor_wali', urutan: 130, sistem: 1 },
  { kode: 'pot_telat', label: 'Pot. Telat 75%', tipe: 'potongan', nilai: 'uang', rumus: 'jam_telat * 0.75 * honor_jam', urutan: 140, sistem: 1 },
  { kode: 'pot_dana_sosial', label: 'Dana Sosial', tipe: 'potongan', nilai: 'uang', urutan: 150 },
  { kode: 'pot_bpjs_kes', label: 'BPJS Kesehatan', tipe: 'potongan', nilai: 'uang', urutan: 160 },
  { kode: 'pot_bpjs_tk', label: 'BPJS Tenaga Kerja', tipe: 'potongan', nilai: 'uang', urutan: 170 },
  { kode: 'jam_sertifikasi', label: 'Sertifikasi (jam)', tipe: 'info', nilai: 'jam', urutan: 180 },
  { kode: 'pot_sertifikasi', label: 'Penyesuaian Sertifikasi', tipe: 'potongan', nilai: 'uang', rumus: 'jam_sertifikasi * sertifikasi_rate', urutan: 190, sistem: 1 },
  { kode: 'pot_kasbon', label: 'Kasbon', tipe: 'potongan', nilai: 'uang', urutan: 200 }
];
/** kolom lama pada tabel `payroll` yang menjadi tempat penyimpanan nilai */
const PAYROLL_LEGACY = new Set(['jam_efektif', 'jam_telat', 'honor_jam', 'tunjangan_jabatan', 'tunjangan_masa_kerja',
  'lembur', 'tambahan_penghasilan', 'tunjangan_khusus', 'jam_pembantu_kepsek', 'jam_wali_kelas',
  'jam_sertifikasi', 'pot_dana_sosial', 'pot_bpjs_kes', 'pot_bpjs_tk', 'pot_kasbon']);

function seedPayrollColumns() {
  const n = db.prepare('SELECT COUNT(*) c FROM payroll_kolom').get().c;
  if (n) return;
  const ins = db.prepare(`INSERT OR IGNORE INTO payroll_kolom (kode,label,tipe,nilai,rumus,urutan,sistem,aktif,created_at)
    VALUES (?,?,?,?,?,?,?,1,?)`);
  for (const c of PAYROLL_DEFAULT_COLS) ins.run(c.kode, c.label, c.tipe, c.nilai, c.rumus || '', c.urutan, c.sistem || 0, nowStamp());
}

function payrollKolomList(opts = {}) {
  const sql = 'SELECT * FROM payroll_kolom' + (opts.all ? '' : ' WHERE aktif=1') + ' ORDER BY urutan, id';
  return db.prepare(sql).all();
}
function payrollKolomById(id) { return id ? db.prepare('SELECT * FROM payroll_kolom WHERE id=?').get(Number(id)) || null : null; }
function payrollKolomByKode(kode) { return db.prepare('SELECT * FROM payroll_kolom WHERE kode=?').get(String(kode || '')) || null; }
function kodeSlug(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'kolom';
}
/**
 * Simpan/perbarui satu kolom leger.
 * · id kosong → kolom baru (kode dibuat dari label, wajib unik)
 * · id ada    → ubah label/tipe/satuan/rumus/urutan (kode & sistem dipertahankan)
 */
function payrollKolomSave(data) {
  const label = String(data.label || '').trim();
  if (!label) throw new Error('Nama kolom wajib diisi.');
  const tipe = ['penerimaan', 'potongan', 'info'].includes(String(data.tipe)) ? String(data.tipe) : 'penerimaan';
  const nilai = String(data.nilai) === 'jam' ? 'jam' : 'uang';
  const rumus = String(data.rumus || '').trim();
  if (rumus) {
    try { payrollFormulaTest(rumus); } catch (e) { throw new Error('Rumus tidak valid: ' + e.message); }
  }
  const urut = Number(data.urutan);
  if (data.id && payrollKolomById(data.id)) {
    const cur = payrollKolomById(data.id);
    if (cur.sistem && tipe !== cur.tipe) throw new Error('Tipe kolom bawaan tidak dapat diubah.');
    db.prepare('UPDATE payroll_kolom SET label=?,tipe=?,nilai=?,rumus=?,urutan=?,aktif=? WHERE id=?')
      .run(label, cur.sistem ? cur.tipe : tipe, cur.sistem ? cur.nilai : nilai, rumus,
        Number.isFinite(urut) ? urut : cur.urutan, data.aktif === undefined ? cur.aktif : (data.aktif ? 1 : 0), cur.id);
    return payrollKolomById(cur.id);
  }
  let kode = kodeSlug(data.kode || label);
  if (payrollKolomByKode(kode) || PAYROLL_LEGACY.has(kode)) kode = kode + '_' + Date.now().toString(36).slice(-4);
  const info = db.prepare(`INSERT INTO payroll_kolom (kode,label,tipe,nilai,rumus,urutan,sistem,aktif,created_at)
    VALUES (?,?,?,?,?,?,0,?,?)`).run(kode, label, tipe, nilai, rumus, Number.isFinite(urut) ? urut : 1000, data.aktif === false ? 0 : 1, nowStamp());
  return payrollKolomById(Number(info.lastInsertRowid));
}
function payrollKolomDelete(id) {
  const row = payrollKolomById(id);
  if (!row) return null;
  if (row.sistem) throw new Error('Kolom bawaan tidak dapat dihapus — ubah nama atau nonaktifkan saja.');
  // histori lama tidak dihapus: nilai tetap tersimpan di payroll_nilai (hanya kolomnya yang hilang dari tampilan)
  db.prepare('DELETE FROM payroll_kolom WHERE id=?').run(row.id);
  return row;
}
function payrollKolomReorder(ids) {
  const upd = db.prepare('UPDATE payroll_kolom SET urutan=? WHERE id=?');
  ids.forEach((id, i) => upd.run((i + 1) * 10, Number(id)));
  return ids.length;
}

/* ---------------- evaluator rumus (aman, tanpa eval) ---------------- */
function payrollFormulaTest(expr) {
  return payrollEval(expr, {});
}
function payrollEval(expr, vars) {
  const src = String(expr || '').replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  function number() {
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error('angka diharapkan pada posisi ' + (i + 1));
    i += m[0].length;
    return Number(m[0]);
  }
  function factor() {
    if (peek() === '(') {
      i++;
      const v = additive();
      if (peek() !== ')') throw new Error('kurung tutup hilang');
      i++;
      return v;
    }
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (/[0-9.]/.test(peek() || '')) return number();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) throw new Error('tanda tidak dikenal pada posisi ' + (i + 1));
    i += m[0].length;
    const name = m[0];
    if (peek() === '(') {
      i++;
      const args = [];
      if (peek() !== ')') {
        for (;;) {
          args.push(additive());
          if (peek() === ',') { i++; continue; }
          break;
        }
      }
      if (peek() !== ')') throw new Error('kurung tutup hilang pada fungsi ' + name);
      i++;
      if (name === 'round') return Math.round(args[0] || 0);
      if (name === 'min') return Math.min(...args);
      if (name === 'max') return Math.max(...args);
      if (name === 'abs') return Math.abs(args[0] || 0);
      throw new Error('fungsi ' + name + ' tidak dikenal');
    }
    const v = vars[name];
    if (v === undefined) throw new Error('variabel "' + name + '" tidak dikenal');
    return Number(v) || 0;
  }
  function multiplicative() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = factor();
      v = op === '*' ? v * r : (r === 0 ? 0 : v / r);
    }
    return v;
  }
  function additive() {
    let v = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = multiplicative();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  if (!src) return 0;
  const out = additive();
  if (i !== src.length) throw new Error('sisa ekspresi tidak terbaca pada posisi ' + (i + 1));
  return out;
}

/** nilai isian dinamis satu periode: { payroll_id: { kode: nilai } } */
function payrollNilaiMap(periode) {
  const map = new Map();
  let rows = [];
  try {
    rows = db.prepare(`SELECT n.payroll_id, n.kolom_kode, n.nilai FROM payroll_nilai n
      JOIN payroll p ON p.id=n.payroll_id WHERE p.periode=?`).all(periode);
  } catch (e) { rows = []; }
  for (const r of rows) {
    if (!map.has(r.payroll_id)) map.set(r.payroll_id, {});
    map.get(r.payroll_id)[r.kolom_kode] = Number(r.nilai) || 0;
  }
  return map;
}
/** hitung nilai semua kolom untuk satu baris leger */
function payrollCompute(row, values, cols) {
  const vars = {
    honor_pembantu: honorPembantuJam(),
    honor_wali: honorWaliJam(),
    sertifikasi_rate: sertifikasiJam()
  };
  // 1) nilai awal: kolom bawaan dari tabel payroll, sisanya dari payroll_nilai
  for (const c of cols) {
    const legacy = PAYROLL_LEGACY.has(c.kode) ? row[c.kode] : undefined;
    vars[c.kode] = Number(legacy !== undefined ? legacy : (values[c.kode] || 0)) || 0;
  }
  // 2) kolom berumus dihitung (beberapa lintasan agar rumus bisa saling rujuk)
  const computed = {};
  for (let pass = 0; pass < 3; pass++) {
    for (const c of cols) {
      if (!c.rumus) continue;
      try { vars[c.kode] = Math.round(payrollEval(c.rumus, vars) * 100) / 100; } catch (e) { vars[c.kode] = 0; }
      computed[c.kode] = true;
    }
  }
  // 3) total
  let penerimaan = 0, potongan = 0;
  for (const c of cols) {
    const v = Number(vars[c.kode]) || 0;
    if (c.tipe === 'penerimaan') penerimaan += v;
    else if (c.tipe === 'potongan') potongan += v;
  }
  penerimaan = Math.round(penerimaan); potongan = Math.round(potongan);
  return { vals: vars, computed, penerimaan, potongan, diterima: penerimaan - potongan };
}
/** data leger dinamis satu periode + total per kolom (mengikuti urutan kolom) */
function payrollDynamic(periode) {
  const cols = payrollKolomList();
  const rows = db.prepare(`SELECT * FROM payroll WHERE periode=?
      ORDER BY CASE WHEN COALESCE(urutan,0)=0 THEN id ELSE urutan END, id`).all(periode);
  const nilai = payrollNilaiMap(periode);
  const perKode = {};
  for (const c of cols) perKode[c.kode] = 0;
  let penerimaan = 0, potongan = 0;
  const pos = v => Math.max(0, Number(v) || 0);   // nilai minus TIDAK mengurangi grand total
  const out = rows.map(r => {
    const d = payrollCompute(r, nilai.get(r.id) || {}, cols);
    for (const c of cols) perKode[c.kode] += pos(d.vals[c.kode]);
    penerimaan += pos(d.penerimaan); potongan += pos(d.potongan);
    return Object.assign({}, r, {
      din: d.vals, dinComputed: d.computed,
      penerimaanDinamis: d.penerimaan, potonganDinamis: d.potongan, diterimaDinamis: d.diterima
    });
  });
  return {
    cols, rows: out, totals: { perKode, penerimaan, potongan, diterima: penerimaan - potongan, n: out.length }
  };
}
/** simpan nilai dinamis satu baris (dipanggil handler /payroll/simpan) */
function payrollNilaiSet(payrollId, kode, value) {
  db.prepare(`INSERT INTO payroll_nilai (payroll_id,kolom_kode,nilai) VALUES (?,?,?)
    ON CONFLICT(payroll_id,kolom_kode) DO UPDATE SET nilai=excluded.nilai`).run(payrollId, String(kode), Number(value) || 0);
}

function payrollCalc(r) {
  const n = v => Number(v) || 0;
  const rate = honorPembantuJam();
  const rateWali = honorWaliJam();
  const jamEfektif = n(r.jam_efektif), jamTelat = n(r.jam_telat), honorJam = n(r.honor_jam);
  const honorMengajar = Math.round(jamEfektif * honorJam);
  const potTelat = Math.round(jamTelat * 0.75 * honorJam);
  // tugas tambahan = 2 komponen terpisah, otomatis jam × tarif standar
  const jamPembantu = n(r.jam_pembantu_kepsek), jamWali = n(r.jam_wali_kelas);
  const pembantuKepsek = Math.round(jamPembantu * rate);
  const waliKelas = Math.round(jamWali * rateWali);
  const penerimaan = honorMengajar + n(r.tunjangan_jabatan) + n(r.tunjangan_masa_kerja) + n(r.lembur)
    + n(r.tambahan_penghasilan) + n(r.tunjangan_khusus) + pembantuKepsek + waliKelas;
  // sertifikasi: INPUT HANYA JAM; nominal = jam × tarif per jam dari Pengaturan Sistem
  const sertRate = sertifikasiJam();
  const jamSertifikasi = n(r.jam_sertifikasi);
  const sertifikasiAuto = Math.round(jamSertifikasi * sertRate);
  const sertifikasi = sertifikasiAuto;
  const potongan = potTelat + n(r.pot_dana_sosial) + n(r.pot_bpjs_kes) + n(r.pot_bpjs_tk)
    + sertifikasi + n(r.pot_kasbon);
  return {
    honorMengajar, potTelat, penerimaan, potongan,
    honorTugasJam: rate, honorWaliJam: rateWali, pembantuKepsek, waliKelas,
    jamSertifikasi, sertifikasi, sertifikasiAuto, sertifikasiJam: sertRate,
    diterima: penerimaan - potongan
  };
}
function payrollRows(periode) {
  // urutan = urutan input/import (DILARANG di-sort abjad); baris tanpa urutan memakai id
  const rows = db.prepare(`SELECT * FROM payroll WHERE periode=?
      ORDER BY CASE WHEN COALESCE(urutan,0)=0 THEN id ELSE urutan END, id`).all(periode)
    .map(r => ({ ...r, ...payrollCalc(r) }));
  // kolom dinamis: total penerimaan/potongan/diterima mengikuti definisi kolom sekolah
  let dyn = null;
  try { dyn = payrollDynamic(periode); } catch (e) { dyn = null; }
  if (!dyn) return rows;
  const map = new Map(dyn.rows.map(r => [r.id, r]));
  return rows.map(r => {
    const d = map.get(r.id);
    if (!d) return r;
    return {
      ...r, din: d.din, dinComputed: d.dinComputed,
      penerimaan: d.penerimaanDinamis, potongan: d.potonganDinamis, diterima: d.diterimaDinamis
    };
  });
}
function payrollTotals(periode) {
  const rows = payrollRows(periode);
  /* Nilai MINUS tetap tampil apa adanya pada baris/kolom rincian pegawai, tetapi
     TIDAK boleh mengurangi grand total. Setiap kontribusi baris di-clamp ke 0
     sebelum dijumlahkan (Math.max(0, nilai)). */
  const pos = v => Math.max(0, Number(v) || 0);
  const sum = k => rows.reduce((s, r) => s + pos(r[k]), 0);
  const guru = rows.filter(r => r.tipe === 'guru'), tu = rows.filter(r => r.tipe !== 'guru');
  return {
    rows, n: rows.length,
    /* total baris negatif diabaikan (informasi saja, dipakai UI sebagai catatan) */
    barisMinus: rows.filter(r => Number(r.diterima) < 0).length,
    guru: { n: guru.length, honor: guru.reduce((s, r) => s + pos(r.honorMengajar), 0), diterima: guru.reduce((s, r) => s + pos(r.diterima), 0) },
    tu: { n: tu.length, honor: tu.reduce((s, r) => s + pos(r.honorMengajar), 0), diterima: tu.reduce((s, r) => s + pos(r.diterima), 0) },
    penerimaan: sum('penerimaan'), potongan: sum('potongan'), diterima: sum('diterima'),
    potTelat: sum('potTelat'),
    danaSosial: sum('pot_dana_sosial'), bpjsKes: sum('pot_bpjs_kes'), bpjsTk: sum('pot_bpjs_tk'),
    sertifikasi: sum('sertifikasi'), kasbon: sum('pot_kasbon'),
    tunjanganJabatan: sum('tunjangan_jabatan'), masaKerja: sum('tunjangan_masa_kerja'),
    lembur: sum('lembur'), tambahan: sum('tambahan_penghasilan'), khusus: sum('tunjangan_khusus'),
    pembantuKepsek: sum('pembantuKepsek'), waliKelas: sum('waliKelas'),
    jamPembantu: sum('jam_pembantu_kepsek'), jamWali: sum('jam_wali_kelas'),
    jamSertifikasi: sum('jam_sertifikasi'),
    tugasTambahan: sum('tugas_tambahan')
  };
}
/**
 * Status posting sebuah periode leger honor.
 * Bila transaksi BKU terkait sudah dihapus / di-void, leger OTOMATIS terbuka kembali
 * (draf bisa diedit & diposting ulang) — kuncian hanya berlaku selama BKU masih memuat transaksinya.
 */
function payrollPost(periode) {
  const row = db.prepare('SELECT * FROM payroll_post WHERE periode=?').get(periode);
  if (!row) return null;
  if (row.trx_umum_id) {
    const t = db.prepare('SELECT status FROM transaksi WHERE id=?').get(row.trx_umum_id);
    if (!t || t.status === 'void') {
      db.prepare('DELETE FROM payroll_post WHERE periode=?').run(periode);
      return null;
    }
  }
  return row;
}
/** buka kuncian leger yang transaksi BKU-nya baru saja dihapus (dipanggil dari modul transaksi) */
function payrollUnlockByTrx(trxId) {
  const id = Number(trxId) || 0;
  if (!id) return [];
  const rows = db.prepare('SELECT periode FROM payroll_post WHERE trx_umum_id=? OR trx_dana_sosial_id=?').all(id, id);
  if (rows.length) db.prepare('DELETE FROM payroll_post WHERE trx_umum_id=? OR trx_dana_sosial_id=?').run(id, id);
  return rows.map(r => r.periode);
}
/** status draf leger (mode kasbon otomatis/manual, riwayat penerapan) */
function payrollDraft(periode) {
  return db.prepare('SELECT * FROM payroll_draft WHERE periode=?').get(periode)
    || { periode, kasbon_auto: 1, kasbon_at: null, kasbon_by: null, kasbon_total: 0, catatan: '' };
}
function payrollDraftSet(periode, patch = {}) {
  const next = { ...payrollDraft(periode), ...patch };
  db.prepare(`INSERT INTO payroll_draft (periode,kasbon_auto,kasbon_at,kasbon_by,kasbon_total,catatan,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(periode) DO UPDATE SET kasbon_auto=excluded.kasbon_auto, kasbon_at=excluded.kasbon_at,
        kasbon_by=excluded.kasbon_by, kasbon_total=excluded.kasbon_total, catatan=excluded.catatan, updated_at=excluded.updated_at`)
    .run(periode, next.kasbon_auto ? 1 : 0, next.kasbon_at || null, next.kasbon_by || null,
      Number(next.kasbon_total) || 0, next.catatan || '', nowStamp());
  return payrollDraft(periode);
}
/** seluruh periode yang punya draf leger / sudah pernah diposting (untuk dropdown periode) */
function payrollPeriods() {
  return db.prepare('SELECT periode FROM payroll UNION SELECT periode FROM payroll_post ORDER BY periode DESC')
    .all().map(r => r.periode);
}
/**
 * Salin isian leger dari bulan sebelumnya ke periode tujuan.
 * URUTAN NAMA 100% mengikuti periode sumber (urutan kolom `urutan`), tanpa sort abjad.
 * Pegawai yang sudah ada di periode tujuan dilewati (tidak diduplikasi).
 */
function payrollCopyPrev(periode) {
  const prev = prevPeriode(periode);
  const src = db.prepare(`SELECT * FROM payroll WHERE periode=?
      ORDER BY CASE WHEN COALESCE(urutan,0)=0 THEN id ELSE urutan END, id`).all(prev);
  if (!src.length) return { copied: 0, skipped: 0, prev };
  let copied = 0, skipped = 0;
  db.transaction(() => {
    let urut = Number(db.prepare('SELECT COALESCE(MAX(urutan),0) m FROM payroll WHERE periode=?').get(periode).m) || 0;
    const ins = db.prepare(`INSERT INTO payroll (periode,pegawai_id,nama,jabatan,tipe,jam_efektif,jam_telat,
        jam_pembantu_kepsek,jam_wali_kelas,jam_sertifikasi,honor_jam,tunjangan_jabatan,tunjangan_masa_kerja,
        lembur,tambahan_penghasilan,tunjangan_khusus,pot_dana_sosial,pot_bpjs_kes,pot_bpjs_tk,
        pot_sertifikasi,pot_kasbon,catatan,urutan,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of src) {
      const dup = r.pegawai_id
        ? db.prepare('SELECT id FROM payroll WHERE periode=? AND pegawai_id=?').get(periode, r.pegawai_id)
        : db.prepare('SELECT id FROM payroll WHERE periode=? AND lower(nama)=lower(?)').get(periode, r.nama);
      if (dup) { skipped++; continue; }
      ins.run(periode, r.pegawai_id || null, r.nama, r.jabatan || '', r.tipe || 'guru',
        Number(r.jam_efektif) || 0, Number(r.jam_telat) || 0, Number(r.jam_pembantu_kepsek) || 0,
        Number(r.jam_wali_kelas) || 0, Number(r.jam_sertifikasi) || 0,
        Number(r.honor_jam) || 0, Number(r.tunjangan_jabatan) || 0, Number(r.tunjangan_masa_kerja) || 0,
        Number(r.lembur) || 0, Number(r.tambahan_penghasilan) || 0, Number(r.tunjangan_khusus) || 0,
        Number(r.pot_dana_sosial) || 0, Number(r.pot_bpjs_kes) || 0, Number(r.pot_bpjs_tk) || 0,
        Number(r.pot_sertifikasi) || 0, Number(r.pot_kasbon) || 0,
        `${r.catatan ? r.catatan + ' · ' : ''}disalin dari ${periodeLabel(prev)}`.slice(0, 400),
        ++urut, nowStamp(), nowStamp());
      copied++;
    }
  })();
  return { copied, skipped, prev };
}

/* ================= LAPORAN ARUS KAS ================= */
/** kelompokkan arus kas per kategori: operasional / investasi / pendanaan */
function arusKasData(taId, from, to, bkuIds) {
  const bk = [].concat(bkuIds || []).map(Number).filter(Boolean);
  const args = [];
  let sql = `SELECT c.kode, c.nama, c.kategori,
      COALESCE(SUM(CASE WHEN t.jenis='pemasukan' THEN t.nominal ELSE 0 END),0) masuk,
      COALESCE(SUM(CASE WHEN t.jenis='pengeluaran' THEN t.nominal ELSE 0 END),0) keluar
    FROM transaksi t JOIN bku b ON b.id=t.bku_id LEFT JOIN coa c ON c.id=t.coa_id
    WHERE t.status='posted'`;
  if (taId) { sql += ' AND b.tahun_ajaran_id=?'; args.push(taId); }
  if (bk.length) { sql += ` AND b.id IN (${bk.map(() => '?').join(',')})`; args.push(...bk); }
  if (from) { sql += ' AND t.tanggal>=?'; args.push(from); }
  if (to) { sql += ' AND t.tanggal<=?'; args.push(to); }
  sql += ' GROUP BY c.id ORDER BY c.kode';
  const raw = db.prepare(sql).all(...args);
  const groupOf = x => {
    if (x.kode === '5.2.02') return 'investasi';
    if (x.kategori === 'mutasi') return 'pendanaan';
    return 'operasional';
  };
  const groups = { operasional: [], investasi: [], pendanaan: [] };
  for (const x of raw) groups[groupOf(x)].push(x);
  const sumOf = list => ({
    masuk: list.reduce((s, x) => s + Number(x.masuk || 0), 0),
    keluar: list.reduce((s, x) => s + Number(x.keluar || 0), 0),
    net: list.reduce((s, x) => s + Number(x.masuk || 0) - Number(x.keluar || 0), 0)
  });
  const totals = { operasional: sumOf(groups.operasional), investasi: sumOf(groups.investasi), pendanaan: sumOf(groups.pendanaan) };
  const saldoAwalBase = taId
    ? (bk.length ? db.prepare(`SELECT COALESCE(SUM(saldo_awal),0) s FROM bku WHERE tahun_ajaran_id=? AND id IN (${bk.map(() => '?').join(',')})`).get(taId, ...bk).s
      : allBku(taId).reduce((s, b) => s + Number(b.saldo_awal || 0), 0))
    : 0;
  let saldoAwal = saldoAwalBase;
  if (from) {
    const pa = [from];
    let pq = `SELECT COALESCE(SUM(CASE WHEN t.jenis='pemasukan' THEN t.nominal ELSE -t.nominal END),0) d
      FROM transaksi t JOIN bku b ON b.id=t.bku_id
      WHERE t.status='posted' AND t.tanggal<?`;
    if (taId) { pq += ' AND b.tahun_ajaran_id=?'; pa.push(taId); }
    if (bk.length) { pq += ` AND b.id IN (${bk.map(() => '?').join(',')})`; pa.push(...bk); }
    saldoAwal = saldoAwalBase + Number(db.prepare(pq).get(...pa).d || 0);
  }
  const mutasiNet = totals.operasional.net + totals.investasi.net + totals.pendanaan.net;
  return {
    groups, totals, saldoAwal,
    kenaikan: mutasiNet,
    saldoAkhir: saldoAwal + mutasiNet,
    masuk: totals.operasional.masuk + totals.investasi.masuk + totals.pendanaan.masuk,
    keluar: totals.operasional.keluar + totals.investasi.keluar + totals.pendanaan.keluar
  };
}

/**
 * Salin daftar kelas tahun sebelumnya ke tahun ajaran baru + naikkan tingkat siswa
 * (X → XI, XI → XII; XII tidak disalin karena siswa lulus).
 * Dipakai saat menambah tahun ajaran baru supaya "Penetapan Grup Iuran ke Kelas"
 * dan Data Siswa TA baru TIDAK kosong (bug dropdown siswa kosong).
 */
function cloneKelasTa(prevTaId, newTaId, opts = {}) {
  const prev = tahunById(prevTaId), next = tahunById(newTaId);
  if (!prev || !next || Number(prev.id) === Number(next.id)) return { kelas: 0, siswa: 0 };
  // tingkat akhir (XII / 12 / TK-B) → '' (siswa lulus, kelas tidak disalin)
  const nextTingkat = t => {
    const raw = String(t || '').trim();
    if (!raw) return '';
    if (tingkatUrut(raw) >= tingkatUrut('XII') && tingkatNaik(raw) === '') return '';
    return tingkatNaik(raw);
  };
  const rename = (nama, dari, ke) => {
    const n = String(nama || '');
    const d = String(dari || '').trim();
    if (!d) return n;
    if (n.trim().toLowerCase().slice(0, d.length) !== d.toLowerCase()) return n;
    const rest = n.trim().slice(d.length);
    if (rest && !/^\s/.test(rest)) return n;
    return ke + rest;
  };
  const promosi = opts.promosi !== false;
  let nKelas = 0, nSiswa = 0;
  db.transaction(() => {
    const mapKelas = new Map();
    for (const k of db.prepare('SELECT * FROM kelas WHERE tahun_ajaran_id=? ORDER BY urutan, id').all(prev.id)) {
      const tingkatBaru = promosi ? nextTingkat(k.tingkat) : String(k.tingkat || '');
      if (!tingkatBaru) continue;
      const namaBaru = promosi ? rename(k.nama, String(k.tingkat || ''), tingkatBaru) : String(k.nama || '');
      if (!namaBaru) continue;
      const dup = db.prepare('SELECT * FROM kelas WHERE tahun_ajaran_id=? AND lower(nama)=lower(?)').get(next.id, namaBaru);
      if (dup) { mapKelas.set(Number(k.id), Number(dup.id)); continue; }
      const info = db.prepare(`INSERT INTO kelas (nama,nama_kelas,tingkat,wali_kelas,program_id,tahun_ajaran_id,aktif,urutan,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(namaBaru, namaBaru, tingkatBaru, k.wali_kelas || '', k.program_id || null, next.id, k.aktif ? 1 : 0, k.urutan || 0, nowStamp());
      mapKelas.set(Number(k.id), Number(info.lastInsertRowid));
      nKelas++;
    }
    const cariSiswa = db.prepare('SELECT DISTINCT siswa_id FROM siswa_penempatan WHERE kelas_id=? AND tahun_ajaran_id=?');
    for (const [kelasLama, kelasBaru] of mapKelas) {
      for (const r of cariSiswa.all(kelasLama, prev.id)) {
        const s = db.prepare('SELECT id,status FROM siswa WHERE id=?').get(r.siswa_id);
        if (!s || s.status !== 'aktif') continue;
        penempatanSet(s.id, kelasBaru, next.id, { sumber: 'promosi', overwrite: false });
        siswaSyncCurrent(s.id);
        nSiswa++;
      }
    }
  })();
  logAudit(opts.user || null, 'SALIN KELAS TA', 'tahun_ajaran',
    `Salin ${nKelas} kelas & ${nSiswa} penempatan siswa ${prev.nama || prev.id} → ${next.nama || next.id}`);
  return { kelas: nKelas, siswa: nSiswa };
}

/**
 * Bersihkan salinan piutang "yatim": baris piutang yang tahun_ajaran_id-nya sudah
 * TIDAK ADA di master tahun ajaran (sisa rollover untuk TA yang kemudian dihapus).
 * Baris seperti ini tidak pernah muncul di menu Piutang, tetapi masih ikut terhitung
 * pada total/as-setiap laporan.
 *
 * Aturan:
 *  - catatan cicilan (piutang_bayar) yang menempel pada baris yatim DIPINDAHKAN lebih dulu
 *    ke baris piutang aktif (cocokkan nama + teks dasar keterangan + nominal → nama + nominal
 *    → piutang belum lunas tertua milik pegawai tsb) agar pembayaran tidak hilang;
 *  - baris yatim diarsipkan ke Kotak Sampah (bisa dipulihkan 30 hari) lalu dihapus.
 * Idempoten: tidak ada baris yatim → tidak melakukan apa pun.
 */
const TRASH_DAYS = 30;
const TRASH_LABEL = {
  transaksi: 'Transaksi BKU', piutang: 'Piutang Pegawai', piutang_lain: 'Piutang Lain-lain',
  payroll: 'Leger Honor', aset: 'Akun Aset', pinjaman_mutasi: 'Transaksi Aset',
  beasiswa: 'Beasiswa', iuran_bayar: 'Pembayaran Iuran', ekskul_honor: 'Honor Ekskul',
  siswa: 'Data Siswa', mutasi_kas: 'Mutasi Kas',
  piutang_bayar: 'Riwayat Pembayaran Piutang', piutang_lain_bayar: 'Riwayat Pembayaran Piutang Sertifikasi',
  piutang_lainnya: 'Piutang Lainnya', piutang_lainnya_bayar: 'Riwayat Pembayaran Piutang Lainnya',
  piutang_kategori: 'Kategori Piutang Lainnya', siswa_penempatan: 'Penempatan Kelas Siswa',
  pegawai: 'Data Pegawai'
};
function cleanupOrphanPiutang(user) {
  const validIds = db.prepare('SELECT id FROM tahun_ajaran').all().map(r => Number(r.id));
  const listSql = '(' + (validIds.join(',') || '0') + ')';
  const orphans = db.prepare(`SELECT * FROM piutang WHERE tahun_ajaran_id IS NULL
    OR tahun_ajaran_id NOT IN ${listSql} ORDER BY id`).all();
  if (!orphans.length) return { moved: 0, movedValue: 0, deleted: 0 };
  const orphanIds = orphans.map(r => Number(r.id));
  const orphSql = '(' + orphanIds.join(',') + ')';
  const payments = db.prepare(`SELECT * FROM piutang_bayar WHERE piutang_id IN ${orphSql} ORDER BY id`).all();
  const activeRows = db.prepare(`SELECT * FROM piutang WHERE tahun_ajaran_id IN ${listSql}`).all();

  const bucket = new Map(), namaNom = new Map(), namaOnly = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const r of activeRows) {
    const nama = String(r.nama_pegawai || '').trim().toLowerCase();
    push(bucket, nama + '|' + stripCarryText(r.keterangan).toLowerCase() + '|' + Math.round(Number(r.nominal) || 0), r);
    push(namaNom, nama + '|' + Math.round(Number(r.nominal) || 0), r);
    push(namaOnly, nama, r);
  }
  const byId = new Map(orphans.map(r => [Number(r.id), r]));
  let moved = 0, movedValue = 0, deleted = 0;
  for (const pay of payments) {
    const asal = byId.get(Number(pay.piutang_id)) || {};
    const nama = String(asal.nama_pegawai || '').trim().toLowerCase();
    const target = (bucket.get(nama + '|' + stripCarryText(asal.keterangan).toLowerCase() + '|' + Math.round(Number(asal.nominal) || 0)) || [])[0]
      || (namaNom.get(nama + '|' + Math.round(Number(asal.nominal) || 0)) || [])[0]
      || (namaOnly.get(nama) || []).filter(r => r.status === 'belum').sort((a, b) => String(a.tanggal_utang || '').localeCompare(String(b.tanggal_utang || '')))[0]
      || (namaOnly.get(nama) || [])[0];
    if (!target) continue;
    db.prepare('UPDATE piutang_bayar SET piutang_id=?, keterangan=? WHERE id=?')
      .run(target.id, `Pemindahan cicilan dari salinan TA lama (${asal.tanggal_utang || '-'})`, pay.id);
    moved++; movedValue += Number(pay.nominal) || 0;
  }
  for (const r of orphans) {
    const anak = db.prepare('SELECT * FROM piutang_bayar WHERE piutang_id=?').all(r.id);
    trashAdd('piutang', r, {
      user: user || null,
      alasan: 'Salinan "Saldo awal TA" dari tahun pelajaran yang sudah dihapus (data yatim)',
      label: `${r.nama_pegawai} — ${r.tanggal_utang} (Rp ${Number(r.nominal || 0).toLocaleString('id-ID')})`,
      extra: { children: [{ tabel: 'piutang_bayar', rows: anak }] }
    });
  }
  db.prepare(`DELETE FROM piutang WHERE tahun_ajaran_id IS NULL OR tahun_ajaran_id NOT IN ${listSql}`).run();
  deleted = orphans.length;
  piutangSyncStatus();
  logAudit(user || null, 'BERSIHKAN', 'piutang',
    `Hapus ${deleted} salinan piutang yatim (TA ${[...new Set(orphans.map(r => r.tahun_ajaran_id))].join(', ')}); ${moved} cicilan Rp ${movedValue.toLocaleString('id-ID')} dipindahkan ke piutang aktif`);
  return { moved, movedValue, deleted };
}

bootstrap();

// ==================================================================
// TAHAP 1 — MIGRASI MULTI-TENANT SEKOLAH PERTAMA
// Seluruh tabel database yang sedang berjalan diberi kolom tenant_id dan
// diisi tenant_id = 1 TANPA menghapus / mengubah satu baris data pun.
// Idempoten: aman dijalankan setiap kali server start.
// ==================================================================
try {
  const mig = migrateTenantColumns(rootDb, 1);
  if (mig.added) console.log('[tenant] tenant_id ditambahkan ke ' + mig.added + ' tabel, ' + mig.filled + ' baris diisi (tenant 1)');
} catch (e) { console.error('[tenant-migrate]', e.message); }

/**
 * Siapkan database baru untuk satu sekolah (tenant baru).
 * Skema + master dasar (CoA, BKU, tahun ajaran, permission) dibuat otomatis,
 * lalu akun admin sekolah menggantikan akun bawaan seed.
 */
function createTenantDatabase(opts = {}) {
  const id = Number(opts.id) || 0;
  if (!id) throw new Error('createTenantDatabase: id tenant wajib.');
  const file = opts.file || path.join(DATA_DIR, 'tenants', 'tenant-' + id + '.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = openTenantConn(id, file);
  dbStore.run(conn, () => { bootstrap(); });
  migrateTenantColumns(conn, id);
  dbStore.run(conn, () => {
    setSetting('tenant_id', String(id));
    if (opts.school_code) setSetting('tenant_kode', String(opts.school_code));
    if (opts.nama) setSetting('sekolah_nama', String(opts.nama));
    if (opts.alamat) setSetting('sekolah_alamat', String(opts.alamat));
    if (opts.kepala) setSetting('sekolah_kepala', String(opts.kepala));
    if (opts.app_nama) setSetting('app_nama', String(opts.app_nama));
    if (opts.tema) setSetting('tema_warna', String(opts.tema));
    if (opts.logo) {
      // logo default sistem dipakai sebagai logo sekolah sampai admin sekolah menggantinya sendiri
      setSetting('sekolah_logo', String(opts.logo));
      setSetting('app_logo', String(opts.logo));
    }
    /* ---------- ONBOARDING: kondisi awal BERSIH ----------------------------
       Sekolah yang baru mendaftar memulai dengan:
         · daftar BKU KOSONG (tanpa 17 BKU contoh),
         · seluruh identitas sekolah KOSONG kecuali Nama Sekolah (dari form
           pendaftaran) — alamat, kepala, bendahara, NIP/NUPTK, NPSN, kontak,
           bentuk pendidikan & kop surat tidak ikut contoh.
       `opts.keepSample` dipakai internal (mis. sandbox/demo) bila data contoh
       memang dibutuhkan. */
    if (!opts.keepSample) {
      try { if (opts.keepBku !== true) db.prepare('DELETE FROM bku').run(); } catch (e) { }
      const kosongkan = ['sekolah_alamat', 'sekolah_kepala', 'sekolah_nip_kepala', 'sekolah_bendahara', 'sekolah_nip_bendahara',
        'sekolah_npsn', 'sekolah_bentuk', 'sekolah_status', 'sekolah_kepemilikan', 'sekolah_telp', 'sekolah_email',
        'sekolah_website', 'kop_baris'];
      const upd = db.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
      for (const k of kosongkan) upd.run(k, '');
    }
    // jenjang pendidikan → preset tingkat kelas otomatis untuk sekolah baru
    if (opts.jenjang) {
      setSetting('jenjang_pendidikan', String(opts.jenjang));
      const preset = jenjangPreset(opts.jenjang);
      if (preset.length) setTingkatAktif(preset);
    }
    // akun admin sekolah (menggantikan akun bawaan admin@sekolah.sch.id / admin123)
    if (opts.admin_email) {
      const pw = hashPassword(opts.admin_password || 'admin123');
      const uname = String(opts.admin_username || String(opts.admin_email).split('@')[0]).trim();
      const ada = db.prepare("SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get();
      if (ada) {
        db.prepare('UPDATE users SET nama=?,email=?,password=?,username=?,jabatan=?,aktif=1 WHERE id=?')
          .run(opts.admin_nama || 'Administrator Sekolah', String(opts.admin_email).trim(), pw, uname, 'Administrator Sekolah', ada.id);
      } else {
        db.prepare('INSERT INTO users (nama,email,password,role,aktif,jabatan,username,created_at) VALUES (?,?,?,?,1,?,?,?)')
          .run(opts.admin_nama || 'Administrator Sekolah', String(opts.admin_email).trim(), pw, 'super_admin', 'Administrator Sekolah', uname, nowStamp());
      }
      db.prepare("DELETE FROM users WHERE role<>'super_admin' AND email LIKE '%@sekolah.sch.id'").run();
    }
  });
  return conn;
}

/* ==================================================================
   SANDBOX AKUN DEMO — database dummy terpisah
   Dibuat sekali saat pertama dibutuhkan: skema + master data awal
   (CoA, BKU, tahun ajaran, aset) tanpa data transaksi sekolah asli.
   ================================================================== */
function ensureDemoDb() {
  const conn = demoHandle();
  dbStore.run(conn, () => {
    const has = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!has) bootstrap();
    setSetting('demo_catatan', getSetting('demo_catatan', 'Akun ini memakai database DUMMY terpisah. Semua perubahan tidak memengaruhi data sekolah.'));
  });
  return conn;
}
/* reset isi database demo ke kondisi awal (master saja) */
function resetDemoDb() {
  const conn = demoHandle();
  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  dbStore.run(conn, () => {
    db.transaction(() => {
      for (const t of tables) {
        if (['settings', 'permissions'].includes(t.name)) continue;
        db.prepare(`DELETE FROM ${t.name}`).run();
      }
      // bersihkan master yang dibuat bootstrap agar ikut dibuat ulang
      setSetting('demo_reset_at', nowStamp());
    })();
    bootstrap();
  });
  return true;
}

/* ==================================================================
   PEMBERSIHAN DATA HANTU (ORPHAN / PHANTOM) — HARD DELETE
   ------------------------------------------------------------------
   Menyapu baris yang TIDAK MUNGKIN lagi tampil di UI mana pun karena
   induknya sudah tidak ada, contoh nyata di DB produksi:
     · piutang sertifikasi bertanggal 2027 yang menempel pada tahun
       pelajaran (id 5) yang sudah dihapus → tidak muncul di /piutang-lain
       TA mana pun sehingga tidak bisa dihapus dari UI
     · saldo kas/akun aset & beasiswa milik TA yang sudah dihapus
     · grup iuran + nominal milik TA yang sudah dihapus
     · pembayaran iuran yang menunjuk transaksi BKU yang sudah tidak ada
   Berjalan otomatis setiap server start, idempoten (tanpa baris hantu =
   tidak melakukan apa pun) dan TANPA dialog konfirmasi. Sebelum menghapus,
   isi baris dicadangkan ke data/purge-orphan-<waktu>.json (maks 3 berkas).
   ================================================================== */
function purgeBackupFile() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return path.join(path.dirname(DB_PATH),
    `purge-orphan-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`);
}
function purgeGhostData(user) {
  const validTa = db.prepare('SELECT id FROM tahun_ajaran').all().map(r => Number(r.id));
  const taList = '(' + (validTa.join(',') || '0') + ')';
  const snapshot = {};
  const idsFor = new Map();
  const grab = (tabel, sql, ...args) => {
    let rows = [];
    try { rows = db.prepare(sql).all(...args); } catch (e) { return []; }
    if (!rows.length) return rows;
    snapshot[tabel] = snapshot[tabel] || [];
    snapshot[tabel].push(...rows);
    const set = idsFor.get(tabel) || new Set();
    rows.forEach(r => set.add(Number(r.id)));
    idsFor.set(tabel, set);
    return rows;
  };
  const deletes = [];
  const planDelete = (tabel, rows) => {
    if (!rows || !rows.length) return;
    const ids = rows.map(r => Number(r.id)).filter(n => n);
    if (!ids.length) return;
    deletes.push({ tabel, ids });
  };

  /* ---- 1. baris yang menempel pada tahun pelajaran yang sudah dihapus ---- */
  const asetHantu = grab('aset', `SELECT * FROM aset WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`);
  planDelete('aset', asetHantu);
  planDelete('beasiswa', grab('beasiswa', `SELECT * FROM beasiswa WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`));
  planDelete('anggaran', grab('anggaran', `SELECT * FROM anggaran WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`));
  planDelete('spp', grab('spp', `SELECT * FROM spp WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`));
  // piutang pegawai / sertifikasi / lainnya + riwayat cicilannya
  const piutangHantu = grab('piutang', `SELECT * FROM piutang WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`);
  planDelete('piutang', piutangHantu);
  const piutangLainHantu = grab('piutang_lain', `SELECT * FROM piutang_lain WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`);
  planDelete('piutang_lain', piutangLainHantu);
  planDelete('piutang_lainnya', grab('piutang_lainnya', `SELECT * FROM piutang_lainnya WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`));
  // grup iuran hantu (+ nominal & tagihan/pembayarannya)
  const grupHantu = grab('iuran_grup', `SELECT * FROM iuran_grup WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`);
  planDelete('iuran_grup', grupHantu);
  const tagihanIds = new Set();
  if (grupHantu.length) {
    const gid = '(' + grupHantu.map(r => Number(r.id)).join(',') + ')';
    for (const t of grab('iuran_tagihan', `SELECT * FROM iuran_tagihan WHERE grup_id IN ${gid}`)) tagihanIds.add(Number(t.id));
    planDelete('iuran_nominal', grab('iuran_nominal', `SELECT * FROM iuran_nominal WHERE grup_id IN ${gid}`));
  }
  // kelas hantu + penempatannya
  const kelasHantu = grab('kelas', `SELECT * FROM kelas WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`);
  planDelete('kelas', kelasHantu);
  planDelete('siswa_penempatan', grab('siswa_penempatan', `SELECT * FROM siswa_penempatan WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`));
  // BKU hantu (+ transaksinya)
  const bkuHantu = grab('bku', `SELECT * FROM bku WHERE tahun_ajaran_id IS NOT NULL AND tahun_ajaran_id NOT IN ${taList}`);
  planDelete('bku', bkuHantu);
  if (bkuHantu.length) {
    const bid = '(' + bkuHantu.map(r => Number(r.id)).join(',') + ')';
    planDelete('transaksi', grab('transaksi', `SELECT * FROM transaksi WHERE bku_id IN ${bid}`));
    planDelete('bku_rab', grab('bku_rab', `SELECT * FROM bku_rab WHERE bku_id IN ${bid}`));
  }
  planDelete('bku_rab', grab('bku_rab', `SELECT r.* FROM bku_rab r
    LEFT JOIN bku b ON b.id=r.bku_id LEFT JOIN coa c ON c.id=r.coa_id
    WHERE b.id IS NULL OR c.id IS NULL`));

  /* ---- 2. baris yatim karena induknya sudah tidak ada ---- */
  for (const t of grab('iuran_tagihan', `SELECT t.* FROM iuran_tagihan t
    LEFT JOIN iuran_grup g ON g.id=t.grup_id LEFT JOIN siswa s ON s.id=t.siswa_id
    WHERE g.id IS NULL OR s.id IS NULL
      OR (t.tahun_ajaran_id IS NOT NULL AND t.tahun_ajaran_id NOT IN ${taList})`)) tagihanIds.add(Number(t.id));
  planDelete('iuran_tagihan', [...tagihanIds].map(id => ({ id })));
  if (tagihanIds.size) {
    const tid = '(' + [...tagihanIds].join(',') + ')';
    planDelete('iuran_bayar', grab('iuran_bayar', `SELECT * FROM iuran_bayar WHERE tagihan_id IN ${tid}`));
  }
  planDelete('iuran_bayar', grab('iuran_bayar', `SELECT b.* FROM iuran_bayar b
    LEFT JOIN iuran_tagihan t ON t.id=b.tagihan_id WHERE t.id IS NULL`));
  planDelete('iuran_nominal', grab('iuran_nominal', `SELECT n.* FROM iuran_nominal n
    LEFT JOIN iuran_grup g ON g.id=n.grup_id WHERE g.id IS NULL`));
  planDelete('piutang_bayar', grab('piutang_bayar', `SELECT b.* FROM piutang_bayar b
    LEFT JOIN piutang p ON p.id=b.piutang_id WHERE p.id IS NULL`));
  planDelete('piutang_lain_bayar', grab('piutang_lain_bayar', `SELECT b.* FROM piutang_lain_bayar b
    LEFT JOIN piutang_lain p ON p.id=b.piutang_id WHERE p.id IS NULL`));
  planDelete('piutang_lainnya_bayar', grab('piutang_lainnya_bayar', `SELECT b.* FROM piutang_lainnya_bayar b
    LEFT JOIN piutang_lainnya p ON p.id=b.piutang_id WHERE p.id IS NULL`));
  planDelete('pinjaman_mutasi', grab('pinjaman_mutasi', `SELECT m.* FROM pinjaman_mutasi m
    LEFT JOIN aset a ON a.id=m.aset_id WHERE a.id IS NULL`));
  planDelete('transaksi', grab('transaksi', `SELECT t.* FROM transaksi t
    LEFT JOIN bku b ON b.id=t.bku_id WHERE b.id IS NULL`));
  planDelete('payroll', grab('payroll', `SELECT p.* FROM payroll p
    LEFT JOIN pegawai g ON g.id=p.pegawai_id WHERE g.id IS NULL`));
  planDelete('payroll_post', grab('payroll_post', `SELECT p.* FROM payroll_post p
    LEFT JOIN transaksi t ON t.id=p.transaksi_id WHERE t.id IS NULL`));

  /* ---- 3. pembayaran iuran yang menunjuk transaksi BKU yang sudah hilang ----
     Bukan dihapus: dikembalikan ke antrean posting supaya terlihat & bisa diposting ulang. */
  const bayarNyasar = (() => {
    try {
      return db.prepare(`SELECT b.* FROM iuran_bayar b LEFT JOIN transaksi t ON t.id=b.transaksi_id
        WHERE b.transaksi_id IS NOT NULL AND t.id IS NULL`).all();
    } catch (e) { return []; }
  })();
  if (!bayarNyasar.length && !deletes.length) return { deleted: 0, reset: 0, tables: {} };

  // cadangkan isi baris yang akan dihapus
  const tables = {};
  for (const d of deletes) tables[d.tabel] = d.ids.length;
  if (deletes.length) {
    try {
      const dir = path.dirname(DB_PATH);
      const file = purgeBackupFile();
      fs.writeFileSync(file, JSON.stringify({
        created_at: nowStamp(),
        keterangan: 'Cadangan baris data hantu (orphan/phantom) sebelum dihapus permanen',
        tables: snapshot
      }, null, 2), 'utf8');
      // simpan maksimal 3 berkas cadangan
      const olds = fs.readdirSync(dir).filter(f => /^purge-orphan-.*\.json$/.test(f)).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 3))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { }
      }
    } catch (e) { console.error('[purge] gagal menyimpan cadangan:', e.message); }
  }

  let deleted = 0;
  for (const d of deletes) {
    const q = d.ids.map(() => '?').join(',');
    try {
      const info = db.prepare(`DELETE FROM ${d.tabel} WHERE id IN (${q})`).run(...d.ids);
      deleted += Number(info.changes || 0);
    } catch (e) { console.error(`[purge] gagal hapus ${d.tabel}:`, e.message); }
  }
  let reset = 0;
  for (const b of bayarNyasar) {
    const bku = b.bku_id ? db.prepare('SELECT * FROM bku WHERE id=?').get(b.bku_id) : null;
    db.prepare('UPDATE iuran_bayar SET transaksi_id=NULL, status=? WHERE id=?')
      .run(bku && bku.status === 'aktif' ? 'pending' : 'manual', b.id);
    reset++;
  }
  try { piutangSyncStatus(); } catch (e) { }
  if (deleted || reset) {
    logAudit(user || null, 'BERSIHKAN DATA HANTU', 'sistem',
      `Hard delete ${deleted} baris data yatim${Object.keys(tables).length ? ' (' + Object.entries(tables).map(([t, n]) => `${t}: ${n}`).join(', ') + ')' : ''}` +
      (reset ? `; ${reset} pembayaran iuran dikembalikan ke antrean posting` : ''));
  }
  return { deleted, reset, tables };
}

/* ==================================================================
   TAHUN AJARAN OTOMATIS (mengikuti bulan kalender berjalan)
   ================================================================== */
/** tahun ajaran yang rentang tanggalnya memuat `dateISO`, atau TA terdekat */
function taAutoFor(dateISO) {
  const d = String(dateISO || todayISO()).slice(0, 10);
  const all = allTahun();
  if (!all.length) return null;
  const hit = all.find(t => t.tanggal_mulai && t.tanggal_selesai
    && d >= String(t.tanggal_mulai).slice(0, 10) && d <= String(t.tanggal_selesai).slice(0, 10));
  if (hit) return hit;
  // tidak ada yang cocok: bulan >= 7 → tahun berjalan, selain itu tahun sebelumnya
  const y = Number(d.slice(0, 4)) || new Date().getFullYear();
  const m = Number(d.slice(5, 7)) || 1;
  const target = m >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
  return all.find(t => String(t.nama).replace(/\s/g, '') === target) || hit || all.find(t => t.aktif) || all[0];
}
function taAutoId(dateISO) {
  const t = taAutoFor(dateISO);
  return t ? t.id : null;
}

/* ==================================================================
   KOTAK SAMPAH — soft delete 30 hari
   (konstanta TRASH_DAYS/TRASH_LABEL dideklarasikan sebelum bootstrap agar
    migrasi data yang memakai trashAdd() bisa berjalan saat start)
   ================================================================== */
function trashAdd(tabel, row, opts = {}) {
  if (!row) return null;
  const now = new Date();
  const exp = new Date(now.getTime() + TRASH_DAYS * 86400000);
  const p = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const info = db.prepare('INSERT INTO trash (tabel,row_id,label,data,extra,alasan,user_id,user_nama,deleted_at,expired_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(tabel, row.id || null, opts.label || (TRASH_LABEL[tabel] || tabel) + ' #' + (row.id || ''),
      JSON.stringify(row), opts.extra ? JSON.stringify(opts.extra) : null, opts.alasan || '',
      opts.user ? opts.user.id : null, opts.user ? opts.user.nama : '', iso(now), iso(exp));
  return Number(info.lastInsertRowid);
}
function trashList(tabel) {
  const rows = tabel
    ? db.prepare('SELECT * FROM trash WHERE tabel=? ORDER BY id DESC').all(tabel)
    : db.prepare('SELECT * FROM trash ORDER BY id DESC').all();
  return rows;
}
/** buang permanen data kotak sampah yang sudah kedaluwarsa (dipanggil tiap request / start) */
function trashPurge() {
  const now = nowStamp();
  const info = db.prepare('DELETE FROM trash WHERE expired_at < ?').run(now);
  return info.changes;
}
/** tabel yang aman direstorasi beserta kolomnya */
function trashRestore(id, user) {
  const t = db.prepare('SELECT * FROM trash WHERE id=?').get(id);
  if (!t) throw new Error('Data kotak sampah tidak ditemukan.');
  const row = JSON.parse(t.data);
  const insertRow = (tabel, data) => {
    const cols = db.prepare(`PRAGMA table_info(${tabel})`).all().map(c => c.name);
    const keys = Object.keys(data).filter(k => cols.includes(k));
    if (!keys.length) return false;
    db.prepare(`INSERT OR REPLACE INTO ${tabel} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map(k => data[k]));
    return true;
  };
  if (!insertRow(t.tabel, row)) throw new Error('Struktur tabel asal sudah berubah, data tidak dapat dikembalikan.');
  // baris anak (mis. cicilan piutang) ikut dikembalikan
  try {
    const extra = t.extra ? JSON.parse(t.extra) : null;
    if (extra && Array.isArray(extra.children)) {
      for (const ch of extra.children) for (const r of (ch.rows || [])) insertRow(ch.tabel, r);
    }
  } catch (e) { }
  db.prepare('DELETE FROM trash WHERE id=?').run(id);
  logAudit(user, 'RESTORE', 'trash', `Mengembalikan ${TRASH_LABEL[t.tabel] || t.tabel} #${t.row_id} (${t.label})`);
  return row;
}

/* ==================================================================
   AKADEMIK — program keahlian, kelas, siswa
   ================================================================== */
const SISWA_STATUS = {
  aktif: ['Aktif', 'green'], nonaktif: ['Non-Aktif', 'gray'], lulus: ['Lulus', 'blue'],
  pindah: ['Pindah / Mutasi Keluar', 'amber'], do: ['Drop Out (DO)', 'red']
};
function programList(aktifOnly) {
  return db.prepare(`SELECT * FROM program_keahlian ${aktifOnly ? 'WHERE aktif=1' : ''} ORDER BY nama`).all();
}
function kelasList(taId, opts = {}) {
  let sql = `SELECT k.*, p.nama program_nama,
      (SELECT COUNT(*) FROM siswa s
        JOIN siswa_penempatan sp ON sp.siswa_id=s.id AND sp.tahun_ajaran_id=k.tahun_ajaran_id
        WHERE sp.kelas_id=k.id AND s.status='aktif') jumlah_siswa
    FROM kelas k LEFT JOIN program_keahlian p ON p.id=k.program_id WHERE 1=1`;
  const args = [];
  if (taId) { sql += ' AND k.tahun_ajaran_id=?'; args.push(taId); }
  if (opts.aktifOnly) sql += ' AND k.aktif=1';
  sql += ' ORDER BY k.urutan, COALESCE(k.nama_kelas, k.nama), k.id';
  return db.prepare(sql).all(...args)
    .map(k => ({ ...k, nama_kelas: k.nama_kelas || k.nama, tingkat_urut: tingkatUrut(k.tingkat) }))
    .sort((a, b) => (a.tingkat_urut - b.tingkat_urut) || (a.urutan - b.urutan) || String(a.nama).localeCompare(String(b.nama)));
}
function kelasById(id) {
  const k = db.prepare(`SELECT k.*, p.nama program_nama FROM kelas k LEFT JOIN program_keahlian p ON p.id=k.program_id WHERE k.id=?`).get(id);
  return k ? { ...k, nama_kelas: k.nama_kelas || k.nama } : k;
}

/* ---------- penempatan kelas per tahun pelajaran ---------- */
/** kunci urut kronologis tahun pelajaran (tanggal mulai → nama → id) */
function taSortKey(ta) {
  const t = typeof ta === 'object' && ta ? ta : (ta ? tahunById(ta) : null);
  if (!t) return '';
  return `${String(t.tanggal_mulai || '')}#${String(t.nama || '')}#${String(t.id).padStart(6, '0')}`;
}
/** daftar penempatan (riwayat kelas) seorang siswa, terbaru di atas */
function penempatanList(siswaId) {
  const rows = db.prepare(`SELECT p.*, k.nama kelas_nama, k.tingkat, t.nama ta_nama, t.tanggal_mulai
    FROM siswa_penempatan p LEFT JOIN kelas k ON k.id=p.kelas_id
    LEFT JOIN tahun_ajaran t ON t.id=p.tahun_ajaran_id WHERE p.siswa_id=?`).all(siswaId);
  return rows.sort((a, b) => taSortKey(b).localeCompare(taSortKey(a)));
}
/**
 * Simpan penempatan siswa pada satu tahun pelajaran.
 * `overwrite:false` dipakai untuk merekam tahun ASAL saat mutasi lintas tahun
 * pelajaran — penempatan yang sudah ada tidak boleh tertimpa.
 */
function penempatanSet(siswaId, kelasId, taId, opts = {}) {
  if (!siswaId || !taId) return null;
  const now = nowStamp();
  const row = db.prepare('SELECT * FROM siswa_penempatan WHERE siswa_id=? AND tahun_ajaran_id=?').get(siswaId, taId);
  if (row) {
    if (opts.overwrite === false) return row;
    db.prepare(`UPDATE siswa_penempatan SET kelas_id=?, sumber=?, mutasi_id=COALESCE(?,mutasi_id), updated_at=? WHERE id=?`)
      .run(kelasId || null, opts.sumber || row.sumber || 'manual', opts.mutasiId || null, now, row.id);
    return { ...row, kelas_id: kelasId || null };
  }
  const info = db.prepare(`INSERT INTO siswa_penempatan (siswa_id,kelas_id,tahun_ajaran_id,sumber,mutasi_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(siswaId, kelasId || null, taId, opts.sumber || 'manual', opts.mutasiId || null, now, now);
  return db.prepare('SELECT * FROM siswa_penempatan WHERE id=?').get(Number(info.lastInsertRowid));
}
/** selaraskan cache di tabel siswa (kelas & TA terbaru) dengan penempatan terbaru */
function siswaSyncCurrent(siswaId) {
  const rows = db.prepare(`SELECT p.kelas_id, p.tahun_ajaran_id, t.nama ta_nama, t.tanggal_mulai
    FROM siswa_penempatan p LEFT JOIN tahun_ajaran t ON t.id=p.tahun_ajaran_id WHERE p.siswa_id=?`).all(siswaId);
  if (!rows.length) return null;
  rows.sort((a, b) => taSortKey(b).localeCompare(taSortKey(a)));
  const cur = rows[0];
  db.prepare('UPDATE siswa SET kelas_id=?, tahun_ajaran_id=?, updated_at=? WHERE id=?')
    .run(cur.kelas_id || null, cur.tahun_ajaran_id || null, nowStamp(), siswaId);
  return cur;
}
/**
 * Daftar siswa. Bila `taId` diberikan, daftar mengikuti PENEMPATAN pada tahun
 * pelajaran tersebut (bukan sekadar kolom cache siswa) sehingga siswa yang
 * dimutasi lintas tahun pelajaran tetap muncul pada rekap tahun asalnya.
 */
function siswaList(opts = {}) {
  const args = [];
  const perTa = !!opts.taId;
  let joins;
  if (perTa) {
    args.push(opts.taId, opts.taId, opts.taId);
    joins = `LEFT JOIN siswa_penempatan p ON p.siswa_id=s.id AND p.tahun_ajaran_id=?
      LEFT JOIN kelas k ON k.id=COALESCE(p.kelas_id, CASE WHEN s.tahun_ajaran_id=? THEN s.kelas_id END)`;
  } else {
    joins = `LEFT JOIN siswa_penempatan p ON p.siswa_id=s.id AND p.tahun_ajaran_id=s.tahun_ajaran_id
      LEFT JOIN kelas k ON k.id=COALESCE(p.kelas_id, s.kelas_id)`;
  }
  let sql = `SELECT s.*, k.id kelas_efektif, k.nama kelas_nama, k.tingkat, pr.nama program_nama
    FROM siswa s ${joins} LEFT JOIN program_keahlian pr ON pr.id=k.program_id WHERE 1=1`;
  // siswa tanpa baris penempatan tetap tampil bila kolom cache-nya milik TA ini (data lama)
  if (perTa) sql += ' AND (p.id IS NOT NULL OR s.tahun_ajaran_id=?)';
  if (opts.kelasId) { sql += ' AND k.id=?'; args.push(opts.kelasId); }
  if (opts.status) {
    if (Array.isArray(opts.status)) { sql += ` AND s.status IN (${opts.status.map(() => '?').join(',')})`; args.push(...opts.status); }
    else { sql += ' AND s.status=?'; args.push(opts.status); }
  }
  if (opts.q) {
    sql += ' AND (s.nama LIKE ? OR s.nisn LIKE ?)';
    args.push('%' + opts.q + '%', '%' + opts.q + '%');
  }
  sql += ' ORDER BY k.tingkat, k.nama, s.nama';
  return db.prepare(sql).all(...args).map(r => {
    const { kelas_efektif, ...rest } = r;
    return { ...rest, kelas_id: kelas_efektif === undefined ? null : kelas_efektif };
  });
}

/* ==================================================================
   IURAN SISWA
   ================================================================== */
const BULAN_TA = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
function iuranGrupList(taId, opts = {}) {
  let sql = 'SELECT * FROM iuran_grup WHERE 1=1';
  const args = [];
  if (taId) { sql += ' AND tahun_ajaran_id=?'; args.push(taId); }
  if (opts.aktifOnly) sql += ' AND aktif=1';
  sql += ' ORDER BY nama';
  const rows = db.prepare(sql).all(...args);
  return rows.map(g => {
    const nom = db.prepare("SELECT * FROM iuran_nominal WHERE grup_id=? AND COALESCE(tingkat,'')='' ORDER BY COALESCE(bulan,0)").all(g.id);
    const total = nom.reduce((s, r) => s + Number(r.nominal || 0), 0);
    const siswa = db.prepare('SELECT COUNT(*) c FROM iuran_tagihan WHERE grup_id=?').get(g.id).c;
    const tingkatRows = db.prepare("SELECT tingkat, COUNT(*) n, COALESCE(SUM(nominal),0) total FROM iuran_nominal WHERE grup_id=? AND COALESCE(tingkat,'')<>'' GROUP BY tingkat").all(g.id);
    return { ...g, nominal: nom, total_nominal: total, jumlah_siswa: siswa, tingkat_nominal: tingkatRows };
  });
}
/**
 * Nominal iuran per bulan untuk satu grup.
 * `tingkat` kosong → nominal DEFAULT (semua tingkat). Bila suatu bulan tidak
 * punya nominal khusus tingkat tersebut, nilai default yang dipakai.
 */
function iuranNominalMap(grupId, tingkat) {
  const t = String(tingkat || '').trim();
  const def = {}, khusus = {};
  for (const r of db.prepare('SELECT * FROM iuran_nominal WHERE grup_id=?').all(grupId)) {
    const key = r.bulan || 0;
    if (String(r.tingkat || '').trim() === '') def[key] = Number(r.nominal || 0);
    else if (String(r.tingkat).trim().toUpperCase() === t.toUpperCase()) khusus[key] = Number(r.nominal || 0);
  }
  const out = {};
  for (const k of Object.keys(def)) out[k] = def[k];
  for (const k of Object.keys(khusus)) out[k] = khusus[k];
  return out;
}
/** total tagihan satu grup untuk satu tingkat (fallback ke default) */
function iuranTotalFor(grupId, tingkat) {
  const map = iuranNominalMap(grupId, tingkat);
  return Object.values(map).reduce((s, v) => s + Number(v || 0), 0);
}
/** tingkat kelas efektif seorang siswa pada tahun pelajaran tertentu */
function siswaTingkat(siswaId, taId) {
  try {
    const r = db.prepare(`SELECT k.tingkat FROM siswa_penempatan sp JOIN kelas k ON k.id=sp.kelas_id
      WHERE sp.siswa_id=? AND sp.tahun_ajaran_id=? LIMIT 1`).get(Number(siswaId), Number(taId));
    if (r && r.tingkat) return String(r.tingkat);
    const s = db.prepare('SELECT s.kelas_id, k.tingkat FROM siswa s LEFT JOIN kelas k ON k.id=s.kelas_id WHERE s.id=?').get(Number(siswaId));
    return (s && s.tingkat) ? String(s.tingkat) : '';
  } catch (e) { return ''; }
}
/**
 * Rincian tagihan BULANAN satu tagihan/grup + alokasi pembayaran.
 * Pembayaran yang menyebut bulan tertentu dialokasikan ke bulan itu dulu,
 * sisanya (bulan NULL) FIFO dari bulan pertama.
 * Dipakai halaman detail iuran, matriks bulanan, DAN portal publik orang tua
 * agar angka di semua tempat selalu sama.
 * @param {number} grupId
 * @param {Array<{jumlah:number,bulan:(number|null)}>} payments
 * @returns {Array<{bulan:number,tagihan:number,dibayar:number,sisa:number,status:string}>}
 */
function iuranMonthDetail(grupId, payments, tingkat) {
  const nom = iuranNominalMap(grupId, tingkat);
  const months = BULAN_TA.filter(b => Number(nom[b] || 0) > 0)
    .map(b => ({ bulan: b, tagihan: Number(nom[b] || 0), dibayar: 0 }));
  if (!months.length) return [];
  let pool = 0;
  for (const p of (payments || [])) {
    const j = Number(p.jumlah || 0);
    if (!(j > 0)) continue;
    const m = p.bulan ? months.find(x => x.bulan === Number(p.bulan)) : null;
    if (m) {
      const add = Math.min(Math.max(0, m.tagihan - m.dibayar), j);
      m.dibayar += add;
      pool += j - add;
    } else pool += j;
  }
  for (const m of months) {
    if (pool <= 0) break;
    const add = Math.min(Math.max(0, m.tagihan - m.dibayar), pool);
    m.dibayar += add;
    pool -= add;
  }
  return months.map(m => ({
    ...m,
    sisa: Math.max(0, m.tagihan - m.dibayar),
    status: m.dibayar >= m.tagihan ? 'lunas' : m.dibayar > 0 ? 'sebagian' : 'belum'
  }));
}
/** pembayaran (non-void) per tagihan untuk sekumpulan id tagihan → Map(tagihan_id → rows) */
function iuranPaysMap(tagihanIds) {
  const ids = [].concat(tagihanIds || []).map(Number).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT tagihan_id, jumlah, potongan, dibayar, bulan, tanggal, metode
    FROM iuran_bayar WHERE status<>'void' AND tagihan_id IN (${ids.map(() => '?').join(',')})
    ORDER BY tanggal, id`).all(...ids);
  for (const r of rows) {
    if (!map.has(r.tagihan_id)) map.set(r.tagihan_id, []);
    map.get(r.tagihan_id).push(r);
  }
  return map;
}
/** tagihan + pembayaran (yang tidak di-void) */
function iuranTagihanRows(opts = {}) {
  let sql = `SELECT t.*, s.nama siswa_nama, s.nisn, s.parent_phone, k.nama kelas_nama, k.tingkat, g.nama grup_nama, g.jenis grup_jenis,
      COALESCE((SELECT SUM(b.jumlah) FROM iuran_bayar b WHERE b.tagihan_id=t.id AND b.status<>'void'),0) terbayar,
      COALESCE((SELECT SUM(b.potongan) FROM iuran_bayar b WHERE b.tagihan_id=t.id AND b.status<>'void'),0) total_potongan,
      COALESCE((SELECT SUM(b.dibayar) FROM iuran_bayar b WHERE b.tagihan_id=t.id AND b.status<>'void'),0) kas_diterima,
      (SELECT COUNT(*) FROM iuran_bayar b WHERE b.tagihan_id=t.id AND b.status<>'void') n_bayar
    FROM iuran_tagihan t JOIN siswa s ON s.id=t.siswa_id
    LEFT JOIN siswa_penempatan sp ON sp.siswa_id=s.id AND sp.tahun_ajaran_id=t.tahun_ajaran_id
    LEFT JOIN kelas k ON k.id=COALESCE(sp.kelas_id, s.kelas_id)
    JOIN iuran_grup g ON g.id=t.grup_id WHERE 1=1`;
  const args = [];
  if (opts.taId) { sql += ' AND t.tahun_ajaran_id=?'; args.push(opts.taId); }
  if (opts.grupId) {
    const gs = [].concat(opts.grupId).map(Number).filter(Boolean);
    if (gs.length) { sql += ` AND t.grup_id IN (${gs.map(() => '?').join(',')})`; args.push(...gs); }
  }
  if (opts.siswaId) { sql += ' AND t.siswa_id=?'; args.push(opts.siswaId); }
  if (opts.tingkat) {
    const ts = [].concat(opts.tingkat).map(x => String(x || '').trim()).filter(Boolean);
    if (ts.length) { sql += ` AND COALESCE(k.tingkat,'') IN (${ts.map(() => '?').join(',')})`; args.push(...ts); }
  }
  if (opts.kelasId) {
    const ks = [].concat(opts.kelasId).map(Number).filter(Boolean);
    if (ks.length) { sql += ` AND k.id IN (${ks.map(() => '?').join(',')})`; args.push(...ks); }
  }
  if (opts.siswaIds) {
    const ss = [].concat(opts.siswaIds).map(Number).filter(Boolean);
    if (ss.length) { sql += ` AND t.siswa_id IN (${ss.map(() => '?').join(',')})`; args.push(...ss); }
  }
  if (opts.q) { sql += ' AND (s.nama LIKE ? OR s.nisn LIKE ?)'; args.push('%' + opts.q + '%', '%' + opts.q + '%'); }
  // hanya siswa berstatus aktif (dipakai halaman Data Iuran & Tagihan Aktif)
  if (opts.aktifOnly) sql += " AND s.status='aktif'";
  sql += ' ORDER BY g.nama, s.nama';
  return db.prepare(sql).all(...args).map(r => {
    let sisa = Math.max(0, Number(r.nominal || 0) - Number(r.terbayar || 0));
    let status = sisa <= 0 ? 'lunas' : (Number(r.terbayar) > 0 ? 'sebagian' : 'belum');
    if (r.writeoff === 'pemutihan') { sisa = 0; status = 'pemutihan'; }
    else if (r.writeoff === 'tak_tertagih') status = 'tak_tertagih';
    return {
      ...r, nominal: Number(r.nominal || 0), terbayar: Number(r.terbayar || 0),
      total_potongan: Number(r.total_potongan || 0), kas_diterima: Number(r.kas_diterima || 0),
      sisa, status
    };
  });
}
/** rekap tagihan per siswa (untuk Data Iuran & portal publik) */
function iuranRekapSiswa(rows) {
  const map = new Map();
  for (const r of rows) {
    let s = map.get(r.siswa_id);
    if (!s) {
      s = {
        siswa_id: r.siswa_id, nama: r.siswa_nama, nisn: r.nisn, kelas: r.kelas_nama, parent_phone: r.parent_phone,
        tahun_ajaran_id: r.tahun_ajaran_id, tagihan: 0, terbayar: 0, potongan: 0, kas: 0, sisa: 0,
        items: []
      };
      map.set(r.siswa_id, s);
    }
    s.tagihan += r.nominal; s.terbayar += r.terbayar; s.potongan += r.total_potongan; s.kas += r.kas_diterima;
    s.sisa += r.sisa;
    s.items.push(r);
  }
  return Array.from(map.values()).map(s => ({ ...s, sisa: Math.max(0, s.sisa) }));
}
function iuranBayarRows(opts = {}) {
  let sql = `SELECT b.*, s.nama siswa_nama, s.nisn, k.nama kelas_nama, k.tingkat, g.nama grup_nama, g.jenis grup_jenis,
      g.id grup_id, g.tahun_ajaran_id grup_ta_id,
      t.nominal tagihan_nominal, bk.nama bku_nama, u.nama pencatat, t2.no_bukti
    FROM iuran_bayar b LEFT JOIN iuran_tagihan t ON t.id=b.tagihan_id
    LEFT JOIN siswa s ON s.id=COALESCE(b.siswa_id,t.siswa_id)
    LEFT JOIN iuran_grup g ON g.id=t.grup_id
    LEFT JOIN siswa_penempatan sp ON sp.siswa_id=s.id AND sp.tahun_ajaran_id=COALESCE(t.tahun_ajaran_id, g.tahun_ajaran_id)
    LEFT JOIN kelas k ON k.id=COALESCE(sp.kelas_id, s.kelas_id)
    LEFT JOIN bku bk ON bk.id=b.bku_id LEFT JOIN users u ON u.id=b.created_by
    LEFT JOIN transaksi t2 ON t2.id=b.transaksi_id WHERE 1=1`;
  const args = [];
  if (opts.siswaId) { sql += ' AND COALESCE(b.siswa_id,t.siswa_id)=?'; args.push(opts.siswaId); }
  if (opts.tagihanId) { sql += ' AND b.tagihan_id=?'; args.push(opts.tagihanId); }
  if (opts.kwitansiNo) { sql += ' AND b.kwitansi_no=?'; args.push(opts.kwitansiNo); }
  if (opts.taId) { sql += ' AND t.tahun_ajaran_id=?'; args.push(opts.taId); }
  if (opts.status) { sql += ' AND b.status=?'; args.push(opts.status); }
  if (opts.statuses) {
    const statuses = [].concat(opts.statuses).map(String).filter(Boolean);
    if (statuses.length) { sql += ` AND b.status IN (${statuses.map(() => '?').join(',')})`; args.push(...statuses); }
  }
  if (opts.dari) { sql += ' AND b.tanggal>=?'; args.push(opts.dari); }
  if (opts.sampai) { sql += ' AND b.tanggal<=?'; args.push(opts.sampai); }
  if (opts.q) { sql += ' AND (s.nama LIKE ? OR s.nisn LIKE ?)'; args.push('%' + opts.q + '%', '%' + opts.q + '%'); }
  if (opts.grupId) {
    const gs = [].concat(opts.grupId).map(Number).filter(Boolean);
    if (gs.length) { sql += ` AND t.grup_id IN (${gs.map(() => '?').join(',')})`; args.push(...gs); }
  }
  if (opts.bulan) { sql += ' AND b.bulan=?'; args.push(opts.bulan); }
  if (opts.metode) { sql += ' AND b.metode=?'; args.push(opts.metode); }
  sql += ' ORDER BY b.tanggal DESC, b.id DESC';
  const limit = Math.max(0, Math.min(500, Number(opts.limit) || 0));
  if (limit) {
    sql += ' LIMIT ? OFFSET ?';
    args.push(limit, Math.max(0, Number(opts.offset) || 0));
  }
  return db.prepare(sql).all(...args);
}

/* ==================================================================
   HONOR PEMBINA EKSTRAKURIKULER (antrean posting)
   ================================================================== */
function ekskulRows(periode) {
  const rows = periode
    ? db.prepare('SELECT * FROM ekskul_honor WHERE periode=? ORDER BY nama_pembina').all(periode)
    : db.prepare('SELECT * FROM ekskul_honor ORDER BY periode DESC, nama_pembina').all();
  return rows.map(r => ({ ...r, jumlah: Math.round((Number(r.kehadiran) || 0) * (Number(r.harga_satuan) || 0)) }));
}
function ekskulPending() {
  return ekskulRows().filter(r => r.status === 'pending');
}

/* ==================================================================
   ASET: sembunyikan duplikasi akun pinjaman/aset lain
   (nominal sama & belum punya transaksi buku bantu → ditandai tampil=0)
   ================================================================== */
function dedupeAset(taId, opts = {}) {
  let sql = "SELECT * FROM aset WHERE jenis IN ('pinjaman','lain')";
  const args = [];
  if (taId) { sql += ' AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)'; args.push(taId); }
  const rows = db.prepare(sql + ' ORDER BY id').all(...args);
  const groups = new Map();
  for (const a of rows) {
    const mut = db.prepare('SELECT COUNT(*) c FROM pinjaman_mutasi WHERE aset_id=?').get(a.id).c;
    // hanya dibandingkan dalam tahun pelajaran yang sama (akun rollover antar TA tidak dianggap duplikat)
    const key = (a.tahun_ajaran_id || 0) + '|' + a.jenis + '|' + Math.round(Number(a.saldo) || 0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...a, mutasi: mut });
  }
  let hidden = 0;
  const upd = db.prepare('UPDATE aset SET tampil=0 WHERE id=?');
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const tanpaMutasi = list.filter(a => a.mutasi === 0);
    if (tanpaMutasi.length < 2) continue;
    // mode otomatis (saat start): hanya nama yang benar-benar sama yang disembunyikan
    if (opts.sameNameOnly) {
      const nama = new Set(tanpaMutasi.map(a => String(a.nama || '').toLowerCase().trim()));
      if (nama.size !== 1) continue;
    }
    // pertahankan akun terlama, sembunyikan sisanya
    for (const a of tanpaMutasi.slice(1)) {
      if (Number(a.tampil) !== 0) { upd.run(a.id); hidden++; }
    }
  }
  return hidden;
}


/* ==================================================================
   ANALITIK DASHBOARD IURAN (ringkasan · bulanan · metode · per grup)
   ================================================================== */
/**
 * @returns {{
 *   summary:{tagihan:number,terbayar:number,potongan:number,sisa:number,siswa:number},
 *   monthly:Array<{bulan:number,label:string,tagihan:number,dibayar:number,tunai:number,transfer:number}>,
 *   metode:Array<{bulan:number,label:string,tunai:number,transfer:number,total:number}>,
 *   grup:Array<{id:number,nama:string,jenis:string,sel:Object<string,{tunai:number,transfer:number}>,total:{tunai:number,transfer:number}}>,
 *   nonBulanan:{tagihan:number,dibayar:number}
 * }}
 */
function iuranAnalytics(taId) {
  const groups = iuranGrupList(taId, {});
  const tags = iuranTagihanRows({ taId, aktifOnly: true });
  const months = BULAN_TA;
  const zero = () => ({ tagihan: 0, dibayar: 0, tunai: 0, transfer: 0 });
  const monthMap = new Map(months.map(b => [b, zero()]));
  const grupMap = new Map();
  for (const g of groups) {
    const sel = {};
    for (const b of months) sel[b] = { tunai: 0, transfer: 0 };
    grupMap.set(g.id, { id: g.id, nama: g.nama, jenis: g.jenis, sel, total: { tunai: 0, transfer: 0 } });
  }
  const nonBulanan = { tagihan: 0, dibayar: 0 };
  if (tags.length) {
    const ids = tags.map(t => t.id);
    const pays = db.prepare(`SELECT tagihan_id, jumlah, potongan, dibayar, bulan, tanggal, metode FROM iuran_bayar
      WHERE status<>'void' AND tagihan_id IN (${ids.map(() => '?').join(',')}) ORDER BY tanggal, id`).all(...ids);
    const payMap = new Map();
    for (const p of pays) {
      if (!payMap.has(p.tagihan_id)) payMap.set(p.tagihan_id, []);
      payMap.get(p.tagihan_id).push(p);
    }
    for (const t of tags) {
      const g = grupMap.get(t.grup_id);
      const list = payMap.get(t.id) || [];
      const nominalMap = {};
      for (const r of db.prepare('SELECT bulan, nominal FROM iuran_nominal WHERE grup_id=?').all(t.grup_id)) nominalMap[r.bulan || 0] = Number(r.nominal || 0);
      if (t.grup_jenis === 'bulanan') {
        const mrows = months.filter(b => Number(nominalMap[b] || 0) > 0)
          .map(b => ({ bulan: b, tagihan: Number(nominalMap[b] || 0), dibayar: 0, tunai: 0, transfer: 0 }));
        if (!mrows.length) continue;
        let pool = [];   // pembayaran tanpa bulan (FIFO)
        for (const p of list) {
          const j = Number(p.jumlah || 0);
          if (!(j > 0)) continue;
          const metode = p.metode === 'transfer' ? 'transfer' : 'tunai';
          const target = p.bulan ? mrows.find(x => x.bulan === Number(p.bulan)) : null;
          if (target) {
            const add = Math.min(Math.max(0, target.tagihan - target.dibayar), j);
            target.dibayar += add; target[metode] += add;
            if (j - add > 0) pool.push({ sisa: j - add, metode });
          } else pool.push({ sisa: j, metode });
        }
        for (const m of mrows) {
          let need = Math.max(0, m.tagihan - m.dibayar);
          while (need > 0 && pool.length) {
            const head = pool[0];
            const add = Math.min(need, head.sisa);
            m.dibayar += add; m[head.metode] += add;
            need -= add; head.sisa -= add;
            if (head.sisa <= 0) pool.shift();
          }
        }
        for (const m of mrows) {
          const acc = monthMap.get(m.bulan);
          if (!acc) continue;
          acc.tagihan += m.tagihan; acc.dibayar += m.dibayar;
          acc.tunai += m.tunai; acc.transfer += m.transfer;
          if (g) { g.sel[m.bulan].tunai += m.tunai; g.sel[m.bulan].transfer += m.transfer; g.total.tunai += m.tunai; g.total.transfer += m.transfer; }
        }
      } else {
        nonBulanan.tagihan += Number(t.nominal || 0);
        for (const p of list) {
          const metode = p.metode === 'transfer' ? 'transfer' : 'tunai';
          const nominal = Number(p.jumlah || 0);
          nonBulanan.dibayar += nominal;
          if (g) {
            g.total[metode] += nominal;
            // iuran non-bulanan dibukukan pada BULAN TANGGAL PEMBAYARAN agar kolom
            // Juli–Juni pada tabel "Rincian Penerimaan per Grup" ikut terisi
            const pm = Number(String(p.tanggal || '').slice(5, 7)) || 0;
            if (pm >= 1 && pm <= 12 && g.sel[pm]) g.sel[pm][metode] += nominal;
          }
        }
      }
    }
  }
  const summary = {
    tagihan: tags.reduce((a, t) => a + Number(t.nominal || 0), 0),
    terbayar: tags.reduce((a, t) => a + Number(t.terbayar || 0), 0),
    potongan: tags.reduce((a, t) => a + Number(t.total_potongan || 0), 0),
    sisa: tags.reduce((a, t) => a + Number(t.sisa || 0), 0),
    siswa: new Set(tags.map(t => t.siswa_id)).size,
    lunas: tags.filter(t => t.sisa <= 0).length,
    tagihanCount: tags.length
  };
  const monthly = months.map(b => {
    const m = monthMap.get(b);
    return { bulan: b, label: `${(NAMA_BULAN[b - 1] || '').slice(0, 3)}`, tagihan: m.tagihan, dibayar: m.dibayar, tunai: m.tunai, transfer: m.transfer, sisa: Math.max(0, m.tagihan - m.dibayar) };
  });
  const metode = monthly.map(m => ({ bulan: m.bulan, label: m.label, tunai: m.tunai, transfer: m.transfer, total: m.tunai + m.transfer }));
  return { summary, monthly, metode, grup: [...grupMap.values()], nonBulanan, months };
}

/** rekap piutang sertifikasi per pegawai */
function sertifikasiRekap(taId, opts = {}) {
  const map = new Map();
  for (const p of piutangLainRows(taId)) {
    if (opts.hanyaBelum && !(p.sisa > 0)) continue;
    const key = String(p.nama || '').trim().toLowerCase();
    if (!map.has(key)) map.set(key, { nama: String(p.nama || '').trim(), jumlah: 0, aktif: 0, nominal: 0, dibayar: 0, sisa: 0, items: [] });
    const g = map.get(key);
    g.jumlah++;
    g.nominal += Number(p.nominal || 0);
    g.dibayar += Number(p.dibayar || 0);
    g.sisa += Number(p.sisa || 0);
    if (p.sisa > 0) { g.aktif++; g.items.push(p); }
  }
  return [...map.values()].sort((a, b) => (b.sisa - a.sisa) || a.nama.localeCompare(b.nama, 'id'));
}

/* ==================================================================
   OTP PORTAL PUBLIK (pegawai / slip gaji)
   ================================================================== */
function otpCreate(jenis, ref, phone, minutes = 10) {
  const token = require('./lib').token(24);
  const kode = String(Math.floor(1000 + Math.random() * 9000));
  /* masa berlaku memakai jam WIB yang sama dengan nowStamp() saat verifikasi */
  const exp = require('./lib').plusMinutesStamp(minutes);
  db.prepare('DELETE FROM otp_code WHERE expires_at < ?').run(nowStamp());
  db.prepare('INSERT INTO otp_code (token,jenis,ref,phone,kode,expires_at,tries,verified,created_at) VALUES (?,?,?,?,?,?,0,0,?)')
    .run(token, jenis, String(ref || ''), String(phone || ''), kode, exp, nowStamp());
  return { token, kode, expires_at: exp };
}
function otpGet(token) { return token ? db.prepare('SELECT * FROM otp_code WHERE token=?').get(String(token)) : null; }function otpVerify(token, kode, maxTries = 5) {
  const row = otpGet(token);
  if (!row) return { ok: false, err: 'Sesi verifikasi tidak ditemukan. Silakan ulangi pencarian.' };
  if (row.verified) return { ok: true, row };
  if (String(row.expires_at) < nowStamp()) return { ok: false, err: 'Kode OTP sudah kedaluwarsa. Silakan ulangi pencarian.' };
  if (Number(row.tries) >= maxTries) return { ok: false, err: 'Terlalu banyak percobaan. Silakan ulangi pencarian.' };
  if (String(kode || '').trim() !== String(row.kode)) {
    db.prepare('UPDATE otp_code SET tries=tries+1 WHERE token=?').run(row.token);
    return { ok: false, err: 'Kode OTP salah. Periksa kembali pesan WhatsApp Anda.' };
  }
  db.prepare('UPDATE otp_code SET verified=1 WHERE token=?').run(row.token);
  return { ok: true, row: { ...row, verified: 1 } };
}

/* ==================================================================
   TAUTAN SLIP HONOR LANGSUNG (TANPA OTP)
   ------------------------------------------------------------------
   Slip honor dapat dikirim massal lewat WhatsApp. Tautan yang dikirim
   adalah URL bertoken: "<id-pegawai>.<hmac>" yang ditandatangani dengan
   `portal_token_secret` milik sekolah, sehingga pegawai langsung melihat
   slipnya tanpa menunggu/memasukkan kode OTP.
   ================================================================== */
function portalSecret() {
  let s = String(getSetting('portal_token_secret', '') || '').trim();
  if (s) return s;
  s = require('crypto').randomBytes(24).toString('hex');
  try { setSetting('portal_token_secret', s); } catch (e) { }
  return s;
}
/** token akses langsung slip honor pegawai (jenis di-scope agar tidak bisa dipakai lintas modul) */
function slipToken(pegawaiId, jenis) {
  const id = Number(pegawaiId) || 0;
  if (!id) return '';
  const scope = String(jenis || 'slip');
  const sig = require('crypto').createHmac('sha256', portalSecret()).update(scope + ':' + id).digest('hex').slice(0, 32);
  return `${id}.${sig}`;
}
/** verifikasi token slip; mengembalikan id pegawai (0 = tidak valid) */
function verifySlipToken(tok, jenis) {
  const m = /^(\d{1,12})\.([a-f0-9]{32})$/.exec(String(tok || '').trim());
  if (!m) return 0;
  const scope = String(jenis || 'slip');
  const want = require('crypto').createHmac('sha256', portalSecret()).update(scope + ':' + m[1]).digest('hex').slice(0, 32);
  try {
    if (!require('crypto').timingSafeEqual(Buffer.from(want, 'utf8'), Buffer.from(m[2], 'utf8'))) return 0;
  } catch (e) { return 0; }
  return Number(m[1]);
}

/* ==================================================================
   PESAN / CATATAN ORANG TUA (feedback loop)
   ================================================================== */
function portalPesanAdd({ siswa_id, nama, kontak, pesan, taId, sumber, ref }) {
  const info = db.prepare(`INSERT INTO portal_pesan (siswa_id,nama,kontak,pesan,status,tahun_ajaran_id,created_at,sumber,ref)
    VALUES (?,?,?,?,'baru',?,?,?,?)`).run(siswa_id || null, String(nama || '').slice(0, 160), String(kontak || '').slice(0, 60),
    String(pesan || ''), taId || null, nowStamp(), String(sumber || 'siswa').slice(0, 20), ref === undefined || ref === null ? '' : String(ref));
  return Number(info.lastInsertRowid);
}
function portalPesanList(opts = {}) {
  let sql = 'SELECT * FROM portal_pesan WHERE 1=1';
  const args = [];
  if (opts.status) { sql += ' AND status=?'; args.push(opts.status); }
  if (opts.sumber === 'siswa') sql += " AND COALESCE(NULLIF(sumber,''),'siswa')='siswa'";
  else if (opts.sumber) { sql += ' AND sumber=?'; args.push(opts.sumber); }
  sql += ' ORDER BY (status=\'selesai\'), id DESC LIMIT ' + (Number(opts.limit) || 100);
  return db.prepare(sql).all(...args);
}
function portalPesanCount() {
  return db.prepare("SELECT COUNT(*) c FROM portal_pesan WHERE status='baru'").get().c;
}
/** balasan pihak sekolah atas catatan orang tua (tidak mengubah isi catatan asli) */
function portalPesanReply(id, balasan, oleh, statusAfter) {
  const st = ['baru', 'selesai'].includes(String(statusAfter)) ? String(statusAfter) : 'selesai';
  const info = db.prepare('UPDATE portal_pesan SET balasan=?, balas_oleh=?, balas_at=?, status=?, selesai_at=?, selesai_by=? WHERE id=?')
    .run(String(balasan || ''), String(oleh || ''), nowStamp(), st,
      st === 'selesai' ? nowStamp() : null, st === 'selesai' ? String(oleh || '') : null, Number(id) || 0);
  return info.changes > 0;
}
/** hapus balasan (catatan kembali berstatus baru) */
function portalPesanReplyClear(id, oleh) {
  const info = db.prepare("UPDATE portal_pesan SET balasan=NULL, balas_oleh=NULL, balas_at=NULL, status='baru', selesai_at=NULL, selesai_by=NULL WHERE id=?")
    .run(Number(id) || 0);
  return info.changes > 0;
}

/* ==================================================================
   NOTIFIKASI INTERNAL (lonceng header)
   ------------------------------------------------------------------
   Baris ditujukan ke satu role (default bendahara = super_admin).
   Dibaca/ditandai per role (semua pengguna role tersebut melihat daftar
   yang sama) — cukup untuk notifikasi operasional seperti pembayaran
   manual baru dari portal orang tua.
   ================================================================== */
function notifAdd({ untuk = 'super_admin', jenis = 'umum', judul = '', isi = '', href = '', ref = '' }) {
  const info = db.prepare(`INSERT INTO notif (untuk,jenis,judul,isi,href,ref,dibaca,created_at)
    VALUES (?,?,?,?,?,?,0,?)`).run(String(untuk || 'super_admin'), String(jenis || 'umum').slice(0, 40),
    String(judul || '').slice(0, 200), String(isi || '').slice(0, 500),
    String(href || ''), String(ref === undefined || ref === null ? '' : ref), nowStamp());
  return Number(info.lastInsertRowid);
}
function notifTargets(role) {
  return [String(role || 'staff'), 'semua'];
}
function notifList(role, opts = {}) {
  const targets = notifTargets(role);
  const args = [...targets];
  let sql = `SELECT * FROM notif WHERE untuk IN (${targets.map(() => '?').join(',')})`;
  if (opts.hanyaBaru) sql += ' AND dibaca=0';
  sql += ' ORDER BY id DESC LIMIT ' + (Number(opts.limit) || 20);
  return db.prepare(sql).all(...args);
}
function notifCount(role) {
  const targets = notifTargets(role);
  return db.prepare(`SELECT COUNT(*) c FROM notif WHERE untuk IN (${targets.map(() => '?').join(',')}) AND dibaca=0`).get(...targets).c;
}
function notifRead(role, id, oleh) {
  const targets = notifTargets(role);
  if (id) return db.prepare(`UPDATE notif SET dibaca=1, baca_at=?, baca_by=? WHERE id=? AND untuk IN (${targets.map(() => '?').join(',')})`)
    .run(nowStamp(), String(oleh || ''), Number(id) || 0, ...targets).changes;
  return db.prepare(`UPDATE notif SET dibaca=1, baca_at=?, baca_by=? WHERE untuk IN (${targets.map(() => '?').join(',')}) AND dibaca=0`)
    .run(nowStamp(), String(oleh || ''), ...targets).changes;
}

/* ==================================================================
   CATATAN PEGAWAI → BENDAHARA
   ------------------------------------------------------------------
   Pegawai (pengguna yang login) melaporkan kekeliruan data (mis. nominal
   leger honor). Nama & jabatan diambil otomatis dari sesi login di server,
   pegawai hanya menulis isi pesan.
   status: 'baru' (belum dilihat) · 'diproses' (sudah dibalas/ditinjau) · 'selesai'
   ================================================================== */
const CATATAN_STATUS = { baru: 'Baru', diproses: 'Diproses', selesai: 'Selesai' };
function catatanAdd({ userId, nama, jabatan, pesan, terkait, periode, taId }) {
  const info = db.prepare(`INSERT INTO catatan_pegawai (user_id,nama,jabatan,pesan,terkait,periode,status,tahun_ajaran_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'baru',?,?,?)`).run(
    userId || null, String(nama || '').slice(0, 120), String(jabatan || '').slice(0, 120),
    String(pesan || ''), String(terkait || 'umum').slice(0, 40), String(periode || '').slice(0, 20),
    taId || null, nowStamp(), nowStamp());
  return Number(info.lastInsertRowid);
}
function catatanList(opts = {}) {
  let sql = 'SELECT * FROM catatan_pegawai WHERE 1=1';
  const args = [];
  if (opts.userId) { sql += ' AND user_id=?'; args.push(opts.userId); }
  if (opts.status) { sql += ' AND status=?'; args.push(opts.status); }
  if (opts.taId) { sql += ' AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)'; args.push(opts.taId); }
  if (opts.q) { sql += ' AND (nama LIKE ? OR pesan LIKE ? OR COALESCE(balasan,\'\') LIKE ?)'; args.push('%' + opts.q + '%', '%' + opts.q + '%', '%' + opts.q + '%'); }
  sql += " ORDER BY (status='selesai'), id DESC LIMIT " + (Number(opts.limit) || 200);
  return db.prepare(sql).all(...args);
}
function catatanCount(taId) {
  return taId
    ? db.prepare("SELECT COUNT(*) c FROM catatan_pegawai WHERE status<>'selesai' AND (tahun_ajaran_id=? OR tahun_ajaran_id IS NULL)").get(taId).c
    : db.prepare("SELECT COUNT(*) c FROM catatan_pegawai WHERE status<>'selesai'").get().c;
}
function catatanReply(id, { balasan, oleh, status }) {
  const row = db.prepare('SELECT * FROM catatan_pegawai WHERE id=?').get(id);
  if (!row) return null;
  const st = ['baru', 'diproses', 'selesai'].includes(status) ? status : (String(balasan || '').trim() ? 'diproses' : row.status);
  db.prepare('UPDATE catatan_pegawai SET balasan=?, balas_oleh=?, balas_at=?, status=?, updated_at=? WHERE id=?')
    .run(String(balasan || ''), String(oleh || ''), nowStamp(), st, nowStamp(), id);
  return db.prepare('SELECT * FROM catatan_pegawai WHERE id=?').get(id);
}
function catatanStatus(id, status) {
  const st = ['baru', 'diproses', 'selesai'].includes(status) ? status : 'baru';
  db.prepare('UPDATE catatan_pegawai SET status=?, updated_at=? WHERE id=?').run(st, nowStamp(), id);
  return db.prepare('SELECT * FROM catatan_pegawai WHERE id=?').get(id);
}
function catatanDelete(id) {
  const row = db.prepare('SELECT * FROM catatan_pegawai WHERE id=?').get(id);
  if (row) db.prepare('DELETE FROM catatan_pegawai WHERE id=?').run(id);
  return row || null;
}

/* ==================================================================
   BEASISWA: penerima per siswa
   ================================================================== */
function beasiswaSiswaList(beasiswaId) {
  return db.prepare(`SELECT bs.*, s.nama siswa_nama, s.nisn, k.nama kelas_nama
    FROM beasiswa_siswa bs JOIN siswa s ON s.id=bs.siswa_id LEFT JOIN kelas k ON k.id=s.kelas_id
    WHERE bs.beasiswa_id=? ORDER BY s.nama`).all(beasiswaId);
}


/* ==================================================================
   RESET DATA PER TAHUN PELAJARAN
   ------------------------------------------------------------------
   Menghapus seluruh RIWAYAT (transaksi BKU, penutupan periode, penetapan &
   pembayaran iuran, leger honor, honor ekskul, piutang, beasiswa, mutasi kas,
   SPP, mutasi aset) yang terikat pada satu tahun pelajaran.
   Master data (siswa, kelas, pegawai, CoA, daftar BKU) dan data tahun
   pelajaran LAIN tidak disentuh.
   ================================================================== */
function resetTaData(taId, user, opts = {}) {
  const ta = tahunById(taId);
  if (!ta) return { tables: {}, ta: null };
  const id = Number(ta.id);
  const r = taRange(ta);
  const pFrom = String(r.from).slice(0, 7);
  const pTo = String(r.to).slice(0, 7);
  const bkuIds = db.prepare('SELECT id FROM bku WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const qB = bkuIds.length ? bkuIds.map(() => '?').join(',') : '0';
  const argB = bkuIds.length ? bkuIds : [];
  const asetIds = db.prepare('SELECT id FROM aset WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const qA = asetIds.length ? asetIds.map(() => '?').join(',') : '0';
  const argA = asetIds.length ? asetIds : [];
  const tagIds = db.prepare('SELECT id FROM iuran_tagihan WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const qT = tagIds.length ? tagIds.map(() => '?').join(',') : '0';
  const argT = tagIds.length ? tagIds : [];
  const piutangIds = db.prepare('SELECT id FROM piutang WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const piuLainIds = db.prepare('SELECT id FROM piutang_lain WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const piuLainnyaIds = db.prepare('SELECT id FROM piutang_lainnya WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const beaIds = db.prepare('SELECT id FROM beasiswa WHERE tahun_ajaran_id=?').all(id).map(x => Number(x.id));
  const qIn = arr => (arr.length ? arr.map(() => '?').join(',') : '0');
  const arg = arr => (arr.length ? arr : []);
  const tables = {};
  const del = (name, sql, args) => {
    try { tables[name] = Number(db.prepare(sql).run(...(args || [])).changes || 0); } catch (e) { tables[name] = 0; }
  };

  // ---- cadangan JSON (maks 3 berkas, seperti purge-orphan) ----
  let backupFile = '';
  if (opts.cadangan !== false) {
    try {
      const snap = {};
      const grab = (name, sql, args) => { try { snap[name] = db.prepare(sql).all(...(args || [])); } catch (e) { snap[name] = []; } };
      grab('transaksi', `SELECT * FROM transaksi WHERE bku_id IN (${qB})`, argB);
      grab('bku_periode', `SELECT * FROM bku_periode WHERE bku_id IN (${qB})`, argB);
      grab('iuran_tagihan', `SELECT * FROM iuran_tagihan WHERE tahun_ajaran_id=?`, [id]);
      grab('iuran_bayar', `SELECT * FROM iuran_bayar WHERE tagihan_id IN (${qT})`, argT);
      grab('payroll', 'SELECT * FROM payroll WHERE substr(periode,1,7) BETWEEN ? AND ?', [pFrom, pTo]);
      grab('piutang', 'SELECT * FROM piutang WHERE tahun_ajaran_id=?', [id]);
      grab('piutang_lain', 'SELECT * FROM piutang_lain WHERE tahun_ajaran_id=?', [id]);
      grab('piutang_lainnya', 'SELECT * FROM piutang_lainnya WHERE tahun_ajaran_id=?', [id]);
      grab('beasiswa', 'SELECT * FROM beasiswa WHERE tahun_ajaran_id=?', [id]);
      grab('rekon_saldo_global', 'SELECT * FROM rekon_saldo_global WHERE tahun_ajaran_id=?', [id]);
      const dir = path.dirname(DB_PATH);
      const stamp = nowStamp().replace(/[-: ]/g, '').slice(0, 14);
      backupFile = path.join(dir, `reset-ta-${id}-${stamp}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({ created_at: nowStamp(), keterangan: `Cadangan sebelum reset data TA ${ta.nama}`, ta: ta.nama, tables: snap }, null, 2), 'utf8');
      const olds = fs.readdirSync(dir).filter(f => /^reset-ta-.*\.json$/.test(f)).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 3))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { }
      }
    } catch (e) { console.error('[reset-ta] gagal cadangan:', e.message); backupFile = ''; }
  }

  db.transaction(() => {
    del('iuran_bayar_trx', `DELETE FROM iuran_bayar WHERE tagihan_id IN (${qT})`, argT);
    del('iuran_tagihan', 'DELETE FROM iuran_tagihan WHERE tahun_ajaran_id=?', [id]);
    del('transaksi', `DELETE FROM transaksi WHERE bku_id IN (${qB})`, argB);
    del('bku_periode', `DELETE FROM bku_periode WHERE bku_id IN (${qB})`, argB);
    del('koreksi', `DELETE FROM koreksi WHERE bku_id IN (${qB})`, argB);
    del('bku_import', `DELETE FROM bku_import WHERE bku_id IN (${qB})`, argB);
    del('rekon_saldo', `DELETE FROM rekon_saldo WHERE bku_id IN (${qB})`, argB);
    del('rekon_saldo_global', 'DELETE FROM rekon_saldo_global WHERE tahun_ajaran_id=?', [id]);
    del('payroll', 'DELETE FROM payroll WHERE substr(periode,1,7) BETWEEN ? AND ?', [pFrom, pTo]);
    del('payroll_post', 'DELETE FROM payroll_post WHERE substr(periode,1,7) BETWEEN ? AND ?', [pFrom, pTo]);
    del('payroll_draft', 'DELETE FROM payroll_draft WHERE substr(periode,1,7) BETWEEN ? AND ?', [pFrom, pTo]);
    del('ekskul_honor', 'DELETE FROM ekskul_honor WHERE substr(periode,1,7) BETWEEN ? AND ?', [pFrom, pTo]);
    del('mutasi_kas', 'DELETE FROM mutasi_kas WHERE tahun_ajaran_id=?', [id]);
    del('spp', 'DELETE FROM spp WHERE tahun_ajaran_id=?', [id]);
    del('piutang_bayar', `DELETE FROM piutang_bayar WHERE piutang_id IN (${qIn(piutangIds)})`, arg(piutangIds));
    del('piutang', 'DELETE FROM piutang WHERE tahun_ajaran_id=?', [id]);
    del('piutang_lain_bayar', `DELETE FROM piutang_lain_bayar WHERE piutang_id IN (${qIn(piuLainIds)})`, arg(piuLainIds));
    del('piutang_lain', 'DELETE FROM piutang_lain WHERE tahun_ajaran_id=?', [id]);
    del('piutang_lainnya_bayar', `DELETE FROM piutang_lainnya_bayar WHERE piutang_id IN (${qIn(piuLainnyaIds)})`, arg(piuLainnyaIds));
    del('piutang_lainnya', 'DELETE FROM piutang_lainnya WHERE tahun_ajaran_id=?', [id]);
    del('beasiswa_siswa', `DELETE FROM beasiswa_siswa WHERE beasiswa_id IN (${qIn(beaIds)})`, arg(beaIds));
    del('beasiswa', 'DELETE FROM beasiswa WHERE tahun_ajaran_id=?', [id]);
    del('pinjaman_mutasi', `DELETE FROM pinjaman_mutasi WHERE aset_id IN (${qA})`, argA);
    // buku kas dikosongkan (tetap ada sebagai master) & dibuka kembali
    try {
      db.prepare(`UPDATE bku SET saldo_awal=0, status='aktif', ditutup_at=NULL, ditutup_oleh=NULL,
        saldo_akhir_tutup=NULL, berita_acara_no=NULL WHERE tahun_ajaran_id=?`).run(id);
    } catch (e) { }
    // akun aset TA ini dikosongkan saldo & ledger-nya
    try { db.prepare('UPDATE aset SET saldo=0 WHERE tahun_ajaran_id=?').run(id); } catch (e) { }
  })();

  // bersihkan sisa data hantu & sinkronkan status piutang
  try { beasiswaCleanup(); } catch (e) { }
  try { piutangSyncStatus(); } catch (e) { }
  try { piutangLainnyaSyncStatus(); } catch (e) { }
  return { tables, ta, backupFile };
}

/* ==================================================================
   BEASISWA ENFORCEMENT — pembayaran iuran otomatis & status terkunci
   ------------------------------------------------------------------
   Saat siswa ditetapkan sebagai penerima beasiswa pada sebuah grup iuran:
   - tagihan grup siswa tersebut dibuat bila belum ada (otomatis),
   - pembayaran otomatis dicatat (sumber='beasiswa', status='beasiswa',
     tanpa BKU/antrean posting) sehingga status grup menjadi LUNAS,
   - tagihan ditandai beasiswa_locked=1 → tidak bisa diedit/dihapus dari
     halaman Data Iuran; perubahan hanya lewat Modul Beasiswa.
   ================================================================== */
/** daftar grup iuran yang mendapat potongan satu beasiswa (fallback ke kolom lama) */
function beasiswaGrupList(beasiswaId) {
  const rows = db.prepare('SELECT * FROM beasiswa_grup WHERE beasiswa_id=? ORDER BY id').all(Number(beasiswaId) || 0);
  if (rows.length) return rows;
  const b = db.prepare('SELECT * FROM beasiswa WHERE id=?').get(Number(beasiswaId) || 0);
  return b && b.grup_id ? [{ grup_id: b.grup_id, bulan_mask: b.bulan_mask || '' }] : [];
}
function beasiswaGrupSet(beasiswaId, list) {
  const id = Number(beasiswaId) || 0;
  if (!id) return;
  db.prepare('DELETE FROM beasiswa_grup WHERE beasiswa_id=?').run(id);
  const ins = db.prepare('INSERT OR IGNORE INTO beasiswa_grup (beasiswa_id,grup_id,bulan_mask) VALUES (?,?,?)');
  for (const g of list || []) {
    const gid = Number(g.grup_id || g.id || 0);
    if (gid) ins.run(id, gid, String(g.bulan_mask || ''));
  }
}
function beasiswaShare(beasiswaRow, recips) {
  const b = beasiswaRow || {};
  const n = Math.max(1, (recips || []).length);
  const per = Number(b.nominal || 0) / n;
  return Math.round(per);
}
/** sinkronkan satu beasiswa: hapus jejak lama lalu tulis ulang pembayaran otomatis */
function beasiswaSync(beasiswaId) {
  const id = Number(beasiswaId) || 0;
  if (!id) return { rows: 0, students: 0 };
  const b = db.prepare('SELECT * FROM beasiswa WHERE id=?').get(id);
  let rows = 0, students = 0;
  db.transaction(() => {
    // bersihkan jejak sebelumnya (idempoten)
    db.prepare("DELETE FROM iuran_bayar WHERE sumber='beasiswa' AND beasiswa_id=?").run(id);
    db.prepare('UPDATE iuran_tagihan SET beasiswa_locked=0, beasiswa_id=NULL WHERE beasiswa_id=?').run(id);
    if (!b || !Number(b.aktif)) return;
    const glist = beasiswaGrupList(id);
    if (!glist.length) return;
    const recips = db.prepare('SELECT * FROM beasiswa_siswa WHERE beasiswa_id=?').all(id);
    if (!recips.length) return;
    // nominal tersimpan = nilai beasiswa untuk semua penerima → bagi rata per siswa
    const perSiswa = Math.max(0, Math.round(Number(b.nominal || 0) / recips.length)) || Number(b.nominal || 0);
    const ins = db.prepare(`INSERT INTO iuran_bayar (tagihan_id,siswa_id,tanggal,jumlah,potongan,dibayar,metode,keterangan,bku_id,transaksi_id,status,bulan,sumber,beasiswa_id,created_at)
      VALUES (?,?,?,?,?,?,'beasiswa',?,NULL,NULL,'beasiswa',?,'beasiswa',?,?)`);
    const tgl = todayISO();
    for (const r of recips) {
      let sisaShare = perSiswa;
      students++;
      for (const gg of glist) {
        const g = db.prepare('SELECT * FROM iuran_grup WHERE id=?').get(gg.grup_id);
        if (!g) continue;
        const tingkat = siswaTingkat(r.siswa_id, g.tahun_ajaran_id);
        const nom = iuranNominalMap(g.id, tingkat);
        const allMonths = BULAN_TA.filter(m => Number(nom[m] || 0) > 0);
        const mask = String(gg.bulan_mask || b.bulan_mask || '').split(',').map(Number).filter(Boolean);
        const months = g.jenis === 'bulanan'
          ? (mask.length ? allMonths.filter(m => mask.includes(m)) : allMonths)
          : [null];
        if (!months.length) continue;
        const total = g.jenis === 'bulanan'
          ? allMonths.reduce((a2, m) => a2 + Number(nom[m] || 0), 0)
          : Object.values(nom).reduce((a2, v) => a2 + Number(v || 0), 0);
        if (!(total > 0)) continue;
        let t = db.prepare('SELECT * FROM iuran_tagihan WHERE grup_id=? AND siswa_id=?').get(g.id, r.siswa_id);
        if (!t) {
          const info = db.prepare(`INSERT INTO iuran_tagihan (grup_id,siswa_id,tahun_ajaran_id,nominal,potongan,keterangan,created_at)
            VALUES (?,?,?,?,0,?,?)`).run(g.id, r.siswa_id, g.tahun_ajaran_id, total, 'Dibuat otomatis oleh beasiswa', nowStamp());
          t = { id: Number(info.lastInsertRowid), nominal: total };
        } else if (Number(t.nominal || 0) !== total) {
          db.prepare('UPDATE iuran_tagihan SET nominal=? WHERE id=?').run(total, t.id);
        }
        db.prepare('UPDATE iuran_tagihan SET beasiswa_locked=1, beasiswa_id=? WHERE id=?').run(id, t.id);
        const existing = db.prepare(`SELECT jumlah, potongan, dibayar, bulan FROM iuran_bayar
          WHERE tagihan_id=? AND status<>'void' ORDER BY tanggal, id`).all(t.id);
        const paidByMonth = g.jenis === 'bulanan'
          ? new Map(iuranMonthDetail(g.id, existing, tingkat).map(x => [x.bulan, x.dibayar]))
          : new Map();
        const paidTotal = g.jenis === 'bulanan'
          ? 0
          : existing.reduce((sum, p) => sum + Number(p.jumlah || 0), 0);
        for (const m of months) {
          const tagih = g.jenis === 'bulanan' ? Number(nom[m] || 0) : total;
          if (!(tagih > 0)) continue;
          const alreadyPaid = g.jenis === 'bulanan' ? Number(paidByMonth.get(m) || 0) : paidTotal;
          const available = Math.max(0, tagih - alreadyPaid);
          const wanted = Number(b.persen) > 0
            ? Math.round(tagih * Math.min(100, Number(b.persen)) / 100)
            : Math.min(tagih, sisaShare);
          const pakai = Math.min(available, wanted);
          if (!(Number(b.persen) > 0)) sisaShare -= pakai;
          if (!(pakai > 0)) continue;
          ins.run(t.id, r.siswa_id, tgl, pakai, 0, pakai,
            `Beasiswa ${b.nama}${m ? ' — ' + (NAMA_BULAN[m - 1] || '') : ''}`, m, id, nowStamp());
          rows++;
        }
      }
    }
  })();
  return { rows, students };
}
/** bersihkan pembayaran otomatis milik beasiswa yang sudah dihapus */
function beasiswaCleanup() {
  let n = 0;
  db.transaction(() => {
    n += db.prepare("DELETE FROM iuran_bayar WHERE sumber='beasiswa' AND (beasiswa_id IS NULL OR beasiswa_id NOT IN (SELECT id FROM beasiswa))").run().changes;
    n += db.prepare('UPDATE iuran_tagihan SET beasiswa_locked=0, beasiswa_id=NULL WHERE beasiswa_id IS NOT NULL AND beasiswa_id NOT IN (SELECT id FROM beasiswa)').run().changes;
  })();
  return n;
}
/** sinkronkan SEMUA beasiswa aktif (dipakai setelah perubahan penerima/grup) */
function beasiswaSyncAll() {
  let out = { rows: 0, students: 0, docs: 0 };
  for (const b of db.prepare('SELECT id FROM beasiswa').all()) {
    const r = beasiswaSync(b.id);
    out.rows += r.rows; out.students += r.students; out.docs++;
  }
  beasiswaCleanup();
  return out;
}

module.exports = {
  db, mainDb, DB_PATH, SAAS_DB_PATH, DEMO_DB_PATH, runAsDemo, ensureDemoDb, resetDemoDb, isDemoContext,
  rootDb, controlDb, runWithMeta, currentMeta, openTenantConn, runAsTenant, currentTenantConn, migrateTenantColumns, ensureTenantUniqueIndexes, createTenantDatabase, DATA_DIR, tableNamesOf,
  registerTimeFns, migrateLegacyTimestamps, TZ_LEGACY_SHIFT_HOURS, dateOffsetISO,
  getSetting, setSetting, settingsAll, logAudit, activeTahun, allTahun, allBku, allBkuRaw, bkuIuranGroups, bkuForIuranGrup, bkuRabRows, bkuRabSummary, autoBku,
  bkuSaldo, bkuIuranReceived, bkuUsesIuranSaldo, bkuIncomeEnabled, bkuTransactionVisibleSql, bkuRegularIncome, bkuTotals, bkuVisibleIncomeTotal, globalTotals, dbSizeBytes, storageQuotaBytes, storageInfo, kasBankTunai, asetKas, asetLain, pinjamanAkun,
  asetLedger, asetMutasi, pinjamanList, asetNonKasTotal,
  piutangPegawaiTotal, piutangSisa, sppTunggakan, sppPeriode, sppTerimaMap, sppTampil, sppSeries,
  COA_EXPENSE_KATEGORI, COA_INCOME_KATEGORI, KATEGORI_LABEL, effKategori, cloneTaMaster, cloneKelasTa, autoGraduateStudents, purgeGhostData,
  sertifikasiTampil, piutangLainRows, piutangLainSisa, piutangLainTotal, piutangLainNeraca, honorTugasJam,
  piutangLainnyaTampil, piutangKategoriList, piutangKategoriById, piutangKategoriByNama,
  piutangLainnyaRows, piutangLainnyaSisa, piutangLainnyaTotal, piutangLainnyaAset, piutangLainnyaAsetRows,
  piutangLainnyaRekap, piutangLainnyaSyncStatus,
  beasiswaTotal, beasiswaList,
  pegawaiList, payrollCalc, payrollRows, payrollTotals, payrollPost,
  PAYROLL_DEFAULT_COLS, PAYROLL_LEGACY, seedPayrollColumns, payrollKolomList, payrollKolomById, payrollKolomByKode,
  payrollKolomSave, payrollKolomDelete, payrollKolomReorder, payrollEval, payrollCompute, payrollNilaiMap,
  payrollDynamic, payrollNilaiSet, arusKasData, sertifikasiJam,
  piutangSyncStatus, payrollUnlockByTrx, payrollDraft, payrollDraftSet, payrollPeriods, payrollCopyPrev,
  stripCarryText, isCarryText, piutangBuckets, piutangBucketsAll, piutangRingkasan, cleanupOrphanPiutang, honorPembantuJam, honorWaliJam,
  totalSaldoDana, MODULES, ACTIONS, ROLE_LABEL, ROLES, DEMO_BLOCKED, defaultAllowed, BKU_AUTO_NAMES, isAutoBkuNama,
  tahunById, taOf, taRange, taOptions, taIdOfDate, taOfDate, bkuPadanan, resolveBkuTanggal, rolloverTa,
  JENJANG, TINGKAT_MASTER, TINGKAT_ALIAS, tingkatUrut, tingkatNaik, tingkatLabel, jenjangPreset,
  tingkatAktif, setTingkatAktif, applyJenjangPreset,
  NAMA_BULAN, periodeOf, periodeLabel, periodeStart, periodeEnd, prevPeriode, currentPeriode,
  periodeRow, periodeStatus, periodeLockError, periodeEditable, openingFor, monthTotals,
  periodePosisi, unclosedPeriods, removePeriodAdjustment, closePeriode, periodeListOf,
  // baru: trash, akademik, iuran, ekskul, tahun ajaran otomatis
  taAutoFor, taAutoId, TRASH_DAYS, TRASH_LABEL, trashAdd, trashList, trashPurge, trashRestore,
  SISWA_STATUS, programList, kelasList, kelasById, siswaList,
  penempatanList, penempatanSet, siswaSyncCurrent, taSortKey,
  BULAN_TA, iuranGrupList, iuranNominalMap, iuranTotalFor, siswaTingkat, iuranMonthDetail, iuranPaysMap, iuranTagihanRows, iuranRekapSiswa, iuranBayarRows,
  ekskulRows, ekskulPending, dedupeAset,
  // ronde 9: analitik iuran, rekap sertifikasi, OTP portal, pesan orang tua, beasiswa siswa
  iuranAnalytics, sertifikasiRekap, otpCreate, otpGet, otpVerify,
  portalSecret, slipToken, verifySlipToken,
  portalSlugs, portalPath, portalBaseSlug, setPortalBaseSlug, slugifySeg, portalSlugIsCustom, resetPortalSlugCache, portalDefaultAlias, portalRewrite, portalSlugError, normalizePortalSlug, RESERVED_SLUGS,
  PORTAL_SLUG_KEYS, PORTAL_SLUG_DEFAULT,
  portalPesanAdd, portalPesanList, portalPesanCount, beasiswaSiswaList, beasiswaGrupList, beasiswaGrupSet,
  portalPesanReply, portalPesanReplyClear, notifAdd, notifList, notifCount, notifRead, cloneBkuTa, nextBkuKode,
  newPublicToken, publicTokenEnsure, publicSetActive, publicFind,
  CATATAN_STATUS, catatanAdd, catatanList, catatanCount, catatanReply, catatanStatus, catatanDelete,
  beasiswaSync, beasiswaSyncAll, beasiswaCleanup, resetTaData,
  // tampilan (tema, branding, penataan menu) + petunjuk pengguna
  temaWarna, appNama, appSub, appSubGlobal, APP_SUB_DEFAULT, appLogo, navUi, setNavUi, TEMA_DEFAULT,
  // identitas resmi sekolah (NPSN, bentuk, status, kepemilikan, kontak)
  BENTUK_PENDIDIKAN, BENTUK_LABEL, STATUS_SEKOLAH, KEPEMILIKAN_OPTIONS, identitasSekolah,
  mainSetting, setMainSetting, temaWarnaGlobal, appNamaGlobal, appLogoGlobal, navUiGlobal, setNavUiGlobal,
  panduanList, panduanById, panduanSave, panduanDelete, panduanUrutkan
};
