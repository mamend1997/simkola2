'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const perf = require('./perf');
const { URL } = require('url');

const envCfg = require('./env');
const lib = require('./lib');
const dbm = require('./db');
const ui = require('./ui');
const saas = require('./saas');
const storage = require('./storage');
const queue = require('./queue');
const bayariuran = require('./bayariuran');
const publicUrl = require('./publicurl');

const PORT = process.env.PORT || 3120;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 30 * 1024 * 1024;
const MEDIA_BASE = String(process.env.APP_MEDIA_URL || 'http://127.0.0.1:4310').replace(/\/+$/, '');

/* ---------------- helper ---------------- */
function clientIp(req) {
  const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = f || String(req.socket && req.socket.remoteAddress || '');
  return ip.replace(/^::ffff:/, '').slice(0, 60);
}

/* ---------------- tiny router ---------------- */
const routes = [];
function add(method, pattern, handler) {
  const segs = pattern.split('/').filter(Boolean);
  routes.push({ method, segs, handler });
}
const get = (p, h) => add('GET', p, h);
const post = (p, h) => add('POST', p, h);
function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
      else if (s !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/* ---------------- responses ---------------- */
function makeRes(raw) {
  const res = { raw, status: 200, headers: {} };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.html = (body, status = 200) => {
    raw.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...res.headers
    });
    raw.end(body);
  };
  res.json = (obj, status = 200) => {
    raw.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...res.headers });
    raw.end(JSON.stringify(obj));
  };
  res.redirect = (loc, status = 303) => {
    raw.writeHead(status, { Location: loc, ...res.headers });
    raw.end();
  };
  res.file = (buffer, filename, mime) => {
    raw.writeHead(200, {
      'Content-Type': mime || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
      ...res.headers
    });
    raw.end(buffer);
  };
  res.notFound = () => res.html(renderError(404, 'Halaman tidak ditemukan', 'Periksa kembali alamat halaman yang Anda tuju.'), 404);
  return res;
}

