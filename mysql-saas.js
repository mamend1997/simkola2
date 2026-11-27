'use strict';

const crypto = require('node:crypto');
const dbm = require('./db');
const lib = require('./lib');
const paygw = require('./paygw');

const PAKET = Object.freeze({ basic: 'Basic', standard: 'Standard', pro: 'Pro' });
const PAY_STATUS = Object.freeze({
  pending: { label: 'Menunggu', color: 'amber' },
  approved: { label: 'Disetujui', color: 'green' },
  rejected: { label: 'Ditolak', color: 'red' },
  issued: { label: 'Tagihan', color: 'blue' }
});
const SESSION_DAYS = 14;
const FEATURE_KEYS = Object.freeze([
  'dashboard', 'transaksi', 'rekon', 'mutasi_kas', 'tutup_bulanan', 'piutang', 'bku', 'coa',
  'anggaran', 'saldo_awal', 'aset', 'import', 'tahun_ajaran', 'laporan', 'pengguna', 'sekolah',
  'trash', 'audit', 'backup', 'panduan', 'siswa', 'kelas', 'program', 'mutasi_kelas', 'iuran',
  'pegawai', 'payroll', 'ekskul', 'beasiswa', 'piutang_lain', 'piutang_lainnya', 'catatan',
  'tarif_honor', 'backup_cloud', 'identitas', 'portal_publik', 'tema', 'desain_cetak',
  'pembantu_kas', 'pembantu_bank', 'pembantu_pajak', 'pembantu_bhp', 'pembantu_modal'
]);
const BASIC_FEATURES = Object.freeze(FEATURE_KEYS.filter(key => ![
  'piutang_lain', 'piutang_lainnya', 'pegawai', 'payroll', 'ekskul',
  'beasiswa', 'catatan', 'tarif_honor', 'backup_cloud'
].includes(key)));
const DEFAULT_SETTINGS = Object.freeze({
  saas_nama: 'SIMKOLA',
  saas_sub: 'Sistem Keuangan',
  saas_logo: '',
  saas_favicon: '',
  saas_tema: '#4F46E5',
  trial_hari: '7',
  paket_default: 'basic',
  captcha_provider: 'off',
  captcha_site_key: '',
  captcha_secret: '',
  reg_limit_per_hour: '2',
  reg_block_hours: '24',
  daftar_otp_aktif: '1',
  daftar_otp_menit: '10',
  daftar_otp_jeda: '60',
  daftar_otp_demo: '1',
  maintenance_aktif: '0',
  maintenance_pesan: '',
  maintenance_selesai: ''
});
const CORE_TABLES = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    school_code VARCHAR(16) NOT NULL UNIQUE,
    nama VARCHAR(191) NOT NULL,
    paket VARCHAR(64) NOT NULL DEFAULT 'standard',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    is_lifetime_free TINYINT NOT NULL DEFAULT 0,
    expires_at VARCHAR(32) NULL,
    registered_at VARCHAR(32) NULL,
    contact_nama VARCHAR(191) NULL,
    contact_email VARCHAR(320) NULL,
    contact_telp VARCHAR(64) NULL,
    alamat LONGTEXT NULL,
    db_file VARCHAR(1024) NULL,
    logo VARCHAR(1024) NULL,
    app_nama VARCHAR(191) NULL,
    tema VARCHAR(32) NULL,
    features LONGTEXT NULL,
    trial TINYINT NOT NULL DEFAULT 0,
    catatan LONGTEXT NULL,
    portal_status VARCHAR(32) NOT NULL DEFAULT 'aktif',
    portal_note LONGTEXT NULL,
    portal_locked_at VARCHAR(32) NULL,
    portal_locked_by VARCHAR(191) NULL,
    portal_slug VARCHAR(191) NULL,
    custom_domain VARCHAR(253) NULL,
    custom_domain_status VARCHAR(32) NULL,
    npsn VARCHAR(32) NULL,
    server_ip VARCHAR(64) NULL,
    harga_bulanan BIGINT NULL DEFAULT 0,
    harga_tahunan BIGINT NULL DEFAULT 0,
    harga_catatan LONGTEXT NULL,
    created_at VARCHAR(32) NULL,
    updated_at VARCHAR(32) NULL
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS saas_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    nama VARCHAR(191) NOT NULL,
    email VARCHAR(320) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(64) NOT NULL DEFAULT 'super_admin',
    aktif TINYINT NOT NULL DEFAULT 1,
    created_at VARCHAR(32) NULL,
    last_login VARCHAR(32) NULL,
    mfa_secret VARCHAR(128) NULL,
    mfa_pending_secret VARCHAR(128) NULL,
    mfa_recovery LONGTEXT NULL,
    mfa_enabled TINYINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(128) NOT NULL PRIMARY KEY,
    user_id BIGINT NULL,
    tenant_id BIGINT NULL,
    kind VARCHAR(64) NOT NULL DEFAULT 'tenant',
    expires_at VARCHAR(32) NULL,
    ta_id BIGINT NULL,
    alert_pending BIGINT NOT NULL DEFAULT 0,
    welcome LONGTEXT NULL,
    imp_by BIGINT NULL,
    created_at VARCHAR(32) NULL
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    identity_hash CHAR(64) NOT NULL,
    result VARCHAR(32) NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    INDEX idx_auth_attempts_identity (identity_hash,result,created_at)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS saas_packages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kode VARCHAR(64) NOT NULL UNIQUE,
    nama VARCHAR(191) NOT NULL,
    harga_bulan DOUBLE NOT NULL DEFAULT 0,
    harga_tahun DOUBLE NOT NULL DEFAULT 0,
    fitur LONGTEXT NULL,
    self_trial TINYINT NOT NULL DEFAULT 0,
    trial_hari BIGINT NULL,
    is_default TINYINT NOT NULL DEFAULT 0,
    aktif TINYINT NOT NULL DEFAULT 1,
    urutan BIGINT NOT NULL DEFAULT 0,
    keterangan LONGTEXT NULL,
    created_at VARCHAR(32) NULL,
    updated_at VARCHAR(32) NULL
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS reg_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ip VARCHAR(191) NOT NULL,
    email VARCHAR(320) NULL,
    hasil VARCHAR(64) NULL,
    created_at VARCHAR(32) NOT NULL,
    INDEX idx_reg_attempts_ip (ip,created_at)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS daftar_otp (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(128) NOT NULL UNIQUE,
    phone VARCHAR(32) NOT NULL,
    kode VARCHAR(8) NOT NULL,
    expires_at VARCHAR(32) NULL,
    expires_ms BIGINT NULL,
    created_ms BIGINT NULL,
    tries BIGINT NOT NULL DEFAULT 0,
    verified TINYINT NOT NULL DEFAULT 0,
    ip VARCHAR(64) NULL,
    created_at VARCHAR(32) NULL,
    verified_at VARCHAR(32) NULL,
    INDEX idx_daftar_otp_phone (phone,id),
    INDEX idx_daftar_otp_ip_time (ip,created_ms)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS saas_settings (
    k VARCHAR(191) NOT NULL PRIMARY KEY,
    v LONGTEXT NULL
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS saas_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL,
    user_nama VARCHAR(191) NULL,
    aksi VARCHAR(191) NULL,
    modul VARCHAR(191) NULL,
    detail LONGTEXT NULL,
    tenant_id BIGINT NULL,
    created_at VARCHAR(32) NULL,
    INDEX idx_saas_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
const REQUIRED_COLUMNS = {
  tenants: {
    portal_status: "VARCHAR(32) NOT NULL DEFAULT 'aktif'",
    portal_slug: 'VARCHAR(191) NULL',
    custom_domain: 'VARCHAR(253) NULL',
    custom_domain_status: 'VARCHAR(32) NULL',
    features: 'LONGTEXT NULL',
    is_lifetime_free: 'TINYINT NOT NULL DEFAULT 0',
    expires_at: 'VARCHAR(32) NULL',
    status: "VARCHAR(32) NOT NULL DEFAULT 'active'"
  },
  saas_users: {
    mfa_secret: 'VARCHAR(128) NULL',
    mfa_pending_secret: 'VARCHAR(128) NULL',
    mfa_recovery: 'LONGTEXT NULL',
    mfa_enabled: 'TINYINT NOT NULL DEFAULT 0',
    last_login: 'VARCHAR(32) NULL'
  },
  sessions: {
    tenant_id: 'BIGINT NULL',
    kind: "VARCHAR(64) NOT NULL DEFAULT 'tenant'",
    expires_at: 'VARCHAR(32) NULL',
    ta_id: 'BIGINT NULL',
    alert_pending: 'BIGINT NOT NULL DEFAULT 0',
    welcome: 'LONGTEXT NULL',
    imp_by: 'BIGINT NULL',
    created_at: 'VARCHAR(32) NULL'
  }
};

function createMysqlSaas({
  database = dbm.mysqlDatabase,
  authStore = dbm.mysqlAuthStore
} = {}) {
  if (!database || !authStore) throw new TypeError('Database dan auth store MySQL wajib tersedia untuk SaaS.');

  const settingCache = new Map(Object.entries(DEFAULT_SETTINGS));
  let initialized = false;

  async function columns(table) {
    const rows = await database.prepare(`SELECT COLUMN_NAME AS name
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`).all(table);
    return new Set(rows.map(row => String(row.name)));
  }

  async function ensureIndex(table, name, columnsSql, unique = false) {
    const found = await database.prepare(`SELECT 1 AS found FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1`).get(table, name);
    if (!found) {
      await database.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${columnsSql})`);
    }
  }

  async function initialize() {
    await database.withControl(async () => {
      for (const sql of CORE_TABLES) await database.query(sql);
      for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
        const present = await columns(table);
        for (const [name, definition] of Object.entries(required)) {
          if (!present.has(name)) {
            await database.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
            present.add(name);
          }
        }
      }
      await ensureIndex('auth_attempts', 'idx_auth_attempts_identity', '`identity_hash`,`result`,`created_at`');
      await ensureIndex('reg_attempts', 'idx_reg_attempts_ip', '`ip`,`created_at`');
      await ensureIndex('daftar_otp', 'idx_daftar_otp_phone', '`phone`,`id`');
      await ensureIndex('daftar_otp', 'idx_daftar_otp_ip_time', '`ip`,`created_ms`');
      await ensureIndex('saas_audit', 'idx_saas_audit_created', '`created_at`');
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        await database.prepare(`INSERT INTO saas_settings (k,v) VALUES (?,?)
          ON DUPLICATE KEY UPDATE k=VALUES(k)`).run(key, value);
      }
      const basic = await database.prepare("SELECT id FROM saas_packages WHERE kode='basic' LIMIT 1").get();
      if (!basic) {
        const existingPackages = await database.prepare('SELECT COUNT(*) AS c FROM saas_packages').get();
        const now = lib.nowStamp();
        await database.prepare(`INSERT INTO saas_packages
          (kode,nama,harga_bulan,harga_tahun,fitur,self_trial,trial_hari,is_default,aktif,urutan,keterangan,created_at,updated_at)
          VALUES ('basic','Basic',100000,1000000,?,1,7,?,1,1,?,?,?)`).run(
          JSON.stringify(BASIC_FEATURES),
          Number(existingPackages && existingPackages.c) ? 0 : 1,
          'Paket pendaftaran mandiri dengan masa uji coba 7 hari.',
          now,
          now
        );
      }
      const settings = await database.prepare('SELECT k,v FROM saas_settings').all();
      settingCache.clear();
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settingCache.set(key, value);
      for (const row of settings) settingCache.set(String(row.k), String(row.v == null ? '' : row.v));
    });
    initialized = true;
    return { initialized: true, tables: CORE_TABLES.length };
  }

  function requireInitialized() {
    if (!initialized) throw new Error('Control plane MySQL belum diinisialisasi. Jalankan initialize() sebelum menerima request.');
  }

  function get(key, fallback = '') {
    return settingCache.has(String(key)) ? settingCache.get(String(key)) : fallback;
  }

  async function set(key, value) {
    requireInitialized();
    const name = String(key);
    const normalized = String(value == null ? '' : value);
    await database.withControl(() => database.prepare(`INSERT INTO saas_settings (k,v) VALUES (?,?)
      ON DUPLICATE KEY UPDATE v=VALUES(v)`).run(name, normalized));
    settingCache.set(name, normalized);
    return normalized;
  }

  function settings() {
    return Object.fromEntries(settingCache);
  }

  function appName() { return String(get('saas_nama', 'SIMKOLA') || 'SIMKOLA').trim() || 'SIMKOLA'; }
  function appSub() { return String(get('saas_sub', 'Sistem Keuangan') || 'Sistem Keuangan').trim() || 'Sistem Keuangan'; }
  function appLogo() { return String(get('saas_logo', '') || '').trim(); }
  function tema() { return String(get('saas_tema', '#4F46E5') || '#4F46E5').trim(); }
  function todayISO() { return lib.todayISO(); }
  function addDays(iso, days) {
    const date = new Date(String(iso || todayISO()) + 'T12:00:00+07:00');
    date.setDate(date.getDate() + Number(days || 0));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function daysBetween(from, to) {
    const a = Date.parse(String(from || '').slice(0, 10) + 'T00:00:00Z');
    const b = Date.parse(String(to || '').slice(0, 10) + 'T00:00:00Z');
    return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86400000) : 0;
  }

  function featureDefaults(packageCode = 'standard') {
    return Object.fromEntries(FEATURE_KEYS.map(key => [key, packageCode === 'pro' ? 1 : 0]));
  }
  function tenantFeatures(tenant) {
    if (!tenant) return featureDefaults('pro');
    let raw = tenant.features || {};
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw || '{}'); } catch (error) {
        throw new Error(`Konfigurasi fitur tenant ${tenant.id} tidak valid.`, { cause: error });
      }
    }
    const base = featureDefaults(tenant.paket || 'standard');
    for (const key of FEATURE_KEYS) {
      if (raw[key] !== undefined) base[key] = Number(raw[key]) ? 1 : 0;
    }
    return base;
  }
  function enabledKeys(tenant) {
    const features = tenantFeatures(tenant);
    return FEATURE_KEYS.filter(key => features[key]);
  }
  function blockedFeature(tenant, pathname) {
    if (!tenant) return null;
    const feature = String(pathname || '').split('/').filter(Boolean)[0];
    return feature && tenantFeatures(tenant)[feature] === 0 ? feature : null;
  }

  async function allTenants() {
    requireInitialized();
    return database.withControl(() => database.prepare('SELECT * FROM tenants ORDER BY id').all());
  }
  async function tenantById(id) { requireInitialized(); return authStore.tenantById(id); }
  async function tenantByCode(code) { requireInitialized(); return authStore.tenantByCode(code); }
  async function tenantByDomain(host) {
    requireInitialized();
    const domain = String(host || '').split(':')[0].trim().toLowerCase();
    if (!domain) return null;
    const row = await database.withControl(() => database.prepare(`SELECT * FROM tenants
      WHERE LOWER(COALESCE(custom_domain,''))=? LIMIT 1`).get(domain));
    return row ? { tenant: row, verified: String(row.custom_domain_status || '').toUpperCase() === 'VERIFIED' } : null;
  }
  async function tenantByPortalSlug(slug) {
    requireInitialized();
    const value = String(slug || '').trim().toLowerCase();
    if (!value) return null;
    return database.withControl(() => database.prepare(`SELECT * FROM tenants
      WHERE LOWER(COALESCE(portal_slug,''))=? LIMIT 1`).get(value) || null);
  }
  async function tenantByPortalPrefix(slug) {
    const exact = await tenantByPortalSlug(slug);
    if (exact) return exact;
    const value = String(slug || '').trim().toLowerCase().replace(/[\\%_]/g, '\\$&');
    if (!value) return null;
    return database.withControl(() => database.prepare(`SELECT * FROM tenants
      WHERE LOWER(COALESCE(portal_slug,'')) LIKE ? ORDER BY id LIMIT 1`).get(value + '/%') || null);
  }

  function statusOf(tenant) {
    if (!tenant) return { key: 'missing', label: 'Tidak ditemukan', color: 'gray' };
    if (Number(tenant.is_lifetime_free)) return { key: 'lifetime', label: 'Aktif (Lifetime)', color: 'green' };
    if (String(tenant.status || '').toLowerCase() === 'suspended') return { key: 'suspended', label: 'Ditangguhkan', color: 'red' };
    const remaining = daysBetween(todayISO(), String(tenant.expires_at || '').slice(0, 10));
    if (!tenant.expires_at || remaining < 0) return { key: 'expired', label: 'Kedaluwarsa', color: 'red' };
    if (remaining <= 7) return { key: 'soon', label: 'Segera berakhir', color: 'amber' };
    return { key: 'active', label: 'Aktif', color: 'green' };
  }
  function isBlocked(tenant) {
    const status = statusOf(tenant);
    return status.key === 'expired' || status.key === 'suspended';
  }

  function maintenance() {
    return {
      aktif: String(get('maintenance_aktif', '0')) === '1',
      pesan: String(get('maintenance_pesan', '') || ''),
      selesai: String(get('maintenance_selesai', '') || ''),
      mulai: String(get('maintenance_aktif_sejak', '') || '')
    };
  }

  async function createSession(options) { requireInitialized(); return authStore.createSession(options); }
  async function getSession(token) { requireInitialized(); return authStore.getSession(token); }
  async function destroySession(token) { requireInitialized(); return authStore.destroySession(token); }
  async function updateSession(token, patch) { requireInitialized(); return authStore.updateSession(token, patch); }
  async function takeWelcome(token) {
    requireInitialized();
    if (!token) return null;
    return database.withControl(() => database.transaction(async tx => {
      const row = await tx.prepare('SELECT welcome FROM sessions WHERE token=? FOR UPDATE').get(String(token));
      if (!row || !row.welcome) return null;
      let value;
      try { value = JSON.parse(String(row.welcome)); } catch (error) {
        throw new Error('Data kredensial sambutan pada sesi tidak valid.', { cause: error });
      }
      await tx.prepare('UPDATE sessions SET welcome=NULL WHERE token=?').run(String(token));
      return value;
    }));
  }

  async function authIsLimited(identity, options) { requireInitialized(); return authStore.authIsLimited(identity, options); }
  async function authRecord(identity, success) { requireInitialized(); return authStore.authRecord(identity, success); }
  async function authenticateSchool(options) { requireInitialized(); return authStore.authenticateSchool(options); }
  async function schoolUserById(tenant, id) { requireInitialized(); return authStore.schoolUserById(tenant, id); }
  async function markSchoolLogin(tenant, id) { requireInitialized(); return authStore.markSchoolLogin(tenant, id); }
  async function findAdmin(email) {
    requireInitialized();
    return database.withControl(() => database.prepare(`SELECT * FROM saas_users
      WHERE LOWER(email)=LOWER(?) LIMIT 1`).get(String(email || '').trim()) || null);
  }
  async function adminById(id) { requireInitialized(); return authStore.adminById(id); }
  async function markAdminLogin(id) {
    requireInitialized();
    return database.withControl(() => database.prepare('UPDATE saas_users SET last_login=? WHERE id=?')
      .run(lib.nowStamp(), Number(id) || 0));
  }
  async function setAdminPassword(id, password) {
    requireInitialized();
    return database.withControl(() => database.prepare('UPDATE saas_users SET password=? WHERE id=?')
      .run(lib.hashPassword(password), Number(id) || 0));
  }

  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function base32Encode(buffer) {
    let bits = 0, value = 0, output = '';
    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits) output += BASE32[(value << (5 - bits)) & 31];
    return output;
  }
  function base32Decode(secret) {
    let bits = 0, value = 0;
    const output = [];
    for (const character of String(secret || '').toUpperCase().replace(/=+$/g, '').replace(/\s/g, '')) {
      const digit = BASE32.indexOf(character);
      if (digit < 0) throw new Error('Secret authenticator tidak valid.');
      value = (value << 5) | digit;
      bits += 5;
      if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(output);
  }
  function totpCode(secret, at = Date.now()) {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(Math.floor(Number(at) / 30000)));
    const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
    const offset = digest[digest.length - 1] & 15;
    const binary = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16)
      | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
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
    return Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('hex').match(/.{1,4}/g).join('-'));
  }
  async function mfaEnabled(id) {
    requireInitialized();
    const row = await database.withControl(() => database.prepare('SELECT mfa_enabled FROM saas_users WHERE id=?').get(Number(id) || 0));
    return !!(row && Number(row.mfa_enabled));
  }
  async function mfaStart(id) {
    requireInitialized();
    const secret = base32Encode(crypto.randomBytes(20));
    const result = await database.withControl(() => database.prepare('UPDATE saas_users SET mfa_pending_secret=? WHERE id=?')
      .run(secret, Number(id) || 0));
    if (!result.changes) throw new Error('Akun Super Admin tidak ditemukan.');
    return secret;
  }
  async function mfaPendingSecret(id) {
    requireInitialized();
    const row = await database.withControl(() => database.prepare('SELECT mfa_pending_secret FROM saas_users WHERE id=?')
      .get(Number(id) || 0));
    return String(row && row.mfa_pending_secret || '');
  }
  async function mfaEnable(id, code) {
    requireInitialized();
    return database.withControl(() => database.transaction(async tx => {
      const row = await tx.prepare('SELECT mfa_pending_secret,mfa_enabled FROM saas_users WHERE id=? FOR UPDATE')
        .get(Number(id) || 0);
      if (!row || Number(row.mfa_enabled)) throw new Error('MFA sudah aktif; masuk kembali untuk melanjutkan.');
      if (!row.mfa_pending_secret || !totpVerify(row.mfa_pending_secret, code)) {
        throw new Error('Kode authenticator tidak valid atau kedaluwarsa.');
      }
      const codes = newRecoveryCodes();
      const digests = codes.map(recoveryDigest);
      const result = await tx.prepare(`UPDATE saas_users SET mfa_secret=?,mfa_pending_secret=NULL,
        mfa_recovery=?,mfa_enabled=1 WHERE id=? AND mfa_enabled=0`)
        .run(row.mfa_pending_secret, JSON.stringify(digests), Number(id) || 0);
      if (!result.changes) throw new Error('MFA sudah aktif; masuk kembali untuk melanjutkan.');
      return codes;
    }));
  }
  async function mfaVerify(id, code) {
    requireInitialized();
    return database.withControl(() => database.transaction(async tx => {
      const row = await tx.prepare('SELECT mfa_secret,mfa_recovery,mfa_enabled FROM saas_users WHERE id=? FOR UPDATE')
        .get(Number(id) || 0);
      if (!row || !Number(row.mfa_enabled)) return false;
      if (totpVerify(row.mfa_secret, code)) return true;
      const digest = recoveryDigest(code);
      let recovery = [];
      try { recovery = JSON.parse(row.mfa_recovery || '[]'); } catch (error) {
        throw new Error('Daftar kode pemulihan Super Admin tidak valid.', { cause: error });
      }
      const match = recovery.findIndex(value => {
        const actual = Buffer.from(String(value || ''));
        const expected = Buffer.from(digest);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      });
      if (match < 0) return false;
      recovery.splice(match, 1);
      const result = await tx.prepare('UPDATE saas_users SET mfa_recovery=? WHERE id=?')
        .run(JSON.stringify(recovery), Number(id) || 0);
      return result.changes === 1;
    }));
  }
  async function mfaRecoveryCount(id) {
    requireInitialized();
    const row = await database.withControl(() => database.prepare('SELECT mfa_recovery FROM saas_users WHERE id=?')
      .get(Number(id) || 0));
    try { return JSON.parse(row && row.mfa_recovery || '[]').length; } catch (error) {
      throw new Error('Daftar kode pemulihan Super Admin tidak valid.', { cause: error });
    }
  }

  async function logSaas(user, action, moduleName, detail, tenantId) {
    requireInitialized();
    return database.withControl(() => database.prepare(`INSERT INTO saas_audit
      (user_id,user_nama,aksi,modul,detail,tenant_id,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      user ? Number(user.id) : null,
      user ? String(user.nama || 'Super Admin') : 'system',
      String(action || ''),
      String(moduleName || ''),
      String(detail || ''),
      Number(tenantId) || null,
      lib.nowStamp()
    ));
  }
  async function ensureAdmin() {
    requireInitialized();
    const existing = await database.withControl(() => database.prepare(
      "SELECT id,email FROM saas_users WHERE role='super_admin' ORDER BY id LIMIT 1").get());
    if (existing) return { created: false, email: existing.email };
    const email = String(process.env.SAAS_ADMIN_EMAIL || 'super@simkeu.id').trim().toLowerCase();
    const password = String(process.env.SAAS_ADMIN_PASSWORD || 'SuperAdmin2026!');
    await database.withControl(() => database.prepare(`INSERT INTO saas_users
      (nama,email,password,role,aktif,created_at,mfa_recovery,mfa_enabled)
      VALUES (?,?,?,'super_admin',1,?,'[]',0)`).run(
      'Super Admin Pusat', email, lib.hashPassword(password), lib.nowStamp()
    ));
    return { created: true, email };
  }

  function packageSelfTrial(pkg) {
    return !!(pkg && Number(pkg.self_trial));
  }
  function trialDays() {
    return Math.max(0, Number(get('trial_hari', '7')) || 0);
  }
  function packageTrialDays(pkg) {
    if (!pkg || pkg.trial_hari === null || pkg.trial_hari === undefined || pkg.trial_hari === '') {
      return trialDays();
    }
    const days = Number(pkg.trial_hari);
    return Number.isFinite(days) && days >= 0 ? days : trialDays();
  }
  async function packageRows(options = {}) {
    requireInitialized();
    return database.withControl(() => database.prepare(
      'SELECT * FROM saas_packages' + (options.all ? '' : ' WHERE aktif=1') + ' ORDER BY urutan,id'
    ).all());
  }
  async function packageByCode(code) {
    requireInitialized();
    return database.withControl(() => database.prepare(
      'SELECT * FROM saas_packages WHERE LOWER(kode)=LOWER(?) LIMIT 1'
    ).get(String(code || '').trim()) || null);
  }
  async function defaultPackage() {
    const rows = await packageRows();
    const preferred = String(get('paket_default', 'basic') || 'basic').toLowerCase();
    return rows.find(pkg => String(pkg.kode).toLowerCase() === preferred)
      || rows.find(pkg => Number(pkg.is_default))
      || rows[0]
      || null;
  }
  function packageFeatureMap(pkg, fallbackCode = 'basic') {
    const code = String(pkg && pkg.kode || fallbackCode || 'basic').toLowerCase();
    let raw = pkg && pkg.fitur;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw || 'null'); } catch (error) {
        throw new Error('Konfigurasi fitur paket tidak valid.', { cause: error });
      }
    }
    if (Array.isArray(raw)) {
      const selected = new Set(raw.map(String));
      return Object.fromEntries(FEATURE_KEYS.map(key => [key, selected.has(key) ? 1 : 0]));
    }
    if (raw && typeof raw === 'object') {
      const defaults = featureDefaults(code);
      return Object.fromEntries(FEATURE_KEYS.map(key => [
        key,
        raw[key] === undefined ? defaults[key] : (Number(raw[key]) ? 1 : 0)
      ]));
    }
    if (pkg && pkg.kode) {
      throw new Error(`Paket "${pkg.kode}" belum memiliki peta fitur yang valid.`);
    }
    return Object.fromEntries(FEATURE_KEYS.map(key => [key, BASIC_FEATURES.includes(key) ? 1 : 0]));
  }
  function clientIpOf(req) {
    const forwarded = String(req && req.headers
      && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) || '')
      .split(',')[0].trim();
    const ip = forwarded || String(req && req.socket && req.socket.remoteAddress || '').trim();
    return ip.replace(/^::ffff:/, '') || 'unknown';
  }
  function regLimits() {
    return {
      perHour: Math.max(1, Number(get('reg_limit_per_hour', '2')) || 2),
      blockHours: Math.max(0, Number(get('reg_block_hours', '24')) || 24)
    };
  }
  async function regLog(ip, email, result) {
    requireInitialized();
    const cutoff = addDays(todayISO(), -30) + ' 00:00:00';
    return database.withControl(() => database.transaction(async tx => {
      await tx.prepare('INSERT INTO reg_attempts (ip,email,hasil,created_at) VALUES (?,?,?,?)')
        .run(String(ip || '').slice(0, 191), String(email || '').slice(0, 320),
          String(result || '').slice(0, 64), lib.nowStamp());
      await tx.prepare('DELETE FROM reg_attempts WHERE created_at<?').run(cutoff);
    }));
  }
  async function regStatus(ip) {
    requireInitialized();
    const limits = regLimits();
    const ipKey = String(ip || '').slice(0, 191);
    return database.withControl(async () => {
      const rows = await database.prepare(`SELECT id,hasil,created_at FROM reg_attempts
        WHERE ip=? ORDER BY id DESC LIMIT 50`).all(ipKey);
      const blocked = rows.find(row => row.hasil === 'blocked');
      if (blocked) {
        const created = Date.parse(String(blocked.created_at || '').replace(' ', 'T'));
        const until = created + limits.blockHours * 60 * 60 * 1000;
        if (Number.isFinite(created) && Date.now() < until) {
          return {
            blocked: true,
            until,
            retryMin: Math.ceil((until - Date.now()) / 60000),
            count: rows.length
          };
        }
      }
      const countRow = await database.prepare(`SELECT COUNT(*) AS c FROM reg_attempts
        WHERE ip=? AND created_at>=? AND hasil IN ('sukses','gagal')`)
        .get(ipKey, lib.plusMinutesStamp(-60));
      return { blocked: false, count: Number(countRow && countRow.c) || 0, limit: limits.perHour };
    });
  }
  async function regHit(ip, email, result) {
    const limits = regLimits();
    const status = await regStatus(ip);
    if (status.blocked) return { blocked: true, ...status };
    await regLog(ip, email, result);
    const after = await regStatus(ip);
    if (!after.blocked && after.count > limits.perHour && result !== 'blocked') {
      await regLog(ip, email, 'blocked');
      return { blocked: true, ...(await regStatus(ip)), justBlocked: true };
    }
    return { blocked: false, ...after };
  }
  function captchaConfig() {
    return {
      provider: String(get('captcha_provider', 'off') || 'off'),
      siteKey: String(get('captcha_site_key', '') || '')
    };
  }
  async function verifyCaptcha(token, ip) {
    const provider = String(get('captcha_provider', 'off') || 'off');
    if (provider === 'off') return null;
    const secret = String(get('captcha_secret', '') || '');
    if (!secret) return null;
    const response = String(token || '').trim();
    if (!response) return 'Verifikasi keamanan (captcha) gagal. Muat ulang halaman lalu coba lagi.';
    const url = provider === 'turnstile'
      ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
      : 'https://www.google.com/recaptcha/api/siteverify';
    try {
      const body = new URLSearchParams({ secret, response });
      if (ip) body.set('remoteip', String(ip));
      const result = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const data = await result.json();
      if (!data || data.success !== true) return 'Verifikasi keamanan (captcha) gagal. Silakan coba lagi.';
      if (provider === 'recaptcha' && data.score !== undefined && Number(data.score) < 0.4) {
        return 'Permintaan terdeteksi otomatis (skor keamanan rendah). Silakan coba lagi.';
      }
      return null;
    } catch (error) {
      return 'Verifikasi keamanan tidak dapat dihubungi. Coba beberapa saat lagi.';
    }
  }
  function daftarOtpCfg() {
    const number = (key, fallback, min, max) => {
      const parsed = Number(get(key, String(fallback)));
      return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
    };
    const truth = (value, fallback) => value === undefined || value === null || value === ''
      ? fallback
      : /^(1|true|on|ya|yes)$/i.test(String(value).trim());
    return {
      aktif: truth(get('daftar_otp_aktif', '1'), true),
      menit: number('daftar_otp_menit', 10, 1, 60),
      jeda: number('daftar_otp_jeda', 60, 0, 600),
      demo: truth(get('daftar_otp_demo', '1'), true),
      maxPerJam: 5
    };
  }
  async function sendRegistrationWA(phone, message) {
    const url = String(process.env.WA_API_URL || get('wa_api_url', '') || '').trim();
    const token = String(process.env.WA_API_TOKEN || get('wa_api_token', '') || '').trim();
    const payload = String(process.env.WA_API_PAYLOAD || get('wa_payload', 'form') || 'form').toLowerCase();
    const target = lib.normPhone(phone);
    if (!url) return { ok: false, demo: daftarOtpCfg().demo, reason: 'Gateway WhatsApp pusat belum diatur.' };
    if (!target) return { ok: false, demo: false, reason: 'Nomor WhatsApp tidak valid.' };
    const headers = { Authorization: token };
    let body;
    if (payload === 'json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ target, phone: target, message, type: 'text' });
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ target, phone: target, message, type: 'text' }).toString();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      const raw = await response.text();
      if (!response.ok) return { ok: false, demo: false, reason: `Gateway menolak (HTTP ${response.status}).`, raw: raw.slice(0, 300) };
      return { ok: true, raw: raw.slice(0, 300) };
    } catch (error) {
      return { ok: false, demo: false, reason: `Gagal menghubungi gateway WhatsApp: ${error.message}` };
    } finally {
      clearTimeout(timeout);
    }
  }
  async function otpDaftarSend(phoneRaw, ip) {
    requireInitialized();
    const cfg = daftarOtpCfg();
    if (!cfg.aktif) return { ok: false, err: 'Verifikasi OTP sedang dinonaktifkan.' };
    const target = lib.normPhone(phoneRaw);
    if (!target) return { ok: false, err: 'Nomor WhatsApp tidak valid. Gunakan format 08xx… atau 62xx…' };
    const now = Date.now();
    const ipKey = String(ip || '').slice(0, 60);
    const guard = await database.withControl(async () => {
      await database.prepare('DELETE FROM daftar_otp WHERE created_ms<?').run(now - 24 * 60 * 60 * 1000);
      const last = await database.prepare(`SELECT created_ms FROM daftar_otp
        WHERE phone=? ORDER BY id DESC LIMIT 1`).get(target);
      if (last && cfg.jeda > 0) {
        const seconds = Math.ceil((Number(last.created_ms || 0) + cfg.jeda * 1000 - now) / 1000);
        if (seconds > 0) return { err: `Tunggu ${seconds} detik sebelum meminta kode baru.` };
      }
      const perPhone = await database.prepare(`SELECT COUNT(*) AS c FROM daftar_otp
        WHERE phone=? AND created_ms>=?`).get(target, now - 60 * 60 * 1000);
      if (Number(perPhone && perPhone.c) >= cfg.maxPerJam) {
        return { err: 'Terlalu banyak permintaan kode untuk nomor ini. Coba lagi dalam 1 jam.' };
      }
      if (ipKey) {
        const perIp = await database.prepare(`SELECT COUNT(*) AS c FROM daftar_otp
          WHERE ip=? AND created_ms>=?`).get(ipKey, now - 60 * 60 * 1000);
        if (Number(perIp && perIp.c) >= cfg.maxPerJam * 3) {
          return { err: 'Terlalu banyak permintaan OTP dari jaringan ini. Coba lagi nanti.' };
        }
      }
      return {};
    });
    if (guard.err) return { ok: false, err: guard.err };
    const code = String(crypto.randomInt(1000, 10000));
    const token = lib.token(16);
    const expiresMs = now + cfg.menit * 60 * 1000;
    await database.withControl(() => database.prepare(`INSERT INTO daftar_otp
      (token,phone,kode,expires_at,expires_ms,created_ms,tries,verified,ip,created_at)
      VALUES (?,?,?,?,?,?,0,0,?,?)`).run(
      token, target, code, lib.plusMinutesStamp(cfg.menit), expiresMs, now, ipKey, lib.nowStamp()
    ));
    const sent = await sendRegistrationWA(target,
      `*Pendaftaran Sekolah Baru*\nKode OTP pendaftaran Anda: *${code}*\n\nKode berlaku ${cfg.menit} menit. Jangan bagikan kode ini kepada siapa pun.`);
    const demo = !sent.ok && cfg.demo;
    await logSaas(null, sent.ok ? 'OTP DAFTAR TERKIRIM' : (demo ? 'OTP DAFTAR MODE UJI' : 'OTP DAFTAR GAGAL'),
      'daftar', `${target} → ${sent.ok ? 'kode terkirim via WhatsApp' : (sent.reason || 'gateway belum aktif')}`);
    return { ok: true, token, menit: cfg.menit, target, demo, demo_kode: demo ? code : '', kirim: sent };
  }
  async function otpDaftarVerify(token, code) {
    requireInitialized();
    const value = String(token || '').trim();
    if (!value) return { ok: false, err: 'Sesi verifikasi tidak ditemukan. Silakan kirim ulang kode OTP.' };
    const result = await database.withControl(() => database.transaction(async tx => {
      const row = await tx.prepare('SELECT * FROM daftar_otp WHERE token=? FOR UPDATE').get(value);
      if (!row) return { ok: false, err: 'Sesi verifikasi tidak ditemukan. Silakan kirim ulang kode OTP.' };
      if (Number(row.verified)) return { ok: true, row };
      if (Number(row.expires_ms || 0) && Number(row.expires_ms) < Date.now()) {
        return { ok: false, err: 'Kode OTP sudah kedaluwarsa. Silakan kirim ulang kode baru.' };
      }
      if (Number(row.tries) >= 5) return { ok: false, err: 'Terlalu banyak percobaan. Kirim ulang kode OTP baru.' };
      const submitted = String(code || '').replace(/\D/g, '');
      if (!/^\d{4}$/.test(submitted) || submitted !== String(row.kode)) {
        await tx.prepare('UPDATE daftar_otp SET tries=tries+1 WHERE token=?').run(value);
        return { ok: false, err: 'Kode OTP salah. Periksa kembali pesan WhatsApp Anda.' };
      }
      await tx.prepare('UPDATE daftar_otp SET verified=1,verified_at=? WHERE token=?')
        .run(lib.stampID(), value);
      return { ok: true, row: { ...row, verified: 1 } };
    }));
    if (result.ok) await logSaas(null, 'OTP DAFTAR VERIFIKASI', 'daftar',
      `Nomor ${result.row.phone} berhasil diverifikasi`);
    return result;
  }
  async function otpDaftarValid(token, phoneRaw) {
    requireInitialized();
    const value = String(token || '').trim();
    const row = value
      ? await database.withControl(() => database.prepare('SELECT * FROM daftar_otp WHERE token=?').get(value))
      : null;
    if (!row) return { ok: false, err: 'Verifikasi nomor WhatsApp belum dilakukan. Klik "Kirim Kode OTP" lalu masukkan kodenya.' };
    if (!Number(row.verified)) return { ok: false, err: 'Kode OTP belum diverifikasi. Masukkan 4 digit kode dari WhatsApp Anda.' };
    if (Number(row.expires_ms || 0) && Number(row.expires_ms) < Date.now()) {
      return { ok: false, err: `Verifikasi OTP sudah kedaluwarsa (lebih dari ${daftarOtpCfg().menit} menit). Silakan verifikasi ulang.` };
    }
    const phone = lib.normPhone(phoneRaw);
    if (!phone || phone !== String(row.phone)) {
      return { ok: false, err: 'Nomor WhatsApp yang diisi berbeda dengan nomor yang diverifikasi. Verifikasi ulang nomor tersebut.' };
    }
    return { ok: true, row, phone };
  }
  function newSchoolCode(used) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 4000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
      if (!used.has(code)) return code;
    }
    throw new Error('Gagal membuat kode sekolah unik. Coba lagi.');
  }
  async function phoneAlreadyRegistered(phoneRaw) {
    const phone = lib.normPhone(phoneRaw);
    if (!phone) return false;
    const tenants = await allTenants();
    for (const tenant of tenants) {
      if (lib.normPhone(tenant.contact_telp) === phone) return true;
      const value = await database.withTenant(tenant, () => dbm.mysqlHelpers.getSetting('sekolah_telp', ''));
      if (lib.normPhone(value) === phone) return true;
    }
    return false;
  }
  async function createTenant(input = {}) {
    requireInitialized();
    const name = String(input.nama || '').trim();
    const email = String(input.admin_email || '').trim().toLowerCase();
    if (!name) throw new Error('Nama sekolah wajib diisi.');
    if (name.length > 191) throw new Error('Nama sekolah maksimal 191 karakter.');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Email admin sekolah tidak valid.');
    if (email.length > 320 || email.split('@')[0].length > 191) throw new Error('Email/username admin terlalu panjang.');
    if (String(input.admin_nama || '').trim().length > 191) throw new Error('Nama admin maksimal 191 karakter.');
    const password = String(input.admin_password || '');
    if (password.length < 8 || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      throw new Error('Password minimal 8 karakter dan wajib memuat huruf besar, angka, serta simbol.');
    }
    const packageCode = String(input.paket || '').trim().toLowerCase();
    const pkg = await packageByCode(packageCode);
    if (!pkg || !Number(pkg.aktif)) throw new Error('Paket pendaftaran tidak tersedia.');
    if (!packageSelfTrial(pkg)) throw new Error('Paket ini tidak menerima pendaftaran mandiri.');
    const now = lib.nowStamp();
    const trialDays = Math.min(365, packageTrialDays(pkg));
    const expiresAt = addDays(todayISO(), trialDays);
    const schoolFeatures = packageFeatureMap(pkg, packageCode);
    const registration = await database.withControl(() => database.transaction(async tx => {
      const lockName = 'simkola:tenant-registration';
      const lock = await tx.prepare('SELECT GET_LOCK(?,10) AS acquired').get(lockName);
      if (Number(lock && lock.acquired) !== 1) throw new Error('Pendaftaran sekolah lain sedang diproses. Silakan coba kembali.');
      try {
        const next = await tx.prepare(`SELECT AUTO_INCREMENT AS next_id FROM information_schema.TABLES
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenants'`).get();
        const tenantId = Number(next && next.next_id);
        if (!Number.isInteger(tenantId) || tenantId < 1) {
          throw new Error('ID tenant berikutnya tidak dapat ditentukan dari database control plane.');
        }
        dbm.mysqlRuntime.schoolDatabaseName(tenantId);
        const existingCodes = await tx.prepare('SELECT school_code FROM tenants').all();
        const code = newSchoolCode(new Set(existingCodes.map(row => String(row.school_code || '').toUpperCase())));
        const inserted = await tx.prepare(`INSERT INTO tenants
          (school_code,nama,paket,status,is_lifetime_free,expires_at,registered_at,contact_nama,contact_email,contact_telp,
           alamat,db_file,logo,app_nama,tema,features,trial,created_at,updated_at)
          VALUES (?,?,?,'active',0,?,?,?,?,?,?,?, ?,?,?,?,1,?,?)`).run(
          code,
          name,
          packageCode,
          expiresAt,
          todayISO(),
          String(input.admin_nama || '').trim(),
          email,
          lib.normPhone(input.contact_telp) || '',
          String(input.alamat || '').trim(),
          '',
          String(get('saas_logo', '') || ''),
          String(input.app_nama || appName()),
          String(input.tema || tema()),
          JSON.stringify(schoolFeatures),
          now,
          now
        );
        if (Number(inserted.lastInsertRowid) !== tenantId) {
          throw new Error('ID tenant berubah saat pendaftaran. Pastikan pemetaan database MySQL tenant sesuai.');
        }
        return { tenantId, code };
      } finally {
        await tx.prepare('SELECT RELEASE_LOCK(?) AS released').get(lockName);
      }
    }));
    const { tenantId, code } = registration;
    let tenant = { id: tenantId };
    try {
      const databaseName = dbm.mysqlRuntime.schoolDatabaseName(tenantId);
      tenant = await tenantById(tenantId);
      if (!tenant) throw new Error('Data tenant yang baru dibuat tidak dapat dibaca.');
      await database.withTenant(tenant, async () => {
        const tables = await dbm.mysqlHelpers.tableNames();
        for (const table of tables) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('Nama tabel pada database tenant tidak valid.');
          const row = await database.prepare(`SELECT 1 AS found FROM \`${table}\` LIMIT 1`).get();
          if (row) throw new Error(`Database MySQL tenant ${tenantId} (${databaseName}) sudah berisi data. Gunakan database khusus yang kosong.`);
        }
      });
      await database.withControl(() => database.prepare(
        'UPDATE tenants SET db_file=?,updated_at=? WHERE id=?'
      ).run(databaseName, now, tenantId));
      tenant.db_file = databaseName;
      await dbm.initializeSchema(tenant);
      await database.withTenant(tenant, () => database.transaction(async tx => {
        const settings = {
          tenant_id: String(tenantId),
          tenant_kode: code,
          sekolah_nama: name,
          sekolah_alamat: String(input.alamat || '').trim(),
          sekolah_kepala: '',
          sekolah_telp: lib.normPhone(input.contact_telp) || '',
          sekolah_email: email,
          sekolah_logo: String(get('saas_logo', '') || ''),
          app_nama: String(input.app_nama || appName()),
          tema_warna: String(input.tema || tema()),
          jenjang_pendidikan: String(input.jenjang || ''),
          tingkat_aktif: '[]'
        };
        for (const [key, value] of Object.entries(settings)) {
          await tx.prepare(`INSERT INTO settings (k,v,tenant_id) VALUES (?,?,?)
            ON DUPLICATE KEY UPDATE v=VALUES(v),tenant_id=VALUES(tenant_id)`).run(key, value, tenantId);
        }
        await tx.prepare(`INSERT INTO users
          (nama,email,password,role,aktif,jabatan,username,created_at,tenant_id)
          VALUES (?,?,?,'super_admin',1,'Administrator Sekolah',?,?,?)`).run(
          String(input.admin_nama || 'Administrator Sekolah').trim(),
          email,
          lib.hashPassword(password),
          email.split('@')[0],
          now,
          tenantId
        );
      }));
      try {
        await logSaas(null, 'DAFTAR', 'tenant',
          `Sekolah ${name} (${code}) didaftarkan dengan paket ${packageCode}; database MySQL tenant ${tenantId} disiapkan.`,
          tenantId);
      } catch (error) {
        console.error('[mysql-register-audit]', error.message);
      }
      return tenant;
    } catch (error) {
      await database.withControl(() => database.prepare('DELETE FROM tenants WHERE id=?').run(tenantId));
      throw new Error(`Pendaftaran tenant ${tenantId} dibatalkan: ${error.message}`, { cause: error });
    }
  }
  async function ensureBootstrap() {
    const admin = await ensureAdmin();
    const tenants = await allTenants();
    if (!tenants.length) throw new Error('Belum ada tenant sekolah pada database control plane MySQL.');
    return admin;
  }

  return {
    db: null,
    C: null,
    DB_DRIVER: 'mysql',
    PAKET,
    PAY_STATUS,
    FEATURES: FEATURE_KEYS.map(key => ({ key, label: key, std: 1 })),
    FEATURE_MAP: {},
    PATH_FEATURES: [],
    SESSION_DAYS,
    paygw,
    initialize,
    isInitialized: () => initialized,
    get,
    set,
    settings,
    appName,
    appSub,
    appLogo,
    tema,
    todayISO,
    addDays,
    daysBetween,
    featureDefaults,
    tenantFeatures,
    enabledKeys,
    blockedFeature,
    allTenants,
    tenantById,
    tenantByCode,
    tenantByDomain,
    tenantByPortalSlug,
    tenantByPortalPrefix,
    statusOf,
    isBlocked,
    maintenance,
    createSession,
    getSession,
    destroySession,
    updateSession,
    takeWelcome,
    authIsLimited,
    authRecord,
    authenticateSchool,
    schoolUserById,
    markSchoolLogin,
    findAdmin,
    adminById,
    markAdminLogin,
    setAdminPassword,
    mfaEnabled,
    mfaStart,
    mfaPendingSecret,
    mfaEnable,
    mfaVerify,
    mfaRecoveryCount,
    logSaas,
    ensureAdmin,
    ensureBootstrap,
    packageSelfTrial,
    packageTrialDays,
    packageRows,
    packageByCode,
    defaultPackage,
    packageFeatureMap,
    clientIpOf,
    regLimits,
    regLog,
    regStatus,
    regHit,
    captchaConfig,
    verifyCaptcha,
    daftarOtpCfg,
    otpDaftarSend,
    otpDaftarVerify,
    otpDaftarValid,
    phoneAlreadyRegistered,
    createTenant
  };
}

module.exports = createMysqlSaas();
module.exports.createMysqlSaas = createMysqlSaas;
