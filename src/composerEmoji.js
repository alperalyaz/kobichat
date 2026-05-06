/**
 * Mesaj yazma alanı: SVG emoji (img) + metin; sunucuya Unicode serileştirme.
 * Sistem fontundan bağımsız tutarlı görünüm (Win7 / Win11 vb.).
 */
import { emojiFileForChar, parseEmojiSegments } from "./emojiMapper.js";

export function emojiAssetBase() {
  const b = import.meta.env.BASE_URL || "./";
  return b.endsWith("/") ? b : `${b}/`;
}

function emojiImgSrc(file) {
  return `${emojiAssetBase()}assets/emojis/${file}`;
}

function createEmojiImg(char) {
  const file = emojiFileForChar(char);
  const img = document.createElement("img");
  img.className = "inline-emoji composer-inline-emoji";
  img.src = emojiImgSrc(file);
  img.alt = "";
  img.draggable = false;
  img.setAttribute("contenteditable", "false");
  img.dataset.emojiChar = char;
  return img;
}

/** @param {HTMLElement} root */
export function serializeComposer(root) {
  if (!root) return "";
  let out = "";

  function walkChildren(parent) {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (i > 0 && kids[i].nodeName === "DIV" && kids[i - 1].nodeName === "DIV") {
        out += "\n";
      }
      walkNode(kids[i]);
    }
  }

  function walkNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
      return;
    }
    if (node.nodeName === "IMG" && node.dataset?.emojiChar) {
      out += node.dataset.emojiChar;
      return;
    }
    if (node.nodeName === "BR") {
      out += "\n";
      return;
    }
    walkChildren(node);
  }

  walkChildren(root);
  return out;
}

/** @param {Range} range */
function serializeRangeContents(range) {
  const frag = range.cloneContents();
  const w = document.createElement("div");
  w.appendChild(frag);
  return serializeComposer(w);
}

/** @param {HTMLElement} editorEl */
export function getCaretSerializedOffset(editorEl) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return 0;
  try {
    const r = document.createRange();
    r.setStart(editorEl, 0);
    r.setEnd(range.startContainer, range.startOffset);
    return serializeRangeContents(r).length;
  } catch {
    return 0;
  }
}

/** @param {HTMLElement} editorEl */
export function setCaretSerializedOffset(editorEl, targetOffset) {
  if (!editorEl) return;
  const target = Math.max(0, targetOffset);
  let acc = 0;
  let placed = false;

  function applyRange(r) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function walkChildren(parent) {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (i > 0 && kids[i].nodeName === "DIV" && kids[i - 1].nodeName === "DIV") {
        acc += 1;
      }
      if (walkNode(kids[i])) return true;
    }
    return false;
  }

  function walkNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent;
      const len = t.length;
      if (acc + len >= target) {
        const r = document.createRange();
        r.setStart(node, Math.min(target - acc, len));
        r.collapse(true);
        applyRange(r);
        placed = true;
        return true;
      }
      acc += len;
      return false;
    }
    if (node.nodeName === "IMG" && node.dataset?.emojiChar) {
      const ch = node.dataset.emojiChar;
      const clen = ch.length;
      if (acc + clen >= target) {
        const r = document.createRange();
        r.setStartAfter(node);
        r.collapse(true);
        applyRange(r);
        placed = true;
        return true;
      }
      acc += clen;
      return false;
    }
    if (node.nodeName === "BR") {
      if (acc >= target) {
        const r = document.createRange();
        r.setStartBefore(node);
        r.collapse(true);
        applyRange(r);
        placed = true;
        return true;
      }
      acc += 1;
      return false;
    }
    return walkChildren(node);
  }

  walkChildren(editorEl);
  if (!placed) {
    const r = document.createRange();
    r.selectNodeContents(editorEl);
    r.collapse(false);
    applyRange(r);
  }
}

