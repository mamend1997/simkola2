'use strict';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff',
  aktif INTEGER NOT NULL DEFAULT 1, jabatan TEXT DEFAULT '',
  created_at TEXT, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT);
CREATE TABLE IF NOT EXISTS permissions (
  role TEXT NOT NULL, module TEXT NOT NULL, action TEXT NOT NULL, allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role, module, action)
);
CREATE TABLE IF NOT EXISTS tahun_ajaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, tanggal_mulai TEXT, tanggal_selesai TEXT,
  aktif INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bku (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL DEFAULT 'umum',
  kode TEXT, tahun_ajaran_id INTEGER, saldo_awal REAL NOT NULL DEFAULT 0,
  pemasukan_saldo INTEGER NOT NULL DEFAULT 0, rab REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aktif', ditutup_at TEXT, ditutup_oleh TEXT,
  saldo_akhir_tutup REAL, berita_acara_no TEXT, urutan INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS coa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kode TEXT NOT NULL, nama TEXT NOT NULL,
  kategori TEXT NOT NULL, aktif INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS anggaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tahun_ajaran_id INTEGER NOT NULL, coa_id INTEGER NOT NULL,
  pagu REAL NOT NULL DEFAULT 0, keterangan TEXT,
  UNIQUE (tahun_ajaran_id, coa_id)
);
CREATE TABLE IF NOT EXISTS bku_rab (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, coa_id INTEGER NOT NULL,
  pagu REAL NOT NULL DEFAULT 0, keterangan TEXT, created_at TEXT, updated_at TEXT, tenant_id INTEGER,
  UNIQUE (bku_id, coa_id)
);
CREATE TABLE IF NOT EXISTS transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, tanggal TEXT NOT NULL,
  jenis TEXT NOT NULL, metode TEXT NOT NULL DEFAULT 'tunai', no_bukti TEXT,
  coa_id INTEGER, nominal REAL NOT NULL DEFAULT 0, jumlah_barang REAL NOT NULL DEFAULT 1,
  harga_satuan REAL NOT NULL DEFAULT 0, uraian TEXT, nama_pihak TEXT,
  nota_url TEXT, status TEXT NOT NULL DEFAULT 'posted', rekon_matched INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT, approved_by INTEGER, approved_at TEXT, catatan_approval TEXT
);
CREATE TABLE IF NOT EXISTS piutang (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama_pegawai TEXT NOT NULL, tanggal_utang TEXT,
  nominal REAL NOT NULL DEFAULT 0, tanggal_bayar TEXT, status TEXT NOT NULL DEFAULT 'belum',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS spp (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tahun_ajaran_id INTEGER NOT NULL, bulan INTEGER NOT NULL,
  total_ditagihkan REAL NOT NULL DEFAULT 0, total_diterima REAL NOT NULL DEFAULT 0, keterangan TEXT,
  UNIQUE (tahun_ajaran_id, bulan)
);
CREATE TABLE IF NOT EXISTS aset (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL,
  saldo REAL NOT NULL DEFAULT 0, keterangan TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS rekon_saldo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bku_id INTEGER NOT NULL, tanggal TEXT,
  saldo_koran REAL NOT NULL DEFAULT 0, catatan TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS rekon_saldo_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tahun_ajaran_id INTEGER, tanggal TEXT,
  saldo_koran REAL NOT NULL DEFAULT 0, catatan TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rekon_saldo_global_ta_date
  ON rekon_saldo_global(tahun_ajaran_id, tanggal, id);
CREATE TABLE IF NOT EXISTS koreksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER, bku_id INTEGER,
  aksi TEXT NOT NULL DEFAULT 'edit',
  data_lama TEXT, data_baru TEXT, alasan TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER, requested_nama TEXT, requested_at TEXT,
  reviewed_by INTEGER, reviewed_nama TEXT, reviewed_at TEXT, catatan_review TEXT
);
CREATE TABLE IF NOT EXISTS bku_import (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bku_id INTEGER, nama_file TEXT, judul_excel TEXT, sheet TEXT,
  jumlah_masuk INTEGER DEFAULT 0, jumlah_keluar INTEGER DEFAULT 0,
  total_masuk REAL DEFAULT 0, total_keluar REAL DEFAULT 0,
  saldo_awal REAL DEFAULT 0, saldo_akhir REAL DEFAULT 0,
  reconciled INTEGER DEFAULT 0, dilewati INTEGER DEFAULT 0,
  user_id INTEGER, user_nama TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_nama TEXT, aksi TEXT,
  modul TEXT, detail TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS piutang_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, piutang_id INTEGER NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, created_by INTEGER
);
CREATE TABLE IF NOT EXISTS pinjaman_mutasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT, aset_id INTEGER,
  tanggal TEXT, keterangan TEXT, jenis TEXT NOT NULL DEFAULT 'masuk',
  nominal REAL NOT NULL DEFAULT 0, created_at TEXT, created_by INTEGER,
  no_bukti TEXT, nama_pihak TEXT, bukti_url TEXT, metode TEXT DEFAULT 'tunai', coa_id INTEGER
);
CREATE TABLE IF NOT EXISTS pegawai (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jabatan TEXT DEFAULT '',
  tipe TEXT NOT NULL DEFAULT 'guru', no_rekening TEXT DEFAULT '', pemilik_rekening TEXT DEFAULT '',
  nip TEXT, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS payroll (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  periode TEXT NOT NULL, pegawai_id INTEGER, nama TEXT NOT NULL, jabatan TEXT DEFAULT '', tipe TEXT DEFAULT 'guru',
  jam_efektif REAL NOT NULL DEFAULT 0, jam_telat REAL NOT NULL DEFAULT 0, honor_jam REAL NOT NULL DEFAULT 0,
  tunjangan_jabatan REAL NOT NULL DEFAULT 0, tunjangan_masa_kerja REAL NOT NULL DEFAULT 0,
  lembur REAL NOT NULL DEFAULT 0, tambahan_penghasilan REAL NOT NULL DEFAULT 0,
  tunjangan_khusus REAL NOT NULL DEFAULT 0, tugas_tambahan REAL NOT NULL DEFAULT 0,
  pot_dana_sosial REAL NOT NULL DEFAULT 0, pot_bpjs_kes REAL NOT NULL DEFAULT 0,
  pot_bpjs_tk REAL NOT NULL DEFAULT 0, pot_sertifikasi REAL NOT NULL DEFAULT 0,
  pot_kasbon REAL NOT NULL DEFAULT 0, kasbon_applied REAL NOT NULL DEFAULT 0,
  piutang_id INTEGER, catatan TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE (periode, pegawai_id)
);
CREATE TABLE IF NOT EXISTS payroll_post (
  id INTEGER PRIMARY KEY AUTOINCREMENT, periode TEXT NOT NULL UNIQUE,
  total_penerimaan REAL DEFAULT 0, total_potongan REAL DEFAULT 0, total_diterima REAL DEFAULT 0,
  dana_sosial REAL DEFAULT 0, trx_umum_id INTEGER, trx_dana_sosial_id INTEGER,
  posted_at TEXT, posted_by TEXT
);
/* status draf leger honor: mode potongan kasbon & catatan (leger tetap draf sampai diposting) */
/* ---------- Leger Honor DINAMIS: kolom bisa ditambah/diubah sekolah ---------- */
CREATE TABLE IF NOT EXISTS payroll_kolom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  tipe TEXT NOT NULL DEFAULT 'penerimaan',
  nilai TEXT NOT NULL DEFAULT 'uang',
  rumus TEXT,
  urutan INTEGER NOT NULL DEFAULT 0,
  sistem INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS payroll_nilai (
  payroll_id INTEGER NOT NULL,
  kolom_kode TEXT NOT NULL,
  nilai REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (payroll_id, kolom_kode)
);
CREATE TABLE IF NOT EXISTS payroll_draft (
  periode TEXT PRIMARY KEY,
  kasbon_auto INTEGER NOT NULL DEFAULT 1,
  kasbon_at TEXT, kasbon_by TEXT, kasbon_total REAL NOT NULL DEFAULT 0,
  catatan TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS beasiswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, tahun_ajaran_id INTEGER,
  nominal REAL NOT NULL DEFAULT 0, keterangan TEXT, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS beasiswa_siswa (
  beasiswa_id INTEGER NOT NULL, siswa_id INTEGER NOT NULL,
  nominal REAL NOT NULL DEFAULT 0, UNIQUE (beasiswa_id, siswa_id)
);
CREATE INDEX IF NOT EXISTS idx_bs_siswa ON beasiswa_siswa(siswa_id);
/* pesan / catatan orang tua dari portal publik */
CREATE TABLE IF NOT EXISTS portal_pesan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER, nama TEXT, kontak TEXT,
  pesan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'baru',
  tahun_ajaran_id INTEGER, created_at TEXT, selesai_at TEXT, selesai_by TEXT,
  sumber TEXT DEFAULT 'siswa', ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_pp_status ON portal_pesan(status);
/* ---------- notifikasi internal (lonceng pada header) ----------
   untuk = kode role penerima ('super_admin', 'kepala_sekolah', 'staff', 'semua').
   Dipakai modul pembayaran iuran portal agar bendahara langsung tahu ada
   pembayaran manual baru yang menunggu verifikasi. */
CREATE TABLE IF NOT EXISTS notif (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  untuk TEXT NOT NULL DEFAULT 'super_admin',
  jenis TEXT, judul TEXT, isi TEXT, href TEXT, ref TEXT,
  dibaca INTEGER NOT NULL DEFAULT 0, created_at TEXT, baca_at TEXT, baca_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_baca ON notif(untuk, dibaca, id);
/* catatan / laporan kekeliruan dari pegawai (login) kepada bendahara */
CREATE TABLE IF NOT EXISTS catatan_pegawai (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, nama TEXT NOT NULL, jabatan TEXT,
  pesan TEXT NOT NULL, terkait TEXT, periode TEXT, status TEXT NOT NULL DEFAULT 'baru',
  balasan TEXT, balas_oleh TEXT, balas_at TEXT, tahun_ajaran_id INTEGER,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cp_status ON catatan_pegawai(status);
/* kode OTP portal publik (pegawai / slip gaji) */
CREATE TABLE IF NOT EXISTS otp_code (
  token TEXT PRIMARY KEY, jenis TEXT NOT NULL, ref TEXT,
  phone TEXT, kode TEXT NOT NULL, expires_at TEXT, tries INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS bku_periode (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bku_id INTEGER NOT NULL, periode TEXT NOT NULL,
  saldo_awal REAL NOT NULL DEFAULT 0,
  total_masuk REAL NOT NULL DEFAULT 0, total_keluar REAL NOT NULL DEFAULT 0,
  saldo_buku REAL NOT NULL DEFAULT 0, saldo_akhir REAL NOT NULL DEFAULT 0,
  metode TEXT NOT NULL DEFAULT 'rollover',
  opnam_tunai REAL, opnam_bank REAL, selisih REAL NOT NULL DEFAULT 0,
  alasan TEXT, metode_penyesuaian TEXT, transaksi_penyesuaian_id INTEGER,
  status TEXT NOT NULL DEFAULT 'ditutup',
  berita_acara_no TEXT, ditutup_at TEXT, ditutup_oleh TEXT,
  UNIQUE (bku_id, periode)
);
CREATE TABLE IF NOT EXISTS piutang_lain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL, kategori TEXT NOT NULL DEFAULT 'Sertifikasi',
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'belum', tanggal_bayar TEXT,
  bku_id INTEGER, created_at TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS piutang_lain_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, piutang_id INTEGER NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, created_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pl_bayar ON piutang_lain_bayar(piutang_id);
CREATE INDEX IF NOT EXISTS idx_trx_bku ON transaksi(bku_id);
CREATE INDEX IF NOT EXISTS idx_trx_coa ON transaksi(coa_id);
CREATE INDEX IF NOT EXISTS idx_trx_status ON transaksi(status);
CREATE INDEX IF NOT EXISTS idx_piutang_nama ON piutang(nama_pegawai);
CREATE INDEX IF NOT EXISTS idx_payroll_periode ON payroll(periode);
CREATE INDEX IF NOT EXISTS idx_pl_nama ON piutang_lain(nama);
CREATE INDEX IF NOT EXISTS idx_trx_tgl ON transaksi(tanggal);
CREATE INDEX IF NOT EXISTS idx_bayar_piutang ON piutang_bayar(piutang_id);
/* ---------- kotak sampah (soft delete 30 hari) ---------- */
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tabel TEXT NOT NULL, row_id INTEGER,
  label TEXT, data TEXT NOT NULL, extra TEXT, alasan TEXT,
  user_id INTEGER, user_nama TEXT, deleted_at TEXT, expired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trash_tabel ON trash(tabel);
/* ---------- akademik ---------- */
CREATE TABLE IF NOT EXISTS program_keahlian (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, program_studi TEXT DEFAULT '',
  ketua TEXT DEFAULT '', aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS kelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, nama_kelas TEXT, tingkat TEXT DEFAULT '',
  wali_kelas TEXT DEFAULT '', program_id INTEGER, tahun_ajaran_id INTEGER,
  aktif INTEGER NOT NULL DEFAULT 1, urutan INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS siswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nisn TEXT, nama TEXT NOT NULL,
  jenis_kelamin TEXT DEFAULT 'L', tanggal_lahir TEXT, kelas_id INTEGER,
  tahun_ajaran_id INTEGER, status TEXT NOT NULL DEFAULT 'aktif',
  keterangan TEXT, parent_phone TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_siswa_kelas ON siswa(kelas_id);
CREATE INDEX IF NOT EXISTS idx_siswa_nama ON siswa(nama);
CREATE INDEX IF NOT EXISTS idx_siswa_nisn ON siswa(nisn);
CREATE TABLE IF NOT EXISTS siswa_mutasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER, kelas_asal_id INTEGER, kelas_tujuan_id INTEGER,
  ta_asal_id INTEGER, ta_tujuan_id INTEGER, status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER, created_at TEXT, applied_at TEXT, applied_by TEXT
);
/* ---------- iuran siswa ---------- */
CREATE TABLE IF NOT EXISTS iuran_grup (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, jenis TEXT NOT NULL DEFAULT 'bulanan',
  tahun_ajaran_id INTEGER, keterangan TEXT, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS bku_iuran_grup (
  bku_id INTEGER NOT NULL, grup_id INTEGER NOT NULL, tenant_id INTEGER,
  PRIMARY KEY (bku_id, grup_id), UNIQUE (grup_id)
);
CREATE TABLE IF NOT EXISTS iuran_nominal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grup_id INTEGER NOT NULL, bulan INTEGER,
  nominal REAL NOT NULL DEFAULT 0, tingkat TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS iuran_tagihan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grup_id INTEGER NOT NULL, siswa_id INTEGER NOT NULL,
  tahun_ajaran_id INTEGER, nominal REAL NOT NULL DEFAULT 0, potongan REAL NOT NULL DEFAULT 0,
  keterangan TEXT, created_at TEXT, UNIQUE (grup_id, siswa_id)
);
/* ---------- pengingat tagihan via WhatsApp (broadcast scheduler) ---------- */
CREATE TABLE IF NOT EXISTS wa_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, isi TEXT NOT NULL,
  urutan INTEGER NOT NULL DEFAULT 0, aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS wa_reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER, nama TEXT, phone TEXT, kelas TEXT,
  nominal REAL NOT NULL DEFAULT 0, pesan TEXT, status TEXT NOT NULL DEFAULT 'pending',
  error TEXT, mode TEXT NOT NULL DEFAULT 'manual', pemicu TEXT, batch TEXT,
  created_at TEXT, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_log_status ON wa_reminder_log(status, id);
CREATE INDEX IF NOT EXISTS idx_wa_log_created ON wa_reminder_log(created_at);
CREATE TABLE IF NOT EXISTS iuran_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tagihan_id INTEGER, siswa_id INTEGER,
  tanggal TEXT, jumlah REAL NOT NULL DEFAULT 0, potongan REAL NOT NULL DEFAULT 0,
  dibayar REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai', keterangan TEXT,
  bku_id INTEGER, transaksi_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
  kwitansi_no TEXT, print_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT, posted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_iuran_bayar_tag ON iuran_bayar(tagihan_id);
CREATE INDEX IF NOT EXISTS idx_iuran_bayar_tgl ON iuran_bayar(tanggal);
CREATE INDEX IF NOT EXISTS idx_iuran_tagihan_ta_id ON iuran_tagihan(tahun_ajaran_id, id);
CREATE INDEX IF NOT EXISTS idx_iuran_bayar_status_tgl ON iuran_bayar(status, tanggal, id);
/* ---------- pembayaran iuran mandiri dari portal orang tua ----------
   Satu baris = satu keranjang pembayaran (bisa beberapa item tagihan/bulan).
   status: 'menunggu' (menunggu pembayaran gateway / verifikasi bendahara),
           'lunas' (diverifikasi bendahara atau callback gateway sukses),
           'ditolak' (bukti tidak sah), 'batal' (kedaluwarsa / dibatalkan).
   Saat lunas, rincian item dipecah menjadi baris iuran_bayar status 'pending'
   sehingga otomatis muncul di Antrean Posting Iuran. */
CREATE TABLE IF NOT EXISTS iuran_checkout (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  siswa_id INTEGER, nama TEXT, kelas TEXT,
  items TEXT, total REAL NOT NULL DEFAULT 0,
  metode TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'menunggu',
  provider TEXT, order_id TEXT, gateway_status TEXT,
  qr_string TEXT, qr_url TEXT, checkout_url TEXT, expires_at TEXT,
  bukti_url TEXT, bukti_nama TEXT, catatan TEXT, alasan TEXT,
  ta_id INTEGER, created_at TEXT, paid_at TEXT, verified_by TEXT, verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_iuran_co_status ON iuran_checkout(status, id);
CREATE INDEX IF NOT EXISTS idx_iuran_co_order ON iuran_checkout(order_id);
CREATE TABLE IF NOT EXISTS ekskul_honor (
  id INTEGER PRIMARY KEY AUTOINCREMENT, periode TEXT, nama_pembina TEXT NOT NULL,
  kehadiran REAL NOT NULL DEFAULT 0, harga_satuan REAL NOT NULL DEFAULT 0,
  keterangan TEXT, status TEXT NOT NULL DEFAULT 'pending', bku_id INTEGER,
  transaksi_id INTEGER, created_at TEXT, posted_at TEXT, posted_by TEXT,
  /* bulan pembukuan ke BKU (boleh BEDA dengan periode kinerja/honor) */
  posting_periode TEXT
);
/* ---------- mutasi bank & cash (tidak lewat BKU) ---------- */
CREATE TABLE IF NOT EXISTS mutasi_kas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, dari TEXT, ke TEXT,
  nominal REAL NOT NULL DEFAULT 0, keterangan TEXT, no_bukti TEXT,
  tahun_ajaran_id INTEGER, created_at TEXT, created_by INTEGER
);
/* ---------- penempatan kelas siswa per tahun pelajaran (riwayat akademik) ----------
   Satu baris = siswa terdaftar di satu kelas pada satu tahun pelajaran.
   Mutasi/penetapan kelas TIDAK lagi menghapus penempatan tahun sebelumnya,
   sehingga rekap akademik tahun asal tetap utuh. Kolom siswa.kelas_id &
   siswa.tahun_ajaran_id hanya cache penempatan TERBARU (lihat siswaSyncCurrent). */
CREATE TABLE IF NOT EXISTS siswa_penempatan (
  id INTEGER PRIMARY KEY AUTOINCREMENT, siswa_id INTEGER NOT NULL, kelas_id INTEGER,
  tahun_ajaran_id INTEGER NOT NULL, sumber TEXT NOT NULL DEFAULT 'manual',
  mutasi_id INTEGER, created_at TEXT, updated_at TEXT,
  UNIQUE (siswa_id, tahun_ajaran_id)
);
CREATE INDEX IF NOT EXISTS idx_penempatan_ta ON siswa_penempatan(tahun_ajaran_id, kelas_id);
CREATE INDEX IF NOT EXISTS idx_penempatan_siswa ON siswa_penempatan(siswa_id);
/* ---------- piutang lainnya: kategori fleksibel + tagihan/cicilan ---------- */
CREATE TABLE IF NOT EXISTS piutang_kategori (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, keterangan TEXT DEFAULT '',
  tampil_aset INTEGER NOT NULL DEFAULT 1, aktif INTEGER NOT NULL DEFAULT 1,
  urutan INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS piutang_lainnya (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kategori_id INTEGER, nama TEXT NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'belum', tanggal_bayar TEXT, bku_id INTEGER,
  created_at TEXT, tahun_ajaran_id INTEGER
);
CREATE TABLE IF NOT EXISTS piutang_lainnya_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT, piutang_id INTEGER NOT NULL,
  tanggal TEXT, nominal REAL NOT NULL DEFAULT 0, metode TEXT DEFAULT 'tunai',
  bku_id INTEGER, transaksi_id INTEGER, keterangan TEXT, created_at TEXT, created_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pln_bayar ON piutang_lainnya_bayar(piutang_id);
CREATE INDEX IF NOT EXISTS idx_pln_nama ON piutang_lainnya(nama);
CREATE INDEX IF NOT EXISTS idx_pln_ta ON piutang_lainnya(tahun_ajaran_id);
/* ---------- riwayat auto-backup (Telegram) ---------- */
CREATE TABLE IF NOT EXISTS cloud_backup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waktu TEXT, nama_berkas TEXT, ukuran INTEGER, file_id TEXT,
  status TEXT NOT NULL DEFAULT 'gagal', pesan TEXT,
  pemicu TEXT NOT NULL DEFAULT 'manual', user_nama TEXT,
  dihapus INTEGER NOT NULL DEFAULT 0, durasi_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cloud_backup_waktu ON cloud_backup(waktu);
/* ---------- Beasiswa multi-grup iuran ---------- */
CREATE TABLE IF NOT EXISTS beasiswa_grup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beasiswa_id INTEGER NOT NULL,
  grup_id INTEGER NOT NULL,
  bulan_mask TEXT,
  UNIQUE(beasiswa_id, grup_id)
);
/* ---------- Petunjuk Pengguna: panduan bergambar + video/PDF ---------- */
CREATE TABLE IF NOT EXISTS panduan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judul TEXT NOT NULL,
  kategori TEXT,
  ringkas TEXT,
  thumbnail TEXT,
  video_url TEXT,
  pdf_url TEXT,
  urutan INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);`;

module.exports = SCHEMA;
