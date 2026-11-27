'use strict';
/**
 * ==================================================================
 * PORTAL SUPER ADMIN PUSAT  →  /super-admin
 * ------------------------------------------------------------------
 * Route terpisah dari portal sekolah. Semua halaman dilindungi sesi
 * control-plane (cookie simkeu_saas) dengan peran super_admin.
 *
 *   /super-admin                 dashboard SaaS
 *   /super-admin/sekolah         daftar + tambah sekolah
 *   /super-admin/sekolah/:id     detail: paket, masa aktif, lifetime, fitur
 *   /super-admin/pembayaran      persetujuan pembayaran (QRIS manual)
 *   /super-admin/qris            pengaturan QRIS / DANA Bisnis
 *   /super-admin/backup          auto-backup database via email (SMTP)
 * ==================================================================
 */
const fs = require('fs');
const path = require('path');
const bd = require('../backupdata');
const bt = require('../backup_tg');
const tg = require('../telegram');
const X = require('../xlsx-read');
const srcpack = require('../sourcepack');
const envCfg = require('../env');
const QRCode = require('qrcode');
const publicUrl = require('../publicurl');

const COOKIE = 'simkeu_saas';
const MFA_COOKIE = 'simkeu_mfa';

module.exports = ({ get, post, dbm, lib, ui, saas, queue, uploadMedia, refreshPortalMap }) => {
  const { esc, rupiah, tglID, nowStamp } = lib;
  /** label paket dari master paket (dinamis) */
  function pkgLabel(kode) {
    const p = saas.packageByKode(kode);
    return p ? p.nama : (saas.PAKET[kode] || kode || '-');
  }
  function tenantPortalSlugs(t) {
    return dbm.runAsTenant(t, () => dbm.portalSlugs());
  }
  function tenantPortalUrl(t, req, kind, slugs) {
    return dbm.runAsTenant(t, () => publicUrl.absolute(dbm, {
      tenant: t, BASE: req.BASE, headers: req.headers
    }, '/' + (slugs || dbm.portalSlugs())[kind]));
  }
  const S = saas.db;

  /* ---------------- sesi super admin ---------------- */
  function parseCookie(req, name) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out[name] || '';
  }
  function me(req) {
    const user = req.saasUser || null;
    return user && Number(user.aktif) ? user : null;
  }
  function mfaSetup(req) {
    const token = parseCookie(req, MFA_COOKIE);
    const session = req.mfaSession;
    if (!session || session.kind !== 'saas_mfa_setup') return null;
    const user = req.mfaUser;
    return user && user.aktif ? { token, session, user } : null;
  }
  function secureCookie(req) {
    return String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : ''))
      .split(',')[0].trim().toLowerCase() === 'https' ? '; Secure' : '';
  }
  function requireAdmin(req, res) {
    const u = me(req);
    if (!u) {
      res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Silakan masuk sebagai Super Admin Pusat.'));
      return null;
    }
    if (req.saasMfaEnabled === false) {
      saas.destroySession(parseCookie(req, COOKIE));
      res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`);
      res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Aktifkan MFA sebelum melanjutkan.'));
      return null;
    }
    return u;
  }
  function flash(path, key, msg) {
    const sep = path.includes('?') ? '&' : '?';
    return path + sep + key + '=' + encodeURIComponent(msg);
  }

  /* ---------------- layout ---------------- */
  const MENU = [
    { href: '/super-admin', label: 'Dashboard', icon: 'dashboard' },
    { href: '/super-admin/keamanan', label: 'Keamanan Akun', icon: 'shield' },
    { href: '/super-admin/health', label: 'Kesehatan Sistem', icon: 'dashboard' },
    { href: '/super-admin/sekolah', label: 'Daftar Sekolah', icon: 'school' },
    { href: '/super-admin/portal-publik', label: 'Manajemen Custom Slug & Portal Publik', icon: 'link' },
    { href: '/super-admin/pembayaran', label: 'Pembayaran', icon: 'card' },
    { href: '/super-admin/paket', label: 'Paket Langganan', icon: 'layers' },
    { href: '/super-admin/menu-default', label: 'Default Tampilan Menu', icon: 'menu' },
    { href: '/super-admin/branding', label: 'Branding Sistem', icon: 'school' },
    { href: '/super-admin/qris', label: 'QRIS & Harga', icon: 'tag' },
    { href: '/super-admin/legal', label: 'Legalitas & SLA', icon: 'file' },
    { href: '/super-admin/tiket', label: 'Pusat Tiket', icon: 'inbox' },
    { href: '/super-admin/pengumuman', label: 'Pengumuman & Maintenance', icon: 'bell' },
    { href: '/super-admin/petunjuk', label: 'Master Petunjuk', icon: 'book' },
    { href: '/super-admin/audit', label: 'Audit Logs', icon: 'shield' },
    { href: '/super-admin/wa', label: 'WA Gateway', icon: 'send' },
    { href: '/super-admin/backup', label: 'Backup & Restore Database System', icon: 'database' },
    { href: '/super-admin/database', label: 'Database Manager', icon: 'database' }
  ];
  const subOf = pathname => (MENU.find(m => pathname === m.href || pathname.startsWith(m.href + '/')) || {}).href || '';

  function shell(req, { title, sub = '', active = '', content, user }) {
    const base = req.BASE;
    const q = req.query;
    const ok = q.get('ok'), err = q.get('err');
    const stats = saas.stats();
    const nav = MENU.map(m => `<a href="${base}${m.href}" class="sa-nav${active === m.href ? ' on' : ''}">${ui.icon(m.icon)}<span>${esc(m.label)}</span>
      ${m.href === '/super-admin/pembayaran' && stats.menunggu ? `<b class="sa-pill">${stats.menunggu}</b>` : ''}</a>`).join('');
    return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Super Admin</title>
${ui.fontLinks()}
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}">
<link rel="icon" href="${base}/favicon.ico">
<style>
.sa-wrap{display:grid;grid-template-columns:248px 1fr;min-height:100vh;gap:0}
.sa-side{background:#141127;color:#EDE9FE;padding:22px 16px;display:flex;flex-direction:column;gap:18px}
.sa-brand{display:flex;align-items:center;gap:11px;font-weight:800;letter-spacing:-.02em;font-size:15px}
.sa-mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#6366F1,#8B5CF6);display:grid;place-items:center;color:#fff}
.sa-nav{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:11px;color:#C7C2E8;font-weight:600;font-size:13.5px;text-decoration:none}
.sa-nav:hover{background:rgba(255,255,255,.07);color:#fff}
.sa-nav.on{background:linear-gradient(135deg,#6366F1,#8B5CF6);color:#fff}
.sa-nav svg{width:17px;height:17px;flex:0 0 17px}
.sa-nav span{line-height:1.28;font-size:13px;letter-spacing:-.01em}
.sa-pill{margin-left:auto;background:#F97316;color:#fff;border-radius:999px;padding:1px 7px;font-size:11px}
.sa-main{padding:26px 30px 48px;min-width:0}
.sa-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.sa-top h1{font-size:23px;margin:0;letter-spacing:-.03em}
.sa-top .sub{color:#8A8598;font-size:13px;margin-top:4px}
.sa-user{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.7);border:1px solid var(--line);padding:7px 12px;border-radius:12px;font-size:12.5px}
.sa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
.sa-kpi{padding:18px;border-radius:16px;background:#fff;border:1px solid var(--line)}
.sa-kpi .v{font-size:23px;font-weight:800;letter-spacing:-.03em}
.sa-kpi .l{font-size:11.5px;text-transform:uppercase;letter-spacing:.1em;color:#8A8598;font-weight:700}
@media (max-width:900px){ .sa-wrap{grid-template-columns:1fr} .sa-side{flex-direction:row;flex-wrap:wrap;padding:14px} .sa-nav span{display:none} .sa-main{padding:18px 16px 40px} }
.lb{position:fixed;inset:0;background:rgba(17,12,32,.86);display:none;place-items:center;z-index:99;padding:24px}
.lb.on{display:grid}
.lb img{max-width:min(92vw,720px);max-height:86vh;border-radius:12px;background:#fff}
.lb-x{position:absolute;top:18px;right:22px;color:#fff;font-size:26px;cursor:pointer;line-height:1}
</style></head><body>
<div class="sa-wrap">
  <aside class="sa-side">
    <div class="sa-brand"><div class="sa-mark">${ui.icon('shield')}</div><div>Super Admin<br><span style="font-weight:600;font-size:11px;opacity:.7">${esc(saas.appName())}</span></div></div>
    ${nav}
    <div style="margin-top:auto;font-size:11.5px;opacity:.6;line-height:1.6">
      ${stats.total} sekolah terdaftar<br>${stats.aktif} aktif · ${stats.suspended} ditangguhkan
    </div>
  </aside>
  <main class="sa-main">
    <div class="sa-top">
      <div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
      <div class="flex" style="gap:10px;align-items:center;flex-wrap:wrap">
        <div class="sa-user">${ui.icon('users')}<div><b>${esc((user || {}).nama || '')}</b><div class="t-sub">Super Admin Pusat</div></div></div>
        <form method="post" action="${base}/super-admin/logout"><button class="btn btn-sm">Keluar</button></form>
      </div>
    </div>
    ${ok ? `<div class="alert ok">${ui.icon('check')}<div>${esc(ok)}</div></div>` : ''}
    ${err ? `<div class="alert err">${ui.icon('alert')}<div>${esc(err)}</div></div>` : ''}
    ${content}
  </main>
</div>
<script src="${base}/assets/app.js?v=${ui.ASSET_V}" defer></script>
<script>
document.querySelectorAll('[data-proof]').forEach(function(el){
  el.addEventListener('click', function(e){
    e.preventDefault();
    var lb = document.getElementById('lb');
    lb.querySelector('img').src = el.getAttribute('data-proof');
    lb.classList.add('on');
  });
});
document.addEventListener('click', function(e){ if(e.target.id==='lb'||e.target.classList.contains('lb-x')) document.getElementById('lb').classList.remove('on'); });
</script>
<div class="lb" id="lb"><span class="lb-x">&times;</span><img alt="Bukti pembayaran"></div>
</body></html>`;
  }

  /* ---------------- login ---------------- */
  function loginPage(req, res, { err } = {}) {
    const base = req.BASE;
    const appName = saas.appName();
    res.html(`<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Masuk Super Admin · ${esc(appName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}"><link rel="icon" href="${base}/favicon.ico">
</head><body style="display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<div class="card" style="width:100%;max-width:420px;padding:30px">
  <div class="flex" style="gap:12px;align-items:center;margin-bottom:18px">
    <div style="width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#6366F1,#8B5CF6);display:grid;place-items:center;color:#fff">${ui.icon('shield')}</div>
    <div><div style="font-weight:800;letter-spacing:-.02em">Super Admin Pusat</div><div class="small muted">${esc(appName)}</div></div>
  </div>
  ${err ? `<div class="alert err">${ui.icon('alert')}<div>${esc(err)}</div></div>` : ''}
  <form method="post" action="${base}/super-admin/login">
    <div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username" placeholder="super@simkeu.id"></div>
    <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password" placeholder="••••••••"></div>
    <div class="field"><label>Kode authenticator / pemulihan (jika MFA sudah aktif)</label><input type="text" name="mfa_code" inputmode="numeric" autocomplete="one-time-code" placeholder="Kosongkan saat penyiapan pertama"></div>
    <button class="btn btn-primary btn-block">Masuk</button>
  </form>
  <p class="small muted" style="margin-top:16px;text-align:center"><a href="${base}/login">← Portal sekolah</a></p>
</div></body></html>`);
  }

  get('/super-admin/login', (req, res) => {
    if (me(req)) return res.redirect(req.BASE + '/super-admin');
    loginPage(req, res, { err: req.query.get('err') });
  });

  post('/super-admin/login', async (req, res) => {
    const email = String(req.body.email || '').trim();
    const pass = String(req.body.password || '');
    const identity = 'superadmin:' + email.toLowerCase();
    try {
      if (await saas.authIsLimited(identity)) {
        return loginPage(req, res, { err: 'Terlalu banyak percobaan masuk. Silakan coba kembali dalam 15 menit.' });
      }
      const u = await saas.findAdmin(email);
      if (!u || !lib.verifyPassword(pass, u.password)) {
        await saas.authRecord(identity, false);
        return res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Email atau password salah.'));
      }
      if (!Number(u.aktif)) {
        await saas.authRecord(identity, false);
        return res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Akun super admin dinonaktifkan.'));
      }
      if (await saas.mfaEnabled(u.id)) {
        if (!await saas.mfaVerify(u.id, req.body.mfa_code)) {
          await saas.authRecord(identity, false);
          return loginPage(req, res, { err: 'Kode authenticator atau pemulihan tidak valid.' });
        }
        await saas.authRecord(identity, true);
      } else {
        await saas.authRecord(identity, true);
        await saas.mfaStart(u.id);
        const setupToken = await saas.createSession({ userId: u.id, kind: 'saas_mfa_setup', expiresMinutes: 10 });
        res.set('Set-Cookie', `${MFA_COOKIE}=${setupToken}; Path=/super-admin; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie(req)}`);
        return res.redirect(req.BASE + '/super-admin/mfa-setup');
      }
      const token = await saas.createSession({ userId: u.id, kind: 'saas' });
      if (dbm.DB_DRIVER === 'mysql') await saas.markAdminLogin(u.id);
      else S.prepare('UPDATE saas_users SET last_login=? WHERE id=?').run(nowStamp(), u.id);
      await saas.logSaas(u, 'LOGIN', 'auth', 'Super Admin Pusat masuk');
      res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secureCookie(req)}`);
      return res.redirect(req.BASE + '/super-admin');
    } catch (error) {
      console.error('[super-admin-login]', error.message);
      return loginPage(req, res, { err: 'Login Super Admin gagal karena layanan database bermasalah. Silakan coba lagi.' });
    }
  });

  post('/super-admin/logout', async (req, res) => {
    await saas.destroySession(parseCookie(req, COOKIE));
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`);
    res.redirect(req.BASE + '/super-admin/login?ok=' + encodeURIComponent('Anda telah keluar.'));
  });

  get('/super-admin/mfa-setup', async (req, res) => {
    const state = mfaSetup(req);
    if (!state) return res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Sesi penyiapan keamanan berakhir. Silakan masuk kembali.'));
    const secret = await saas.mfaPendingSecret(state.user.id);
    if (!secret) return res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Penyiapan MFA perlu diulang.'));
    const issuer = saas.appName();
    const uri = `otpauth://totp/${encodeURIComponent(issuer + ':' + state.user.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toDataURL(uri, { width: 220, margin: 1 });
    const err = req.query.get('err');
    res.html(`<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Aktifkan MFA · ${esc(issuer)}</title><link rel="stylesheet" href="${req.BASE}/assets/app.css?v=${ui.ASSET_V}"></head>
      <body style="display:grid;place-items:center;min-height:100vh;padding:20px"><main class="card" style="max-width:520px;width:100%;padding:28px">
      <h2>Aktifkan verifikasi dua langkah</h2><p class="muted">Akun Super Admin wajib memakai aplikasi authenticator seperti Google Authenticator, Microsoft Authenticator, atau 1Password.</p>
      ${err ? `<div class="alert err">${esc(err)}</div>` : ''}
      <ol><li>Tambahkan akun dengan memindai QR ini.</li><li>Masukkan kode 6 digit yang sedang tampil untuk mengaktifkan MFA.</li><li>Simpan kode pemulihan yang muncul setelah aktivasi.</li></ol>
      <div style="text-align:center"><img src="${qr}" alt="QR authenticator" width="220" height="220"></div>
      <p class="small">Jika tidak dapat memindai QR, masukkan secret ini secara manual:</p><p class="mono" style="word-break:break-all">${esc(secret)}</p>
      <form method="post" action="${req.BASE}/super-admin/mfa-setup"><div class="field"><label>Kode authenticator</label>
      <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></div>
      <button class="btn btn-primary btn-block">Aktifkan MFA</button></form></main></body></html>`);
  });

  post('/super-admin/mfa-setup', async (req, res) => {
    const state = mfaSetup(req);
    if (!state) return res.redirect(req.BASE + '/super-admin/login?err=' + encodeURIComponent('Sesi penyiapan keamanan berakhir.'));
    const identity = 'superadmin:' + String(state.user.email || '').trim().toLowerCase();
    if (await saas.authIsLimited(identity)) {
      return res.redirect(req.BASE + '/super-admin/mfa-setup?err=' + encodeURIComponent('Terlalu banyak kode yang salah. Silakan coba kembali setelah 15 menit.'));
    }
    try {
      const codes = await saas.mfaEnable(state.user.id, req.body.code);
      await saas.authRecord(identity, true);
      await saas.destroySession(state.token);
      const token = await saas.createSession({ userId: state.user.id, kind: 'saas' });
      if (dbm.DB_DRIVER === 'mysql') await saas.markAdminLogin(state.user.id);
      else S.prepare('UPDATE saas_users SET last_login=? WHERE id=?').run(nowStamp(), state.user.id);
      await saas.logSaas(state.user, 'AKTIFKAN MFA', 'auth', 'Super Admin Pusat mengaktifkan verifikasi dua langkah');
      res.set('Set-Cookie', [
        `${MFA_COOKIE}=; Path=/super-admin; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`,
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secureCookie(req)}`
      ]);
      res.html(`<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Kode Pemulihan · ${esc(saas.appName())}</title><link rel="stylesheet" href="${req.BASE}/assets/app.css?v=${ui.ASSET_V}"></head>
        <body style="display:grid;place-items:center;min-height:100vh;padding:20px"><main class="card" style="max-width:520px;width:100%;padding:28px">
        <div class="alert ok"><b>MFA berhasil diaktifkan.</b></div><h2>Simpan kode pemulihan</h2>
        <p class="muted">Setiap kode hanya dapat digunakan sekali. Kode ini tidak akan ditampilkan lagi; simpan di tempat aman dan jangan bagikan.</p>
        <div class="mono" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${codes.map(x => `<code style="padding:8px;background:#f6f3ef;border-radius:6px">${esc(x)}</code>`).join('')}</div>
        <p style="margin-top:20px"><a class="btn btn-primary btn-block" href="${req.BASE}/super-admin">Saya sudah menyimpan kode</a></p></main></body></html>`);
    } catch (e) {
      await saas.authRecord(identity, false);
      res.redirect(req.BASE + '/super-admin/mfa-setup?err=' + encodeURIComponent(e.message));
    }
  });

  get('/super-admin/keamanan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const count = saas.mfaRecoveryCount(u.id);
    const content = `<div class="card"><div class="card-head"><div><h3>Verifikasi Dua Langkah</h3><div class="sub">MFA wajib untuk akun Super Admin Pusat</div></div>${ui.badge('Aktif', 'green')}</div>
      <p>Akun ini dilindungi password dan aplikasi authenticator. Kode pemulihan tersisa: <b>${count}</b>.</p>
      <div class="alert warn">${ui.icon('alert')}<div>Simpan kode pemulihan di tempat aman. Jika authenticator dan seluruh kode pemulihan hilang, akses akun memerlukan pemulihan oleh operator server.</div></div>
      <p class="small muted">Untuk mengganti perangkat authenticator, gunakan salah satu kode pemulihan saat masuk, lalu hubungi operator untuk mengatur ulang MFA.</p></div>`;
    res.html(shell(req, { title: 'Keamanan Akun', sub: 'Perlindungan akun Super Admin Pusat', active: '/super-admin/keamanan', content, user: u }));
  });

  get('/super-admin/health', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    let controlOk = false;
    try { controlOk = S.pragma('quick_check').every(r => r.quick_check === 'ok'); } catch (e) { }
    const tenants = saas.allTenants();
    const tenantResults = tenants.map(t => {
      try {
        dbm.openTenantConn(t.id, t.db_file).prepare('SELECT 1').get();
        return { name: t.nama, code: t.school_code, ok: true, error: '' };
      } catch (e) { return { name: t.nama, code: t.school_code, ok: false, error: e.message }; }
    });
    const queueStats = queue ? queue.stats() : { pending: 0, running: 0, done: 0, failed: 0 };
    const backups = saas.backupLogRows('saas', 10);
    const latestSuccess = backups.find(x => x.status === 'sukses');
    const latestFailure = backups.find(x => x.status !== 'sukses');
    const tenantRows = tenantResults.map(t => `<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.code)}</td>
      <td>${t.ok ? ui.badge('Terhubung', 'green') : ui.badge('Gagal', 'red')}</td><td class="small">${esc(t.error)}</td></tr>`).join('');
    const jobRows = queue ? queue.recent(10).map(j => `<tr><td>${j.id}</td><td>${esc(j.jenis)}</td>
      <td>${ui.badge(j.status, j.status === 'done' ? 'green' : j.status === 'failed' ? 'red' : 'amber')}</td>
      <td class="small">${esc(j.last_error || j.created_at || '')}</td></tr>`).join('') : '';
    const content = `<div class="grid-4 mb-3">
      <div class="card"><div class="mt">Control Plane</div><div class="nm">${controlOk ? ui.badge('Sehat', 'green') : ui.badge('Periksa', 'red')}</div></div>
      <div class="card"><div class="mt">Database Sekolah</div><div class="nm">${tenantResults.filter(t => t.ok).length} / ${tenants.length} terhubung</div></div>
      <div class="card"><div class="mt">Antrean</div><div class="nm">${queueStats.pending} tertunda · ${queueStats.failed} gagal</div></div>
      <div class="card"><div class="mt">Backup SaaS Terakhir</div><div class="nm">${latestSuccess ? esc(lib.stampID(latestSuccess.created_at)) : 'Belum ada'}</div></div>
    </div>
    ${latestFailure ? `<div class="alert warn">${ui.icon('alert')}<div>Backup terakhir gagal (${esc(lib.stampID(latestFailure.created_at))}): ${esc(latestFailure.pesan || 'tanpa rincian')}</div></div>` : ''}
    <div class="card mb-3"><div class="card-head"><div><h3>Koneksi Database Sekolah</h3><div class="sub">Pemeriksaan koneksi ringan, tanpa membaca data keuangan</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Sekolah</th><th>Kode</th><th>Status</th><th>Catatan</th></tr></thead>
      <tbody>${tenantRows || '<tr><td colspan="4" class="muted center">Belum ada sekolah.</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-head"><div><h3>Antrean Pekerjaan Terbaru</h3><div class="sub">${queueStats.running} berjalan · ${queueStats.done} selesai</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>Jenis</th><th>Status</th><th>Pesan / Waktu</th></tr></thead>
      <tbody>${jobRows || '<tr><td colspan="4" class="muted center">Belum ada pekerjaan.</td></tr>'}</tbody></table></div></div>`;
    res.html(shell(req, { title: 'Kesehatan Sistem', sub: 'Database, antrean pekerjaan, dan status backup', active: '/super-admin/health', content, user: u }));
  });

  /** keluar dari mode "login as tenant" (kembali ke portal super admin) */
  get('/super-admin/kembali', (req, res) => {
    const sid = parseCookie(req, 'simkeu_sid');
    if (sid) saas.destroySession(sid);
    res.set('Set-Cookie', `simkeu_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`);
    res.redirect(req.BASE + '/super-admin');
  });

  /* ---------------- ganti password super admin ---------------- */
  post('/super-admin/password', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const lama = String(req.body.password_lama || '');
    const baru = String(req.body.password_baru || '');
    const ulang = String(req.body.password_ulang || '');
    const back = m => res.redirect(req.BASE + flash('/super-admin', 'err', m));
    if (!lib.verifyPassword(lama, u.password)) return back('Password lama tidak sesuai.');
    if (baru.length < 8) return back('Password baru minimal 8 karakter.');
    if (baru !== ulang) return back('Konfirmasi password baru tidak sama.');
    saas.setAdminPassword(u.id, baru);
    saas.logSaas(u, 'GANTI PASSWORD', 'auth', 'Super Admin Pusat mengganti password');
    res.redirect(req.BASE + flash('/super-admin', 'ok', 'Password Super Admin berhasil diganti.'));
  });

  /* ---------------- dashboard ---------------- */
  get('/super-admin', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const st = saas.stats();
    const list = saas.allTenants();
    const rows = list.slice(0, 8).map(t => {
      const s = saas.statusOf(t);
      return `<tr>
        <td><a href="${req.BASE}/super-admin/sekolah/${t.id}"><b>${esc(t.nama)}</b></a><div class="t-sub">${esc(t.contact_email || '')}</div></td>
        <td><span class="mono" style="letter-spacing:.12em;font-weight:700">${esc(t.school_code)}</span></td>
        <td>${esc(pkgLabel(t.paket))}</td>
        <td class="nowrap">${Number(t.is_lifetime_free) ? 'Lifetime' : esc(tglID(t.expires_at || '-'))}</td>
        <td>${ui.badge(s.label, s.color)}</td>
      </tr>`;
    }).join('');
    const menunggu = saas.paymentsAll('pending');
    const tiketOpen = saas.ticketsAll({ status: 'open' });
    const maintState = saas.maintenance();
    const content = `
    ${maintState.aktif ? `<div class="card mb-3" style="border-color:#F6CFD0;background:#FFF8F8">
      <div class="card-head"><div><h3>Mode Perbaikan Sedang AKTIF</h3>
        <div class="sub">Seluruh akses sekolah diblokir sementara</div></div>
        <a class="btn btn-sm btn-primary" href="${req.BASE}/super-admin/pengumuman">Kelola</a></div>
    </div>` : ''}
    ${tiketOpen.length ? `<div class="card mb-3" style="border-color:#F7DFB5;background:#FFFDF7">
      <div class="card-head"><div><h3>${ui.icon('inbox', 'i-sm')} ${tiketOpen.length} tiket kendala baru</h3>
        <div class="sub">Belum ditindaklanjuti oleh Super Admin</div></div>
        <a class="btn btn-sm btn-primary" href="${req.BASE}/super-admin/tiket">Buka Pusat Tiket</a></div>
    </div>` : ''}
    <div class="sa-grid mb-3">
      ${[['Total Sekolah', st.total], ['Sekolah Aktif', st.aktif], ['Lifetime', st.lifetime], ['Ditangguhkan', st.suspended],
        ['Menunggu Verifikasi', st.menunggu], ['Pendapatan Bulan Ini', rupiah(st.pendapatan)]]
        .map(([l, v]) => `<div class="sa-kpi"><div class="l">${esc(l)}</div><div class="v">${typeof v === 'number' ? v : esc(v)}</div></div>`).join('')}
    </div>
    ${menunggu.length ? `<div class="card mb-3" style="border-color:#F7DFB5;background:#FFFDF7">
      <div class="card-head"><div><h3>${ui.icon('clock', 'i-sm')} ${menunggu.length} pengajuan pembayaran menunggu</h3>
        <div class="sub">Verifikasi bukti transfer lalu setujui untuk memperpanjang masa aktif</div></div>
        <a class="btn btn-sm btn-primary" href="${req.BASE}/super-admin/pembayaran">Buka Persetujuan</a></div>
    </div>` : ''}
    <div class="card mb-3">
      <div class="card-head"><div><h3>Keamanan Akun Super Admin</h3>
        <div class="sub">Ganti sandi bawaan segera setelah pemasangan</div></div></div>
      <form method="post" action="${req.BASE}/super-admin/password">
        <div class="row3">
          <div class="field"><label>Password Lama</label><input type="password" name="password_lama" required autocomplete="current-password"></div>
          <div class="field"><label>Password Baru (min. 8 karakter)</label><input type="password" name="password_baru" required minlength="8" autocomplete="new-password"></div>
          <div class="field"><label>Ulangi Password Baru</label><input type="password" name="password_ulang" required minlength="8" autocomplete="new-password"></div>
        </div>
        <div class="form-actions"><button class="btn">${ui.icon('lock')}Ganti Password</button></div>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Sekolah Terdaftar</h3><div class="sub">8 sekolah terbaru · kelola di menu Daftar Sekolah</div></div>
        <a class="btn btn-sm btn-primary" href="${req.BASE}/super-admin/sekolah">${ui.icon('plus')}Tambah Sekolah</a></div>
      <div class="table-wrap"><table><thead><tr><th>Nama Sekolah</th><th>Kode</th><th>Paket</th><th>Masa Aktif</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">Belum ada sekolah.</td></tr>`}</tbody></table></div>
    </div>`;
    res.html(shell(req, { title: 'Dashboard SaaS', sub: 'Ringkasan seluruh sekolah yang memakai layanan', active: '/super-admin', content, user: u }));
  });

  /* ---------------- daftar sekolah ---------------- */
  get('/super-admin/sekolah', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const list = saas.allTenants();
    const domBadge = t => {
      const st = String(t.custom_domain_status || '').toUpperCase();
      if (!t.custom_domain) return ui.badge('Belum Ada', 'gray');
      if (st === 'VERIFIED') return ui.badge('Terverifikasi', 'green');
      if (st === 'FAILED') return ui.badge('Gagal', 'red');
      return ui.badge('Menunggu Verifikasi', 'amber');
    };
    const rows = list.map(t => {
      const s = saas.statusOf(t);
      const on = saas.enabledKeys(t).length;
      const slug = String(t.portal_slug || '');
      const portalSlugs = slug ? tenantPortalSlugs(t) : null;
      const adm = (() => { try { return adminOf(t); } catch (e) { return null; } })();
      return `<tr>
        <td><a href="${req.BASE}/super-admin/sekolah/${t.id}"><b>${esc(t.nama)}</b></a>
          <div class="t-sub">${esc(t.contact_email || '')}${t.contact_telp ? ' · ' + esc(t.contact_telp) : ''}</div></td>
        <td class="mono">#${t.id}</td>
        <td class="mono" style="font-weight:700;letter-spacing:.12em">${esc(t.school_code)}</td>
        <td><span class="badge ${t.paket === 'pro' ? 'violet' : 'blue'} plain">${esc(pkgLabel(t.paket))}</span></td>
        <td class="nowrap">${Number(t.is_lifetime_free) ? '<b>Lifetime</b>' : esc(tglID(t.expires_at || '-'))}</td>
        <td>${ui.badge(s.label, s.color)}</td>
        <td class="num">${on}/${saas.FEATURES.length}</td>
        <td class="small">${slug && portalSlugs
        ? `<a href="${esc(tenantPortalUrl(t, req, 'siswa', portalSlugs))}" target="_blank" rel="noopener" class="mono">/${esc(portalSlugs.siswa)}</a>`
        : '<span class="muted">-</span>'}</td>
        <td class="small">${t.custom_domain ? `<span class="mono">${esc(t.custom_domain)}</span><div>${domBadge(t)}</div>` : domBadge(t)}</td>
        <td class="nowrap">
          <button class="btn btn-sm" data-open="mReset${t.id}" title="Reset password admin sekolah">${ui.icon('lock')}Reset</button>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/masuk" style="display:inline">
            <button class="btn btn-sm" title="Masuk sebagai sekolah ini">${ui.icon('login')}Masuk</button></form>
        </td>
      </tr>`;
    }).join('');

    // modal reset password per sekolah (di luar tabel agar form tidak rusak)
    const resetModals = list.map(t => {
      const adm = (() => { try { return adminOf(t); } catch (e) { return null; } })();
      return ui.modal('mReset' + t.id, {
        title: 'Reset Password Admin Sekolah',
        body: `<form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/reset-password" data-reset-form>
          <div class="alert info" style="margin-top:0">${ui.icon('info')}<div>
            <b>${esc(t.nama)}</b> · Kode Sekolah <b class="mono">${esc(t.school_code)}</b><br>
            Username admin: <b class="mono">${esc(adm ? (adm.username || adm.email) : '(belum ada akun admin)')}</b></div></div>
          <div class="field"><label>Kata Sandi Baru</label>
            <div class="flex" style="gap:8px">
              <input type="text" name="password_baru" class="js-newpw" required minlength="6" placeholder="minimal 6 karakter" style="flex:1">
              <button type="button" class="btn" data-generate-pw>${ui.icon('refresh')}Generate Acak</button>
            </div>
            <div class="hint">Sandi disimpan dalam bentuk hash aman (scrypt + salt acak).</div></div>
          <div class="form-actions">
            <button class="btn btn-primary">${ui.icon('save')}Simpan &amp; Terapkan</button>
            <button type="button" class="btn" data-close="mReset${t.id}">Batal</button>
          </div>
        </form>`,
        wide: false
      });
    }).join('');
    const formFields = `
        <div class="row3">
          <div class="field"><label>Nama Sekolah *</label><input type="text" name="nama" required placeholder="SMK Negeri 1 Contoh"></div>
          <div class="field"><label>Kode Sekolah (4 karakter)</label><input type="text" name="school_code" maxlength="4" placeholder="otomatis (SK02)" style="text-transform:uppercase"></div>
          <div class="field"><label>Paket</label><select name="paket">
            ${saas.packageRows().map(p => `<option value="${esc(p.kode)}" ${p.kode === saas.defaultPackage().kode ? 'selected' : ''}>${esc(p.nama)}</option>`).join('')}
          </select></div>
        </div>
        <div class="row3">
          <div class="field"><label>Nama Admin Sekolah *</label><input type="text" name="admin_nama" required placeholder="Bendahara / Admin"></div>
          <div class="field"><label>Email Admin (login) *</label><input type="email" name="admin_email" required placeholder="admin@sekolah.sch.id"></div>
          <div class="field"><label>Password Admin *</label><input type="text" name="admin_password" required minlength="6" placeholder="minimal 6 karakter"></div>
        </div>
        <div class="row3">
          <div class="field"><label>Telepon / WhatsApp</label><input type="text" name="telp" placeholder="08xx"></div>
          <div class="field"><label>Masa Aktif (hari)</label><input type="number" name="days" value="${saas.trialDays() || 30}" min="1" max="3650"></div>
          <div class="field"><label>Opsi</label>
            <label class="check" style="margin-top:6px"><input type="checkbox" name="is_lifetime_free" value="1"> Akses Lifetime (gratis)</label></div>
        </div>
        <div class="field"><label>Alamat</label><input type="text" name="alamat" placeholder="Jl. Pendidikan No. 1"></div>`;
    const addModal = ui.modal('mTambahSekolah', {
      title: 'Tambah Sekolah Manual',
      body: `<form method="post" action="${req.BASE}/super-admin/sekolah/tambah" id="fSekolahBaru">${formFields}
        <div class="form-actions"><button class="btn btn-primary">${ui.icon('plus')}Simpan Sekolah</button></div></form>`,
      wide: true
    });
    const content = `
    <div class="card">
      <div class="card-head"><div><h3>Daftar Sekolah (${list.length})</h3><div class="sub">Nama, tenant_id, kode, paket, masa aktif & status</div></div>
        ${ui.openModalBtn('mTambahSekolah', 'Tambah Sekolah')}</div>
      <div class="table-wrap"><table><thead><tr><th>Sekolah</th><th>tenant_id</th><th>Kode</th><th>Paket</th><th>Masa Aktif</th><th>Status</th><th class="num">Fitur</th><th>URL Portal</th><th>Custom Domain</th><th>Aksi</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="10" class="muted" style="text-align:center;padding:18px">Belum ada sekolah.</td></tr>`}</tbody></table></div>
      ${addModal}
      ${resetModals}
      <p class="help mt-1">Data setiap sekolah tersimpan di database terpisah (<code>data/tenants/tenant-&lt;id&gt;.sqlite</code>), sehingga tidak mungkin saling terlihat.</p>
    </div>`;
    res.html(shell(req, { title: 'Daftar Sekolah', sub: 'Tenant, kode akses, paket & status langganan', active: '/super-admin/sekolah', content, user: u }));
  });

  post('/super-admin/sekolah/tambah', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const t = saas.createTenant({
        nama: req.body.nama, school_code: req.body.school_code,
        paket: req.body.paket, admin_nama: req.body.admin_nama,
        admin_email: req.body.admin_email, admin_password: req.body.admin_password,
        contact_nama: req.body.admin_nama, contact_telp: req.body.telp, alamat: req.body.alamat,
        days: Number(req.body.days) || 30, is_lifetime_free: req.body.is_lifetime_free ? 1 : 0,
        trial: false, user: u
      });
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok',
        `Sekolah dibuat. Kode Sekolah: ${t.school_code} — berikan kode ini ke admin sekolah untuk login.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', e.message));
    }
  });

  /* ---------------- detail sekolah ---------------- */
  get('/super-admin/sekolah/:id', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const t = saas.tenantById(req.params.id);
    if (!t) return res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', 'Sekolah tidak ditemukan.'));
    const st = saas.statusOf(t);
    const cred = saas.credNoticeTake(parseCookie(req, COOKIE));
    const adminAkun = (() => { try { return adminOf(t); } catch (e) { return null; } })();
    const portalSlugs = t.portal_slug ? tenantPortalSlugs(t) : null;
    const on = saas.tenantFeatures(t);
    const featureBox = (std) => saas.FEATURES.filter(f => f.std === std).map(f => `
      <label class="check" style="display:flex;align-items:center;gap:8px;padding:7px 0">
        <input type="checkbox" name="fitur" value="${f.key}" ${on[f.key] ? 'checked' : ''}>
        <span>${esc(f.label)}</span></label>`).join('');
    const riwayat = saas.paymentsOf(t.id, 20);
    const content = `
    <div class="split">
      <div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Data Sekolah</h3><div class="sub">tenant_id ${t.id} · terdaftar ${esc(tglID(t.registered_at || '-'))}</div></div>
            ${ui.badge(st.label, st.color)}</div>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/simpan">
            <div class="row3">
              <div class="field"><label>Nama Sekolah</label><input type="text" name="nama" value="${esc(t.nama)}" required></div>
              <div class="field"><label>Kode Sekolah</label><input type="text" name="school_code" value="${esc(t.school_code)}" maxlength="4" style="text-transform:uppercase" required></div>
              <div class="field"><label>Paket</label><select name="paket">
                ${saas.packageRows({ all: true }).map(p => `<option value="${esc(p.kode)}" ${t.paket === p.kode ? 'selected' : ''}>${esc(p.nama)}${p.harga_bulan ? ' — Rp ' + Number(p.harga_bulan).toLocaleString('id-ID') + '/bln' : ''}</option>`).join('')}
              </select></div>
            </div>
            <div class="row3">
              <div class="field"><label>Status</label><select name="status">
                <option value="active" ${t.status === 'active' ? 'selected' : ''}>Aktif</option>
                <option value="suspended" ${t.status === 'suspended' ? 'selected' : ''}>Ditangguhkan</option></select></div>
              <div class="field"><label>Masa Aktif s.d.</label><input type="date" name="expires_at" value="${esc(String(t.expires_at || '').slice(0, 10))}"></div>
              <div class="field"><label>Telepon</label><input type="text" name="contact_telp" value="${esc(t.contact_telp || '')}"></div>
            </div>
            <div class="row2">
              <div class="field"><label>Email Admin</label><input type="email" name="contact_email" value="${esc(t.contact_email || '')}"></div>
              <div class="field"><label>Nama Kontak</label><input type="text" name="contact_nama" value="${esc(t.contact_nama || '')}"></div>
            </div>
            <div class="field"><label>Alamat</label><input type="text" name="alamat" value="${esc(t.alamat || '')}"></div>
            <div class="card" style="background:var(--soft);margin-bottom:0">
              <div class="card-head" style="padding:0 0 6px"><div><h3 style="font-size:14px">Harga Langganan Khusus Sekolah</h3>
                <div class="sub">Kosongkan / 0 = ikut harga paket <b>${esc(pkgLabel(t.paket))}</b>
                  (Rp ${Number(saas.hargaTenant(t, t.paket, 30)).toLocaleString('id-ID')}/bln ·
                   Rp ${Number(saas.hargaTenant(t, t.paket, 365)).toLocaleString('id-ID')}/tahun)</div></div></div>
              <div class="row2">
                <div class="field"><label>Harga Khusus 1 Bulan (Rp)</label>
                  <input type="text" inputmode="numeric" name="harga_bulanan" value="${Number(t.harga_bulanan) || ''}"
                    placeholder="${Number(saas.packagePrice(t.paket, 30)).toLocaleString('id-ID')}"></div>
                <div class="field"><label>Harga Khusus 12 Bulan (Rp)</label>
                  <input type="text" inputmode="numeric" name="harga_tahunan" value="${Number(t.harga_tahunan) || ''}"
                    placeholder="${Number(saas.packagePrice(t.paket, 365)).toLocaleString('id-ID')}"></div>
              </div>
              <div class="field"><label>Catatan Kesepakatan</label>
                <input type="text" name="harga_catatan" value="${esc(t.harga_catatan || '')}" placeholder="mis. harga khusus mitra / yayasan">
                <div class="hint">Harga ini dipakai saat sekolah mengajukan perpanjangan (manual maupun QRIS otomatis).</div></div>
            </div>
            <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Perubahan</button></div>
          </form>
        </div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Kontrol Fitur (Feature Flagging)</h3>
            <div class="sub">Centang = tersedia. Fitur yang tidak dicentang disembunyikan dari menu &amp; diblokir lewat URL langsung.</div></div></div>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/fitur">
            <div class="row2">
              <div><div class="t-sub" style="font-weight:700;text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin-bottom:6px">Paket Standard</div>${featureBox(1)}</div>
              <div><div class="t-sub" style="font-weight:700;text-transform:uppercase;letter-spacing:.1em;font-size:11px;margin-bottom:6px">Fitur Pro</div>${featureBox(0)}</div>
            </div>
            <div class="form-actions"><button class="btn btn-primary">${ui.icon('check')}Simpan Fitur</button></div>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Riwayat Pembayaran</h3><div class="sub">20 transaksi terakhir</div></div></div>
          <div class="table-wrap short"><table><thead><tr><th>Tanggal</th><th>Jenis</th><th>Durasi</th><th class="num">Nominal</th><th>Status</th><th>Catatan</th></tr></thead><tbody>
          ${riwayat.length ? riwayat.map(p => `<tr>
            <td class="nowrap">${esc(tglID(p.dibuat_at || p.created_at))}</td>
            <td>${p.jenis === 'tagihan' ? 'Tagihan' : 'Perpanjangan'}</td>
            <td>${p.durasi >= 365 ? '12 bln' : '1 bln'}</td>
            <td class="num">${rupiah(p.nominal)}</td>
            <td>${ui.badge((saas.PAY_STATUS[p.status] || {}).label || p.status, (saas.PAY_STATUS[p.status] || {}).color || 'gray')}</td>
            <td class="small">${esc(p.alasan || p.catatan || '-')}</td></tr>`).join('')
        : `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">Belum ada transaksi.</td></tr>`}
          </tbody></table></div>
        </div>
      </div>
      <div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Akses Lifetime</h3><div class="sub">Manual override</div></div></div>
          <div class="alert ${Number(t.is_lifetime_free) ? 'ok' : 'info'}">${ui.icon(Number(t.is_lifetime_free) ? 'check' : 'info')}
            <div>${Number(t.is_lifetime_free)
        ? '<b>Status: Aktif (Lifetime).</b> Sekolah kebal auto-suspend, tidak ditagih, dan tombol perpanjang disembunyikan.'
        : 'Sekolah berlangganan normal: tagihan H-7 diterbitkan otomatis dan akun ditangguhkan bila melewati masa aktif.'}</div></div>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/lifetime">
            <input type="hidden" name="on" value="${Number(t.is_lifetime_free) ? '0' : '1'}">
            <button class="btn ${Number(t.is_lifetime_free) ? '' : 'btn-primary'} btn-block">
              ${Number(t.is_lifetime_free) ? 'Matikan Lifetime (kembali berlangganan)' : 'Set Lifetime (akses gratis selamanya)'}</button>
          </form>
        </div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Akun Admin Sekolah</h3><div class="sub">${esc(adminAkun ? (adminAkun.username || adminAkun.email) : 'belum ada akun admin')}</div></div></div>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/reset-password" data-reset-form>
            <div class="field"><label>Kata Sandi Baru</label>
              <div class="flex" style="gap:8px">
                <input type="text" name="password_baru" class="js-newpw" required minlength="6" placeholder="minimal 6 karakter" style="flex:1">
                <button type="button" class="btn" data-generate-pw>${ui.icon('refresh')}Acak</button>
              </div></div>
            <button class="btn btn-primary btn-block">${ui.icon('lock')}Reset Password</button>
          </form>
        </div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Bantuan Teknis</h3><div class="sub">Masuk sebagai sekolah ini</div></div></div>
          <p class="small muted">Gunakan untuk mendampingi admin sekolah. Tindakan Anda tercatat pada audit log sekolah.</p>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/masuk">
            <button class="btn btn-block">${ui.icon('login')}Login As Tenant</button></form>
        </div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Portal Publik &amp; Domain</h3><div class="sub">Slug unik + domain khusus sekolah</div></div></div>
          <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/portal">
            <div class="field"><label>Alamat Portal (slug)</label>
              <input type="text" name="portal_slug" value="${esc(t.portal_slug || '')}" placeholder="sdn-1-jakarta">
              <div class="hint">${portalSlugs ? `Aktif: <b>/${esc(portalSlugs.siswa)}</b>` : 'Belum ada slug.'}</div></div>
            <div class="field"><label>Custom Domain</label>
              <input type="text" name="custom_domain" value="${esc(t.custom_domain || '')}" placeholder="keuangan.sman1jakarta.sch.id"></div>
            <div class="form-actions"><button class="btn btn-primary btn-block">${ui.icon('save')}Simpan</button></div>
          </form>
          <div class="list mt-2">
            <div class="list-row"><div><div class="mt">Status domain</div><div class="nm">${
        !t.custom_domain ? 'Belum Ada' : (String(t.custom_domain_status).toUpperCase() === 'VERIFIED' ? 'Terverifikasi (Active)' : String(t.custom_domain_status).toUpperCase() === 'FAILED' ? 'Gagal verifikasi' : 'Menunggu Verifikasi (Pending)')
      }</div></div></div>
          </div>
          <div class="flex mt-2" style="gap:8px;flex-wrap:wrap">
            <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/domain/verifikasi">
              <button class="btn btn-sm" ${t.custom_domain ? '' : 'disabled'}>${ui.icon('check')}Verifikasi &amp; Aktifkan Domain</button></form>
            <form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/domain/hapus" data-confirm="Lepas domain khusus sekolah ini?">
              <button class="btn btn-sm btn-danger" ${t.custom_domain ? '' : 'disabled'}>${ui.icon('trash')}Hapus Domain</button></form>
          </div>
          <div class="alert info mt-1" style="margin-bottom:0">${ui.icon('info')}<div><b>Petunjuk DNS untuk sekolah:</b><br>
            <b>Opsi 1 (CNAME)</b> — arahkan CNAME ke <code>${esc(saas.get('portal_cname_target', '') || saas.get('saas_base_url', '') || 'portal.simkeu.com')}</code><br>
            <b>Opsi 2 (A Record — direkomendasikan)</b> — arahkan A Record ke IP server <code>${esc(saas.serverIp() || '(belum diatur)')}</code><br>
            Verifikasi mencocokkan <b>A Record/CNAME</b> dan <b>Host Domain (HTTP_HOST)</b> sekaligus. Sertifikat SSL (HTTPS)
            diterbitkan otomatis oleh proxy server setelah domain terverifikasi.</div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Ringkasan</h3></div></div>
          <div class="list">
            <div class="list-row"><div><div class="mt">Kode Sekolah</div><div class="nm mono" style="letter-spacing:.16em">${esc(t.school_code)}</div></div></div>
            <div class="list-row"><div><div class="mt">Paket</div><div class="nm">${esc(pkgLabel(t.paket))}</div></div></div>
            <div class="list-row"><div><div class="mt">Masa aktif</div><div class="nm">${Number(t.is_lifetime_free) ? 'Lifetime' : esc(tglID(t.expires_at || '-'))}</div></div></div>
            <div class="list-row"><div><div class="mt">Fitur aktif</div><div class="nm">${saas.enabledKeys(t).length} / ${saas.FEATURES.length}</div></div></div>
            <div class="list-row"><div><div class="mt">Database</div><div class="nm mono small">${esc(t.db_file || '-')}</div></div></div>
          </div>
          ${Number(t.id) === 1 ? `<div class="alert info mt-2">${ui.icon('lock')}<div>Sekolah pertama (data produksi) tidak dapat dihapus.</div></div>`
        : `<form method="post" action="${req.BASE}/super-admin/sekolah/${t.id}/hapus" data-confirm="Hapus sekolah ${esc(t.nama)}? Database sekolah akan dilepas dari daftar (cadangan .dihapus tetap disimpan).">
              <button class="btn btn-danger btn-block">${ui.icon('trash')}Hapus Sekolah</button></form>`}
        </div>
      </div>
    </div>`;
    const credModal = cred ? ui.modal('mCredBaru', {
      title: 'Password Berhasil Diperbarui',
      autoShow: true, autoKey: 'cred' + t.id,
      body: `<div class="alert ok" style="margin-top:0">${ui.icon('check')}<div>Sandi admin sekolah <b>${esc(t.nama)}</b> berhasil direset.</div></div>
        <div class="list">
          <div class="list-row"><div><div class="mt">Kode Sekolah (4 Digit)</div><div class="nm mono" style="font-size:18px;letter-spacing:.18em">${esc(cred.kode)}</div></div></div>
          <div class="list-row"><div><div class="mt">Username</div><div class="nm mono">${esc(cred.username)}</div></div></div>
          <div class="list-row"><div><div class="mt">Password Baru</div><div class="nm mono" style="font-size:17px;letter-spacing:.06em">${esc(cred.password)}</div></div></div>
        </div>
        <button type="button" class="btn btn-primary btn-block mt-2" data-copy-login
          data-copy-text="Kode Sekolah: ${esc(cred.kode)}${'\n'}Username: ${esc(cred.username)}${'\n'}Password: ${esc(cred.password)}">
          ${ui.icon('file')}Salin Info Login</button>`,
      footer: `<button class="btn" data-close="mCredBaru">Tutup</button>`
    }) : '';
    res.html(shell(req, { title: t.nama, sub: 'Kode ' + t.school_code + ' · tenant_id ' + t.id, active: '/super-admin/sekolah', content: content + credModal, user: u }));
  });

  post('/super-admin/sekolah/:id/simpan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const t = saas.tenantById(req.params.id);
    if (!t) return res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', 'Sekolah tidak ditemukan.'));
    try {
      const b = req.body;
      const patch = {
        nama: b.nama, school_code: b.school_code, paket: b.paket, status: b.status,
        expires_at: b.expires_at || null,
        is_lifetime_free: t.is_lifetime_free,
        contact_nama: b.contact_nama, contact_email: b.contact_email, contact_telp: b.contact_telp, alamat: b.alamat,
        /* harga langganan khusus per sekolah (0/kosong = ikut paket) */
        harga_bulanan: b.harga_bulanan, harga_tahunan: b.harga_tahunan, harga_catatan: b.harga_catatan,
        features: t.features, user: u
      };
      saas.updateTenant(t.id, patch);
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok', 'Data sekolah diperbarui.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'err', e.message));
    }
  });

  post('/super-admin/sekolah/:id/fitur', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const picked = [].concat(req.body.fitur || []);
      const map = {};
      for (const f of saas.FEATURES) map[f.key] = picked.includes(f.key) ? 1 : 0;
      saas.setFeatures(req.params.id, map, u);
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'ok', 'Kontrol fitur disimpan. Menu & URL sekolah langsung menyesuaikan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'err', e.message));
    }
  });

  post('/super-admin/sekolah/:id/lifetime', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const t = saas.setLifetime(req.params.id, req.body.on === '1', u);
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok',
        Number(t.is_lifetime_free) ? 'Status LIFETIME aktif — sekolah bebas tagihan & auto-suspend.' : 'Status lifetime dimatikan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'err', e.message));
    }
  });

  post('/super-admin/sekolah/:id/hapus', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      saas.deleteTenant(req.params.id, u);
      res.redirect(req.BASE + flash('/super-admin/sekolah', 'ok', 'Sekolah dihapus dari daftar.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'err', e.message));
    }
  });

  /* ---------------- login as tenant ---------------- */
  post('/super-admin/sekolah/:id/masuk', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const t = saas.tenantById(req.params.id);
    if (!t) return res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', 'Sekolah tidak ditemukan.'));
    try {
      const conn = dbm.openTenantConn(t.id, t.db_file);
      const target = conn.prepare("SELECT id,nama FROM users WHERE role='super_admin' AND aktif=1 ORDER BY id LIMIT 1").get();
      if (!target) throw new Error('Sekolah ini belum punya akun admin aktif.');
      const token = saas.createSession({ userId: target.id, tenantId: t.id, kind: 'tenant' });
      S.prepare('UPDATE sessions SET imp_by=? WHERE token=?').run(u.id, token);
      saas.logSaas(u, 'LOGIN AS TENANT', 'tenant', `Masuk sebagai ${t.nama} untuk bantuan teknis`, t.id);
      res.set('Set-Cookie', `simkeu_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 8}${secureCookie(req)}`);
      res.redirect(req.BASE + '/');
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'err', e.message));
    }
  });

  /* ---------------- pembayaran ---------------- */
  get('/super-admin/pembayaran', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const filter = String(req.query.get('status') || 'pending');
    const rows = (filter === 'all' ? saas.paymentsAll() : saas.paymentsAll(filter)).map(p => `<tr>
      <td><b>${esc(p.sekolah_nama)}</b><div class="t-sub">${esc(p.no_invoice || '-')} · ${esc(tglID(p.dibuat_at || p.created_at))}</div></td>
      <td class="mono" style="font-weight:700">${esc(p.school_code)}</td>
      <td>${p.durasi >= 365 ? '12 Bulan' : '1 Bulan'}</td>
      <td class="num">${rupiah(p.nominal)}</td>
      <td>${ui.badge(p.channel === 'gateway' ? ('QRIS Otomatis · ' + esc(p.provider || 'gateway')) : 'QRIS Manual', p.channel === 'gateway' ? 'green' : 'blue')}
        ${p.order_id ? `<div class="t-sub mono">${esc(p.order_id)}</div>` : ''}</td>
      <td>${p.bukti_url
        ? `<button type="button" class="btn btn-sm" data-proof="${esc(p.bukti_url)}">${ui.icon('search')}Lihat Bukti</button>`
        : (p.qr_url ? `<a class="btn btn-sm" href="${esc(p.qr_url)}" target="_blank" rel="noopener">${ui.icon('qris')}QRIS</a>`
          : (p.qr_string ? `<span class="mono t-sub" style="font-size:10px;word-break:break-all">${esc(String(p.qr_string).slice(0, 40))}…</span>` : '<span class="muted small">tanpa bukti</span>'))}</td>
      <td>${ui.badge((saas.PAY_STATUS[p.status] || {}).label || p.status, (saas.PAY_STATUS[p.status] || {}).color || 'gray')}
        ${p.alasan ? `<div class="t-sub">${esc(p.alasan)}</div>` : ''}</td>
      <td class="nowrap">
        ${p.status === 'pending' ? `
        <form method="post" action="${req.BASE}/super-admin/pembayaran/${p.id}/approve" style="display:inline"
          data-confirm="Setujui pembayaran ${esc(p.sekolah_nama)} (${p.durasi >= 365 ? '365' : '30'} hari)? Masa aktif otomatis ditambah dan akun dibuka kembali.">
          <button class="btn btn-sm btn-primary">${ui.icon('check')}Setujui</button></form>
        <form method="post" action="${req.BASE}/super-admin/pembayaran/${p.id}/reject" style="display:inline"
          data-confirm="Tolak pengajuan ini? Isi alasan pada kolom di samping.">
          <input type="hidden" name="alasan" value="Bukti pembayaran tidak valid / dana belum masuk">
          <button class="btn btn-sm btn-danger">${ui.icon('x')}Tolak</button></form>`
        : `<span class="t-sub">${esc(p.direview_oleh || '')}</span>`}
      </td>
    </tr>`).join('');
    const content = `
    <div class="card mb-3">
      <div class="card-head"><div><h3>Persetujuan Pembayaran</h3><div class="sub">Verifikasi bukti transfer perpanjangan (QRIS / DANA Bisnis)</div></div>
        <div class="flex" style="gap:6px">
          ${['pending', 'approved', 'rejected', 'all'].map(s => `<a class="btn btn-sm ${filter === s ? 'btn-primary' : ''}" href="${req.BASE}/super-admin/pembayaran?status=${s}">${s === 'all' ? 'Semua' : (saas.PAY_STATUS[s] || {}).label}</a>`).join('')}
        </div></div>
      <div class="table-wrap"><table><thead><tr><th>Sekolah</th><th>Kode</th><th>Durasi</th><th class="num">Nominal</th><th>Metode</th><th>Bukti / QRIS</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">Tidak ada pengajuan pada filter ini.</td></tr>`}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Penagihan &amp; Pembekuan Otomatis</h3><div class="sub">Cron harian: tagihan H-7 &amp; suspend otomatis</div></div></div>
      <p class="small muted">Cron berjalan otomatis setiap hari. Tombol di bawah menjalankan pemeriksaan sekarang (idempoten — tidak membuat tagihan ganda).</p>
      <form method="post" action="${req.BASE}/super-admin/jalan-tagihan"><button class="btn">${ui.icon('refresh')}Jalankan Pemeriksaan Tagihan Sekarang</button></form>
    </div>`;
    res.html(shell(req, { title: 'Pembayaran & Penagihan', sub: 'Verifikasi pembayaran perpanjangan', active: '/super-admin/pembayaran', content, user: u }));
  });

  post('/super-admin/pembayaran/:id/approve', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const p = saas.paymentById(req.params.id);
      const r = saas.approvePayment(req.params.id, u);
      // notifikasi WA otomatis ke admin sekolah (lewat queue)
      try {
        const msg = `*Pembayaran Disetujui*\n\nSekolah: ${r.tenant.nama} (${r.tenant.school_code})\n` +
          `Durasi: ${Number(p.durasi) >= 365 ? '12 bulan' : '1 bulan'}\nNominal: Rp ${Number(p.nominal || 0).toLocaleString('id-ID')}\n` +
          `Masa aktif sekarang s.d. *${r.end}*.\n\nTerima kasih, layanan sekolah Anda sudah aktif kembali.`;
        if (queue) queue.push('wa.notify', { tenantId: r.tenant.id, message: msg });
      } catch (e) { }
      res.redirect(req.BASE + flash('/super-admin/pembayaran', 'ok',
        `Pembayaran disetujui. ${r.tenant.nama} aktif sampai ${r.end} dan pemblokiran dibuka.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/pembayaran', 'err', e.message));
    }
  });

  post('/super-admin/pembayaran/:id/reject', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const p = saas.paymentById(req.params.id);
      saas.rejectPayment(req.params.id, req.body.alasan, u);
      try {
        const msg = `*Pengajuan Perpanjangan Ditolak*\n\nSekolah: ${p.sekolah_nama} (${p.school_code})\n` +
          `Alasan: ${String(req.body.alasan || '').trim()}\n\nSilakan unggah ulang bukti pembayaran pada menu Info Layanan.`;
        if (queue) queue.push('wa.notify', { tenantId: p.tenant_id, message: msg });
      } catch (e) { }
      res.redirect(req.BASE + flash('/super-admin/pembayaran', 'ok', 'Pengajuan ditolak. Alasan tampil di menu Info Layanan sekolah.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/pembayaran', 'err', e.message));
    }
  });

  post('/super-admin/jalan-tagihan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const r = saas.runDailyJobs();
      res.redirect(req.BASE + flash('/super-admin/pembayaran', 'ok', `Pemeriksaan selesai: ${r.invoices} tagihan baru, ${r.suspended} sekolah ditangguhkan.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/pembayaran', 'err', e.message));
    }
  });

  /* ---------------- QRIS & harga ---------------- */
  get('/super-admin/qris', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const img = saas.get('qris_image', '');
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>QRIS / DANA Bisnis</h3><div class="sub">Tampil otomatis di halaman checkout seluruh sekolah</div></div></div>
        <form method="post" action="${req.BASE}/super-admin/qris">
          <div class="field"><label>Gambar Barcode QRIS (.png / .jpg / .webp / .svg, maks 5 MB)</label>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/*" data-b64="qris_b64" data-max="5">
            <input type="hidden" name="qris_b64" id="qris_b64">
            <div class="hint" id="qris_b64-info">Kosongkan bila tidak ingin mengganti gambar yang sudah ada.
              Gambar raster otomatis dikonversi ke <b>WebP</b> oleh aplikasi — format itu juga diterima di sini.</div></div>
          <div class="row2">
            <div class="field"><label>Nama Pemilik Rekening / QRIS</label><input type="text" name="qris_nama" value="${esc(saas.get('qris_nama', ''))}" placeholder="Yayasan Pendidikan Contoh"></div>
            <div class="field"><label>Nomor Rekening / DANA</label><input type="text" name="qris_nomor" value="${esc(saas.get('qris_nomor', ''))}" placeholder="0812xxxx / 1234567890"></div>
          </div>
          <div class="field"><label>Instruksi Pembayaran</label>
            <textarea name="qris_instruksi" rows="3" placeholder="Contoh: scan QRIS, lalu unggah bukti transfer...">${esc(saas.get('qris_instruksi', ''))}</textarea></div>
          <hr class="sep">
          <div class="row2">
            <div class="field"><label>Harga 1 Bulan (Rp)</label><input type="text" name="harga_bulan" data-money value="${esc(saas.get('harga_bulan', '150000'))}"></div>
            <div class="field"><label>Harga 12 Bulan (Rp)</label><input type="text" name="harga_tahun" data-money value="${esc(saas.get('harga_tahun', '1500000'))}"></div>
          </div>
          <div class="row2">
            <div class="field"><label>Masa Uji Coba Sekolah Baru (hari)</label><input type="number" name="trial_hari" value="${esc(saas.get('trial_hari', '30'))}" min="0" max="365"></div>
            <div class="field"><label>Nama Layanan (judul halaman login)</label><input type="text" name="saas_nama" value="${esc(saas.appName())}"></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Pengaturan</button></div>
        </form>
      </div>
      <div>
        ${(() => {
          const pay = saas.payConfig('');
          const cfg = saas.gatewayCfg();
          const absBase = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || (req.BASE ? '(domain ini)' + req.BASE : '(domain ini)');
          /* URL webhook absolut (host permintaan dipakai bila APP_BASE_URL kosong) */
          const hostAbs = (() => {
            const env = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
            if (env) return env + req.BASE;
            const h = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
            const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
            return h ? proto + '://' + h + req.BASE : '';
          })();
          const webhookAbs = (hostAbs || absBase) + '/api/webhook/kasera';
          return `<div class="card mb-3" data-pay-methods="1">
            <div class="card-head"><div><h3>${ui.icon('qris', 'i-sm')} Metode Pembayaran Hybrid</h3>
              <div class="sub">Aktifkan QRIS otomatis (payment gateway) &/atau QRIS manual</div></div></div>
            <form method="post" action="${req.BASE}/super-admin/qris/pay">
              <label class="opt" style="margin-bottom:8px">
                <input type="checkbox" name="pay_gateway_aktif" value="1" ${pay.gateway_aktif ? 'checked' : ''} data-pay-gateway>
                <span><b>QRIS Otomatis (Payment Gateway)</b><br><span class="t-sub">QRIS dinamis + verifikasi status otomatis lewat callback.</span></span>
              </label>
              <label class="opt" style="margin-bottom:8px">
                <input type="checkbox" name="pay_manual_aktif" value="1" ${pay.manual_aktif ? 'checked' : ''} data-pay-manual>
                <span><b>QRIS Manual (Transfer / Unggah Bukti)</b><br><span class="t-sub">Gambar QRIS statis + verifikasi manual Super Admin.</span></span>
              </label>
              <div class="row2">
                <div class="field"><label>Provider Gateway</label>
                  <select name="pay_gateway_provider" data-pay-provider>
                    ${pay.providers.map(p => `<option value="${esc(p.key)}" ${p.key === pay.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
                  </select></div>
                <div class="field"><label>Mode</label>
                  <select name="pay_gateway_mode" data-pay-mode>
                    <option value="sandbox" ${pay.mode === 'sandbox' ? 'selected' : ''}>Sandbox / Uji Coba</option>
                    <option value="production" ${pay.mode === 'production' ? 'selected' : ''}>Production (Live)</option>
                  </select></div>
              </div>
              <div class="field"><label>Merchant Code / Merchant ID</label>
                <input type="text" name="pay_gateway_merchant" placeholder="${cfg.merchant ? '•••• (tersimpan)' : 'mis. D1234'}"></div>
              <div class="field"><label>Server Key / API Key</label>
                <input type="password" name="pay_gateway_key" autocomplete="new-password"
                  placeholder="${cfg.key ? '•••••••• (tersimpan — isi hanya bila ingin mengganti)' : 'tempel kunci gateway'}"></div>
              <div class="row2">
                <div class="field"><label>Client Key / Callback Token</label>
                  <input type="text" name="pay_gateway_key2" placeholder="${cfg.key2 ? '•••• (tersimpan)' : 'opsional'}"></div>
                <div class="field"><label>Kedaluwarsa QRIS (menit)</label>
                  <input type="number" name="pay_gateway_expire_menit" min="5" max="1440" value="${pay.expire_menit}"></div>
              </div>
              <div class="field"><label>Base URL API Gateway (opsional)</label>
                <input type="text" name="pay_gateway_base" placeholder="${esc(saas.get('pay_gateway_base', '') || 'https://pay.kasera.id')}" data-pay-base>
                <div class="hint">Khusus provider <b>Kasera</b>: isi bila base URL API berbeda. Kosongkan untuk default
                  (<b>production</b> https://pay.kasera.id · <b>sandbox</b> https://sandbox.kasera.id).</div></div>
              <div class="card" style="box-shadow:none;border:1px dashed var(--line);padding:14px;margin-bottom:14px">
                <div class="card-head" style="margin-bottom:8px"><div><h4 style="margin:0">Kasera Pay — Transaksi &amp; Webhook Otomatis</h4>
                  <div class="sub">POST <span class="mono">/v1/transactions</span> + verifikasi <span class="mono">kasera-signature-v1</span></div></div></div>
                <div class="row2">
                  <div class="field"><label>Webhook Secret (Callback Secret)</label>
                    <input type="password" name="pay_gateway_callback" autocomplete="new-password"
                      placeholder="${pay.callback_set ? '•••••••• (tersimpan — isi hanya bila ingin mengganti)' : 'tempel Webhook Secret dari dashboard Kasera'}">
                    <div class="hint">Dipakai menghitung <span class="mono">HMAC-SHA256(body, secret)</span> pada header
                      <span class="mono">kasera-signature-v1</span>. Boleh juga dari variabel lingkungan <span class="mono">KASERA_WEBHOOK_SECRET</span>.</div></div>
                  <div class="field"><label>API Kasera yang dipakai</label>
                    <select name="pay_gateway_kasera_api" data-pay-kasera-api>
                      <option value="auto" ${(pay.kasera_api || 'auto') === 'auto' ? 'selected' : ''}>Otomatis — /v1/transactions, QRIS lama sebagai cadangan</option>
                      <option value="transactions" ${pay.kasera_api === 'transactions' ? 'selected' : ''}>Hanya /v1/transactions (checkout_url)</option>
                      <option value="qris" ${pay.kasera_api === 'qris' ? 'selected' : ''}>Hanya /v1/qris (QRIS lama)</option>
                    </select>
                    <div class="hint">Pilih <b>qris</b> bila akun Kasera Anda belum mengaktifkan API Transactions.</div></div>
                </div>
                <div class="field"><label>URL Webhook untuk dashboard Kasera</label>
                  <input type="text" readonly value="${esc(pay.webhook_url || (absBase + '/api/webhook/kasera'))}" data-pay-webhook>
                  <div class="hint">Daftarkan URL ini pada dashboard Kasera Pay. Status webhook: ${pay.webhook_secret_set
              ? ui.badge('Secret terpasang', 'green') : ui.badge('Secret belum diisi', 'amber')}. Rute webhook tidak memakai sesi &amp; dikecualikan dari CSRF.</div></div>
                <div class="row2">
                  <div class="field"><label>API Key <span class="t-sub">(KASERA_API_KEY)</span></label>
                    <div class="t-sub">Gunakan kolom <b>Server Key / API Key</b> di atas — dikirim sebagai <span class="mono">Authorization: Bearer</span>.</div></div>
                  <div class="field"><label>Idempotency-Key</label>
                    <div class="t-sub">Otomatis memakai nomor pesanan (order id) agar pembayaran tidak ganda saat jaringan terputus.</div></div>
                </div>
              </div>
              <div class="field"><label>URL Callback (daftarkan di dashboard provider)</label>
                <input type="text" readonly value="${esc(absBase)}/pay/callback"></div>
              <button class="btn btn-block mt-2" type="submit" formmethod="post"
                formaction="${req.BASE}/super-admin/qris/test"
                style="margin-bottom:10px">${ui.icon('shield')}Uji Koneksi Kasera (tanpa membuat tagihan)</button>
              <div class="alert info">${ui.icon('info')}<div>${pay.provider === 'sandbox'
              ? 'Provider <b>Simulasi</b> tidak menghubungi jaringan: QR dibuat lokal & dapat disimulasikan lunas untuk pengujian.'
              : 'Pastikan URL callback di atas terdaftar pada dashboard provider agar pembayaran terverifikasi real-time.'}</div></div>
              <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Metode Pembayaran</button></div>
            </form>
          </div>`;
        })()}
        <div class="card mb-3">
          <div class="card-head"><div><h3>Pratinjau QRIS</h3><div class="sub">Yang dilihat sekolah saat checkout</div></div></div>
          ${img ? `<div style="text-align:center;background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px">
              <img src="${esc(img)}" alt="QRIS" loading="lazy" decoding="async" style="max-width:100%;max-height:300px;object-fit:contain"></div>`
        : `<div class="alert warn">${ui.icon('alert')}<div>Belum ada gambar QRIS. Halaman checkout sekolah akan menampilkan instruksi manual.</div></div>`}
          <div class="list mt-2">
            <div class="list-row"><div><div class="mt">QRIS Otomatis</div><div class="nm">${String(saas.get('pay_gateway_aktif')) === '1' ? 'Aktif · ' + esc((saas.payConfig('').provider_label || '')) : 'Nonaktif'}</div></div></div>
            <div class="list-row"><div><div class="mt">QRIS Manual</div><div class="nm">${String(saas.get('pay_manual_aktif', '1')) === '1' ? 'Aktif' : 'Nonaktif'}</div></div></div>
            <div class="list-row"><div><div class="mt">Nama Pemilik</div><div class="nm">${esc(saas.get('qris_nama', '-'))}</div></div></div>
            <div class="list-row"><div><div class="mt">Nomor</div><div class="nm mono">${esc(saas.get('qris_nomor', '-'))}</div></div></div>
          </div>
        </div>
        <div class="card mb-3" data-kasera-log="1">
          <div class="card-head"><div><h3>Log Webhook Kasera</h3><div class="sub">8 notifikasi terakhir — bukti pembayaran diproses otomatis</div></div></div>
          ${(() => {
            const ev = (() => { try { return saas.kaseraEvents(8); } catch (e) { return []; } })();
            if (!ev.length) return `<div class="t-sub">Belum ada notifikasi masuk. Pastikan URL webhook di atas sudah didaftarkan pada dashboard Kasera Pay.</div>`;
            const badgeOf = h => h === 'ok' ? ui.badge('Lunas', 'green')
              : h === 'diabaikan' ? ui.badge('Diabaikan', 'gray')
                : h === 'jumlah-tidak-cocok' ? ui.badge('Nominal beda', 'amber')
                  : h === 'gagal' ? ui.badge('Gagal', 'red') : ui.badge(h || '-', 'gray');
            return `<div class="table-wrap short"><table data-tbl="kasera-event"><thead><tr>
              <th>Waktu</th><th>Event</th><th>Nomor Pesanan</th><th class="num">Nominal</th><th>Hasil</th></tr></thead><tbody>
              ${ev.map(r => `<tr><td class="t-sub nowrap">${esc(lib.stampShort(r.diterima_at))}</td>
                <td class="t-sub">${esc(r.tipe || '-')}</td>
                <td class="mono t-sub">${esc(r.order_id || '-')}</td>
                <td class="num">${rupiah(r.jumlah)}</td>
                <td>${badgeOf(r.hasil)}<div class="t-sub">${esc(r.pesan || '')}</div></td></tr>`).join('')}
              </tbody></table></div>`;
          })()}
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Ringkasan Harga</h3></div></div>
          <div class="list">
            <div class="list-row"><div><div class="mt">1 Bulan (+30 hari)</div><div class="nm">${rupiah(saas.priceOf(30))}</div></div></div>
            <div class="list-row"><div><div class="mt">12 Bulan (+365 hari)</div><div class="nm">${rupiah(saas.priceOf(365))}</div></div></div>
            <div class="list-row"><div><div class="mt">Uji coba sekolah baru</div><div class="nm">${saas.trialDays()} hari</div></div></div>
          </div>
        </div>
      </div>
    </div>`;
    res.html(shell(req, { title: 'QRIS & Harga Layanan', sub: 'Metode pembayaran perpanjangan SaaS', active: '/super-admin/qris', content, user: u }));
  });

  /* ---------------- metode pembayaran hybrid (sakelar + kredensial) ---------------- */
  post('/super-admin/qris/test', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    const cfg = saas.gatewayCfg();
    const key = String(b.pay_gateway_key || '').trim() || cfg.key;
    const mode = ['sandbox', 'production'].includes(String(b.pay_gateway_mode || ''))
      ? String(b.pay_gateway_mode) : cfg.mode;
    const base = String(b.pay_gateway_base || '').trim() || cfg.base;
    try {
      if (!key) throw new Error('API Key belum diisi. Tempel Server Key / API Key lalu coba lagi.');
      const result = await saas.paygw.kaseraTestConnection({
        key, mode, base,
        merchant: String(b.pay_gateway_merchant || '').trim() || cfg.merchant,
        kasera_api: String(b.pay_gateway_kasera_api || cfg.kasera_api || 'auto')
      });
      if (!result.ok) throw new Error(result.error);
      res.redirect(req.BASE + flash('/super-admin/qris', 'ok', 'Koneksi Kasera terverifikasi. Endpoint: ' + (result.base || base)));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/qris', 'err', 'Uji Kasera gagal: ' + e.message));
    }
  });

  post('/super-admin/qris/pay', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    try {
      const provider = saas.paygw.PROVIDER_KEYS.includes(String(b.pay_gateway_provider || '')) ? String(b.pay_gateway_provider) : 'sandbox';
      const mode = ['sandbox', 'production'].includes(String(b.pay_gateway_mode || '')) ? String(b.pay_gateway_mode) : 'sandbox';
      const gatewayOn = String(b.pay_gateway_aktif || '') === '1';
      const manualOn = String(b.pay_manual_aktif || '') === '1';
      if (!gatewayOn && !manualOn) throw new Error('Minimal satu metode pembayaran harus aktif agar sekolah dapat memperpanjang layanan.');
      if (gatewayOn && provider !== 'sandbox' && !String(b.pay_gateway_key || '').trim() && !String(saas.get('pay_gateway_key', '')).trim()) {
        throw new Error('Kunci gateway wajib diisi sebelum mengaktifkan QRIS otomatis (provider ' + provider + ').');
      }
      saas.set('pay_gateway_aktif', gatewayOn ? '1' : '0');
      saas.set('pay_manual_aktif', manualOn ? '1' : '0');
      saas.set('pay_gateway_provider', provider);
      saas.set('pay_gateway_mode', mode);
      saas.set('pay_gateway_expire_menit', String(Math.max(5, Math.min(1440, Number(b.pay_gateway_expire_menit) || 60))));
      if (b.pay_gateway_merchant !== undefined) saas.set('pay_gateway_merchant', String(b.pay_gateway_merchant || '').trim());
      if (String(b.pay_gateway_key || '').trim()) saas.set('pay_gateway_key', String(b.pay_gateway_key).trim());
      if (b.pay_gateway_key2 !== undefined) saas.set('pay_gateway_key2', String(b.pay_gateway_key2 || '').trim());
      if (b.pay_gateway_base !== undefined) saas.set('pay_gateway_base', String(b.pay_gateway_base || '').trim());
      /* Kasera Pay: Webhook Secret (kasera-signature-v1) + pilihan API */
      if (b.pay_gateway_callback !== undefined) saas.set('pay_gateway_callback', String(b.pay_gateway_callback || '').trim());
      if (b.pay_gateway_kasera_api !== undefined) {
        const apiMode = ['auto', 'transactions', 'qris'].includes(String(b.pay_gateway_kasera_api))
          ? String(b.pay_gateway_kasera_api) : 'auto';
        saas.set('pay_gateway_kasera_api', apiMode);
      }
      if (gatewayOn && provider === 'kasera' && !String(b.pay_gateway_callback || saas.get('pay_gateway_callback', '')).trim()
        && !String(process.env.KASERA_WEBHOOK_SECRET || '').trim()) {
        /* bukan penghalang: pembayaran tetap jalan, hanya notifikasi otomatis yang tidak terverifikasi */
        console.warn('[kasera] Webhook Secret belum diisi — webhook akan ditolak sampai secret diatur.');
      }
      saas.logSaas(u, 'EDIT PEMBAYARAN', 'saas',
        `Metode pembayaran: gateway ${gatewayOn ? 'ON' : 'OFF'} (${provider}/${mode}), manual ${manualOn ? 'ON' : 'OFF'}`);
      res.redirect(req.BASE + flash('/super-admin/qris', 'ok', 'Metode pembayaran diperbarui.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/qris', 'err', e.message));
    }
  });

  post('/super-admin/qris', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    try {
      const hb = lib.parseMoney ? lib.parseMoney(b.harga_bulan) : Number(b.harga_bulan);
      const ht = lib.parseMoney ? lib.parseMoney(b.harga_tahun) : Number(b.harga_tahun);
      if (Number(hb) < 0 || Number(ht) < 0) throw new Error('Harga tidak boleh negatif.');
      let img = String(saas.get('qris_image', ''));
      const b64 = String(b.qris_b64 || '').trim();
      if (b64) {
        /* ---- unggah QRIS ----
           Dulu hanya PNG/JPG yang diterima, padahal aplikasi mengonversi gambar raster
           ke WebP sebelum diunggah → unggahan selalu gagal. Sekarang format ditentukan
           dari MIME data URL DAN sidik jari berkas (magic bytes) sebagai cadangan. */
        const mm = b64.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/i);
        const raw = Buffer.from(mm ? mm[2] : b64, 'base64');
        if (!raw.length) throw new Error('Berkas gambar QRIS kosong atau gagal dibaca.');
        if (raw.length > 5 * 1024 * 1024) throw new Error('Ukuran gambar QRIS melebihi 5 MB. Perkecil gambar terlebih dahulu.');
        const sniff = (() => {
          if (raw[0] === 0x89 && raw[1] === 0x50) return { ext: 'png', mime: 'image/png' };
          if (raw[0] === 0xFF && raw[1] === 0xD8) return { ext: 'jpg', mime: 'image/jpeg' };
          if (raw.slice(0, 4).toString('ascii') === 'RIFF' && raw.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
          if (/^\s*<\?xml|^\s*<svg/i.test(raw.slice(0, 200).toString('utf8'))) return { ext: 'svg', mime: 'image/svg+xml' };
          if (raw.slice(0, 4).toString('ascii') === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
          return null;
        })();
        const declared = (mm && mm[1] ? String(mm[1]).toLowerCase() : '');
        const allowed = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' };
        const ext = (sniff && sniff.ext) || allowed[declared] || '';
        if (!ext) throw new Error('Berkas bukan gambar yang valid (gunakan PNG, JPG, WebP, atau SVG).');
        img = await uploadMedia(b64.startsWith('data:') ? b64 : `data:${sniff ? sniff.mime : 'image/png'};base64,${b64}`,
          `qris-${Date.now()}.${ext}`, { jenis: 'logo', tenantId: 1 });
      }
      saas.set('qris_image', img);
      saas.set('qris_nama', String(b.qris_nama || ''));
      saas.set('qris_nomor', String(b.qris_nomor || ''));
      saas.set('qris_instruksi', String(b.qris_instruksi || ''));
      saas.set('harga_bulan', String(Math.round(Number(hb) || 0)));
      saas.set('harga_tahun', String(Math.round(Number(ht) || 0)));
      saas.set('trial_hari', String(Math.max(0, Number(b.trial_hari) || 0)));
      if (b.saas_nama) saas.set('saas_nama', String(b.saas_nama).trim());
      saas.logSaas(u, 'EDIT QRIS', 'saas', 'Memperbarui QRIS, instruksi & harga layanan');
      res.redirect(req.BASE + flash('/super-admin/qris', 'ok', 'Pengaturan QRIS & harga disimpan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/qris', 'err', e.message));
    }
  });

  /* ================= LEGALITAS & SLA (dokumen publik) ================= */
  get('/super-admin/legal', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const g = (k, d) => String(saas.get(k, '') || d || '');
    const legal = require('./legal');
    const def = (legal.DEFAULTS || {});
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Dokumen Legalitas Layanan</h3>
          <div class="sub">Tampil sebagai halaman publik di <code>/syarat-ketentuan</code> dan <code>/sla</code></div></div></div>
        <form method="post" action="${req.BASE}/super-admin/legal">
          <div class="field"><label>Kontak Resmi / Email Dukungan</label>
            <input type="text" name="legal_kontak" value="${esc(g('legal_kontak'))}" maxlength="120" placeholder="support@sekolah.sch.id / 0812xxxx">
            <div class="hint">Ditampilkan pada kedua dokumen sebagai kontak resmi layanan.</div></div>
          <hr class="sep">
          <div class="card-head" style="padding:0 0 8px"><div><h3>Terms of Service (Syarat &amp; Ketentuan)</h3>
            <div class="sub">Nomor urut otomatis menjadi judul bagian</div></div>
            <a class="btn btn-sm" target="_blank" href="${req.BASE}/syarat-ketentuan">${ui.icon('eye')}Lihat</a></div>
          <div class="field"><label>Judul Dokumen</label>
            <input type="text" name="legal_tos_judul" value="${esc(g('legal_tos_judul', 'Syarat & Ketentuan Layanan'))}" maxlength="90"></div>
          <div class="field"><label>Isi Dokumen</label>
            <textarea name="legal_tos" rows="12" style="font-family:ui-monospace,monospace;font-size:12px"
              placeholder="${esc((def.tos || '').slice(0, 120))}">${esc(g('legal_tos'))}</textarea>
            <div class="hint">Mulai baris dengan <code>1. </code>, <code>2. </code> untuk membuat judul bagian. Kosongkan untuk memakai contoh bawaan.</div></div>
          <hr class="sep">
          <div class="card-head" style="padding:0 0 8px"><div><h3>Service Level Agreement (SLA)</h3>
            <div class="sub">Janji tingkat layanan kepada sekolah</div></div>
            <a class="btn btn-sm" target="_blank" href="${req.BASE}/sla">${ui.icon('eye')}Lihat</a></div>
          <div class="field"><label>Judul Dokumen</label>
            <input type="text" name="legal_sla_judul" value="${esc(g('legal_sla_judul', 'Service Level Agreement (SLA)'))}" maxlength="90"></div>
          <div class="field"><label>Isi Dokumen</label>
            <textarea name="legal_sla" rows="12" style="font-family:ui-monospace,monospace;font-size:12px"
              placeholder="${esc((def.sla || '').slice(0, 120))}">${esc(g('legal_sla'))}</textarea></div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Dokumen Legalitas</button></div>
        </form>
      </div>
      <div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Tautan Publik</h3><div class="sub">Dapat dibuka tanpa login</div></div></div>
          <div class="list">
            <a class="list-row" target="_blank" href="${req.BASE}/syarat-ketentuan"><div><div class="nm">Syarat &amp; Ketentuan</div>
              <div class="mt mono">/syarat-ketentuan</div></div><span class="ml-auto">${ui.icon('link')}</span></a>
            <a class="list-row" target="_blank" href="${req.BASE}/sla"><div><div class="nm">Service Level Agreement</div>
              <div class="mt mono">/sla</div></div><span class="ml-auto">${ui.icon('link')}</span></a>
          </div>
          <p class="help">Dokumen ini dipakai bersama seluruh sekolah. Cantumkan juga tautannya pada halaman pendaftaran bila diperlukan.</p>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Status Dokumen</h3></div></div>
          <div class="list">
            <div class="list-row"><div><div class="mt">Syarat &amp; Ketentuan</div><div class="nm">${g('legal_tos') ? 'Kustom' : 'Contoh bawaan'}</div></div></div>
            <div class="list-row"><div><div class="mt">SLA</div><div class="nm">${g('legal_sla') ? 'Kustom' : 'Contoh bawaan'}</div></div></div>
            <div class="list-row"><div><div class="mt">Kontak</div><div class="nm mono">${esc(g('legal_kontak') || '-')}</div></div></div>
          </div>
        </div>
      </div>
    </div>`;
    res.html(shell(req, { title: 'Legalitas & SLA', sub: 'Syarat & Ketentuan Layanan dan Service Level Agreement', active: '/super-admin/legal', content, user: u }));
  });

  post('/super-admin/legal', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    try {
      const now = lib.stampID ? lib.stampID() : lib.nowStamp();
      const put = (k, max) => {
        if (b[k] === undefined) return;
        saas.set(k, String(b[k] || '').replace(/\r/g, '').slice(0, max || 20000));
      };
      put('legal_tos_judul', 90);
      put('legal_sla_judul', 90);
      put('legal_kontak', 120);
      if (b.legal_tos !== undefined) { put('legal_tos', 20000); saas.set('legal_tos_updated', now); }
      if (b.legal_sla !== undefined) { put('legal_sla', 20000); saas.set('legal_sla_updated', now); }
      saas.logSaas(u, 'EDIT LEGALITAS', 'saas', 'Memperbarui dokumen Syarat & Ketentuan / SLA');
      res.redirect(flash(req.BASE + '/super-admin/legal', 'ok', 'Dokumen legalitas disimpan.'));
    } catch (e) {
      res.redirect(flash(req.BASE + '/super-admin/legal', 'err', e.message));
    }
  });

  /* ================= BRANDING SISTEM (default untuk portal login) ================= */
  get('/super-admin/branding', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const logo = saas.appLogo();
    const fav = String(saas.get('saas_favicon', '') || '');
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Branding Sistem (Default)</h3>
          <div class="sub">Dipakai pada portal login utama & tab browser sebelum masuk ke sekolah</div></div></div>
        <form method="post" action="${req.BASE}/super-admin/branding">
          <input type="hidden" name="logo_b64" id="logoB64">
          <input type="hidden" name="fav_b64" id="favB64">
          <div class="field"><label>Nama Aplikasi Default</label>
            <input type="text" name="saas_nama" value="${esc(saas.appName())}" required maxlength="40" placeholder="SIMKEU">
            <div class="hint">Tampil pada portal login utama, judul tab, dan panel Super Admin.</div></div>
          <div class="field"><label>Sub-Judul Aplikasi Default (baris kecil di bawah nama aplikasi)</label>
            <input type="text" name="saas_sub" value="${esc(saas.appSub())}" maxlength="60" placeholder="Sistem Keuangan">
            <div class="hint">Dipakai seluruh sekolah yang <b>belum mengisi</b> sub-judulnya sendiri di menu
              <b>Tema &amp; Branding Aplikasi</b>. Kosongkan untuk kembali ke <b>Sistem Keuangan</b>.</div></div>
          <div class="field"><label>Logo Default Sistem (PNG/JPG/SVG, maks 5 MB)</label>
            <input type="file" accept="image/*" data-b64="logoB64" data-max="5">
            <div class="hint" id="logoB64-info">Kosongkan bila tidak ingin mengganti.</div></div>
          <div class="field"><label>Favicon Default (PNG/ICO/SVG, maks 2 MB)</label>
            <input type="file" accept="image/*,.ico" data-b64="favB64" data-max="2">
            <div class="hint" id="favB64-info">Bila kosong, favicon otomatis dibuat dari logo default.</div></div>
          <div class="row2">
            <div class="field"><label>Masa Uji Coba Sekolah Baru (hari)</label>
              <input type="number" name="trial_hari" value="${esc(saas.trialDays())}" min="0" max="365">
              <div class="hint">Saat mendaftar, expires_at = tanggal daftar + jumlah hari ini.</div></div>
            <div class="field"><label>Paket Default Pendaftaran</label>
              <select name="paket_default">
                ${saas.packageRows().map(p => `<option value="${esc(p.kode)}" ${saas.defaultPackage().kode === p.kode ? 'selected' : ''}>${esc(p.nama)}</option>`).join('')}
              </select></div>
          </div>
          <hr class="sep">
          <div class="card-head" style="padding:0 0 8px"><div><h3>Anti-Spam Pendaftaran</h3>
            <div class="sub">CAPTCHA transparan + pembatasan IP</div></div></div>
          <div class="row2">
            <div class="field"><label>Penyedia CAPTCHA</label>
              <select name="captcha_provider">
                ${['off', 'recaptcha', 'turnstile'].map(x => `<option value="${x}" ${saas.get('captcha_provider', 'off') === x ? 'selected' : ''}>${x === 'off' ? 'Nonaktif' : x === 'recaptcha' ? 'Google reCAPTCHA v3' : 'Cloudflare Turnstile'}</option>`).join('')}
              </select></div>
            <div class="field"><label>Site Key</label><input type="text" name="captcha_site_key" value="${esc(saas.get('captcha_site_key', ''))}" placeholder="site key"></div>
          </div>
          <div class="field"><label>Secret Key</label><input type="password" name="captcha_secret" value="${esc(saas.get('captcha_secret', ''))}" placeholder="secret key" autocomplete="new-password"></div>
          <div class="row2">
            <div class="field"><label>Batas Pendaftaran per IP (per jam)</label><input type="number" name="reg_limit_per_hour" value="${esc(saas.regLimits().perHour)}" min="1" max="50"></div>
            <div class="field"><label>Blokir IP (jam) bila melewati batas</label><input type="number" name="reg_block_hours" value="${esc(saas.regLimits().blockHours)}" min="0" max="168"></div>
          </div>
          <div class="field"><label>Nomor WhatsApp Admin (untuk paket berbayar)</label>
            <input type="text" name="wa_admin_number" value="${esc(saas.get('wa_admin_number', ''))}" placeholder="08xxxxxxxxxx / 628xxxxxxxxxx">
            <div class="hint">Dipakai tombol "Langganan via WhatsApp" pada pilihan paket di halaman pendaftaran sekolah.</div></div>
          <hr class="sep">
          ${(() => {
            const otp = saas.daftarOtpCfg();
            const wc = saas.waConfig();
            return `<div class="card-head" style="padding:0 0 8px"><div><h3>Verifikasi WhatsApp Pendaftaran (OTP)</h3>
              <div class="sub">Nomor WhatsApp pendaftar diverifikasi dengan kode OTP 4 digit sebelum pendaftaran dikirim</div></div></div>
            ${wc.aktif && wc.url
              ? `<div class="alert ok">${ui.icon('check')}<div>Gateway WhatsApp <b>aktif</b> — kode OTP pendaftaran dikirim lewat gateway yang sama dengan informasi tagihan perpanjangan.</div></div>`
              : `<div class="alert warn">${ui.icon('alert')}<div>Gateway WhatsApp <b>belum aktif</b>. Kode OTP belum dapat dikirim sungguhan — aktifkan di menu <a href="${req.BASE}/super-admin/wa"><b>WA Gateway</b></a>. Selama belum aktif, kode akan ditampilkan di layar bila opsi mode uji dicentang.</div></div>`}
            <div class="row3">
              <div class="field"><label>Verifikasi OTP Pendaftaran</label>
                <select name="daftar_otp_aktif">
                  <option value="1" ${otp.aktif ? 'selected' : ''}>Aktif (wajib verifikasi)</option>
                  <option value="0" ${otp.aktif ? '' : 'selected'}>Nonaktif</option>
                </select></div>
              <div class="field"><label>Masa Berlaku Kode (menit)</label>
                <input type="number" name="daftar_otp_menit" value="${otp.menit}" min="1" max="60"></div>
              <div class="field"><label>Jeda Kirim Ulang (detik)</label>
                <input type="number" name="daftar_otp_jeda" value="${otp.jeda}" min="0" max="600"></div>
            </div>
            <input type="hidden" name="daftar_otp_demo" value="0">
            <label class="check mb-2"><input type="checkbox" name="daftar_otp_demo" value="1" ${otp.demo ? 'checked' : ''}>
              Tampilkan kode di layar bila gateway WhatsApp belum aktif (mode uji)</label>
            <div class="hint" style="margin-bottom:4px">Maksimal ${otp.maxPerJam}× kirim per nomor per jam &amp; 5 percobaan verifikasi per kode.</div>`;
          })()}
          <hr class="sep">
          <div class="card-head" style="padding:0 0 8px"><div><h3>Domain, Subdomain &amp; Server</h3>
            <div class="sub">Dipakai pada petunjuk DNS custom domain sekolah</div></div></div>
          <div class="row2">
            <div class="field"><label>Host Portal Platform (CNAME)</label>
              <input type="text" name="saas_base_url" value="${esc(saas.get('saas_base_url', ''))}" placeholder="portal.simkeu.com">
              <div class="hint">Target CNAME yang ditampilkan pada form custom domain sekolah (Opsi 1).</div></div>
            <div class="field"><label>IP Dedicated Server (A Record)</label>
              <input type="text" name="saas_server_ip" value="${esc(saas.serverIp())}" placeholder="103.xx.xx.xx">
              <div class="hint">Ditampilkan sebagai Opsi 2 (A Record) — direkomendasikan bila CNAME gagal.
                Verifikasi DNS mencocokkan IP ini dengan hasil <code>A record</code> domain sekolah.</div></div>
          </div>
          <div class="field"><label>Target CNAME Khusus (opsional)</label>
            <input type="text" name="portal_cname_target" value="${esc(saas.get('portal_cname_target', ''))}" placeholder="portal.simkeu.com">
            <div class="hint">Bila diisi, nilai ini yang dipakai untuk verifikasi CNAME (menimpa Host Portal Platform).</div></div>
          <hr class="sep">
          <div class="card-head" style="padding:0 0 8px"><div><h3>Default Tampilan Halaman Portal Publik</h3>
            <div class="sub">Dipakai sekolah yang belum mengisi teks kustomnya sendiri</div></div></div>
          <div class="row2">
            <div class="field"><label>Default Title (judul tab browser)</label>
              <input type="text" name="portal_default_title" value="${esc(saas.portalDefaults().title)}" maxlength="40" placeholder="Cek Tagihan">
              <div class="hint">Tab browser menjadi <code>Judul · Nama Sekolah</code>.</div></div>
            <div class="field"><label>Default Subtitle (banner portal)</label>
              <input type="text" name="portal_default_subtitle" value="${esc(saas.portalDefaults().subtitle)}" maxlength="60" placeholder="PORTAL CEK TAGIHAN IURAN SISWA">
              <div class="hint">Maksimal 60 karakter agar banner tetap rapi di layar HP.</div></div>
          </div>
          <div class="field"><label>Default Judul Tab Saat Tautan Bertoken (opsional)</label>
            <input type="text" name="portal_default_token_title" value="${esc(saas.portalDefaults().tokenTitle || '')}" maxlength="60" placeholder="mis. Rincian {judul} — kosong = sama dengan Default Title">
            <div class="hint">Berlaku untuk sekolah yang membuka tautan pribadi <code>?token=…</code> dan belum mengisi judulnya sendiri.
              Placeholder <code>{judul}</code> diganti judul portal sekolah. Kosongkan agar judulnya konsisten (Opsi A).</div></div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Branding &amp; Keamanan</button></div>
        </form>
      </div>
      <div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Pratinjau</h3><div class="sub">Tampilan portal login utama</div></div></div>
          <div style="text-align:center;padding:10px 0">
            ${logo ? `<img src="${esc(logo)}" alt="Logo" width="130" height="130" loading="lazy" decoding="async" style="max-width:130px;max-height:130px;object-fit:contain">`
        : `<div style="width:110px;height:110px;border-radius:26px;background:linear-gradient(135deg,#6366F1,#8B5CF6);display:grid;place-items:center;margin:0 auto;color:#fff">${ui.icon('wallet')}</div>`}
            <div style="font-weight:800;font-size:19px;margin-top:12px">${esc(saas.appName())}</div>
            <div class="small muted" style="text-transform:uppercase;letter-spacing:.14em;font-size:10.5px">${esc(saas.appSub())}</div>
            <div class="small muted" style="margin-top:6px">dipakai sebagai default sub-judul sekolah</div>
          </div>
          <div class="list mt-2">
            <div class="list-row"><div><div class="mt">Favicon default</div><div class="nm mono small">${fav ? esc(fav.split('/').pop()) : '(otomatis dari logo)'}</div></div></div>
            <div class="list-row"><div><div class="mt">Masa uji coba</div><div class="nm">${saas.trialDays()} hari</div></div></div>
            <div class="list-row"><div><div class="mt">Paket default</div><div class="nm">${esc(saas.defaultPackage().nama)}</div></div></div>
            <div class="list-row"><div><div class="mt">WhatsApp admin</div><div class="nm mono">${esc(saas.waAdminNumber() || '-')}</div></div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Favicon Tenant</h3><div class="sub">Otomatis per sekolah</div></div></div>
          <div class="alert info">${ui.icon('info')}<div>Setiap sekolah memakai <b>logo sekolahnya</b> sebagai favicon pada tab browser saat
            dashboard/portal sekolah dibuka. Bila logo belum diunggah, sistem memakai favicon default di atas.</div></div>
          <p class="help">Portal login utama (tanpa konteks sekolah) <b>selalu</b> memakai branding default ini.</p>
        </div>
      </div>
    </div>`;
    res.html(shell(req, { title: 'Branding Sistem', sub: 'Nama aplikasi, logo, favicon & keamanan pendaftaran', active: '/super-admin/branding', content, user: u }));
  });

  post('/super-admin/branding', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    try {
      const nama = String(b.saas_nama || '').trim();
      if (nama) saas.set('saas_nama', nama);
      if (b.saas_sub !== undefined) {
        const sub = String(b.saas_sub || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        saas.set('saas_sub', sub || 'Sistem Keuangan');
      }
      if (b.logo_b64) {
        const url = await uploadMedia(b.logo_b64, 'branding-logo-' + Date.now() + '.png', { jenis: 'logo', tenantId: 1 });
        saas.set('saas_logo', url);
      }
      if (b.fav_b64) {
        const url = await uploadMedia(b.fav_b64, 'branding-favicon-' + Date.now() + '.png', { jenis: 'logo', tenantId: 1 });
        saas.set('saas_favicon', url);
      }
      if (b.trial_hari !== undefined) saas.set('trial_hari', String(Math.max(0, Number(b.trial_hari) || 0)));
      if (b.paket_default && saas.packageByKode(b.paket_default)) {
        const p = saas.packageByKode(b.paket_default);
        saas.packageSetDefault(p.id);
      }
      if (b.captcha_provider !== undefined) saas.set('captcha_provider', ['off', 'recaptcha', 'turnstile'].includes(b.captcha_provider) ? b.captcha_provider : 'off');
      if (b.captcha_site_key !== undefined) saas.set('captcha_site_key', String(b.captcha_site_key).trim());
      if (b.captcha_secret !== undefined) saas.set('captcha_secret', String(b.captcha_secret).trim());
      if (b.reg_limit_per_hour !== undefined) saas.set('reg_limit_per_hour', String(Math.max(1, Number(b.reg_limit_per_hour) || 2)));
      if (b.reg_block_hours !== undefined) saas.set('reg_block_hours', String(Math.max(0, Number(b.reg_block_hours) || 24)));
      /* verifikasi OTP pendaftaran — nilai boolean dinormalkan '1'/'0' (jangan simpan 'true'/'false') */
      if (b.daftar_otp_aktif !== undefined) saas.set('daftar_otp_aktif', /^(1|true|on|ya)$/i.test(String(b.daftar_otp_aktif)) ? '1' : '0');
      if (b.daftar_otp_menit !== undefined) saas.set('daftar_otp_menit', String(Math.max(1, Math.min(60, Number(b.daftar_otp_menit) || 10))));
      if (b.daftar_otp_jeda !== undefined) saas.set('daftar_otp_jeda', String(Math.max(0, Math.min(600, Number(b.daftar_otp_jeda) || 0))));
      /* checkbox diikuti hidden "0" → nilai terakhir yang dipakai; kiriman parsial tidak menghapus setelan */
      if (b.daftar_otp_demo !== undefined) {
        const raw = [].concat(b.daftar_otp_demo);
        const last = raw[raw.length - 1];
        saas.set('daftar_otp_demo', /^(1|true|on|ya)$/i.test(String(last)) ? '1' : '0');
      }
      if (b.wa_admin_number !== undefined) saas.set('wa_admin_number', String(b.wa_admin_number || '').trim());
      if (b.saas_base_url !== undefined) saas.set('saas_base_url', String(b.saas_base_url || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
      if (b.saas_server_ip !== undefined) saas.set('saas_server_ip', String(b.saas_server_ip || '').trim());
      if (b.portal_cname_target !== undefined) saas.set('portal_cname_target', String(b.portal_cname_target || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
      if (b.portal_default_title !== undefined) {
        const v = String(b.portal_default_title || '').trim().slice(0, saas.PORTAL_TITLE_MAX || 40);
        saas.set('portal_default_title', v || saas.PORTAL_TEXT_DEFAULT.title);
      }
      if (b.portal_default_subtitle !== undefined) {
        const v = String(b.portal_default_subtitle || '').trim().slice(0, saas.PORTAL_SUBTITLE_MAX || 60);
        saas.set('portal_default_subtitle', v || saas.PORTAL_TEXT_DEFAULT.subtitle);
      }
      if (b.portal_default_token_title !== undefined) {
        /* kosong = ikut Default Title (perilaku konsisten untuk semua sekolah) */
        const v = String(b.portal_default_token_title || '').trim().slice(0, saas.PORTAL_TOKEN_TITLE_MAX || 60);
        saas.set('portal_default_token_title', v);
      }
      saas.logSaas(u, 'EDIT BRANDING', 'saas', 'Memperbarui branding sistem & pengaturan keamanan pendaftaran');
      res.redirect(req.BASE + flash('/super-admin/branding', 'ok', 'Branding sistem disimpan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/branding', 'err', e.message));
    }
  });

  /* ================= MANAJEMEN CUSTOM SLUG & PORTAL PUBLIK ================= */
  /** ringkasan halaman publik satu sekolah (dibaca dari database sekolahnya) */
  function tenantPortalInfo(t) {
    const out = { published: true, title: '', subtitle: '', namaSekolah: '', slugs: null, sw: { siswa: true, pegawai: true, slip: true } };
    try {
      const conn = dbm.openTenantConn(t.id, t.db_file);
      const rows = conn.prepare("SELECT k,v FROM settings WHERE k IN ('portal_aktif','portal_pegawai_aktif','portal_slip_aktif','portal_page_title','portal_subtitle','sekolah_nama')").all();
      const g = k => String(((rows.find(x => x.k === k) || {}).v) || '');
      out.published = g('portal_aktif') !== '0';
      out.sw = { siswa: g('portal_aktif') !== '0', pegawai: g('portal_pegawai_aktif') !== '0', slip: g('portal_slip_aktif') !== '0' };
      out.title = g('portal_page_title');
      out.subtitle = g('portal_subtitle');
      out.namaSekolah = g('sekolah_nama');
      out.slugs = tenantPortalSlugs(t);
    } catch (e) { }
    return out;
  }

  get('/super-admin/portal-publik', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const list = saas.allTenants();
    const q = String(req.query.get('q') || '').trim().toLowerCase();
    const rowsRaw = list.map(t => ({ t, info: tenantPortalInfo(t) }))
      .filter(x => !q || [x.t.nama, x.t.portal_slug, x.t.custom_domain, x.t.school_code]
        .some(v => String(v || '').toLowerCase().includes(q)));
    const defaultTxt = saas.portalDefaults ? saas.portalDefaults() : { title: 'Cek Tagihan', subtitle: 'PORTAL CEK TAGIHAN IURAN SISWA' };
    const domBadge = t => {
      const st = String(t.custom_domain_status || '').toUpperCase();
      if (!t.custom_domain) return ui.badge('Belum Ada', 'gray');
      if (st === 'VERIFIED') return ui.badge('Terverifikasi', 'green');
      if (st === 'FAILED') return ui.badge('Gagal', 'red');
      return ui.badge('Menunggu', 'amber');
    };
    const statusOptions = (cur) => Object.values(saas.PORTAL_STATUS || {}).map(s =>
      `<option value="${esc(s.key)}" ${cur === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('');

    const rows = rowsRaw.map(({ t, info }) => {
      const st = saas.portalStatusOf(t);
      const infoSt = saas.portalStatusInfo(t);
      const slug = String(t.portal_slug || '');
      const portalHref = kind => info.slugs ? tenantPortalUrl(t, req, kind, info.slugs) : '';
      const siswaHref = portalHref('siswa');
      const pegawaiHref = portalHref('pegawai');
      const slipHref = portalHref('slip');
      return `<tr>
        <td><a href="${req.BASE}/super-admin/sekolah/${t.id}"><b>${esc(t.nama)}</b></a>
          <div class="t-sub mono">${esc(t.school_code)} · ${esc(pkgLabel(t.paket))}</div></td>
        <td>${slug && info.slugs
          ? `<a class="mono" href="${esc(siswaHref)}" target="_blank" rel="noopener">${esc('/' + info.slugs.siswa)}</a>`
          : `<span class="badge gray">${slug ? 'Path tidak tersedia' : 'Tidak ada'}</span>`}
          ${info.title ? `<div class="t-sub">Tab: ${esc(info.title)}</div>` : ''}</td>
        <td>${t.custom_domain ? `<span class="mono small">${esc(t.custom_domain)}</span><div>${domBadge(t)}</div>` : domBadge(t)}</td>
        <td>
          <form method="post" action="${req.BASE}/super-admin/portal-publik/${t.id}/status">
            <select name="status" data-autosubmit style="min-width:132px">${statusOptions(st)}</select>
          </form>
          <div class="t-sub">Sakelar sekolah: ${['siswa', 'pegawai', 'slip'].map(k => `${k === 'siswa' ? 'Siswa' : k === 'pegawai' ? 'Pegawai' : 'Slip'} ${info.sw[k] ? ui.badge('ON', 'green') : ui.badge('OFF', 'gray')}`).join(' · ')}</div>
          ${t.portal_note ? `<div class="t-sub" title="${esc(t.portal_note)}">Catatan: ${esc(t.portal_note.slice(0, 40))}</div>` : ''}
        </td>
        <td class="nowrap">
          ${slug && info.slugs ? `<span class="small muted">Lihat:</span>
            <a class="btn btn-sm" href="${esc(siswaHref)}" target="_blank" rel="noopener" title="Portal tagihan siswa">${ui.icon('eye')}Siswa</a>
            <a class="btn btn-sm" href="${esc(pegawaiHref)}" target="_blank" rel="noopener" title="Portal piutang pegawai">Pegawai</a>
            <a class="btn btn-sm" href="${esc(slipHref)}" target="_blank" rel="noopener" title="Portal slip gaji">Slip</a>` : ''}
          <button class="btn btn-sm" data-open="mSlug${t.id}" title="Ubah / reset slug">${ui.icon('edit')}Slug</button>
          ${st === 'aktif'
          ? `<form method="post" action="${req.BASE}/super-admin/portal-publik/${t.id}/status" style="display:inline">
               <input type="hidden" name="status" value="nonaktif">
               <input type="hidden" name="note" value="Disembunyikan oleh Administrator Pusat">
               <button class="btn btn-sm" title="Sembunyikan halaman dari publik">${ui.icon('lock')}Sembunyikan</button></form>`
          : `<form method="post" action="${req.BASE}/super-admin/portal-publik/${t.id}/status" style="display:inline">
               <input type="hidden" name="status" value="aktif">
               <button class="btn btn-sm" title="Aktifkan kembali halaman publik">${ui.icon('unlock')}Aktifkan</button></form>`}
          <form method="post" action="${req.BASE}/super-admin/portal-publik/${t.id}/hapus" style="display:inline"
            data-confirm="Hapus halaman publik ${esc(t.nama)}? Alamat /${esc(info.slugs ? info.slugs.siswa : slug || '-') } akan dikosongkan dan portal kembali ke halaman default. Pengaturan lain tidak dihapus.">
            <button class="btn btn-sm" title="Hapus halaman publik">${ui.icon('trash')}Hapus</button></form>
        </td>
      </tr>`;
    }).join('');

    /* modal edit slug (dirender DI LUAR tabel agar form tidak rusak) */
    const modals = rowsRaw.map(({ t, info }) => {
      const slug = String(t.portal_slug || '');
      const st = saas.portalStatusOf(t);
      const currentPath = info.slugs ? '/' + info.slugs.siswa : '';
      return ui.modal('mSlug' + t.id, {
        title: 'Ubah Slug Halaman Publik',
        body: `<form method="post" action="${req.BASE}/super-admin/portal-publik/${t.id}/slug">
          <div class="alert info" style="margin-top:0">${ui.icon('info')}<div>
            <b>${esc(t.nama)}</b> · kode <b class="mono">${esc(t.school_code)}</b><br>
            Alamat publik: <code>${esc(currentPath || '(tidak ada)')}</code></div></div>
          <div class="field"><label>Custom Slug</label>
            <div class="flex" style="gap:6px;align-items:center">
              <span class="small muted nowrap">/</span>
              <input type="text" name="portal_slug" value="${esc(slug)}" style="flex:1" maxlength="81"
                pattern="[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9](/[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9])?" placeholder="slug-sekolah">
              <span class="small muted nowrap">sub-slug aktif</span>
            </div>
            <div class="hint">Huruf kecil, angka, dan tanda hubung (-), tiap bagian 3–40 karakter, harus unik antar sekolah.
              Boleh dua bagian mengikuti format default (mis. <code>sdn-1-cikoneng/tagihan</code>).
              Kosongkan untuk <b>menghapus</b> halaman publik sekolah ini.</div></div>
          <div class="field"><label>Status Akses Publik</label>
            <select name="status">${statusOptions(st)}</select></div>
          <div class="field"><label>Catatan / Alasan (tampil ke sekolah)</label>
            <input type="text" name="note" value="${esc(t.portal_note || '')}" maxlength="200" placeholder="mis. belum melengkapi verifikasi data"></div>
          <div class="form-actions">
            <button class="btn btn-primary">${ui.icon('save')}Simpan Perubahan</button>
            <button type="button" class="btn" data-close="mSlug${t.id}">Batal</button>
          </div>
        </form>`,
        wide: false
      });
    }).join('');

    const stats = {
      total: list.length,
      aktif: list.filter(t => saas.portalStatusOf(t) === 'aktif').length,
      nonaktif: list.filter(t => saas.portalStatusOf(t) === 'nonaktif').length,
      privat: list.filter(t => saas.portalStatusOf(t) === 'private').length,
      slug: list.filter(t => String(t.portal_slug || '').trim()).length,
      domain: list.filter(t => String(t.custom_domain || '').trim()).length
    };
    const content = `
    <div class="sa-grid mb-3" style="margin-bottom:18px">
      <div class="sa-kpi"><div class="l">Total Sekolah</div><div class="v">${stats.total}</div></div>
      <div class="sa-kpi"><div class="l">Halaman Aktif</div><div class="v" style="color:#16A34A">${stats.aktif}</div></div>
      <div class="sa-kpi"><div class="l">Non-Aktif</div><div class="v" style="color:#DC2626">${stats.nonaktif}</div></div>
      <div class="sa-kpi"><div class="l">Private</div><div class="v" style="color:#D97706">${stats.privat}</div></div>
      <div class="sa-kpi"><div class="l">Punya Slug</div><div class="v">${stats.slug}</div></div>
      <div class="sa-kpi"><div class="l">Custom Domain</div><div class="v">${stats.domain}</div></div>
    </div>

    <div class="card mb-3">
      <div class="card-head"><div><h3>Format Default Slug Portal Publik</h3>
        <div class="sub">Pola alamat portal otomatis untuk sekolah yang baru mendaftar</div></div>
        ${ui.badge(saas.slugFormat ? saas.slugFormat() : '{sekolah}', 'orange', 'plain')}</div>
      <form method="post" action="${req.BASE}/super-admin/portal-publik/format">
        <div class="row2">
          <div class="field"><label>Pola Alamat</label>
            <select name="portal_slug_format">
              <option value="{sekolah}" ${(saas.slugFormat ? saas.slugFormat() : '{sekolah}') === '{sekolah}' ? 'selected' : ''}>/&#123;nama-sekolah-slug&#125; — satu bagian</option>
              <option value="{sekolah}/{custom}" ${(saas.slugFormat ? saas.slugFormat() : '') === '{sekolah}/{custom}' ? 'selected' : ''}>/&#123;nama-sekolah-slug&#125;/&#123;custom-slug&#125; — dua bagian</option>
            </select>
            <div class="hint">Contoh hasil: <code>/${esc(saas.slugFromName ? saas.slugFromName('SDN 1 Cikoneng', 0) : 'sdn-1-cikoneng')}</code>.
              Slug selalu dibuat unik otomatis (ditambah <code>-2</code>, <code>-3</code>, … bila bentrok dengan sekolah lain).</div></div>
          <div class="field"><label>Slug Kustom Bawaan (untuk pola dua bagian)</label>
            <input type="text" name="portal_slug_custom_default" maxlength="40"
              value="${esc(saas.slugCustomDefault ? saas.slugCustomDefault() : 'tagihan')}" placeholder="tagihan"
              pattern="[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9]">
            <div class="hint">Bagian kedua alamat portal. Dapat diubah per sekolah pada tombol <b>Slug</b> di tabel bawah.</div></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Format Slug</button></div>
      </form>
      <p class="help">Perubahan format hanya berlaku untuk <b>sekolah baru</b>; slug sekolah yang sudah ada tidak diubah otomatis.</p>
    </div>

    <div class="card mb-3">
      <div class="card-head"><div><h3>Rekapitulasi Halaman Publik Seluruh Sekolah</h3>
        <div class="sub">URL/slug, domain khusus, status akses publik &amp; aksi pengawasan</div></div></div>
      <form method="get" action="${req.BASE}/super-admin/portal-publik" class="flex" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input type="text" name="q" value="${esc(q)}" placeholder="Cari nama sekolah / slug / domain" style="max-width:320px">
        <button class="btn btn-sm">${ui.icon('search')}Cari</button>
        ${q ? `<a class="btn btn-sm" href="${req.BASE}/super-admin/portal-publik">Reset</a>` : ''}
        <span class="small muted ml-auto">Default teks portal: <b>${esc(defaultTxt.title)}</b> · <b>${esc(defaultTxt.subtitle)}</b>
          <a href="${req.BASE}/super-admin/branding">(ubah)</a></span>
      </form>
      <div class="table-wrap"><table><thead><tr>
        <th>Nama Sekolah (Tenant)</th><th>URL / Custom Slug</th><th>Custom Domain</th>
        <th>Status Akses Publik</th><th>Aksi</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">Tidak ada sekolah yang cocok.</td></tr>`}</tbody></table></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Aturan Akses Halaman Publik</h3><div class="sub">Berlaku untuk seluruh alamat portal sekolah</div></div></div>
      <div class="kv">
        <dt>${ui.badge('Aktif', 'green')}</dt><dd>Dapat dibuka siapa saja — tetap tunduk pada sakelar publikasi milik sekolah sendiri.</dd>
        <dt>${ui.badge('Non-Aktif', 'red')}</dt><dd>Disembunyikan dari publik: pengunjung menerima halaman <b>404 Not Found</b>.</dd>
        <dt>${ui.badge('Private', 'amber')}</dt><dd>Akses terbatas: pengunjung menerima halaman <b>403 Forbidden</b>.</dd>
        <dt>Hapus Halaman Publik</dt><dd>Mengosongkan slug sekolah; alamat publik kembali ke halaman default (404). Pengaturan &amp; data sekolah tetap utuh.</dd>
        <dt>Sakelar sekolah</dt><dd>Bila sekolah mematikan "Publikasikan Halaman Portal", halaman ditutup (503) walau status pusat Aktif.</dd>
      </div>
      <p class="help mt-2">Seluruh perubahan tercatat pada Audit Logs Super Admin dan langsung berlaku tanpa restart server.</p>
    </div>
    ${modals}`;
    res.html(shell(req, {
      title: 'Manajemen Custom Slug & Portal Publik',
      sub: 'Pengawasan alamat publik seluruh sekolah: slug, domain, status akses & penghapusan',
      active: '/super-admin/portal-publik', content, user: u
    }));
  });

  post('/super-admin/portal-publik/:id/status', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const back = req.BASE + '/super-admin/portal-publik';
    try {
      const t = saas.setPortalStatus(req.params.id, req.body.status, String(req.body.note || '').trim(), u);
      if (typeof refreshPortalMap === 'function') refreshPortalMap();
      const info = saas.portalStatusInfo(t);
      const warn = info.key === 'aktif' && !String(t.portal_slug || '').trim()
        ? ' Slug sekolah masih kosong — isi slug agar halaman publik dapat dibuka.' : '';
      res.redirect(flash(back, 'ok', `${t.nama}: status akses publik kini ${info.label}.${warn}`));
    } catch (e) {
      res.redirect(flash(back, 'err', e.message));
    }
  });

  /* ================= FORMAT DEFAULT SLUG PORTAL PUBLIK (dipakai saat sekolah baru mendaftar) ================= */
  post('/super-admin/portal-publik/format', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const back = req.BASE + '/super-admin/portal-publik';
    try {
      const b = req.body || {};
      const fmt = String(b.portal_slug_format || '').trim().toLowerCase();
      const errF = saas.slugFormatError ? saas.slugFormatError(fmt) : null;
      if (errF) throw new Error(errF);
      const custom = String(b.portal_slug_custom_default || '').trim().toLowerCase();
      if (custom && !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(custom)) {
        throw new Error('Slug kustom bawaan hanya boleh huruf kecil, angka, dan tanda hubung (-), 3–40 karakter.');
      }
      saas.set('portal_slug_format', fmt || (saas.SLUG_FORMAT_DEFAULT || '{sekolah}'));
      if (b.portal_slug_custom_default !== undefined) {
        saas.set('portal_slug_custom_default', custom || (saas.SLUG_CUSTOM_DEFAULT || 'tagihan'));
      }
      saas.logSaas(u, 'EDIT FORMAT SLUG', 'portal',
        `Format default slug portal: ${saas.slugFormat()} · contoh ${saas.slugFromName('SDN 1 Cikoneng', 0)}`);
      res.redirect(flash(back, 'ok', `Format default slug disimpan: ${saas.slugFormat()} — contoh /${saas.slugFromName('SDN 1 Cikoneng', 0)}`));
    } catch (e) {
      res.redirect(flash(back, 'err', e.message));
    }
  });

  post('/super-admin/portal-publik/:id/slug', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const back = req.BASE + '/super-admin/portal-publik';
    try {
      const raw = String(req.body.portal_slug || '').trim().toLowerCase();
      let t;
      if (!raw) {
        t = saas.clearPortalSlug(req.params.id, u);
      } else {
        t = saas.setPortalSlug(req.params.id, raw, u);
      }
      if (req.body.status !== undefined) t = saas.setPortalStatus(req.params.id, req.body.status, String(req.body.note || '').trim(), u);
      else if (req.body.note !== undefined) t = saas.setPortalStatus(req.params.id, saas.portalStatusOf(t), String(req.body.note || '').trim(), u);
      if (typeof refreshPortalMap === 'function') refreshPortalMap();
      const portalSlugs = raw ? tenantPortalSlugs(t) : null;
      res.redirect(flash(back, 'ok', raw
        ? `Slug ${t.nama} disimpan: /${portalSlugs.siswa}`
        : `Halaman publik ${t.nama} dihapus — alamat publik kembali ke halaman default.`));
    } catch (e) {
      res.redirect(flash(back, 'err', e.message));
    }
  });

  post('/super-admin/portal-publik/:id/hapus', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const back = req.BASE + '/super-admin/portal-publik';
    try {
      const t = saas.clearPortalSlug(req.params.id, u);
      if (typeof refreshPortalMap === 'function') refreshPortalMap();
      res.redirect(flash(back, 'ok', `Halaman publik ${t.nama} dihapus. Pengaturan & data sekolah tidak berubah.`));
    } catch (e) {
      res.redirect(flash(back, 'err', e.message));
    }
  });

  /* ================= PAKET LANGGANAN (CRUD) ================= */
  get('/super-admin/paket', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const rows = saas.packageRows({ all: true });
    const edId = Number(req.query.get('edit') || 0);
    const ed = edId ? saas.packageById(edId) : null;
    const usage = {};
    for (const r of S.prepare('SELECT paket, COUNT(*) c FROM tenants GROUP BY paket').all()) usage[r.paket] = r.c;
    const featMap = {};
    for (const p of rows) featMap[p.id] = saas.packageFeatureMap(p);
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>${ed ? 'Sunting Paket' : 'Tambah Paket'}</h3>
          <div class="sub">Harga dipakai pada checkout perpanjangan/upgrade sekolah</div></div>
          ${ed ? `<a class="btn btn-sm" href="${req.BASE}/super-admin/paket">${ui.icon('x')}Batal</a>` : ''}</div>
        <form method="post" action="${req.BASE}/super-admin/paket/simpan">
          <input type="hidden" name="id" value="${ed ? ed.id : ''}">
          <div class="row2">
            <div class="field"><label>Nama Paket *</label><input type="text" name="nama" required value="${esc(ed ? ed.nama : '')}" placeholder="Basic / Standard / Pro"></div>
            <div class="field"><label>Kode Paket</label><input type="text" name="kode" value="${esc(ed ? ed.kode : '')}" placeholder="otomatis dari nama" ${ed ? 'readonly' : ''}></div>
          </div>
          <div class="row2">
            <div class="field"><label>Harga 1 Bulan (Rp)</label><input type="text" name="harga_bulan" data-money value="${esc(lib.moneyInput(ed ? ed.harga_bulan : 0))}"></div>
            <div class="field"><label>Harga 12 Bulan (Rp)</label><input type="text" name="harga_tahun" data-money value="${esc(lib.moneyInput(ed ? ed.harga_tahun : 0))}"></div>
          </div>
          <div class="field"><label>Keterangan Singkat</label>
            <input type="text" name="keterangan" value="${esc(ed ? (ed.keterangan || '') : '')}" placeholder="BKU, transaksi, laporan, piutang…"></div>
          <div class="row3">
            <div class="field"><label>Urutan</label><input type="number" name="urutan" value="${ed ? ed.urutan : rows.length + 1}" min="1"></div>
            <div class="field"><label>Masa Uji Coba Paket (hari)</label>
              <input type="number" name="trial_hari" value="${ed && ed.trial_hari !== null && ed.trial_hari !== undefined ? ed.trial_hari : ''}" min="0" max="365" placeholder="ikut pengaturan global"></div>
            <div class="field"><label>Status</label>
              <label class="check" style="margin-top:8px"><input type="checkbox" name="aktif" value="1" ${!ed || ed.aktif ? 'checked' : ''}> Aktif (tampil di pilihan paket)</label></div>
          </div>
          <label class="check mb-2"><input type="checkbox" name="self_trial" value="1" ${ed && Number(ed.self_trial) ? 'checked' : ''}>
            Boleh daftar mandiri (langsung mendaftar &amp; mendapat masa uji coba tanpa bayar dulu)</label>
          <div class="alert info" style="margin-top:0">${ui.icon('info')}<div>Paket yang <b>tidak</b> dicentang "daftar mandiri" hanya bisa dipilih lewat
            tombol WhatsApp di halaman pendaftaran (harus bayar sesuai harga).</div></div>
          <hr class="sep">
          <div class="card-head" style="padding:0 0 8px"><div><h3>Kontrol Fitur Paket</h3>
            <div class="sub">Fitur yang dicentang otomatis aktif untuk sekolah berpaket ini</div></div></div>
          <div class="pk-feat-grid">
            ${saas.FEATURES.map(f => `<label class="check"><input type="checkbox" name="fitur" value="${esc(f.key)}"
              ${(ed ? featMap[ed.id] || {} : {})[f.key] ? 'checked' : ''}> ${esc(f.label)}</label>`).join('')}
          </div>
          <div class="flex mt-2" style="gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm" data-check-name-all="fitur">${ui.icon('check')}Pilih Semua Fitur</button>
            <button type="button" class="btn btn-sm" data-check-name-none="fitur">${ui.icon('x')}Kosongkan</button>
          </div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}${ed ? 'Simpan Perubahan' : 'Tambah Paket'}</button></div>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Daftar Paket (${rows.length})</h3><div class="sub">Paket default dipakai pendaftaran sekolah baru</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Paket</th><th>Kode</th><th class="num">1 Bulan</th><th class="num">12 Bulan</th><th class="num">Sekolah</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(p => `<tr>
            <td><b>${esc(p.nama)}</b>${Number(p.is_default) ? ' ' + ui.badge('Default', 'green') : ''}
              ${Number(p.self_trial) ? ui.badge('Daftar mandiri', 'blue') : ui.badge('Bayar / WA', 'amber')}
              <div class="t-sub">${esc(p.keterangan || '')}</div>
              <div class="t-sub">${saas.packageFeatureLabels(p).length} fitur · trial ${p.trial_hari !== null && p.trial_hari !== undefined ? p.trial_hari : saas.trialDays()} hari</div></td>
            <td class="mono small">${esc(p.kode)}</td>
            <td class="num">${rupiah(p.harga_bulan)}</td>
            <td class="num">${rupiah(p.harga_tahun)}</td>
            <td class="num">${usage[p.kode] || 0}</td>
            <td>${p.aktif ? ui.badge('Aktif', 'green') : ui.badge('Nonaktif', 'gray')}</td>
            <td class="nowrap">
              <a class="btn btn-sm btn-icon" href="${req.BASE}/super-admin/paket?edit=${p.id}" title="Sunting">${ui.icon('edit')}</a>
              ${Number(p.is_default) ? '' : `<form method="post" action="${req.BASE}/super-admin/paket/${p.id}/default" style="display:inline">
                <button class="btn btn-sm" title="Jadikan paket default">Default</button></form>`}
              <form method="post" action="${req.BASE}/super-admin/paket/${p.id}/hapus" style="display:inline" data-confirm="Hapus paket ${esc(p.nama)}?">
                <button class="btn btn-sm btn-danger" ${Number(p.is_default) ? 'disabled' : ''}>${ui.icon('trash')}</button></form>
            </td></tr>`).join('')}
        </tbody></table></div>
        <div class="alert info mt-2">${ui.icon('info')}<div>Menambah paket <b>Pro</b> (atau paket dengan kode <code>pro</code>) otomatis mengaktifkan seluruh fitur untuk sekolah yang memakainya.</div></div>
      </div>
    </div>`;
    res.html(shell(req, { title: 'Paket Langganan', sub: 'Kelola pilihan paket, harga & paket default', active: '/super-admin/paket', content, user: u }));
  });

  post('/super-admin/paket/simpan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const fitur = [].concat(req.body.fitur || []).map(x => String(x).trim()).filter(Boolean);
      const row = saas.packageSave({
        id: req.body.id, nama: req.body.nama, kode: req.body.kode,
        harga_bulan: req.body.harga_bulan, harga_tahun: req.body.harga_tahun,
        keterangan: req.body.keterangan, urutan: req.body.urutan, aktif: req.body.aktif ? 1 : 0,
        self_trial: req.body.self_trial ? 1 : 0, trial_hari: req.body.trial_hari,
        fitur: fitur
      });
      saas.logSaas(u, req.body.id ? 'EDIT PAKET' : 'TAMBAH PAKET', 'saas', `${row.nama} (${row.kode})`);
      res.redirect(req.BASE + flash('/super-admin/paket', 'ok', 'Paket langganan disimpan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/paket', 'err', e.message));
    }
  });
  post('/super-admin/paket/:id/default', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const p = saas.packageSetDefault(req.params.id);
      saas.logSaas(u, 'PAKET DEFAULT', 'saas', p.nama);
      res.redirect(req.BASE + flash('/super-admin/paket', 'ok', `Paket default: ${p.nama}.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/paket', 'err', e.message));
    }
  });
  post('/super-admin/paket/:id/hapus', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const p = saas.packageDelete(req.params.id);
      if (p) saas.logSaas(u, 'HAPUS PAKET', 'saas', p.nama);
      res.redirect(req.BASE + flash('/super-admin/paket', 'ok', 'Paket dihapus.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/paket', 'err', e.message));
    }
  });

  /* ubah paket sekolah langsung dari detail */
  post('/super-admin/sekolah/:id/paket', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const t = saas.setPackage(req.params.id, req.body.paket, u);
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok', `Paket sekolah diubah menjadi ${pkgLabel(t.paket)}.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'err', e.message));
    }
  });

  /* ================= AUTO-BACKUP SERVER (TELEGRAM) + UNDUHAN LANGSUNG ================= */
  get('/super-admin/backup', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const cfg = bt.saasConfig(saas);
    const log = saas.backupLogRows('saas', 12);
    const qs = queue ? queue.stats() : { pending: 0, running: 0, done: 0, failed: 0 };
    const jobs = queue ? queue.recent(8) : [];
    const lastNext = tg.slotNow(cfg.slots) || null;
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Auto-Backup Server (Telegram)</h3>
          <div class="sub">Backup SELURUH SaaS: control plane + semua sekolah, 2x sehari</div></div>
          ${cfg.aktif && cfg.token && cfg.chat ? ui.badge('Aktif', 'green') : ui.badge('Belum aktif', 'gray')}</div>
        <div class="alert info">${ui.icon('info')}<div>Nama berkas <code>Backup_FULL_SIMKEU_DDMMYYYY_HHMM.zip</code>.
          Jadwal <b>06:00</b> &amp; <b>15:00</b>. Berkas sementara (<code>.zip</code>/<code>.sql</code>) dihapus otomatis
          setelah diproses — berhasil maupun gagal.</div></div>
        <form method="post" action="${req.BASE}/super-admin/backup/simpan">
          <div class="field"><label>Telegram Bot Token ${cfg.token ? `<span class="t-sub">(tersimpan: ${esc(tg.mask(cfg.token))})</span>` : ''}</label>
            <input type="text" name="tg_token" value="" autocomplete="off" placeholder="${cfg.token ? 'kosongkan bila tidak diubah' : '123456789:AAH…'}"></div>
          <div class="row2">
            <div class="field"><label>Telegram Chat ID Super Admin</label><input type="text" name="tg_chat" value="${esc(cfg.chat)}" placeholder="987654321 / -100…"></div>
            <div class="field"><label>Jadwal otomatis</label><input type="text" name="backup_slots" value="${esc(cfg.slots)}" placeholder="06:00,15:00"></div>
          </div>
          <label class="check mb-2"><input type="checkbox" name="tg_aktif" value="1" ${cfg.aktif ? 'checked' : ''}> Aktifkan pengiriman otomatis 06:00 &amp; 15:00</label>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Pengaturan</button></div>
        </form>
        <div class="flex mt-2" style="gap:10px;flex-wrap:wrap">
          <form method="post" action="${req.BASE}/super-admin/backup/uji"><button class="btn">${ui.icon('check')}Uji Koneksi Bot</button></form>
          <form method="post" action="${req.BASE}/super-admin/backup/kirim"><button class="btn btn-primary">${ui.icon('upload')}Backup &amp; Kirim Sekarang</button></form>
          <form method="post" action="${req.BASE}/super-admin/backup/bersih"><button class="btn">${ui.icon('trash')}Bersihkan Berkas Sementara</button></form>
          <form method="post" action="${req.BASE}/super-admin/backup/antrean"><button class="btn">${ui.icon('refresh')}Proses Antrean Sekarang</button></form>
        </div>
        <hr class="sep">
        <div class="card-head"><div><h3>Backup Manual &amp; Unduh Langsung</h3>
          <div class="sub">Ekspor real-time seluruh sistem, langsung terunduh ke komputer (tanpa Telegram)</div></div></div>
        <div class="row2">
          <a class="btn btn-block" href="${req.BASE}/super-admin/backup/download-zip">${ui.icon('download')}Download Keseluruhan Data (.zip)</a>
          <a class="btn btn-block" href="${req.BASE}/super-admin/backup/download-sql">${ui.icon('database')}Download Keseluruhan Data (.sql)</a>
        </div>
        <p class="help mt-1">Berkas dibuat saat tombol diklik lalu langsung dikirim ke browser; berkas sementara di server dihapus segera setelahnya.</p>
        <div class="row2 mt-2">
          <a class="btn btn-block" href="${req.BASE}/super-admin/backup/download-source">${ui.icon('download')}Download Source Code (.zip)</a>
          <button type="button" class="btn btn-block" data-open="mRestoreDb">${ui.icon('upload')}Restore Database</button>
        </div>
        <div class="alert warn mt-2">${ui.icon('alert')}<div><b>Download Source Code</b> memuat seluruh kode program tanpa database,
          <code>node_modules</code>, dan berkas rahasia <code>.env</code>. <b>Restore Database</b> menerima berkas
          <code>.zip</code> (seluruh sistem) maupun <code>.json</code> (satu sekolah) — lihat tombol di atas.</div></div>
        <div class="card mt-3" style="box-shadow:none;border-style:dashed">
          <div class="card-head"><div><h3>Konfigurasi Lingkungan (.env)</h3><div class="sub">Portable — pindah hosting tanpa mengubah kode</div></div></div>
          <div class="table-wrap short"><table><thead><tr><th>Variabel</th><th>Nilai aktif</th><th>Keterangan</th></tr></thead><tbody>
            ${envCfg.describe().map(x => `<tr>
              <td class="mono small">${esc(x.key)}</td>
              <td class="small">${esc(String(x.value || '(kosong)'))}${x.fromEnv ? '' : ' <span class="t-sub">(default)</span>'}</td>
              <td class="t-sub">${esc(x.note)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
      </div>
      <div>
        <div class="card mb-3">
          <div class="card-head"><div><h3>Antrean Pekerjaan (Queue)</h3><div class="sub">Backup, WA &amp; penagihan diproses bertahap</div></div></div>
          <div class="sa-grid" style="grid-template-columns:repeat(2,1fr)">
            <div class="sa-kpi"><div class="l">Menunggu</div><div class="v">${qs.pending || 0}</div></div>
            <div class="sa-kpi"><div class="l">Berjalan</div><div class="v">${qs.running || 0}</div></div>
            <div class="sa-kpi"><div class="l">Selesai</div><div class="v">${qs.done || 0}</div></div>
            <div class="sa-kpi"><div class="l">Gagal</div><div class="v">${qs.failed || 0}</div></div>
          </div>
          <div class="table-wrap short mt-2"><table><thead><tr><th>#</th><th>Jenis</th><th>Status</th><th>Percobaan</th><th>Catatan</th></tr></thead><tbody>
            ${jobs.length ? jobs.map(j => `<tr>
              <td class="mono small">${j.id}</td><td class="small">${esc(j.jenis)}</td>
              <td>${ui.badge(j.status, j.status === 'done' ? 'green' : j.status === 'failed' ? 'red' : j.status === 'running' ? 'blue' : 'amber')}</td>
              <td class="num">${j.attempts}</td>
              <td class="small">${esc((j.last_error || '').slice(0, 70))}</td></tr>`).join('')
        : `<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">Antrean kosong.</td></tr>`}
          </tbody></table></div>
          ${lastNext ? `<p class="help mt-1">Slot jadwal aktif sekarang: <b>${esc(lastNext.slot)}</b></p>` : ''}
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Riwayat Backup Server</h3><div class="sub">12 terakhir</div></div></div>
          <div class="table-wrap short"><table><thead><tr><th>Waktu</th><th>Berkas</th><th class="num">Ukuran</th><th>Status</th><th>Pesan</th></tr></thead><tbody>
            ${log.length ? log.map(r => `<tr>
              <td class="nowrap small">${esc(r.created_at || '')}</td>
              <td class="mono small">${esc(r.nama_berkas || '-')}</td>
              <td class="num">${r.ukuran ? Math.round(r.ukuran / 1024) + ' KB' : '-'}</td>
              <td>${r.status === 'sukses' ? ui.badge('Sukses', 'green') : ui.badge('Gagal', 'red')}</td>
              <td class="small">${esc((r.pesan || '').slice(0, 80))}</td></tr>`).join('')
        : `<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">Belum ada riwayat.</td></tr>`}
          </tbody></table></div>
        </div>
      </div>
    </div>
    ${ui.modal('mRestoreDb', {
      title: 'Restore Database Sistem',
      wide: true,
      body: `<div class="alert err">${ui.icon('alert')}<div><b>Perhatian.</b> Restore akan <b>menimpa</b> data yang ada.
          Berkas <code>.zip</code> memulihkan seluruh database sekolah + pengaturan sistem (daftar sekolah dipertahankan).
          Berkas <code>.json</code> memulihkan <b>satu sekolah</b> yang dipilih.
          Berkas media/unggahan (logo, nota) tersimpan di media cloud dan tidak termasuk dalam berkas cadangan.</div></div>
        <form method="post" action="${req.BASE}/super-admin/backup/restore" data-confirm="Restore sekarang? Data yang ada akan ditimpa." id="fRestoreDb">
          <div class="field"><label>Berkas Backup (.zip / .json)</label>
            <input type="hidden" name="file_b64" id="db_file_b64">
            <input type="file" accept=".zip,.json,application/zip,application/json" data-b64="db_file_b64" data-max="300">
            <div class="hint" id="db_file_b64-info">ZIP hasil Download Keseluruhan Data, atau JSON hasil Backup Data Sekolah.</div></div>
          <div class="field"><label>Untuk berkas .json — pilih sekolah tujuan</label>
            <select name="tenant_id">
              <option value="0">— pilih sekolah —</option>
              ${saas.allTenants().map(t => `<option value="${t.id}">${esc(t.school_code)} · ${esc(t.nama)}</option>`).join('')}
            </select>
            <div class="hint">Diabaikan bila berkas yang diunggah berupa ZIP.</div></div>
          <label class="check"><input type="checkbox" name="konfirmasi" value="1" required> Saya memahami data akan ditimpa dan telah membuat backup terbaru</label>
          <div class="form-actions"><button class="btn" type="submit" formaction="${req.BASE}/super-admin/backup/validate" formmethod="post" formnovalidate>${ui.icon('check')}Validasi Berkas Saja</button></div>
        </form>`,
      footer: `<button class="btn" data-close="mRestoreDb">Batal</button><button class="btn btn-danger" form="fRestoreDb">${ui.icon('upload')}Mulai Restore</button>`
    })}
    </div>`;
    res.html(shell(req, { title: 'Backup & Restore Database System', sub: 'Backup penuh, source code & pemulihan database', active: '/super-admin/backup', content, user: u }));
  });

  post('/super-admin/backup/simpan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const b = req.body || {};
    try {
      const cur = bt.saasConfig(saas);
      const token = String(b.tg_token || '').trim() || cur.token;
      const chat = String(b.tg_chat || '').trim();
      const slots = String(b.backup_slots || '06:00,15:00').trim();
      const aktif = b.tg_aktif ? '1' : '0';
      if (aktif === '1') {
        if (!token) throw new Error('Bot Token wajib diisi bila auto-backup diaktifkan.');
        if (!chat) throw new Error('Chat ID Super Admin wajib diisi bila auto-backup diaktifkan.');
        if (!tg.looksValidToken(token)) throw new Error('Format Bot Token tidak valid (contoh: 123456789:AAH…).');
        for (const x of slots.split(',')) if (!/^\d{1,2}:\d{2}$/.test(x.trim())) throw new Error('Format jadwal harus HH:MM, mis. 06:00,15:00.');
      }
      saas.set('tg_token', token);
      saas.set('tg_chat', chat);
      saas.set('backup_slots', slots);
      saas.set('tg_aktif', aktif);
      saas.logSaas(u, 'EDIT BACKUP', 'saas', 'Memperbarui auto-backup server (Telegram)');
      res.redirect(req.BASE + flash('/super-admin/backup', 'ok', 'Pengaturan auto-backup server disimpan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', e.message));
    }
  });

  post('/super-admin/backup/uji', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const cfg = bt.saasConfig(saas);
    try {
      if (!cfg.token) throw new Error('Bot Token belum diisi.');
      const me = await tg.getMe(cfg.token);
      if (!cfg.chat) throw new Error('Bot @' + me.username + ' terdeteksi. Isi Chat ID Super Admin lalu simpan.');
      await tg.sendMessage({ token: cfg.token, chatId: cfg.chat, text: '✅ Uji koneksi Super Admin berhasil.\nAuto-backup server akan dikirim ke chat ini pukul ' + cfg.slots + '.' });
      res.redirect(req.BASE + flash('/super-admin/backup', 'ok', `Bot @${me.username} terhubung; pesan uji terkirim ke ${cfg.chat}.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', 'Uji gagal: ' + e.message));
    }
  });

  post('/super-admin/backup/kirim', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const r = await bt.runSaasBackup(dbm, saas, { trigger: 'manual', user: u.nama });
      res.redirect(req.BASE + flash('/super-admin/backup', 'ok',
        `Backup ${r.nama} (${r.tenants} sekolah · ${Math.round(r.ukuran / 1024)} KB) terkirim ke Telegram ${r.chat}.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', 'Backup gagal: ' + e.message));
    }
  });

  post('/super-admin/backup/antrean', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      if (!queue) throw new Error('Queue tidak tersedia.');
      const hasil = await queue.drain(60);
      const sukses = hasil.filter(x => x.ok).length;
      const gagal = hasil.length - sukses;
      res.redirect(req.BASE + flash('/super-admin/backup', 'ok',
        `Antrean diproses: ${sukses} berhasil, ${gagal} gagal.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', e.message));
    }
  });

  post('/super-admin/backup/bersih', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const n = tg.sweepTemps(Date.now() + 2 * 60 * 60 * 1000); // paksa bersihkan semua sisa
    res.redirect(req.BASE + flash('/super-admin/backup', 'ok', `${n} berkas sementara dibersihkan dari server.`));
  });

  /** unduh langsung: .zip seluruh sistem */
  get('/super-admin/backup/download-zip', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const nama = bd.fullBackupName(new Date());
    let tmp = '';
    try {
      const zip = bt.buildSaasZip(dbm, saas);
      tmp = tg.writeTemp(nama, zip.buffer);
      const buf = require('fs').readFileSync(tmp);
      saas.logSaas(u, 'DOWNLOAD BACKUP', 'saas', `Unduh ZIP seluruh sistem (${zip.tenants} sekolah, ${Math.round(buf.length / 1024)} KB)`);
      res.file(buf, nama, 'application/zip');
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', 'Gagal membuat ZIP: ' + e.message));
    } finally {
      tg.cleanup(tmp);
    }
  });

  /** dump SQL seluruh sistem (control plane + semua sekolah) */
  function sqlValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
    return "'" + String(v).replace(/'/g, "''") + "'";
  }
  function dumpDb(conn, title) {
    const out = [`-- ================================================================`, `-- ${title}`, `-- ${lib.nowStamp()}`, `-- ================================================================`];
    const objs = conn.prepare(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`).all();
    for (const o of objs) {
      if (o.type === 'table') out.push(`DROP TABLE IF EXISTS "${o.name}";`);
      if (o.type === 'index') out.push(`DROP INDEX IF EXISTS "${o.name}";`);
    }
    for (const o of objs.filter(o => o.type === 'table')) out.push(o.sql.trim() + ';');
    for (const o of objs.filter(o => o.type !== 'table')) out.push(o.sql.trim() + ';');
    let rows = 0;
    for (const o of objs.filter(o => o.type === 'table')) {
      let data = [];
      try { data = conn.prepare(`SELECT * FROM "${o.name}"`).all(); } catch (e) { continue; }
      if (!data.length) continue;
      const cols = Object.keys(data[0]);
      const colSql = cols.map(c => `"${c}"`).join(',');
      for (const r of data) { out.push(`INSERT INTO "${o.name}" (${colSql}) VALUES (${cols.map(c => sqlValue(r[c])).join(',')});`); rows++; }
    }
    return { sql: out.join('\n'), rows };
  }
  get('/super-admin/backup/download-sql', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const nama = 'Backup_FULL_SIMKEU_' + lib.todayISO().replace(/-/g, '') + '.sql';
    let tmp = '';
    try {
      const parts = [
        '-- BACKUP LENGKAP SaaS SIMKEU (SQL portabel)',
        '-- Dibuat: ' + lib.nowStamp(),
        '-- Berisi control plane + seluruh database sekolah.',
        'PRAGMA foreign_keys=OFF;',
        ''
      ];
      const cp = dumpDb(saas.db, 'CONTROL PLANE (saas.db)');
      parts.push(cp.sql, '');
      let total = cp.rows, n = 0;
      for (const t of saas.allTenants()) {
        try {
          const conn = dbm.openTenantConn(t.id, t.db_file);
          const d = dumpDb(conn, `SEKOLAH ${t.school_code} — ${t.nama} (tenant_id ${t.id})`);
          parts.push(d.sql, '');
          total += d.rows; n++;
        } catch (e) {
          parts.push(`-- GAGAL membaca database ${t.school_code}: ${e.message}`, '');
        }
      }
      parts.push(`-- total ${total} baris dari ${n} sekolah + control plane`);
      const buf = Buffer.from(parts.join('\n'), 'utf8');
      tmp = tg.writeTemp(nama, buf);
      saas.logSaas(u, 'DOWNLOAD BACKUP', 'saas', `Unduh SQL seluruh sistem (${n} sekolah, ${total} baris)`);
      res.file(buf, nama, 'application/sql');
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', 'Gagal membuat SQL: ' + e.message));
    } finally {
      tg.cleanup(tmp);
    }
  });



  /* ================= DEFAULT TAMPILAN MENU SEKOLAH (PRESET) ================= */
  function menuTemplate() {
    let raw = {};
    try { raw = JSON.parse(saas.get('school_menu_default', '{}') || '{}') || {}; } catch (e) { raw = {}; }
    const hidden = new Set(Array.isArray(raw.hidden) ? raw.hidden.map(String) : []);
    const navUi = raw.navUi && typeof raw.navUi === 'object' ? raw.navUi : {};
    return { hidden, navUi };
  }

  get('/super-admin/menu-default', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const tpl = menuTemplate();
    const catalog = ui.navOrdered(tpl.navUi);
    const all = ui.navCatalog().flatMap(g => g.items.map(i => i.href));
    const shown = all.filter(h => !tpl.hidden.has(h)).length;
    let idx = 0;
    const groups = catalog.map((g, gi) => {
      const items = g.items.map(it => {
        const i = idx++;
        const orig = (ui.NAV.find(x => x.id === g.id) || { items: [] }).items.find(x => x.href === it.href) || {};
        const pos = Number(tpl.navUi.order && tpl.navUi.order[it.href]) || (i + 1);
        return `<tr>
          <td class="center"><input type="checkbox" name="show" value="${esc(it.href)}" data-check-name="${i}" ${tpl.hidden.has(it.href) ? '' : 'checked'}></td>
          <td><div class="t-strong">${esc(orig.label || it.label)}</div><div class="t-sub mono">${esc(it.href)}</div>
            <input type="hidden" name="h_${i}" value="${esc(it.href)}"></td>
          <td><input name="lbl_${i}" value="${esc(tpl.navUi.labels && tpl.navUi.labels[it.href] || '')}" maxlength="60" placeholder="${esc(orig.label || it.label)}"></td>
          <td style="width:110px"><input type="number" name="ord_${i}" value="${pos}" min="1" max="999"></td>
        </tr>`;
      }).join('');
      const gpos = Number(tpl.navUi.groups && tpl.navUi.groups[g.id]) || (gi + 1);
      return `<div class="card mb-2">
        <div class="card-head"><div><h3>${esc(g.group)}</h3><div class="sub">${g.items.length} menu</div></div>
          <div class="field" style="margin:0;width:130px"><label class="small">Urutan grup</label>
            <input type="number" name="g_${esc(g.id)}" value="${gpos}" min="1" max="99"></div></div>
        <div class="table-wrap"><table><thead><tr>
          <th style="width:64px" class="center">Tampil</th><th>Menu</th><th style="width:260px">Judul Tampilan</th><th>Urutan</th>
        </tr></thead><tbody>${items}</tbody></table></div>
      </div>`;
    }).join('');
    const content = `<div class="alert info">${ui.icon('info')}<div><b>Preset tampilan menu sekolah baru.</b>
      Susunan ini otomatis diterapkan saat sekolah baru didaftarkan (menu yang dicentang tampil, urutan &amp; judul mengikuti pengaturan ini).
      Sekolah tetap dapat mengubahnya sendiri lewat menu <b>Pengaturan Tampilan Menu</b>.</div></div>
    <form method="post" action="${req.BASE}/super-admin/menu-default/simpan" id="fMenuDefault">
      <div class="card mb-3">
        <div class="card-head"><div><h3>Ringkasan Preset</h3><div class="sub">${shown} dari ${all.length} menu ditampilkan</div></div>
          <div class="toolbar">
            <label class="check small"><input type="checkbox" data-check-name-all="show"> Tampilkan semua menu</label>
            <button type="submit" class="btn btn-primary btn-sm">${ui.icon('save')}Simpan Preset</button>
          </div></div>
      </div>
      ${groups}
      <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Preset Default</button></div>
    </form>
    <div class="card mt-3">
      <div class="card-head"><div><h3>Terapkan ke Semua Sekolah</h3><div class="sub">Timpa tampilan menu seluruh sekolah yang sudah terdaftar</div></div></div>
      <div class="alert warn">${ui.icon('alert')}<div>Tindakan ini akan mengganti pengaturan menu <b>custom</b> milik semua sekolah dengan preset di atas.
        Ikon PNG kustom yang sudah diunggah akan dilepas.</div></div>
      <form method="post" action="${req.BASE}/super-admin/menu-default/terapkan" data-confirm="Terapkan preset menu ke SEMUA sekolah? Pengaturan menu custom tiap sekolah akan ditimpa.">
        <label class="check mb-2"><input type="checkbox" name="konfirmasi" value="1" required> Saya memahami pengaturan menu semua sekolah akan ditimpa</label>
        <button class="btn btn-danger">${ui.icon('refresh')}Terapkan ke Semua Sekolah</button>
      </form>
    </div>`;
    res.html(shell(req, { title: 'Default Tampilan Menu Sekolah', sub: 'Preset layout menu untuk sekolah baru', active: '/super-admin/menu-default', content, user: u }));
  });

  post('/super-admin/menu-default/simpan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const all = ui.navCatalog().flatMap(g => g.items.map(i => i.href));
    const shown = new Set([].concat(req.body.show || []).map(String));
    const hidden = all.filter(h => !shown.has(h));
    const order = {}, labels = {}, groups = {};
    for (let i = 0; req.body['h_' + i] !== undefined; i++) {
      const href = String(req.body['h_' + i] || '');
      if (!href) continue;
      const ord = Number(req.body['ord_' + i]);
      order[href] = Number.isFinite(ord) && ord > 0 ? ord : (i + 1);
      const lbl = String(req.body['lbl_' + i] || '').trim().slice(0, 60);
      if (lbl) labels[href] = lbl;
    }
    ui.navCatalog().forEach(g => {
      const v = Number(req.body['g_' + g.id]);
      if (Number.isFinite(v) && v > 0) groups[g.id] = v;
    });
    saas.set('school_menu_default', JSON.stringify({ hidden, navUi: { order, groups, labels, icons: {} } }));
    saas.logSaas(u, 'SIMPAN PRESET MENU', 'saas', `Preset tampilan menu sekolah: ${all.length - hidden.length}/${all.length} menu ditampilkan`);
    res.redirect(req.BASE + flash('/super-admin/menu-default', 'ok', 'Preset tampilan menu sekolah disimpan.'));
  });

  post('/super-admin/menu-default/terapkan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    if (!req.body.konfirmasi) return res.redirect(req.BASE + flash('/super-admin/menu-default', 'err', 'Centang konfirmasi terlebih dahulu.'));
    const tpl = menuTemplate();
    let ok = 0, gagal = 0;
    for (const t of saas.allTenants()) {
      try {
        dbm.runAsTenant(t, () => {
          dbm.setSetting('nav_hidden', Array.from(tpl.hidden).join(','));
          dbm.setNavUi(tpl.navUi);
        });
        ok++;
      } catch (e) { gagal++; }
    }
    saas.logSaas(u, 'TERAPKAN PRESET MENU', 'saas', `Preset menu diterapkan ke ${ok} sekolah${gagal ? ', gagal ' + gagal : ''}`);
    res.redirect(req.BASE + flash('/super-admin/menu-default', 'ok', `Preset menu diterapkan ke ${ok} sekolah${gagal ? ' (' + gagal + ' gagal)' : ''}.`));
  });

  /* ================= SOURCE CODE & RESTORE DATABASE (SUPER ADMIN) ================= */
  /** unduh seluruh source code aplikasi (.zip) — tanpa database & .env */
  get('/super-admin/backup/download-source', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const files = srcpack.collectSource();
      files.push({
        name: 'README-SOURCE.txt', data: [
          'SIMKEU SaaS — SOURCE CODE APLIKASI',
          'Dibuat: ' + lib.nowStamp(),
          '',
          'CARA PASANG DI VPS BARU',
          '  1. Salin seluruh isi ZIP ke folder aplikasi.',
          '  2. npm install  (better-sqlite3 12.9.0).',
          '  3. Salin .env.example menjadi .env lalu isi DB_PATH, APP_BASE_URL,',
          '     APP_MEDIA_URL/APP_MEDIA_TOKEN, WA_API_URL/WA_API_TOKEN.',
          '  4. Pulihkan data lewat panel Super Admin → Backup & Restore Database System.',
          '  5. Jalankan: npm start (port mengikuti variabel PORT).',
          '',
          'CATATAN: database, node_modules, dan .env TIDAK disertakan.'
        ].join('\r\n')
      });
      const buf = lib.zip(files);
      const stamp = String(lib.nowStamp()).slice(0, 10).replace(/-/g, '');
      saas.logSaas(u, 'DOWNLOAD SOURCE', 'saas', `Mengunduh source code aplikasi (${files.length} berkas)`);
      res.file(buf, `simkeu-source-${stamp}.zip`, 'application/zip');
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', 'Gagal mengemas source code: ' + e.message));
    }
  });

  /** pulihkan seluruh data satu sekolah dari objek dump SIMKEU */
  function restoreTenantDump(conn, data) {
    bd.validateDump(conn, data);
    const tables = bd.TABLES;
    let n = 0;
    conn.transaction(() => {
      for (const t of tables) {
        const rows = data && data.tables ? data.tables[t] : null;
        if (!Array.isArray(rows)) continue;
        conn.prepare('DELETE FROM "' + t + '"').run();
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]).filter(k => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
        if (!cols.length) continue;
        const stmt = conn.prepare('INSERT INTO "' + t + '" (' + cols.map(c => '"' + c + '"').join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')');
        for (const row of rows) { stmt.run(cols.map(c => row[c] === undefined ? null : row[c])); n++; }
      }
      if (!conn.prepare("SELECT COUNT(*) c FROM users WHERE role='super_admin'").get().c) {
        conn.prepare('INSERT INTO users (nama,email,password,role,aktif,jabatan,created_at) VALUES (?,?,?,?,1,?,?)')
          .run('Bendahara Utama', 'admin@sekolah.sch.id', lib.hashPassword('admin123'), 'super_admin', 'Bendahara Utama', lib.nowStamp());
      }
    })();
    return n;
  }

  function savePreRestoreSnapshot() {
    const dir = path.dirname(dbm.SAAS_DB_PATH || path.join(__dirname, '..', 'data', 'saas.db'));
    const name = `pre-restore-full-${Date.now()}.zip`;
    const file = path.join(dir, name);
    fs.mkdirSync(dir, { recursive: true });
    const zip = bt.buildSaasZip(dbm, saas);
    fs.writeFileSync(file, zip.buffer, { flag: 'wx' });
    const old = fs.readdirSync(dir)
      .filter(x => /^pre-restore-full-\d+\.zip$/.test(x))
      .sort();
    while (old.length > 3) {
      const stale = old.shift();
      fs.unlinkSync(path.join(dir, stale));
    }
    return name;
  }

  post('/super-admin/backup/validate', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const raw = String(req.body.file_b64 || '');
      const buf = Buffer.from(raw.includes(',') ? raw.split(',').pop() : raw, 'base64');
      if (!buf.length) throw new Error('Berkas kosong atau belum dipilih.');
      let totalRows = 0, tenantCount = 0;
      if (buf[0] === 0x50 && buf[1] === 0x4b) {
        const entries = X.unzipEntries(buf);
        const cParts = Object.keys(entries).filter(n => /(^|\/)control-plane\.json$/i.test(n));
        const tParts = Object.keys(entries).filter(n => /^sekolah\/[^/]+\/database\.json$/i.test(n));
        if (!cParts.length && !tParts.length) throw new Error('Berkas ZIP bukan backup sistem SIMKEU.');
        for (const key of tParts) {
          const code = key.split('/')[1].split('-')[0].toUpperCase();
          const tenant = saas.tenantByCode(code);
          if (!tenant) continue;
          const data = JSON.parse(entries[key].toString('utf8'));
          const conn = dbm.openTenantConn(tenant.id, tenant.db_file);
          const report = bd.validateDump(conn, data);
          totalRows += report.rows;
          tenantCount++;
        }
        if (cParts.length) {
          const control = JSON.parse(entries[cParts[0]].toString('utf8'));
          if (!control || control.app !== 'simkeu-saas' || !control.tables || typeof control.tables !== 'object') {
            throw new Error('Data control plane pada ZIP tidak valid.');
          }
          const skip = new Set(['sessions', 'saas_jobs', 'tenants', 'saas_audit', 'saas_backup_log']);
          const existing = new Set(dbm.tableNamesOf(saas.db));
          for (const [table, rows] of Object.entries(control.tables)) {
            if (skip.has(table) || !existing.has(table)) continue;
            if (!Array.isArray(rows)) throw new Error(`Tabel control plane "${table}" bukan daftar baris yang valid.`);
            const cols = new Set(saas.db.pragma(`table_info("${table}")`).map(c => c.name));
            for (const row of rows) {
              if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Baris control plane "${table}" tidak valid.`);
              for (const col of Object.keys(row)) if (!cols.has(col)) throw new Error(`Kolom control plane "${table}.${col}" tidak tersedia.`);
              totalRows++;
            }
          }
        }
        if (!tenantCount && !cParts.length) throw new Error('Tidak ada database sekolah pada ZIP yang cocok dengan tenant terdaftar.');
        return res.redirect(req.BASE + flash('/super-admin/backup', 'ok', `Validasi ZIP berhasil: ${tenantCount} database sekolah dan ${totalRows} baris; tidak ada data yang diubah.`));
      }
      const data = JSON.parse(buf.toString('utf8'));
      const target = saas.tenantById(Number(req.body.tenant_id || 0));
      if (!target) throw new Error('Pilih sekolah tujuan untuk validasi berkas JSON.');
      const report = bd.validateDump(dbm.openTenantConn(target.id, target.db_file), data);
      res.redirect(req.BASE + flash('/super-admin/backup', 'ok', `Validasi JSON berhasil: ${target.school_code}, ${report.tables} tabel dan ${report.rows} baris; tidak ada data yang diubah.`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/backup', 'err', 'Validasi backup gagal: ' + e.message));
    }
  });

  post('/super-admin/backup/restore', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const back = '/super-admin/backup';
    if (!req.body.konfirmasi) return res.redirect(req.BASE + flash(back, 'err', 'Centang konfirmasi terlebih dahulu.'));
    let buf;
    try {
      const raw = String(req.body.file_b64 || '');
      buf = Buffer.from(raw.includes(',') ? raw.split(',').pop() : raw, 'base64');
      if (!buf.length) throw new Error('Berkas kosong atau belum dipilih.');
    } catch (e) {
      return res.redirect(req.BASE + flash(back, 'err', 'Berkas tidak valid: ' + e.message));
    }
    // ---- berkas ZIP: seluruh sistem (control plane + semua sekolah) ----
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      let entries = {};
      try { entries = X.unzipEntries(buf); } catch (e) {
        return res.redirect(req.BASE + flash(back, 'err', 'ZIP tidak dapat dibaca: ' + e.message));
      }
      const cParts = Object.keys(entries).filter(n => /(^|\/)control-plane\.json$/i.test(n));
      const tParts = Object.keys(entries).filter(n => /^sekolah\/[^/]+\/database\.json$/i.test(n));
      if (!cParts.length && !tParts.length) {
        return res.redirect(req.BASE + flash(back, 'err', 'Berkas ZIP bukan backup sistem SIMKEU (control-plane.json / sekolah/*/database.json tidak ditemukan).'));
      }
      const restorePlan = [], sekolahSkip = [];
      for (const key of tParts) {
        const code = key.split('/')[1].split('-')[0].toUpperCase();
        const t = saas.tenantByCode(code);
        if (!t) { sekolahSkip.push(code); continue; }
        try {
          const data = JSON.parse(entries[key].toString('utf8'));
          const conn = dbm.openTenantConn(t.id, t.db_file);
          const validation = bd.validateDump(conn, data);
          restorePlan.push({ tenant: t, data, rows: validation.rows });
        } catch (e) {
          return res.redirect(req.BASE + flash(back, 'err', `Validasi database ${code} gagal; tidak ada database yang dipulihkan: ${e.message}`));
        }
      }
      // control plane: pulihkan pengaturan & data pendukung, JANGAN timpa daftar sekolah
      let control = null;
      const cpSkip = new Set(['sessions', 'saas_jobs', 'tenants', 'saas_audit', 'saas_backup_log']);
      if (cParts.length) {
        try {
          control = JSON.parse(entries[cParts[0]].toString('utf8'));
          if (!control || control.app !== 'simkeu-saas' || !control.tables || typeof control.tables !== 'object') {
            throw new Error('Struktur control plane tidak valid.');
          }
          const existing = new Set(dbm.tableNamesOf(saas.db));
          for (const [table, list] of Object.entries(control.tables)) {
            if (cpSkip.has(table) || !existing.has(table)) continue;
            if (!Array.isArray(list)) throw new Error(`Tabel "${table}" bukan daftar baris yang valid.`);
            const cols = new Set(saas.db.pragma(`table_info("${table}")`).map(c => c.name));
            for (const row of list) {
              if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Baris tabel "${table}" tidak valid.`);
              for (const col of Object.keys(row)) if (!cols.has(col)) throw new Error(`Kolom "${table}.${col}" tidak tersedia.`);
            }
          }
        } catch (e) {
          return res.redirect(req.BASE + flash(back, 'err', `Validasi control plane gagal; tidak ada database yang dipulihkan: ${e.message}`));
        }
      }
      if (!restorePlan.length && !control) {
        return res.redirect(req.BASE + flash(back, 'err', 'Tidak ada database backup yang cocok dengan sekolah terdaftar.'));
      }
      let snapshotName;
      try { snapshotName = savePreRestoreSnapshot(); }
      catch (e) {
        return res.redirect(req.BASE + flash(back, 'err', 'Snapshot sebelum restore gagal dibuat; data tidak diubah. ' + e.message));
      }
      let sekolahOk = 0, rows = 0, cpTables = 0;
      for (const item of restorePlan) {
        try {
          rows += restoreTenantDump(dbm.openTenantConn(item.tenant.id, item.tenant.db_file), item.data);
          sekolahOk++;
        } catch (e) {
          return res.redirect(req.BASE + flash(back, 'err', `Restore berhenti setelah ${sekolahOk} sekolah; ${item.tenant.school_code} gagal: ${e.message}. Data sebelumnya mungkin sudah dipulihkan sebagian.`));
        }
      }
      if (control) {
        const existing = new Set(dbm.tableNamesOf(saas.db));
        saas.db.transaction(() => {
          for (const [table, list] of Object.entries(control.tables)) {
            if (cpSkip.has(table) || !existing.has(table)) continue;
            saas.db.prepare('DELETE FROM "' + table + '"').run();
            if (!list.length) continue;
            const cols = Object.keys(list[0]).filter(k => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
            const stmt = saas.db.prepare('INSERT INTO "' + table + '" (' + cols.map(c => '"' + c + '"').join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')');
            for (const row of list) { stmt.run(cols.map(c => row[c] === undefined ? null : row[c])); rows++; }
            cpTables++;
          }
        })();
      }
      try { saas.db.prepare('DELETE FROM sessions').run(); } catch (e) { }
      saas.logSaas(u, 'RESTORE DATABASE', 'saas',
        `Restore ZIP: ${sekolahOk} sekolah (${rows} baris), ${cpTables} tabel sistem` + (sekolahSkip.length ? `, dilewati: ${sekolahSkip.join(', ')}` : ''));
      res.set('Set-Cookie', `simkeu_saas=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`);
      const msg = `Restore ZIP selesai: ${sekolahOk} sekolah dipulihkan (${rows} baris), ${cpTables} tabel sistem.` +
        (sekolahSkip.length ? ' Dilewati: ' + sekolahSkip.join(', ') + '.' : '') +
        ` Snapshot sebelum restore: ${snapshotName}. Silakan masuk kembali.`;
      return res.redirect(req.BASE + '/super-admin/login?ok=' + encodeURIComponent(msg));
    }
    // ---- berkas JSON: satu sekolah ----
    let data;
    try { data = JSON.parse(buf.toString('utf8')); } catch (e) {
      return res.redirect(req.BASE + flash(back, 'err', 'Berkas JSON tidak valid: ' + e.message));
    }
    if (!data || data.app !== 'simkeu-sekolah' || !data.tables) {
      return res.redirect(req.BASE + flash(back, 'err', 'Format JSON bukan backup SIMKEU Sekolah.'));
    }
    const tid = Number(req.body.tenant_id || 0);
    const target = tid ? saas.tenantById(tid) : null;
    if (!target) return res.redirect(req.BASE + flash(back, 'err', 'Pilih sekolah tujuan untuk restore berkas JSON.'));
    try {
      const conn = dbm.openTenantConn(target.id, target.db_file);
      bd.validateDump(conn, data);
      const snapshotName = savePreRestoreSnapshot();
      const rows = restoreTenantDump(conn, data);
      try { saas.db.prepare('DELETE FROM sessions WHERE tenant_id=?').run(target.id); } catch (e) { }
      saas.logSaas(u, 'RESTORE DATABASE', 'tenant', `Restore JSON ke ${target.school_code} · ${target.nama} (${rows} baris)`, target.id);
      res.redirect(req.BASE + flash(back, 'ok', `Restore JSON ke ${target.school_code} — ${target.nama} selesai (${rows} baris). Snapshot sebelum restore: ${snapshotName}.`));
    } catch (e) {
      res.redirect(req.BASE + flash(back, 'err', 'Restore gagal: ' + e.message));
    }
  });

  /* ================= RESET PASSWORD ADMIN SEKOLAH ================= */
  function adminOf(tenant) {
    const conn = dbm.openTenantConn(tenant.id, tenant.db_file);
    return conn.prepare("SELECT id,nama,email,username,role,aktif FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get() || null;
  }
  post('/super-admin/sekolah/:id/reset-password', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const t = saas.tenantById(req.params.id);
    if (!t) return res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', 'Sekolah tidak ditemukan.'));
    try {
      const baru = String(req.body.password_baru || '');
      if (baru.length < 6) throw new Error('Kata sandi baru minimal 6 karakter.');
      const adm = adminOf(t);
      if (!adm) throw new Error('Sekolah ini belum memiliki akun admin (role admin sekolah).');
      const conn = dbm.openTenantConn(t.id, t.db_file);
      // hash aman (scrypt dengan salt acak — setara kelas bcrypt/argon2 untuk kebutuhan aplikasi ini)
      conn.prepare('UPDATE users SET password=?, aktif=1 WHERE id=?').run(lib.hashPassword(baru), adm.id);
      conn.prepare('INSERT INTO audit (user_id,user_nama,aksi,modul,detail,created_at) VALUES (?,?,?,?,?,?)')
        .run(null, u.nama, 'RESET PASSWORD', 'pengguna', `Sandi admin sekolah direset oleh Super Admin Pusat`, lib.nowStamp());
      saas.logSaas(u, 'RESET PASSWORD', 'tenant', `${t.nama}: sandi admin ${adm.username || adm.email} direset`, t.id);
      saas.credNoticeSet(parseCookie(req, COOKIE), {
        school: t.nama, kode: t.school_code,
        username: adm.username || adm.email, password: baru
      });
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok', 'Kata sandi admin sekolah berhasil diperbarui.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'err', e.message));
    }
  });

  /* ================= AUDIT LOGS ================= */
  get('/super-admin/audit', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const q = req.query;
    const filter = {
      tenantId: Number(q.get('tenant') || 0) || undefined,
      aksi: String(q.get('aksi') || '').trim() || undefined,
      q: String(q.get('q') || '').trim() || undefined,
      from: String(q.get('from') || '').trim() || undefined,
      to: String(q.get('to') || '').trim() || undefined,
      limit: 200
    };
    const rows = saas.auditRows(filter);
    const tenants = saas.allTenants();
    const actions = saas.auditActions();
    const content = `
    <div class="card mb-3">
      <div class="card-head"><div><h3>Audit Logs Seluruh Sekolah</h3><div class="sub">Login, perubahan data, hapus data, reset password &amp; status billing</div></div></div>
      <form method="get" action="${req.BASE}/super-admin/audit">
        <div class="row3">
          <div class="field"><label>Dari Tanggal</label><input type="date" name="from" value="${esc(filter.from || '')}"></div>
          <div class="field"><label>Sampai Tanggal</label><input type="date" name="to" value="${esc(filter.to || '')}"></div>
          <div class="field"><label>Nama Sekolah</label>
            <select name="tenant"><option value="">Semua sekolah</option>
              ${tenants.map(t => `<option value="${t.id}" ${Number(filter.tenantId) === Number(t.id) ? 'selected' : ''}>${esc(t.nama)} (${esc(t.school_code)})</option>`).join('')}
            </select></div>
        </div>
        <div class="row2">
          <div class="field"><label>Jenis Aktivitas</label>
            <select name="aksi"><option value="">Semua aktivitas</option>
              ${actions.map(a => `<option value="${esc(a.aksi)}" ${filter.aksi === a.aksi ? 'selected' : ''}>${esc(a.aksi)} (${a.c})</option>`).join('')}
            </select></div>
          <div class="field"><label>Pencarian</label><input type="text" name="q" value="${esc(filter.q || '')}" placeholder="nama user / detail / sekolah"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary">${ui.icon('search')}Terapkan Filter</button>
          <a class="btn" href="${req.BASE}/super-admin/audit">Reset</a></div>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>${rows.length} Aktivitas</h3><div class="sub">Urut terbaru</div></div></div>
      <div class="table-wrap" style="max-height:66vh;overflow:auto"><table><thead><tr>
        <th>Waktu</th><th>Sekolah</th><th>User</th><th>Role</th><th>IP</th><th>Aksi</th><th>Detail</th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr>
          <td class="nowrap small">${esc(r.created_at || '')}</td>
          <td class="small">${esc(r.tenant_nama || ('tenant ' + (r.tenant_id || '-')))}</td>
          <td class="small"><b>${esc(r.user_nama || '-')}</b></td>
          <td class="small">${esc(r.role || '-')}</td>
          <td class="mono small">${esc(r.ip || '-')}</td>
          <td>${ui.badge(r.aksi || '-', /HAPUS|TOLAK|SUSPEND|DITOLAK/.test(r.aksi || '') ? 'red' : /LOGIN|TAMBAH|DOWNLOAD/.test(r.aksi || '') ? 'green' : 'gray')}</td>
          <td class="small">${esc((r.detail || '').slice(0, 120))}</td></tr>`).join('')
        : `<tr><td colspan="7" class="muted" style="text-align:center;padding:18px">Belum ada aktivitas pada filter ini.</td></tr>`}
      </tbody></table></div>
    </div>`;
    res.html(shell(req, { title: 'Audit Logs', sub: 'Jejak aktivitas seluruh sekolah', active: '/super-admin/audit', content, user: u }));
  });

  /* ================= PENGUMUMAN GLOBAL & MAINTENANCE ================= */
  get('/super-admin/pengumuman', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const rows = saas.announcementRows();
    const m = saas.maintenance();
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Buat / Sunting Pengumuman</h3>
          <div class="sub">Tampil real-time di dashboard seluruh sekolah</div></div></div>
        <form method="post" action="${req.BASE}/super-admin/pengumuman/simpan">
          <div class="row2">
            <div class="field"><label>Judul Pengumuman *</label><input type="text" name="judul" required maxlength="140" placeholder="Contoh: Pemeliharaan server Sabtu malam"></div>
            <div class="field"><label>Opsi Tampilan</label>
              <select name="tipe">
                <option value="banner">Banner Top Bar (bilah di atas navigasi)</option>
                <option value="popup">Pop-up Modal saat login</option>
              </select></div>
          </div>
          <div class="field"><label>Isi Pengumuman</label>
            <textarea name="isi" rows="4" placeholder="Tuliskan informasi untuk seluruh sekolah…"></textarea></div>
          <div class="row3">
            <div class="field"><label>Warna</label><select name="warna">
              <option value="info">Biru (informasi)</option><option value="ok">Hijau (baik)</option>
              <option value="warn">Kuning (peringatan)</option><option value="err">Merah (penting)</option></select></div>
            <div class="field"><label>Mulai (opsional)</label><input type="date" name="mulai"></div>
            <div class="field"><label>Selesai (opsional)</label><input type="date" name="selesai"></div>
          </div>
          <label class="check mb-2"><input type="checkbox" name="aktif" value="1" checked> Aktifkan sekarang</label>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Pengumuman</button></div>
        </form>
        <div class="table-wrap mt-3"><table><thead><tr><th>Judul</th><th>Tipe</th><th>Warna</th><th>Periode</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.length ? rows.map(a => `<tr>
            <td><b>${esc(a.judul)}</b><div class="t-sub">${esc((a.isi || '').slice(0, 80))}</div></td>
            <td>${a.tipe === 'popup' ? 'Pop-up' : 'Banner'}</td>
            <td>${ui.badge(a.warna, a.warna === 'err' ? 'red' : a.warna === 'warn' ? 'amber' : a.warna === 'ok' ? 'green' : 'blue')}</td>
            <td class="small">${esc(a.mulai || '-')} → ${esc(a.selesai || '-')}</td>
            <td>${a.aktif ? ui.badge('Aktif', 'green') : ui.badge('Nonaktif', 'gray')}</td>
            <td class="nowrap">
              <form method="post" action="${req.BASE}/super-admin/pengumuman/${a.id}/toggle" style="display:inline">
                <button class="btn btn-sm">${a.aktif ? 'Nonaktifkan' : 'Aktifkan'}</button></form>
              <form method="post" action="${req.BASE}/super-admin/pengumuman/${a.id}/hapus" style="display:inline" data-confirm="Hapus pengumuman ini?">
                <button class="btn btn-sm btn-danger">${ui.icon('trash')}</button></form>
            </td></tr>`).join('')
        : `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">Belum ada pengumuman.</td></tr>`}
        </tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Mode Perbaikan (Maintenance)</h3>
          <div class="sub">Blokir sementara seluruh akses sekolah</div></div>
          ${m.aktif ? ui.badge('AKTIF', 'red') : ui.badge('Normal', 'green')}</div>
        <div class="alert ${m.aktif ? 'warn' : 'info'}">${ui.icon(m.aktif ? 'alert' : 'info')}<div>
          ${m.aktif
        ? `Mode perbaikan <b>sedang aktif</b>. Seluruh admin/staf sekolah dialihkan ke halaman "Sistem Dalam Perbaikan".
             Portal Super Admin tetap dapat diakses normal.`
        : `Saat diaktifkan, seluruh pengguna sekolah akan melihat halaman "Sistem Dalam Perbaikan";
             portal Super Admin tetap normal.`}</div></div>
        <form method="post" action="${req.BASE}/super-admin/maintenance">
          <div class="field"><label>Pesan Pemberitahuan Resmi</label>
            <textarea name="pesan" rows="3" placeholder="Contoh: Pemeliharaan rutin, layanan kembali pukul 22:00 WIB.">${esc(m.pesan)}</textarea></div>
          <div class="field"><label>Perkiraan Selesai (teks bebas)</label>
            <input type="text" name="selesai" value="${esc(m.selesai)}" placeholder="Sabtu, 8 Nov 2026 pukul 22:00 WIB"></div>
          ${m.aktif
        ? `<input type="hidden" name="aktif" value="0"><button class="btn btn-primary btn-block">${ui.icon('check')}Matikan Maintenance</button>`
        : `<input type="hidden" name="aktif" value="1"><button class="btn btn-danger btn-block" data-confirm="Aktifkan mode perbaikan? Semua akses sekolah akan diblokir sementara.">${ui.icon('lock')}Aktifkan Maintenance</button>`}
        </form>
        ${m.mulai ? `<p class="help mt-2">Aktif sejak: ${esc(m.mulai)}</p>` : ''}
      </div>
    </div>`;
    res.html(shell(req, { title: 'Pengumuman & Maintenance', sub: 'Broadcast banner/pop-up dan mode perbaikan', active: '/super-admin/pengumuman', content, user: u }));
  });

  post('/super-admin/pengumuman/simpan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const row = saas.announcementSave({
        judul: req.body.judul, isi: req.body.isi, tipe: req.body.tipe, warna: req.body.warna,
        mulai: req.body.mulai, selesai: req.body.selesai, aktif: req.body.aktif ? 1 : 0, oleh: u.nama
      });
      if (!row) throw new Error('Judul pengumuman wajib diisi.');
      saas.logSaas(u, 'PENGUMUMAN', 'saas', `Pengumuman "${row.judul}" (${row.tipe}) disimpan`);
      res.redirect(req.BASE + flash('/super-admin/pengumuman', 'ok', 'Pengumuman disimpan dan langsung tampil di sekolah.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/pengumuman', 'err', e.message));
    }
  });
  post('/super-admin/pengumuman/:id/toggle', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const a = saas.announcementById(req.params.id);
    if (a) { saas.announcementSave({ ...a, aktif: a.aktif ? 0 : 1, oleh: u.nama }); }
    res.redirect(req.BASE + flash('/super-admin/pengumuman', 'ok', 'Status pengumuman diubah.'));
  });
  post('/super-admin/pengumuman/:id/hapus', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const a = saas.announcementDelete(req.params.id);
    if (a) saas.logSaas(u, 'HAPUS PENGUMUMAN', 'saas', a.judul);
    res.redirect(req.BASE + flash('/super-admin/pengumuman', 'ok', 'Pengumuman dihapus.'));
  });
  post('/super-admin/maintenance', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const on = String(req.body.aktif) === '1';
      const m = saas.setMaintenance(on, req.body.pesan, req.body.selesai, u);
      res.redirect(req.BASE + flash('/super-admin/pengumuman', 'ok',
        m.aktif ? 'Mode perbaikan AKTIF — seluruh akses sekolah diblokir sementara.' : 'Mode perbaikan dimatikan; sekolah dapat mengakses aplikasi kembali.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/pengumuman', 'err', e.message));
    }
  });

  /* ================= PUSAT TIKET KENDALA ================= */
  get('/super-admin/tiket', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const status = String(req.query.get('status') || '').trim();
    const q = String(req.query.get('q') || '').trim();
    const rows = saas.ticketsAll({ status: status || undefined, q: q || undefined });
    const pick = Number(req.query.get('id') || 0);
    const detail = pick ? saas.ticketById(pick) : (rows[0] || null);
    const msgs = detail ? saas.ticketMessages(detail.id) : [];
    const badge = st => st === 'resolved' ? ui.badge('Resolved', 'green') : st === 'in_progress' ? ui.badge('In Progress', 'blue') : ui.badge('Open', 'amber');
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Pusat Tiket Kendala</h3><div class="sub">${rows.length} tiket dari seluruh sekolah</div></div></div>
        <form method="get" action="${req.BASE}/super-admin/tiket" class="filterbar">
          <div class="field"><label>Status</label><select name="status" data-autosubmit>
            <option value="">Semua status</option>
            ${Object.entries(saas.TICKET_STATUS).map(([k, v]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select></div>
          <input type="text" name="q" value="${esc(q)}" placeholder="cari sekolah / judul / kode">
          <button class="btn">${ui.icon('search')}Cari</button>
        </form>
        <div class="table-wrap" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Kode</th><th>Sekolah</th><th>Judul</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.length ? rows.map(t => `<tr>
            <td class="mono small">${esc(t.kode || '-')}</td>
            <td class="small">${esc(t.sekolah_nama)}<div class="t-sub">${esc(t.school_code)}</div></td>
            <td><b>${esc(t.judul)}</b><div class="t-sub">${esc(t.kategori || '')} · ${esc(t.created_at || '')}</div></td>
            <td>${badge(t.status)}</td>
            <td><a class="btn btn-sm ${detail && detail.id === t.id ? 'btn-primary' : ''}" href="${req.BASE}/super-admin/tiket?id=${t.id}&status=${encodeURIComponent(status)}">Buka</a></td>
          </tr>`).join('') : `<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">Tidak ada tiket.</td></tr>`}
        </tbody></table></div>
      </div>
      <div class="card">
        ${detail ? `
          <div class="card-head"><div><h3>${esc(detail.kode)} · ${esc(detail.judul)}</h3>
            <div class="sub">${esc(detail.kategori)} · ${esc(detail.dibuat_oleh || '-')} · ${esc(detail.created_at || '')}</div></div>
            ${badge(detail.status)}</div>
          <div class="alert info">${ui.icon('info')}<div>${esc(detail.deskripsi || '').replace(/\n/g, '<br>')}</div></div>
          ${detail.bukti_url ? `<p class="small"><b>Bukti:</b> <button type="button" class="btn btn-sm" data-proof="${esc(detail.bukti_url)}">Lihat screenshot</button></p>` : ''}
          <div class="ticket-thread">
            ${msgs.map(m => `<div class="tk-msg ${m.dari === 'admin' ? 'admin' : 'tenant'}">
              <div class="tk-head"><b>${esc(m.nama || '-')}</b><span class="t-sub">${m.dari === 'admin' ? 'Super Admin' : 'Sekolah'} · ${esc(m.created_at || '')}</span></div>
              <div class="tk-body">${esc(m.pesan || '').replace(/\n/g, '<br>')}</div>
              ${m.lampiran_url ? `<a class="tk-attach" href="${esc(m.lampiran_url)}" target="_blank" rel="noopener">${ui.icon('file')}Lampiran</a>` : ''}
            </div>`).join('') || '<div class="muted small">Belum ada balasan.</div>'}
          </div>
          <form method="post" action="${req.BASE}/super-admin/tiket/${detail.id}/balas" class="mt-2">
            <input type="hidden" name="lampiran_b64" id="lampiranAdmin">
            <div class="field"><label>Balasan Super Admin</label><textarea name="pesan" rows="3" placeholder="Tuliskan solusi / instruksi…"></textarea></div>
            <div class="field"><label>Screenshot Jawaban (opsional)</label>
              <input type="file" accept="image/*" data-b64="lampiranAdmin" data-max="5">
              <div class="hint" id="lampiranAdmin-info">PNG/JPG maks 5 MB.</div></div>
            <div class="form-actions"><button class="btn btn-primary">${ui.icon('send')}Kirim Balasan</button></div>
          </form>
          <form method="post" action="${req.BASE}/super-admin/tiket/${detail.id}/status" class="flex mt-2" style="gap:8px;align-items:flex-end">
            <div class="field" style="margin:0"><label>Ubah Status</label>
              <select name="status">${Object.entries(saas.TICKET_STATUS).map(([k, v]) => `<option value="${k}" ${detail.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <button class="btn">${ui.icon('check')}Simpan Status</button>
          </form>`
        : `<div class="muted" style="padding:30px;text-align:center">Pilih tiket pada tabel untuk melihat percakapan.</div>`}
      </div>
    </div>`;
    res.html(shell(req, { title: 'Pusat Tiket Kendala', sub: 'Helpdesk seluruh sekolah', active: '/super-admin/tiket', content, user: u }));
  });

  post('/super-admin/tiket/:id/balas', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      let lamp = '';
      if (req.body.lampiran_b64) lamp = await uploadMedia(req.body.lampiran_b64, 'tiket-admin-' + Date.now() + '.jpg', { jenis: 'tiket', tenantId: 1 });
      const t = saas.ticketMessageAdd(req.params.id, { dari: 'admin', nama: u.nama + ' (Super Admin)', pesan: req.body.pesan, lampiran_url: lamp });
      saas.logSaas(u, 'BALAS TIKET', 'tiket', `${t.kode} · ${t.sekolah_nama || ''}`);
      res.redirect(req.BASE + flash('/super-admin/tiket?id=' + req.params.id, 'ok', 'Balasan terkirim ke sekolah.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/tiket?id=' + req.params.id, 'err', e.message));
    }
  });
  post('/super-admin/tiket/:id/status', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      saas.ticketStatus(req.params.id, req.body.status, u);
      res.redirect(req.BASE + flash('/super-admin/tiket?id=' + req.params.id, 'ok', 'Status tiket diperbarui.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/tiket?id=' + req.params.id, 'err', e.message));
    }
  });

  /* ================= WA GATEWAY PUSAT ================= */
  get('/super-admin/wa', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const cfg = saas.waConfig();
    const logs = S.prepare("SELECT * FROM saas_audit WHERE modul='wa' ORDER BY id DESC LIMIT 12").all();
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Pengaturan WA Gateway</h3><div class="sub">Dipakai untuk pengingat H-7 &amp; notifikasi pembayaran</div></div>
          ${cfg.aktif ? ui.badge('Aktif', 'green') : ui.badge('Nonaktif', 'gray')}</div>
        <div class="alert info">${ui.icon('info')}<div>Kompatibel dengan gateway populer (Fonnte, Wablas, Watzap, dsb).
          Mode <b>form</b> mengirim <code>target</code> + <code>message</code> (x-www-form-urlencoded);
          mode <b>json</b> mengirim <code>{target, phone, message, sender}</code>.</div></div>
        <form method="post" action="${req.BASE}/super-admin/wa/simpan">
          <div class="field"><label>Endpoint URL</label><input type="text" name="wa_api_url" value="${esc(cfg.url)}" placeholder="https://api.fonnte.com/send"></div>
          <div class="row2">
            <div class="field"><label>API Key / Token</label><input type="text" name="wa_api_token" value="${esc(cfg.token)}" autocomplete="off" placeholder="token gateway"></div>
            <div class="field"><label>Nomor WhatsApp Pengirim</label><input type="text" name="wa_sender" value="${esc(cfg.sender)}" placeholder="628123456789"></div>
          </div>
          <div class="row2">
            <div class="field"><label>Format Payload</label><select name="wa_payload">
              <option value="form" ${cfg.payload === 'form' ? 'selected' : ''}>Form (target + message)</option>
              <option value="json" ${cfg.payload === 'json' ? 'selected' : ''}>JSON ({target, message})</option>
            </select></div>
            <div class="field"><label>Status</label>
              <label class="check" style="margin-top:6px"><input type="checkbox" name="wa_aktif" value="1" ${cfg.aktif ? 'checked' : ''}> Aktifkan pengiriman otomatis</label></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Pengaturan</button></div>
        </form>
        <form method="post" action="${req.BASE}/super-admin/wa/uji" class="mt-2">
          <div class="row2">
            <div class="field"><label>Nomor Uji</label><input type="text" name="nomor" placeholder="08xxxxxxxxxx"></div>
            <div class="field" style="display:flex;align-items:flex-end"><button class="btn btn-block">${ui.icon('send')}Uji Kirim WA</button></div>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Notifikasi Otomatis</h3><div class="sub">Dijalankan lewat queue saat cron harian</div></div></div>
        <div class="list">
          <div class="list-row"><div><div class="mt">Pengingat perpanjangan H-7</div>
            <div class="nm">Dikirim otomatis ke nomor admin sekolah 7 hari sebelum masa aktif berakhir.</div></div></div>
          <div class="list-row"><div><div class="mt">Persetujuan / penolakan pembayaran</div>
            <div class="nm">Dikirim saat Super Admin menyetujui atau menolak pengajuan perpanjangan.</div></div></div>
        </div>
        <div class="table-wrap short mt-2"><table><thead><tr><th>Waktu</th><th>Sekolah</th><th>Hasil</th></tr></thead><tbody>
          ${logs.length ? logs.map(l => `<tr><td class="nowrap small">${esc(l.created_at || '')}</td>
            <td class="small">${esc(l.detail || '')}</td>
            <td>${ui.badge(l.aksi, /GAGAL/.test(l.aksi) ? 'red' : 'green')}</td></tr>`).join('')
        : `<tr><td colspan="3" class="muted" style="text-align:center;padding:14px">Belum ada pengiriman.</td></tr>`}
        </tbody></table></div>
      </div>
    </div>`;
    res.html(shell(req, { title: 'WA Gateway', sub: 'Notifikasi otomatis ke admin sekolah', active: '/super-admin/wa', content, user: u }));
  });

  post('/super-admin/wa/simpan', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const b = req.body || {};
      const aktif = b.wa_aktif ? '1' : '0';
      if (aktif === '1' && !String(b.wa_api_url || '').trim()) throw new Error('Endpoint URL wajib diisi bila WA diaktifkan.');
      saas.set('wa_api_url', String(b.wa_api_url || '').trim());
      saas.set('wa_api_token', String(b.wa_api_token || '').trim());
      saas.set('wa_sender', String(b.wa_sender || '').trim());
      saas.set('wa_payload', b.wa_payload === 'json' ? 'json' : 'form');
      saas.set('wa_aktif', aktif);
      saas.logSaas(u, 'EDIT WA', 'wa', 'Memperbarui kredensial WA Gateway');
      res.redirect(req.BASE + flash('/super-admin/wa', 'ok', 'Pengaturan WA Gateway disimpan.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/wa', 'err', e.message));
    }
  });

  post('/super-admin/wa/uji', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      const nomor = String(req.body.nomor || '').trim();
      if (!nomor) throw new Error('Nomor uji wajib diisi.');
      const r = await saas.sendWA(nomor, `Uji koneksi WA Gateway ${saas.appName()}\nWaktu: ${lib.nowStamp()}`);
      if (!r.ok && !r.demo) throw new Error(r.reason || 'Gagal mengirim.');
      res.redirect(req.BASE + flash('/super-admin/wa', r.ok ? 'ok' : 'err',
        r.ok ? `Pesan uji terkirim ke ${r.target || nomor}.` : ('Gateway belum aktif: ' + (r.reason || '-'))));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/wa', 'err', 'Uji gagal: ' + e.message));
    }
  });

  /* ================= MASTER PETUNJUK PENGGUNA ================= */
  get('/super-admin/petunjuk', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const editId = Number(req.query.get('edit') || 0);
    const ed = editId ? saas.guideById(editId) : null;
    const rows = saas.guideRows({});
    const content = `
    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>${ed ? 'Sunting Petunjuk' : 'Tambah Petunjuk Pengguna'}</h3>
          <div class="sub">Materi ini otomatis tampil di menu Petunjuk Pengguna SELURUH sekolah</div></div>
          ${ed ? `<a class="btn btn-sm" href="${req.BASE}/super-admin/petunjuk">${ui.icon('x')}Batal</a>` : ''}</div>
        <form method="post" action="${req.BASE}/super-admin/petunjuk/simpan">
          <input type="hidden" name="id" value="${ed ? ed.id : ''}">
          <input type="hidden" name="thumbnail_b64" id="gThumbB64">
          <div class="row2">
            <div class="field"><label>Judul Panduan *</label><input type="text" name="judul" required value="${esc(ed ? ed.judul : '')}" placeholder="Cara mencatat pembayaran iuran"></div>
            <div class="field"><label>Kategori</label><input type="text" name="kategori" value="${esc(ed ? (ed.kategori || '') : '')}" placeholder="Iuran &amp; SPP"></div>
          </div>
          <div class="field"><label>Ringkasan Singkat</label>
            <textarea name="ringkas" rows="2" placeholder="1–2 kalimat ringkas">${esc(ed ? (ed.ringkas || '') : '')}</textarea></div>
          <div class="field"><label>Isi Panduan (Markdown / teks kaya)</label>
            <textarea name="konten" id="fGuideBody" rows="12" placeholder="# Langkah 1&#10;1. Buka menu Iuran&#10;2. Klik Bayar&#10;&#10;**Catatan:** …">${esc(ed ? (ed.konten || '') : '')}</textarea>
            <div class="hint">Dukungan: <code>#</code> judul, <code>-</code> daftar, <code>**tebal**</code>, <code>kode</code>.</div></div>
          <div class="row2">
            <div class="field"><label>URL Thumbnail / Gambar Pratayang (opsional)</label>
              <input type="text" name="thumbnail_url" value="${esc(ed ? (ed.thumbnail_url || '') : '')}" placeholder="https://…/gambar-panduan.jpg">
              <div class="hint">Rasio disarankan <b>16:9</b>. Bila kosong, kartu memakai gambar dari video YouTube (atau ikon bawaan).</div></div>
            <div class="field"><label>Unggah Thumbnail (PNG/JPG/WebP, maks 5 MB)</label>
              <input type="file" accept="image/*" data-b64="gThumbB64" data-max="5">
              <div class="hint" id="gThumbB64-info">${ed && ed.thumbnail_url ? 'Thumbnail saat ini: ' + esc(ed.thumbnail_url) : 'Kosongkan bila tidak ingin mengunggah.'}</div></div>
          </div>
          <div class="row3">
            <div class="field"><label>Video YouTube (opsional)</label><input type="text" name="video_url" value="${esc(ed ? (ed.video_url || '') : '')}" placeholder="https://youtu.be/…"></div>
            <div class="field"><label>Lampiran / PDF (opsional)</label><input type="text" name="lampiran_url" value="${esc(ed ? (ed.lampiran_url || '') : '')}" placeholder="https://…/panduan.pdf"></div>
            <div class="field"><label>Urutan</label><input type="number" name="urutan" value="${ed ? Number(ed.urutan || 0) : rows.length + 1}" min="0"></div>
          </div>
          <label class="check mb-2"><input type="checkbox" name="published" value="1" ${!ed || ed.published ? 'checked' : ''}> Terbitkan (tampil di sekolah)</label>
          <div class="alert info mb-2">${ui.icon('info')}<div>Video &amp; PDF dibuka <b>langsung di dalam aplikasi</b> (modal viewer) pada halaman Petunjuk Pengguna sekolah — pengguna tidak perlu membuka tab baru.</div></div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}${ed ? 'Simpan Perubahan' : 'Tambah Panduan'}</button></div>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Daftar Petunjuk (${rows.length})</h3><div class="sub">Sinkron otomatis ke semua sekolah</div></div></div>
        <div class="table-wrap" style="max-height:64vh;overflow:auto"><table><thead><tr><th>#</th><th>Thumb</th><th>Judul</th><th>Kategori</th><th>Media</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.length ? rows.map(g => `<tr>
            <td class="num">${g.urutan || '-'}</td>
            <td>${(g.thumbnail_url || '').trim() ? `<img src="${esc(g.thumbnail_url)}" alt="Thumb" width="72" height="41" loading="lazy" decoding="async" style="width:72px;height:41px;object-fit:cover;border-radius:6px;border:1px solid var(--line)">` : '<span class="t-sub">—</span>'}</td>
            <td><b>${esc(g.judul)}</b><div class="t-sub">${esc((g.ringkas || '').slice(0, 70))}</div></td>
            <td class="small">${esc(g.kategori || '-')}</td>
            <td class="small nowrap">${g.video_url ? ui.badge('Video', 'red', 'plain') : ''}${(g.lampiran_url || '').trim() ? ' ' + ui.badge(/\.pdf(\?|#|$)/i.test(g.lampiran_url) ? 'PDF' : 'Lampiran', 'amber', 'plain') : ''}${!g.video_url && !(g.lampiran_url || '').trim() ? '<span class="t-sub">—</span>' : ''}</td>
            <td>${g.published ? ui.badge('Terbit', 'green') : ui.badge('Draf', 'gray')}</td>
            <td class="nowrap">
              <a class="btn btn-sm" href="${req.BASE}/super-admin/petunjuk?edit=${g.id}">${ui.icon('edit')}</a>
              <form method="post" action="${req.BASE}/super-admin/petunjuk/${g.id}/hapus" style="display:inline" data-confirm="Hapus panduan ini dari semua sekolah?">
                <button class="btn btn-sm btn-danger">${ui.icon('trash')}</button></form>
            </td></tr>`).join('')
        : `<tr><td colspan="7" class="muted" style="text-align:center;padding:16px">Belum ada panduan.</td></tr>`}
        </tbody></table></div>
        <div class="alert info mt-2">${ui.icon('info')}<div>Akun sekolah hanya dapat <b>membaca</b> panduan; seluruh upaya tambah/ubah/hapus dari sisi sekolah ditolak (403).</div></div>
      </div>
    </div>`;
    res.html(shell(req, { title: 'Master Petunjuk Pengguna', sub: 'Sumber tunggal materi panduan seluruh sekolah', active: '/super-admin/petunjuk', content, user: u }));
  });

  post('/super-admin/petunjuk/simpan', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      let thumbnail = String(req.body.thumbnail_url || '').trim();
      if (req.body.thumbnail_b64) {
        thumbnail = await uploadMedia(req.body.thumbnail_b64, 'panduan-thumb-' + Date.now() + '.webp',
          { jenis: 'panduan', tenantId: 1 });
      }
      const row = saas.guideSave({
        id: req.body.id, judul: req.body.judul, kategori: req.body.kategori, ringkas: req.body.ringkas,
        konten: req.body.konten, video_url: req.body.video_url, lampiran_url: req.body.lampiran_url,
        thumbnail_url: thumbnail,
        urutan: req.body.urutan, published: req.body.published ? 1 : 0, oleh: u.nama
      });
      if (!row) throw new Error('Judul panduan wajib diisi.');
      saas.logSaas(u, req.body.id ? 'EDIT PANDUAN' : 'TAMBAH PANDUAN', 'panduan', row.judul);
      res.redirect(req.BASE + flash('/super-admin/petunjuk', 'ok', 'Panduan disimpan & langsung tampil di seluruh sekolah.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/petunjuk', 'err', e.message));
    }
  });
  post('/super-admin/petunjuk/:id/hapus', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const g = saas.guideDelete(req.params.id);
    if (g) saas.logSaas(u, 'HAPUS PANDUAN', 'panduan', g.judul);
    res.redirect(req.BASE + flash('/super-admin/petunjuk', 'ok', 'Panduan dihapus dari seluruh sekolah.'));
  });

  /* ================= PORTAL SLUG & CUSTOM DOMAIN (dari daftar sekolah) ================= */
  post('/super-admin/sekolah/:id/portal', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const t = saas.tenantById(req.params.id);
    if (!t) return res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', 'Sekolah tidak ditemukan.'));
    try {
      if (req.body.portal_slug !== undefined && String(req.body.portal_slug).trim() !== '') {
        saas.setPortalSlug(t.id, String(req.body.portal_slug).trim(), u);
      }
      if (req.body.custom_domain !== undefined) {
        const dom = String(req.body.custom_domain || '').trim();
        if (!dom) saas.setCustomDomain(t.id, '', u);
        else saas.setCustomDomain(t.id, dom, u, 'pending');
      }
      if (typeof refreshPortalMap === 'function') refreshPortalMap();
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok', 'Alamat portal / domain sekolah diperbarui.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'err', e.message));
    }
  });

  post('/super-admin/sekolah/:id/domain/verifikasi', async (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    const t = saas.tenantById(req.params.id);
    if (!t) return res.redirect(req.BASE + flash('/super-admin/sekolah', 'err', 'Sekolah tidak ditemukan.'));
    try {
      if (!t.custom_domain) throw new Error('Sekolah ini belum mengajukan domain khusus.');
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const chk = await saas.checkDns(t.custom_domain, { host, ip: saas.serverIp() });
      if (!chk.ok) {
        saas.setCustomDomain(t.id, t.custom_domain, u, 'failed');
        throw new Error('DNS belum mengarah dengan benar: ' + chk.note);
      }
      saas.setCustomDomain(t.id, t.custom_domain, u, 'verified');
      const hostNote = chk.hostMatch ? ' Host domain cocok.' : ` Permintaan lewat host ${host || '-'} — aktif setelah DNS mengarah.`;
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'ok', `Domain ${t.custom_domain} terverifikasi & aktif (${chk.note}).${hostNote}`));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + t.id, 'err', e.message));
    }
  });

  post('/super-admin/sekolah/:id/domain/hapus', (req, res) => {
    const u = requireAdmin(req, res); if (!u) return;
    try {
      saas.setCustomDomain(req.params.id, '', u);
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'ok', 'Domain khusus dilepas dari sekolah.'));
    } catch (e) {
      res.redirect(req.BASE + flash('/super-admin/sekolah/' + req.params.id, 'err', e.message));
    }
  });

};
