'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registerClassRoutes = require('../routes/kelas_tingkat');

const routes = new Map();
const calls = [];
const db = {
  prepare(sql) {
    const execute = async (method, values) => {
      calls.push({ method, sql, values });
      if (sql.includes('FROM permissions')) return method === 'all' ? [] : { allowed: 1 };
      if (sql.includes('FROM tahun_ajaran')) {
        return method === 'all'
          ? [{ id: 1, nama: '2026/2027', tanggal_mulai: '2026-07-01', tanggal_selesai: '2027-06-30', aktif: 1 }]
          : { id: 1, nama: '2026/2027' };
      }
      if (sql.includes('FROM kelas') && sql.includes('LOWER(COALESCE')) return null;
      if (sql.includes('FROM kelas') && sql.includes('COUNT(*) AS c')) return { c: 0 };
      if (sql.includes('FROM kelas') && sql.includes('MAX(urutan)')) return { next_order: 2 };
      if (sql.includes('FROM kelas')) return [{ id: 4, nama: 'VII-A', nama_kelas: 'VII-A', tingkat: 'VII', aktif: 1, jumlah_siswa: 12 }];
      return null;
    };
    return {
      get: async (...values) => execute('get', values),
      all: async (...values) => execute('all', values),
      run: async (...values) => execute('run', values)
    };
  }
};

const dbm = {
  DB_DRIVER: 'mysql',
  db,
  mysqlDatabase: {
    transaction: async fn => fn({
      prepare: sql => ({
        run: async (...values) => {
          calls.push({ method: 'tx-run', sql, values });
          return { changes: 1 };
        }
      })
    })
  },
  mysqlHelpers: {
    settingsAll: async () => ({ jenjang_pendidikan: 'SMP/MTs', tingkat_aktif: '["VII","VIII","IX"]' }),
    getSetting: async (_key, fallback) => fallback,
    setSetting: async () => ({ changes: 1 }),
    logAudit: async () => ({ at: '2026-11-27 12:00:00' })
  },
  currentMeta: () => ({ ip: '127.0.0.1' }),
  ROLE_LABEL: { super_admin: 'Super Admin' }
};
const ui = {
  layout: ({ title, content }) => `<html><title>${title}</title>${content}</html>`,
  icon: () => '',
  badge: label => `<span>${label}</span>`,
  emptyState: label => `<div>${label}</div>`
};
const lib = {
  esc: value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch])),
  nowStamp: () => '2026-11-27 12:00:00'
};

registerClassRoutes({
  get: (route, handler) => routes.set(`GET ${route}`, handler),
  post: (route, handler) => routes.set(`POST ${route}`, handler),
  dbm, lib, ui, flashUrl: (pathname, key, value) => `${pathname}?${key}=${encodeURIComponent(value)}`
});

function request({ query = '', body = {} } = {}) {
  return {
    BASE: '',
    url: '/kelas/tingkat',
    query: new URLSearchParams(query),
    body,
    user: { id: 1, nama: 'Admin', role: 'super_admin' },
    tenant: { id: 1, nama: 'Sekolah Uji', school_code: 'UJI1', paket: 'basic' },
    sessionRow: { ta_id: 1 }
  };
}

function response() {
  return {
    statusCode: 200,
    htmlBody: '',
    redirectTo: '',
    html(body, status = 200) { this.htmlBody = body; this.statusCode = status; },
    redirect(url) { this.redirectTo = url; }
  };
}

async function main() {
  const page = response();
  await routes.get('GET /kelas/tingkat')(request(), page);
  assert.equal(page.statusCode, 200);
  assert.match(page.htmlBody, /Pengaturan Kelas & Tingkat/);
  assert.match(page.htmlBody, /VII-A/);

  const setLevel = response();
  await routes.get('POST /kelas/tingkat/jenjang')(request({
    body: { jenjang_pendidikan: 'SD/MI' }
  }), setLevel);
  assert.match(setLevel.redirectTo, /Preset%20tingkat%3A%20I%2C%20II/);
  assert.equal(calls.filter(call => call.method === 'tx-run').length, 2);

  const addClass = response();
  await routes.get('POST /kelas/tingkat/kelas')(request({
    body: { nama: 'VII-B', tingkat: 'VII', tahun_ajaran_id: '1' }
  }), addClass);
  assert.match(addClass.redirectTo, /Kelas%20VII-B%20ditambahkan/);
  assert.ok(calls.some(call => call.method === 'run' && call.sql.startsWith('INSERT INTO kelas')));
  assert.ok(calls.every(call => !/\bPRAGMA\b|sqlite_master|ON CONFLICT/i.test(call.sql)));

  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("'/kelas/tingkat'"), 'server allowlist missing the class-level page');
  console.log('MySQL class-level route checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
