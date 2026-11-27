'use strict';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_VARCHAR_LENGTH = 191;
const MYSQL_COLUMN_MIGRATIONS = [
  ['users', 'foto', 'VARCHAR(1024) NULL'],
  ['users', 'username', 'VARCHAR(191) NULL'],
  ['users', 'tenant_id', 'BIGINT NULL'],
  ['transaksi', 'is_penyesuaian', 'TINYINT NOT NULL DEFAULT 0'],
  ['transaksi', 'periode_penyesuaian', 'VARCHAR(32) NULL'],
  ['transaksi', 'transfer_group', 'VARCHAR(191) NULL'],
  ['transaksi', 'jumlah_barang', 'DOUBLE NOT NULL DEFAULT 1'],
  ['transaksi', 'harga_satuan', 'DOUBLE NOT NULL DEFAULT 0'],
  ['transaksi', 'void_at', 'VARCHAR(32) NULL'],
  ['transaksi', 'void_by', 'VARCHAR(191) NULL'],
  ['transaksi', 'void_alasan', 'LONGTEXT NULL'],
  ['transaksi', 'void_reversal_id', 'BIGINT NULL'],
  ['transaksi', 'void_of', 'BIGINT NULL'],
  ['bku', 'pemasukan_saldo', 'TINYINT NOT NULL DEFAULT 0'],
  ['bku', 'auto_mode', 'TINYINT NOT NULL DEFAULT 0'],
  ['bku', 'rab', 'DOUBLE NOT NULL DEFAULT 0'],
  ['bku', 'public_token', 'VARCHAR(64) NULL'],
  ['bku', 'is_public', 'TINYINT NOT NULL DEFAULT 0'],
  ['spp', 'diterima_manual', 'DOUBLE NOT NULL DEFAULT 0'],
  ['pinjaman_mutasi', 'no_bukti', 'VARCHAR(191) NULL'],
  ['pinjaman_mutasi', 'nama_pihak', 'LONGTEXT NULL'],
  ['pinjaman_mutasi', 'bukti_url', 'VARCHAR(1024) NULL'],
  ['pinjaman_mutasi', 'metode', "VARCHAR(191) NULL DEFAULT 'tunai'"],
  ['pinjaman_mutasi', 'coa_id', 'BIGINT NULL'],
  ['sessions', 'alert_pending', 'BIGINT NOT NULL DEFAULT 0'],
  ['sessions', 'ta_id', 'BIGINT NULL'],
  ['piutang_bayar', 'payroll_id', 'BIGINT NULL'],
  ['pegawai', 'tipe', "VARCHAR(191) NOT NULL DEFAULT 'guru'"],
  ['pegawai', 'nip', 'VARCHAR(191) NULL'],
  ['pegawai', 'tanggal_lahir', 'VARCHAR(32) NULL'],
  ['pegawai', 'whatsapp', "VARCHAR(191) NULL DEFAULT ''"],
  ['iuran_nominal', 'tingkat', "VARCHAR(191) NOT NULL DEFAULT ''"],
  ['payroll', 'jam_pembantu_kepsek', 'DOUBLE NOT NULL DEFAULT 0'],
  ['payroll', 'jam_wali_kelas', 'DOUBLE NOT NULL DEFAULT 0'],
  ['payroll', 'urutan', 'BIGINT NOT NULL DEFAULT 0'],
  ['payroll', 'jam_sertifikasi', 'DOUBLE NOT NULL DEFAULT 0'],
  ['aset', 'tampil', 'TINYINT NOT NULL DEFAULT 1'],
  ['iuran_bayar', 'kwitansi_no', 'VARCHAR(191) NULL'],
  ['iuran_bayar', 'print_count', 'BIGINT NOT NULL DEFAULT 0'],
  ['iuran_bayar', 'posted_at', 'VARCHAR(32) NULL'],
  ['iuran_bayar', 'bulan', 'BIGINT NULL'],
  ['iuran_bayar', 'sumber', "VARCHAR(191) NULL DEFAULT 'manual'"],
  ['iuran_bayar', 'beasiswa_id', 'BIGINT NULL'],
  ['iuran_tagihan', 'writeoff', 'LONGTEXT NULL'],
  ['iuran_tagihan', 'writeoff_at', 'VARCHAR(32) NULL'],
  ['iuran_tagihan', 'writeoff_by', 'VARCHAR(191) NULL'],
  ['iuran_tagihan', 'beasiswa_locked', 'TINYINT NOT NULL DEFAULT 0'],
  ['iuran_tagihan', 'beasiswa_id', 'BIGINT NULL'],
  ['iuran_grup', 'coa_id', 'BIGINT NULL'],
  ['iuran_grup', 'jatuh_tempo', 'BIGINT NULL'],
  ['iuran_grup', 'public_token', 'VARCHAR(64) NULL'],
  ['iuran_grup', 'is_public', 'TINYINT NOT NULL DEFAULT 0'],
  ['kelas', 'public_token', 'VARCHAR(64) NULL'],
  ['kelas', 'is_public', 'TINYINT NOT NULL DEFAULT 0'],
  ['ekskul_honor', 'jenis', "VARCHAR(191) NULL DEFAULT ''"],
  ['ekskul_honor', 'posting_periode', 'VARCHAR(32) NULL'],
  ['portal_pesan', 'sumber', "VARCHAR(191) NULL DEFAULT 'siswa'"],
  ['portal_pesan', 'ref', 'VARCHAR(191) NULL'],
  ['portal_pesan', 'balasan', 'LONGTEXT NULL'],
  ['portal_pesan', 'balas_oleh', 'VARCHAR(191) NULL'],
  ['portal_pesan', 'balas_at', 'VARCHAR(32) NULL'],
  ['beasiswa', 'deskripsi', "VARCHAR(191) NULL DEFAULT ''"],
  ['beasiswa', 'grup_id', 'BIGINT NULL'],
  ['beasiswa', 'bulan_mask', "VARCHAR(191) NULL DEFAULT ''"],
  ['beasiswa', 'persen', 'DOUBLE NOT NULL DEFAULT 0']
];