/** Bilinen Unicode emoji dizilerini metin düğümlerinde SVG img ile değiştirir. */
export function normalizeUnicodeEmojiInEditor(editorEl) {
  if (!editorEl) return;
  const caret = getCaretSerializedOffset(editorEl);
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.parentNode && n.textContent) textNodes.push(n);
  }
  for (const tn of textNodes) {
    if (!tn.parentNode) continue;
    const segments = parseEmojiSegments(tn.textContent);
    if (segments.length === 1 && segments[0].type === "text") continue;
    const frag = document.createDocumentFragment();
    for (const seg of segments) {
      if (seg.type === "text") frag.appendChild(document.createTextNode(seg.content));
      else frag.appendChild(createEmojiImg(seg.char));
    }
    tn.parentNode.replaceChild(frag, tn);
  }
  const len = serializeComposer(editorEl).length;
  setCaretSerializedOffset(editorEl, Math.min(caret, len));
}

function isComposerEmojiImg(node) {
  return Boolean(node && node.nodeName === "IMG" && node.dataset && node.dataset.emojiChar);
}

/** @param {Range} range */
function findEmojiImgBeforeCaret(range) {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    if (startOffset > 0) return null;
    const prev = startContainer.previousSibling;
    return isComposerEmojiImg(prev) ? prev : null;
  }
  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    if (startOffset === 0) return null;
    const prev = startContainer.childNodes[startOffset - 1];
    return isComposerEmojiImg(prev) ? prev : null;
  }
  return null;
}

/** @param {Range} range */
function findEmojiImgAfterCaret(range) {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    if (startOffset < startContainer.textContent.length) return null;
    const next = startContainer.nextSibling;
    return isComposerEmojiImg(next) ? next : null;
  }
  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    if (startOffset >= startContainer.childNodes.length) return null;
    const next = startContainer.childNodes[startOffset];
    return isComposerEmojiImg(next) ? next : null;
  }
  return null;
}

function removeEmojiImg(img) {
  const parent = img.parentNode;
  if (!parent) return;
  const next = img.nextSibling;
  const prev = img.previousSibling;
  img.remove();
  const sel = window.getSelection();
  const r = document.createRange();
  if (prev && prev.nodeType === Node.TEXT_NODE) {
    r.setStart(prev, prev.textContent.length);
    r.collapse(true);
  } else if (next && next.nodeType === Node.TEXT_NODE) {
    r.setStart(next, 0);
    r.collapse(true);
  } else if (next) {
    r.setStartBefore(next);
    r.collapse(true);
  } else if (prev) {
    r.setStartAfter(prev);
    r.collapse(true);
  } else {
    r.selectNodeContents(parent);
    r.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * SVG emoji `contenteditable=false` img bazı ortamlarda Backspace/Delete ile silinmez; elle kaldırır.
 * @returns {boolean} olay işlendiyse true (preventDefault yapıldı)
 */
export function handleComposerKeyDown(editorEl, e) {
  if (!editorEl) return false;
  if (e.key !== "Backspace" && e.key !== "Delete") return false;
  if (e.defaultPrevented) return false;
  if (e.isComposing) return false;
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return false;
  if (!range.collapsed) return false;

  if (e.key === "Backspace") {
    const img = findEmojiImgBeforeCaret(range);
    if (img && editorEl.contains(img)) {
      e.preventDefault();
      removeEmojiImg(img);
      return true;
    }
  } else {
    const img = findEmojiImgAfterCaret(range);
    if (img && editorEl.contains(img)) {
      e.preventDefault();
      removeEmojiImg(img);
      return true;
    }
  }
  return false;
}

/** Araç çubuğundan: imleç konumuna SVG emoji ekler. */
export function insertEmojiImageAtCaret(editorEl, char) {
  if (!editorEl) return;
  editorEl.focus();
  const img = createEmojiImg(char);
  const sel = window.getSelection();
  let range = null;
  if (sel.rangeCount) {
    range = sel.getRangeAt(0);
  }
  if (!range || !editorEl.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(editorEl);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(img);
  range.setStartAfter(img);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
