/**
 * release-store-out içindeki .appx paketinde özel tile varlıklarını doğrular.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "release-store-out");
const REQUIRED = [
  "assets/StoreLogo.png",
  "assets/Square44x44Logo.png",
  "assets/Square150x150Logo.png",
  "assets/Wide310x150Logo.png"
];

function fail(msg) {
  console.error(`[verify-store-appx] HATA: ${msg}`);
  process.exit(1);
}

function findAppx() {
  if (!fs.existsSync(OUT_DIR)) {
    fail(`Çıktı klasörü yok: ${OUT_DIR}`);
  }
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((name) => name.toLowerCase().endsWith(".appx"))
    .map((name) => path.join(OUT_DIR, name));
  if (!files.length) {
    fail(`${OUT_DIR} içinde .appx bulunamadı. Önce npm run release:store çalıştırın.`);
  }
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function readEntries(appxPath) {
  const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(appxPath)})
$entries = foreach ($e in $zip.Entries) {
  [PSCustomObject]@{ Name = ($e.FullName -replace '\\\\','/'); Length = $e.Length }
}
$manifest = $zip.Entries | Where-Object { $_.FullName -eq 'AppxManifest.xml' }
$xml = ''
if ($manifest) {
  $reader = New-Object System.IO.StreamReader($manifest.Open())
  $xml = $reader.ReadToEnd()
  $reader.Close()
}
$zip.Dispose()
@{ entries = $entries; manifest = $xml } | ConvertTo-Json -Compress -Depth 4
`;
  const rc = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", ps],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  if (rc.status !== 0) {
    fail(rc.stderr || rc.stdout || "AppX okunamadı.");
  }
  try {
    return JSON.parse(rc.stdout.trim());
  } catch {
    fail("AppX içeriği çözümlenemedi.");
  }
}

function main() {
  const appx = findAppx();
  const stat = fs.statSync(appx);
  console.log(`[verify-store-appx] ${path.basename(appx)} (${stat.mtime.toISOString()})`);

  const payload = readEntries(appx);
  const entries = new Map(
    (payload.entries || []).map((entry) => [String(entry.Name || ""), Number(entry.Length) || 0])
  );

  for (const asset of REQUIRED) {
    const size = entries.get(asset);
    if (size == null) {
      fail(`${asset} pakette yok. icon:prepare ve release:store yeniden çalıştırın.`);
    }
    if (size < 500) {
      fail(`${asset} çok küçük (${size} bayt); varsayılan tile olabilir.`);
    }
    console.log(`[verify-store-appx] ${asset} OK (${size} bayt)`);
  }

  const xml = String(payload.manifest || "");
  if (!xml.includes("Square150x150Logo=\"assets\\Square150x150Logo.png\"")) {
    fail("Manifest özel Square150x150Logo yolunu göstermiyor.");
  }
  if (xml.includes("BackgroundColor=\"#464646\"")) {
    console.warn("[verify-store-appx] UYARI: manifest BackgroundColor hâlâ #464646.");
  } else if (xml.includes("BackgroundColor=\"#EA580C\"")) {
    console.log("[verify-store-appx] manifest BackgroundColor #EA580C");
  }

  console.log("[verify-store-appx] Paket tile kontrolü geçti.");
}

main();