function renderError(code, title, desc) {
  const ASSET_V = ui.ASSET_V;
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${lib.esc(title)}</title><link rel="stylesheet" href="assets/app.css?v=${ASSET_V}" onerror="this.remove()">
<style>body{display:grid;place-items:center;min-height:100vh;margin:0;font-family:Inter,system-ui,sans-serif;background:#FFFBF8;color:#2A1A12}
.b{text-align:center;max-width:440px;padding:40px}h1{font-size:64px;margin:0;color:#F97316;letter-spacing:-.04em}p{color:#8A7A70}</style>
</head><body><div class="b"><h1>${code}</h1><h2>${lib.esc(title)}</h2><p>${lib.esc(desc)}</p><p><a href="./" style="color:#EA580C;font-weight:700">Kembali ke Dashboard</a></p></div></body></html>`;
}

/* ---------------- request context ---------------- */
const COOKIE = 'simkeu_sid';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Ukuran data terlalu besar (maks 30 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(buf.toString('utf8') || '{}')); } catch (e) { resolve({}); }
        return;
      }
      const out = {};
      const s = buf.toString('utf8');
      for (const [k, v] of new URLSearchParams(s)) {
        // nama field yang dikirim berulang (mis. checkbox ceklis) dikumpulkan jadi array
        if (out[k] === undefined) out[k] = v;
        else if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

/**
 * Body MENTAH (byte asli) — wajib untuk verifikasi tanda tangan webhook
 * (HMAC dihitung dari body yang dikirim gateway, bukan hasil JSON.parse).
 */
function readRawBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Ukuran data terlalu besar.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** urai body mentah sesuai Content-Type (JSON atau form-urlencoded) */
function bodyOfRaw(raw, contentType) {
  const s = String(raw === undefined || raw === null ? '' : raw);
  const type = String(contentType || '');
  if (!s) return {};
  if (type.includes('json') || /^\s*[{[]/.test(s)) {
    try { return JSON.parse(s); } catch (e) { /* lanjut ke form */ }
  }
  const out = {};
  try {
    for (const [k, v] of new URLSearchParams(s)) {
      if (out[k] === undefined) out[k] = v;
      else if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    }
  } catch (e) { /* bukan form */ }
  return out;
}

/* ---------------- auth & permissions ---------------- */
function can(user, module, action) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const r = dbm.mainDb.prepare('SELECT allowed FROM permissions WHERE role=? AND module=? AND action=?').get(user.role, module, action);
  return !!(r && r.allowed);
}
function roleLabel(role) { return dbm.ROLE_LABEL[role] || role; }

function permissionMatrix() {
  const rows = dbm.mainDb.prepare('SELECT * FROM permissions').all();
  const map = {};
  for (const r of rows) map[`${r.role}|${r.module}|${r.action}`] = r.allowed;
  return map;
}

/* ---------------- sesi login (control plane, multi-tenant) ---------------- */
async function setSession(userId, tenantId, alertPending, welcome) {
  const tenant = await saas.tenantById(tenantId);
  const t = await saas.createSession({ userId, tenantId, kind: 'tenant', alertPending: alertPending || 0, welcome });
  await dbm.openTenantConn(tenantId, (tenant || {}).db_file)
    .prepare('UPDATE users SET last_login=? WHERE id=?').run(lib.nowStamp(), userId);
  return t;
}

/** sesi dari cookie: { row, tenant } untuk sekolah, { row } untuk super admin, atau null */
async function readSession(req) {
  const c = parseCookies(req.headers.cookie);
  const row = await saas.getSession(c[COOKIE]);
  if (!row) return null;
  if (row.kind === 'saas') return { row };
  const tenant = await saas.tenantById(row.tenant_id);
  if (!tenant) return null;
  return { row, tenant };
}

/** muat akun sekolah dari database tenant (dipanggil DI DALAM konteks tenant) */
async function loadTenantUser(session) {
  const u = await dbm.db.prepare('SELECT id,nama,email,role,aktif,jabatan,foto,username FROM users WHERE id=?').get(session.user_id);
  return u && u.aktif ? u : null;
}

/** tahun pelajaran aktif untuk sesi ini (dropdown header) + query ?ta= */
async function resolveTa(req) {
  const s = req.sessionRow;
  let taId = s && s.ta_id ? Number(s.ta_id) : null;
  const qta = Number((req.query && req.query.get) ? (req.query.get('ta') || 0) : 0);
  if (qta && await dbm.tahunById(qta)) {
    taId = qta;
    try { await saas.updateSession(s.token, { ta_id: qta }); } catch (e) { }
  }
  if (!taId) {
    taId = await dbm.taAutoId();
    if (taId && s) { try { await saas.updateSession(s.token, { ta_id: taId }); } catch (e) { } }
  }
  req.taId = taId;
  req.TA = await dbm.tahunById(taId) || await dbm.activeTahun();
}

/* ---------------- upload berkas (terisolasi per sekolah) ---------------- */
/**
 * Nama berkas selalu memuat tenant_id + stempel waktu + acak (lihat storage.js)
 * sehingga berkas sekolah berbeda tidak pernah saling menimpa.
 */
async function uploadMedia(base64, filename, opts = {}) {
  const conn = dbm.currentTenantConn();
  const tenantId = Number(opts.tenantId || (conn && conn.__tenantId) || 1);
  const jenis = opts.jenis || 'lain';
  if (!process.env.APP_MEDIA_TOKEN && !opts.allowLocal) {
    // tanpa token media (mode lokal) tetap disimpan di storage/tenants/<id>/...
  }
  const r = await storage.saveUpload({ base64, filename, jenis, tenantId });
  return r.url;
}

/* ---------------- shared page helpers ---------------- */
/**
 * Alamat absolut aplikasi dari permintaan (untuk URL yang harus ditempel
 * di dashboard pihak ketiga, mis. webhook payment gateway).
 * Urutan: APP_BASE_URL → host permintaan (+ X-Forwarded-*) → path saja.
 */
function absUrl(req, pathname = '') {
  const env = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const tail = String(pathname || '');
  const base = String((req && req.BASE) || '').replace(/\/+$/, '');
  if (env) return env + base + tail;
  const h = String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '')
    .split(',')[0].trim();
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  return (h ? `${proto}://${h}` : '') + base + tail;
}

function ctx(req) {
  const s = dbm.settingsAll();
  const ta = dbm.taOf(req) || null;
  return {
    req,
    base: req.BASE,
    absUrl: (p = '') => absUrl(req, p),
    publicAbsUrl: (p = '') => publicUrl.absolute(dbm, req, p),
    user: req.user,
    q: req.query,
    settings: s,
    ta,
    taId: ta ? ta.id : null,
    taList: dbm.taOptions(),
    can: (m, a) => can(req.user, m, a),
    roleLabel: roleLabel(req.user?.role),
    pendingCount: ta
      ? dbm.db.prepare(`SELECT COUNT(*) c FROM transaksi t JOIN bku b ON b.id=t.bku_id
          WHERE t.status='pending' AND b.tahun_ajaran_id=? AND ${dbm.bkuTransactionVisibleSql('t', 'b')}`).get(ta.id).c
      : dbm.db.prepare(`SELECT COUNT(*) c FROM transaksi t JOIN bku b ON b.id=t.bku_id
          WHERE t.status='pending' AND ${dbm.bkuTransactionVisibleSql('t', 'b')}`).get().c
  };
}

function page(req, res, { title, sub = '', active, content }) {
  const c = ctx(req);
  const tenant = req.tenant || null;
  const st = saas.statusOf(tenant);
  // pengumuman global dari Super Admin (banner top bar + pop-up sekali per sesi)
  const notices = saas.visibleAnnouncements(tenant ? tenant.id : null);
  res.html(ui.layout({
    title, sub, user: c.user, active, base: c.base, content,
    query: req.query, roleLabel: c.roleLabel, pendingCount: c.pendingCount,
    can: (m, a) => can(req.user, m, a || 'view'),
    logoStamp: c.settings.sekolah_logo || '',
    taList: c.taList, taId: c.taId, path: req.url,
    // tampilan global (tema, nama & logo aplikasi, penataan menu) selalu dari database sekolah aktif
    navHidden: String(c.settings.nav_hidden || ''),
    navCfg: dbm.navUi(),
    tema: dbm.temaWarnaGlobal(),
    appName: dbm.appNamaGlobal(),
    // sub-judul bilah samping: isian sekolah → default Branding Sistem Super Admin → bawaan
    appSub: dbm.appSub() || (saas && saas.appSub ? saas.appSub() : dbm.APP_SUB_DEFAULT),
    appLogo: dbm.appLogoGlobal(),
    appLogoSmall: dbm.mainSetting('app_logo_small', ''),
    mode: String(c.settings.mode_tema || 'light') === 'dark' ? 'dark' : 'light',
    // multi-tenant: fitur yang aktif untuk sekolah ini + penanda mode bantuan super admin
    features: saas.enabledKeys(tenant),
    tenantInfo: tenant ? { nama: tenant.nama, kode: tenant.school_code, status: st, paket: tenant.paket } : null,
    impersonate: (req.sessionRow && req.sessionRow.imp_by)
      ? { nama: (saas.adminById(req.sessionRow.imp_by) || {}).nama || 'Super Admin' }
      : null,
    announcements: notices,
    // notifikasi lonceng (pembayaran portal, dsb) sesuai role pengguna
    notifs: (() => { try { bayariuran.ensureTables(dbm); return dbm.notifList(req.user.role, { limit: 10 }); } catch (e) { return []; } })(),
    notifCount: (() => { try { return dbm.notifCount(req.user.role); } catch (e) { return 0; } })()
  }));
}

/** bangun URL tujuan + parameter flash (ok/err/warn) tanpa duplikasi */
function flashUrl(pathname, key, msg) {
  try {
    const u = new URL(pathname, 'http://local');
    ['ok', 'err', 'warn'].forEach(k => u.searchParams.delete(k));
    u.searchParams.set(key, msg);
    // pakai %20 (bukan '+') agar konsisten dengan redirect lain & mudah dibaca di log
    return u.pathname + '?' + u.searchParams.toString().replace(/\+/g, '%20');
  } catch (e) {
    return pathname + (pathname.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(msg);
  }
}

class HttpError extends Error {
  constructor(status, title, desc) { super(title); this.status = status; this.title = title; this.desc = desc; }
}
function guard(req, res, module, action) {
  if (!req.user) throw new HttpError(302, 'Perlu masuk', 'Silakan login terlebih dahulu.');
  if (!can(req.user, module, action)) {
    throw new HttpError(403, 'Akses ditolak', 'Role Anda tidak memiliki hak akses untuk tindakan ini. Hubungi Super Admin bila Anda merasa ini keliru.');
  }
  return true;
}

/* ---------------- favicon: logo tenant atau branding default sistem ---------------- */
const favCache = { url: null, buf: null, mime: '', at: 0 };
const favSysCache = { url: null, buf: null, mime: '', at: 0 };
/** favicon DEFAULT sistem (dipakai portal login utama / panel Super Admin) */
async function sysFavicon() {
  const fav = String(saas.get('saas_favicon', '') || '');
  const logo = String(saas.get('saas_logo', '') || '');
  const src = fav || logo;
  const now = Date.now();
  if (src && favSysCache.url === src && favSysCache.buf && now - favSysCache.at < 30 * 60 * 1000) return favSysCache;
  if (src) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = String(r.headers.get('content-type') || 'image/png').split(';')[0];
        if (buf.length && /^image\//.test(ct)) {
          Object.assign(favSysCache, { url: src, buf, mime: ct, at: now });
          return favSysCache;
        }
      }
    } catch (e) { }
  }
  // fallback: SVG inisial nama aplikasi
  const nama = String(saas.appName() || 'SIMKEU').trim();
  const ini = (nama.charAt(0) || 'S').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><rect width="100" height="100" rx="24" fill="url(#g)"/><text x="50" y="70" font-family="Inter,Arial,sans-serif" font-size="52" font-weight="800" fill="#fff" text-anchor="middle">${ini}</text></svg>`;
  Object.assign(favSysCache, { url: 'sys', buf: Buffer.from(svg, 'utf8'), mime: 'image/svg+xml', at: now });
  return favSysCache;
}

async function faviconResponse(pathname) {
  const logo = dbm.getSetting('sekolah_logo', '');
  const now = Date.now();
  if (logo && favCache.url === logo && favCache.buf && now - favCache.at < 30 * 60 * 1000) {
    return { buf: favCache.buf, mime: favCache.mime };
  }
  if (logo) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(logo, { signal: ctrl.signal });
      clearTimeout(to);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = String(r.headers.get('content-type') || 'image/png').split(';')[0];
        if (buf.length && /^image\//.test(ct)) {
          favCache.url = logo; favCache.buf = buf; favCache.mime = ct; favCache.at = now;
          return { buf, mime: ct };
        }
      }
    } catch (e) { /* fallback ke inisial */ }
  }
  // fallback: SVG inisial sekolah (warna orange)
  const nama = String(dbm.getSetting('sekolah_nama', 'Sekolah')).trim();
  const initial = (nama.replace(/^(SMA|SMK|SMP|SD|MA|MTs|S)\s+/i, '').charAt(0) || nama.charAt(0) || 'S').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FB923C"/><stop offset="1" stop-color="#EA580C"/></linearGradient></defs><rect width="100" height="100" rx="24" fill="url(#g)"/><text x="50" y="70" font-family="Inter,Arial,sans-serif" font-size="52" font-weight="800" fill="#fff" text-anchor="middle">${initial}</text></svg>`;
  return { buf: Buffer.from(svg, 'utf8'), mime: 'image/svg+xml' };
}

/* ---------------- tahun ajaran aktif (dropdown header) ---------------- */
post('/ta/pilih', async (req, res) => {
  if (!req.user) return res.redirect(req.BASE + '/login');
  const id = Number(req.body.ta || 0);
  const ta = id ? await dbm.tahunById(id) : null;
  const backDemo = req.user && req.user.role === 'demo';
  if (req.sessionRow && !backDemo) {
    try { await saas.updateSession(req.sessionRow.token, { ta_id: ta ? ta.id : null }); } catch (e) { }
  }
  const backRaw = String(req.body.back || '');
  const back = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/.test(backRaw) && !backRaw.startsWith('//') ? backRaw : '/';
  const msg = ta ? `Tahun Pelajaran aktif: ${ta.nama}. Seluruh tampilan menyesuaikan tahun pelajaran ini.` : 'Tahun Pelajaran default digunakan.';
  res.redirect(req.BASE + flashUrl(back, 'ok', msg));
});

