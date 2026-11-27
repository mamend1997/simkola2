'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createMysqlRuntime, readConfig } = require('../mysql-runtime');
const { createMysqlDatabase } = require('../mysql-database');
const { createMysqlDbHelpers } = require('../mysql-db-helpers');
const { createMysqlAuthStore } = require('../mysql-auth-store');
const { mysqlSchemaStatements, initializeMysqlSchema } = require('../mysql-schema');
const appSchema = require('../db-schema');
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
assert.throws(() => readConfig({ ...baseEnv, MYSQL_TENANT_DATABASES: '{invalid' }), /JSON object yang valid/);
assert.throws(() => readConfig({ ...baseEnv, MYSQL_TENANT_DATABASES: '{"2":"control_db"}' }), /tidak boleh sama/);
assert.throws(() => readConfig({ ...baseEnv, MYSQL_TENANT_DATABASES: '{"0":"school_zero"}' }), /ID tenant/);

const mysqlStartup = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict');
  const mysqlDb = require('./db');
  const saas = require('./saas');
  assert.equal(mysqlDb.DB_DRIVER, 'mysql');
  assert.equal(saas.DB_DRIVER, 'mysql');
  assert.equal(typeof saas.initialize, 'function');
  assert.equal(typeof saas.authenticateSchool, 'function');
  assert.equal(typeof saas.getSession, 'function');
  assert.equal(typeof saas.mfaVerify, 'function');
  assert.equal(typeof saas.packageRows, 'function');
  assert.equal(typeof saas.regStatus, 'function');
  assert.equal(typeof saas.otpDaftarSend, 'function');
  assert.equal(typeof saas.otpDaftarVerify, 'function');
  assert.equal(typeof saas.createTenant, 'function');
  assert.equal(typeof mysqlDb.mysqlRuntime.schoolPool, 'function');
  assert.equal(typeof mysqlDb.withTenant, 'function');
  assert.equal(typeof mysqlDb.withControl, 'function');
  assert.equal(typeof mysqlDb.initializeSchema, 'function');
  assert.equal(typeof mysqlDb.tableNames, 'function');
  assert.equal(typeof mysqlDb.columns, 'function');
  assert.equal(typeof mysqlDb.db.get, 'function');
  assert.equal(typeof mysqlDb.db.all, 'function');
  assert.equal(typeof mysqlDb.db.run, 'function');
  assert.equal(typeof mysqlDb.db.transaction, 'function');
  assert.equal(typeof mysqlDb.db.prepare('SELECT 1').get, 'function');
  console.log('MYSQL_DB_API_READY');
`], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    DB_DRIVER: 'mysql',
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'test',
    MYSQL_PASSWORD: 'test-only',
    MYSQL_TENANT_DB: 'school_db',
    MYSQL_CONTROL_DB: 'control_db'
  },
  encoding: 'utf8'
});
assert.equal(mysqlStartup.status, 0, mysqlStartup.stderr || mysqlStartup.error?.message);
assert.match(mysqlStartup.stdout, /MYSQL_DB_API_READY/);

const mysqlSaasStartup = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict');
  const { createMysqlSaas } = require('./mysql-saas');
  const statements = [];
  const database = {
    withControl: fn => fn(),
    async query(sql) { statements.push(sql); return { affectedRows: 0 }; },
    prepare(sql) {
      return {
        all: async () => {
          if (/SELECT k,v FROM saas_settings/.test(sql)) return [];
          return [];
        },
        get: async () => null,
        run: async () => ({ changes: 1, lastInsertRowid: 0 })
      };
    },
    async transaction(fn) { return fn({ prepare: this.prepare.bind(this) }); }
  };
  const authStore = {
    tenantById: async id => ({ id }),
    tenantByCode: async code => ({ id: 1, school_code: code })
  };
  (async () => {
    const saas = createMysqlSaas({ database, authStore });
    await assert.rejects(saas.set('saas_nama', 'Sebelum init'), /belum diinisialisasi/);
    await saas.initialize();
    assert.equal(saas.isInitialized(), true);
    assert.equal(saas.appName(), 'SIMKOLA');
    assert.equal(saas.daftarOtpCfg().aktif, true);
    assert.equal(saas.packageSelfTrial({ self_trial: 1 }), true);
    assert.equal(saas.packageTrialDays({ trial_hari: null }), 7);
    assert.equal(saas.packageFeatureMap({ kode: 'basic', fitur: '["siswa"]' }).siswa, 1);
    assert.equal(saas.packageFeatureMap({ kode: 'basic', fitur: '["siswa"]' }).payroll, 0);
    await saas.set('saas_nama', 'SIMKOLA Uji');
    assert.equal(saas.appName(), 'SIMKOLA Uji');
    assert.deepEqual(await saas.tenantById(3), { id: 3 });
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS sessions/.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS auth_attempts/.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS saas_packages/.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS reg_attempts/.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS daftar_otp/.test(sql)));
    console.log('MYSQL_SAAS_API_READY');
  })().catch(error => { console.error(error); process.exitCode = 1; });
`], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    DB_DRIVER: 'mysql',
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'test',
    MYSQL_PASSWORD: 'test-only',
    MYSQL_TENANT_DB: 'school_db',
    MYSQL_CONTROL_DB: 'control_db'
  },
  encoding: 'utf8'
});
assert.equal(mysqlSaasStartup.status, 0, mysqlSaasStartup.stderr || mysqlSaasStartup.error?.message);
assert.match(mysqlSaasStartup.stdout, /MYSQL_SAAS_API_READY/);

