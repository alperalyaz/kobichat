/** Yerel profilde 7 hazır mesaj (Ctrl+1 … Ctrl+7). */
export const QUICK_MSG_COUNT = 7;

const STORAGE_KEY = "kobichat_quick_messages_v1";

export function defaultQuickMessages() {
  return Array.from({ length: QUICK_MSG_COUNT }, () => "");
}

/**
 * @returns {string[]}
 */
export function loadQuickMessages() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultQuickMessages();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return defaultQuickMessages();
    const out = arr.slice(0, QUICK_MSG_COUNT);
    while (out.length < QUICK_MSG_COUNT) out.push("");
    return out.map((s) => String(s ?? "").slice(0, 2000));
  } catch {
    return defaultQuickMessages();
  }
}

/**
 * @param {unknown[]} messages
 */
export function saveQuickMessages(messages) {
  const normalized = defaultQuickMessages().map((_, i) =>
    String(messages?.[i] ?? "").slice(0, 2000)
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignored
  }
}