/* ---------------- module routes ---------------- */
require('./routes/auth')({ get, post, dbm, lib, ui, page, ctx, guard, can, setSession, COOKIE, roleLabel, permissionMatrix, uploadMedia, renderError, flashUrl, saas });
require('./routes/dashboard')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl, saas });
require('./routes/approval')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/master')({ get, post, dbm, lib, ui, page, ctx, guard, can, uploadMedia, flashUrl, saas, refreshPortalMap: portalMapRebuild });
require('./routes/aset_akun')({ get, post, dbm, lib, ui, page, ctx, guard, can, uploadMedia, flashUrl });
require('./routes/transaksi')({ get, post, dbm, lib, ui, page, ctx, guard, can, uploadMedia, flashUrl });
require('./routes/rekon')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/piutang')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/piutang_lain')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/piutang_lainnya')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/pegawai')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/payroll')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/payroll_kolom')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/beasiswa')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/tutup')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/bku_detail')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/import')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/laporan')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl, saas });
require('./routes/sistem')({ get, post, dbm, lib, ui, page, ctx, guard, can, permissionMatrix, uploadMedia, flashUrl });
require('./routes/desain')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl, uploadMedia });
require('./routes/akademik')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/kelas_tingkat')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/iuran')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/reminder')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/ekskul')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/trash')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/mutasi')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/portal')({ get, post, dbm, lib, ui, guard, flashUrl, saas, uploadMedia, ctx });
require('./routes/pembayaran')({ get, post, dbm, lib, ui, page, ctx, guard, can, uploadMedia, flashUrl, saas });
require('./routes/portal_pegawai')({ get, post, dbm, lib, ui });
require('./routes/catatan')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl });
require('./routes/panduan')({ get, post, dbm, lib, ui, page, ctx, guard, can, uploadMedia, flashUrl, saas });
require('./routes/layanan')({ get, post, dbm, lib, ui, page, ctx, guard, uploadMedia, flashUrl, saas });
require('./routes/backup_tg')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl, saas });
require('./routes/tiket')({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl, saas, uploadMedia });
require('./routes/superadmin')({ get, post, dbm, lib, ui, saas, queue, uploadMedia, renderError, refreshPortalMap: portalMapRebuild });
require('./routes/superadmin_db')({ get, post, dbm, lib, ui, saas });
/* dokumen legalitas: halaman publik (ToS/SLA) + menu sidebar panel sekolah (/legal/tos, /legal/sla) */
require('./routes/legal')({ get, dbm, lib, ui, saas, page, ctx, guard });
/* domain publik: tautan acak BKU & Grup Iuran (tanpa login) */
require('./routes/publik')({ get, dbm, lib, ui, ctx });

/* ---------------- halaman status (suspend / fitur nonaktif) ---------------- */
function statusPage({ base, badge, title, desc, tone = 'warn', actions = [] }) {
  const col = tone === 'err' ? '#DC2626' : tone === 'info' ? '#2563EB' : '#EA580C';
  const bg = tone === 'err' ? '#FEF2F2' : tone === 'info' ? '#EFF6FF' : '#FFF7ED';
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${lib.esc(title)}</title><link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}">
<link rel="icon" href="${base}/favicon.ico"></head>
<body style="display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<div class="card" style="max-width:560px;width:100%;padding:32px;text-align:center">
  <div style="display:inline-flex;align-items:center;gap:8px;background:${bg};color:${col};font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:7px 14px;border-radius:999px">${lib.esc(badge || 'Informasi')}</div>
  <h2 style="margin:18px 0 8px;font-size:24px;letter-spacing:-.02em">${lib.esc(title)}</h2>
  <p class="muted" style="margin:0 auto 22px;max-width:420px;line-height:1.65">${desc}</p>
  <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
    ${actions.map(a => `<a class="btn ${a.primary ? 'btn-primary' : ''}" href="${base}${a.href}">${lib.esc(a.label)}</a>`).join('')}
  </div>
</div></body></html>`;
}

/* ---------------- halaman sistem: maintenance & domain belum terverifikasi ---------------- */
function maintenancePage({ base, m }) {
  const nama = saas.appName();
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sistem Dalam Perbaikan</title>
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}"><link rel="icon" href="${base}/favicon.ico">
<style>body{display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.mt-card{max-width:600px;width:100%;text-align:center;padding:38px 32px}
.mt-ico{width:76px;height:76px;margin:0 auto 18px;border-radius:24px;display:grid;place-items:center;
background:linear-gradient(135deg,#F59E0B,#EA580C);color:#fff;font-size:34px}
.mt-card h1{font-size:25px;margin:0 0 10px;letter-spacing:-.02em}
.mt-card p{line-height:1.7;margin:0 auto 20px;max-width:460px;color:var(--muted,#6B6577)}
.mt-eta{display:inline-block;background:#FFF7ED;color:#C2410C;font-weight:700;font-size:12.5px;
padding:8px 14px;border-radius:999px;margin-bottom:18px}</style></head>
<body><div class="card mt-card">
  <div class="mt-ico">&#9881;</div>
  <h1>Sistem Dalam Perbaikan</h1>
  <p>${lib.esc(m.pesan || 'Kami sedang melakukan pemeliharaan sistem. Silakan kembali beberapa saat lagi.')}</p>
  ${m.selesai ? `<div class="mt-eta">Perkiraan selesai: ${lib.esc(m.selesai)}</div>` : ''}
  <div class="flex" style="justify-content:center;gap:10px;flex-wrap:wrap">
    <a class="btn" href="${base}/">Coba Lagi</a>
    <a class="btn" href="${base}/login">Halaman Masuk</a>
  </div>
  <p class="small muted" style="margin-top:20px">${lib.esc(nama)} · pemeliharaan terjadwal oleh Super Admin Pusat</p>
</div></body></html>`;
}

function domainPendingPage({ base, tenant }) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Domain Belum Terverifikasi</title>
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}"><link rel="icon" href="${base}/favicon.ico">
</head><body style="display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<div class="card" style="max-width:560px;width:100%;padding:34px;text-align:center">
  <div style="width:64px;height:64px;border-radius:20px;margin:0 auto 16px;display:grid;place-items:center;background:#FEF3C7;color:#B45309;font-size:28px">!</div>
  <h2 style="margin:0 0 8px;font-size:22px">Domain Belum Terverifikasi</h2>
  <p class="muted" style="line-height:1.7;margin:0 auto 18px;max-width:420px">
    Domain ini terdaftar untuk <b>${lib.esc(tenant.nama)}</b> tetapi statusnya belum VERIFIED atau
    DNS belum mengarah ke server. Hubungi Super Admin Pusat untuk menyelesaikan verifikasi.</p>
  <a class="btn btn-primary" href="${base}/login">Buka halaman masuk</a>
