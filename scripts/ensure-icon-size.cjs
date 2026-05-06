/**
 * electron-builder Windows ikonu için PNG en az 256x256 olmalı.
 * Küçükse 512x512'ye contain ile ölçekler (şeffaf değilse açık gri dolgu).
 */
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const MIN = 256;
const TARGET = 512;
const buildIcon = path.join(__dirname, "..", "build", "icon.png");
const publicIcon = path.join(__dirname, "..", "public", "icon.png");

async function ensureOne(p) {
  if (!fs.existsSync(p)) {
    console.warn(`[icon] yok: ${p}`);
    return;
  }
  const meta = await sharp(p).metadata();
  if (meta.width >= MIN && meta.height >= MIN) {
    console.log(`[icon] ${path.basename(p)} ${meta.width}x${meta.height} — OK`);
    return;
  }
  const bg =
    meta.hasAlpha === true
      ? { r: 0, g: 0, b: 0, alpha: 0 }
      : { r: 245, g: 245, b: 245, alpha: 1 };
  const buf = await sharp(p)
    .resize(TARGET, TARGET, {
      fit: "contain",
      background: bg
    })
    .png()
    .toBuffer();
  await fs.promises.writeFile(p, buf);
  console.log(`[icon] ${path.basename(p)} ${meta.width}x${meta.height} → ${TARGET}x${TARGET}`);
}

async function writeIcoFromPng() {
  if (!fs.existsSync(buildIcon)) return;
  const pngToIco = require("png-to-ico");
  const ico = await pngToIco(buildIcon);
  const icoPath = path.join(__dirname, "..", "build", "icon.ico");
  await fs.promises.writeFile(icoPath, ico);
  console.log("[icon] build/icon.ico güncellendi");
}

async function main() {
  await ensureOne(buildIcon);
  await ensureOne(publicIcon);
  await writeIcoFromPng();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
