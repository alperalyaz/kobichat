/** Pano notu türleri (ikon + renk); etiketler i18n'den. */
export const NOTE_KINDS = [
  { v: "", icon: "", color: "", tkey: "boardKindPlain" },
  { v: "info", icon: "ℹ️", color: "#0891b2", tkey: "boardKindInfo" },
  { v: "warning", icon: "⚠️", color: "#f59e0b", tkey: "boardKindWarning" },
  { v: "important", icon: "❗", color: "#dc2626", tkey: "boardKindImportant" },
  { v: "success", icon: "✅", color: "#059669", tkey: "boardKindSuccess" },
  { v: "note", icon: "📌", color: "#7c3aed", tkey: "boardKindNote" }
];

export function noteKind(v) {
  return NOTE_KINDS.find((k) => k.v === v) ?? NOTE_KINDS[0];
}

/** Zamanlı bildirim türleri. */
export const SCHED_KINDS = [
  { v: "work", icon: "☀️", color: "#f59e0b", tkey: "boardSchedWork" },
  { v: "celebrate", icon: "🎉", color: "#e11d48", tkey: "boardSchedCelebrate" },
  { v: "birthday", icon: "🎂", color: "#9333ea", tkey: "boardSchedBirthday" },
  { v: "info", icon: "ℹ️", color: "#0891b2", tkey: "boardSchedInfo" },
  { v: "announce", icon: "📢", color: "#0891b2", tkey: "boardSchedAnnounce" },
  { v: "thanks", icon: "❤️", color: "#dc2626", tkey: "boardSchedThanks" },
  { v: "success", icon: "✅", color: "#059669", tkey: "boardSchedSuccess" }
];

export function schedKind(v) {
  return SCHED_KINDS.find((k) => k.v === v) ?? SCHED_KINDS[3];
}

/** Aylık menü JSON'u: {"yil":2026,"ay":5,"gunler":[{"gun":1,"yemek1":"..."}]} */
export function parseMonthly(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, value: null };
  try {
    const v = JSON.parse(s);
    const yil = Number(v?.yil);
    const ay = Number(v?.ay);
    if (!Number.isFinite(yil) || yil < 2000 || yil > 2100) return { ok: false };
    if (!Number.isFinite(ay) || ay < 1 || ay > 12) return { ok: false };
    if (!Array.isArray(v.gunler)) return { ok: false };
    return { ok: true, value: v };
  } catch {
    return { ok: false };
  }
}

/** Bugünün 4 yemek hücresi; bugün için kayıt yoksa null. */
export function mealCellsForToday(raw) {
  const { value } = parseMonthly(raw);
  if (!value) return null;
  const d = new Date();
  if (Number(value.yil) !== d.getFullYear() || Number(value.ay) !== d.getMonth() + 1) return null;
  const row = value.gunler.find((g) => Number(g?.gun) === d.getDate());
  if (!row) return null;
  const cells = ["yemek1", "yemek2", "yemek3", "yemek4"].map((k) => String(row[k] ?? "").trim());
  return cells.some(Boolean) ? cells : null;
}

/** Görseli küçültüp JPEG data URL'e çevirir (sunucu sınırı ~1.5 MB). */
export function shrinkImageFile(file, maxW = 1000, maxH = 1000) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image"));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Pazartesiden başlayan gün sırası (Date.getDay değerleri). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function weekdayShort(locale, day) {
  // 2024-01-07 bir Pazar.
  const d = new Date(2024, 0, 7 + day);
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  } catch {
    return String(day);
  }
}

export function newLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
