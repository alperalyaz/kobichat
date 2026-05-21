/**
 * Microsoft Store AppX tile görselleri (build/appx/).
 * electron-builder özel asset verilmezse varsayılan tile kullanır; 10.1.1.11 reddine yol açar.
 */
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const ICON = path.join(ROOT, "build", "icon.png");
const OUT = path.join(ROOT, "build", "appx");

const TILE_BG = { r: 234, g: 88, b: 12, alpha: 1 };
const WIDE_GRADIENT_STOPS = [
  { offset: 0, color: "#ea580c" },
  { offset: 1, color: "#fb923c" }
];

async function logoPng(size) {
  return sharp(ICON)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
}

async function squareTile(size) {
  const pad = Math.max(4, Math.round(size * 0.08));
  const inner = size - pad * 2;
  const logo = await logoPng(inner);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: TILE_BG
    }
  })
    .composite([{ input: logo, left: pad, top: pad }])
    .png()
    .toBuffer();
}

async function wideTile() {
  const w = 310;
  const h = 150;
  const logo = await logoPng(96);
  const bgSvg = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="wg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${WIDE_GRADIENT_STOPS[0].color}"/>
      <stop offset="100%" stop-color="${WIDE_GRADIENT_STOPS[1].color}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#wg)"/>
</svg>`
  );
  return sharp(bgSvg)
    .composite([{ input: logo, left: 24, top: Math.floor((h - 96) / 2) }])
    .png()
    .toBuffer();
}

async function splashScreen() {
  const w = 620;
  const h = 300;
  const logo = await logoPng(180);
  const bgSvg = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ea580c"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sg)"/>
</svg>`
  );
  return sharp(bgSvg)
    .composite([{ input: logo, left: Math.floor((w - 180) / 2), top: Math.floor((h - 180) / 2) }])
    .png()
    .toBuffer();
}

async function main() {
  if (!fs.existsSync(ICON)) {
    console.warn("[appx-assets] build/icon.png yok, atlanıyor.");
    return;
  }

  await fs.promises.mkdir(OUT, { recursive: true });

  const tiles = [
    ["StoreLogo.png", () => squareTile(50)],
    ["Square44x44Logo.png", () => squareTile(44)],
    ["Square150x150Logo.png", () => squareTile(150)],
    ["LargeTile.png", () => squareTile(310)],
    ["SmallTile.png", () => squareTile(71)],
    ["BadgeLogo.png", () => squareTile(24)],
    ["Wide310x150Logo.png", wideTile],
    ["SplashScreen.png", splashScreen]
  ];

  for (const [name, build] of tiles) {
    const buf = await build();
    await fs.promises.writeFile(path.join(OUT, name), buf);
    console.log(`[appx-assets] ${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
