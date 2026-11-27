'use strict';

module.exports = ({ get, post, dbm, lib, ui, page, ctx, guard, can, setSession, COOKIE, roleLabel, permissionMatrix, renderError, uploadMedia, saas }) => {
  const { db } = dbm;
  const secureCookie = req => String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : ''))
    .split(',')[0].trim().toLowerCase() === 'https' ? '; Secure' : '';

  function authShell({ base, content, sideTitle, sideDesc }) {
    // branding halaman login = branding layanan (bukan milik satu sekolah)
    const appName = saas ? saas.appName() : 'SIMKOLA';
    const appLogo = saas ? saas.appLogo() : '';
    const tema = saas ? saas.tema() : '#F97316';
    return `<!DOCTYPE html><html lang="id"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${lib.esc(appName)}</title>
${ui.fontLinks()}
${ui.logoPreconnect([appLogo])}
${appLogo ? `<link rel="preload" as="image" href="${lib.esc(appLogo)}" fetchpriority="high">` : ''}
<link rel="stylesheet" href="${base}/assets/app.css?v=${ui.ASSET_V}">
${ui.themeCss(tema)}
<link rel="icon" type="image/png" href="${base}/favicon.ico">
<link rel="apple-touch-icon" href="${base}/favicon.ico">
<meta name="theme-color" content="${lib.esc(tema)}">
</head><body>
<div class="auth-wrap">
  <aside class="auth-aside">
    <div class="inner">
      <div class="flex" style="gap:12px">
        <div style="width:46px;height:46px;border-radius:14px;overflow:hidden;background:rgba(255,255,255,.2);display:grid;place-items:center;border:1px solid rgba(255,255,255,.3)">${appLogo ? `<img src="${lib.esc(appLogo)}" alt="Logo" width="46" height="46" fetchpriority="high" decoding="async" style="width:100%;height:100%;object-fit:contain">` : ui.icon('wallet')}</div>
        <div>
          <div style="font-weight:800;font-size:17px;letter-spacing:-.02em">${lib.esc(appName)}</div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.16em;opacity:.8">Sistem Informasi Keuangan</div>
        </div>
      </div>
      <h1>${sideTitle}</h1>
      <p>${sideDesc}</p>
      <div class="auth-feats">
        <div class="auth-feat"><div class="fi">${ui.icon('book')}</div><div><b>BKU & Buku Pembantu</b><br><span style="opacity:.82">Umum, bank, pajak, tunai & 11 BKU kegiatan khusus.</span></div></div>
        <div class="auth-feat"><div class="fi">${ui.icon('shield')}</div><div><b>RBAC & Audit Trail</b><br><span style="opacity:.82">Hak akses per role, approval pengeluaran besar, log aktivitas.</span></div></div>
        <div class="auth-feat"><div class="fi">${ui.icon('file')}</div><div><b>Laporan Siap Cetak</b><br><span style="opacity:.82">BKU, rekonsiliasi kas, LRA, piutang & SPP — PDF dan Excel.</span></div></div>
      </div>
    </div>
  </aside>
  <main class="auth-main"><div class="auth-card">${content}</div></main>
</div>
<script src="${base}/assets/app.js?v=${ui.ASSET_V}" defer></script>
</body></html>`;
  }

  /* ---------------- LOGIN MULTI-TENANT: Kode Sekolah + Username + Password ---------------- */
  get('/login', (req, res) => {
    const base = req.BASE;
    const q = req.query;
    const err = q.get('err'), ok = q.get('ok');
    const kode = String(q.get('kode') || '').toUpperCase().slice(0, 4);
    const appName = saas.appName();
    // portal login UTAMA selalu memakai branding DEFAULT sistem (diatur Super Admin),
    // bukan logo sekolah — logo sekolah hanya tampil setelah masuk ke sekolahnya.
    const sysLogo = saas.appLogo();
    res.html(authShell({
      base,
      sideTitle: 'Kelola keuangan sekolah dengan rapi, aman, dan transparan.',
      sideDesc: 'Satu tempat untuk transaksi harian, anggaran, piutang, sampai pelaporan pertanggungjawaban dana sekolah.',
      content: `
      <div class="auth-login-head">
        ${sysLogo ? `<img src="${lib.esc(sysLogo)}" alt="Logo" class="auth-logo-img" width="96" height="96" fetchpriority="high" decoding="async">` : `<div class="auth-logo-ph">${ui.icon('school')}</div>`}
        <div class="auth-welcome">Selamat datang di ${lib.esc(appName)}</div>
        <div class="small muted">Sistem Informasi Manajemen Keuangan Sekolah</div>
      </div>
      ${err ? `<div class="alert err">${ui.icon('alert')}<div>${lib.esc(err)}</div></div>` : ''}
      ${ok ? `<div class="alert ok">${ui.icon('check')}<div>${lib.esc(ok)}</div></div>` : ''}
      <h2>Masuk ke Akun Sekolah</h2>
      <p class="muted small" style="margin-bottom:22px">Masukkan <b>Kode Sekolah</b> 4 karakter yang Anda terima saat pendaftaran.</p>
      <form method="post" action="${base}/login">
        <div class="field"><label>Kode Sekolah</label>
          <input type="text" name="kode" required maxlength="4" value="${lib.esc(kode)}" placeholder="SK01"
            style="text-transform:uppercase;letter-spacing:.28em;font-weight:700" autocomplete="organization"></div>
        <div class="field"><label>Username / Email</label><input type="text" name="email" required placeholder="admin@sekolah.sch.id" autocomplete="username"></div>
        <div class="field"><label>Password</label>
          <div class="password-control"><input type="password" name="password" required placeholder="••••••••" autocomplete="current-password" id="loginPassword">
            <button type="button" class="password-eye" data-password-toggle aria-label="Lihat kata sandi" aria-pressed="false">${ui.icon('eye')}</button></div>
        </div>
        <button class="btn btn-primary btn-block" type="submit" style="margin-top:6px">Masuk</button>
      </form>
      <div style="margin-top:18px;text-align:center"><span class="small muted">Belum punya akun sekolah?</span>
        <a class="btn btn-primary btn-sm" href="${base}/register" style="margin:8px auto 0">Daftarkan Sekolah Anda</a></div>`
    }));
  });

  post('/login', async (req, res) => {
    const base = req.BASE;
    const kode = String(req.body.kode || '').trim().toUpperCase();
    const ident = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const fail = msg => res.redirect(base + '/login?err=' + encodeURIComponent(msg) + (kode ? '&kode=' + encodeURIComponent(kode) : ''));
    const identity = 'school:' + ident.toLowerCase();
    if (await saas.authIsLimited(identity)) return fail('Terlalu banyak percobaan masuk. Silakan coba kembali dalam 15 menit.');
    // Kompatibilitas: tautan/ bookmark lama tanpa kode sekolah tetap dilayani
    // oleh sekolah pertama (SK01). Bila kode diisi, isolasi tetap ketat per sekolah.
    const tenant = kode ? await saas.tenantByCode(kode) : await saas.tenantById(1);
    if (!tenant) {
      await saas.authRecord(identity, false);
      return fail(kode ? ('Kode sekolah "' + kode + '" tidak ditemukan. Periksa kembali kode dari admin sekolah Anda.') : 'Kode sekolah wajib diisi (4 karakter).');
    }
    const conn = dbm.openTenantConn(tenant.id, tenant.db_file);
    const u = await conn.prepare("SELECT * FROM users WHERE lower(email)=lower(?) OR lower(COALESCE(username,''))=lower(?) ORDER BY id LIMIT 1").get(ident, ident);
    if (!u || !lib.verifyPassword(password, u.password)) {
      await saas.authRecord(identity, false);
      return fail('Username atau password salah' + (kode ? ' untuk sekolah ' + kode : '') + '.');
    }
    if (!u.aktif) {
      await saas.authRecord(identity, false);
      return fail('Akun Anda dinonaktifkan. Hubungi admin sekolah.');
    }
    await saas.authRecord(identity, true);
    // hitung draf pengeluaran baru di database sekolah tersebut
    const alert = await dbm.runAsTenant(tenant, async () => {
      const pendingRow = await db.prepare(`SELECT COUNT(*) c FROM transaksi t JOIN bku b ON b.id=t.bku_id
        WHERE t.status='pending' AND ${dbm.bkuTransactionVisibleSql('t', 'b')}`).get();
      return pendingRow ? pendingRow.c : 0;
    });
    const t = await setSession(u.id, tenant.id, alert);
    await dbm.runAsTenant(tenant, () => dbm.logAudit(u, 'LOGIN', 'auth', `${u.nama} masuk ke aplikasi (${tenant.nama})`));
    res.set('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secureCookie(req)}`);
    res.redirect(base + '/');
  });

  /* ---------------- PENDAFTARAN MANDIRI SEKOLAH BARU ---------------- */
  function trialPackage() {
    const packages = saas.packageRows();
    const available = packages.filter(p => saas.packageSelfTrial(p) && saas.packageTrialDays(p) > 0);
    const preferred = saas.defaultPackage();
    return available.find(p => p.kode === preferred.kode) || available[0] || null;
  }

  function phoneAlreadyRegistered(raw) {
    const phone = lib.normPhone(raw);
    if (!phone) return false;
    return saas.allTenants().some(t => {
      if (lib.normPhone(t.contact_telp) === phone) return true;
      const conn = dbm.openTenantConn(t.id, t.db_file);
      const schoolPhone = conn.prepare("SELECT v FROM settings WHERE k='sekolah_telp'").get();
      return lib.normPhone(schoolPhone && schoolPhone.v) === phone;
    });
  }

  function registerForm(req, res, { err } = {}) {
    const base = req.BASE;
    const q = req.query;
    const v = k => lib.esc(q.get(k) || '');
    /* ---- verifikasi nomor WhatsApp (OTP 4 digit) ---- */
    const otpCfg = (() => { try { return saas.daftarOtpCfg(); } catch (e) { return { aktif: false, menit: 10 }; } })();
    const otpTokenQ = String(q.get('otp') || '').trim();
    const otpCheck = otpCfg.aktif && otpTokenQ
      ? (() => { try { return saas.otpDaftarValid(otpTokenQ, q.get('telp')); } catch (e) { return { ok: false }; } })()
      : { ok: false };
    const otpVerified = !!otpCheck.ok;
    const otpToken = otpVerified ? otpTokenQ : '';
    const trialPkg = trialPackage();
    const cap = saas.captchaConfig();
    const capSite = cap.siteKey;
    let captchaHtml = '';
    if (cap.provider === 'turnstile' && capSite) {
      captchaHtml = `<input type="hidden" name="cf-turnstile-response" id="cfToken">
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        <div class="cf-turnstile" data-sitekey="${lib.esc(capSite)}" data-callback="__capOk" style="margin-bottom:10px"></div>
        <script>function __capOk(t){var e=document.getElementById('cfToken');if(e)e.value=t;}</script>`;
    } else if (cap.provider === 'recaptcha' && capSite) {
      captchaHtml = `<input type="hidden" name="recaptcha_token" id="rcToken">
        <script src="https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(capSite)}"></script>
        <script>
          document.addEventListener('submit', function (ev) {
            var f = ev.target, t = document.getElementById('rcToken');
            if (!f || !f.action || !/register/.test(f.action) || (t && t.value)) return;
            ev.preventDefault();
            grecaptcha.ready(function () {
              grecaptcha.execute(${JSON.stringify(capSite)}, { action: 'register' }).then(function (tok) {
                t.value = tok; f.submit();
              });
            });
          }, true);
        </script>`;
    }
    res.html(authShell({
      base,
      sideTitle: 'Daftarkan sekolah Anda dalam 1 menit.',
      sideDesc: 'Dapatkan kode sekolah 4 karakter, akun admin, dan database keuangan yang terisolasi penuh dari sekolah lain.',
      content: `
      <div class="auth-login-head">
        <div class="auth-logo-ph">${ui.icon('school')}</div>
        <div class="auth-welcome">Pendaftaran Sekolah Baru</div>
      </div>
      ${err ? `<div class="alert err">${ui.icon('alert')}<div>${lib.esc(err)}</div></div>` : ''}
      <form method="post" action="${base}/register">
        <div class="field"><label>Nama Sekolah</label><input type="text" name="nama" value="${v('nama')}" required placeholder="SMK Negeri 1 Contoh"></div>
        <div class="field"><label>Jenjang Pendidikan</label>
          <select name="jenjang">
            ${Object.entries(dbm.JENJANG).map(([k, val]) => `<option value="${lib.esc(k)}" ${v('jenjang') === lib.esc(k) ? 'selected' : ''}>${lib.esc(val.label)}${val.preset.length ? ' — tingkat ' + val.preset.join(', ') : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Alamat Sekolah</label><input type="text" name="alamat" value="${v('alamat')}" required placeholder="Jl. Pendidikan No. 1, Kota"></div>
        <div class="row2">
          <div class="field"><label>Nama Admin</label><input type="text" name="admin_nama" value="${v('admin_nama')}" required placeholder="Nama bendahara/admin"></div>
          <div class="field"><label>Email Admin</label><input type="email" name="admin_email" value="${v('admin_email')}" required placeholder="admin@sekolah.sch.id" data-register-email>
            <div class="hint" data-email-warning hidden></div></div>
        </div>
        <div class="field"><label>Password Admin</label>
          <div class="password-control"><input type="password" name="admin_password" id="registerPassword" required minlength="8"
            pattern="(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}" title="Minimal 8 karakter, dengan huruf besar, angka, dan simbol."
            placeholder="Minimal 8 karakter" autocomplete="new-password" data-register-password>
            <button type="button" class="password-eye" data-password-toggle aria-label="Lihat kata sandi" aria-pressed="false">${ui.icon('eye')}</button></div>
          <ul class="password-rules" aria-live="polite">
            <li data-password-rule="length"><span>${ui.icon('check')}</span>Minimal 8 karakter</li>
            <li data-password-rule="upper"><span>${ui.icon('check')}</span>Memiliki huruf besar</li>
            <li data-password-rule="number"><span>${ui.icon('check')}</span>Memiliki angka</li>
            <li data-password-rule="symbol"><span>${ui.icon('check')}</span>Memiliki simbol</li>
          </ul>
        </div>
        <div class="field"><label>Nomor WhatsApp / Telepon${otpCfg.aktif ? ' <span style="color:var(--red)">*</span>' : ''}</label>
          <div class="otp-row">
            <input type="text" name="telp" id="fDaftarTelp" value="${v('telp') || '+62'}" ${otpCfg.aktif ? 'required' : ''}
              inputmode="numeric" autocomplete="tel" maxlength="18" pattern="\\+62[0-9]{7,15}" placeholder="+628xxxxxxxxxx">
            ${otpCfg.aktif ? `<button type="button" class="btn" id="btnOtpKirim" data-otp-kirim>${ui.icon('send')}Kirim Kode OTP</button>` : ''}
          </div>
        </div>
        ${otpCfg.aktif ? `<div class="otp-box${otpVerified ? ' verified' : ''}" id="otpBox" data-otp-box ${otpVerified ? '' : 'hidden'}>
          <div class="otp-head">${ui.icon('shield')}<div><b>Verifikasi Nomor WhatsApp</b>
            <div class="small muted">Masukkan <b>4 digit kode OTP</b> yang dikirim ke WhatsApp Anda sebelum mendaftar.</div></div></div>
          <div class="otp-digits">
            ${[0, 1, 2, 3].map(i => `<input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="1"
              data-otp-digit${otpVerified ? ' disabled' : ''} aria-label="Digit OTP ${i + 1}">`).join('')}
            <button type="button" class="btn btn-sm btn-primary" id="btnOtpVerif" data-otp-verifikasi ${otpVerified ? 'disabled' : ''}>${ui.icon('check')}Verifikasi</button>
          </div>
          <div class="otp-status ${otpVerified ? 'ok' : ''}" id="otpStatus" data-otp-status>${otpVerified
        ? 'Nomor WhatsApp sudah terverifikasi.'
        : `Kode berlaku ${otpCfg.menit} menit.`}</div>
          <input type="hidden" name="otp_token" id="otpToken" value="${lib.esc(otpToken)}">
        </div>` : `<input type="hidden" name="otp_token" value="">`}
        <hr class="sep">
        ${!trialPkg ? `<div class="alert warn">${ui.icon('alert')}<div>Pendaftaran sedang belum tersedia. Silakan hubungi pengelola layanan.</div></div>` : ''}
        ${captchaHtml}
        <button class="btn btn-primary btn-block" type="submit" id="btnDaftar" data-otp-gate="${otpCfg.aktif && !otpVerified ? '1' : '0'}"
          ${!trialPkg || (otpCfg.aktif && !otpVerified) ? 'disabled' : ''}>${trialPkg ? 'Daftar Saja' : 'Pendaftaran Belum Tersedia'}</button>
      </form>
      <p class="small muted" style="margin-top:16px;text-align:center">Sudah punya akun? <a href="${base}/login" style="color:var(--o-700);font-weight:700">Masuk</a></p>
      <script>
      ${otpCfg.aktif ? `
      (function () {
        var OTP_BASE = ${JSON.stringify(base)};
        var form = document.getElementById('btnDaftar') ? document.getElementById('btnDaftar').form : null;
        var btn = document.getElementById('btnDaftar');
        var telp = document.getElementById('fDaftarTelp');
        var sendBtn = document.getElementById('btnOtpKirim');
        var verifBtn = document.getElementById('btnOtpVerif');
        var tok = document.getElementById('otpToken');
        var st = document.getElementById('otpStatus');
        var box = document.getElementById('otpBox');
        var digits = Array.prototype.slice.call(document.querySelectorAll('[data-otp-digit]'));
        if (!form || !btn || !telp || !tok) return;
        var verified = !!tok.value;
        function say(html, tone) {
          if (!st) return;
          st.className = 'otp-status' + (tone ? ' ' + tone : '');
          st.innerHTML = html;
        }
        function syncGate() {
          btn.disabled = !verified;
          btn.setAttribute('data-otp-gate', verified ? '0' : '1');
          if (box) box.classList.toggle('verified', verified);
        }
        function setVerified(on) {
          verified = !!on;
          if (!on) tok.value = '';
          syncGate();
        }
        function kode() { return digits.map(function (d) { return d.value; }).join(''); }
        digits.forEach(function (d, i) {
          d.addEventListener('input', function () {
            d.value = (d.value || '').replace(/[^0-9]/g, '').slice(0, 1);
            if (d.value && digits[i + 1]) digits[i + 1].focus();
          });
          d.addEventListener('keydown', function (e) {
            if (e.key === 'Backspace' && !d.value && digits[i - 1]) { digits[i - 1].focus(); }
            if (e.key === 'Enter') { e.preventDefault(); if (verifBtn) verifBtn.click(); }
          });
          d.addEventListener('paste', function (e) {
            var t = (e.clipboardData || window.clipboardData).getData('text') || '';
            t = t.replace(/[^0-9]/g, '').slice(0, 4);
            if (!t) return;
            e.preventDefault();
            digits.forEach(function (x, j) { x.value = t[j] || ''; });
          });
        });
        if (sendBtn) sendBtn.addEventListener('click', function () {
          if (box) box.hidden = false;
          var nomor = (telp.value || '').trim();
          if (!/^\\+62\\d{7,15}$/.test(nomor)) { say('Masukkan nomor WhatsApp dengan awalan +62 dan angka yang valid.', 'err'); telp.focus(); return; }
          sendBtn.disabled = true;
          say('Mengirim kode OTP…', '');
          fetch(OTP_BASE + '/register/otp/kirim', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telp: nomor })
          }).then(function (r) { return r.json(); }).then(function (j) {
            sendBtn.disabled = false;
            if (!j || !j.ok) { say((j && j.err) || 'Gagal mengirim kode OTP.', 'err'); return; }
            setVerified(false);
            tok.value = j.token;
            digits.forEach(function (x) { x.disabled = false; x.value = ''; });
            if (verifBtn) verifBtn.disabled = false;
            if (j.demo_kode) {
              say('Gateway WhatsApp belum aktif (mode uji). Kode OTP Anda: <b class="mono" data-otp-demo="' + j.demo_kode + '" style="letter-spacing:3px">' + j.demo_kode + '</b>', 'warn');
            } else {
              say('Kode OTP 4 digit telah dikirim ke WhatsApp <b>' + (j.target || nomor) + '</b>. Berlaku ' + (j.menit || 10) + ' menit.', 'ok');
            }
            if (digits[0]) digits[0].focus();
          }).catch(function () {
            sendBtn.disabled = false;
            say('Tidak dapat menghubungi server. Periksa koneksi Anda.', 'err');
          });
        });
        if (verifBtn) verifBtn.addEventListener('click', function () {
          var k = kode();
          if (!tok.value) { say('Klik "Kirim Kode OTP" terlebih dahulu.', 'err'); return; }
          if (k.length !== 4) { say('Masukkan 4 digit kode OTP.', 'err'); return; }
          verifBtn.disabled = true;
          fetch(OTP_BASE + '/register/otp/verifikasi', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: tok.value, kode: k })
          }).then(function (r) { return r.json(); }).then(function (j) {
            verifBtn.disabled = false;
            if (!j || !j.ok) { say((j && j.err) || 'Kode OTP salah.', 'err'); return; }
            setVerified(true);
            digits.forEach(function (x) { x.disabled = true; });
            if (verifBtn) verifBtn.disabled = true;
            say('Nomor WhatsApp <b>' + (j.phone || '') + '</b> terverifikasi. Silakan lanjutkan pendaftaran.', 'ok');
          }).catch(function () {
            verifBtn.disabled = false;
            say('Tidak dapat menghubungi server. Periksa koneksi Anda.', 'err');
          });
        });
        telp.addEventListener('input', function () {
          if (verified) {
            setVerified(false);
            digits.forEach(function (x) { x.disabled = false; x.value = ''; });
            if (verifBtn) verifBtn.disabled = false;
            say('Nomor berubah — silakan verifikasi ulang nomor WhatsApp Anda.', 'warn');
          }
        });
        syncGate();
      })();` : ''}
      (function () {
        var telp = document.getElementById('fDaftarTelp');
        function normalizePhone() {
          if (!telp) return;
          var digits = (telp.value || '').replace(/\\D/g, '');
          if (digits.slice(0, 3) === '620') digits = '62' + digits.slice(3);
          else if (digits.charAt(0) === '0') digits = '62' + digits.slice(1);
          else if (digits.charAt(0) === '8') digits = '62' + digits;
          else if (digits.slice(0, 2) !== '62') digits = '62' + digits;
          telp.value = '+' + digits.slice(0, 17);
        }
        if (telp) {
          telp.addEventListener('input', normalizePhone);
          normalizePhone();
        }
        var pw = document.querySelector('[data-register-password]');
        if (pw) {
          var rules = {
            length: function (v) { return v.length >= 8; },
            upper: function (v) { return /[A-Z]/.test(v); },
            number: function (v) { return /[0-9]/.test(v); },
            symbol: function (v) { return /[^A-Za-z0-9]/.test(v); }
          };
          function syncPasswordRules() {
            Object.keys(rules).forEach(function (key) {
              var row = document.querySelector('[data-password-rule="' + key + '"]');
              if (row) row.classList.toggle('met', rules[key](pw.value));
            });
          }
          pw.addEventListener('input', syncPasswordRules);
          syncPasswordRules();
        }
        var email = document.querySelector('[data-register-email]');
        var emailWarning = document.querySelector('[data-email-warning]');
        if (email && emailWarning) {
          function syncEmailWarning() {
            var invalid = !!email.value && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email.value);
            emailWarning.hidden = !invalid;
            emailWarning.textContent = invalid ? 'Email belum lengkap. Gunakan format nama@domain.tld.' : '';
            email.setCustomValidity(invalid ? 'Lengkapi email dengan format nama@domain.tld.' : '');
          }
          email.addEventListener('input', syncEmailWarning);
          email.addEventListener('blur', syncEmailWarning);
          syncEmailWarning();
        }
      })();
      </script>`
    }));
  }

  get('/register', (req, res) => registerForm(req, res));
  get('/daftar', (req, res) => registerForm(req, res));

  /* ================================================================
     VERIFIKASI NOMOR WHATSAPP PENDAFTAR (OTP 4 DIGIT)
     Kode dikirim lewat WA Gateway pusat (menu WA Gateway Super Admin)
     — gateway yang sama dengan informasi tagihan perpanjangan.
     ================================================================ */
  post('/register/otp/kirim', async (req, res) => {
    const b = req.body || {};
    const cfg = (() => { try { return saas.daftarOtpCfg(); } catch (e) { return { aktif: false }; } })();
    if (!cfg.aktif) return res.json({ ok: false, err: 'Verifikasi OTP sedang dinonaktifkan oleh administrator.' }, 400);
    try {
      const telp = String(b.telp || '').trim();
      if (!/^\+?\d{8,17}$/.test(telp)) {
        return res.json({ ok: false, err: 'Nomor WhatsApp tidak valid. Gunakan angka dengan awalan +62.' }, 400);
      }
      if (phoneAlreadyRegistered(telp)) {
        return res.json({ ok: false, err: 'Nomor WhatsApp ini sudah dipakai untuk sekolah lain. Gunakan nomor yang belum terdaftar.' }, 409);
      }
      const r = await saas.otpDaftarSend(telp, saas.clientIpOf(req));
      if (!r.ok) return res.json({ ok: false, err: r.err || 'Gagal mengirim kode OTP.' }, 400);
      /* gateway aktif tetapi penolakan/gagal kirim & mode uji mati → jangan mengaku terkirim */
      if (!r.demo && (!r.kirim || !r.kirim.ok)) {
        return res.json({
          ok: false,
          err: 'Kode OTP gagal dikirim via WhatsApp (' + ((r.kirim && r.kirim.reason) || 'gateway belum aktif') + '). Coba lagi beberapa saat atau hubungi admin layanan.'
        }, 502);
      }
      return res.json({
        ok: true, token: r.token, menit: r.menit, target: r.target,
        demo: !!r.demo, demo_kode: r.demo_kode || '',
        pesan: r.kirim && r.kirim.ok ? 'Kode OTP dikirim via WhatsApp.' : ''
      });
    } catch (e) {
      console.error('[otp-daftar]', e.message);
      return res.json({ ok: false, err: 'Terjadi kesalahan saat mengirim kode OTP.' }, 500);
    }
  });

  post('/register/otp/verifikasi', (req, res) => {
    const b = req.body || {};
    try {
      const r = saas.otpDaftarVerify(String(b.token || '').trim(), String(b.kode || '').trim());
      if (!r.ok) return res.json({ ok: false, err: r.err }, 400);
      return res.json({ ok: true, phone: lib.phoneDisplay(r.row.phone) });
    } catch (e) {
      return res.json({ ok: false, err: 'Terjadi kesalahan saat memverifikasi kode OTP.' }, 500);
    }
  });

  post('/register', async (req, res) => {
    const base = req.BASE;
    const b = req.body || {};
    const back = q => base + '/register?' + Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k] || '')).join('&');
    const nama = String(b.nama || '').trim();
    const alamat = String(b.alamat || '').trim();
    const adminNama = String(b.admin_nama || '').trim();
    const email = String(b.admin_email || '').trim();
    const p1 = String(b.admin_password || '');
    const keep = {
      nama, admin_email: email, admin_nama: adminNama, alamat,
      telp: b.telp, jenjang: b.jenjang,
      // token OTP yang sudah terverifikasi disertakan agar pengguna tidak perlu verifikasi ulang
      otp: b.otp_token || ''
    };
    const ip = saas.clientIpOf(req);

    // ---- 1) RATE LIMIT / IP THROTTLING (maks. N pendaftaran per jam, blokir X jam) ----
    const status = saas.regStatus(ip);
    if (status.blocked) {
      return res.redirect(back(Object.assign({}, keep, {
        err: `Terlalu banyak permintaan pendaftaran. Silakan coba beberapa saat lagi (${status.retryMin} menit).`
      })));
    }

    // ---- 2) CAPTCHA (reCAPTCHA v3 / Turnstile) bila dikonfigurasi ----
    const capErr = await saas.verifyCaptcha(b.cfTurnstileResponse || b['cf-turnstile-response'] || b.recaptcha_token, ip);
    if (capErr) {
      saas.regLog(ip, email, 'captcha');
      return res.redirect(back(Object.assign({}, keep, { err: capErr })));
    }

    // ---- 3) validasi isian ----
    const fail = msg => { saas.regLog(ip, email, 'gagal'); return res.redirect(back(Object.assign({}, keep, { err: msg }))); };
    if (!nama) return fail('Nama sekolah wajib diisi.');
    if (!alamat) return fail('Alamat sekolah wajib diisi.');
    if (!adminNama) return fail('Nama admin wajib diisi.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Email admin tidak valid.');
    if (String(b.telp || '').trim() && (!/^\+?\d{8,17}$/.test(String(b.telp).trim()) || !lib.normPhone(b.telp))) {
      return fail('Nomor WhatsApp hanya boleh berisi angka dan harus valid.');
    }
    if (phoneAlreadyRegistered(b.telp)) return fail('Nomor WhatsApp ini sudah dipakai untuk sekolah lain. Gunakan nomor yang belum terdaftar.');
    if (p1.length < 8 || !/[A-Z]/.test(p1) || !/[0-9]/.test(p1) || !/[^A-Za-z0-9]/.test(p1)) {
      return fail('Password minimal 8 karakter dan wajib memuat huruf besar, angka, serta simbol.');
    }
    const jenjang = dbm.JENJANG[String(b.jenjang || '')] ? String(b.jenjang) : '';

    /* ---- verifikasi nomor WhatsApp (OTP 4 digit) WAJIB sebelum submit ---- */
    const otpCfg = (() => { try { return saas.daftarOtpCfg(); } catch (e) { return { aktif: false }; } })();
    if (otpCfg.aktif) {
      if (!String(b.telp || '').trim()) return fail('Nomor WhatsApp wajib diisi & diverifikasi dengan kode OTP.');
      const otp = (() => { try { return saas.otpDaftarValid(String(b.otp_token || '').trim(), b.telp); } catch (e) { return { ok: false, err: 'Verifikasi OTP gagal diproses.' }; } })();
      if (!otp.ok) return fail(otp.err || 'Nomor WhatsApp belum terverifikasi.');
    }

    // Pendaftaran publik selalu memakai paket uji coba yang diizinkan, bukan nilai dari browser.
    const pkgSel = trialPackage();
    if (!pkgSel) return fail('Pendaftaran uji coba belum tersedia. Silakan hubungi pengelola layanan.');
    const trialHari = saas.packageTrialDays(pkgSel);

    // ---- 4) batas per jam (setelah validasi dasar) ----
    if (phoneAlreadyRegistered(b.telp)) return fail('Nomor WhatsApp ini sudah dipakai untuk sekolah lain. Gunakan nomor yang belum terdaftar.');
    const hit = saas.regHit(ip, email, 'sukses');
    if (hit.blocked) {
      return res.redirect(back(Object.assign({}, keep, {
        err: `Terlalu banyak permintaan pendaftaran. Silakan coba beberapa saat lagi (${hit.retryMin || saas.regLimits().blockHours * 60} menit).`
      })));
    }

    try {
      const tenant = saas.createTenant({
        nama, admin_email: email, admin_password: p1,
        admin_nama: adminNama,
        alamat, kepala: '',
        contact_telp: lib.normPhone(b.telp) || '', jenjang,
        paket: pkgSel.kode, days: trialHari, trial: true
      });
      /* ================================================================
         SETELAH DAFTAR: langsung masuk sebagai Admin Sekolah yang baru dibuat.
         Kredensial (kode sekolah 4 karakter, username, password) disimpan pada
         baris sesi — bukan di URL — lalu ditampilkan SEKALI di dashboard.
         Bila pembuatan sesi gagal, pengguna diarahkan ke halaman sukses
         berisi kredensial yang sama (token sekali pakai, kedaluwarsa 30 menit).
         ================================================================ */
      const admin = (() => {
        try {
          return dbm.runAsTenant(tenant, () => db.prepare(
            "SELECT * FROM users WHERE role='super_admin' ORDER BY id LIMIT 1").get());
        } catch (e) { console.error('[daftar] admin sekolah tidak ditemukan:', e.message); return null; }
      })();
      const kredensial = {
        kode: tenant.school_code,
        sekolah: tenant.nama,
        username: (admin && (admin.username || admin.email)) || email,
        nama: (admin && admin.nama) || String(b.admin_nama || 'Administrator Sekolah').trim(),
        password: p1,
        at: lib.nowStamp()
      };
      let token = null;
      if (admin && admin.aktif) {
        try { token = await setSession(admin.id, tenant.id, 0, JSON.stringify(kredensial)); } catch (e) { console.error('[daftar] gagal membuat sesi:', e.message); }
      }
      try {
        await dbm.runAsTenant(tenant, () => dbm.logAudit(admin || null, 'DAFTAR', 'auth',
          `Pendaftaran sekolah ${tenant.nama} (${tenant.school_code}) — admin ${email}`
          + (token ? ' langsung masuk ke dashboard' : ' diarahkan ke halaman kredensial')));
      } catch (e) { }
      if (token) {
        res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${secureCookie(req)}`);
        return res.redirect(base + '/?welcome=1');
      }
      // ---- fallback: halaman sukses berisi kredensial (token sekali pakai) ----
      const sKey = require('crypto').randomBytes(12).toString('hex');
      successStore.set(sKey, { ...kredensial, exp: Date.now() + 30 * 60 * 1000 });
      return res.redirect(base + '/daftar/sukses?t=' + sKey);
    } catch (e) {
      res.redirect(back(Object.assign({}, keep, { err: e.message })));
    }
  });

  /* ================================================================
     HALAMAN SUKSES PENDAFTARAN (fallback / tautan ulang)
     Menampilkan Kode Sekolah, Username, dan Password dalam satu kartu.
     Data disimpan di memori 30 menit & sekali pakai — tidak pernah di URL.
     ================================================================ */
  const successStore = new Map();
  function takeSuccess(key) {
    const k = String(key || '');
    if (!k) return null;
    const v = successStore.get(k);
    if (!v) return null;
    successStore.delete(k);
    if (v.exp && v.exp < Date.now()) return null;
    return v;
  }
  get('/daftar/sukses', (req, res) => {
    const base = req.BASE;
    const data = takeSuccess(req.query.get('t'));
    const kodeUrl = String(req.query.get('kode') || '').trim().toUpperCase().slice(0, 4);
    const usernameUrl = String(req.query.get('u') || '').trim();
    if (!data && !kodeUrl) return res.redirect(base + '/login?err=' + encodeURIComponent('Halaman kredensial pendaftaran sudah kedaluwarsa. Silakan masuk dengan kode sekolah Anda.'));
    const kode = data ? data.kode : kodeUrl;
    const username = data ? data.username : (usernameUrl || '-');
    const sekolah = data ? data.sekolah : '';
    const nama = data ? data.nama : '';
    const pwd = data ? data.password : '';
    res.html(authShell({
      base,
      sideTitle: 'Pendaftaran berhasil!',
      sideDesc: 'Simpan kredensial di samping, lalu masuk ke dashboard keuangan sekolah Anda.',
      content: `
      <div class="auth-login-head">
        <div class="auth-logo-ph" style="background:#DCFCE7;color:#15803D">${ui.icon('check')}</div>
        <div class="auth-welcome">Sekolah berhasil didaftarkan</div>
        <div class="small muted">${lib.esc(nama || 'Administrator Sekolah')}${sekolah ? ' · ' + lib.esc(sekolah) : ''}</div>
      </div>
      <div class="alert ok">${ui.icon('check')}<div>Akun sekolah sudah aktif. <b>Simpan kredensial</b> berikut untuk masuk kembali kapan saja.</div></div>
      <div class="cred-box">
        <div class="cred-row">
          <div><div class="cred-lbl">Kode Sekolah</div>
            <div class="cred-val mono" data-cred="kode">${lib.esc(kode)}</div></div>
          <button type="button" class="btn btn-sm" data-copy="${lib.esc(kode)}">${ui.icon('file')}Salin</button>
        </div>
        <div class="cred-row">
          <div><div class="cred-lbl">Username</div>
            <div class="cred-val mono" data-cred="user">${lib.esc(username)}</div></div>
          <button type="button" class="btn btn-sm" data-copy="${lib.esc(username)}">${ui.icon('file')}Salin</button>
        </div>
        <div class="cred-row">
          <div><div class="cred-lbl">Password</div>
            <div class="cred-val mono" data-cred="pwd" data-pw>${pwd ? '•'.repeat(pwd.length) : '(password yang Anda pilih saat mendaftar)'}</div></div>
          ${pwd ? `<div class="flex" style="gap:6px">
            <button type="button" class="btn btn-sm" data-pw-toggle>${ui.icon('eye')}Lihat</button>
            <button type="button" class="btn btn-sm" data-copy="${lib.esc(pwd)}">${ui.icon('file')}Salin</button></div>` : ''}
        </div>
      </div>
      <p class="help" style="margin-top:10px">Demi keamanan, password hanya ditampilkan sekali di halaman ini. Bila lupa, minta Administrator Pusat meresetnya.</p>
      <a class="btn btn-primary btn-block" href="${base}/login?kode=${lib.esc(kode)}" style="margin-top:6px">${ui.icon('login')}Masuk ke Dashboard Sekolah</a>
      <p class="small muted" style="margin-top:14px;text-align:center">Alamat masuk: <b>${base}/login</b></p>`
    }));
  });

  post('/logout', async (req, res) => {
    const c = String(req.headers.cookie || '');
    const m = c.match(/simkeu_sid=([^;]+)/);
    if (m) await saas.destroySession(decodeURIComponent(m[1]));
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(req)}`);
    res.redirect(req.BASE + '/login?ok=' + encodeURIComponent('Anda telah keluar dari aplikasi.'));
  });

  /* profil sendiri */
  get('/akun', (req, res) => {
    const c = ctx(req);
    const u = dbm.mainDb.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) || req.user;
    page(req, res, {
      title: 'Akun Saya', sub: 'Kelola profil dan password Anda', active: 'akun',
      content: `<div class="split"><div class="card">
        <div class="card-head"><div><h3>Foto Profil</h3><div class="sub">JPG/PNG, maksimal 5 MB</div></div></div>
        <div class="flex" style="gap:18px;align-items:flex-start;flex-wrap:wrap">
          <div style="text-align:center">
            <div data-avatar-preview="foto_b64">${ui.avatar(u, 'avatar avatar-xl')}</div>
            <div class="avatar-preview-note">Pratinjau avatar</div>
          </div>
          <div style="flex:1;min-width:220px">
            <form method="post" action="${c.base}/akun/foto">
              <input type="hidden" name="foto_b64" id="foto_b64">
              <div class="field" style="margin-bottom:8px"><label>Pilih foto (JPG/PNG, maks 5 MB)</label>
                <input type="file" accept="image/*" data-avatar="foto_b64" data-max="5">
                <div class="avatar-pos" data-avatar-pos="foto_b64" style="display:${u.foto ? 'flex' : 'none'}">
                  <span class="small muted" style="align-self:center;margin-right:2px">Posisi:</span>
                  <button type="button" data-pos="0">Atas</button>
                  <button type="button" data-pos="0.5" class="on">Tengah</button>
                  <button type="button" data-pos="1">Bawah</button>
                </div>
                <div class="hint" id="foto_b64-info">Foto otomatis dipotong persegi mengikuti pratinjau di samping — yang Anda lihat itulah avatar yang tersimpan.</div></div>
              <button class="btn btn-primary btn-block">${ui.icon('upload')}Simpan Foto Profil</button>
            </form>
            ${u.foto ? `<form method="post" action="${c.base}/akun/foto" data-confirm="Hapus foto profil?"><input type="hidden" name="hapus" value="1"><button class="btn btn-danger btn-block mt-1">${ui.icon('trash')}Hapus Foto</button></form>` : ''}
          </div>
        </div>
        <hr class="sep">
        <div class="card-head"><div><h3>Profil</h3><div class="sub">Data akun yang sedang aktif</div></div></div>
        <form method="post" action="${c.base}/akun">
          <div class="row2">
            <div class="field"><label>Nama Lengkap</label><input type="text" name="nama" value="${lib.esc(u.nama)}" required></div>
            <div class="field"><label>Email</label><input type="email" name="email" value="${lib.esc(u.email)}" required></div>
          </div>
          <div class="field"><label>Role</label><input type="text" value="${lib.esc(roleLabel(u.role))}" readonly></div>
          <div class="row2">
            <div class="field"><label>Password Baru</label><input type="password" name="password" placeholder="Kosongkan jika tidak diubah" minlength="6"></div>
            <div class="field"><label>Ulangi Password Baru</label><input type="password" name="password2" placeholder="Ulangi password baru"></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Perubahan</button></div>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Hak Akses Role Anda</h3><div class="sub">${lib.esc(roleLabel(u.role))}</div></div></div>
        ${permissionList(u.role)}
        <p class="help mt-2">Terakhir masuk: ${lib.esc(u.last_login || '-')}</p>
      </div></div>`
    });
  });

  post('/akun', (req, res) => {
    const { nama, email, password, password2 } = req.body;
    if (!nama || !email) return res.redirect(req.BASE + '/akun?err=' + encodeURIComponent('Nama dan email wajib diisi.'));
    const dup = dbm.mainDb.prepare('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?').get(String(email).trim(), req.user.id);
    if (dup) return res.redirect(req.BASE + '/akun?err=' + encodeURIComponent('Email sudah dipakai akun lain.'));
    if (password) {
      if (String(password).length < 6) return res.redirect(req.BASE + '/akun?err=' + encodeURIComponent('Password minimal 6 karakter.'));
      if (password !== password2) return res.redirect(req.BASE + '/akun?err=' + encodeURIComponent('Konfirmasi password tidak sama.'));
      dbm.mainDb.prepare('UPDATE users SET nama=?,email=?,password=? WHERE id=?').run(String(nama).trim(), String(email).trim(), lib.hashPassword(password), req.user.id);
    } else {
      dbm.mainDb.prepare('UPDATE users SET nama=?,email=? WHERE id=?').run(String(nama).trim(), String(email).trim(), req.user.id);
    }
    dbm.logAudit(req.user, 'EDIT', 'pengguna', `Memperbarui profil sendiri (${email})`);
    res.redirect(req.BASE + '/akun?ok=' + encodeURIComponent('Profil berhasil diperbarui.'));
  });

  post('/akun/foto', async (req, res) => {
    if (req.body.hapus) {
      dbm.mainDb.prepare('UPDATE users SET foto=NULL WHERE id=?').run(req.user.id);
      dbm.logAudit(req.user, 'EDIT', 'pengguna', 'Menghapus foto profil');
      return res.redirect(req.BASE + '/akun?ok=' + encodeURIComponent('Foto profil dihapus.'));
    }
    if (!req.body.foto_b64) return res.redirect(req.BASE + '/akun?err=' + encodeURIComponent('Pilih berkas foto terlebih dahulu.'));
    try {
      const m = String(req.body.foto_b64).match(/^data:(image\/[^;]+);base64,/);
      if (!m) throw new Error('Berkas bukan gambar yang valid.');
      const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const url = await uploadMedia(req.body.foto_b64, `foto-${req.user.id}-${Date.now()}.${ext}`);
      dbm.mainDb.prepare('UPDATE users SET foto=? WHERE id=?').run(url, req.user.id);
      dbm.logAudit(req.user, 'EDIT', 'pengguna', 'Memperbarui foto profil');
      res.redirect(req.BASE + '/akun?ok=' + encodeURIComponent('Foto profil diperbarui.'));
    } catch (e) {
      res.redirect(req.BASE + '/akun?err=' + encodeURIComponent(e.message));
    }
  });

  function permissionList(role) {
    const map = permissionMatrix();
    let html = '<div class="list">';
    for (const m of dbm.MODULES) {
      const acts = dbm.ACTIONS.filter(a => (map[`${role}|${m.key}|${a}`] || 0) === 1);
      html += `<div class="list-row"><div class="dot-s" style="background:${acts.length ? 'var(--o-500)' : '#DDD2C9'}"></div>
        <div><div class="nm">${lib.esc(m.label)}</div><div class="mt">${acts.length ? acts.map(a => labelAction(a)).join(' · ') : 'Tidak ada akses'}</div></div>
        ${acts.length ? ui.badge('Aktif', 'green') : ui.badge('Terkunci', 'gray')}</div>`;
    }
    return html + '</div>';
  }
  function labelAction(a) {
    return ({ view: 'Lihat', create: 'Tambah', edit: 'Edit', delete: 'Hapus', approve: 'Approval', export: 'Export' })[a] || a;
  }
};