</div></body></html>`;
}

/* ---------------- portal publik per sekolah (slug bisa diubah tiap tenant) ---------------- */
let portalMapCache = { at: 0, map: {} };
/** peta slug portal (unik antar sekolah) → tenant; slug kanonik ada di control plane */
/**
 * Bagian nama sekolah pada alamat portal: /<base>/<sub-slug>.
 * Diambil dari slug kanonik tenant (bagian pertama) atau nama sekolah.
 */
function portalBaseOf(t) {
  const slug = String((t && t.portal_slug) || '').trim().toLowerCase();
  const first = slug.split('/')[0].replace(/[^a-z0-9-]/g, '');
  if (first) return first;
  const nm = String((t && t.nama) || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return nm || ('sekolah-' + ((t && t.id) || 1));
}
/** segmen portal efektif satu sekolah + bagian nama sekolah */
function tenantPortalSegs(t) {
  const out = { base: portalBaseOf(t), siswa: 'portal-tagihan', pegawai: 'portal-pegawai', slip: 'portal-slip' };
  try {
    const conn = dbm.openTenantConn(t.id, t.db_file);
    const rows = conn.prepare("SELECT k,v FROM settings WHERE k IN ('portal_slug','portal_pegawai_slug','portal_slip_slug','portal_base_slug')").all();
    const g = (k, d) => {
      const r = rows.find(x => x.k === k);
      const v = String((r && r.v) || '').trim().toLowerCase();
      return v || d;
    };
    const DEF = { siswa: 'portal-tagihan', pegawai: 'portal-pegawai', slip: 'portal-slip' };
    for (const kind of ['siswa', 'pegawai', 'slip']) {
      let v = g('portal_slug', '') || '';
      if (kind === 'pegawai') v = g('portal_pegawai_slug', '');
      if (kind === 'slip') v = g('portal_slip_slug', '');
      /* nilai lama yang menabrak bagian nama sekolah (mis. sama persis) atau kosong
         akan menghasilkan alamat ganda /<sekolah>/<sekolah> → pakai default. */
      if (!v || v === out.base || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v)) v = DEF[kind];
      out[kind] = v;
    }
    /* Bagian nama sekolah SELALU mengikuti slug kanonik di control plane
       (bukan nilai lama di settings), lalu disinkronkan ke pengaturan sekolah
       agar tautan yang dibangun aplikasi memakai alamat yang sama. */
    const b = g('portal_base_slug', '');
    const upsert = conn.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
    let berubah = false;
    if (b !== out.base) { upsert.run('portal_base_slug', out.base); berubah = true; }
    for (const [kind, key] of [['siswa', 'portal_slug'], ['pegawai', 'portal_pegawai_slug'], ['slip', 'portal_slip_slug']]) {
      if (g(key, '') !== out[kind]) { upsert.run(key, out[kind]); berubah = true; }
    }
    if (berubah) { try { dbm.resetPortalSlugCache(); } catch (e) { } }
  } catch (e) { }
  return out;
}
/**
 * Peta alamat portal publik:
 *   "nama-sekolah/portal-tagihan" → { path:'/portal',        kind:'siswa'  }
 *   "nama-sekolah/portal-pegawai" → { path:'/portal-pegawai', kind:'pegawai' }
 *   "nama-sekolah/portal-slip"    → { path:'/portal-slip',    kind:'slip'   }
 * Alamat lama ("nama-sekolah/portal", "nama-sekolah") hanya dipakai untuk
 * MENGALIHKAN (redirect) pengunjung ke alamat lengkap yang baru.
 */
function portalSlugMap(force = false) {
  if (!force && Date.now() - portalMapCache.at < 60000) return portalMapCache.map;
  const map = {};
  let tenants = [];
  try { tenants = saas.allTenants(); } catch (e) { tenants = []; }
  const CANON = { siswa: '/portal', pegawai: '/portal-pegawai', slip: '/portal-slip' };
  const OLD_SEG = { siswa: 'portal', pegawai: 'portal-pegawai', slip: 'portal-slip' };
  for (const t of tenants) {
    const segs = tenantPortalSegs(t);
    // alamat kanonik lengkap
    for (const kind of ['siswa', 'pegawai', 'slip']) {
      const key = (segs.base + '/' + segs[kind]).toLowerCase();
      if (!map[key]) map[key] = { path: CANON[kind], tenantId: t.id, kind, key, canonical: true };
    }
    // alamat lama → redirect ke alamat lengkap
    for (const kind of ['siswa', 'pegawai', 'slip']) {
      const key = (segs.base + '/' + OLD_SEG[kind]).toLowerCase();
      const to = '/' + segs.base + '/' + segs[kind];
      if (!map[key]) map[key] = { path: CANON[kind], tenantId: t.id, kind, key, legacy: true, to };
    }
    // "/nama-sekolah" saja → redirect ke portal tagihan siswa
    const baseKey = segs.base.toLowerCase();
    if (!map[baseKey]) map[baseKey] = { path: '/portal', tenantId: t.id, kind: 'siswa', key: baseKey, legacy: true, to: '/' + segs.base + '/' + segs.siswa };
    /* halaman publik tambahan (transparansi BKU & Grup Iuran):
       /<nama-sekolah>/publik/bku/<token> · /<nama-sekolah>/publik/iuran/<token> */
    const pubKey = (segs.base + '/publik').toLowerCase();
    if (!map[pubKey]) map[pubKey] = { path: '/publik', tenantId: t.id, kind: 'publik', key: pubKey, canonical: true };
  }
  portalMapCache = { at: Date.now(), map };
  return map;
}
function portalMapRebuild() { return portalSlugMap(true); }
/** akses peta slug dengan aman (tanpa menyentuh properti bawaan Object) */
function map_get(map, key) {
  const k = String(key || '').toLowerCase();
  if (!k || !Object.prototype.hasOwnProperty.call(map, k)) return null;
  return map[k];
}
/**
 * Cocokkan slug portal dari segmen URL. Slug kanonik boleh dua bagian
 * ("nama-sekolah/tagihan") sehingga dua segmen dicoba lebih dulu.
 * → { key, hit, consumed } atau null
 */
function slugLookup(map, segs) {
  const list = Array.isArray(segs) ? segs : [];
  if (!list.length) return null;
  if (list.length >= 2) {
    const k2 = list[0] + '/' + list[1];
    if (map[k2]) return { key: k2, hit: map[k2], consumed: 2 };
  }
  if (map[list[0]]) return { key: list[0], hit: map[list[0]], consumed: 1 };
  return null;
}
/** sub-halaman portal siswa yang boleh menempel langsung pada slug (mis. /<slug>/hasil) */
const PORTAL_SUB_ROUTES = new Set(['siswa', 'pesan', 'cari', 'otp', 'verifikasi', 'hasil', 'cetak', 'nama', 'bayar', 'pay', 'notif']);
/**
 * Ubah sisa path setelah slug menjadi path portal kanonik.
 * '' → /portal · 'portal' → /portal · 'hasil' → /portal/hasil ·
 * 'portal-pegawai/hasil' → /portal-pegawai/hasil
 */
function portalRestToPath(rest) {
  const r = String(rest || '').replace(/^\/+/, '');
  if (!r) return '/portal';
  if (/^(portal|portal-pegawai|portal-slip)(\/|$)/.test(r)) return '/' + r;
  const first = r.split('/')[0];
  if (PORTAL_SUB_ROUTES.has(first)) return '/portal/' + r;
  return null;
}
/** alamat portal aktif satu sekolah (mengikuti slug kanonik, boleh dua bagian) */
function tenantPortalPath(tenant, kind) {
  const slug = String((tenant && tenant.portal_slug) || '').trim().toLowerCase();
  if (!slug) return '';
  const suffix = kind === 'pegawai' ? '/portal-pegawai' : kind === 'slip' ? '/portal-slip' : '';
  return '/' + slug + suffix;
}

const ALWAYS_ALLOWED = ['/info-layanan', '/perpanjang', '/akun', '/logout', '/login'];
/**
 * Hanya callback gateway bertanda tangan yang dikecualikan dari pemeriksaan
 * Origin/Fetch Metadata. Form browser lain tetap harus berasal dari aplikasi.
 */
const CSRF_EXEMPT = new Set([
  '/api/webhook/kasera', '/pay/webhook/kasera',
  '/pay/callback', '/portal/pay/callback'
]);
function isCsrfExempt(pathname) { return CSRF_EXEMPT.has(String(pathname || '')); }
function hasOriginMetadata(req) {
  return !!(req.headers.origin || req.headers.referer || req.headers['sec-fetch-site']);
}
function csrfRequestAllowed(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'none') return false;
  const source = String(req.headers.origin || req.headers.referer || '').trim();
  if (!source) return true;
  try {
    const from = new URL(source);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http'))
      .split(',')[0].trim().toLowerCase();
    return from.host.toLowerCase() === host.toLowerCase()
      && from.protocol.replace(':', '').toLowerCase() === proto;
  } catch (e) {
    return false;
  }
}

function isPublicPath(pathname) {
  if (['/login', '/register', '/daftar', '/logout'].includes(pathname)) return true;
  /* verifikasi OTP pendaftaran sekolah (tanpa sesi) */
  if (pathname === '/register/otp/kirim' || pathname === '/register/otp/verifikasi') return true;
  /* callback & webhook payment gateway (diverifikasi lewat signature, tanpa sesi) */
  if (pathname === '/pay/callback' || pathname === '/api/webhook/kasera' || pathname === '/pay/webhook/kasera') return true;
  // dokumen legalitas layanan dapat dibuka tanpa login
  if (['/syarat-ketentuan', '/sla'].includes(pathname)) return true;
  // halaman sukses pendaftaran (kredensial) — tanpa sesi, token sekali pakai
  if (pathname === '/daftar/sukses') return true;
  /* halaman publik bertoken (BKU & Grup Iuran) — keamanan dijaga oleh token acak,
     dan tautan resmi selalu memakai awalan nama sekolah */
  if (pathname.startsWith('/publik/')) return true;
  return false;
}

/* ---------------- server ---------------- */
function notFoundSchool(base, host) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 · Sekolah Tidak Ditemukan</title>
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}"><link rel="icon" href="${base}/favicon.ico">
</head><body style="display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<div class="card" style="max-width:520px;width:100%;padding:36px;text-align:center">
  <div style="font-size:58px;font-weight:800;color:var(--o-500);line-height:1;letter-spacing:-.04em">404</div>
  <h2 style="margin:10px 0 8px;font-size:21px">Sekolah Tidak Ditemukan</h2>
  <p class="muted" style="line-height:1.7;margin:0 auto 18px;max-width:400px">
    Alamat <b>${lib.esc(host || '')}</b> tidak terdaftar pada layanan ini. Periksa kembali tautan portal sekolah Anda.</p>
  <a class="btn btn-primary" href="${base}/login">Halaman Masuk</a>
</div></body></html>`;
}

