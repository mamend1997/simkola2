'use strict';

const lib = require('./lib');
const TABLE_NAME = /^[A-Za-z0-9_]{1,64}$/;

function createMysqlDbHelpers(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('Database async MySQL tidak valid.');
  }

  async function getSetting(key, fallback = '') {
    const row = await database.prepare('SELECT v FROM settings WHERE k=?').get(String(key));
    return row ? row.v : fallback;
  }

  async function setSetting(key, value) {
    return database.prepare(`INSERT INTO settings (k,v) VALUES (?,?)
      ON DUPLICATE KEY UPDATE v=VALUES(v)`).run(String(key), String(value == null ? '' : value));
  }

  async function settingsAll() {
    const rows = await database.prepare('SELECT k,v FROM settings').all();
    return Object.fromEntries(rows.map(row => [String(row.k), row.v]));
  }

  async function tableNames() {
    const rows = await database.prepare(`SELECT TABLE_NAME AS name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'
      ORDER BY TABLE_NAME`).all();
    return rows.map(row => String(row.name));
  }

  async function tableExists(table) {
    const name = String(table || '');
    if (!TABLE_NAME.test(name)) throw new Error('Nama tabel MySQL tidak valid.');
    const row = await database.prepare(`SELECT 1 AS found
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
      LIMIT 1`).get(name);
    return !!row;
  }

  async function columns(table) {
    const name = String(table || '');
    if (!TABLE_NAME.test(name)) throw new Error('Nama tabel MySQL tidak valid.');
    const rows = await database.prepare(`SELECT COLUMN_NAME AS name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
      ORDER BY ORDINAL_POSITION`).all(name);
    return rows.map(row => String(row.name));
  }

  async function logAudit(user, action, moduleName, detail, meta = {}) {
    const scope = database.currentScope();
    if (!scope || scope.kind !== 'tenant') throw new Error('Audit sekolah harus dijalankan dalam scope tenant.');
    const tenantId = scope.tenantId;
    const at = lib.nowStamp();
    const local = await database.prepare(`INSERT INTO audit
      (user_id,user_nama,aksi,modul,detail,created_at) VALUES (?,?,?,?,?,?)`).run(
      user ? user.id : null,
      user ? String(user.nama || 'system') : 'system',
      String(action || ''),
      String(moduleName || ''),
      String(detail || ''),
      at
    );

    let central;
    try {
      central = await database.withControl(async () => {
        let tenantName = String(meta.tenantName || '');
        if (!tenantName) {
          const row = await database.prepare('SELECT nama FROM tenants WHERE id=?').get(tenantId);
          tenantName = String(row && row.nama || '');
        }
        return database.prepare(`INSERT INTO audit_log
          (tenant_id,tenant_nama,user_id,user_nama,role,ip,aksi,modul,detail,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          tenantId,
          tenantName,
          user ? user.id : null,
          user ? String(user.nama || 'system') : 'sistem',
          user ? String(user.role || '') : 'sistem',
          String(meta.ip || ''),
          String(action || ''),
          String(moduleName || ''),
          String(detail || ''),
          at
        );
      });
    } catch (error) {
      if (error instanceof Error) error.auditLocalWritten = true;
      throw error;
    }

    return { at, local, central };
  }

  return { getSetting, setSetting, settingsAll, tableNames, tableExists, columns, logAudit };
}

module.exports = { createMysqlDbHelpers };
