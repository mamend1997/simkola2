'use strict';

const crypto = require('node:crypto');
const lib = require('./lib');

const SESSION_DAYS = 14;
const SESSION_PATCH_COLUMNS = new Set(['ta_id', 'alert_pending', 'welcome', 'expires_at']);

function createMysqlAuthStore(database) {
  if (!database || typeof database.withControl !== 'function' || typeof database.withTenant !== 'function'
    || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    throw new TypeError('Database async MySQL tidak valid untuk autentikasi.');
  }

  function identityHash(identity) {
    return crypto.createHash('sha256')
      .update(String(identity || '').trim().toLowerCase())
      .digest('hex');
  }

  function tenantById(id) {
    const tenantId = Number(id) || 0;
    return database.withControl(async () => (
      await database.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId)
    ) || null);
  }

  function tenantByCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return Promise.resolve(null);
    return database.withControl(async () => (
      await database.prepare('SELECT * FROM tenants WHERE UPPER(school_code)=?').get(normalized)
    ) || null);
  }

  function schoolUserByIdentity(tenant, identity) {
    const ident = String(identity || '').trim();
    if (!tenant || !Number.isInteger(Number(tenant.id)) || Number(tenant.id) < 1) {
      return Promise.reject(new Error('Tenant sekolah tidak valid.'));
    }
    return database.withTenant(tenant, async () => database.prepare(`SELECT *
      FROM users
      WHERE LOWER(email)=LOWER(?) OR LOWER(COALESCE(username,''))=LOWER(?)
      ORDER BY id LIMIT 1`).get(ident, ident) || null);
  }

  function schoolUserById(tenant, userId) {
    if (!tenant || !Number.isInteger(Number(tenant.id)) || Number(tenant.id) < 1) {
      return Promise.reject(new Error('Tenant sekolah tidak valid.'));
    }
    return database.withTenant(tenant, async () => database.prepare(`SELECT
      id,nama,email,role,aktif,jabatan,foto,username
      FROM users WHERE id=?`).get(Number(userId) || 0) || null);
  }

  async function createSession({ userId, tenantId, kind, alertPending, welcome, expiresMinutes } = {}) {
    const token = lib.token(24);
    const expiresAt = expiresMinutes
      ? lib.plusMinutesStamp(Number(expiresMinutes))
      : lib.plusDaysStamp(SESSION_DAYS);
    await database.withControl(() => database.prepare(`INSERT INTO sessions
      (token,user_id,tenant_id,kind,expires_at,alert_pending,ta_id,created_at,welcome)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      token,
      Number(userId) || null,
      Number(tenantId) || null,
      String(kind || 'tenant'),
      expiresAt,
      Number(alertPending) || 0,
      null,
      lib.nowStamp(),
      welcome ? String(welcome) : null
    ));
    return token;
  }

  async function getSession(token) {
    const sessionToken = String(token || '');
    if (!sessionToken) return null;
    return database.withControl(async () => {
      const row = await database.prepare('SELECT * FROM sessions WHERE token=?').get(sessionToken);
      if (!row) return null;
      if (String(row.expires_at || '') < lib.nowStamp()) {
        await database.prepare('DELETE FROM sessions WHERE token=?').run(sessionToken);
        return null;
      }
      return row;
    });
  }

  async function destroySession(token) {
    const sessionToken = String(token || '');
    if (!sessionToken) return { changes: 0, lastInsertRowid: 0 };
    return database.withControl(() => database.prepare('DELETE FROM sessions WHERE token=?').run(sessionToken));
  }

  async function updateSession(token, patch = {}) {
    const entries = Object.entries(patch);
    if (!entries.length) return { changes: 0, lastInsertRowid: 0 };
    for (const [key] of entries) {
      if (!SESSION_PATCH_COLUMNS.has(key)) throw new Error(`Kolom sesi tidak diizinkan: ${key}`);
    }
    const assignments = entries.map(([key]) => `\`${key}\`=?`).join(',');
    const values = entries.map(([, value]) => value);
    values.push(String(token || ''));
    return database.withControl(() => database.prepare(`UPDATE sessions SET ${assignments} WHERE token=?`).run(...values));
  }

  async function adminById(id) {
    return database.withControl(async () => (
      await database.prepare('SELECT * FROM saas_users WHERE id=?').get(Number(id) || 0)
    ) || null);
  }

  async function authIsLimited(identity, { limit = 5, windowMinutes = 15 } = {}) {
    const hash = identityHash(identity);
    const cutoff = lib.plusMinutesStamp(-Math.abs(Number(windowMinutes) || 15));
    return database.withControl(async () => {
      const row = await database.prepare(`SELECT COUNT(*) AS n FROM auth_attempts
        WHERE identity_hash=? AND result='failed' AND created_at>=?`).get(hash, cutoff);
      return Number(row && row.n || 0) >= Math.max(1, Number(limit) || 5);
    });
  }

  async function authRecord(identity, success) {
    const hash = identityHash(identity);
    const now = lib.nowStamp();
    const cutoff = lib.plusDaysStamp(-2);
    return database.withControl(() => database.transaction(async tx => {
      if (success) {
        await tx.prepare('DELETE FROM auth_attempts WHERE identity_hash=?').run(hash);
      } else {
        await tx.prepare(`INSERT INTO auth_attempts (identity_hash,result,created_at)
          VALUES (?,'failed',?)`).run(hash, now);
      }
      await tx.prepare('DELETE FROM auth_attempts WHERE created_at<?').run(cutoff);
    }));
  }

  return {
    tenantById,
    tenantByCode,
    schoolUserByIdentity,
    schoolUserById,
    createSession,
    getSession,
    destroySession,
    updateSession,
    adminById,
    authIsLimited,
    authRecord
  };
}

module.exports = { createMysqlAuthStore, SESSION_DAYS };