/* ---------------- halaman status portal publik (akses ditolak) ---------------- */
function portalAccessPage({ base, tenant, access }) {
  const t = tenant || {};
  let logo = '', nama = t.nama || 'Sekolah';
  try {
    const conn = dbm.openTenantConn(t.id, t.db_file);
    const rows = conn.prepare("SELECT k,v FROM settings WHERE k IN ('sekolah_logo','sekolah_nama')").all();
    const g = k => String(((rows.find(x => x.k === k) || {}).v) || '');
    logo = g('sekolah_logo'); if (g('sekolah_nama')) nama = g('sekolah_nama');
  } catch (e) { }
  const INFO = {
    hidden: {
      badge: '404', title: 'Halaman Tidak Ditemukan',
      desc: 'Halaman portal publik sekolah ini sedang <b>disembunyikan</b> oleh Administrator Pusat, sehingga tidak dapat diakses umum.'
    },
    deleted: {
      badge: '404', title: 'Halaman Publik Tidak Tersedia',
      desc: 'Alamat portal publik sekolah ini sudah <b>dihapus</b>. Silakan hubungi petugas sekolah untuk informasi tagihan.'
    },
    private: {
      badge: '403', title: 'Halaman Publik Bersifat Private',
      desc: 'Halaman portal sekolah ini ditetapkan <b>Private</b> oleh Administrator Pusat — hanya untuk kalangan internal sekolah.'
    },
    unpublished: {
      badge: '503', title: 'Portal Sementara Ditutup',
      desc: 'Pengelola sekolah menonaktifkan halaman portal publik. Silakan hubungi bendahara sekolah untuk informasi tagihan.'
    }
  };
  const info = INFO[access.mode] || INFO.hidden;
  const mark = logo
    ? `<img src="${lib.esc(logo)}" alt="Logo" width="64" height="64" style="max-width:64px;max-height:64px;object-fit:contain">`
    : `<div style="width:58px;height:58px;border-radius:18px;margin:0 auto;display:grid;place-items:center;background:#FFF1E6;color:#EA580C;font-size:24px;font-weight:800">${lib.esc(String(nama).charAt(0))}</div>`;
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${lib.esc(info.title)} · ${lib.esc(nama)}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}"><link rel="icon" href="${base}/favicon.ico">
</head><body style="display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<div class="card" style="max-width:540px;width:100%;padding:34px;text-align:center">
  ${mark}
  <div style="font-weight:800;letter-spacing:-.02em;margin-top:12px">${lib.esc(nama)}</div>
  <div style="font-size:52px;font-weight:800;color:var(--o-500);line-height:1;letter-spacing:-.05em;margin:14px 0 6px">${lib.esc(info.badge)}</div>
  <h2 style="margin:0 0 8px;font-size:21px">${lib.esc(info.title)}</h2>
  <p class="muted" style="line-height:1.7;margin:0 auto 18px;max-width:400px">${info.desc}</p>
  <a class="btn btn-primary" href="${base}/login">Halaman Masuk Sekolah</a>
