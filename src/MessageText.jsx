import React from "react";
import { EmojiRichText } from "./EmojiRichText.jsx";

/** ">" ile başlayan ardışık satırları alıntı bloğu olarak ayırır (e-posta / markdown alışkanlığı). */
export function splitQuoteBlocks(text) {
  const blocks = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*>\s?(.*)$/.exec(line);
    const quote = Boolean(m);
    const content = m ? m[1] : line;
    const last = blocks[blocks.length - 1];
    if (last && last.quote === quote) last.lines.push(content);
    else blocks.push({ quote, lines: [content] });
  }
  return blocks.map((b) => ({ quote: b.quote, text: b.lines.join("\n") }));
}

/** Seçili metni alıntı satırlarına çevirir: her dolu satırın başına "> ". */
export function toQuoteLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `> ${l}`)
    .join("\n");
}

/** Mesaj metni: alıntı satırları solunda çizgili blok, geri kalanı normal. */
export function MessageText({ text }) {
  const blocks = splitQuoteBlocks(text);
  if (!blocks.some((b) => b.quote)) return <EmojiRichText text={text ?? ""} />;
  return blocks.map((b, i) =>
    b.quote ? (
      <blockquote key={i} className="msg-quote">
        <EmojiRichText text={b.text} />
      </blockquote>
    ) : (
      <EmojiRichText key={i} text={b.text.replace(/^\n+|\n+$/g, "")} />
    )
  );
}
