# Hosting Murah AI - pasang model Hosting Murah ke GitHub Copilot Chat (VS Code) lewat TERMINAL (Windows).
# Cara pakai (tempel di PowerShell, ganti sk-vps-... dengan kunci API kamu):
#   $env:HOSTINGMURAH_KEY="sk-vps-..."; irm https://my.hostingmurah.co.id/api/ai/aktivasi.ps1 | iex
#
# Mengambil daftar model siap-pakai dari server lalu menaruhnya di chatLanguageModels.json milik
# VS Code/Cursor/Windsurf/VSCodium. Menyembunyikan model bawaan Copilot & pin model Hosting Murah
# (pakai winsqlite3.dll bawaan Windows 10/11) best-effort; model tetap terpasang meski dilewati.

& {
Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$API = if ($env:HOSTINGMURAH_API) { $env:HOSTINGMURAH_API.TrimEnd('/') } else { 'https://my.hostingmurah.co.id' }
$NL = [Environment]::NewLine

function Say($m) { Write-Host $m }
function OK($m)  { Write-Host "  $([char]0x2713) $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  ! $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "$([char]0x2717) $m" -ForegroundColor Red; throw $m }

# --- kunci mode chat ke "Local" lewat settings.json (JSONC-aman, best-effort) ---
function Set-LocalHarness($userDir) {
  try {
    $setPath = Join-Path $userDir 'settings.json'
    $s = ''
    if (Test-Path $setPath) { $s = [System.IO.File]::ReadAllText($setPath) }
    if (-not $s.Trim()) { $s = '{}' }
    $kv = [ordered]@{ 'chat.defaultToCopilotHarness' = 'false'; 'chat.editor.preferCopilotHarness' = 'false'; 'chat.editor.localAgent.enabled' = 'true' }
    foreach ($k in $kv.Keys) {
      $v = $kv[$k]
      $re = [regex]('("' + [regex]::Escape($k) + '"\s*:\s*)(true|false)')
      if ($re.IsMatch($s)) { $s = $re.Replace($s, ('$1' + $v)) }
      else { $s = ([regex]'\{').Replace($s, ('{' + $NL + '  "' + $k + '": ' + $v + ','), 1) }
    }
    [System.IO.File]::WriteAllText($setPath, $s, (New-Object System.Text.UTF8Encoding($false)))
    return $true
  } catch { return $false }
}

# --- folder konfigurasi editor ---
$root = $env:APPDATA
$editors = @('Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium')
$edName = $null; $userDir = $null
foreach ($d in $editors) {
  if (Test-Path (Join-Path $root "$d\User")) { $userDir = Join-Path $root "$d\User"; $edName = $d; break }
}
if (-not $userDir) { Die "VS Code / Cursor / Windsurf / VSCodium tidak ditemukan. Pasang VS Code terbaru dulu, buka sekali, lalu ulangi." }
Say "Editor  : $edName"
Say "Server  : $API"

# --- kunci API (env / ketik) ---
$key = if ($env:HOSTINGMURAH_KEY) { $env:HOSTINGMURAH_KEY } else { Read-Host "Masukkan kunci API Hosting Murah (sk-vps-...)" }
$key = ($key -replace '\s', '')
if (-not $key) { Die "Kunci API kosong." }
if (-not $key.StartsWith('sk-vps-')) { Die "Kunci API harus berawalan sk-vps- (buat di menu AI Service -> API Keys)." }

# --- ambil konfigurasi siap-pakai dari server ---
Say ""
Say "Menghubungkan ke Hosting Murah AI..."
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$API/api/ai/vscode-config" -ContentType 'application/json' -Body (@{ key = $key } | ConvertTo-Json)
} catch {
  $sc = $null; try { $sc = [int]$_.Exception.Response.StatusCode } catch {}
  if ($sc -eq 401) { Die "Kunci API tidak dikenal. Salin ulang dari menu AI Service -> API Keys." }
  Die "Gagal menghubungi server (koneksi/kunci API). $($_.Exception.Message)"
}
$raw = $r.Content
try { $parsed = $raw | ConvertFrom-Json } catch { Die "Konfigurasi dari server tidak valid." }
$blok = if ($parsed -is [array]) { $parsed[0] } else { $parsed }
if (-not $blok -or $blok.vendor -ne 'customendpoint') { Die "Konfigurasi dari server tidak valid." }
$nmodel = @($blok.models).Count

$cfg = Join-Path $userDir 'chatLanguageModels.json'
if (Test-Path $cfg) { Copy-Item $cfg "$cfg.hostingmurah-bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force }
[System.IO.File]::WriteAllText($cfg, $raw, (New-Object System.Text.UTF8Encoding($false)))
OK "$nmodel model Hosting Murah terpasang di GitHub Copilot Chat"
if (Set-LocalHarness $userDir) { OK "Mode chat dikunci ke 'Local' (pakai model Hosting Murah langsung, tak minta login/upgrade Copilot)." }

# --- rapikan tampilan: sembunyikan model bawaan Copilot, matikan upsell, pin unggulan (best-effort) ---
$db = Join-Path $userDir 'globalStorage\state.vscdb'
if (Test-Path $db) {
  Copy-Item $db "$db.hostingmurah-bak" -Force -ErrorAction SilentlyContinue
  $useWin = $false
  try {
    if (-not ([System.Management.Automation.PSTypeName]'Hosting MurahSqlite').Type) {
      Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Hosting MurahSqlite {
  const string DLL = "winsqlite3.dll";
  [DllImport(DLL, EntryPoint="sqlite3_open16", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Unicode)]
  static extern int Open16(string filename, out IntPtr db);
  [DllImport(DLL, EntryPoint="sqlite3_close", CallingConvention=CallingConvention.Cdecl)]
  static extern int CloseDb(IntPtr db);
  [DllImport(DLL, EntryPoint="sqlite3_busy_timeout", CallingConvention=CallingConvention.Cdecl)]
  static extern int BusyTimeout(IntPtr db, int ms);
  [DllImport(DLL, EntryPoint="sqlite3_prepare16_v2", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Unicode)]
  static extern int Prepare16(IntPtr db, string sql, int n, out IntPtr stmt, IntPtr tail);
  [DllImport(DLL, EntryPoint="sqlite3_bind_text16", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Unicode)]
  static extern int BindText16(IntPtr stmt, int idx, string val, int n, IntPtr destr);
  [DllImport(DLL, EntryPoint="sqlite3_step", CallingConvention=CallingConvention.Cdecl)]
  static extern int Step(IntPtr stmt);
  [DllImport(DLL, EntryPoint="sqlite3_column_text16", CallingConvention=CallingConvention.Cdecl)]
  static extern IntPtr ColumnText16(IntPtr stmt, int col);
  [DllImport(DLL, EntryPoint="sqlite3_finalize", CallingConvention=CallingConvention.Cdecl)]
  static extern int FinalizeStmt(IntPtr stmt);
  static readonly IntPtr TRANSIENT = new IntPtr(-1);
  public static string Read(string dbPath, string key) {
    IntPtr db = IntPtr.Zero;
    if (Open16(dbPath, out db) != 0) { if (db != IntPtr.Zero) CloseDb(db); return null; }
    try {
      BusyTimeout(db, 4000);
      IntPtr st;
      if (Prepare16(db, "SELECT value FROM ItemTable WHERE key=?", -1, out st, IntPtr.Zero) != 0) return null;
      try {
        BindText16(st, 1, key, -1, TRANSIENT);
        if (Step(st) == 100) { IntPtr p = ColumnText16(st, 0); return p == IntPtr.Zero ? null : Marshal.PtrToStringUni(p); }
        return null;
      } finally { FinalizeStmt(st); }
    } finally { CloseDb(db); }
  }
  public static bool Write(string dbPath, string key, string val) {
    IntPtr db = IntPtr.Zero;
    if (Open16(dbPath, out db) != 0) { if (db != IntPtr.Zero) CloseDb(db); return false; }
    try {
      BusyTimeout(db, 4000);
      IntPtr st;
      if (Prepare16(db, "INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)", -1, out st, IntPtr.Zero) != 0) return false;
      try {
        BindText16(st, 1, key, -1, TRANSIENT);
        BindText16(st, 2, val, -1, TRANSIENT);
        return Step(st) == 101;
      } finally { FinalizeStmt(st); }
    } finally { CloseDb(db); }
  }
}
'@
    }
    [void][HostingMurahSqlite]::Read($db, '__probe__')
    $useWin = $true
  } catch { $useWin = $false }

  if ($useWin) {
    try {
      [void][HostingMurahSqlite]::Write($db, 'chat.modelsControl', '{"free":{},"paid":{}}')
      [void][HostingMurahSqlite]::Write($db, 'chat.userSelectedSessionType', 'local')
      $cache = [HostingMurahSqlite]::Read($db, 'chat.cachedLanguageModels.v2')
      $hidden = New-Object System.Collections.Generic.List[string]
      if ($cache) {
        try {
          foreach ($m in ($cache | ConvertFrom-Json)) {
            $v = $null; try { $v = [string]$m.metadata.vendor } catch {}
            if ($v -and $v -ne 'customendpoint' -and $m.identifier) { $hidden.Add([string]$m.identifier) }
          }
        } catch {}
      }
      if ($hidden.Count -gt 0) {
        $arr = '[' + (($hidden | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']'
        [void][HostingMurahSqlite]::Write($db, 'chatModelVisibility', '{"hiddenModels":' + $arr + '}')
      } else {
        Warn "Model bawaan belum ter-cache - buka editor sekali lalu ulangi (model tetap terpasang)"
      }
      $pins = @()
      foreach ($id in @('sonnet-5','opus-5','fable-51','haiku-55','gemini-38','terra','sol','gpt-55')) {
        if (@($blok.models | ForEach-Object { $_.id }) -contains $id) { $pins += "customendpoint/$id" }
      }
      if ($pins.Count) {
        $parr = '[' + (($pins | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']'
        [void][HostingMurahSqlite]::Write($db, 'chatModelPinned', $parr)
      }
    } catch { Warn "Rapikan tampilan sebagian dilewati - tidak wajib (model tetap terpasang)" }
  } else {
    Warn "winsqlite3.dll tak tersedia (Windows terlalu lama) -> sembunyikan model bawaan dilewati (model tetap terpasang)"
  }
} else {
  Warn "state.vscdb belum ada -> buka $edName sekali lalu jalankan ulang (model tetap terpasang)"
}

# --- pilih model BYOK pertama -> pemilih model langsung terbuka di tab BYOK (bukan Copilot/Auto) ---
try {
  if ((Test-Path $db) -and (Test-Path $cfg) -and ([System.Management.Automation.PSTypeName]'Hosting MurahSqlite').Type) {
    $selG = $null
    $selJ = [System.IO.File]::ReadAllText($cfg) | ConvertFrom-Json
    foreach ($g in $selJ) {
      $gp = $g.PSObject.Properties
      if ($gp['models'] -and @($gp['models'].Value).Count -and @($gp['models'].Value)[0].PSObject.Properties['id']) { $selG = $g; break }
    }
    if ($selG) {
      $gp = $selG.PSObject.Properties
      $selV = if ($gp['vendor'] -and $gp['vendor'].Value) { [string]$gp['vendor'].Value } else { 'customendpoint' }
      $selN = if ($gp['name'] -and $gp['name'].Value) { [string]$gp['name'].Value } else { '' }
      $selId = (@($selV, $selN, [string]@($gp['models'].Value)[0].id) | Where-Object { $_ }) -join '/'
      [void][HostingMurahSqlite]::Write($db, 'chat.currentLanguageModel.panel', $selId)
      [void][HostingMurahSqlite]::Write($db, 'chat.currentLanguageModel.panel.local', $selId)
      [void][HostingMurahSqlite]::Write($db, 'chat.currentLanguageModel.panel.isDefault', 'false')
    }
  }
} catch {}

# draft chat kosong per-folder menyimpan model sendiri & mengalahkan pilihan global -> buang yg bukan BYOK
try {
  $selWs = Join-Path $userDir 'workspaceStorage'
  if (Test-Path $selWs) {
    if (-not ([System.Management.Automation.PSTypeName]'SelByokExec').Type) {
      Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SelByokExec {
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_open16", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Unicode)]
  static extern int Open16(string filename, out IntPtr db);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_close", CallingConvention=CallingConvention.Cdecl)]
  static extern int CloseDb(IntPtr db);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_busy_timeout", CallingConvention=CallingConvention.Cdecl)]
  static extern int BusyTimeout(IntPtr db, int ms);
  [DllImport("winsqlite3.dll", EntryPoint="sqlite3_exec", CallingConvention=CallingConvention.Cdecl)]
  static extern int Exec(IntPtr db, byte[] sql, IntPtr cb, IntPtr arg, IntPtr err);
  public static int Run(string dbPath, string sql) {
    IntPtr db = IntPtr.Zero;
    if (Open16(dbPath, out db) != 0) { if (db != IntPtr.Zero) CloseDb(db); return -1; }
    try { BusyTimeout(db, 4000); return Exec(db, System.Text.Encoding.UTF8.GetBytes(sql + "\0"), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero); }
    finally { CloseDb(db); }
  }
}
'@
    }
    $selSql = 'DELETE FROM ItemTable WHERE key LIKE ''chat.untitledInputState%'' AND CAST(value AS TEXT) LIKE ''%"selectedModel":{%'' AND CAST(value AS TEXT) NOT LIKE ''%"selectedModel":{"identifier":"customendpoint/%'';'
    foreach ($selD in (Get-ChildItem -LiteralPath $selWs -Directory -ErrorAction SilentlyContinue)) {
      $selF = Join-Path $selD.FullName 'state.vscdb'
      if (Test-Path -LiteralPath $selF) { [void][SelByokExec]::Run($selF, $selSql) }
    }
  }
} catch {}

# --- tutup & buka ulang editor otomatis supaya model langsung termuat (proses WMI, lepas dari terminal) ---
$progMap = @{ 'Code'='Microsoft VS Code'; 'Code - Insiders'='Microsoft VS Code Insiders'; 'Cursor'='cursor'; 'Windsurf'='Windsurf'; 'VSCodium'='VSCodium' }
$prog = $progMap[$edName]
$exe = $null
$running = Get-Process -Name $edName -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
if ($running) { $exe = $running.Path }
if (-not $exe) {
  foreach ($base in @("$env:LOCALAPPDATA\Programs\$prog", "$env:ProgramFiles\$prog", "${env:ProgramFiles(x86)}\$prog")) {
    if ($base -and (Test-Path (Join-Path $base "$edName.exe"))) { $exe = Join-Path $base "$edName.exe"; break }
  }
}
if ($running -and $exe -and (Test-Path $exe)) {
  Write-Host ">> $edName akan DITUTUP lalu dibuka ulang otomatis (~4 detik). Simpan pekerjaan Anda." -ForegroundColor Yellow
  $q = [char]34
  $line = "ping -n 5 127.0.0.1 >nul & taskkill /f /im $q$edName.exe$q >nul 2>&1 & ping -n 2 127.0.0.1 >nul & start $q$q $q$exe$q"
  $done = $false
  try { [void]([wmiclass]'Win32_Process').Create("cmd.exe /c $line"); $done = $true } catch {}
  if (-not $done) { try { Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c', $line; $done = $true } catch {} }
  if ($done) { OK "Editor akan tertutup & terbuka kembali otomatis." }
  else { Write-Host ">> Tutup lalu buka lagi $edName secara manual." -ForegroundColor Yellow }
} else {
  Write-Host ">> Buka $edName, lalu di Copilot Chat pilih model Hosting Murah (mis. Claude Sonnet 5) dari pemilih model." -ForegroundColor Yellow
}
}