</div></body></html>`;
}

/* ---------------- halaman "alamat portal lama sudah tidak dipakai" ---------------- */
function portalMovedPage({ base, tenant, activeUrl, activeLabel }) {
  const t = tenant || {};
  let logo = '', nama = t.nama || 'Sekolah';
  try {
    const conn = dbm.openTenantConn(t.id, t.db_file);
    const rows = conn.prepare("SELECT k,v FROM settings WHERE k IN ('sekolah_logo','sekolah_nama')").all();
    const g = k => String(((rows.find(x => x.k === k) || {}).v) || '');
    logo = g('sekolah_logo'); if (g('sekolah_nama')) nama = g('sekolah_nama');
  } catch (e) { }
  const mark = logo
    ? `<img src="${lib.esc(logo)}" alt="Logo" width="64" height="64" style="max-width:64px;max-height:64px;object-fit:contain">`
    : `<div style="width:58px;height:58px;border-radius:18px;margin:0 auto;display:grid;place-items:center;background:#FFF1E6;color:#EA580C;font-size:24px;font-weight:800">${lib.esc(String(nama).charAt(0))}</div>`;
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Halaman Tidak Ditemukan · ${lib.esc(nama)}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}"><link rel="icon" href="${base}/favicon.ico">
</head><body style="display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<div class="card" style="max-width:540px;width:100%;padding:34px;text-align:center">
  ${mark}
  <div style="font-weight:800;letter-spacing:-.02em;margin-top:12px">${lib.esc(nama)}</div>
  <div style="font-size:52px;font-weight:800;color:var(--o-500);line-height:1;letter-spacing:-.05em;margin:14px 0 6px">404</div>
  <h2 style="margin:0 0 8px;font-size:21px">Halaman Tidak Ditemukan</h2>
  <p class="muted" style="line-height:1.7;margin:0 auto 16px;max-width:400px">
    Alamat portal ini <b>sudah tidak digunakan</b>. Silakan buka alamat portal sekolah yang berlaku:</p>
  ${activeUrl ? `<p style="margin:0 auto 18px"><a class="url-chip" href="${lib.esc(activeUrl)}" style="font-size:13px">${lib.esc(activeLabel || activeUrl)}</a></p>` : ''}
  <a class="btn btn-primary" href="${lib.esc(activeUrl || base + '/login')}">Buka Portal Sekolah</a>
</div></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const base = String(req.headers['x-public-base-path'] || '').replace(/\/$/, '');
  req.BASE = base;
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return makeRes(res).html('Bad request', 400); }
  const pathname0 = decodeURIComponent(url.pathname);
  req.query = url.searchParams;

  if (pathname0 === '/healthz' && req.method === 'GET') {
    try {
      saas.db.prepare('SELECT 1').get();
      dbm.mainDb.prepare('SELECT 1').get();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false }));
    }
  }

  // ---- static assets (tidak bergantung tenant) ----
  // Minifikasi + kompresi (gzip/brotli) + Cache-Control immutable bila URL memakai ?v=<versi>
  if (pathname0.startsWith('/assets/')) {
    const name = pathname0.slice('/assets/'.length).replace(/[^a-zA-Z0-9._-]/g, '');
    const fp = path.join(PUBLIC_DIR, name);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const mime = name.endsWith('.css') ? 'text/css; charset=utf-8'
        : name.endsWith('.js') ? 'application/javascript; charset=utf-8'
          : name.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      const versioned = url.searchParams.has('v');
      if (perf.sendAsset(req, res, fp, mime, versioned)) return;
      res.writeHead(200, {
        'Content-Type': mime, 'Cache-Control': perf.cacheControl(versioned),
        'Vary': 'Accept-Encoding'
      });
      return fs.createReadStream(fp).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }

  const R = makeRes(res);
  const session = await readSession(req);
  const isSuperPath = pathname0 === '/super-admin' || pathname0.startsWith('/super-admin/');

  // ---- penentuan tenant dari HOST (custom domain) ----
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const dom = (() => { try { return saas.tenantByDomain(host); } catch (e) { return null; } })();
  if (dom && !dom.verified && !isSuperPath) {
    return R.html(domainPendingPage({ base, tenant: dom.tenant }), 404);
  }
  const hostTenant = dom && dom.verified ? dom.tenant : null;

  /* ---- CALLBACK PAYMENT GATEWAY (QRIS otomatis) ----
     Dipanggil server gateway tanpa sesi; keaslian diverifikasi signature/token. */
  if (pathname0 === '/pay/callback') {
    try {
      const raw = await readRawBody(req);
      const body = bodyOfRaw(raw, req.headers['content-type']);
      const cfg = saas.gatewayCfg();
      if (!saas.paygw.verifyCallback(cfg, body, req.headers || {}, raw)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Signature callback tidak valid.' }));
      }
      const parsed = saas.paygw.parseCallback(cfg, body);
      const row = parsed.order_id ? saas.gatewayRow(parsed.order_id) : null;
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Transaksi tidak ditemukan.' }));
      }
      if (!parsed.paid) {
        saas.db.prepare('UPDATE saas_payments SET gateway_status=? WHERE id=?').run(parsed.status || 'PENDING', row.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, paid: false }));
      }
      const r = saas.gatewayMarkPaid(parsed.order_id, 'Payment Gateway');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, paid: true, sudah: r.sudah }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  /* ---- WEBHOOK KASERA PAY (publik, tanpa sesi, diverifikasi tanda tangan) ----
     POST /api/webhook/kasera
       header : kasera-signature-v1 = HMAC-SHA256(body mentah, WEBHOOK SECRET)
       event  : payment.paid → external_id → tagihan menjadi LUNAS
     Rute ini DIKECUALIKAN dari CSRF (lihat CSRF_EXEMPT) karena dipanggil
     server Kasera, bukan browser. Event dideduplikasi berdasarkan id event. */
  if (pathname0 === '/api/webhook/kasera' || pathname0 === '/pay/webhook/kasera') {
    const balas = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') return balas(405, { ok: false, error: 'Gunakan metode POST.' });
    try {
      const raw = await readRawBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
      const tenantHint = Number(url.searchParams.get('t') || url.searchParams.get('tenant') || 0) || 0;
      const hasil = await saas.kaseraHandleWebhook({ raw, body, headers: req.headers || {}, tenantHint });
      return balas(hasil.code, hasil.out);
    } catch (e) {
      console.error('[kasera] gagal memproses webhook:', e);
      return balas(500, { ok: false, error: 'Terjadi kesalahan saat memproses webhook: ' + e.message });
    }
  }

  /* ---- CALLBACK PEMBAYARAN IURAN PORTAL (QRIS per sekolah) ----
     order_id berbentuk IU<tenantId>-<acak>. Sekolah ditentukan dari query ?t=
     atau dari awalan order_id, lalu koneksi database sekolah tersebut dibuka. */
  if (pathname0 === '/portal/pay/callback') {
    const balas = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      const raw = await readRawBody(req);
      const body = bodyOfRaw(raw, req.headers['content-type']);
      const parsedRaw = saas.paygw.parseCallback({ provider: 'generic' }, body);
      const oid = String(parsedRaw.order_id || body.order_id || '');
      const tQuery = Number(new URL(req.url, 'http://x').searchParams.get('t') || 0);
      const tFromOrder = Number((/^IU(\d+)-/i.exec(oid) || [])[1] || 0);
      const tenant = saas.tenantById(tQuery || tFromOrder || 1);
      if (!tenant) return balas(404, { ok: false, error: 'Sekolah tidak ditemukan.' });
      const hasil = await dbm.runAsTenant(tenant, async () => {
        bayariuran.ensureTables(dbm);
        const conf = bayariuran.cfg(dbm, saas);
        if (!saas.paygw.verifyCallback(conf, body, req.headers || {}, raw)) {
          return { code: 401, out: { ok: false, error: 'Signature callback tidak valid.' } };
        }
        const parsed = saas.paygw.parseCallback(conf, body);
        const row = parsed.order_id ? bayariuran.byOrder(dbm, parsed.order_id) : null;
        if (!row) return { code: 404, out: { ok: false, error: 'Transaksi iuran tidak ditemukan.' } };
        if (!parsed.paid) {
          dbm.db.prepare('UPDATE iuran_checkout SET gateway_status=? WHERE id=?').run(parsed.status || 'PENDING', row.id);
          return { code: 200, out: { ok: true, paid: false } };
        }
        const r = bayariuran.applyPaid(dbm, row, { oleh: 'Payment Gateway', gatewayStatus: parsed.status || 'PAID' });
        return { code: 200, out: { ok: true, paid: true, sudah: r.sudah, baris: r.baris } };
      });
      return balas(hasil.code, hasil.out);
    } catch (e) {
      return balas(400, { ok: false, error: e.message });
    }
  }

  // ---- favicon: logo sekolah (bila ada konteks sekolah), selain itu branding default ----
  if (pathname0 === '/favicon.ico' || pathname0 === '/favicon.svg' || pathname0 === '/favicon.png') {
    const segsFav = pathname0.split('/').filter(Boolean);
    const slugFav = segsFav[0] || '';
    let tFav = (session && session.tenant) || hostTenant || null;
    if (!tFav && slugFav && !isSuperPath) {
      try {
        const m = portalSlugMap();
        const hit = m[slugFav] || m[slugFav.split('/')[0]]
          || Object.values(portalSlugMap(true)).find(x => String(x.key || '').split('/')[0] === slugFav);
        if (hit) tFav = saas.tenantById(hit.tenantId || hit.id);
      } catch (e) { }
    }
    try {
      const fav = tFav ? await dbm.runAsTenant(tFav, async () => faviconResponse()) : await sysFavicon();
      res.writeHead(200, { 'Content-Type': fav.mime, 'Cache-Control': 'public, max-age=1800' });
      return res.end(fav.buf);
    } catch (e) {
      res.writeHead(302, { Location: base + '/assets/app.css' });
      return res.end();
    }
  }

  function handleError(err, pathname) {
    if (err instanceof HttpError) {
      if (err.status === 302) return R.redirect(base + '/login?err=' + encodeURIComponent('Silakan masuk terlebih dahulu.'));
      return R.html(renderError(err.status, err.title, err.desc), err.status);
    }
    console.error('[ERROR]', pathname, err);
    const msg = String(err && err.message || err);
    if (req.method === 'POST') {
      const back = req.headers.referer || (base + '/');
      try {
        const u = new URL(back, 'http://x');
        u.searchParams.set('err', msg);
        return R.redirect(u.pathname + '?' + u.searchParams.toString());
      } catch (e) {
        return R.redirect(base + '/?err=' + encodeURIComponent(msg));
      }
    }
    R.html(renderError(500, 'Terjadi kesalahan', msg), 500);
  }

  async function runRoute(pathname) {
    const m = match(req.method === 'POST' ? 'POST' : 'GET', pathname);
    if (!m) return R.notFound();
    req.params = m.params;
    await m.handler(req, R);
  }

  /* ================= MODE PERBAIKAN (MAINTENANCE) ================= */
  const maint = (() => { try { return saas.maintenance(); } catch (e) { return { aktif: false }; } })();
  if (maint.aktif && !isSuperPath) {
    if (!storage.__filesPath || !pathname0.startsWith('/files/')) {
      return R.html(maintenancePage({ base, m: maint }), 503);
    }
  }

  /* ================= PORTAL SUPER ADMIN PUSAT (dedicated route) ================= */
  if (isSuperPath) {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const saasRow = await saas.getSession(cookies.simkeu_saas);
      const setupRow = await saas.getSession(cookies.simkeu_mfa);
      req.saasSession = saasRow && saasRow.kind === 'saas' ? saasRow : null;
      req.mfaSession = setupRow && setupRow.kind === 'saas_mfa_setup' ? setupRow : null;
      req.saasUser = req.saasSession ? await saas.adminById(req.saasSession.user_id) : null;
      req.body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body = await readBody(req);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        && (req.saasSession || req.mfaSession || hasOriginMetadata(req))
        && !isCsrfExempt(pathname0) && !csrfRequestAllowed(req)) {
        return R.html(renderError(403, 'Permintaan ditolak', 'Asal permintaan tidak sesuai dengan alamat aplikasi. Muat ulang halaman lalu coba kembali.'), 403);
      }
      return await dbm.runWithMeta({ ip: clientIp(req), tenantId: null }, () => runRoute(pathname0));
    } catch (err) { return handleError(err, pathname0); }
  }

  /* ================= BERKAS TERISOLASI PER SEKOLAH (mode lokal) ================= */
  if (pathname0.startsWith('/files/')) {
    const segs = pathname0.split('/').filter(Boolean); // files / tenant / jenis / name
    if (segs.length === 4) {
      const fp = storage.localFile(segs[1], segs[2], segs[3]);
      if (fp) {
        const ext = path.extname(fp).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp' : ext === '.pdf' ? 'application/pdf'
            : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
        // nama berkas unik per unggahan → aman di-cache selamanya
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
        return fs.createReadStream(fp).pipe(res);
      }
    }
    return R.html(renderError(404, 'Berkas tidak ditemukan', 'Berkas mungkin sudah dihapus.'), 404);
  }

  try {
    req.body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) req.body = await readBody(req);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      && !session && hasOriginMetadata(req) && !isCsrfExempt(pathname0) && !csrfRequestAllowed(req)) {
      return R.html(renderError(403, 'Permintaan ditolak', 'Asal permintaan tidak sesuai dengan alamat aplikasi.'), 403);
    }

    /* ---------- belum login: halaman publik + portal orang tua (slug per sekolah) ---------- */
    if (!session) {
      const segs = pathname0.split('/').filter(Boolean);
      const first = segs[0] || '';
      const kode = String((req.query.get && req.query.get('kode')) || (req.body && req.body.kode) || '').trim();
      const tByCode = kode ? saas.tenantByCode(kode) : null;
      const canonical = ['/portal', '/portal-pegawai', '/portal-slip'];
      const subRoutes = new Set(['siswa', 'pesan', 'cari', 'otp', 'verifikasi', 'hasil', 'cetak', 'nama', 'bayar']);
      const slugMap = (function () { const m = portalSlugMap(); return slugLookup(m, segs) ? m : portalSlugMap(true); })();
      // slug kanonik boleh dua bagian ("nama-sekolah/tagihan") → cocokkan 2 segmen lebih dulu
      const hitSlug = slugLookup(slugMap, segs);

      /**
       * ALAMAT PORTAL PUBLIK (berlaku untuk semua sekolah):
       *   ✓ /<nama-sekolah>/portal-tagihan        → tagihan iuran siswa (sub-slug bisa diubah)
       *   ✓ /<nama-sekolah>/portal-pegawai        → piutang pegawai
       *   ✓ /<nama-sekolah>/portal-slip           → slip gaji pegawai
       *   ✗ /portal, /portal-pegawai, /portal-slip, /<nama-sekolah>
       *     → dialihkan (302) ke alamat lengkap; bila sekolah mematikan alamat
       *       bawaan (portal_default_alias = off) → halaman 404.
       */
      const CANON = ['/portal', '/portal-pegawai', '/portal-slip'];
      const KINDS = { '/portal': 'siswa', '/portal-pegawai': 'pegawai', '/portal-slip': 'slip' };
      let portalPath = null, portalTenant = null, redirectTo = null;

      /* (A) domain khusus terverifikasi → portal berada di akar domain (tanpa nama sekolah) */
      if (hostTenant) {
        if (pathname0 === '/') { portalPath = '/portal'; portalTenant = hostTenant; }
        else {
          for (const c of CANON) {
            if (pathname0 === c || pathname0.startsWith(c + '/')) { portalPath = pathname0; portalTenant = hostTenant; break; }
          }
        }
      }

      /* (B) alamat LENGKAP yang sah: /<nama-sekolah>/<sub-slug>[/sub-halaman] */
      if (!portalPath && segs.length >= 2) {
        const key = (segs[0] + '/' + segs[1]).toLowerCase();
        const hit = slugMap[key];
        if (hit) {
          const rest = segs.slice(2).join('/');
          portalPath = hit.path + (rest ? '/' + rest : '');
          portalTenant = saas.tenantById(hit.tenantId);
          /* alamat lama (mis. /sekolah/portal) → alihkan ke /sekolah/portal-tagihan */
          if (hit.legacy && hit.to) {
            const alias = (() => {
              if (!portalTenant) return { on: true };
              try {
                return dbm.runAsTenant(portalTenant, () => dbm.portalDefaultAlias());
              } catch (e) { return { on: true }; }
            })();
            if (!alias.on) {
              return R.html(portalMovedPage({
                base, tenant: portalTenant, activeUrl: base + hit.to, activeLabel: hit.to
              }), 404);
            }
            if (req.method === 'GET') redirectTo = hit.to + (rest ? '/' + rest : '');
          }
        }
      }

      /* (C) alamat lama tanpa nama sekolah: /portal, /portal-pegawai, /portal-slip, /<nama-sekolah> */
      if (!portalPath && !redirectTo && segs.length >= 1) {
        const firstSeg = segs[0].toLowerCase();
        const kindOfFirst = firstSeg === 'portal' ? 'siswa' : firstSeg === 'portal-pegawai' ? 'pegawai' : firstSeg === 'portal-slip' ? 'slip' : null;
        const baseHit = map_get(slugMap, firstSeg);
        if (kindOfFirst || (baseHit && baseHit.legacy)) {
          /* tentukan sekolah: kode sekolah → domain khusus → satu-satunya sekolah → /portal/<slug> */
          let t = tByCode || hostTenant || null;
          let consumed = 1;
          if (!t && kindOfFirst === 'siswa' && segs[1] && !subRoutes.has(segs[1])) {
            const t2 = segs[2] ? saas.tenantByPortalSlug(segs[1] + '/' + segs[2]) : null;
            t = t2 || saas.tenantByPortalPrefix(segs[1]);
            consumed = t2 ? 3 : 2;
          }
          if (!t && baseHit) t = saas.tenantById(baseHit.tenantId);
          /* hanya alamat lama generik (/portal, /portal-pegawai, /portal-slip) yang boleh
             memakai satu-satunya sekolah sebagai tujuan — segmen lain harus dikenali. */
          if (!t && kindOfFirst) {
            try { const all = saas.allTenants(); if (all.length === 1) t = all[0]; } catch (e) { }
          }
          if (!t) return R.html(notFoundSchool(base, segs[0]), 404);
          /* halaman publik sekolah yang sudah dihapus (slug dikosongkan) tidak dilayani */
          if (!String(t.portal_slug || '').trim()) return R.html(notFoundSchool(base, segs[0]), 404);
          const kind = kindOfFirst || 'siswa';
          const segsT = tenantPortalSegs(t);
          const targetSeg = kind === 'pegawai' ? segsT.pegawai : kind === 'slip' ? segsT.slip : segsT.siswa;
          const rest = segs.slice(consumed).join('/');
          const alias = (() => {
            try { return dbm.runAsTenant(t, () => dbm.portalDefaultAlias()); } catch (e) { return { on: true }; }
          })();
          if (!alias.on) {
            const to = '/' + segsT.base + '/' + targetSeg + (rest ? '/' + rest : '');
            return R.html(portalMovedPage({ base, tenant: t, activeUrl: base + to, activeLabel: to }), 404);
          }
          const to = '/' + segsT.base + '/' + targetSeg + (rest ? '/' + rest : '');
          portalPath = (kind === 'pegawai' ? '/portal-pegawai' : kind === 'slip' ? '/portal-slip' : '/portal') + (rest ? '/' + rest : '');
          portalTenant = t;
          if (req.method === 'GET') redirectTo = to;
        }
      }

      /* bentuk /<slug>/portal... dengan sekolah yang tidak dikenal → 404 tegas */
      if (!portalPath && !redirectTo && segs.length >= 2
        && ['portal', 'portal-tagihan', 'portal-pegawai', 'portal-slip'].includes(String(segs[1] || '').toLowerCase())) {
        return R.html(notFoundSchool(base, segs[0]), 404);
      }

      /* alamat sah tetapi berupa alamat lama → alihkan (302) ke alamat lengkap */
      if (redirectTo && portalTenant) {
        const q = url.searchParams.toString();
        return R.redirect(base + redirectTo + (q ? '?' + q : ''));
      }

      if (portalPath) {
        const t = tByCode || portalTenant || saas.tenantById(1);
        if (!t) return R.html(renderError(503, 'Belum ada sekolah', 'Belum ada sekolah yang terdaftar pada layanan ini.'), 503);
        /* ---- validasi akses halaman publik (Super Admin override + sakelar sekolah) ---- */
        const access = (() => { try { return saas.portalAccess(t, portalPath); } catch (e) { return { ok: true }; } })();
        if (!access.ok) return R.html(portalAccessPage({ base, tenant: t, access }), access.status);
        return await dbm.runAsTenant(t, async () => {
          req.tenant = t;
          req.TA = null; req.taId = null;
          try {
            await dbm.runWithMeta({ ip: clientIp(req), tenantId: t.id, tenantNama: t.nama }, () => runRoute(portalPath));
          } catch (err) { handleError(err, portalPath); }
        });
      }
      if (!isPublicPath(pathname0)) {
        if (req.method === 'POST') return R.redirect(base + '/login?err=' + encodeURIComponent('Sesi Anda berakhir. Silakan masuk kembali.'));
        return R.redirect(base + '/login');
      }
      req.tenant = null;
      return await dbm.runWithMeta({ ip: clientIp(req) }, () => runRoute(pathname0));
    }

    /* ---------- super admin memakai cookie sekolah? tolak dengan sopan ---------- */
    if (session.row.kind === 'saas') return R.redirect(base + '/super-admin');

    /* ---------- sudah login: seluruh request berjalan di database sekolahnya ---------- */
    const tenant = session.tenant;
    return await dbm.runAsTenant(tenant, async () => {
      let pathname = pathname0;
      try { pathname = dbm.portalRewrite(pathname0) || pathname0; } catch (e) { }
      /* alamat portal per sekolah juga berlaku untuk pengguna yang sudah login:
         /<nama-sekolah>/<sub-slug>[/sub-halaman] → route portal kanonik. */
      try {
        const segsP = pathname0.split('/').filter(Boolean);
        if (segsP.length >= 2) {
          const m = portalSlugMap();
          const hit = map_get(m, segsP[0] + '/' + segsP[1]) || map_get(portalSlugMap(true), segsP[0] + '/' + segsP[1]);
          if (hit) {
            const rest = segsP.slice(2).join('/');
            pathname = hit.path + (rest ? '/' + rest : '');
          }
        } else if (segsP.length === 1) {
          /* /<nama-sekolah> saja (pengguna login) → alihkan ke portal tagihan */
          const hitB = map_get(portalSlugMap(), segsP[0]) || map_get(portalSlugMap(true), segsP[0]);
          if (hitB && hitB.legacy && hitB.to) {
            const q = url.searchParams.toString();
            return R.redirect(base + hitB.to + (q ? '?' + q : ''));
          }
        }
      } catch (e) { }
      req.tenant = tenant;
      req.sessionRow = session.row;
      return await dbm.runWithMeta({ ip: clientIp(req), tenantId: tenant.id, tenantNama: tenant.nama }, async () => {
        try {
          // ---- keamanan sesi: sesi harus benar-benar milik sekolah ini ----
          if (Number(session.row.tenant_id) !== Number(tenant.id)) {
            await saas.destroySession(session.row.token);
            R.set('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
            return R.redirect(base + '/login?err=' + encodeURIComponent('Sesi tidak valid untuk sekolah ini. Silakan masuk kembali.'));
          }
          const u = await loadTenantUser(session.row);
          if (!u) {
            await saas.destroySession(session.row.token);
            R.set('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
            return R.redirect(base + '/login?err=' + encodeURIComponent('Akun Anda tidak aktif. Hubungi admin sekolah.'));
          }
          if (u.tenant_id !== undefined && u.tenant_id !== null && Number(u.tenant_id) !== Number(tenant.id)) {
            await saas.destroySession(session.row.token);
            return R.redirect(base + '/login?err=' + encodeURIComponent('Akun tidak terikat pada sekolah ini.'));
          }
          req.user = u;
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
            && !isCsrfExempt(pathname) && !csrfRequestAllowed(req)) {
            return R.html(renderError(403, 'Permintaan ditolak', 'Asal permintaan tidak sesuai dengan alamat aplikasi. Muat ulang halaman lalu coba kembali.'), 403);
          }

          // ---- pemblokiran otomatis (masa aktif habis / ditangguhkan) ----
          if (saas.isBlocked(tenant) && !ALWAYS_ALLOWED.some(p => pathname === p || pathname.startsWith(p + '/'))) {
            return R.html(statusPage({
              base, badge: 'Masa aktif berakhir', tone: 'err',
              title: 'Akses sekolah ditangguhkan sementara',
              desc: `Masa aktif <b>${lib.esc(tenant.nama)}</b> (${lib.esc(tenant.school_code)}) berakhir pada <b>${lib.esc(tenant.expires_at || '-')}</b>.
                Data sekolah tetap aman dan akan langsung aktif kembali setelah perpanjangan diverifikasi.`,
              actions: [{ label: 'Info Layanan & Perpanjang', href: '/info-layanan', primary: true }, { label: 'Keluar', href: '/logout' }]
            }), 403);
          }

          // ---- feature flagging: blokir akses langsung ke fitur yang dimatikan ----
          const blockedLabel = saas.blockedFeature(tenant, pathname);
          if (blockedLabel) {
            return R.html(statusPage({
              base, badge: 'Fitur tidak aktif', tone: 'warn',
              title: blockedLabel + ' belum tersedia',
              desc: `Fitur ini tidak termasuk paket <b>${lib.esc(saas.PAKET[tenant.paket] || tenant.paket)}</b> sekolah Anda.
                Hubungi Super Admin Pusat untuk mengaktifkannya.`,
              actions: [{ label: 'Kembali ke Dashboard', href: '/', primary: true }, { label: 'Info Layanan', href: '/info-layanan' }]
            }), 403);
          }

          // ---- halaman publik yang diblokir/dihapus Super Admin tetap tertutup (termasuk sesi sekolah) ----
          if (/^\/(portal|portal-pegawai|portal-slip)(\/|$)/.test(pathname)) {
            const acc = (() => { try { return saas.portalAccess(tenant, pathname); } catch (e) { return { ok: true }; } })();
            if (!acc.ok) return R.html(portalAccessPage({ base, tenant, access: acc }), acc.status);
          }
          // ---- alamat bawaan /portal (tanpa nama sekolah) → alihkan ke alamat lengkap ----
          if (/^\/(portal|portal-pegawai|portal-slip)(\/|$)/.test(pathname0) && !hostTenant) {
            const segsL = pathname0.split('/').filter(Boolean);
            const kindL = segsL[0] === 'portal' ? 'siswa' : segsL[0] === 'portal-pegawai' ? 'pegawai' : 'slip';
            const sT = tenantPortalSegs(tenant);
            const restL = segsL.slice(1).join('/');
            const to = '/' + sT.base + '/' + (kindL === 'pegawai' ? sT.pegawai : kindL === 'slip' ? sT.slip : sT.siswa) + (restL ? '/' + restL : '');
            const alias = (() => { try { return dbm.portalDefaultAlias(); } catch (e) { return { on: true }; } })();
            if (!alias.on) return R.html(portalMovedPage({ base, tenant, activeUrl: base + to, activeLabel: to }), 404);
            if (req.method === 'GET') {
              const q = url.searchParams.toString();
              return R.redirect(base + to + (q ? '?' + q : ''));
            }
          }

          const demoMode = u.role === 'demo';
          const run = async () => {
            if (demoMode) {
              const taDemo = dbm.activeTahun();
              req.TA = taDemo || null;
              req.taId = taDemo ? taDemo.id : null;
            } else {
              await resolveTa(req);
            }
            await runRoute(pathname);
          };
          if (demoMode) {
            dbm.ensureDemoDb();
            await dbm.runAsDemo(run);
          } else await run();
        } catch (err) { handleError(err, pathname); }
      });
    });
  } catch (err) {
    handleError(err, pathname0);
  }
});

/* ---------------- startup: control plane, queue, penjadwalan backup ---------------- */
try {
  queue.init(saas.db);
  queue.start(30000);
  require('./backup_tg').registerJobs(dbm, saas, queue);
} catch (e) { console.error('[queue-init]', e.message); }

/* pengingat tagihan WhatsApp: worker antrean (jeda acak 2–5 detik) + penjadwalan otomatis */
try {
  require('./reminder').startWorker(dbm, saas);
  require('./reminder').startScheduler(dbm, saas);
} catch (e) { console.error('[wa-reminder-start]', e.message); }

try {
  const admin = saas.ensureBootstrap();
  if (admin && admin.created) {
    console.log('[saas] akun Super Admin Pusat dibuat: ' + admin.email + ' (sandi awal dari SAAS_ADMIN_PASSWORD / default)');
  }
} catch (e) { console.error('[saas]', e.message); }

server.listen(PORT, () => {
  // zona waktu proses (WIB) — dipakai Date, SQLite localtime, worker WA & penjadwalan
  console.log(require('./tz').startupLine());
  if (require('./tz').warning) console.warn('[tz] ' + require('./tz').warning);
  console.log('SIMKEU Sekolah listening on ' + PORT + (process.env.APP_BASE_URL ? ' · base ' + process.env.APP_BASE_URL : ''));
});

/* kotak sampah: buang data kedaluwarsa (>30 hari) untuk SEMUA sekolah */
function purgeAllTrash() {
  for (const t of saas.allTenants()) {
    try { dbm.runAsTenant(t, () => dbm.trashPurge()); } catch (e) { }
  }
}
try { purgeAllTrash(); } catch (e) { console.error('[trash]', e.message); }
setInterval(() => { try { purgeAllTrash(); } catch (e) { } }, 6 * 60 * 60 * 1000).unref();

/* cron harian SaaS: tagihan H-7 + penangguhan otomatis sekolah yang kedaluwarsa.
   Penanda tanggal disimpan di saas_settings supaya tidak berjalan dua kali sehari. */
function runBillingTick() {
  const today = saas.todayISO();
  if (String(saas.get('last_daily', '')) === today) return;
  try {
    // pekerjaan berat (tagihan + pengingat WA) diantrekan, bukan dijalankan inline
    queue.push('billing.daily', { tanggal: today });
    saas.set('last_daily', today);
  } catch (e) { console.error('[saas-billing]', e.message); }
}
setTimeout(runBillingTick, 15000).unref();
setInterval(runBillingTick, 30 * 60 * 1000).unref();

/* auto-backup Telegram: penjadwalan 2x sehari (06:00 & 15:00) melalui queue worker
   supaya banyak sekolah tidak membebani satu request (lihat queue.js + backup_tg.js). */
try { require('./backup_tg').startScheduler(dbm, saas); } catch (e) { console.error('[backup-tg]', e.message); }
