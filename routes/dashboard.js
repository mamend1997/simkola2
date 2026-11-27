'use strict';

module.exports = ({ get, post, dbm, lib, ui, flashUrl, saas }) => {
  const { db } = dbm;
  const { rupiah, esc, tglID } = lib;
  const ROLE_LABEL = dbm.ROLE_LABEL || {
    super_admin: 'Super Admin',
    kepala_sekolah: 'Kepala Sekolah',
    staff: 'Staff'
  };

  async function settingsAll() {
    if (dbm.mysqlHelpers) return await dbm.mysqlHelpers.settingsAll();
    return await dbm.settingsAll();
  }

  async function canAsync(user, moduleName, action = 'view') {
    if (!user) return false;
    if (user.role === 'super_admin') return true;
    const row = await db.prepare(
      'SELECT allowed FROM permissions WHERE role=? AND module=? AND action=?'
    ).get(String(user.role), String(moduleName), String(action));
    return !!(row && Number(row.allowed));
  }

  async function dashboardContext(req) {
    const settings = await settingsAll();
    const taList = await db.prepare(`SELECT id,nama,tanggal_mulai,tanggal_selesai,aktif
      FROM tahun_ajaran ORDER BY tanggal_mulai DESC, nama DESC, id DESC`).all();
    const requestedTaId = Number((req.sessionRow && req.sessionRow.ta_id) || req.taId || 0);
    const ta = taList.find(row => Number(row.id) === requestedTaId)
      || taList.find(row => Number(row.aktif) === 1)
      || taList[0]
      || null;
    const permissions = await db.prepare(
      'SELECT module,action,allowed FROM permissions WHERE role=?'
    ).all(String(req.user.role));
    const permissionMap = new Map(permissions.map(row => [
      `${row.module}|${row.action}`,
      Number(row.allowed) === 1
    ]));
    const pendingRow = ta
      ? await db.prepare(`SELECT COUNT(*) AS c FROM transaksi t
          JOIN bku b ON b.id=t.bku_id
          WHERE t.status='pending' AND b.tahun_ajaran_id=?`).get(ta.id)
      : { c: 0 };
    const can = (moduleName, action = 'view') => userCan(permissionMap, req.user, moduleName, action);
    return {
      base: req.BASE || '',
      settings,
      ta,
      taId: ta ? Number(ta.id) : null,
      taList,
      pendingCount: can('transaksi', 'approve') ? Number(pendingRow.c || 0) : 0,
      can
    };
  }

  function userCan(permissionMap, user, moduleName, action) {
    if (!user) return false;
    if (user.role === 'super_admin') return true;
    return permissionMap.get(`${moduleName}|${action}`) === true;
  }

  function navConfig(settings) {
    const raw = String(settings.nav_ui || '').trim();
    return raw ? JSON.parse(raw) : null;
  }

  function renderPage(req, res, c, { title, sub, active, content }) {
    const tenant = req.tenant || null;
    const appName = String(c.settings.app_nama || (saas && saas.appName && saas.appName()) || 'SIMKOLA');
    const appSub = String(c.settings.app_sub || (saas && saas.appSub && saas.appSub()) || 'Sistem Keuangan');
    const appLogo = String(c.settings.app_logo || c.settings.sekolah_logo || '');
    const enabledFeatures = saas && saas.enabledKeys ? saas.enabledKeys(tenant) : null;
    res.html(ui.layout({
      title,
      sub,
      user: req.user,
      active,
      base: c.base,
      content,
      query: req.query,
      roleLabel: ROLE_LABEL[req.user.role] || req.user.role,
      pendingCount: c.pendingCount,
      can: c.can,
      logoStamp: c.settings.sekolah_logo || '',
      taList: c.taList,
      taId: c.taId,
      path: req.url,
      navHidden: String(c.settings.nav_hidden || ''),
      navCfg: navConfig(c.settings),
      tema: String(c.settings.tema_warna || '#F97316'),
      appName,
      appSub,
      appLogo,
      appLogoSmall: String(c.settings.app_logo_small || ''),
      mode: String(c.settings.mode_tema || 'light') === 'dark' ? 'dark' : 'light',
      features: enabledFeatures,
      tenantInfo: tenant ? {
        nama: tenant.nama,
        kode: tenant.school_code,
        status: saas.statusOf(tenant),
        paket: tenant.paket
      } : null,
      impersonate: null,
      announcements: null,
      notifs: [],
      notifCount: 0
    }));
  }

  async function requireView(req, res, c, moduleName = 'dashboard') {
    if (!req.user) {
      res.redirect((req.BASE || '') + '/login');
      return false;
    }
    if (await canAsync(req.user, moduleName, 'view')) return true;
    res.html('<!doctype html><html lang="id"><meta charset="utf-8"><title>Akses ditolak</title>'
      + '<body><main><h1>Akses ditolak</h1><p>Akun Anda tidak memiliki izin untuk halaman ini.</p></main></body></html>', 403);
    return false;
  }

  async function audit(req, action, moduleName, detail) {
    if (dbm.DB_DRIVER === 'mysql') {
      const meta = dbm.currentMeta ? dbm.currentMeta() : {};
      await dbm.mysqlHelpers.logAudit(req.user, action, moduleName, detail, {
        ...meta,
        tenantName: req.tenant && req.tenant.nama
      });
      return;
    }
    await dbm.logAudit(req.user, action, moduleName, detail);
  }

  function backPath(raw, fallback = '/catatan-orangtua') {
    const value = String(raw || fallback);
    return /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/.test(value) && !value.startsWith('//')
      ? value : fallback;
  }

  get('/', async (req, res) => {
    const c = await dashboardContext(req);
    if (!await requireView(req, res, c)) return;
    req.TA = c.ta;
    req.taId = c.taId;

    const taId = c.taId;
    const totals = taId
      ? await db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN t.jenis='pemasukan' THEN t.nominal ELSE 0 END),0) AS total_masuk,
          COALESCE(SUM(CASE WHEN t.jenis='pengeluaran' THEN t.nominal ELSE 0 END),0) AS total_keluar,
          COUNT(*) AS jumlah_transaksi
        FROM transaksi t JOIN bku b ON b.id=t.bku_id
        WHERE b.tahun_ajaran_id=? AND t.status='posted'`).get(taId)
      : { total_masuk: 0, total_keluar: 0, jumlah_transaksi: 0 };
    const anggaran = taId
      ? await db.prepare('SELECT COALESCE(SUM(pagu),0) AS pagu FROM anggaran WHERE tahun_ajaran_id=?').get(taId)
      : { pagu: 0 };
    const realisasi = taId
      ? await db.prepare(`SELECT COALESCE(SUM(t.nominal),0) AS total
        FROM transaksi t JOIN bku b ON b.id=t.bku_id JOIN coa c ON c.id=t.coa_id
        WHERE b.tahun_ajaran_id=? AND t.status='posted' AND t.jenis='pengeluaran'
          AND c.kategori='pengeluaran'`).get(taId)
      : { total: 0 };
    const bkuss = taId
      ? await db.prepare(`SELECT b.id,b.nama,b.jenis,b.status,b.saldo_awal,b.saldo_akhir_tutup,b.ditutup_at,
          COALESCE(SUM(CASE WHEN t.status='posted' AND t.jenis='pemasukan' THEN t.nominal ELSE 0 END),0) AS masuk,
          COALESCE(SUM(CASE WHEN t.status='posted' AND t.jenis='pengeluaran' THEN t.nominal ELSE 0 END),0) AS keluar
        FROM bku b LEFT JOIN transaksi t ON t.bku_id=b.id
        WHERE b.tahun_ajaran_id=?
        GROUP BY b.id,b.nama,b.jenis,b.status,b.saldo_awal,b.saldo_akhir_tutup,b.ditutup_at,b.urutan
        ORDER BY b.urutan,b.id`).all(taId)
      : [];
    const recent = taId
      ? await db.prepare(`SELECT t.id,t.tanggal,t.no_bukti,t.jenis,t.nominal,t.uraian,
          b.nama AS bku_nama,c.nama AS coa_nama
        FROM transaksi t JOIN bku b ON b.id=t.bku_id
        LEFT JOIN coa c ON c.id=t.coa_id
        WHERE b.tahun_ajaran_id=? AND t.status='posted'
        ORDER BY t.tanggal DESC,t.id DESC LIMIT 8`).all(taId)
      : [];
    const pending = taId && c.can('transaksi', 'approve')
      ? await db.prepare(`SELECT t.id,t.tanggal,t.uraian,t.nominal,b.nama AS bku_nama,u.nama AS pembuat
        FROM transaksi t JOIN bku b ON b.id=t.bku_id LEFT JOIN users u ON u.id=t.created_by
        WHERE b.tahun_ajaran_id=? AND t.status='pending'
        ORDER BY t.tanggal DESC,t.id DESC LIMIT 6`).all(taId)
      : [];
    const messageCount = await db.prepare("SELECT COUNT(*) AS c FROM portal_pesan WHERE status='baru'").get();
    const recentMessages = await db.prepare(`SELECT id,nama,pesan,kontak,status,sumber,created_at,selesai_by
      FROM portal_pesan ORDER BY (status='selesai'),id DESC LIMIT 6`).all();
    const welcome = req.sessionRow && saas && saas.takeWelcome
      ? await saas.takeWelcome(req.sessionRow.token)
      : null;
    const income = Number(totals.total_masuk) || 0;
    const expense = Number(totals.total_keluar) || 0;
    const budget = Number(anggaran.pagu) || 0;
    const spent = Number(realisasi.total) || 0;
    const utilization = budget > 0 ? Math.round(spent * 1000 / budget) / 10 : 0;
    const cashBalance = bkuss.reduce((sum, b) => sum + Number(b.saldo_awal || 0)
      + Number(b.masuk || 0) - Number(b.keluar || 0), 0);
    const kpi = (label, value, tone) => `<div class="kpi ${tone}">
      <div class="lbl">${esc(label)}</div><div class="val">${esc(rupiah(value))}</div></div>`;
    const messageCard = `<div class="card mb-3" id="pesanOrangTua">
      <div class="card-head"><div><h3>Catatan Orang Tua ${Number(messageCount.c) ? `<span class="badge amber plain">${Number(messageCount.c)} baru</span>` : ''}</h3>
        <div class="sub">Pesan dari portal publik</div></div>
        <a class="btn btn-sm" href="${c.base}/catatan-orangtua">Rekap Catatan</a></div>
      ${recentMessages.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Nama</th><th>Catatan</th><th>Status</th></tr></thead><tbody>
        ${recentMessages.map(row => `<tr><td class="nowrap">${esc(lib.stampShort(row.created_at))}</td>
          <td>${esc(row.nama || '-')}</td><td>${esc(row.pesan || '')}</td>
          <td>${row.status === 'selesai' ? ui.badge('Selesai Ditindaklanjuti', 'green') : ui.badge('Baru', 'amber')}</td></tr>`).join('')}
      </tbody></table></div>` : ui.emptyState('Belum ada catatan orang tua', 'Catatan dari portal publik akan tampil di sini.')}</div>`;
    const content = `${welcome ? `<div class="card welcome-card mb-3" id="welcomeKredensial">
        <h3>Pendaftaran berhasil — selamat datang, ${esc(welcome.nama || 'Administrator')}!</h3>
        <p>Sekolah ${esc(welcome.sekolah || c.settings.sekolah_nama || '')} sudah aktif. Simpan kredensial berikut.</p>
        <div class="cred-grid"><div class="cred-cell"><b>Kode Sekolah</b><div class="cred-val" data-cred="kode">${esc(welcome.kode || '')}</div></div>
          <div class="cred-cell"><b>Username</b><div class="cred-val">${esc(welcome.username || '')}</div></div>
          <div class="cred-cell"><b>Password</b><div class="cred-val">${esc(welcome.password || '(password pilihan Anda)')}</div></div></div>
        <p class="help">Password hanya ditampilkan sekali di halaman ini.</p></div>` : ''}
      <div class="card hero mb-3"><h2>Ringkasan Keuangan ${esc(c.settings.sekolah_nama || 'Sekolah')}</h2>
        <p>Tahun Pelajaran ${esc(c.ta ? c.ta.nama : 'belum tersedia')}</p>
        <div class="small">${bkuss.length} BKU · ${Number(totals.jumlah_transaksi) || 0} transaksi terposting</div></div>
      <div class="kpi-grid mb-3">
        ${kpi('Total Pemasukan BKU', income, 'ic-green')}
        ${kpi('Total Pengeluaran BKU', expense, 'ic-red')}
        ${kpi('Saldo Buku Kas', cashBalance, 'ic-orange')}
        ${kpi('Pagu Anggaran', budget, 'ic-blue')}
      </div>
      <div class="card mb-3"><div class="card-head"><div><h3>Serapan Anggaran</h3>
        <div class="sub">Realisasi pengeluaran ${esc(c.ta ? 'TA ' + c.ta.nama : '')}</div></div>
        <a class="btn btn-sm" href="${c.base}/anggaran">Kelola Anggaran</a></div>
        <div class="between"><b>Realisasi ${esc(rupiah(spent))}</b><b>Pagu ${esc(rupiah(budget))}</b></div>
        <div class="help">${utilization.toFixed(1)}% terserap · Sisa ${esc(rupiah(Math.max(0, budget - spent)))}</div></div>
      ${pending.length ? `<div class="card mb-3"><div class="card-head"><div><h3>Menunggu Persetujuan</h3><div class="sub">${pending.length} transaksi menunggu tinjauan</div></div>
        <a class="btn btn-sm btn-primary" href="${c.base}/approval">Tinjau</a></div>
        <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>BKU</th><th>Uraian</th><th>Pembuat</th><th class="num">Nominal</th></tr></thead><tbody>
        ${pending.map(row => `<tr><td>${esc(tglID(row.tanggal))}</td><td>${esc(row.bku_nama)}</td><td>${esc(row.uraian || '')}</td>
          <td>${esc(row.pembuat || '-')}</td><td class="num">${esc(rupiah(row.nominal))}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      <div class="card mb-3"><div class="card-head"><div><h3>Status Buku Kas (BKU)</h3><div class="sub">Saldo berjalan berdasarkan transaksi terposting</div></div>
        <a class="btn btn-sm" href="${c.base}/bku">Kelola BKU</a></div>
        ${bkuss.length ? `<div class="table-wrap"><table><thead><tr><th>Nama BKU</th><th>Jenis</th><th>Status</th><th class="num">Saldo</th></tr></thead><tbody>
          ${bkuss.map(b => `<tr><td>${esc(b.nama)}</td><td>${esc(b.jenis || '-')}</td>
            <td>${b.status === 'aktif' ? ui.badge('Aktif', 'green') : ui.badge('Ditutup', 'gray')}</td>
            <td class="num">${esc(rupiah(Number(b.saldo_awal || 0) + Number(b.masuk || 0) - Number(b.keluar || 0)))}</td></tr>`).join('')}
        </tbody></table></div>` : ui.emptyState('Belum ada BKU', 'Buat buku kas untuk mulai mencatat transaksi.')}</div>
      <div class="card mb-3"><div class="card-head"><div><h3>Transaksi Terakhir</h3><div class="sub">8 transaksi terposting terbaru</div></div>
        <a class="btn btn-sm" href="${c.base}/transaksi">Semua Transaksi</a></div>
        ${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No. Bukti</th><th>BKU</th><th>Uraian</th><th class="num">Nominal</th></tr></thead><tbody>
          ${recent.map(row => `<tr><td>${esc(tglID(row.tanggal))}</td><td>${esc(row.no_bukti || '-')}</td><td>${esc(row.bku_nama)}</td>
            <td>${esc(row.uraian || '')}<div class="t-sub">${esc(row.coa_nama || '')}</div></td><td class="num">${esc(rupiah(row.nominal))}</td></tr>`).join('')}
        </tbody></table></div>` : ui.emptyState('Belum ada transaksi', 'Transaksi terposting akan tampil di sini.')}</div>
      ${messageCard}`;
    renderPage(req, res, c, {
      title: 'Dashboard',
      sub: `Ringkasan keuangan · ${c.ta ? 'TA ' + c.ta.nama : 'belum ada tahun ajaran'}`,
      active: 'dashboard',
      content
    });
  });

  async function catatanOrtuPage(req, res) {
    const c = await dashboardContext(req);
    if (!await requireView(req, res, c)) return;
    const status = ['baru', 'selesai'].includes(req.query.get('status') || '') ? req.query.get('status') : '';
    const sumber = ['siswa', 'piutang-pegawai', 'slip-pegawai', 'semua'].includes(req.query.get('sumber') || '')
      ? req.query.get('sumber') : 'semua';
    const where = [];
    const args = [];
    if (status) { where.push('status=?'); args.push(status); }
    if (sumber === 'siswa') where.push("COALESCE(NULLIF(sumber,''),'siswa')='siswa'");
    else if (sumber !== 'semua') { where.push('sumber=?'); args.push(sumber); }
    const rows = await db.prepare(`SELECT * FROM portal_pesan
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (status='selesai'),id DESC LIMIT 400`).all(...args);
    const baru = rows.filter(row => row.status === 'baru').length;
    const currentQuery = new URLSearchParams();
    if (status) currentQuery.set('status', status);
    if (sumber !== 'semua') currentQuery.set('sumber', sumber);
    const back = '/catatan-orangtua' + (currentQuery.toString() ? '?' + currentQuery.toString() : '');
    const content = `<div class="card"><div class="card-head"><div><h3>Rekap Catatan Orang Tua</h3>
      <div class="sub">${rows.length} catatan · ${baru} belum ditindaklanjuti</div></div>
      <form method="get" action="${c.base}/catatan-orangtua" class="toolbar">
        <select name="sumber" data-autosubmit aria-label="Sumber catatan">
          ${[['siswa','Tagihan Siswa'],['piutang-pegawai','Piutang Pegawai'],['slip-pegawai','Slip Pegawai'],['semua','Semua sumber']]
            .map(([value,label]) => `<option value="${value}" ${sumber === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <select name="status" data-autosubmit aria-label="Status catatan">
          <option value="" ${!status ? 'selected' : ''}>Semua Status</option>
          <option value="baru" ${status === 'baru' ? 'selected' : ''}>Baru</option>
          <option value="selesai" ${status === 'selesai' ? 'selected' : ''}>Selesai</option>
        </select>
      </form></div>
      ${rows.length ? `<div class="table-wrap sticky-head"><table><thead><tr><th>Waktu</th><th>Sumber</th><th>Nama</th><th>Catatan</th><th>Balasan</th><th>Kontak</th><th>Status</th><th>Aksi</th></tr></thead><tbody>
        ${rows.map(row => {
      const source = String(row.sumber || 'siswa');
      const label = source === 'slip-pegawai' ? 'Slip Pegawai'
        : source === 'piutang-pegawai' ? 'Piutang Pegawai' : 'Tagihan Siswa';
      const replyForm = c.can('dashboard', 'view') ? `<details><summary class="btn btn-sm btn-primary">Balas</summary>
        <form method="post" action="${c.base}/catatan-orangtua/balas" class="mt-2">
          <input type="hidden" name="id" value="${Number(row.id)}"><input type="hidden" name="back" value="${esc(back)}">
          <div class="field"><label>Balasan</label><textarea name="balasan" rows="3" required minlength="3" maxlength="2000">${esc(row.balasan || '')}</textarea></div>
          <select name="status_after"><option value="selesai">Selesai Ditindaklanjuti</option><option value="baru">Masih Baru</option></select>
          <button class="btn btn-sm btn-primary">Kirim</button></form></details>` : '';
      const deleteForm = c.can('dashboard', 'delete') || c.can('catatan', 'delete')
        ? `<form method="post" action="${c.base}/catatan-orangtua/delete" style="display:inline" data-confirm="Hapus catatan ini?">
            <input type="hidden" name="id" value="${Number(row.id)}"><input type="hidden" name="back" value="${esc(back)}">
            <button class="btn btn-sm btn-danger" title="Hapus catatan">${ui.icon('trash')}</button></form>` : '';
      return `<tr><td class="nowrap">${esc(lib.stampShort(row.created_at))}</td><td>${esc(label)}</td>
        <td>${esc(row.nama || '-')}</td><td>${esc(row.pesan || '')}</td><td>${esc(row.balasan || 'Belum dibalas')}</td>
        <td>${esc(row.kontak || '-')}</td><td>${row.status === 'selesai' ? ui.badge('Selesai', 'green') : ui.badge('Baru', 'amber')}</td>
        <td class="nowrap">${replyForm}${deleteForm}</td></tr>`;
    }).join('')}
      </tbody></table></div>` : ui.emptyState('Belum ada catatan orang tua', 'Catatan dari portal publik akan tampil di sini.')}</div>`;
    renderPage(req, res, c, {
      title: 'Catatan Orang Tua',
      sub: 'Rekap umpan balik orang tua/wali dari portal publik',
      active: 'pesan_orangtua',
      content
    });
  }
  get('/catatan-orangtua', catatanOrtuPage);
  get('/pesan-orangtua', catatanOrtuPage);

  post('/catatan-orangtua/delete', async (req, res) => {
    const back = backPath(req.body.back);
    if (!await canAsync(req.user, 'dashboard', 'delete') && !await canAsync(req.user, 'catatan', 'delete')) {
      return res.redirect((req.BASE || '') + flashUrl(back, 'err', 'Role Anda tidak berhak menghapus catatan orang tua.'));
    }
    const id = Number(req.body.id || 0);
    const row = id ? await db.prepare('SELECT * FROM portal_pesan WHERE id=?').get(id) : null;
    if (!row) return res.redirect((req.BASE || '') + flashUrl(back, 'err', 'Catatan tidak ditemukan.'));
    await db.prepare('DELETE FROM portal_pesan WHERE id=?').run(id);
    await audit(req, 'HAPUS', 'portal', `Menghapus catatan orang tua dari ${row.nama || '-'}: ${String(row.pesan || '').slice(0, 100)}`);
    return res.redirect((req.BASE || '') + flashUrl(back, 'ok', 'Catatan orang tua dihapus.'));
  });

  post('/catatan-orangtua/balas', async (req, res) => {
    if (!await requireView(req, res, { can: () => false })) return;
    const id = Number(req.body.id || 0);
    const back = backPath(req.body.back);
    const reply = String(req.body.balasan || '').trim();
    const status = ['baru', 'selesai'].includes(String(req.body.status_after || ''))
      ? String(req.body.status_after) : 'selesai';
    if (reply.length < 3) {
      return res.redirect((req.BASE || '') + flashUrl(back, 'err', 'Balasan terlalu pendek (minimal 3 karakter).'));
    }
    const row = id ? await db.prepare('SELECT * FROM portal_pesan WHERE id=?').get(id) : null;
    if (!row) return res.redirect((req.BASE || '') + flashUrl(back, 'err', 'Catatan tidak ditemukan.'));
    const now = lib.nowStamp();
    await db.prepare(`UPDATE portal_pesan
      SET balasan=?,balas_oleh=?,balas_at=?,status=?,selesai_at=?,selesai_by=? WHERE id=?`).run(
      reply,
      String(req.user.nama || ''),
      now,
      status,
      status === 'selesai' ? now : null,
      status === 'selesai' ? String(req.user.nama || '') : null,
      id
    );
    await audit(req, 'BALAS', 'portal', `Membalas catatan orang tua ${row.nama || '-'}: ${reply.slice(0, 120)}`);
    return res.redirect((req.BASE || '') + flashUrl(back, 'ok', 'Balasan terkirim. Orang tua/wali dapat melihatnya di portal.'));
  });

  post('/pesan-orangtua/selesai', async (req, res) => {
    if (!await requireView(req, res, { can: () => false })) return;
    const id = Number(req.body.id || 0);
    const back = backPath(req.body.back);
    const row = id ? await db.prepare('SELECT * FROM portal_pesan WHERE id=?').get(id) : null;
    if (!row) return res.redirect((req.BASE || '') + flashUrl(back, 'err', 'Catatan tidak ditemukan.'));
    await db.prepare(`UPDATE portal_pesan
      SET status='selesai',selesai_at=?,selesai_by=? WHERE id=?`).run(lib.nowStamp(), req.user.nama, id);
    await audit(req, 'TINDAKLANJUT', 'portal', `Catatan orang tua ${row.nama || ''} ditandai selesai`);
    return res.redirect((req.BASE || '') + flashUrl(back, 'ok', 'Catatan ditandai: Selesai Ditindaklanjuti.'));
  });
};
