'use strict';

const assert = require('node:assert/strict');
const lib = require('../lib');
const registerAuthRoutes = require('../routes/auth');

const routes = new Map();
const handlers = {
  get(path, fn) { routes.set(`GET ${path}`, fn); },
  post(path, fn) { routes.set(`POST ${path}`, fn); }
};
const tenant = { id: 2, school_code: 'K7B2', nama: 'Sekolah Uji', db_file: 'school_two_db' };
const admin = {
  id: 1, nama: 'Admin Uji', email: 'admin@sekolah.test',
  username: 'admin', role: 'super_admin', aktif: 1
};
let otpEnabled = false;
const registrations = [];
const saas = {
  appName: () => 'SIMKOLA',
  appLogo: () => '',
  tema: () => '#4F46E5',
  packageRows: async () => [{
    kode: 'basic', nama: 'Basic', aktif: 1, self_trial: 1, trial_hari: 7
  }],
  packageSelfTrial: pkg => !!Number(pkg.self_trial),
  packageTrialDays: pkg => Number(pkg.trial_hari),
  defaultPackage: async () => ({ kode: 'basic' }),
  daftarOtpCfg: async () => ({ aktif: otpEnabled, menit: 10 }),
  otpDaftarValid: async () => ({ ok: false }),
  otpDaftarSend: async () => ({
    ok: true, token: 'otp-token', menit: 10, target: '628123456789',
    demo: true, demo_kode: '4321', kirim: { ok: false, reason: 'gateway belum diatur' }
  }),
  otpDaftarVerify: async () => ({ ok: true, row: { phone: '628123456789' } }),
  captchaConfig: async () => ({ provider: 'off', siteKey: '' }),
  verifyCaptcha: async () => null,
  clientIpOf: () => '127.0.0.1',
  regStatus: async () => ({ blocked: false }),
  regLog: async () => {},
  regHit: async () => ({ blocked: false }),
  regLimits: async () => ({ blockHours: 24 }),
  phoneAlreadyRegistered: async () => false,
  createTenant: async input => {
    registrations.push(input);
    return tenant;
  }
};
const dbm = {
  DB_DRIVER: 'mysql',
  db: {
    prepare: () => ({ get: async () => admin })
  },
  withTenant: async (_tenant, fn) => fn(),
  runAsTenant: async (_tenant, fn) => fn(),
  mysqlHelpers: {}
};
const ui = {
  ASSET_V: 'test',
  fontLinks: () => '',
  logoPreconnect: () => '',
  themeCss: () => '',
  icon: () => ''
};
registerAuthRoutes({
  ...handlers,
  dbm,
  lib,
  ui,
  page() {},
  ctx() { return {}; },
  guard() {},
  can() { return true; },
  setSession: async () => 'session-token',
  COOKIE: 'simkeu_sid',
  roleLabel: role => role,
  permissionMatrix() { return {}; },
  renderError() { return ''; },
  uploadMedia() {},
  saas
});

function response() {
  return {
    statusCode: 200,
    htmlBody: '',
    jsonBody: null,
    redirectTo: '',
    html(body, status = 200) { this.htmlBody = body; this.statusCode = status; },
    json(body, status = 200) { this.jsonBody = body; this.statusCode = status; },
    redirect(location) { this.redirectTo = location; },
    set() {}
  };
}
function request({ query = '', body = {} } = {}) {
  return {
    BASE: '',
    query: new URLSearchParams(query),
    body,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  };
}

async function main() {
  const formResponse = response();
  await routes.get('GET /register')(request(), formResponse);
  assert.equal(formResponse.statusCode, 200);
  assert.match(formResponse.htmlBody, /Pendaftaran Sekolah Baru/);
  assert.match(formResponse.htmlBody, /name="jenjang"/);
  assert.doesNotMatch(formResponse.htmlBody, /sementara dinonaktifkan/);

  otpEnabled = true;
  const sendResponse = response();
  await routes.get('POST /register/otp/kirim')(request({
    body: { telp: '+628123456789' }
  }), sendResponse);
  assert.equal(sendResponse.statusCode, 200);
  assert.equal(sendResponse.jsonBody.ok, true);
  assert.equal(sendResponse.jsonBody.demo_kode, '4321');

  const verifyResponse = response();
  await routes.get('POST /register/otp/verifikasi')(request({
    body: { token: 'otp-token', kode: '4321' }
  }), verifyResponse);
  assert.deepEqual(verifyResponse.jsonBody, { ok: true, phone: '08123456789' });

  const blockedResponse = response();
  await routes.get('POST /register')(request({
    body: {
      nama: 'Sekolah Uji',
      alamat: 'Jl. Contoh',
      admin_nama: 'Admin Uji',
      admin_email: 'admin@sekolah.test',
      admin_password: 'StrongPass1!',
      telp: '+628123456789',
      jenjang: 'SD/MI',
      otp_token: 'otp-token'
    }
  }), blockedResponse);
  assert.match(blockedResponse.redirectTo, /Nomor%20WhatsApp%20belum%20terverifikasi/);
  assert.equal(registrations.length, 0);

  otpEnabled = false;
  const registerResponse = response();
  await routes.get('POST /register')(request({
    body: {
      nama: 'Sekolah Uji',
      alamat: 'Jl. Contoh',
      admin_nama: 'Admin Uji',
      admin_email: 'admin@sekolah.test',
      admin_password: 'StrongPass1!',
      jenjang: 'SD/MI'
    }
  }), registerResponse);
  assert.match(registerResponse.redirectTo, /^\/daftar\/sukses\?t=/);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].paket, 'basic');
  assert.equal(registrations[0].jenjang, 'SD/MI');

  const token = new URL(registerResponse.redirectTo, 'http://localhost').searchParams.get('t');
  const successResponse = response();
  await routes.get('GET /daftar/sukses')(request({ query: `t=${encodeURIComponent(token)}` }), successResponse);
  assert.equal(successResponse.statusCode, 200);
  assert.match(successResponse.htmlBody, /Pendaftaran berhasil dan akun admin sudah tersimpan/);
  assert.match(successResponse.htmlBody, /K7B2/);

  console.log('MySQL registration route checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
