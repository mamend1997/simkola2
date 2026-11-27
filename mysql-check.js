'use strict';

require('./env');
const { createMysqlRuntime } = require('./mysql-runtime');

async function main() {
  const runtime = createMysqlRuntime();
  try {
    const result = await runtime.checkConnections();
    console.log(`MySQL connected: school=${result.school.database}, control=${result.control.database}, server=${result.school.version}`);
  } finally {
    await runtime.close();
  }
}

main().catch(error => {
  console.error('[mysql-check] ' + error.message);
  process.exitCode = 1;
});
