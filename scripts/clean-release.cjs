/**
 * release/ klasörünü siler (electron-builder öncesi kilit/artık dosya temizliği).
 * KobiChat veya başka bir süreç app.asar dosyasını kilitliyse silme başarısız olur — o zaman uygulamayı kapatın.
 */
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "release");
if (fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("[clean-release] release/ silindi.");
} else {
  console.log("[clean-release] release/ yok, atlanıyor.");
}
