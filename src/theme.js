const THEME_KEY = "kobiChatTheme";
const LEGACY_THEME_KEY = "lanChatTheme";

export function getStoredTheme() {
  if (typeof window === "undefined") return "light";
  let v = localStorage.getItem(THEME_KEY);
  if (v == null) {
    v = localStorage.getItem(LEGACY_THEME_KEY);
    if (v != null) localStorage.setItem(THEME_KEY, v);
  }
  return v === "dark" ? "dark" : "light";
}

export function setStoredTheme(mode) {
  if (typeof window === "undefined") return;
  localStorage.setItem(THEME_KEY, mode === "dark" ? "dark" : "light");
}

export function applyThemeToDocument(mode) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", mode === "dark" ? "dark" : "light");
}

export function conversationId(uuidA, uuidB) {
  const [x, y] = [String(uuidA || ""), String(uuidB || "")].sort();
  return `dm:${x}:${y}`;
}

/** dm:uuidA:uuidB içinden karşı tarafın clientUuid değeri */
export function peerClientUuidFromConvId(convId, myClientUuid) {
  if (!convId || typeof convId !== "string" || !convId.startsWith("dm:")) return "";
  const rest = convId.slice(3);
  const idx = rest.indexOf(":");
  if (idx === -1) return "";
  const a = rest.slice(0, idx).trim();
  const b = rest.slice(idx + 1).trim();
  const my = String(myClientUuid || "").trim();
  if (a === my) return b;
  if (b === my) return a;
  return "";
}

/**
 * Sohbet penceresi için gelen mesajın bu DM’e ait olduğunu doğrular.
 * - peerUuid: URL’deki karşı taraf (peerUuid).
 * - myClientUuid boşken: conv_id içinde peer katılımcıysa kabul (köprü/socket:context yarışı).
 * - myClientUuid doluyken: diğer segment “ben” olmalı (yanlış konuşmaya düşmeyi engeller).
 */
export function isDmConvForPeerAndMe(convId, peerUuid, myClientUuid) {
  if (!convId || typeof convId !== "string" || !convId.startsWith("dm:")) return false;
  const rest = convId.slice(3);
  const idx = rest.indexOf(":");
  if (idx === -1) return false;
  const a = rest.slice(0, idx).trim();
  const b = rest.slice(idx + 1).trim();
  const peer = String(peerUuid || "").trim();
  if (!peer) return false;
  if (a !== peer && b !== peer) return false;
  const my = String(myClientUuid || "").trim();
  if (!my) return true;
  const other = a === peer ? b : a;
  return other === my;
}