const MYSQL_INDEX_MIGRATIONS = [
  { name: 'idx_iuran_nominal_grup', table: 'iuran_nominal', columns: ['grup_id', 'tingkat'] },
  { name: 'uq_bku_public_token', table: 'bku', columns: ['public_token'], unique: true },
  { name: 'uq_iuran_grup_public_token', table: 'iuran_grup', columns: ['public_token'], unique: true },
  { name: 'uq_kelas_public_token', table: 'kelas', columns: ['public_token'], unique: true }
];

const MYSQL_TENANT_UNIQUE_INDEXES = [
  { name: 'uq_siswa_tenant_nisn', table: 'siswa', columns: ['tenant_id', 'nisn'], nonEmpty: ['nisn'] },
  { name: 'uq_pegawai_tenant_nip', table: 'pegawai', columns: ['tenant_id', 'nip'], nonEmpty: ['nip'] },
  { name: 'uq_transaksi_tenant_bukti', table: 'transaksi', columns: ['tenant_id', 'no_bukti'], nonEmpty: ['no_bukti'] }
];

function splitTopLevel(value, delimiter = ',') {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === delimiter && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function statementsOf(schema) {
  const source = String(schema || '').replace(/\/\*[\s\S]*?\*\//g, '');
  return splitTopLevel(source, ';').filter(Boolean);
}

function keyColumnsOf(definitions) {
  const keys = new Set();
  for (const definition of definitions) {
    const tableKey = definition.match(/^(?:PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)/i);
    if (tableKey) {
      for (const column of tableKey[1].split(',')) {
        const name = column.trim().replace(/[`"]/g, '');
        if (IDENTIFIER.test(name)) keys.add(name);
      }
      continue;
    }
    const column = definition.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/);
    if (column && /\b(?:PRIMARY KEY|UNIQUE)\b/i.test(column[2])) keys.add(column[1]);
  }
  return keys;
}

function textType(table, column, isKey, hasDefault) {
  if ((table === 'siswa' && column === 'nisn')
    || (table === 'pegawai' && column === 'nip')
    || (table === 'transaksi' && column === 'no_bukti')) {
    return 'VARCHAR(191)';
  }
  if (isKey || hasDefault) {
    if (column === 'email') return 'VARCHAR(320)';
    if (column === 'school_code') return 'VARCHAR(16)';
    return `VARCHAR(${DEFAULT_VARCHAR_LENGTH})`;
  }
  return 'LONGTEXT';
}

function convertTable(statement, columnTypes) {
  const match = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/i);
  if (!match) throw new Error('DDL tabel SQLite tidak dikenali.');
  const table = match[1];
  const definitions = splitTopLevel(match[2]);
  const keys = keyColumnsOf(definitions);
  const columns = new Map();
  const converted = definitions.map(definition => {
    if (/^(?:PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT)\b/i.test(definition)) {
      return definition.replace(/\bINTEGER\b/gi, 'BIGINT');
    }

    const column = definition.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/);
    if (!column) throw new Error(`Kolom DDL SQLite tidak dikenali pada tabel ${table}.`);
    const name = column[1];
    let rest = column[2];

    if (/\bINTEGER\s+PRIMARY KEY\s+AUTOINCREMENT\b/i.test(rest)) {
      rest = rest.replace(/\bINTEGER\s+PRIMARY KEY\s+AUTOINCREMENT\b/i, 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY');
    } else if (/\bINTEGER\s+PRIMARY KEY\b/i.test(rest)) {
      rest = rest.replace(/\bINTEGER\s+PRIMARY KEY\b/i, 'BIGINT UNSIGNED NOT NULL PRIMARY KEY');
    } else {
      rest = rest.replace(/\bINTEGER\b/gi, 'BIGINT').replace(/\bREAL\b/gi, 'DOUBLE');
      if (/\bTEXT\b/i.test(rest)) {
        const type = textType(table, name, keys.has(name) || /\b(?:PRIMARY KEY|UNIQUE)\b/i.test(rest), /\bDEFAULT\b/i.test(rest));
        rest = rest.replace(/\bTEXT\b/i, type);
      }
    }

    const type = (rest.match(/^(?:BIGINT UNSIGNED NOT NULL AUTO_INCREMENT|BIGINT UNSIGNED NOT NULL|BIGINT|DOUBLE|VARCHAR\(\d+\)|LONGTEXT|TEXT)/i) || [])[0];
    if (type) columns.set(name, type.toUpperCase().startsWith('LONGTEXT') || type.toUpperCase() === 'TEXT' ? 'LONGTEXT' : type.toUpperCase());
    return `${name} ${rest}`;
  });
  columnTypes.set(table, columns);
  return `CREATE TABLE IF NOT EXISTS ${table} (${converted.join(', ')}) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

function convertIndex(statement, columnTypes) {
  const match = statement.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)(?:\s+WHERE\s+([\s\S]+))?$/i);
  if (!match) throw new Error('DDL indeks SQLite tidak dikenali.');
  const [, unique, index, table, columnList, where] = match;
  if (where) throw new Error(`Indeks parsial SQLite ${index} memerlukan migrasi MySQL eksplisit.`);
  const fields = splitTopLevel(columnList).map(raw => {
    const field = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?$/i);
    if (!field) throw new Error(`Kolom indeks ${index} tidak dikenali.`);
    const [, name, direction] = field;
    const type = columnTypes.get(table) && columnTypes.get(table).get(name);
    const prefix = type === 'LONGTEXT' ? '(191)' : '';
    return `${name}${prefix}${direction ? ` ${direction}` : ''}`;
  });
  return {
    table,
    index,
    sql: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${index} ON ${table} (${fields.join(', ')})`
  };
}

function mysqlSchemaStatements(schema) {
  const tables = new Map();
  const indexDefinitions = [];
  for (const statement of statementsOf(schema)) {
    if (/^CREATE TABLE IF NOT EXISTS\b/i.test(statement)) {
      const types = new Map();
      const sql = convertTable(statement, types);
      const table = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i)[1];
      tables.set(table, { sql, types: types.get(table) });
    } else if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)) {
      indexDefinitions.push(statement);
    } else {
      throw new Error('Pernyataan DDL SQLite tidak didukung dalam skema aplikasi.');
    }
  }

  const tableTypes = new Map([...tables].map(([table, schemaTable]) => [table, schemaTable.types]));
  const indexes = indexDefinitions.map(statement => convertIndex(statement, tableTypes));
  const statements = [...tables.values()].map(item => item.sql);
  for (const item of indexes) {
    if (!tables.has(item.table)) throw new Error(`Tabel ${item.table} untuk indeks tidak ditemukan.`);
    statements.push(item.sql);
  }
  return statements;
}

async function initializeMysqlSchema(database, schema, tenantId = 1) {
  if (!database || typeof database.query !== 'function' || typeof database.prepare !== 'function') {
    throw new TypeError('Database MySQL async tidak valid untuk inisialisasi skema.');
  }
  const tenant = Number(tenantId);
  if (!Number.isInteger(tenant) || tenant < 1) throw new Error('ID tenant MySQL tidak valid untuk migrasi skema.');
  const statements = mysqlSchemaStatements(schema);
  let tablesEnsured = 0;
  let indexesCreated = 0;
  let columnsAdded = 0;
  let tenantColumnsAdded = 0;
  let rowsAssigned = 0;
  let duplicateIndexesSkipped = 0;
  const tableStatements = statements.filter(sql => sql.startsWith('CREATE TABLE'));
  const indexStatements = statements.filter(sql => sql.startsWith('CREATE INDEX') || sql.startsWith('CREATE UNIQUE INDEX'));
  for (const sql of tableStatements) {
    await database.query(sql);
    tablesEnsured++;
  }

  const tableRows = await database.prepare(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'`).all();
  const tables = new Set(tableRows.map(row => String(row.name)));
  const columnCache = new Map();
  async function tableColumns(table) {
    if (!columnCache.has(table)) {
      const rows = await database.prepare(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`).all(table);
      columnCache.set(table, new Set(rows.map(row => String(row.name))));
    }
    return columnCache.get(table);
  }
  async function ensureIndex({ name, table, columns, unique = false, nonEmpty = [] }) {
    if (!tables.has(table)) return false;
    const exists = await database.prepare(`SELECT 1 AS found FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1`).get(table, name);
    if (exists) return false;
    if (nonEmpty.length) {
      const predicates = nonEmpty.map(column => `COALESCE(\`${column}\`,'')<>''`).join(' AND ');
      const duplicate = await database.prepare(`SELECT 1 AS found FROM \`${table}\`
        WHERE ${predicates} GROUP BY ${columns.map(column => `\`${column}\``).join(', ')}
        HAVING COUNT(*)>1 LIMIT 1`).get();
      if (duplicate) {
        duplicateIndexesSkipped++;
        return false;
      }
    }
    const types = await tableColumns(table);
    if (!columns.every(column => types.has(column))) return false;
    const sqlColumns = columns.map(column => `\`${column}\``).join(', ');
    await database.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${sqlColumns})`);
    indexesCreated++;
    return true;
  }

  for (const [table, column, definition] of MYSQL_COLUMN_MIGRATIONS) {
    if (!tables.has(table)) continue;
    const columns = await tableColumns(table);
    if (columns.has(column)) continue;
    await database.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    columns.add(column);
    columnsAdded++;
  }

  for (const table of tables) {
    const columns = await tableColumns(table);
    if (!columns.has('tenant_id')) {
      await database.query(`ALTER TABLE \`${table}\` ADD COLUMN \`tenant_id\` BIGINT NULL`);
      columns.add('tenant_id');
      tenantColumnsAdded++;
    }
    const result = await database.prepare(`UPDATE \`${table}\` SET tenant_id=? WHERE tenant_id IS NULL`).run(tenant);
    rowsAssigned += Number(result.changes) || 0;
  }

  for (const sql of indexStatements) {
    const index = sql.match(/^CREATE (?:UNIQUE )?INDEX ([A-Za-z_][A-Za-z0-9_]*) ON ([A-Za-z_][A-Za-z0-9_]*)/i);
    if (!index) throw new Error('DDL indeks MySQL internal tidak dikenali.');
    const [, indexName, tableName] = index;
    const exists = await database.prepare(`SELECT 1 AS found FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1`).get(tableName, indexName);
    if (!exists) {
      await database.query(sql);
      indexesCreated++;
    }
  }

  for (const index of MYSQL_INDEX_MIGRATIONS) await ensureIndex(index);
  for (const index of MYSQL_TENANT_UNIQUE_INDEXES) await ensureIndex({ ...index, unique: true });

  return { tablesEnsured, indexesCreated, columnsAdded, tenantColumnsAdded, rowsAssigned, duplicateIndexesSkipped };
}

module.exports = {
  mysqlSchemaStatements,
  initializeMysqlSchema,
  MYSQL_COLUMN_MIGRATIONS,
  MYSQL_INDEX_MIGRATIONS,
  MYSQL_TENANT_UNIQUE_INDEXES
};
