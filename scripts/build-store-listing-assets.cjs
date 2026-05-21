/**
 * Partner Center Store listings → Store logos alanına yüklenecek PNG'ler.
 */
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const ICON = path.join(ROOT, "build", "icon.png");
const OUT = path.join(ROOT, "build", "store-listing");

const TILE_BG = { r: 234, g: 88, b: 12, alpha: 1 };

async function square(size) {
  const pad = Math.max(6, Math.round(size * 0.08));
  const inner = size - pad * 2;
  const logo = await sharp(ICON)
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
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

async function main() {
  if (!fs.existsSync(ICON)) {
    console.warn("[store-listing-assets] build/icon.png yok, atlanıyor.");
    return;
  }

  await fs.promises.mkdir(OUT, { recursive: true });

  const assets = [
    ["store-logo-300x300.png", 300],
    ["square-icon-150x150.png", 150]
  ];

  for (const [name, size] of assets) {
    const buf = await square(size);
    await fs.promises.writeFile(path.join(OUT, name), buf);
    console.log(`[store-listing-assets] ${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