const mysqlDdl = mysqlSchemaStatements(appSchema);
assert.ok(mysqlDdl.length > 0);
assert.ok(mysqlDdl.some(sql => /CREATE TABLE IF NOT EXISTS users .*AUTO_INCREMENT/.test(sql)));
assert.ok(mysqlDdl.some(sql => /CREATE TABLE IF NOT EXISTS permissions .*PRIMARY KEY \(role, module, action\)/.test(sql)));
assert.ok(mysqlDdl.some(sql => /CREATE INDEX idx_piutang_nama ON piutang \(nama_pegawai\(191\)\)/.test(sql)));
assert.ok(mysqlDdl.every(sql => !/AUTOINCREMENT|sqlite_master|PRAGMA|ON CONFLICT|INDEX IF NOT EXISTS/i.test(sql)));

const calls = [];
let mismatchControlDatabase = false;
const sessions = new Map();
const tenantRow = { id: 1, school_code: 'AB12', nama: 'Sekolah Uji', db_file: 'unused' };
const schoolUser = {
  id: 7, nama: 'Admin Uji', email: 'admin@sekolah.test', username: 'admin',
  password: lib.hashPassword('secret'), aktif: 1
};
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
        const ident = String(values[0] || '').toLowerCase();
        return [ident === 'admin' || ident === 'admin@sekolah.test' ? [schoolUser] : [], []];
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
  const initializedDdl = [];
  const introspectionQueries = [];
  const schemaTableRows = mysqlDdl.filter(sql => sql.startsWith('CREATE TABLE')).map(sql => ({
    name: sql.match(/^CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/)[1]
  }));
  const schemaColumns = new Map(schemaTableRows.map(({ name }) => [name, new Set()]));
  for (const sql of mysqlDdl.filter(statement => statement.startsWith('CREATE TABLE'))) {
    const table = sql.match(/^CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/)[1];
    const body = sql.match(/\(([\s\S]*)\) ENGINE=/)[1];
    const names = [...body.matchAll(/(?:^|, )([A-Za-z_][A-Za-z0-9_]*) (?:BIGINT|DOUBLE|VARCHAR|LONGTEXT)/g)]
      .map(match => match[1]);
    names.forEach(name => schemaColumns.get(table).add(name));
  }
  const fakeSchemaDatabase = {
    async query(sql) {
      initializedDdl.push(sql);
      const added = sql.match(/^ALTER TABLE `([A-Za-z_][A-Za-z0-9_]*)` ADD COLUMN `([A-Za-z_][A-Za-z0-9_]*)`/);
      if (added) schemaColumns.get(added[1]).add(added[2]);
      return { affectedRows: 0 };
    },
    prepare(sql) {
      introspectionQueries.push(sql);
      return {
        all: async (...values) => {
          if (/information_schema\.TABLES/.test(sql)) return schemaTableRows;
          if (/information_schema\.COLUMNS/.test(sql)) {
            return [...(schemaColumns.get(String(values[0])) || [])].map(name => ({ name }));
          }
          return [];
        },
        get: async () => null,
        run: async () => {
          initializedDdl.push(sql);
          return { changes: 1, lastInsertRowid: 0 };
        }
      };
    }
  };
  const initResult = await initializeMysqlSchema(fakeSchemaDatabase, appSchema, 7);
  assert.equal(initResult.tablesEnsured, mysqlDdl.filter(sql => sql.startsWith('CREATE TABLE')).length);
  assert.equal(initResult.indexesCreated, mysqlDdl.filter(sql => sql.startsWith('CREATE INDEX')).length + 7);
  assert.ok(initResult.columnsAdded > 0);
  assert.ok(initResult.tenantColumnsAdded > 0 && initResult.tenantColumnsAdded <= schemaTableRows.length);
  assert.equal(initResult.rowsAssigned, schemaTableRows.length);
  assert.ok(initializedDdl.every(sql => !/AUTOINCREMENT|sqlite_master|PRAGMA|ON CONFLICT|INDEX IF NOT EXISTS/i.test(sql)));
  assert.ok(introspectionQueries.some(sql => /information_schema\.TABLES/.test(sql)));
  assert.ok(introspectionQueries.some(sql => /information_schema\.COLUMNS/.test(sql)));
  assert.ok(introspectionQueries.some(sql => /information_schema\.STATISTICS/.test(sql)));
  assert.ok(initializedDdl.some(sql => /ADD COLUMN `public_token` VARCHAR\(64\)/.test(sql)));
  assert.ok(initializedDdl.some(sql => /UPDATE `settings` SET tenant_id=\? WHERE tenant_id IS NULL/.test(sql)));

  const runtime = createMysqlRuntime({
    env: baseEnv,
    mysql: { createPool: fakePool }
  });
  const database = createMysqlDatabase(runtime);
  const dbHelpers = createMysqlDbHelpers(database);
  const authStore = createMysqlAuthStore(database);
  assert.equal(runtime.config.tenantDatabase, 'school_db');
  assert.equal(runtime.config.controlDatabase, 'control_db');
  assert.equal(runtime.schoolDatabaseName(1), 'school_db');

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

  const mappedRuntime = createMysqlRuntime({
    env: { ...baseEnv, MYSQL_TENANT_DATABASES: '{"1":"school_db","2":"school_two_db"}' },
    mysql: { createPool: fakePool }
  });
  const tenantTwoPool = mappedRuntime.schoolPool(2);
  assert.equal(mappedRuntime.schoolDatabaseName(2), 'school_two_db');
  assert.notStrictEqual(tenantTwoPool, mappedRuntime.schoolPool(1));
  assert.equal((await mappedRuntime.query(tenantTwoPool, 'SELECT DATABASE() AS database_name'))[0].database_name, 'school_two_db');
  assert.throws(() => mappedRuntime.schoolPool(3), /belum dikonfigurasi/);
  assert.throws(() => mappedRuntime.schoolPool(2, 'other_db'), /tidak cocok/);
  await mappedRuntime.close();

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
  const login = await authStore.authenticateSchool({
    schoolCode: tenant.school_code,
    identity: 'admin',
    password: 'secret'
  });
  assert.equal(login.ok, true);
  assert.equal(login.user.id, schoolUser.id);
  assert.equal((await authStore.getSession(login.token)).tenant_id, tenant.id);
  await authStore.destroySession(login.token);
  const rejectedLogin = await authStore.authenticateSchool({
    schoolCode: tenant.school_code,
    identity: 'admin',
    password: 'wrong'
  });
  assert.deepEqual(rejectedLogin, { ok: false, reason: 'invalid_credentials' });

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
  assert.equal(calls.filter(c => c.type === 'end').length, 4);
  console.log('MySQL runtime foundation checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
