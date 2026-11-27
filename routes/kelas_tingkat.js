'use strict';
/**
 * ==================================================================
 * PENGATURAN KELAS & TINGKAT (per sekolah)
 * ------------------------------------------------------------------
 * /kelas/tingkat
 *  · pilih JENJANG pendidikan → preset tingkat otomatis aktif
 *  · centang tingkat mana saja yang dipakai sekolah
 *  · tambah tingkat KUSTOM (mis. "7 Al-Farabi")
 *  · buat kelas per tingkat (nama bebas: VII-A, 7 Al-Farabi, X IPA 1)
 * ==================================================================
 */
module.exports = ({ get, post, dbm, lib, ui, page, ctx, guard, can, flashUrl, saas }) => {
  const { esc, nowStamp } = lib;
  const go = (req, res, key, msg) => res.redirect(req.BASE + flashUrl('/kelas/tingkat', key, msg));

  if (dbm.DB_DRIVER === 'mysql') {
    const db = dbm.db;
    const JENJANG = {
      'PAUD/TK': { label: 'PAUD / TK', preset: ['KB', 'TK-A', 'TK-B'] },
      'SD/MI': { label: 'SD / MI', preset: ['I', 'II', 'III', 'IV', 'V', 'VI'] },
      'SMP/MTs': { label: 'SMP / MTs', preset: ['VII', 'VIII', 'IX'] },
      'SMA/MA': { label: 'SMA / MA', preset: ['X', 'XI', 'XII'] },
      SMK: { label: 'SMK', preset: ['X', 'XI', 'XII'] },
      KUSTOM: { label: 'Kustom (pilih sendiri)', preset: [] }
    };
    const TINGKAT_MASTER = [
      { kode: 'KB', label: 'Kelompok Bermain' }, { kode: 'TK-A', label: 'TK A' }, { kode: 'TK-B', label: 'TK B' },
      { kode: 'I', label: 'Tingkat I' }, { kode: 'II', label: 'Tingkat II' }, { kode: 'III', label: 'Tingkat III' },
      { kode: 'IV', label: 'Tingkat IV' }, { kode: 'V', label: 'Tingkat V' }, { kode: 'VI', label: 'Tingkat VI' },
      { kode: 'VII', label: 'Tingkat VII' }, { kode: 'VIII', label: 'Tingkat VIII' }, { kode: 'IX', label: 'Tingkat IX' },
      { kode: 'X', label: 'Tingkat X' }, { kode: 'XI', label: 'Tingkat XI' }, { kode: 'XII', label: 'Tingkat XII' },
      { kode: 'PAUD', label: 'PAUD' }
    ];
    const TINGKAT_ALIAS = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][i]]));
    const levelOrder = ['KB', 'PAUD', 'TK-A', 'TK-B', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    const levelOrderOf = value => {
      const raw = String(value || '').trim().toUpperCase();
      const normalized = TINGKAT_ALIAS[raw] || raw;
      const index = levelOrder.indexOf(normalized);
      return index < 0 ? 99 : index;
    };
    const sortLevels = list => [...new Set((Array.isArray(list) ? list : [])
      .map(value => String(value).trim()).filter(Boolean))]
      .sort((a, b) => levelOrderOf(a) - levelOrderOf(b) || a.localeCompare(b, 'id'));
    const tingkatLabel = value => {
      const raw = String(value || '').trim();
      const normalized = TINGKAT_ALIAS[raw.toUpperCase()] || raw.toUpperCase();
      const row = TINGKAT_MASTER.find(item => item.kode === normalized);
      return row ? row.label : raw;
    };
    const canAsync = async (user, moduleName, action = 'view') => {
      if (!user) return false;
      if (user.role === 'super_admin') return true;
      const row = await db.prepare(
        'SELECT allowed FROM permissions WHERE role=? AND module=? AND action=?'
      ).get(String(user.role), String(moduleName), String(action));
      return !!(row && Number(row.allowed));
    };
    const access = async (req, res, moduleName, action) => {
      if (!req.user) {
        res.redirect((req.BASE || '') + '/login');
        return false;
      }
      if (await canAsync(req.user, moduleName, action)) return true;
      res.html('<!doctype html><html lang="id"><meta charset="utf-8"><title>Akses ditolak</title>'
        + '<body><main><h1>Akses ditolak</h1><p>Role Anda tidak memiliki hak akses untuk tindakan ini.</p></main></body></html>', 403);
      return false;
    };
    const setting = (key, fallback = '') => dbm.mysqlHelpers.getSetting(key, fallback);
    const setSetting = (key, value) => dbm.mysqlHelpers.setSetting(key, value);
    const getActiveLevels = async () => {
      let active = [];
      try {
        const parsed = JSON.parse(String(await setting('tingkat_aktif', '[]')) || '[]');
        if (Array.isArray(parsed)) active = parsed;
      } catch { /* malformed legacy settings fall back to the configured level preset */ }
      const jenjang = String(await setting('jenjang_pendidikan', ''));
      if (!active.length) active = (JENJANG[jenjang] || {}).preset || [];
      if (!active.length) active = ['VII', 'VIII', 'IX'];
      return sortLevels(active);
    };
    const writeActiveLevels = async list => {
      const clean = sortLevels(list);
      await setSetting('tingkat_aktif', JSON.stringify(clean));
      return clean;
    };
    const getTahunList = () => db.prepare(
      'SELECT id,nama,tanggal_mulai,tanggal_selesai,aktif FROM tahun_ajaran ORDER BY tanggal_mulai DESC,nama DESC,id DESC'
    ).all();
    const currentTahunId = async req => {
      const selected = Number(req.query.get('ta') || (req.sessionRow && req.sessionRow.ta_id) || req.taId || 0);
      if (selected) {
        const exists = await db.prepare('SELECT id FROM tahun_ajaran WHERE id=?').get(selected);
        if (exists) return selected;
      }
      const active = await db.prepare('SELECT id FROM tahun_ajaran WHERE aktif=1 ORDER BY id DESC LIMIT 1').get();
      if (active) return Number(active.id);
      const latest = await db.prepare('SELECT id FROM tahun_ajaran ORDER BY tanggal_mulai DESC,nama DESC,id DESC LIMIT 1').get();
      return latest ? Number(latest.id) : 0;
    };
    const kelasList = async taId => {
      const where = taId ? 'WHERE k.tahun_ajaran_id=?' : '';
      const values = taId ? [taId] : [];
      return db.prepare(`SELECT k.*,
          COALESCE(k.nama_kelas,k.nama) AS nama_kelas,
          (SELECT COUNT(*) FROM siswa s
            JOIN siswa_penempatan sp ON sp.siswa_id=s.id AND sp.tahun_ajaran_id=k.tahun_ajaran_id
            WHERE sp.kelas_id=k.id AND s.status='aktif') AS jumlah_siswa
        FROM kelas k ${where}
        ORDER BY k.urutan,k.nama_kelas,k.id`).all(...values);
    };
    const audit = async (req, action, detail) => {
      const meta = dbm.currentMeta ? dbm.currentMeta() : {};
      await dbm.mysqlHelpers.logAudit(req.user, action, 'kelas', detail, {
        ...meta,
        tenantName: req.tenant && req.tenant.nama
      });
    };
    const renderPage = async (req, res, { title, sub, content }) => {
      const settings = await dbm.mysqlHelpers.settingsAll();
      const taList = await getTahunList();
      const permissions = await db.prepare('SELECT module,action,allowed FROM permissions WHERE role=?')
        .all(String(req.user.role));
      const permissionMap = new Map(permissions.map(row => [
        `${row.module}|${row.action}`, Number(row.allowed) === 1
      ]));
      const can = (moduleName, action = 'view') => req.user.role === 'super_admin'
        || permissionMap.get(`${moduleName}|${action}`) === true;
      const taId = await currentTahunId(req);
      const ta = taList.find(row => Number(row.id) === taId) || null;
      const tenant = req.tenant || null;
      const layout = ui.layout({
        title, sub, user: req.user, active: 'kelas_tingkat', base: req.BASE || '', content,
        query: req.query, roleLabel: (dbm.ROLE_LABEL && dbm.ROLE_LABEL[req.user.role]) || req.user.role,
        pendingCount: 0, can, logoStamp: settings.sekolah_logo || '', taList, taId: ta ? ta.id : null,
        path: req.url, navHidden: String(settings.nav_hidden || ''),
        navCfg: settings.nav_ui ? JSON.parse(settings.nav_ui) : null,
        tema: String(settings.tema_warna || '#F97316'),
        appName: String(settings.app_nama || (saas && saas.appName && saas.appName()) || 'SIMKOLA'),
        appSub: String(settings.app_sub || (saas && saas.appSub && saas.appSub()) || 'Sistem Keuangan'),
        appLogo: String(settings.app_logo || settings.sekolah_logo || ''),
        appLogoSmall: String(settings.app_logo_small || ''),
        mode: String(settings.mode_tema || 'light') === 'dark' ? 'dark' : 'light',
        features: saas && saas.enabledKeys ? saas.enabledKeys(tenant) : null,
        tenantInfo: tenant ? {
          nama: tenant.nama,
          kode: tenant.school_code,
          status: saas && saas.statusOf ? saas.statusOf(tenant) : null,
          paket: tenant.paket
        } : null,
        impersonate: null, announcements: null, notifs: [], notifCount: 0
      });
      res.html(layout);
    };

    get('/kelas/tingkat', async (req, res) => {
      if (!await access(req, res, 'kelas', 'view')) return;
      const settings = await dbm.mysqlHelpers.settingsAll();
      const jenjang = String(settings.jenjang_pendidikan || '');
      const aktif = await getActiveLevels();
      const taId = await currentTahunId(req);
      const kelasAll = await kelasList(taId || null);
      const editable = await canAsync(req.user, 'kelas', 'edit');
      const preset = (JENJANG[jenjang] || {}).preset || [];
      const tingkatRows = TINGKAT_MASTER.map(level => {
        const on = aktif.some(value => value.toUpperCase() === level.kode.toUpperCase());
        const count = kelasAll.filter(row => String(row.tingkat || '').toUpperCase() === level.kode.toUpperCase()).length;
        return `<label class="check tk-item">
          <input type="checkbox" name="tingkat" value="${esc(level.kode)}" ${on ? 'checked' : ''} ${editable ? '' : 'disabled'}>
          <span><b>${esc(level.label)}</b> <span class="t-sub mono">(${esc(level.kode)})</span>
            ${count ? `<span class="badge green plain">${count} kelas</span>` : ''}</span></label>`;
      }).join('');
      const custom = aktif.filter(value => !TINGKAT_MASTER.some(level => level.kode.toUpperCase() === value.toUpperCase()));
      const customRows = custom.map(value => {
        const count = kelasAll.filter(row => String(row.tingkat || '') === value).length;
        return `<div class="tk-item flex" style="justify-content:space-between;gap:10px">
          <div><b>${esc(value)}</b> <span class="badge violet plain">kustom</span>
            ${count ? `<span class="badge green plain">${count} kelas</span>` : ''}</div>
          ${editable ? `<form method="post" action="${req.BASE}/kelas/tingkat/hapus" data-confirm="Hapus tingkat ${esc(value)} dari daftar aktif?">
            <input type="hidden" name="tingkat" value="${esc(value)}"><button class="btn btn-sm btn-danger">${ui.icon('trash')}Hapus</button></form>` : ''}
        </div>`;
      }).join('');
      const byLevel = aktif.map(level => {
        const rows = kelasAll.filter(row => String(row.tingkat || '') === level);
        return `<div class="card mb-2"><div class="card-head" style="padding-bottom:6px">
          <div><h3 style="font-size:15px">${esc(tingkatLabel(level))} <span class="t-sub mono">(${esc(level)})</span></h3>
            <div class="sub">${rows.length} kelas · ${rows.reduce((sum, row) => sum + Number(row.jumlah_siswa || 0), 0)} siswa aktif</div></div>
          ${editable ? `<form method="post" action="${req.BASE}/kelas/tingkat/kelas" class="flex" style="gap:6px;align-items:flex-end">
            <input type="hidden" name="tingkat" value="${esc(level)}"><input type="hidden" name="tahun_ajaran_id" value="${taId}">
            <div class="field" style="margin:0"><label>Nama kelas baru</label><input name="nama" placeholder="mis. ${esc(level)}-A" required style="width:150px"></div>
            <button class="btn btn-sm">${ui.icon('plus')}Tambah</button></form>` : ''}</div>
          ${rows.length ? `<div class="table-wrap short"><table><thead><tr><th>Nama Kelas</th><th>Wali Kelas</th><th class="num">Siswa</th><th>Status</th><th></th></tr></thead><tbody>
            ${rows.map(row => `<tr><td class="t-strong">${esc(row.nama_kelas || row.nama)}</td><td>${esc(row.wali_kelas || '-')}</td>
              <td class="num">${row.jumlah_siswa || 0}</td><td>${row.aktif ? ui.badge('Aktif', 'green') : ui.badge('Non-Aktif', 'gray')}</td>
              <td class="nowrap"><a class="btn btn-sm" href="${req.BASE}/kelas?ta=${taId}&q=${encodeURIComponent(row.nama_kelas || row.nama)}">Kelola</a></td></tr>`).join('')}
          </tbody></table></div>` : '<p class="help" style="margin:0">Belum ada kelas pada tingkat ini.</p>'}</div>`;
      }).join('');
      const ta = taId ? await db.prepare('SELECT nama FROM tahun_ajaran WHERE id=?').get(taId) : null;
      const content = `<div class="alert info">${ui.icon('info')}<div><b>Jenjang pendidikan</b> menentukan preset tingkat standar. Mengubah jenjang akan menerapkan preset baru.</div></div>
        <div class="split"><div class="card"><div class="card-head"><div><h3>Jenjang Pendidikan</h3><div class="sub">Dipakai untuk preset tingkat kelas</div></div>
          ${jenjang ? ui.badge(jenjang, 'blue') : ui.badge('Belum diatur', 'gray')}</div>
          <form method="post" action="${req.BASE}/kelas/tingkat/jenjang"><div class="field"><label>Jenjang Sekolah</label>
            <select name="jenjang_pendidikan" data-autosubmit>${Object.entries(JENJANG).map(([key, value]) => `<option value="${esc(key)}" ${jenjang === key ? 'selected' : ''}>${esc(value.label)}${value.preset.length ? ' — ' + value.preset.join(', ') : ''}</option>`).join('')}</select>
            <div class="hint">Preset saat ini: <b>${preset.length ? esc(preset.join(', ')) : 'tanpa preset (kustom)'}</b></div></div>
            ${editable ? `<button class="btn btn-primary btn-block">${ui.icon('refresh')}Terapkan Preset Jenjang</button>` : ''}</form>
          <hr class="sep"><div class="card-head" style="padding:0 0 8px"><div><h3>Tambah Tingkat Kustom</h3><div class="sub">Mis. "7 Al-Farabi", "Kelas Pagi", "TAHFIDZ"</div></div></div>
          <form method="post" action="${req.BASE}/kelas/tingkat/tambah"><div class="field"><label>Nama Tingkat</label><input name="tingkat" required maxlength="30" placeholder="7 Al-Farabi"></div>
            ${editable ? `<button class="btn btn-block">${ui.icon('plus')}Tambah Tingkat</button>` : ''}</form></div>
        <div class="card"><div class="card-head"><div><h3>Tingkat Aktif</h3><div class="sub">Centang tingkat yang dipakai sekolah ini</div></div>${ui.badge(aktif.length + ' tingkat', 'green')}</div>
          <form method="post" action="${req.BASE}/kelas/tingkat/simpan"><div class="tk-grid">${tingkatRows}</div>
            ${custom.length ? `<hr class="sep"><div class="t-strong mb-1">Tingkat Kustom</div>${customRows}` : ''}
            ${editable ? `<div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Tingkat Aktif</button></div>` : `<div class="alert info">${ui.icon('lock')}<div>Role Anda hanya dapat melihat.</div></div>`}
          </form></div></div>
        <div class="card mt-3"><div class="card-head"><div><h3>Kelas per Tingkat — TA ${esc(ta ? ta.nama : '-')}</h3><div class="sub">${kelasAll.length} kelas terdaftar</div></div>
          <a class="btn btn-sm" href="${req.BASE}/kelas?ta=${taId}">${ui.icon('book')}Halaman Data Kelas</a></div>
          ${byLevel || ui.emptyState('Belum ada tingkat aktif', 'Pilih jenjang pendidikan atau centang tingkat di atas.')}</div>`;
      await renderPage(req, res, { title: 'Pengaturan Kelas & Tingkat', sub: 'Jenjang, tingkat aktif & nama kelas', content });
    });

    post('/kelas/tingkat/jenjang', async (req, res) => {
      if (!await access(req, res, 'kelas', 'edit')) return;
      const jenjang = String(req.body.jenjang_pendidikan || '').trim();
      if (!JENJANG[jenjang]) return go(req, res, 'err', 'Jenjang tidak dikenal.');
      const preset = JENJANG[jenjang].preset;
      await dbm.mysqlDatabase.transaction(async tx => {
        await tx.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)')
          .run('jenjang_pendidikan', jenjang);
        if (preset.length) {
          await tx.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)')
            .run('tingkat_aktif', JSON.stringify(sortLevels(preset)));
        }
      });
      await audit(req, 'EDIT', `Jenjang pendidikan → ${jenjang}${preset.length ? ' (preset tingkat diterapkan)' : ''}`);
      return go(req, res, 'ok', `Jenjang ${jenjang} disimpan. Preset tingkat: ${preset.join(', ') || '-'}.`);
    });

    post('/kelas/tingkat/simpan', async (req, res) => {
      if (!await access(req, res, 'kelas', 'edit')) return;
      const selected = [].concat(req.body.tingkat || []).map(value => String(value).trim()).filter(Boolean);
      if (!selected.length) return go(req, res, 'err', 'Pilih minimal satu tingkat.');
      const current = await getActiveLevels();
      const custom = current.filter(value => !TINGKAT_MASTER.some(level => level.kode.toUpperCase() === value.toUpperCase()));
      const keepCustom = custom.filter(value => selected.some(item => item.toUpperCase() === value.toUpperCase()));
      const active = await writeActiveLevels([...selected, ...keepCustom]);
      await audit(req, 'EDIT', `Tingkat aktif: ${active.join(', ')}`);
      return go(req, res, 'ok', `Tingkat aktif disimpan (${active.length} tingkat).`);
    });

    post('/kelas/tingkat/tambah', async (req, res) => {
      if (!await access(req, res, 'kelas', 'edit')) return;
      const level = String(req.body.tingkat || '').trim();
      if (!level) return go(req, res, 'err', 'Nama tingkat wajib diisi.');
      if (level.length > 30) return go(req, res, 'err', 'Nama tingkat maksimal 30 karakter.');
      const current = await getActiveLevels();
      if (current.some(value => value.toUpperCase() === level.toUpperCase())) return go(req, res, 'err', 'Tingkat tersebut sudah ada.');
      await writeActiveLevels([...current, level]);
      await audit(req, 'TAMBAH', `Tingkat kustom: ${level}`);
      return go(req, res, 'ok', `Tingkat "${level}" ditambahkan.`);
    });

    post('/kelas/tingkat/hapus', async (req, res) => {
      if (!await access(req, res, 'kelas', 'edit')) return;
      const level = String(req.body.tingkat || '').trim();
      const count = await db.prepare('SELECT COUNT(*) AS c FROM kelas WHERE tingkat=?').get(level);
      if (Number(count && count.c || 0)) {
        return go(req, res, 'err', `Tingkat "${level}" masih dipakai ${count.c} kelas. Hapus/pindahkan kelasnya lebih dulu.`);
      }
      const current = await getActiveLevels();
      await writeActiveLevels(current.filter(value => value !== level));
      await audit(req, 'HAPUS', `Tingkat ${level} dinonaktifkan`);
      return go(req, res, 'ok', `Tingkat "${level}" dihapus dari daftar aktif.`);
    });

    post('/kelas/tingkat/kelas', async (req, res) => {
      if (!await access(req, res, 'kelas', 'create')) return;
      const name = String(req.body.nama || '').trim();
      const level = String(req.body.tingkat || '').trim();
      if (!name) return go(req, res, 'err', 'Nama kelas wajib diisi.');
      const taId = Number(req.body.tahun_ajaran_id || await currentTahunId(req));
      if (!Number.isInteger(taId) || taId < 1) return go(req, res, 'err', 'Tahun ajaran belum tersedia.');
      const duplicate = await db.prepare(`SELECT id FROM kelas
        WHERE tahun_ajaran_id=? AND LOWER(COALESCE(nama_kelas,nama))=LOWER(?) LIMIT 1`).get(taId, name);
      if (duplicate) return go(req, res, 'err', 'Nama kelas sudah dipakai pada tahun pelajaran ini.');
      const order = await db.prepare('SELECT COALESCE(MAX(urutan),0)+1 AS next_order FROM kelas').get();
      await db.prepare(`INSERT INTO kelas
        (nama,nama_kelas,tingkat,wali_kelas,program_id,tahun_ajaran_id,aktif,urutan,created_at)
        VALUES (?,?,?,'',NULL,?,1,?,?)`).run(name, name, level, taId, Number(order.next_order || 1), nowStamp());
      await audit(req, 'TAMBAH', `Tambah kelas ${name} (tingkat ${level})`);
      return go(req, res, 'ok', `Kelas ${name} ditambahkan pada tingkat ${level}.`);
    });
    return;
  }

  function taSel(req, c) {
    const id = Number(req.query.get('ta') || c.taId || 0);
    return id || dbm.taAutoId();
  }

  get('/kelas/tingkat', (req, res) => {
    guard(req, res, 'kelas', 'view');
    const c = ctx(req);
    const taId = taSel(req, c);
    const jenjang = String(dbm.getSetting('jenjang_pendidikan', '') || '');
    const aktif = dbm.tingkatAktif();
    const editable = c.can('kelas', 'edit');
    const kelasAll = dbm.kelasList(taId, {});
    const preset = dbm.jenjangPreset(jenjang);

    const tingkatRows = dbm.TINGKAT_MASTER.map(t => {
      const on = aktif.some(a => String(a).toUpperCase() === t.kode.toUpperCase());
      const nKelas = kelasAll.filter(k => String(k.tingkat || '').toUpperCase() === t.kode.toUpperCase()).length;
      return `<label class="check tk-item">
        <input type="checkbox" name="tingkat" value="${esc(t.kode)}" ${on ? 'checked' : ''} ${editable ? '' : 'disabled'}>
        <span><b>${esc(t.label)}</b> <span class="t-sub mono">(${esc(t.kode)})</span>
          ${nKelas ? `<span class="badge green plain">${nKelas} kelas</span>` : ''}</span></label>`;
    }).join('');
    // tingkat aktif yang tidak termasuk master (kustom buatan sekolah)
    const kustom = aktif.filter(a => !dbm.TINGKAT_MASTER.some(t => t.kode.toUpperCase() === String(a).toUpperCase()));
    const kustomRows = kustom.map(a => {
      const nKelas = kelasAll.filter(k => String(k.tingkat || '') === String(a)).length;
      return `<div class="tk-item flex" style="justify-content:space-between;gap:10px">
        <div><b>${esc(a)}</b> <span class="badge violet plain">kustom</span>
          ${nKelas ? `<span class="badge green plain">${nKelas} kelas</span>` : ''}</div>
        ${editable ? `<form method="post" action="${c.base}/kelas/tingkat/hapus" data-confirm="Hapus tingkat ${esc(a)} dari daftar aktif?">
          <input type="hidden" name="tingkat" value="${esc(a)}">
          <button class="btn btn-sm btn-danger">${ui.icon('trash')}Hapus</button></form>` : ''}
      </div>`;
    }).join('');

    const perTingkat = aktif.map(tk => {
      const rows = kelasAll.filter(k => String(k.tingkat || '') === String(tk));
      return `<div class="card mb-2">
        <div class="card-head" style="padding-bottom:6px">
          <div><h3 style="font-size:15px">${esc(dbm.tingkatLabel(tk))} <span class="t-sub mono">(${esc(tk)})</span></h3>
            <div class="sub">${rows.length} kelas · ${rows.reduce((s, k) => s + Number(k.jumlah_siswa || 0), 0)} siswa aktif</div></div>
          ${editable ? `<form method="post" action="${c.base}/kelas/tingkat/kelas" class="flex" style="gap:6px;align-items:flex-end">
            <input type="hidden" name="tingkat" value="${esc(tk)}">
            <input type="hidden" name="tahun_ajaran_id" value="${taId}">
            <div class="field" style="margin:0"><label>Nama kelas baru</label>
              <input name="nama" placeholder="mis. ${esc(tk)}-A" required style="width:150px"></div>
            <button class="btn btn-sm">${ui.icon('plus')}Tambah</button>
          </form>` : ''}
        </div>
        ${rows.length ? `<div class="table-wrap short"><table><thead><tr><th>Nama Kelas</th><th>Wali Kelas</th><th class="num">Siswa</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(k => `<tr>
            <td class="t-strong">${esc(k.nama_kelas || k.nama)}</td>
            <td>${esc(k.wali_kelas || '-')}</td>
            <td class="num">${k.jumlah_siswa || 0}</td>
            <td>${k.aktif ? ui.badge('Aktif', 'green') : ui.badge('Non-Aktif', 'gray')}</td>
            <td class="nowrap"><a class="btn btn-sm" href="${c.base}/kelas?ta=${taId}&q=${encodeURIComponent(k.nama)}">Kelola</a></td>
          </tr>`).join('')}
        </tbody></table></div>` : `<p class="help" style="margin:0">Belum ada kelas pada tingkat ini.</p>`}
      </div>`;
    }).join('');

    const content = `<div class="alert info">${ui.icon('info')}<div>
      <b>Jenjang pendidikan</b> menentukan preset tingkat standar. Mengubah jenjang akan menawarkan preset baru;
      tingkat yang sudah Anda centang manual tidak hilang sampai Anda menyimpannya lagi.</div></div>

    <div class="split">
      <div class="card">
        <div class="card-head"><div><h3>Jenjang Pendidikan</h3><div class="sub">Dipakai untuk preset tingkat kelas</div></div>
          ${jenjang ? ui.badge(jenjang, 'blue') : ui.badge('Belum diatur', 'gray')}</div>
        <form method="post" action="${c.base}/kelas/tingkat/jenjang">
          <div class="field"><label>Jenjang Sekolah</label>
            <select name="jenjang_pendidikan" data-autosubmit>
              ${Object.entries(dbm.JENJANG).map(([k, v]) => `<option value="${esc(k)}" ${jenjang === k ? 'selected' : ''}>${esc(v.label)}${v.preset.length ? ' — ' + v.preset.join(', ') : ''}</option>`).join('')}
            </select>
            <div class="hint">Preset saat ini: <b>${preset.length ? esc(preset.join(', ')) : 'tanpa preset (kustom)'}</b></div></div>
          ${editable ? `<button class="btn btn-primary btn-block">${ui.icon('refresh')}Terapkan Preset Jenjang</button>` : ''}
        </form>
        <hr class="sep">
        <div class="card-head" style="padding:0 0 8px"><div><h3>Tambah Tingkat Kustom</h3>
          <div class="sub">Mis. "7 Al-Farabi", "Kelas Pagi", "TAHFIDZ"</div></div></div>
        <form method="post" action="${c.base}/kelas/tingkat/tambah">
          <div class="field"><label>Nama Tingkat</label><input name="tingkat" required maxlength="30" placeholder="7 Al-Farabi"></div>
          ${editable ? `<button class="btn btn-block">${ui.icon('plus')}Tambah Tingkat</button>` : ''}
        </form>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>Tingkat Aktif</h3><div class="sub">Centang tingkat yang dipakai sekolah ini</div></div>
          ${ui.badge(aktif.length + ' tingkat', 'green')}</div>
        <form method="post" action="${c.base}/kelas/tingkat/simpan">
          <div class="tk-grid">${tingkatRows}</div>
          ${kustom.length ? `<hr class="sep"><div class="t-strong mb-1">Tingkat Kustom</div>${kustomRows}` : ''}
          ${editable ? `<div class="form-actions"><button class="btn btn-primary">${ui.icon('save')}Simpan Tingkat Aktif</button></div>`
        : `<div class="alert info">${ui.icon('lock')}<div>Role Anda hanya dapat melihat.</div></div>`}
        </form>
      </div>
    </div>

    <div class="card mt-3">
      <div class="card-head"><div><h3>Kelas per Tingkat — TA ${esc((dbm.tahunById(taId) || {}).nama || '-')}</h3>
        <div class="sub">${kelasAll.length} kelas terdaftar</div></div>
        <a class="btn btn-sm" href="${c.base}/kelas?ta=${taId}">${ui.icon('book')}Halaman Data Kelas</a></div>
      ${perTingkat || ui.emptyState('Belum ada tingkat aktif', 'Pilih jenjang pendidikan atau centang tingkat di atas.')}
    </div>`;
    page(req, res, { title: 'Pengaturan Kelas & Tingkat', sub: 'Jenjang, tingkat aktif & nama kelas', active: 'kelas_tingkat', content });
  });

  post('/kelas/tingkat/jenjang', (req, res) => {
    guard(req, res, 'kelas', 'edit');
    try {
      const j = String(req.body.jenjang_pendidikan || '').trim();
      if (!dbm.JENJANG[j]) throw new Error('Jenjang tidak dikenal.');
      dbm.setSetting('jenjang_pendidikan', j);
      const r = dbm.applyJenjangPreset(j, true);
      dbm.logAudit(req.user, 'EDIT', 'kelas', `Jenjang pendidikan → ${j}${r.changed ? ' (preset tingkat diterapkan)' : ''}`);
      go(req, res, 'ok', `Jenjang ${j} disimpan. Preset tingkat: ${r.list.join(', ') || '-'}.`);
    } catch (e) { go(req, res, 'err', e.message); }
  });

  post('/kelas/tingkat/simpan', (req, res) => {
    guard(req, res, 'kelas', 'edit');
    const list = [].concat(req.body.tingkat || []).map(x => String(x).trim()).filter(Boolean);
    if (!list.length) return go(req, res, 'err', 'Pilih minimal satu tingkat.');
    const kustom = dbm.tingkatAktif().filter(a => !dbm.TINGKAT_MASTER.some(t => t.kode.toUpperCase() === String(a).toUpperCase()));
    const final = [...new Set([...list, ...kustom.filter(k => list.some(l => l.toUpperCase() === k.toUpperCase()))])];
    dbm.setTingkatAktif(final);
    dbm.logAudit(req.user, 'EDIT', 'kelas', `Tingkat aktif: ${final.join(', ')}`);
    go(req, res, 'ok', `Tingkat aktif disimpan (${final.length} tingkat).`);
  });

  post('/kelas/tingkat/tambah', (req, res) => {
    guard(req, res, 'kelas', 'edit');
    const t = String(req.body.tingkat || '').trim();
    if (!t) return go(req, res, 'err', 'Nama tingkat wajib diisi.');
    const cur = dbm.tingkatAktif();
    if (cur.some(x => x.toUpperCase() === t.toUpperCase())) return go(req, res, 'err', 'Tingkat tersebut sudah ada.');
    dbm.setTingkatAktif([...cur, t]);
    dbm.logAudit(req.user, 'TAMBAH', 'kelas', `Tingkat kustom: ${t}`);
    go(req, res, 'ok', `Tingkat "${t}" ditambahkan.`);
  });

  post('/kelas/tingkat/hapus', (req, res) => {
    guard(req, res, 'kelas', 'edit');
    const t = String(req.body.tingkat || '').trim();
    const nKelas = dbm.kelasList(null, {}).filter(k => String(k.tingkat || '') === t).length;
    if (nKelas) return go(req, res, 'err', `Tingkat "${t}" masih dipakai ${nKelas} kelas. Hapus/pindahkan kelasnya lebih dulu.`);
    dbm.setTingkatAktif(dbm.tingkatAktif().filter(x => x !== t));
    dbm.logAudit(req.user, 'HAPUS', 'kelas', `Tingkat ${t} dinonaktifkan`);
    go(req, res, 'ok', `Tingkat "${t}" dihapus dari daftar aktif.`);
  });

  /** tambah kelas langsung dari halaman pengaturan tingkat */
  post('/kelas/tingkat/kelas', (req, res) => {
    guard(req, res, 'kelas', 'create');
    const { db } = dbm;
    try {
      const nama = String(req.body.nama || '').trim();
      const tingkat = String(req.body.tingkat || '').trim();
      if (!nama) throw new Error('Nama kelas wajib diisi.');
      const taId = Number(req.body.tahun_ajaran_id || dbm.taAutoId());
      const dup = db.prepare('SELECT id FROM kelas WHERE tahun_ajaran_id=? AND lower(COALESCE(nama_kelas,nama))=lower(?)').get(taId, nama);
      if (dup) throw new Error('Nama kelas sudah dipakai pada tahun pelajaran ini.');
      db.prepare(`INSERT INTO kelas (nama,nama_kelas,tingkat,wali_kelas,program_id,tahun_ajaran_id,aktif,urutan,created_at)
        VALUES (?,?,?,'',NULL,?,1,?,?)`).run(nama, nama, tingkat, taId,
        db.prepare('SELECT COALESCE(MAX(urutan),0)+1 n FROM kelas').get().n, nowStamp());
      dbm.logAudit(req.user, 'TAMBAH', 'kelas', `Tambah kelas ${nama} (tingkat ${tingkat})`);
      go(req, res, 'ok', `Kelas ${nama} ditambahkan pada tingkat ${tingkat}.`);
    } catch (e) { go(req, res, 'err', e.message); }
  });
};
