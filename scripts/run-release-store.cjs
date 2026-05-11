/**
 * Microsoft Store AppX paketi üretir (GitHub yayını yapmaz).
 * Partner Center → Manage packages ekranına yüklenecek .appx çıktısı release-store/ altında oluşur.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const identityPath = path.join(root, "build", "store-identity.json");

function log(msg) {
  console.log(`[release:store] ${msg}`);
}

function readStoreIdentity() {
  if (!fs.existsSync(identityPath)) {
    throw new Error(`Store kimlik dosyası bulunamadı: ${identityPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const id = parsed?.packageIdentity || {};
  const name = String(id.name || "").trim();
  const publisher = String(id.publisher || "").trim();
  const publisherDisplayName = String(id.publisherDisplayName || "").trim();
  if (!name || !publisher || !publisherDisplayName) {
    throw new Error("build/store-identity.json içinde name/publisher/publisherDisplayName eksik.");
  }
  return { name, publisher, publisherDisplayName };
}

function runNodeScript(relPath) {
  const rc = spawnSync(process.execPath, [path.join(root, relPath)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false
  });
  if (rc.status !== 0) {
    throw new Error(`${relPath} başarısız (exit ${rc.status ?? 1})`);
  }
}

function runNpmScript(scriptName) {
  const useShell = process.platform === "win32";
  const rc = spawnSync("npm", ["run", scriptName], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: useShell
  });
  if (rc.status !== 0) {
    throw new Error(`npm run ${scriptName} başarısız (exit ${rc.status ?? 1})`);
  }
}

function main() {
  if (process.platform !== "win32") {
    console.error("[release:store] Store AppX paketi yalnızca Windows üzerinde üretilebilir.");
    process.exit(2);
  }

  const identity = readStoreIdentity();
  log("Önceki release-store-out/ klasörü siliniyor…");
  const cleanRc = spawnSync(process.execPath, [path.join(root, "scripts/clean-release-store.cjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false
  });
  if (cleanRc.status !== 0) {
    log(
      "UYARI: release-store-out/ temizlenemedi; kilitli dosya olabilir. Derlemeye devam ediliyor (electron-builder mevcut çıktının üzerine yazabilir)."
    );
  }

  runNpmScript("build");
  runNpmScript("icon:prepare");

  const builderArgs = [
    "electron-builder",
    "--win",
    "appx",
    "--x64",
    "--publish",
    "never",
    "-c.directories.output=release-store-out",
    "-c.extraMetadata.kobichatDistribution=store",
    `-c.appx.identityName=${identity.name}`,
    `-c.appx.publisher=${identity.publisher}`,
    `-c.appx.publisherDisplayName=${identity.publisherDisplayName}`
  ];

  log("AppX paketi derleniyor (GitHub yayını yok)…");
  const builderEnv = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false"
  };
  const rc = spawnSync("npx", builderArgs, {
    cwd: root,
    env: builderEnv,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (rc.error) {
    console.error("[release:store] electron-builder çalıştırılamadı:", rc.error.message);
    process.exit(1);
  }
  if (rc.status !== 0) {
    process.exit(typeof rc.status === "number" ? rc.status : 1);
  }

  log("Tamam. Partner Center → Manage packages ekranına release-store-out/ altındaki .appx dosyasını yükleyin.");
}

try {
  main();
} catch (e) {
  console.error("[release:store]", e?.message || e);
  process.exit(1);
}
