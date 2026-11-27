'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib');
const registerMasterRoutes = require('../routes/master');

const routes = new Map();
const calls = [];
const settings = { sekolah_nama: 'Sekolah Uji', tema_warna: '#F97316', mode_tema: 'light' };
const coaRows = [{ id: 2, kode: '5.2.01', nama: 'Belanja Barang', kategori: 'pengeluaran', aktif: 1 }];
const tenantDb = {
  prepare(sql) {
    const record = (method, values) => calls.push({ scope: 'tenant', method, sql, values });
    return {
      get: async (...values) => {
        record('get', values);
        if (sql.includes('FROM permissions')) return { allowed: values[0] === 'staff' ? 0 : 1 };
        if (sql.includes('COUNT(*) AS c FROM transaksi')) return { c: 0 };
        if (sql.includes('COUNT(*) AS c FROM bku_rab')) return { c: 0 };
        if (sql.includes('FROM tahun_ajaran WHERE id=?')) return { id: Number(values[0]) };
        if (sql.includes('FROM coa WHERE id=?')) return coaRows.find(row => row.id === Number(values[0])) || null;
        if (sql.includes('FROM anggaran WHERE id=?')) return { id: Number(values[0]), tahun_ajaran_id: 1 };
        if (sql.includes('FROM tahun_ajaran') && sql.includes('COUNT')) return { c: 0 };
        return null;
      },
      all: async (...values) => {
        record('all', values);
        if (sql.includes('FROM permissions')) return [];
        if (sql.includes('FROM tahun_ajaran')) return [{
          id: 1, nama: '2026/2027', tanggal_mulai: '2026-07-01',
          tanggal_selesai: '2027-06-30', aktif: 1
        }];
        if (sql.includes('FROM coa') && sql.includes('kategori IN')) return coaRows;
        if (sql.includes('FROM coa')) return coaRows;
        if (sql.includes('FROM transaksi') && sql.includes('GROUP BY coa_id')) return [{ coa_id: 2, n: 3 }];
        if (sql.includes('FROM anggaran')) return [{
          id: 8, tahun_ajaran_id: 1, coa_id: 2, pagu: 10000, keterangan: '',
          kode: '5.2.01', nama: 'Belanja Barang', realisasi: 4000
        }];
        return [];
      },
      run: async (...values) => {
        record('run', values);
        return { changes: 1, lastInsertRowid: 9 };
      }
    };
  }
};
const controlDatabase = {
  withControl: fn => fn(),
  prepare(sql) {
    return {
      get: async (...values) => {
        calls.push({ scope: 'control', method: 'get', sql, values });
        return null;
      },
      run: async (...values) => {
        calls.push({ scope: 'control', method: 'run', sql, values });
        return { changes: 1 };
      }
    };
  },
  transaction: async fn => fn({
    prepare: sql => ({
      run: async (...values) => {
        calls.push({ scope: 'control', method: 'tx-run', sql, values });
        return { changes: 1 };
      }
    })
  })
};
const dbm = {
  DB_DRIVER: 'mysql',
  db: tenantDb,
  mysqlDatabase: controlDatabase,
  mysqlHelpers: {
    settingsAll: async () => ({ ...settings }),
    logAudit: async () => ({ at: '2026-11-27 12:00:00' })
  },
  currentMeta: () => ({ ip: '127.0.0.1' }),
  ROLE_LABEL: { super_admin: 'Super Admin' }
};
const ui = {
  layout: ({ title, content }) => `<html><title>${title}</title>${content}</html>`,
  icon: () => '',
  badge: label => `<span>${label}</span>`,
  emptyState: label => `<div>${label}</div>`,
  openModalBtn: () => '<button></button>',
  modal: (_id, options) => `<div>${options.title || ''}</div>`,
  kop: () => '<div>Kop sekolah</div>',
  moneyInput: name => `<input name="${name}">`,
  selectOptions: () => '<option value="1">2026/2027</option>',
  prog: () => '<div></div>'
};
const saas = {
  appName: () => 'SIMKOLA',
  appSub: () => 'Sistem Keuangan',
  enabledKeys: () => ['dashboard', 'sekolah', 'tema', 'coa', 'anggaran'],
  statusOf: () => ({ key: 'active', label: 'Aktif' })
};

registerMasterRoutes({
  get: (route, handler) => routes.set(`GET ${route}`, handler),
  post: (route, handler) => routes.set(`POST ${route}`, handler),
  dbm, lib, ui, saas,
  uploadMedia: async (_data, filename, options) => {
    calls.push({ scope: 'upload', filename, options });
    return '/files/1/logo/test.webp';
  }
});

function request({ pathName = '/', query = '', body = {}, role = 'super_admin' } = {}) {
  return {
    BASE: '',
    url: pathName,
    query: new URLSearchParams(query),
    body,
    user: { id: 1, nama: 'Admin', role },
    tenant: { id: 1, nama: 'Sekolah Uji', school_code: 'UJI1', paket: 'basic' },
    sessionRow: { ta_id: 1 }
  };
}

function response() {
  return {
    statusCode: 200, htmlBody: '', redirectTo: '',
    html(body, status = 200) { this.htmlBody = body; this.statusCode = status; },
    redirect(url) { this.redirectTo = url; }
  };
}

