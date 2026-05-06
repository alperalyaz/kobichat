/**
 * Standart Unicode emoji → public/assets/emojis/*.svg eşlemesi.
 * Uzun diziler önce eşleşir (ör. ❤️ önce ❤).
 */

const RAW_ENTRIES = [
  ["❤️", "heart.svg"],
  ["😂", "laugh.svg"],
  ["😀", "grinning.svg"],
  ["👏", "clap.svg"],
  ["👍", "thumbs-up.svg"],
  ["🙏", "folded-hands.svg"],
  ["🎉", "party.svg"],
  ["🔥", "fire.svg"],
  ["😠", "angry.svg"],
  ["😭", "crying.svg"],
  ["✅", "check.svg"],
  ["❌", "cross.svg"],
  ["❤", "heart.svg"]
];

/** @type {{ seq: string; file: string }[]} */
export const EMOJI_MAP_SORTED = RAW_ENTRIES.map(([seq, file]) => ({ seq, file })).sort(
  (a, b) => b.seq.length - a.seq.length
);

export const KNOWN_EMOJI_FILES = new Set(RAW_ENTRIES.map(([, f]) => f));

/** Mesaj kutusu araç çubuğu: labelKey → i18n (messages.js) */
export const EMOJI_QUICK_PICK = [
  { char: "😀", labelKey: "emojiJoy" },
  { char: "😂", labelKey: "emojiLaugh" },
  { char: "❤️", labelKey: "emojiHeart" },
  { char: "✅", labelKey: "emojiOk" },
  { char: "❌", labelKey: "emojiCross" },
  { char: "👏", labelKey: "emojiClap" },
  { char: "👍", labelKey: "emojiThumbsUp" },
  { char: "🙏", labelKey: "emojiThanks" },
  { char: "🎉", labelKey: "emojiParty" },
  { char: "🔥", labelKey: "emojiFire" },
  { char: "😭", labelKey: "emojiCry" },
  { char: "😠", labelKey: "emojiAngry" }
];

/**
 * Araç çubuğu için: karakter → dosya adı (bilinmeyense güvenli varsayılan)
 * @param {string} char
 */
export function emojiFileForChar(char) {
  for (const { seq, file } of EMOJI_MAP_SORTED) {
    if (seq === char) return file;
  }
  return "grinning.svg";
}

/**
 * Metni metin ve emoji parçalarına böler (yalnızca haritada olanlar).
 * @param {string} text
 * @returns {({ type: 'text'; content: string } | { type: 'emoji'; file: string; char: string })[]}
 */
export function parseEmojiSegments(text) {
  if (!text) return [];
  const out = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    let matched = false;
    for (const { seq, file } of EMOJI_MAP_SORTED) {
      if (text.startsWith(seq, i)) {
        out.push({ type: "emoji", file, char: seq });
        i += seq.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const cp = text.codePointAt(i);
      const w = cp !== undefined && cp > 0xffff ? 2 : 1;
      out.push({ type: "text", content: text.slice(i, i + w) });
      i += w;
    }
  }
  return out;
}
