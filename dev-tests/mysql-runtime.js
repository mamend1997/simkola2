'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createMysqlRuntime, readConfig } = require('../mysql-runtime');
const { createMysqlDatabase } = require('../mysql-database');
const { createMysqlDbHelpers } = require('../mysql-db-helpers');
const { createMysqlAuthStore } = require('../mysql-auth-store');
const lib = require('../lib');

const baseEnv = {
  MYSQL_HOST: 'localhost',
  MYSQL_PORT: '3306',
  MYSQL_USER: 'simkola',
  MYSQL_PASSWORD: 'test-only',
  MYSQL_TENANT_DB: 'school_db',
  MYSQL_CONTROL_DB: 'control_db'
};

assert.throws(() => readConfig({ ...baseEnv, MYSQL_TENANT_DB: 'bad-name' }), /tidak valid/);
assert.throws(() => readConfig({ ...baseEnv, MYSQL_CONTROL_DB: 'school_db' }), /harus berbeda/);
assert.throws(() => readConfig({ ...baseEnv, MYSQL_PORT: '0' }), /MYSQL_PORT/);

const mysqlStartup = spawnSync(process.execPath, ['-e', "require('./db')"], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, DB_DRIVER: 'mysql' },
  encoding: 'utf8'
});
assert.notEqual(mysqlStartup.status, 0, 'MySQL mode must not silently start the SQLite application');
assert.match(mysqlStartup.stderr, /runtime aplikasi belum dipindahkan sepenuhnya ke MySQL/);

