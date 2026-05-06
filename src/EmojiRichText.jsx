import React, { useMemo, useState } from "react";
import { parseEmojiSegments } from "./emojiMapper.js";

function emojiAssetBase() {
  const b = import.meta.env.BASE_URL || "./";
  return b.endsWith("/") ? b : `${b}/`;
}

function EmojiInlineImg({ file, char }) {
  const [failed, setFailed] = useState(false);
  const src = `${emojiAssetBase()}assets/emojis/${file}`;

  if (failed) {
    return (
      <span className="inline-emoji-fallback" title={char}>
        {char}
      </span>
    );
  }

  return (
    <img
      className="inline-emoji"
      src={src}
      alt=""
      title={char}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Metin içindeki bilinen emoji karakterlerini yerel SVG ile gösterir.
 * SVG yüklenemezse orijinal karaktere düşer (fallback).
 */
export function EmojiRichText({ text, className }) {
  const segments = useMemo(() => parseEmojiSegments(text ?? ""), [text]);

  return (
    <span className={className}>
      {segments.map((seg, idx) =>
        seg.type === "text" ? (
          <span key={`t-${idx}`}>{seg.content}</span>
        ) : (
          <EmojiInlineImg key={`e-${idx}-${seg.file}`} file={seg.file} char={seg.char} />
        )
      )}
    </span>
  );
}
