import React from "react";

/**
 * Native emoji rendering (OS standard glyphs).
 * Bu sayede kullanıcıların alışık olduğu platform emojileri görünür.
 */
export function EmojiRichText({ text, className }) {
  return <span className={className}>{text ?? ""}</span>;
}