async function main() {
  const theme = response();
  await routes.get('GET /tema')(request({ pathName: '/tema' }), theme);
  assert.equal(theme.statusCode, 200);
  assert.match(theme.htmlBody, /Tema &amp; Branding Aplikasi/);

  const savedTheme = response();
  await routes.get('POST /tema')(request({
    pathName: '/tema', body: { tema_hex: '#123abc', mode_tema: 'dark', app_nama: 'SIMKOLA Uji' }
  }), savedTheme);
  assert.match(savedTheme.redirectTo, /tema\?ok=/);
  assert.ok(calls.some(call => call.method === 'tx-run' && call.sql.includes('ON DUPLICATE KEY UPDATE')));
  const uploadedAppLogo = response();
  await routes.get('POST /tema/logo')(request({
    pathName: '/tema/logo', body: { logo_b64: 'data:image/png;base64,AA==' }
  }), uploadedAppLogo);
  assert.match(uploadedAppLogo.redirectTo, /tema\?ok=/);
  assert.ok(calls.some(call => call.scope === 'upload' && call.options.jenis === 'logo' && call.options.tenantId === 1));

  const school = response();
  await routes.get('GET /sekolah')(request({ pathName: '/sekolah' }), school);
  assert.equal(school.statusCode, 200);
  assert.match(school.htmlBody, /NPSN \(8 digit\)/);

  const badNpsn = response();
  await routes.get('POST /sekolah')(request({
    pathName: '/sekolah', body: { sekolah_npsn: '12345' }
  }), badNpsn);
  assert.match(badNpsn.redirectTo, /NPSN%20harus%20tepat%208%20digit/);

  const validNpsn = response();
  await routes.get('POST /sekolah')(request({
    pathName: '/sekolah', body: { sekolah_npsn: '12345678' }
  }), validNpsn);
  assert.match(validNpsn.redirectTo, /sekolah\?ok=/);
  assert.ok(calls.some(call => call.scope === 'control' && call.sql.includes('UPDATE tenants SET npsn')));
  const uploadedSchoolLogo = response();
  await routes.get('POST /sekolah/logo')(request({
    pathName: '/sekolah/logo', body: { logo_b64: 'data:image/png;base64,AA==' }
  }), uploadedSchoolLogo);
  assert.match(uploadedSchoolLogo.redirectTo, /sekolah\?ok=/);

  const coa = response();
  await routes.get('GET /coa')(request({ pathName: '/coa' }), coa);
  assert.equal(coa.statusCode, 200);
  assert.match(coa.htmlBody, /Belanja Barang/);

  const saveCoa = response();
  await routes.get('POST /coa/save')(request({
    pathName: '/coa/save', body: { kode: '5.2.99', nama: 'Belanja Uji', kategori: 'pengeluaran' }
  }), saveCoa);
  assert.match(saveCoa.redirectTo, /coa\?ok=/);
  assert.ok(calls.some(call => call.method === 'run' && call.sql.startsWith('INSERT INTO coa')));
  const deleteCoa = response();
  await routes.get('POST /coa/delete')(request({
    pathName: '/coa/delete', body: { id: '2' }
  }), deleteCoa);
  assert.match(deleteCoa.redirectTo, /coa\?ok=/);
  assert.ok(calls.some(call => call.method === 'run' && call.sql.startsWith('DELETE FROM coa')));

  const budget = response();
  await routes.get('GET /anggaran')(request({ pathName: '/anggaran' }), budget);
  assert.equal(budget.statusCode, 200);
  assert.match(budget.htmlBody, /Anggaran RAPBS \/ RKAS/);

  const saveBudget = response();
  await routes.get('POST /anggaran/save')(request({
    pathName: '/anggaran/save',
    body: { tahun_ajaran_id: '1', coa_id: '2', pagu: '15.000', keterangan: 'Uji' }
  }), saveBudget);
  assert.match(saveBudget.redirectTo, /anggaran\?ta=1&ok=/);
  assert.ok(calls.some(call => call.method === 'run' && call.sql.includes('ON DUPLICATE KEY UPDATE')));

  const editBudget = response();
  await routes.get('POST /anggaran/save')(request({
    pathName: '/anggaran/save',
    body: { id: '8', tahun_ajaran_id: '1', coa_id: '2', pagu: '17.000', keterangan: 'Edit' }
  }), editBudget);
  assert.match(editBudget.redirectTo, /anggaran\?ta=1&ok=/);
  assert.ok(calls.some(call => call.method === 'run' && call.sql.startsWith('UPDATE anggaran')));
  const deleteBudget = response();
  await routes.get('POST /anggaran/delete')(request({
    pathName: '/anggaran/delete', body: { id: '8' }
  }), deleteBudget);
  assert.match(deleteBudget.redirectTo, /anggaran\?ok=/);
  assert.ok(calls.every(call => !/PRAGMA|sqlite_master|ON CONFLICT|INSERT OR IGNORE/i.test(call.sql || '')));

  const denied = response();
  await routes.get('GET /coa')(request({ pathName: '/coa', role: 'staff' }), denied);
  assert.equal(denied.statusCode, 403);

  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const allowlist = source.match(/const mysqlCorePaths = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(allowlist);
  for (const route of ['/tema', '/tema/logo', '/sekolah', '/sekolah/logo', '/coa', '/coa/save',
    '/coa/delete', '/anggaran', '/anggaran/save', '/anggaran/delete']) {
    assert.ok(allowlist[1].includes(`'${route}'`), `server allowlist missing ${route}`);
  }
  assert.doesNotMatch(allowlist[1], /'\/bku|\/aset|\/tahun-ajaran\/rollover/);
  console.log('MySQL master route checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
