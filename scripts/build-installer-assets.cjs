/**
 * NSIS: installer-sidebar (164×314) ve installer-header (150×57) PNG üretir.
 * build/icon.png kaynak; package.json sürümü metne yazılır.
 */
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const ICON = path.join(ROOT, "build", "icon.png");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = String(PKG.version || "0.0.0");

const SIDEBAR_W = 164;
const SIDEBAR_H = 314;
const HEADER_W = 150;
const HEADER_H = 57;

async function main() {
  if (!fs.existsSync(ICON)) {
    console.warn("[installer-assets] build/icon.png yok, atlanıyor.");
    return;
  }

  const logoBuf = await sharp(ICON)
    .resize(120, 120, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  const logoSmallBuf = await sharp(ICON)
    .resize(40, 40, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  const sidebarSvg = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${SIDEBAR_W}" height="${SIDEBAR_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fb923c"/>
      <stop offset="100%" stop-color="#c2410c"/>
    </linearGradient>
  </defs>
  <rect width="${SIDEBAR_W}" height="${SIDEBAR_H}" fill="url(#sg)"/>
  <text x="${SIDEBAR_W / 2}" y="248" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff">KobiChat</text>
  <text x="${SIDEBAR_W / 2}" y="272" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#ffedd5">v${escapeXml(VERSION)}</text>
</svg>`
  );

  const headerSvg = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${HEADER_W}" height="${HEADER_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="hg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ea580c"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
  </defs>
  <rect width="${HEADER_W}" height="${HEADER_H}" fill="url(#hg)"/>
  <text x="52" y="24" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">KobiChat</text>
  <text x="52" y="42" font-family="Segoe UI, Arial, sans-serif" font-size="10" fill="#ffedd5">v${escapeXml(VERSION)}</text>
</svg>`
  );

  const sidebarPath = path.join(ROOT, "build", "installer-sidebar.png");
  const headerPath = path.join(ROOT, "build", "installer-header.png");

  await sharp(sidebarSvg)
    .composite([{ input: logoBuf, left: Math.floor((SIDEBAR_W - 120) / 2), top: 28 }])
    .png()
    .toFile(sidebarPath);

  await sharp(headerSvg)
    .composite([{ input: logoSmallBuf, left: 8, top: Math.floor((HEADER_H - 40) / 2) }])
    .png()
    .toFile(headerPath);

  console.log(`[installer-assets] ${path.basename(sidebarPath)}, ${path.basename(headerPath)} (v${VERSION})`);
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
