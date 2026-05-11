/**
 * GitHub yüklemede GH_TOKEN gerekiyor. Bu betik .env.release dosyasından okur (.gitignore’da).
 * Kullanım: Tek satır: GH_TOKEN=ghp_xxxxx
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const envFile = path.join(root, ".env.release");

function log(msg) {
  console.log(`[release:win:local] ${msg}`);
}

let token =
  typeof process.env.GH_TOKEN === "string" ? process.env.GH_TOKEN.trim().replace(/^["']|["']$/g, "") : "";

if (!token && fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, "utf8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^GH_TOKEN\s*=\s*(.+)$/i.exec(t);
    if (m) {
      token = String(m[1])
        .trim()
        .replace(/^["']|["']$/g, "");
      break;
    }
  }
  if (token) log(".env.release dosyasından token okundu.");
} else if (token) {
  log("Ortam değişkeni GH_TOKEN kullanılıyor.");
}

if (!token) {
  console.error(
    "\n[release:win:local] GH_TOKEN bulunamadı.\n\n" +
      "  Projede tam şu dosyayı oluşturun (adı kritik):\n" +
      `    ${envFile}\n\n` +
      "  Tek satır (örnek):\n" +
      "    GH_TOKEN=ghp_sende_olan_token\n\n" +
      "  Notepad bazen yanlış isim kaydeder: \"text.env.release\" veya UTF-16 olur.\n" +
      "  VS Code veya Cursor’da kök klasörde yeni dosya: .env.release\n"
  );
  process.exit(2);
}

process.env.GH_TOKEN = token;

log("Önceki release/ klasörü siliniyor (Windows kilitliyse işlem reddedilir)…");
const cleanRc = spawnSync(process.execPath, [path.join(__dirname, "clean-release.cjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false
});
if (cleanRc.status !== 0) {
  console.error(
    "\n[release:win:local] Temizlik başarısız (exit " +
      cleanRc.status +
      "). Çalışan KobiChat / Explorer penceresi var mı?\n"
  );
  process.exit(cleanRc.status ?? 1);
}

const useShell = process.platform === "win32";
const r = spawnSync("npm run release:win", {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: useShell
});

if (r.error) {
  console.error("[release:win:local] npm çalıştırılamadı:", r.error.message);
  process.exit(1);
}

const code = typeof r.status === "number" ? r.status : 1;
process.exit(code);
