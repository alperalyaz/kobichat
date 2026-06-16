/**
 * signAndEditExecutable: false kullanıldığında electron-builder exe'ye ikon gömmez.
 * winCodeSign/rcedit zinciri bazı ortamlarda symlink hatası verdiği için
 * paketlemeden sonra yalnızca rcedit ile ikon eklenir.
 * Wine gerektiren ortamlarda (Linux CI) sessizce atlanır.
 */
const fs = require("fs");
const path = require("path");

module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName !== "win32") return;

  const { appOutDir, packager } = context;
  const name = packager.appInfo.productFilename;
  const exe = path.join(appOutDir, `${name}.exe`);
  const ico = path.join(packager.projectDir, "build", "icon.ico");

  if (!fs.existsSync(exe)) {
    console.warn("[afterPack] exe bulunamadı:", exe);
    return;
  }
  if (!fs.existsSync(ico)) {
    console.warn("[afterPack] build/icon.ico yok; npm run icon:prepare çalıştırın.");
    return;
  }

  try {
    const { rcedit } = await import("rcedit");
    await rcedit(exe, { icon: ico });
    console.log("[afterPack] Windows exe ikonu ayarlandı:", path.basename(exe));
  } catch (e) {
    console.warn("[afterPack] İkon ayarlanamadı (Wine eksik olabilir):", e?.message || e);
  }
};
