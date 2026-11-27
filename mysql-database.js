'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

function createMysqlDatabase(runtime) {
  if (!runtime || typeof runtime.schoolPool !== 'function' || typeof runtime.controlPool !== 'function'
    || typeof runtime.query !== 'function' || typeof runtime.withTransaction !== 'function') {
    throw new TypeError('Runtime MySQL tidak lengkap.');
  }

  const context = new AsyncLocalStorage();

  function current() {
    const scope = context.getStore();
    if (!scope) throw new Error('Query MySQL harus dijalankan dalam scope tenant atau control plane.');
    return scope;
  }

  function withScope(scope, fn) {
    if (typeof fn !== 'function') throw new TypeError('Callback scope MySQL wajib berupa fungsi.');
    return context.run(scope, fn);
  }

  function withTenant(tenant, fn) {
    const tenantId = Number(tenant && tenant.id);
    if (!Number.isInteger(tenantId) || tenantId < 1) throw new Error('Tenant MySQL tidak valid.');
    const pool = runtime.schoolPool(tenantId);
    return withScope({ kind: 'tenant', tenantId, pool }, fn);
  }

  function withControl(fn) {
    return withScope({ kind: 'control', tenantId: null, pool: runtime.controlPool() }, fn);
  }

  function statement(sql, execute) {
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('Query MySQL kosong.');
    return {
      get: async (...values) => {
        const rows = await execute(sql, values);
        if (!Array.isArray(rows)) throw new Error('Query get() tidak menghasilkan daftar baris.');
        return rows[0];
      },
      all: async (...values) => {
        const rows = await execute(sql, values);
        if (!Array.isArray(rows)) throw new Error('Query all() tidak menghasilkan daftar baris.');
        return rows;
      },
      run: async (...values) => {
        const result = await execute(sql, values);
        if (!result || Array.isArray(result) || typeof result !== 'object') {
          throw new Error('Query run() tidak menghasilkan metadata eksekusi.');
        }
        return {
          changes: Number(result.affectedRows) || 0,
          lastInsertRowid: Number(result.insertId) || 0
        };
      }
    };
  }

  async function query(sql, values = []) {
    const scope = current();
    return runtime.query(scope.pool, sql, values);
  }

  function prepare(sql) {
    return statement(sql, query);
  }

  async function transaction(fn) {
    const scope = current();
    if (typeof fn !== 'function') throw new TypeError('Callback transaksi wajib berupa fungsi.');
    return runtime.withTransaction(scope.pool, tx => fn({
      query: tx.query,
      prepare: sql => statement(sql, tx.query)
    }));
  }

  function currentScope() {
    const scope = context.getStore();
    return scope ? { kind: scope.kind, tenantId: scope.tenantId } : null;
  }

  return { withTenant, withControl, query, prepare, transaction, currentScope };
}

module.exports = { createMysqlDatabase };
