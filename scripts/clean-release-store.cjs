/**
 * release-store/ klasörünü siler (Store AppX paketi öncesi).
 * KobiChat veya Explorer klasörü kilitlemişse önce süreçleri kapatmayı dener.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "..", "release-store-out");

function isRetryable(err) {
  const code = String(err?.code || "");
  return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Seconds ${seconds}`], {
      stdio: "ignore",
      shell: false
    });
    return;
  }
  spawnSync("sleep", [String(seconds)], { stdio: "ignore", shell: false });
}

function stopKobiChatProcesses() {
  if (process.platform !== "win32") return;
  spawnSync("taskkill", ["/IM", "KobiChat.exe", "/T", "/F"], {
    stdio: "ignore",
    shell: false
  });
}

function removeWithPowerShell(targetDir) {
  if (process.platform !== "win32") return false;
  const ps = `Remove-Item -LiteralPath ${JSON.stringify(targetDir)} -Recurse -Force -ErrorAction Stop`;
  const rc = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    stdio: "ignore",
    shell: false
  });
  return rc.status === 0;
}

function printLockHelp() {
  console.error(
    [
      "[clean-release-store] release-store-out/ silinemedi (dosya kilitli).",
      "KobiChat pencerelerini kapatın, Görev Yöneticisi'nde KobiChat.exe kalmadığından emin olun.",
      "release-store klasörünü açık tutan Explorer penceresini kapatın, npm run dev çalışıyorsa durdurun.",
      "Gerekirse bilgisayarı yeniden başlatıp komutu tekrar deneyin."
    ].join("\n")
  );
}

if (!fs.existsSync(dir)) {
  console.log("[clean-release-store] release-store-out/ yok, atlanıyor.");
  process.exit(0);
}

stopKobiChatProcesses();
sleepMs(400);

const maxTry = 8;
let lastErr = null;
for (let i = 1; i <= maxTry; i += 1) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log("[clean-release-store] release-store-out/ silindi.");
    process.exit(0);
  } catch (err) {
    lastErr = err;
    if (!isRetryable(err) || i === maxTry) break;
    const wait = i * 700;
    console.warn(
      `[clean-release-store] silme denemesi ${i}/${maxTry} başarısız (${err.code}), ${wait}ms sonra tekrar denenecek...`
    );
    sleepMs(wait);
  }
}

if (removeWithPowerShell(dir)) {
  console.log("[clean-release-store] release-store-out/ silindi (PowerShell).");
  process.exit(0);
}

printLockHelp();
process.exit(1);
