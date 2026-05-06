/**
 * KobiChat sürüm kuralı (MAJOR.MINOR.PATCH):
 * - PATCH 0–10 aralığında kalır; bir sonraki artış PATCH'i 10'u geçerse MINOR +1, PATCH 0 olur.
 *   Örnek: 1.0.9 → 1.0.10 → 1.1.0 (1.0.11 yok).
 * - Mevcut sürümde PATCH > 10 ise (ör. 1.0.12), önce normalize edilir: MINOR taşınır, PATCH 10 altına indirilir.
 *   Örnek: 1.0.12 → 1.1.2, sonra bump → 1.1.3.
 *
 * Kullanım: node scripts/bump-version.cjs [--dry-run]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const PKG_PATH = path.join(__dirname, "..", "package.json");

function parseSemver(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Geçersiz sürüm: ${JSON.stringify(v)} (MAJOR.MINOR.PATCH beklenir)`);
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** PATCH > 10 iken MINOR'a taşır (1.0.12 → 1.1.2). */
function normalizeVersion(major, minor, patch) {
  let mi = minor;
  let pa = patch;
  while (pa > 10) {
    mi += 1;
    pa -= 10;
  }
  return [major, mi, pa];
}

/** PATCH artırır; sonuç 10'u geçerse MINOR +1, PATCH 0. */
function bumpPatch(major, minor, patch) {
  const next = patch + 1;
  if (next > 10) {
    return [major, minor + 1, 0];
  }
  return [major, minor, next];
}

function formatVersion(major, minor, patch) {
  return `${major}.${minor}.${patch}`;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const raw = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
  const before = raw.version;
  let [maj, min, pat] = parseSemver(before);
  [maj, min, pat] = normalizeVersion(maj, min, pat);
  [maj, min, pat] = bumpPatch(maj, min, pat);
  const after = formatVersion(maj, min, pat);

  if (dryRun) {
    console.log(`${before} → ${after} (dry-run)`);
    return;
  }

  raw.version = after;
  fs.writeFileSync(PKG_PATH, JSON.stringify(raw, null, 2) + "\n", "utf8");
  console.log(`Sürüm güncellendi: ${before} → ${after}`);
}

main();
