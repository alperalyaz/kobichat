/**
 * release/ klasörünü siler (electron-builder öncesi kilit/artık dosya temizliği).
 * KobiChat veya başka bir süreç app.asar dosyasını kilitliyse silme başarısız olur — o zaman uygulamayı kapatın.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "..", "release-build");

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

if (!fs.existsSync(dir)) {
  console.log("[clean-release] release-build/ yok, atlanıyor.");
  process.exit(0);
}

const maxTry = 8;
let lastErr = null;
for (let i = 1; i <= maxTry; i += 1) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log("[clean-release] release-build/ silindi.");
    process.exit(0);
  } catch (err) {
    lastErr = err;
    if (!isRetryable(err) || i === maxTry) break;
    const wait = i * 700;
    console.warn(`[clean-release] silme denemesi ${i}/${maxTry} başarısız (${err.code}), ${wait}ms sonra tekrar denenecek...`);
    sleepMs(wait);
  }
}

throw lastErr;
