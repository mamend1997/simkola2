'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const source = String.raw`
  const assert = require('node:assert/strict');
  const dbm = require('./db');
  dbm.initializeSchema = async tenant => ({ tenantId: tenant.id });
  dbm.mysqlHelpers.tableNames = async () => [];

  const tenants = [{ id: 1, school_code: 'AB12', nama: 'Sekolah Utama' }];
  const basic = {
    id: 1, kode: 'basic', nama: 'Basic', aktif: 1, self_trial: 1, trial_hari: 7,
    fitur: '["dashboard","siswa","kelas","iuran"]'
  };
  const writes = [];
  let nextTenantId = 2;

  function statement(sql) {
    return {
      async get(...values) {
        if (/SELECT k,v FROM saas_settings/.test(sql)) return null;
        if (/FROM information_schema\.COLUMNS/.test(sql)) return null;
        if (/FROM information_schema\.STATISTICS/.test(sql)) return null;
        if (/SELECT id FROM saas_packages WHERE kode='basic'/.test(sql)) return { id: 1 };
        if (/SELECT COUNT\(\*\) AS c FROM saas_packages/.test(sql)) return { c: 1 };
        if (/FROM saas_packages WHERE LOWER\(kode\)=LOWER\(\?\)/.test(sql)) return basic;
        if (/SELECT GET_LOCK/.test(sql)) return { acquired: 1 };
        if (/SELECT RELEASE_LOCK/.test(sql)) return { released: 1 };
        if (/AUTO_INCREMENT AS next_id/.test(sql)) return { next_id: nextTenantId };
        return null;
      },
      async all(...values) {
        if (/SELECT k,v FROM saas_settings/.test(sql)) return [];
        if (/SELECT school_code FROM tenants/.test(sql)) return tenants.map(row => ({ school_code: row.school_code }));
        return [];
      },
      async run(...values) {
        writes.push({ sql, values });
        if (/INSERT INTO tenants/.test(sql)) {
          const row = {
            id: nextTenantId++,
            school_code: values[0],
            nama: values[1],
            paket: values[2],
            db_file: values[9],
            features: values[13]
          };
          tenants.push(row);
          return { changes: 1, lastInsertRowid: row.id };
        }
        if (/UPDATE tenants SET db_file/.test(sql)) {
          const row = tenants.find(item => item.id === Number(values[2]));
          if (row) row.db_file = values[0];
        }
        return { changes: 1, lastInsertRowid: 1 };
      }
    };
  }

  const database = {
    async query() { return { affectedRows: 0 }; },
    prepare: statement,
    withControl: fn => fn(),
    withTenant: (_tenant, fn) => fn(),
    transaction: fn => fn({ prepare: statement })
  };
  const authStore = {
    tenantById: async id => tenants.find(row => row.id === Number(id)) || null,
    tenantByCode: async code => tenants.find(row => row.school_code === code) || null
  };
  const { createMysqlSaas } = require('./mysql-saas');

  (async () => {
    const saas = createMysqlSaas({ database, authStore });
    await saas.initialize();
    const tenant = await saas.createTenant({
      nama: 'Sekolah Baru',
      admin_email: 'admin@baru.test',
      admin_password: 'StrongPass1!',
      admin_nama: 'Admin Baru',
      alamat: 'Jl. Contoh',
      contact_telp: '08123456789',
      paket: 'basic'
    });
    assert.equal(tenant.id, 2);
    assert.equal(tenant.db_file, 'school_two_db');
    assert.equal(tenant.school_code.length, 4);
    const features = JSON.parse(tenant.features);
    assert.equal(features.dashboard, 1);
    assert.equal(features.siswa, 1);
    assert.equal(features.payroll, 0);
    assert.ok(writes.some(write => /INSERT INTO users/.test(write.sql)
      && write.values[1] === 'admin@baru.test' && write.values[2] !== 'StrongPass1!'));

    nextTenantId = 3;
    await assert.rejects(saas.createTenant({
      nama: 'Sekolah Tanpa Pemetaan',
      admin_email: 'admin2@baru.test',
      admin_password: 'StrongPass1!',
      paket: 'basic'
    }), /Database MySQL untuk sekolah 3 belum dikonfigurasi/);
    assert.equal(tenants.length, 2);
    assert.equal(writes.filter(write => /INSERT INTO tenants/.test(write.sql)).length, 1);
    console.log('MySQL tenant provisioning checks passed');
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
`;

const result = spawnSync(process.execPath, ['-e', source], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    DB_DRIVER: 'mysql',
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'test',
    MYSQL_PASSWORD: 'test-only',
    MYSQL_TENANT_DB: 'school_db',
    MYSQL_TENANT_DATABASES: '{"1":"school_db","2":"school_two_db"}',
    MYSQL_CONTROL_DB: 'control_db'
  },
  encoding: 'utf8'
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
assert.match(result.stdout, /MySQL tenant provisioning checks passed/);
