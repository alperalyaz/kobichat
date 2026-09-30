/**
 * Ayrı çalışan (node ile başlatılmış, ör. C:\KobiChat) KobiChat sunucusunu güncelleyen
 * tek dosyalık betik üretir: KobiChat-Sunucu-Guncelle.cmd
 *
 * Sunucu dosyaları betiğin içine gömülür (internet/GitHub girişi gerekmez). Betik:
 * yönetici izni ister, sunucu klasörünü bulur, yedek alır, dosyaları yazar, sunucuyu
 * başlatıldığı yolla (zamanlanmış görev / hizmet / elle) yeniden başlatır, yeni sürümü
 * doğrular; başarısızsa yedeği geri yükler.
 *
 * Kullanım: node scripts/make-server-updater.cjs [çıktı-klasörü]
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(root, "release-build"));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const payload = {
  "server\\chat-server.cjs": path.join(root, "server", "chat-server.cjs"),
  "server\\board.cjs": path.join(root, "server", "board.cjs"),
  "package.json": path.join(root, "package.json")
};

const fileEntries = Object.entries(payload)
  .map(([rel, abs]) => `  '${rel}' = '${fs.readFileSync(abs).toString("base64")}'`)
  .join("\n");

const script = String.raw`<# : KobiChat sunucu guncelleyici
@echo off
chcp 65001 >nul
set "KC_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:KC_SELF, [Text.Encoding]::UTF8))"
echo.
pause
exit /b
#>

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Version = '__VERSION__'
$Port = 3847
$Files = [ordered]@{
__FILES__
}

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

function Get-Meta {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/server-meta" -TimeoutSec 3 } catch { return $null }
}

function Get-ServerProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'chat-server\.cjs' })
}

function Wait-Version([int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    $m = Get-Meta
    if ($m -and $m.version -eq $Version) { return $true }
    Start-Sleep -Milliseconds 800
  }
  return $false
}

function Main {
  Say ''
  Say "  KobiChat sunucu güncelleyici — sürüm $Version" 'Cyan'
  Say ''

  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say 'Yönetici izni isteniyor; işlem yeni pencerede devam edecek.' 'Yellow'
    Start-Process -FilePath $env:ComSpec -ArgumentList ('/c ""' + $env:KC_SELF + '""') -Verb RunAs
    return
  }

  # 1) Sunucu klasörünü bul
  $meta = Get-Meta
  $root = $null
  if ($meta -and $meta.script) {
    $root = Split-Path (Split-Path ([string]$meta.script) -Parent) -Parent
  } elseif (Test-Path 'C:\KobiChat\server\chat-server.cjs') {
    $root = 'C:\KobiChat'
  }
  if (-not $root -or $root -match 'app\.asar' -or -not (Test-Path (Join-Path $root 'server\chat-server.cjs'))) {
    Say 'Ayrı çalışan bir KobiChat sunucusu bulunamadı.' 'Yellow'
    Say 'Sunucu KobiChat uygulamasının içinde çalışıyorsa uygulamayı güncellemek yeterlidir.' 'Yellow'
    return
  }
  Say "Sunucu klasörü: $root"
  if ($meta -and $meta.version -eq $Version) {
    Say "Sunucu zaten $Version sürümünde. Yapılacak bir şey yok." 'Green'
    return
  }
  $oldVersion = if ($meta -and $meta.version) { [string]$meta.version } else { 'eski (sürüm bilgisi yok)' }
  Say "Çalışan sürüm: $oldVersion"

  # 2) Nasıl başlatıldığını öğren (durdurmadan önce)
  $rootRx = [regex]::Escape($root) + '(\\|"|\s|$)'
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $t = $_
    ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' ' -match ('chat-server|' + $rootRx)
  })
  $services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
    $_.PathName -match ('chat-server|' + $rootRx)
  })
  $firstProc = Get-ServerProcs | Select-Object -First 1
  $nodeExe = $null
  if ($firstProc -and $firstProc.ExecutablePath) { $nodeExe = $firstProc.ExecutablePath }
  if (-not $nodeExe) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $nodeExe = $cmd.Source } }
  if ($tasks.Count) { Say ('Başlatma şekli: zamanlanmış görev (' + (($tasks | ForEach-Object { $_.TaskName }) -join ', ') + ')') }
  elseif ($services.Count) { Say ('Başlatma şekli: Windows hizmeti (' + (($services | ForEach-Object { $_.Name }) -join ', ') + ')') }
  else { Say 'Başlatma şekli: elle / başlangıç klasörü' }

  # 3) Yedek
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path (Split-Path $root -Parent) ("KobiChat-yedek\" + $stamp)
  New-Item -ItemType Directory -Force -Path (Join-Path $backup 'server') | Out-Null
  Copy-Item (Join-Path $root 'server\*') (Join-Path $backup 'server') -Recurse -Force
  if (Test-Path (Join-Path $root 'package.json')) { Copy-Item (Join-Path $root 'package.json') $backup -Force }
  $dbFile = Join-Path $root 'data\messages.db'
  if (Test-Path $dbFile) { New-Item -ItemType Directory -Force -Path (Join-Path $backup 'data') | Out-Null; Copy-Item $dbFile (Join-Path $backup 'data') -Force }
  Say "Yedek alındı: $backup" 'Green'

  $restart = {
    if ($tasks.Count) {
      foreach ($t in $tasks) { Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 1
      Get-ServerProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 1
      foreach ($t in $tasks) { Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath }
    } elseif ($services.Count) {
      foreach ($s in $services) { Restart-Service -Name $s.Name -Force }
    } else {
      Get-ServerProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 1
      if (-not $nodeExe) { throw 'node.exe bulunamadı.' }
      Start-Process -FilePath $nodeExe -ArgumentList '"server\chat-server.cjs"' -WorkingDirectory $root -WindowStyle Hidden
    }
  }

  # 4) Yeni dosyaları yaz
  foreach ($rel in $Files.Keys) {
    $dest = Join-Path $root $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($Files[$rel]))
  }
  Say 'Yeni sunucu dosyaları yazıldı.' 'Green'

  # 5) Yeniden başlat ve doğrula
  Say 'Sunucu yeniden başlatılıyor (herkes birkaç saniye içinde kendiliğinden yeniden bağlanır)...'
  & $restart
  if (Wait-Version 45) {
    Say ''
    Say "  TAMAM: Sunucu $Version sürümüyle çalışıyor. Pano artık kullanılabilir." 'Green'
    Say ''
    return
  }

  # 6) Başarısız: geri al
  Say ''
  Say "Yeni sürüm 45 saniyede ayağa kalkmadı; eski sürüme geri dönülüyor..." 'Red'
  Copy-Item (Join-Path $backup 'server\*') (Join-Path $root 'server') -Recurse -Force
  $newOnly = Join-Path $root 'server\board.cjs'
  if (-not (Test-Path (Join-Path $backup 'server\board.cjs')) -and (Test-Path $newOnly)) { Remove-Item $newOnly -Force }
  if (Test-Path (Join-Path $backup 'package.json')) { Copy-Item (Join-Path $backup 'package.json') $root -Force }
  & $restart
  Start-Sleep -Seconds 5
  if (Get-Meta) { Say 'Eski sürüm yeniden çalışıyor; hiçbir şey kaybolmadı.' 'Yellow' }
  else { Say 'DİKKAT: Sunucu yanıt vermiyor. Bilgisayarı yeniden başlatmayı deneyin.' 'Red' }
  Say 'Ayrıntılar için bu pencerenin ekran görüntüsünü iletin.' 'Yellow'
}

$log = $null
try {
  $log = Join-Path $env:TEMP ('kobichat-sunucu-guncelle-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
  Start-Transcript -Path $log -Force | Out-Null
} catch {}
try {
  Main
} catch {
  Say ''
  Say ('HATA: ' + $_.Exception.Message) 'Red'
  Say 'Sunucu dosyalarına dokunulmadıysa her şey eskisi gibi çalışmaya devam eder.' 'Yellow'
} finally {
  try { Stop-Transcript | Out-Null } catch {}
  if ($log) { Say "Günlük: $log" 'DarkGray' }
}
`
  .replace("__VERSION__", version)
  .replace("__FILES__", fileEntries);

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "KobiChat-Sunucu-Guncelle.cmd");
fs.writeFileSync(outFile, script.replace(/\r?\n/g, "\r\n"), "utf8");
console.log(`${outFile} (${version})`);