const calls = [];
let mismatchControlDatabase = false;
const sessions = new Map();
const tenantRow = { id: 1, school_code: 'AB12', nama: 'Sekolah Uji', db_file: 'unused' };
const schoolUser = { id: 7, nama: 'Admin Uji', email: 'admin@sekolah.test', username: 'admin', password: 'hash', aktif: 1 };
function fakePool(config) {
  calls.push({ type: 'pool', database: config.database, config });
  return {
    async query(sql, values) {
      calls.push({ type: 'query', database: config.database, sql, values });
      if (/SELECT DATABASE\(\)/i.test(sql)) {
        const actualDatabase = mismatchControlDatabase && config.database === 'control_db'
          ? 'wrong_database'
          : config.database;
        return [[{ database_name: actualDatabase, server_version: 'MariaDB test' }], []];
      }
      if (/FROM information_schema\.TABLES/i.test(sql) && sql.includes('TABLE_TYPE')) {
        return [[{ name: 'sessions' }, { name: 'tenants' }], []];
      }
      if (/FROM information_schema\.TABLES/i.test(sql)) {
        return [[{ found: 1 }], []];
      }
      if (/FROM information_schema\.COLUMNS/i.test(sql)) {
        return [[{ name: 'id' }, { name: 'k' }, { name: 'v' }], []];
      }
      if (/SELECT \* FROM tenants WHERE id=/i.test(sql)) return [values[0] === 1 ? [tenantRow] : [], []];
      if (/SELECT \* FROM tenants WHERE UPPER\(school_code\)=/i.test(sql)) {
        return [String(values[0]).toUpperCase() === tenantRow.school_code ? [tenantRow] : [], []];
      }
      if (/FROM users\s+WHERE LOWER\(email\)/i.test(sql)) {
        return [[schoolUser], []];
      }
      if (/FROM users WHERE id=/i.test(sql)) {
        return [Number(values[0]) === schoolUser.id ? [schoolUser] : [], []];
      }
      if (/SELECT \* FROM sessions WHERE token=/i.test(sql)) {
        const row = sessions.get(String(values[0]));
        return [row ? [row] : [], []];
      }
      if (/^\s*INSERT INTO sessions/i.test(sql)) {
        const row = {
          token: values[0], user_id: values[1], tenant_id: values[2], kind: values[3],
          expires_at: values[4], alert_pending: values[5], ta_id: values[6],
          created_at: values[7], welcome: values[8]
        };
        sessions.set(row.token, row);
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (/^\s*DELETE FROM sessions/i.test(sql)) {
        const existed = sessions.delete(String(values[0]));
        return [{ affectedRows: existed ? 1 : 0, insertId: 0 }, []];
      }
      if (/^\s*UPDATE sessions SET/i.test(sql)) {
        const token = String(values[values.length - 1]);
        const row = sessions.get(token);
        if (row) {
          const columns = [...sql.matchAll(/`([a-z_]+)`=\?/g)].map(match => match[1]);
          columns.forEach((column, index) => { row[column] = values[index]; });
        }
        return [{ affectedRows: row ? 1 : 0, insertId: 0 }, []];
      }
      if (/SELECT COUNT\(\*\) AS n FROM auth_attempts/i.test(sql)) return [[{ n: 0 }], []];
      if (/FROM saas_users WHERE id=/i.test(sql)) return [[], []];
      if (/SELECT v FROM settings/i.test(sql)) return [values[0] === 'missing' ? [] : [{ v: 'saved' }], []];
      if (/SELECT k,v FROM settings/i.test(sql)) return [[{ k: 'sekolah_nama', v: 'SIMKOLA' }, { k: 'portal_aktif', v: '1' }], []];
      if (/SELECT nama FROM tenants/i.test(sql)) return [[{ nama: 'Sekolah Uji' }], []];
      if (/^\s*UPDATE\b/i.test(sql)) return [{ affectedRows: 2, insertId: 0 }, []];
      if (/^\s*INSERT\b/i.test(sql)) return [{ affectedRows: 1, insertId: 42 }, []];
      return [[{ database: config.database }], []];
    },
    async getConnection() {
      return {
        async beginTransaction() { calls.push({ type: 'begin' }); },
        async query(sql, values) {
          calls.push({ type: 'transaction-query', sql, values });
          if (/^\s*UPDATE\b/i.test(sql)) return [{ affectedRows: 2, insertId: 0 }, []];
          if (/^\s*INSERT\b/i.test(sql)) return [{ affectedRows: 1, insertId: 42 }, []];
          if (/^\s*DELETE\b/i.test(sql)) return [{ affectedRows: 1, insertId: 0 }, []];
          return [[{ ok: 1 }], []];
        },
        async commit() { calls.push({ type: 'commit' }); },
        async rollback() { calls.push({ type: 'rollback' }); },
        release() { calls.push({ type: 'release' }); }
      };
    },
    async end() { calls.push({ type: 'end', database: config.database }); }
  };
}

async function main() {
  const runtime = createMysqlRuntime({
    env: baseEnv,
    mysql: { createPool: fakePool }
  });
  const database = createMysqlDatabase(runtime);
  const dbHelpers = createMysqlDbHelpers(database);
  const authStore = createMysqlAuthStore(database);
  assert.equal(runtime.config.tenantDatabase, 'school_db');
  assert.equal(runtime.config.controlDatabase, 'control_db');

  const school = runtime.schoolPool(1);
  assert.strictEqual(school, runtime.schoolPool(1));
  assert.notStrictEqual(runtime.controlPool(), school);
  assert.throws(() => runtime.schoolPool(2), /belum dikonfigurasi/);

  const rows = await runtime.query(school, 'SELECT ?', [1]);
  assert.deepEqual(rows, [{ database: 'school_db' }]);
  assert.deepEqual(await runtime.checkConnections(), {
    school: { database: 'school_db', version: 'MariaDB test' },
    control: { database: 'control_db', version: 'MariaDB test' }
  });
  mismatchControlDatabase = true;
  await assert.rejects(runtime.checkConnections(), /database yang tidak sesuai/);
  mismatchControlDatabase = false;
  await assert.rejects(database.query('SELECT 1'), /scope tenant atau control plane/);

  const scopedDatabases = await Promise.all([
    database.withTenant({ id: 1 }, async () => {
      assert.deepEqual(database.currentScope(), { kind: 'tenant', tenantId: 1 });
      return database.prepare('SELECT DATABASE() AS database_name').get();
    }),
    database.withControl(async () => {
      assert.deepEqual(database.currentScope(), { kind: 'control', tenantId: null });
      return database.prepare('SELECT DATABASE() AS database_name').all();
    })
  ]);
  assert.deepEqual(scopedDatabases.map(rows => Array.isArray(rows) ? rows[0].database_name : rows.database_name), ['school_db', 'control_db']);
  assert.throws(() => database.withTenant({ id: 2 }, async () => database.query('SELECT 1')), /belum dikonfigurasi/);
  await assert.rejects(dbHelpers.logAudit(null, 'LOGIN', 'auth', ''), /scope tenant/);

  const tenant = await authStore.tenantByCode('ab12');
  assert.deepEqual(tenant, tenantRow);
  assert.deepEqual(await authStore.tenantById(tenant.id), tenantRow);
  assert.equal(await authStore.tenantByCode(''), null);
  assert.deepEqual(await authStore.schoolUserByIdentity(tenant, 'ADMIN'), schoolUser);
  assert.equal((await authStore.schoolUserById(tenant, schoolUser.id)).id, schoolUser.id);
  const sessionToken = await authStore.createSession({
    userId: schoolUser.id,
    tenantId: tenant.id,
    kind: 'tenant',
    alertPending: 2,
    welcome: '{"kode":"AB12"}'
  });
  assert.match(sessionToken, /^[a-f0-9]{48}$/);
  assert.equal((await authStore.getSession(sessionToken)).tenant_id, tenant.id);
  await authStore.updateSession(sessionToken, { ta_id: 9 });
  assert.equal((await authStore.getSession(sessionToken)).ta_id, 9);
  await assert.rejects(authStore.updateSession(sessionToken, { token: 'unsafe' }), /Kolom sesi tidak diizinkan/);
  assert.equal(await authStore.authIsLimited('school:admin'), false);
  await authStore.authRecord('school:admin', false);
  await authStore.authRecord('school:admin', true);
  await authStore.destroySession(sessionToken);
  assert.equal(await authStore.getSession(sessionToken), null);
  const expiredToken = await authStore.createSession({
    userId: schoolUser.id,
    tenantId: tenant.id,
    expiresMinutes: -5
  });
  assert.equal(await authStore.getSession(expiredToken), null);
  assert.equal(sessions.has(expiredToken), false);
  assert.equal((await authStore.adminById(1)), null);

  await database.withTenant({ id: 1 }, async () => {
    assert.equal(await dbHelpers.getSetting('sekolah_nama'), 'saved');
    assert.equal(await dbHelpers.getSetting('missing', 'default'), 'default');
    assert.deepEqual(await dbHelpers.settingsAll(), { sekolah_nama: 'SIMKOLA', portal_aktif: '1' });
    assert.deepEqual(await dbHelpers.setSetting('portal_aktif', '0'), { changes: 1, lastInsertRowid: 42 });
    assert.deepEqual(await dbHelpers.tableNames(), ['sessions', 'tenants']);
    assert.equal(await dbHelpers.tableExists('tenants'), true);
    assert.deepEqual(await dbHelpers.columns('settings'), ['id', 'k', 'v']);
    await assert.rejects(dbHelpers.columns('bad-name'), /Nama tabel MySQL tidak valid/);

    const audit = await dbHelpers.logAudit({ id: 7, nama: 'Admin Uji', role: 'super_admin' },
      'LOGIN', 'auth', 'Masuk', { ip: '127.0.0.1' });
    assert.deepEqual(audit.local, { changes: 1, lastInsertRowid: 42 });
    assert.deepEqual(audit.central, { changes: 1, lastInsertRowid: 42 });
    const auditWrites = calls.filter(call => call.type === 'query' && /^\s*INSERT INTO (audit|audit_log)/i.test(call.sql));
    assert.deepEqual(auditWrites.map(call => call.database), ['school_db', 'control_db']);
    assert.equal(auditWrites[1].values[1], 'Sekolah Uji');
    assert.equal(auditWrites[1].values[5], '127.0.0.1');

    const result = await database.transaction(async tx => {
      const found = await tx.prepare('SELECT ?').get(2);
      const changed = await tx.prepare('UPDATE demo SET value=?').run('updated');
      return { found, changed };
    });
    assert.deepEqual(result, {
      found: { ok: 1 },
      changed: { changes: 2, lastInsertRowid: 0 }
    });
    const inserted = await database.prepare('INSERT INTO demo(value) VALUES (?)').run('new');
    assert.deepEqual(inserted, { changes: 1, lastInsertRowid: 42 });
  });
  assert.deepEqual(calls.filter(c => ['begin', 'transaction-query', 'commit', 'release'].includes(c.type)).slice(-5)
    .map(c => c.type), ['begin', 'transaction-query', 'transaction-query', 'commit', 'release']);

  await assert.rejects(database.withTenant({ id: 1 }, () => database.transaction(async () => {
    throw new Error('rollback-test');
  })), /rollback-test/);
  assert.deepEqual(calls.filter(c => ['begin', 'rollback', 'release'].includes(c.type)).slice(-3)
    .map(c => c.type), ['begin', 'rollback', 'release']);

  await runtime.close();
  assert.equal(calls.filter(c => c.type === 'end').length, 2);
  console.log('MySQL runtime foundation checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
