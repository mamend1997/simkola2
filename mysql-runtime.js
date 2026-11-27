'use strict';

const mysqlDefault = require('mysql2/promise');

const DATABASE_NAME = /^[A-Za-z0-9_]{1,64}$/;

function databaseName(value, label) {
  const name = String(value || '').trim();
  if (!DATABASE_NAME.test(name)) throw new Error(`${label} MySQL tidak valid.`);
  return name;
}

function readConfig(env = process.env) {
  const config = {
    host: String(env.MYSQL_HOST || '').trim(),
    port: Number(env.MYSQL_PORT || 3306),
    user: String(env.MYSQL_USER || '').trim(),
    password: String(env.MYSQL_PASSWORD || ''),
    tenantDatabase: databaseName(env.MYSQL_TENANT_DB, 'Nama database sekolah'),
    controlDatabase: databaseName(env.MYSQL_CONTROL_DB, 'Nama database control plane'),
    connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT || 10)
  };
  if (!config.host || !config.user || !config.password) {
    throw new Error('Konfigurasi MySQL belum lengkap: MYSQL_HOST, MYSQL_USER, dan MYSQL_PASSWORD wajib diatur.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('MYSQL_PORT harus berupa port TCP yang valid.');
  }
  if (!Number.isInteger(config.connectionLimit) || config.connectionLimit < 1 || config.connectionLimit > 100) {
    throw new Error('MYSQL_CONNECTION_LIMIT harus bilangan bulat antara 1 dan 100.');
  }
  if (config.tenantDatabase === config.controlDatabase) {
    throw new Error('Database sekolah dan control plane harus berbeda.');
  }
  return config;
}

function createMysqlRuntime({ env = process.env, mysql = mysqlDefault } = {}) {
  const config = readConfig(env);
  const pools = new Map();
  const options = database => ({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database,
    charset: 'utf8mb4',
    timezone: '+07:00',
    dateStrings: true,
    decimalNumbers: true,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true
  });

  function poolFor(database) {
    const name = databaseName(database, 'Nama database');
    let pool = pools.get(name);
    if (!pool) {
      pool = mysql.createPool(options(name));
      pools.set(name, pool);
    }
    return pool;
  }

  function schoolPool(tenantId = 1, mysqlDatabase) {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id < 1) throw new Error('ID sekolah MySQL tidak valid.');
    if (mysqlDatabase) return poolFor(mysqlDatabase);
    if (id !== 1) throw new Error(`Database MySQL untuk sekolah ${id} belum dikonfigurasi.`);
    return poolFor(config.tenantDatabase);
  }

  async function query(pool, sql, values = []) {
    if (!pool || typeof pool.query !== 'function') throw new Error('Pool MySQL tidak valid.');
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('Query MySQL kosong.');
    const [rows] = await pool.query(sql, values);
    return rows;
  }

  async function checkConnections() {
    async function inspect(pool, expectedDatabase, label) {
      const rows = await query(pool, 'SELECT DATABASE() AS database_name, VERSION() AS server_version');
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row || row.database_name !== expectedDatabase || !row.server_version) {
        throw new Error(`Pemeriksaan koneksi ${label} gagal atau mengarah ke database yang tidak sesuai.`);
      }
      return { database: row.database_name, version: row.server_version };
    }

    const [school, control] = await Promise.all([
      inspect(schoolPool(1), config.tenantDatabase, 'sekolah'),
      inspect(poolFor(config.controlDatabase), config.controlDatabase, 'control plane')
    ]);
    return { school, control };
  }

  async function withTransaction(pool, fn) {
    if (!pool || typeof pool.getConnection !== 'function') throw new Error('Pool MySQL tidak valid.');
    if (typeof fn !== 'function') throw new TypeError('Callback transaksi wajib berupa fungsi.');
    const connection = await pool.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      const result = await fn({
        query: async (sql, values = []) => {
          if (typeof sql !== 'string' || !sql.trim()) throw new Error('Query MySQL kosong.');
          const [rows] = await connection.query(sql, values);
          return rows;
        }
      });
      await connection.commit();
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          if (error instanceof Error) error.rollbackError = rollbackError;
          else throw new AggregateError([new Error(String(error)), rollbackError], 'Query gagal dan rollback MySQL juga gagal.');
        }
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async function close() {
    const active = Array.from(pools.values());
    pools.clear();
    await Promise.all(active.map(pool => pool.end()));
  }

  return {
    config: Object.freeze({
      host: config.host,
      port: config.port,
      tenantDatabase: config.tenantDatabase,
      controlDatabase: config.controlDatabase,
      connectionLimit: config.connectionLimit
    }),
    controlPool: () => poolFor(config.controlDatabase),
    schoolPool,
    query,
    checkConnections,
    withTransaction,
    close
  };
}

module.exports = { createMysqlRuntime, readConfig };
