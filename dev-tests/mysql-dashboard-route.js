'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib');
const registerDashboardRoutes = require('../routes/dashboard');

const routes = new Map();
const calls = [];
const portalMessage = {
  id: 8,
  nama: 'Wali Uji',
  pesan: 'Mohon cek pembayaran',
  kontak: '08123456789',
  status: 'baru',
  sumber: 'siswa',
  created_at: '2026-11-27 12:00:00'
};
const tenantDb = {
  prepare(sql) {
    return {
      get: async (...values) => {
        calls.push({ method: 'get', sql, values });
        if (sql.includes('FROM tahun_ajaran')) return null;
        if (sql.includes('FROM permissions')) return null;
        if (sql.includes('COUNT(*) AS c FROM transaksi')) return { c: 0 };
        if (sql.includes('AS total_masuk')) return { total_masuk: 1500, total_keluar: 400, jumlah_transaksi: 2 };
        if (sql.includes('AS pagu')) return { pagu: 2000 };
        if (sql.includes('AS total') && sql.includes('JOIN coa')) return { total: 400 };
        if (sql.includes("COUNT(*) AS c FROM portal_pesan")) return { c: 1 };
        if (sql.includes('FROM portal_pesan WHERE id=?')) return portalMessage;
        return null;
      },
      all: async (...values) => {
        calls.push({ method: 'all', sql, values });
        if (sql.includes('FROM tahun_ajaran')) return [{ id: 3, nama: '2026/2027', aktif: 1 }];
        if (sql.includes('FROM permissions')) return [];
        if (sql.includes('FROM bku b LEFT JOIN transaksi')) return [{
          id: 2, nama: 'BKU Umum', jenis: 'umum', status: 'aktif',
          saldo_awal: 100, masuk: 1500, keluar: 400
        }];
        if (sql.includes('FROM transaksi t JOIN bku')) return [];
        if (sql.includes('FROM portal_pesan')) return [portalMessage];
        return [];
      },
      run: async (...values) => {
        calls.push({ method: 'run', sql, values });
        return { changes: 1, lastInsertRowid: 0 };
      }
    };
  }
};

const dbm = {
  DB_DRIVER: 'mysql',
  db: tenantDb,
  mysqlHelpers: {
    settingsAll: async () => ({ sekolah_nama: 'Sekolah Uji', tema_warna: '#F97316' }),
    logAudit: async () => ({ at: '2026-11-27 12:00:00' })
  },
  currentMeta: () => ({ ip: '127.0.0.1' }),
  ROLE_LABEL: { super_admin: 'Super Admin' }
};
const ui = {
  layout: ({ title, content }) => `<html><title>${title}</title>${content}</html>`,
  badge: (label) => `<span>${label}</span>`,
  emptyState: (title) => `<div>${title}</div>`,
  icon: () => ''
};
const saas = {
  appName: () => 'SIMKOLA',
  appSub: () => 'Sistem Keuangan',
  enabledKeys: () => ['dashboard', 'transaksi', 'catatan'],
  statusOf: () => ({ key: 'active', label: 'Aktif' }),
  takeWelcome: async () => null
};

registerDashboardRoutes({
  get: (route, handler) => routes.set(`GET ${route}`, handler),
  post: (route, handler) => routes.set(`POST ${route}`, handler),
  dbm,
  lib,
  ui,
  flashUrl: (pathname, key, value) => `${pathname}?${key}=${encodeURIComponent(value)}`,
  saas
});

function request({ query = '', body = {} } = {}) {
  return {
    BASE: '',
    url: '/',
    query: new URLSearchParams(query),
    body,
    user: { id: 1, nama: 'Admin', role: 'super_admin' },
    tenant: { id: 1, nama: 'Sekolah Uji', school_code: 'UJI1', paket: 'basic' },
    sessionRow: { token: 'session' }
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
  const home = response();
  await routes.get('GET /')(request(), home);
  assert.equal(home.statusCode, 200);
  assert.match(home.htmlBody, /Ringkasan Keuangan/);
  assert.match(home.htmlBody, /BKU Umum/);
  assert.ok(calls.every(call => call.method === 'get' || call.method === 'all'));

  const messages = response();
  await routes.get('GET /catatan-orangtua')(request(), messages);
  assert.equal(messages.statusCode, 200);
  assert.match(messages.htmlBody, /Mohon cek pembayaran/);

  const removed = response();
  await routes.get('POST /catatan-orangtua/delete')(request({
    body: { id: '8', back: '/catatan-orangtua' }
  }), removed);
  assert.match(removed.redirectTo, /Catatan%20orang%20tua%20dihapus/);
  assert.ok(calls.some(call => call.method === 'run' && call.sql.startsWith('DELETE FROM portal_pesan')));

  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of [
    "'/'", "'/catatan-orangtua'", "'/pesan-orangtua'",
    "'/catatan-orangtua/delete'", "'/catatan-orangtua/balas'", "'/pesan-orangtua/selesai'"
  ]) assert.ok(source.includes(route), `server allowlist missing ${route}`);
  assert.ok(source.includes("pathname0.startsWith('/files/')"));
  const allowlist = source.match(/const mysqlCorePaths = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(allowlist);
  assert.doesNotMatch(allowlist[1], /'\/transaksi'/);

  console.log('MySQL dashboard route checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
