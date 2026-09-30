import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyThemeToDocument,
  conversationId,
  getStoredTheme,
  isDmConvForPeerAndMe,
  normalizeClientUuid
} from "./theme.js";
import { EmojiRichText } from "./EmojiRichText.jsx";
import { MessageText, toQuoteLines } from "./MessageText.jsx";
import { EMOJI_QUICK_PICK } from "./emojiMapper.js";
import { LANGS, MESSAGES } from "./i18n/messages.js";
import { detectBrowserLang, normalizeLang, useI18n } from "./i18n/I18nContext.jsx";
import { KOBI_BRIDGE } from "./socketBridge.js";
import {
  handleComposerKeyDown,
  insertEmojiImageAtCaret,
  normalizeUnicodeEmojiInEditor,
  serializeComposer
} from "./composerEmoji.js";
import { QUICK_MSG_COUNT, loadQuickMessages, saveQuickMessages } from "./quickMessagesStorage.js";
import { bootstrapSoundPrefs, playSound, preloadAllSounds } from "./sounds.js";

const WEB_SETTINGS_KEY = "kobiChatWebSettings";
/** Otomatik scroll'ın "kullanıcı dipte" sayılması için tolerans payı (px). */
const NEAR_BOTTOM_THRESHOLD_PX = 80;

/** Geçmiş modalında gösterilecek en fazla “önceki gün” mesajı (son N). Sunucu HISTORY_LIMIT (500) ile eşleştirildi. */
const PAST_HISTORY_DISPLAY_LIMIT = 500;

/**
 * Kullanıcının scroll-container'da gerçekten dibe yakın olup olmadığını ölçer.
 * Yeni mesaj geldiğinde dibe sıçramayı YALNIZCA buradayken yapacağız;
 * geçmişe bakıyorsa pencere yerinden oynamaz.
 */
function isUserNearBottom(el, thresholdPx = NEAR_BOTTOM_THRESHOLD_PX) {
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= thresholdPx;
}

function loadWebSettings() {
  try {
    const raw = localStorage.getItem(WEB_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readBrowserSocketUrlFromQuery() {
  try {
    const p = new URLSearchParams(window.location.search);
    const q = String(p.get("socketUrl") || "").trim();
    return q ? normalizeBase(q) : "";
  } catch {
    return "";
  }
}

function normalizeBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

function uniqueNormalizedUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const u of urls || []) {
    const n = normalizeBase(u);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function uploadTimeoutMsForFile(file) {
  const size = Number(file?.size || 0);
  const mb = Math.max(1, Math.ceil(size / (1024 * 1024)));
  // Küçük dosyalarda en az 60sn, büyük dosyalarda kademeli artış (max 5dk)
  return Math.min(5 * 60 * 1000, 60 * 1000 + mb * 2500);
}

function isImageMime(m) {
  return typeof m === "string" && m.startsWith("image/");
}

function isInlinePreviewableMime(m) {
  if (isImageMime(m)) return true;
  if (typeof m !== "string") return false;
  const mime = m.toLowerCase();
  if (mime === "application/pdf") return true;
  /**
   * `text/html` ve `text/xml` iframe içinde script çalıştırabildiği için
   * doğrudan önizlemeye almıyoruz; sadece düz metin türleri güvenlidir.
   */
  if (mime === "text/plain" || mime === "text/csv" || mime === "text/markdown") return true;
  return false;
}

/** Metin tabanlı önizleme (iframe yerine içeriği kendimiz çiziyoruz). */
function isTextPreviewMime(m) {
  if (typeof m !== "string") return false;
  const mime = m.toLowerCase();
  return mime === "text/plain" || mime === "text/csv" || mime === "text/markdown";
}

/** Önizlemede okunacak en fazla bayt ve CSV'de gösterilecek en fazla satır. */
const TEXT_PREVIEW_MAX_BYTES = 1000000;
const CSV_PREVIEW_MAX_ROWS = 500;

/**
 * Baytları metne çevirir. UTF-8 BOM temizlenir; dosya geçerli UTF-8 değilse
 * windows-1254'e düşülür (Excel'in ürettiği Türkçe CSV'ler çoğunlukla böyledir,
 * aksi halde ş/ğ/İ gibi harfler bozuk görünürdü).
 */
function decodeTextBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("windows-1254").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

/** Ayiriciyi ilk satira bakarak tahmin eder (Turkce Excel ';' kullanir). */
function sniffCsvDelimiter(text) {
  const nl = text.indexOf("\n");
  const first = nl >= 0 ? text.slice(0, nl) : text;
  let best = ",";
  let bestCount = 0;
  for (const d of [";", ",", "\t", "|"]) {
    const c = first.split(d).length - 1;
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/** Tirnakli alanlari ve alan ici ayirici/satir sonlarini dogru isleyen CSV cozumleyici. */
function parseCsv(text, maxRows) {
  const delim = sniffCsvDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
      continue;
    }
    if (c === "\r") continue;
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function formatFileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(2)} MB` : `${mb.toFixed(1)} MB`;
}

function normalizePossiblyMojibakeFilename(name) {
  const raw = String(name || "");
  if (!raw) return "";
  if (!/[ÃÄÅÇÐÑÕÖÜ]/.test(raw)) return raw;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
      Uint8Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff)
    );
    return decoded.includes("�") ? raw : decoded;
  } catch {
    return raw;
  }
}

function formatMsgTime(iso, dateLocale) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(dateLocale || "tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Yerel dolunay (00:00) — ana şeritte “bugün+dün” ayrımı için */
function startOfLocalCalendarDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Ana sohbet gövdesinin başlangıç zamanı (yerelde dünün 00:00'ı dahil).
 * Yalnızca “tam bugün”e göre filtre yapılırsa sunucu/istemci saat sapmasıyla mesaj yanlışlıkla yalnızca
 * “Geçmiş” modalında kalır ve kullanıcı bildirimi duyar ama yazı göremez.
 */
function mainConversationStripStartsAtLocal() {
  const s = startOfLocalCalendarDay(new Date());
  s.setDate(s.getDate() - 1);
  return s;
}

function calendarDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

function sameLocalCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayDividerLabel(iso, locale, t) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameLocalCalendarDay(d, today)) return t("chatDayToday");
  if (sameLocalCalendarDay(d, yesterday)) return t("chatDayYesterday");
  return d.toLocaleDateString(locale || "tr-TR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function groupMessagesByDay(messages, t, locale) {
  if (!messages.length) return [];
  const out = [];
  let curKey = null;
  for (const m of messages) {
    const k = calendarDayKey(m.created_at);
    if (k !== curKey) {
      curKey = k;
      out.push({
        dayKey: k,
        label: dayDividerLabel(m.created_at, locale, t),
        messages: [m]
      });
    } else {
      out[out.length - 1].messages.push(m);
    }
  }
  return out;
}

/**
 * Sunucunun atadığı numerik id (monotonik artar) → sıralamanın TEK doğru
 * kaynağı. Optimistik mesajlar "local-…" id taşır ve henüz sunucu id'si yok.
 */
function serverIdOrNull(m) {
  const s = String(m?.id ?? "");
  if (!s || s.startsWith("local-")) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sıralama: created_at (zaman damgası) ile sıralamak istemci/sunucu saat
 * farkında (clock skew) mesajları birbirinin üstüne atlatıyordu — özellikle
 * dosya mesajlarının optimistik karşılığı olmadığından yalnızca sunucu
 * saatiyle geliyorlar. Bunun yerine sunucu id'sine göre sırala; iki mesaj da
 * onaylıysa id kararı verir (saatten bağımsız). Onaylı mesaj her zaman
 * optimistik (henüz gönderim onayı gelmemiş, en yeni) mesajın üstünde kalır.
 */
/**
 * Onaylanmamış (henüz sunucuya ulaşmamış) gönderim. Titreşim gibi yerel SİSTEM
 * bildirimleri buna dahil DEĞİLDİR: onlar kalıcı kayıtlardır ve zaman sırasına
 * göre araya girmelidir.
 */
function isPendingOptimistic(m) {
  const s = String(m?.id ?? "");
  if (!s.startsWith("local-")) return false;
  return String(m?.kind || "").toLowerCase() !== "system";
}

function msgTimeMs(m) {
  const t = new Date(m?.created_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Sıralama: birincil anahtar zaman, eşitlikte sunucu id'si (aynı milisaniyede
 * gelen mesajlar için kesin sıra). Onaylanmamış optimistik gönderimler ise —
 * sunucu id'leri olmadığından ve tanım gereği en yeni olduklarından — her
 * zaman en sonda tutulur.
 *
 * Eskiden TÜM "local-" kayıtlar en alta sabitleniyordu; bu yüzden titreşim
 * bildirimleri kendilerinden sonra yazılan mesajların altında kalıyordu.
 */
function messageOrderComparator(a, b) {
  const ap = isPendingOptimistic(a);
  const bp = isPendingOptimistic(b);
  if (ap !== bp) return ap ? 1 : -1;
  const at = msgTimeMs(a);
  const bt = msgTimeMs(b);
  if (at !== bt) return at - bt;
  const ai = serverIdOrNull(a);
  const bi = serverIdOrNull(b);
  if (ai != null && bi != null) return ai - bi;
  return 0;
}

/** Sunucudan gelen geçmiş ile ekrandaki (message:new ile eklenen) mesajları birleştirir; geç gelen history yanıtı yeni mesajları silmez. */
function mergeMessageListsById(incoming, previous) {
  const map = new Map();
  for (const m of incoming) {
    if (m?.id != null) map.set(String(m.id), m);
  }
  for (const m of previous) {
    if (m?.id != null && !map.has(String(m.id))) map.set(String(m.id), m);
  }
  return Array.from(map.values()).sort(messageOrderComparator);
}

function clampDisplayName(s) {
  return String(s ?? "")
    .trim()
    .slice(0, 21);
}

const MSG_CACHE_PREFIX = "kobiChatMsgCache_v1_";
const MSG_CACHE_MAX = 200;
const MSG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Optimistik mesaj bu süre içinde sunucuca onaylanmazsa "gönderilemedi" sayılır. */
/**
 * Optimistik mesaj bu süre içinde sunucuca onaylanmazsa "gönderilemedi" sayılır.
 *
 * 12 sn idi; sunucu bağlantı logu (connections.jsonl) 12 sn'nin YANLIŞ ALARM
 * ürettiğini gösterdi: "gönderilemedi" işaretlenen bir mesajın gerçekte
 * ulaştığı, o anda hiçbir kopma olmadığı (en yakın kopmalar saatler öncesi ve
 * sonrası) tespit edildi. Yerel ağda echo normalde <1 sn gelir; gecikme
 * yalnızca pencereler arası aktarımın kısa süre takılmasından kaynaklanır.
 * 30 sn, gerçek bir arızayı yine hızla yakalar ama sağlıklı gönderimleri
 * suçlamaz.
 */
const SEND_CONFIRM_TIMEOUT_MS = 30000;

function loadMessageCache(peerCu) {
  if (!peerCu) return [];
  try {
    const raw = localStorage.getItem(MSG_CACHE_PREFIX + peerCu);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages)) return [];
    if (parsed.savedAt && Date.now() - new Date(parsed.savedAt).getTime() > MSG_CACHE_TTL_MS) {
      localStorage.removeItem(MSG_CACHE_PREFIX + peerCu);
      return [];
    }
    return parsed.messages;
  } catch {
    return [];
  }
}

function saveMessageCache(peerCu, messages) {
  if (!peerCu || !messages.length) return;
  try {
    /**
     * Onaylanmamış optimistik ("local-") mesajları önbelleğe YAZMA. Sunucuya
     * ulaşmamış (gönderilemeyen, tek-tık) bir mesaj önbelleğe girerse her
     * pencere açılışında hayalet olarak geri yüklenir ve sunucu karşılığı
     * olmadığı için hiç temizlenmeden en altta çakılı kalırdı.
     */
    const confirmed = messages.filter((m) => !String(m?.id ?? "").startsWith("local-"));
    if (!confirmed.length) return;
    const toSave = confirmed.slice(-MSG_CACHE_MAX);
    localStorage.setItem(
      MSG_CACHE_PREFIX + peerCu,
      JSON.stringify({ messages: toSave, savedAt: new Date().toISOString() })
    );
  } catch {
    // storage full — ignore
  }
}

function initialLetter(name, dateLocale) {
  if (!name || !String(name).trim()) return "?";
  const ch = String(name).trim()[0];
  return ch.toLocaleUpperCase(dateLocale || "tr-TR");
}

function parseChatWindowParams() {
  const p = new URLSearchParams(window.location.search);
  const rawPeerUuid = String(p.get("peerUuid") || "").trim();
  return {
    peerId: String(p.get("peerId") || "").trim(),
    peerClientUuid: normalizeClientUuid(rawPeerUuid) || rawPeerUuid,
    peerName: decodeURIComponent(p.get("peerName") || ""),
    peerStatus: p.get("peerStatus") || "available",
    peerProfileImage: decodeURIComponent(p.get("peerProfileImage") || "")
  };
}

/** Sunucu `available` veya URL/önbellekten `uygun` — titreşim yalnızca buna izin verir. */
function peerPresenceAllowsPoke(raw) {
  const s = String(raw || "").toLowerCase().trim();
  return s === "available" || s === "uygun" || s === "free";
}

function PokeBellIcon({ className = "" }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path
        d="M12 2.75a4.25 4.25 0 0 0-4.25 4.25c0 3.1-1.55 4.65-2.33 5.43a1.1 1.1 0 0 0 .77 1.87h11.62a1.1 1.1 0 0 0 .77-1.87c-.78-.78-2.33-2.33-2.33-5.43A4.25 4.25 0 0 0 12 2.75Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M10.2 18.9a1.8 1.8 0 0 0 3.6 0" fill="none" />
    </svg>
  );
}

function triggerPokeSentAttentionCss() {
  const el = document.querySelector(".app-shell");
  if (!el) return;
  el.classList.remove("kobi-attention-poke-sent");
  void el.offsetWidth;
  el.classList.add("kobi-attention-poke-sent");
  window.setTimeout(() => el.classList.remove("kobi-attention-poke-sent"), 600);
}

function triggerPokeIncomingAttentionCss() {
  const el = document.querySelector(".app-shell");
  if (!el) return;
  el.classList.remove("kobi-attention-poke-incoming");
  void el.offsetWidth;
  el.classList.add("kobi-attention-poke-incoming");
  window.setTimeout(() => el.classList.remove("kobi-attention-poke-incoming"), 1000);
}

/** Arama sonucunda eşleşen bölümü <mark> ile vurgular (Türkçe büyük/küçük duyarsız). */
function SearchHighlight({ text, query }) {
  const s = String(text ?? "");
  const q = String(query ?? "").trim();
  if (q.length < 2) return <>{s}</>;
  const hay = s.toLocaleLowerCase("tr-TR");
  const needle = q.toLocaleLowerCase("tr-TR");
  const parts = [];
  let from = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) parts.push(s.slice(from, at));
    parts.push(<mark key={`${at}-${guard}`}>{s.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(s.slice(from));
  return <>{parts}</>;
}

function ChatMessageBubble({
  m,
  filePublicUrl,
  isMine,
  onDownloadAttachment,
  onOpenDownloaded,
  localPath,
  onImagePreview,
  statusState,
  avatarImage,
  avatarName,
  downloadProgress,
  onRetryMessage,
  onDeleteMessage
}) {
  const { t, locale } = useI18n();
  const timeLabel = formatMsgTime(m.created_at, locale);
  if (String(m?.kind || "").toLowerCase() === "system") {
    return (
      <div className="msg-system-row" role="status">
        <div className="msg-system-chip">
          <EmojiRichText text={m.text_content ?? ""} />
        </div>
        {timeLabel ? (
          <time className="msg-system-time" dateTime={m.created_at}>
            {timeLabel}
          </time>
        ) : null}
      </div>
    );
  }
  const displayFileName = normalizePossiblyMojibakeFilename(m.file_name || "");
  const finalAvatar = avatarImage;
  const hasAvatarImage = Boolean(finalAvatar);
  const hasLocalFile = Boolean(localPath);
  const canInlinePreview = isInlinePreviewableMime(m.file_mime);
  /**
   * Buton kuralları (kullanıcı odaklı, basit):
   *  - Gönderen + önizlenebilir → "Önizle" (modal/lightbox)
   *  - Gönderen + önizlenemez   → "Aç" (indir + sistemle aç). Kendi
   *    gönderdiği dosyayı doğrulamak isteyebilir; uygulama orijinal
   *    yerel yolu bilmediği için sunucudan getirir.
   *  - Alıcı + yerelde yok      → "İndir"
   *  - Alıcı + yerelde var      → "Aç"
   *  Yani her file mesajında tek ve net bir aksiyon butonu olur.
   */
  const showPreviewAction = isMine && canInlinePreview;
  const showOpenAction = (isMine && !canInlinePreview) || (!isMine && hasLocalFile);
  const showDownloadAction = !isMine && !hasLocalFile;
  const actionLabel = showPreviewAction
    ? t("preview")
    : showOpenAction
      ? t("openDownloaded")
      : t("download");
  return (
    <article className={`msg-row ${isMine ? "msg-row--mine" : ""}`}>
      <div className={`msg-avatar ${hasAvatarImage ? "" : "msg-avatar--fallback"}`} aria-hidden>
        {hasAvatarImage ? (
          <img className="msg-avatar__img" src={finalAvatar} alt="" />
        ) : (
          <span>{initialLetter(avatarName || m.sender, locale)}</span>
        )}
      </div>
      <div className={`msg ${isMine ? "msg--mine" : ""}`}>
        <div className="msg-meta">
          <span className="msg-sender">{m.sender}</span>
          <span className="msg-meta-right">
            {isMine && statusState ? (() => {
              const statusTitle =
                statusState === "read"
                  ? t("messageRead")
                  : statusState === "delivered"
                    ? t("messageDelivered")
                    : statusState === "queued"
                      ? t("messageQueued")
                      : statusState === "pending"
                        ? t("messageSending")
                        : statusState === "failed"
                          ? t("messageFailed")
                          : t("send");
              const glyph =
                statusState === "delivered" || statusState === "read"
                  ? "✓✓"
                  : statusState === "pending"
                    ? "🕓"
                    : statusState === "failed"
                      ? "⚠"
                      : "✓";
              return (
                <span
                  className={`msg-status msg-status--${statusState}`}
                  title={statusTitle}
                  aria-label={statusTitle}
                >
                  {glyph}
                </span>
              );
            })() : null}
            {timeLabel ? (
              <time className="msg-time" dateTime={m.created_at} title={timeLabel}>
                {timeLabel}
              </time>
            ) : null}
          </span>
        </div>
        {m.kind === "text" && (
          <div className="msg-body msg-body--emoji-rich">
            <MessageText text={m.text_content ?? ""} />
          </div>
        )}
        {m.kind === "file" && (
          <div className="msg-body">
            {!m.file_rel ? (
              <div className="msg-file-expired" role="note">
                {m.file_name ? (
                  <span className="msg-file-expired__name">{displayFileName}</span>
                ) : null}
                <span className="msg-file-expired__hint">{t("fileExpired")}</span>
              </div>
            ) : (
              <>
                <div className="msg-file-card">
                  <div className="msg-file-card__icon msg-file-card__icon--text" aria-hidden>
                    {isImageMime(m.file_mime) ? "G" : "D"}
                  </div>
                  <div className="msg-file-card__info">
                    <div className="msg-file-card__name" title={displayFileName || ""}>
                      {displayFileName || t("fileFallback")}
                    </div>
                    <div className="msg-file-card__meta">
                      <span className="msg-file-card__size">{formatFileSize(m.file_size)}</span>
                      {m.file_mime ? <span className="msg-file-card__mime">{m.file_mime}</span> : null}
                    </div>
                  </div>
                  {downloadProgress ? (() => {
                    const pct = Math.min(100, Math.round(downloadProgress.received / downloadProgress.total * 100));
                    return (
                      <div className="msg-file-progress" aria-label={`${pct}%`}>
                        <div className="msg-file-progress__track">
                          <div className="msg-file-progress__fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="msg-file-progress__pct">{pct}%</span>
                      </div>
                    );
                  })() : (
                    <button
                      type="button"
                      className="msg-file-card__action"
                      onClick={() => {
                        if (showPreviewAction) {
                          onImagePreview?.({
                            url: filePublicUrl(m.file_rel),
                            title: displayFileName || t("fileFallback"),
                            mime: m.file_mime || "",
                            fileRel: m.file_rel || "",
                            messageId: m.id,
                            fileSize: m.file_size
                          });
                          return;
                        }
                        if (showOpenAction && hasLocalFile) {
                          onOpenDownloaded?.(localPath);
                          return;
                        }
                        onDownloadAttachment?.({
                          messageId: m.id,
                          fileSize: m.file_size,
                          url: filePublicUrl(m.file_rel),
                          filename: displayFileName || t("fileFallback"),
                          mime: m.file_mime || "",
                          fileRel: m.file_rel || "",
                          openAfter: showOpenAction
                        });
                      }}
                    >
                      {actionLabel}
                    </button>
                  )}
                </div>
                {isImageMime(m.file_mime) && m.file_rel ? (
                  <img
                    className="msg-img msg-img--in-bubble"
                    src={filePublicUrl(m.file_rel)}
                    alt={displayFileName || t("imageAlt")}
                    onClick={() =>
                      onImagePreview?.({
                        url: filePublicUrl(m.file_rel),
                        title: displayFileName || t("imageAlt"),
                        mime: m.file_mime || "",
                        fileRel: m.file_rel || "",
                        messageId: m.id,
                        fileSize: m.file_size
                      })
                    }
                  />
                ) : null}
                {m.text_content ? (
                  <div className="msg-file-caption msg-body--emoji-rich">
                    <MessageText text={m.text_content} />
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
        {isMine && statusState === "failed" ? (
          <div className="msg-failed-actions">
            <button
              type="button"
              className="msg-failed-btn"
              onClick={() => onRetryMessage?.(m)}
            >
              {t("messageRetry")}
            </button>
            <button
              type="button"
              className="msg-failed-btn msg-failed-btn--del"
              onClick={() => onDeleteMessage?.(m)}
            >
              {t("messageDelete")}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function ChatApp() {
  const initialPeer = parseChatWindowParams();
  const peerClientUuid = initialPeer.peerClientUuid;
  const [peerSocketId, setPeerSocketId] = useState(initialPeer.peerId);
  const [peerName, setPeerName] = useState(initialPeer.peerName);
  const [peerStatus, setPeerStatus] = useState(initialPeer.peerStatus);
  const [peerOnline, setPeerOnline] = useState(Boolean(initialPeer.peerId));
  const [peerProfileImage, setPeerProfileImage] = useState(initialPeer.peerProfileImage);
  const { t, locale, lang, setLang } = useI18n();
  /**
   * baseUrl boş başlar; `applyConfig` Electron/web ayarlarından gerçek
   * sunucu URL'sini set edene kadar `filePublicUrl` boş URL üretir ve
   * `onDownloadAttachment` indirmeyi denemez. Bu sayede pencere açılır
   * açılmaz tıklanan eski bir indirmenin yanlışlıkla `127.0.0.1:3847`
   * (build-time fallback) gibi yanlış bir adrese gitmesi önlenmiş olur.
   */
  const [baseUrl, setBaseUrl] = useState("");
  const [activeSocketUrl, setActiveSocketUrl] = useState("");
  const [displayName, setDisplayName] = useState(() => MESSAGES.tr.defaultUserName);
  const [myProfileImage, setMyProfileImage] = useState("");
  const [clientUuid, setClientUuid] = useState("");
  const [mySocketId, setMySocketId] = useState(null);
  const [messages, setMessages] = useState([]);
  /**
   * Geçmiş yazışmalar artık ayrı bir modal'da gösteriliyor. Eski "scroll-up
   * eşiği aşılınca yukarıda göster" mantığı (showPastHistory + layout effect
   * + scroll preservation) tamamen kaldırıldı. Tek scroll container var ve
   * yalnızca bugünkü mesajları gösteriyor; bu sayede scroll yarışı yok.
   */
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  /** Ctrl+F mesaj arama: panel açık mı + arama metni. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const historyModalBodyRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const [quickRows, setQuickRows] = useState(() => loadQuickMessages());
  const [quickEditingSlot, setQuickEditingSlot] = useState(null);
  const [lanReady, setLanReady] = useState(() => typeof window === "undefined" || !window.kobiChat);
  const [activeConvId, setActiveConvId] = useState(null);
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(true);
  const [messageStatusMap, setMessageStatusMap] = useState({});
  const [peerTyping, setPeerTyping] = useState(false);
  const [profileZoomOpen, setProfileZoomOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState(null);
  /**
   * Metin/CSV önizlemesinin içeriği. Bu türleri iframe ile göstermek işe
   * yaramıyor: Chromium `text/csv` ve `text/markdown` yanıtlarını satır içi
   * çizmez, indirilecek dosya sayar ve çerçeve bomboş kalır. Bu yüzden
   * içeriği kendimiz indirip çiziyoruz (CSV → tablo, diğerleri → düz metin).
   */
  const [textPreview, setTextPreview] = useState({ state: "idle", rows: null, text: "", truncated: false });
  /** Electron: indirilen dosyanın tam yolu (mesaj id → path) */
  const [localDownloadByMessageId, setLocalDownloadByMessageId] = useState({});
  /** Electron: aktif indirme ilerlemesi (mesaj id → { received, total }) */
  const [downloadProgress, setDownloadProgress] = useState({});
  /**
   * İndirmesi tamamlanmış mesaj id'leri. `send` (ilerleme) ile `invoke`
   * (dönüş) ayrı IPC kanalları olduğundan, indirme bittikten SONRA geç
   * gelen bir %100 ilerleme olayı çubuğu tekrar gösterip "Aç" butonunu
   * gizleyebiliyordu (çubuk %100'de takılı kalıyordu). Tamamlananları
   * burada işaretleyip geç gelen olayları yok sayıyoruz.
   */
  const completedDownloadsRef = useRef(new Set());
  const [pendingImageUpload, setPendingImageUpload] = useState(null);
  /** Resim önizleme modalında yazılan alt yazı (caption) — resimle birlikte gider. */
  const [pendingCaption, setPendingCaption] = useState("");
  /**
   * Yükleme akışı sayaçları:
   *  - `uploadingCount`: o an havada olan upload sayısı (UI rozetinde gösterilir).
   * Tek upload başarısızsa ayrı alert; çoklu için tek özet alert kullanılır
   * (`uploadFiles` içinde toplanır).
   */
  const [uploadingCount, setUploadingCount] = useState(0);
  /** Titreşim (poke) geri bildirimi — gelen / başarı / hata metni */
  const [pokeNotice, setPokeNotice] = useState({ kind: "", text: "" });

  const bottomRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const composerRef = useRef(null);
  const chatDropRef = useRef(null);
  const composerActionsRef = useRef(null);
  const hasAutoFocusRef = useRef(false);
  const tRef = useRef(t);
  const bridgeRef = useRef(null);
  const instanceIdRef = useRef(`chat-${crypto.randomUUID()}`);
  const dmRequestIdRef = useRef(`dm-${crypto.randomUUID()}`);
  const activeConvIdRef = useRef(null);
  const clientUuidRef = useRef("");
  const mySocketIdRef = useRef(null);
  const soundPlayedForRef = useRef(new Set());
  /** Mükerrer titreşim relay'lerini elemek için görülen pokeId'ler. */
  const seenPokeIdsRef = useRef(new Set());
  const dmOpenSentRef = useRef(false);
  /** Köprü yalnızca konuşma kimliği değişince sıfırlansın (mySocketId ile değil — dinleyici düşmesini önler) */
  const bridgeConvKeyRef = useRef("");
  const messagesRef = useRef([]);
  const notificationSoundEnabledRef = useRef(true);
  const readSentRef = useRef(new Set());
  const typingTimerRef = useRef(null);
  const peerTypingTimerRef = useRef(null);
  const myMessageIdsRef = useRef(new Set());
  const pendingEarlyMessagesRef = useRef([]);

  useEffect(() => {
    if (!window.kobiChat?.onChatPeerSocket) return undefined;
    return window.kobiChat.onChatPeerSocket((p) => {
      if (typeof p?.peerId === "string") {
        const nextPeerId = String(p.peerId).trim();
        setPeerSocketId(nextPeerId);
        setPeerOnline(Boolean(nextPeerId));
      }
      if (typeof p?.peerDisplayName === "string" && p.peerDisplayName.trim()) {
        setPeerName(p.peerDisplayName.trim().slice(0, 80));
      }
      if (typeof p?.peerStatus === "string" && p.peerStatus.trim()) {
        setPeerStatus(p.peerStatus.trim().slice(0, 32));
      }
      if (typeof p?.peerProfileImage === "string") {
        setPeerProfileImage(p.peerProfileImage.trim().slice(0, 400000));
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window.kobiChat?.onAttentionCssBurst !== "function") return undefined;
    return window.kobiChat.onAttentionCssBurst(() => {
      triggerPokeIncomingAttentionCss();
    });
  }, []);

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  clientUuidRef.current = clientUuid;
  mySocketIdRef.current = mySocketId;
  activeConvIdRef.current = activeConvId;
  tRef.current = t;
  notificationSoundEnabledRef.current = notificationSoundEnabled;

  const scrollToBottom = useCallback(() => {
    const sc = scrollContainerRef.current;
    if (sc) {
      sc.scrollTop = sc.scrollHeight;
    } else {
      bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, []);

  /**
   * Otomatik dibe kaydırma.
   *   - `force: true`: pozisyondan bağımsız olarak dibe iner (ilk history
   *     yüklemesi, kendi mesajım, gelen mesaj — bugünkü tek view).
   *   - `force: false`: yalnızca kullanıcı zaten dibe yakınsa scroll eder
   *     (sadece focus/visibility geri dönüşlerinde kullanılır).
   *
   * Üç dalga yazma: rAF (next frame, ~16ms), 80ms (React render sonrası),
   * 250ms (yavaş layout / image/font yüklemesi sonrası). Üçü de aynı yöne
   * (dibe) yazıyor → çelişki yok, "shaking" yaratmaz. Geçmiş yazışmalar
   * ayrı modal'da olduğu için tek scroll container var; bugünkü görünümde
   * yeni mesaj gelince her zaman dibe inmek mantıklı UX (kullanıcı geçmişi
   * görmek isterse "Geçmiş" butonuna basıyor).
   */
  const scheduleScrollToBottom = useCallback(
    ({ force = false } = {}) => {
      const run = () => {
        if (!force && !isUserNearBottom(scrollContainerRef.current)) return;
        scrollToBottom();
      };
      requestAnimationFrame(run);
      setTimeout(run, 80);
      setTimeout(run, 250);
    },
    [scrollToBottom]
  );

  const applyConfig = useCallback(async () => {
    if (window.kobiChat) {
      const cfg = await window.kobiChat.getConfig();
      setBaseUrl(normalizeBase(cfg.socketUrl));
      setDisplayName(clampDisplayName(cfg.displayName) || t("defaultUserName"));
      setMyProfileImage(String(cfg.profileImage || ""));
      if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
      setNotificationSoundEnabled(cfg.notificationSound !== false);
      if (cfg.language) setLang(normalizeLang(cfg.language));
    } else {
      const ws = loadWebSettings();
      const fromQuery = readBrowserSocketUrlFromQuery();
      const fromWebSettings = normalizeBase(ws.socketUrl || "");
      setBaseUrl(
        fromQuery ||
          fromWebSettings ||
          normalizeBase(import.meta.env.VITE_SOCKET_URL || "http://127.0.0.1:3847")
      );
      setDisplayName(clampDisplayName(ws.displayName || "") || t("defaultUserName"));
      setMyProfileImage(String(ws.profileImage || ""));
      setNotificationSoundEnabled(ws.notificationSound !== false);
    }
  }, [t, setLang]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!window.kobiChat) {
        await applyConfig();
        setLanReady(true);
        return;
      }
      const s = await window.kobiChat.getSettings();
      const cfg = await window.kobiChat.getConfig();
      setDisplayName(clampDisplayName(s.displayName || cfg.displayName) || t("defaultUserName"));
      setMyProfileImage(String(s.profileImage || cfg.profileImage || ""));
      setNotificationSoundEnabled((s.notificationSound ?? cfg.notificationSound) !== false);
      if (s.clientUuid) setClientUuid(s.clientUuid);
      else if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
      const rawLang = s.language;
      if (rawLang && LANGS.includes(rawLang)) {
        setLang(rawLang);
      } else if (!rawLang) {
        const d = detectBrowserLang();
        setLang(d);
      }
      setBaseUrl(normalizeBase(cfg.socketUrl));
      if (cancelled) return;
      setLanReady(true);
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, [t, setLang]);

  useEffect(() => {
    applyThemeToDocument(getStoredTheme());
    const syncTheme = () => applyThemeToDocument(getStoredTheme());
    window.addEventListener("storage", syncTheme);
    window.addEventListener("focus", syncTheme);
    return () => {
      window.removeEventListener("storage", syncTheme);
      window.removeEventListener("focus", syncTheme);
    };
  }, []);

  /** Sohbet penceresinde de ses motoru ayarları/preload aktif olsun. */
  useEffect(() => {
    void bootstrapSoundPrefs();
    preloadAllSounds();
  }, []);

  useEffect(() => {
    let unsub;
    if (window.kobiChat) {
      unsub = window.kobiChat.onConfigUpdated((cfg) => {
        setBaseUrl(normalizeBase(cfg.socketUrl));
        setDisplayName(clampDisplayName(cfg.displayName) || t("defaultUserName"));
        setMyProfileImage(String(cfg.profileImage || ""));
        if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
        setNotificationSoundEnabled(cfg.notificationSound !== false);
        if (cfg.language) setLang(normalizeLang(cfg.language));
      });
    }
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [t, setLang]);

  useEffect(() => {
    if (!window.kobiChat?.onDownloadProgress) return;
    const unsub = window.kobiChat.onDownloadProgress(({ messageId, received, total }) => {
      if (messageId == null) return;
      const key = String(messageId);
      // İndirme tamamlandıysa geç gelen ilerleme olaylarını yok say
      // (aksi halde çubuk %100'de takılır, "Aç" butonu çıkmaz).
      if (completedDownloadsRef.current.has(key)) return;
      setDownloadProgress((prev) => ({ ...prev, [key]: { received, total } }));
    });
    return () => typeof unsub === "function" && unsub();
  }, []);

  const convIdMemo = useMemo(() => {
    if (!clientUuid || !peerClientUuid) return null;
    return conversationId(clientUuid, peerClientUuid);
  }, [clientUuid, peerClientUuid]);

  const canSend = Boolean(peerClientUuid && clientUuid && mySocketId);
  const canType = Boolean(peerSocketId && peerClientUuid && clientUuid && mySocketId);
  /** Sunucu yalnızca `available` iken poke kabul eder. */
  const peerAllowsPoke = useMemo(() => {
    if (!peerOnline || !peerSocketId) return false;
    return peerPresenceAllowsPoke(peerStatus);
  }, [peerOnline, peerSocketId, peerStatus]);

  /** Karşı taraf "dışarıda" (away) iken dosya gönderimi engellenir; yalnızca mesaj gider. */
  const peerIsAway = useMemo(() => {
    if (!peerOnline) return false;
    const s = String(peerStatus || "").toLowerCase();
    return s === "away" || s === "disarida";
  }, [peerOnline, peerStatus]);

  const peerStatusText = useMemo(() => {
    const s = String(peerStatus || "").toLowerCase();
    if (!peerOnline) return `${t("presenceUserOffline")} · ${t("messageQueued")}`;
    if (s === "busy" || s === "mesgul") return t("presenceBusy");
    if (s === "away" || s === "disarida") return t("presenceAway");
    return t("presenceAvailable");
  }, [peerStatus, peerOnline, t]);

  /**
   * Üst uyarı: karşı taraf çevrimdışıysa “mesaj kuyruğa alınacak” bilgisi,
   * yoksa meşgul / dışarıda durumu. Çevrimdışı durumu öncelikli; presence
   * status (busy/away) ancak kullanıcı online iken anlamlıdır.
   */
  const peerPresenceBannerKind = useMemo(() => {
    if (!peerOnline) return "offline";
    const s = String(peerStatus || "").toLowerCase();
    if (s === "busy" || s === "mesgul") return "busy";
    if (s === "away" || s === "disarida") return "away";
    return null;
  }, [peerOnline, peerStatus]);

  useEffect(() => {
    const name = (peerName && String(peerName).trim()) || t("defaultUserName");
    const title = `${name} · ${peerStatusText} — KobiChat`;
    document.title = title;
    if (typeof window.kobiChat?.setWindowTitle === "function") {
      void window.kobiChat.setWindowTitle(title);
    }
  }, [peerName, peerStatusText, t]);

  /**
   * Görev çubuğu / pencere simgesi = karşı tarafın profil resmi. Böylece
   * taskbar'da hangi sohbetin kime ait olduğu tek bakışta anlaşılır.
   * Profil resimleri webp data URI olarak saklanıyor; nativeImage webp'i her
   * platformda çözemediğinden burada canvas ile 64x64 PNG'ye çevriliyor.
   * Profil resmi yoksa varsayılan uygulama simgesi geri gelir.
   */
  useEffect(() => {
    if (typeof window.kobiChat?.setWindowIcon !== "function") return undefined;
    const src = String(peerProfileImage || "").trim();
    if (!src.startsWith("data:image/")) {
      void window.kobiChat.setWindowIcon("");
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        /** Kare doldur (cover): kısa kenara göre kırp, ortala. */
        const sw = img.naturalWidth || size;
        const sh = img.naturalHeight || size;
        const side = Math.min(sw, sh);
        ctx.drawImage(img, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, size, size);
        void window.kobiChat.setWindowIcon(canvas.toDataURL("image/png"));
      } catch {
        // ignored — simge değişmezse varsayılan kalır
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [peerProfileImage]);

  // Pencere kapanıp açıldığında sunucu yanıtını beklemeden önbellekten mesajları yükle
  useEffect(() => {
    if (!peerClientUuid) return;
    const cached = loadMessageCache(peerClientUuid);
    if (!cached.length) return;
    setMessages((prev) => {
      if (prev.length > 0) return prev;
      messagesRef.current = cached;
      return cached;
    });
    scheduleScrollToBottom({ force: true });
  }, [peerClientUuid, scheduleScrollToBottom]);

  // Mesajlar güncellenince önbelleğe kaydet
  useEffect(() => {
    if (!peerClientUuid || !messages.length) return;
    saveMessageCache(peerClientUuid, messages);
  }, [messages, peerClientUuid]);

  /**
   * Mesaj bana mı ait? BİRİNCİL ÖLÇÜT `from_client_uuid`: kullanıcı kimliği
   * kalıcıdır, sunucu hem canlı yayında hem geçmişte gönderir ve yeniden
   * bağlanmadan etkilenmez.
   *
   * Eskiden sıra tersineydi ve üç tahmine dayanıyordu (id kümesi → socket id →
   * görünen ad). `myMessageIdsRef`, durum/teslimat olaylarında koşulsuz
   * dolduruluyordu; bir kez karşı tarafın mesaj id'si girince o mesaj kalıcı
   * olarak "benim" sayılıp sağ tarafta, okundu tikiyle görünüyordu.
   * Kimlik bilgisi olmayan ESKİ satırlar için eski sezgiler yedek kalır.
   */
  const isMineMessage = (m) => {
    if (!m) return false;
    const mineCu = normalizeClientUuid(clientUuidRef.current || clientUuid);
    const fromCu = normalizeClientUuid(m.from_client_uuid || "");
    const peerCu = normalizeClientUuid(peerClientUuid);
    if (fromCu) {
      if (mineCu) return fromCu === mineCu;
      /**
       * Kendi kimliğim HENÜZ yüklenmedi (açılış anı: `clientUuid` ayarlardan
       * asenkron geliyor, `peerClientUuid` ise URL'den anında hazır). Özel
       * sohbette yalnızca iki taraf vardır; bu yüzden "karşı taraf değilse
       * benim" güvenli bir çıkarımdır. Bu olmadan, bağlantı kurulana kadar
       * kendi mesajlarım karşı tarafınmış gibi solda görünüyordu.
       */
      if (peerCu) return fromCu !== peerCu;
    }
    const msgId = m?.id != null ? String(m.id) : "";
    if (msgId && myMessageIdsRef.current.has(msgId)) return true;
    if (m.from_socket_id && mySocketId && m.from_socket_id === mySocketId) return true;
    return String(m.sender || "").trim() === (clampDisplayName(displayName) || t("defaultUserName"));
  };

  const bridgeSend = useCallback((payload) => {
    if (window.kobiChat?.sendToRoster) {
      window.kobiChat.sendToRoster(payload);
    } else {
      bridgeRef.current?.postMessage?.(payload);
    }
  }, []);

  const sendPoke = useCallback(() => {
    if (!canSend || !mySocketId || !peerAllowsPoke) return;
    const myCu = normalizeClientUuid(clientUuidRef.current || clientUuid);
    if (!myCu) return;
    bridgeSend({
      type: "chat:send-poke",
      toSocketId: peerSocketId || "",
      peerClientUuid,
      myClientUuid: myCu
    });
  }, [canSend, mySocketId, peerAllowsPoke, peerSocketId, peerClientUuid, bridgeSend, clientUuid]);

  const appendPokeSystemLine = useCallback(
    (text) => {
      const cid = conversationId(clientUuidRef.current || clientUuid, peerClientUuid);
      if (!text?.trim() || !cid) return;
      const row = {
        id: `local-poke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        kind: "system",
        sender: "",
        text_content: text.trim(),
        created_at: new Date().toISOString(),
        conv_id: cid,
        from_socket_id: null,
        file_name: null,
        file_rel: null,
        file_mime: null,
        file_size: null
      };
      setMessages((prev) => {
        const next = mergeMessageListsById([row], prev);
        messagesRef.current = next;
        return next;
      });
      scheduleScrollToBottom({ force: true });
    },
    [peerClientUuid, clientUuid, scheduleScrollToBottom]
  );

  const statusStateForMessage = useCallback(
    (m) => {
      if (!m?.id || !isMineMessage(m)) return "";
      /**
       * Optimistik ("local-") mesaj henüz sunucu tarafından onaylanmadı;
       * tek ✓ ("gönderildi") göstermek yanıltıcıydı (mesaj aslında gitmemiş
       * olabilir). Onaylanana kadar "gönderiliyor", zaman aşımına uğrarsa
       * "gönderilemedi" göster.
       */
      if (String(m.id).startsWith("local-")) {
        return m.send_failed ? "failed" : "pending";
      }
      const ds = String(m.delivery_state || "").toLowerCase();
      const st = messageStatusMap[String(m.id)];
      /**
       * State machine tek yön: queued → sent → delivered → read.
       * `messageStatusMap` (canlı `message:status` event'lerinden) `m.delivery_state`'i
       * (history payload'undan veya `socket:message:state`'ten) **ezme** önceliğine
       * sahip; aksi halde history `delivered` ile geldikten sonra peer mesajı okusa
       * bile UI mavi'ye geçmezdi (delivery_state hâlâ `delivered` döner ve map
       * kontrolü atlanırdı).
       */
      if (st === "read" || ds === "read") return "read";
      if (st === "delivered" || ds === "delivered") return "delivered";
      if (ds === "queued") return "queued";
      return "sent";
    },
    [messageStatusMap]
  );

  const markIncomingAsRead = useCallback(() => {
    if (!canSend || !mySocketId) return;
    const current = messagesRef.current;
    for (const m of current) {
      if (!m?.id || !m?.from_socket_id) continue;
      if (String(m.from_socket_id) === String(mySocketId)) continue;
      const key = String(m.id);
      if (readSentRef.current.has(key)) continue;
      readSentRef.current.add(key);
      bridgeSend({
        type: "chat:message-read",
        senderSocketId: m.from_socket_id,
        senderClientUuid:
          typeof m.from_client_uuid === "string" ? String(m.from_client_uuid).trim() : "",
        messageId: m.id,
        conv_id: m.conv_id
      });
    }
  }, [canSend, mySocketId, bridgeSend]);

  const sendTypingState = useCallback(
    (isTyping) => {
      if (!canType || !mySocketId) return;
      bridgeSend({
        type: "chat:typing",
        clientUuid,
        toSocketId: peerSocketId,
        peerClientUuid,
        conv_id: activeConvIdRef.current || convIdMemo || "",
        isTyping: Boolean(isTyping)
      });
    },
    [canType, mySocketId, bridgeSend, clientUuid, peerSocketId, peerClientUuid, convIdMemo]
  );

  const isChatWindowActivelyViewed = useCallback(() => {
    return document.visibilityState === "visible" && document.hasFocus();
  }, []);

  /**
   * Roster'a (ana pencere) "bu peer'in penceresi görüntülendi → okundu" sinyali.
   * Sohbet penceresinde okuma yapılınca roster'daki turuncu "okunmamış"
   * çerçevesi (has-unread) buradan temizlenir; aksi halde kullanıcı mesajı
   * sohbet penceresinde okusa bile roster'da hiç temizlenmiyor ve çerçeve
   * sonsuza dek kalıyordu.
   */
  const notifyRosterViewed = useCallback(() => {
    const cu = String(peerClientUuid || "").trim();
    if (!cu) return;
    const payload = { type: "chat:viewed", peerClientUuid: cu };
    if (window.kobiChat?.sendToRoster) {
      window.kobiChat.sendToRoster(payload);
    } else if (bridgeRef.current?.postMessage) {
      bridgeRef.current.postMessage(payload);
    }
  }, [peerClientUuid]);

  useEffect(() => {
    setActiveConvId(convIdMemo);
  }, [convIdMemo]);

  useEffect(() => {
    if (!peerClientUuid) return undefined;
    const inst = instanceIdRef.current;
    const rid = dmRequestIdRef.current;
    const convKey = peerClientUuid;
    if (bridgeConvKeyRef.current !== convKey) {
      bridgeConvKeyRef.current = convKey;
      dmOpenSentRef.current = false;
      pendingEarlyMessagesRef.current = [];
    }

    let ch = null;
    let unsubRelay = null;

    function postToRoster(payload) {
      if (window.kobiChat?.sendToRoster) {
        window.kobiChat.sendToRoster(payload);
      } else if (bridgeRef.current?.postMessage) {
        bridgeRef.current.postMessage(payload);
      }
    }

    function applySocketMessageNew(msg) {
      if (!msg?.conv_id) return;
      const my = normalizeClientUuid(clientUuidRef.current || clientUuid);
      const peer = normalizeClientUuid(peerClientUuid);
      if (!peer) return;
      if (!isDmConvForPeerAndMe(msg.conv_id, peer, my)) return;
      const fromSocket = msg?.from_socket_id;
      const sid = mySocketIdRef.current;
      /**
       * "Gelen mi?" kararı ÖNCE kalıcı kullanıcı kimliğine bakar. Eskiden
       * yalnızca socket id karşılaştırılıyordu; `from_socket_id` boş/eksik
       * gelen bir mesajda (kuyruktan aktarım, eski satır) `incoming` yanlışlıkla
       * false oluyor ve mesaj "benim" olarak işaretlenip karşı tarafın mesajı
       * kendi tarafımızda, okundu tikiyle görünüyordu.
       */
      const fromCu = normalizeClientUuid(msg?.from_client_uuid || "");
      const incoming = fromCu
        ? my
          ? fromCu !== my
          : /** Kimliğim henüz yüklenmediyse: özel sohbette karşı taraf ise gelendir. */
            fromCu === peer
        : typeof fromSocket === "string" && fromSocket.length > 0 && fromSocket !== sid;
      if (!incoming && msg?.id != null) {
        myMessageIdsRef.current.add(String(msg.id));
      }
      if (incoming) {
        const k = `snd-${fromSocket}-${msg.id}`;
        if (!soundPlayedForRef.current.has(k)) {
          soundPlayedForRef.current.add(k);
          playSound("messageIncomingSoft");
        }
        if (!isChatWindowActivelyViewed() && window.kobiChat?.flashSelf) {
          void window.kobiChat.flashSelf();
        }
        if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
        setPeerTyping(false);
      }
      setMessages((prev) => {
        const existingIdx = prev.findIndex((x) => String(x.id) === String(msg.id));
        if (existingIdx >= 0) {
          const next = prev.map((x, i) =>
            i === existingIdx
              ? { ...x, ...msg, delivery_state: msg.delivery_state ?? x.delivery_state }
              : x
          );
          messagesRef.current = next;
          return next;
        }
        const sid2 = mySocketIdRef.current;
        const fromSelf =
          typeof msg?.from_socket_id === "string" &&
          sid2 &&
          String(msg.from_socket_id) === String(sid2);
        /**
         * Optimistik ("local-") mesajı sunucu sürümü gelince kaldır. Öncelik
         * client_msg_id eşleşmesi: reconnect'te from_socket_id değişse veya
         * echo geç gelse bile optimistik mesaj güvenle uzlaştırılır. Aksi
         * halde optimistik mesaj (yanlış saatli PC'nin client saatiyle) en
         * altta takılı kalıyor ve mesajlar saat olarak ters görünüyordu.
         * client_msg_id yoksa eski metin eşleşmesine düşülür.
         */
        const incomingCmid = msg?.client_msg_id ? String(msg.client_msg_id) : "";
        const base = prev.filter((m) => {
          if (!String(m.id).startsWith("local-")) return true;
          if (incomingCmid && String(m.client_msg_id || "") === incomingCmid) return false;
          if (
            fromSelf &&
            msg.kind === "text" &&
            m.kind === "text" &&
            m.text_content === msg.text_content &&
            m.conv_id === msg.conv_id
          ) {
            return false;
          }
          return true;
        });
        const next = mergeMessageListsById([msg], base);
        messagesRef.current = next;
        return next;
      });
      scheduleScrollToBottom({ force: true });
      if (incoming && isChatWindowActivelyViewed()) {
        requestAnimationFrame(markIncomingAsRead);
      }
    }

    function flushPendingEarlyMessages() {
      if (pendingEarlyMessagesRef.current.length === 0) return;
      const batch = pendingEarlyMessagesRef.current.splice(0);
      for (const msg of batch) applySocketMessageNew(msg);
    }

    function onPayload(d) {
      if (!d || typeof d !== "object") return;

      if (d.type === "socket:context" && d.replyTo === inst) {
        if (d.mySocketId) {
          mySocketIdRef.current = d.mySocketId;
          setMySocketId(d.mySocketId);
        }
        if (d.clientUuid) {
          clientUuidRef.current = d.clientUuid;
          setClientUuid(d.clientUuid);
        }
        if (typeof d.socketUrl === "string" && d.socketUrl.trim()) {
          setActiveSocketUrl(normalizeBase(d.socketUrl));
        }
        const myCu = String(clientUuidRef.current || clientUuid || "").trim();
        if (!dmOpenSentRef.current && myCu) {
          dmOpenSentRef.current = true;
          postToRoster({
            type: "chat:dm-open",
            peerId: peerSocketId || "",
            peerClientUuid,
            myClientUuid: myCu,
            requestId: rid,
            instanceId: inst
          });
        }
        flushPendingEarlyMessages();
        return;
      }

      if (d.type === "socket:broadcast-context") {
        if (d.mySocketId) {
          mySocketIdRef.current = d.mySocketId;
          setMySocketId(d.mySocketId);
        }
        if (d.clientUuid) {
          clientUuidRef.current = d.clientUuid;
          setClientUuid(d.clientUuid);
        }
        if (typeof d.socketUrl === "string" && d.socketUrl.trim()) {
          setActiveSocketUrl(normalizeBase(d.socketUrl));
        }
        const myCu = String(clientUuidRef.current || clientUuid || "").trim();
        if (!dmOpenSentRef.current && myCu) {
          dmOpenSentRef.current = true;
          postToRoster({
            type: "chat:dm-open",
            peerId: peerSocketId || "",
            peerClientUuid,
            myClientUuid: myCu,
            requestId: rid,
            instanceId: inst
          });
        }
        flushPendingEarlyMessages();
        return;
      }

      if (d.type === "socket:history") {
        const envPeer = normalizeClientUuid(d.peerClientUuid || "");
        const peerOk = Boolean(envPeer && envPeer === normalizeClientUuid(peerClientUuid));
        const reqId = String(d.requestId || "").trim();
        /**
         * Önceki sohbet penceresinin gecikmiş `history` yanıtı aynı peer için gelebilir;
         * requestId uyuşmuyorsa yoksay (pencere kapat-aç sonrası boş/eski geçmiş karışmasın).
         * requestId yoksa (eski sunucu / kuyruk zaman aşımı) yalnızca peer ile eşleştir.
         */
        if (reqId && reqId !== rid) {
          if (!peerOk) return;
        } else if (!reqId && !peerOk) {
          return;
        }
        const payloadMy =
          typeof d.payload?.myClientUuid === "string"
            ? normalizeClientUuid(d.payload.myClientUuid)
            : "";
        const myNorm = normalizeClientUuid(clientUuidRef.current || clientUuid);
        /** Sunucu `myClientUuid` gönderdiyse bu oturumla örtüşmeli (eski sunucuda alan yoksa atlama). */
        const selfOk = !payloadMy || !myNorm || payloadMy === myNorm;

        if (!selfOk) return;

        const list = Array.isArray(d.payload?.messages) ? d.payload.messages : [];
        const wasFirstLoad = (messagesRef.current?.length || 0) === 0;
        const wasNearBottom = isUserNearBottom(scrollContainerRef.current);
        setMessages((prev) => {
          /**
           * Geçmiş yüklenince optimistik "local-" mesajları temizle:
           *  1) Sunucunun artık sahip olduğu (client_msg_id eşleşen) → düş,
           *     çünkü gerçek sürümü aşağıda merge edilecek (mükerrer/yanlış
           *     saat önlenir).
           *  2) Sunucuda YOK ve ESKİ (30 sn'den yaşlı) → düş. Bunlar gönderimi
           *     başarısız olmuş hayaletlerdir; localStorage önbelleğinden geri
           *     yüklenip "en altta takılı kalıyor" sorununu yaratıyorlardı.
           *     Yalnızca çok yeni (bu oturumda henüz gönderilen, echo'su
           *     yolda olabilecek) optimistikler korunur.
           */
          const serverCmids = new Set(
            list.map((m) => (m?.client_msg_id ? String(m.client_msg_id) : "")).filter(Boolean)
          );
          const nowMs = Date.now();
          const STALE_OPTIMISTIC_MS = 30000;
          const cleanedPrev = prev.filter((m) => {
            if (!String(m.id).startsWith("local-")) return true;
            if (m.client_msg_id && serverCmids.has(String(m.client_msg_id))) return false;
            const ageMs = nowMs - new Date(m.created_at).getTime();
            if (Number.isFinite(ageMs) && ageMs > STALE_OPTIMISTIC_MS) return false;
            return true;
          });
          const combined = mergeMessageListsById(list, cleanedPrev);
          messagesRef.current = combined;
          return combined;
        });
        /**
         * İlk yüklemede her zaman dibe in (kullanıcı yeni açtı, en güncel
         * mesajları görmeli). İlk yükleme değilse yalnızca daha önce dipte
         * idiysek scroll et.
         */
        if (wasFirstLoad || wasNearBottom) {
          scheduleScrollToBottom({ force: true });
        }
        flushPendingEarlyMessages();
        return;
      }

      if (d.type === "socket:message:new") {
        const msg = d.msg;
        if (!msg?.conv_id) return;
        const peer = normalizeClientUuid(peerClientUuid);
        if (!peer) return;
        if (!isDmConvForPeerAndMe(msg.conv_id, peer, normalizeClientUuid(clientUuidRef.current || clientUuid))) {
          return;
        }
        if (!mySocketIdRef.current) {
          pendingEarlyMessagesRef.current.push(msg);
          return;
        }
        applySocketMessageNew(msg);
        return;
      }

      if (d.type === "socket:message:status") {
        const payload = d.payload || {};
        if (payload?.messageId == null || typeof payload?.status !== "string") return;
        /**
         * Durum olayları tüm sohbet pencerelerine yayınlanıyor. Eskiden burada
         * koşulsuz `myMessageIdsRef.add()` yapılıyordu; bu, karşı tarafa ait bir
         * id'yi "benim" olarak işaretleyip mesajı yanlış tarafta gösteriyordu.
         * Yalnızca bu sohbette gerçekten bize ait bilinen mesajları işaretle.
         */
        {
          const mid = String(payload.messageId);
          const known = messagesRef.current.find((x) => String(x.id) === mid);
          if (known && isMineMessage(known)) myMessageIdsRef.current.add(mid);
        }
        setMessageStatusMap((prev) => {
          const key = String(payload.messageId);
          const nextStatus = payload.status === "read" ? "read" : "delivered";
          const cur = prev[key];
          if (cur === "read" || cur === nextStatus) return prev;
          return { ...prev, [key]: nextStatus };
        });
        return;
      }

      if (d.type === "socket:poke-incoming") {
        const fromCu = normalizeClientUuid(
          d.fromClientUuid || d.from_client_uuid || ""
        );
        if (!fromCu || fromCu !== normalizeClientUuid(peerClientUuid)) return;
        /** Aynı titreşim relay'i iki kez yollanıyor (bkz. App.jsx); tekilleştir. */
        const pokeId = String(d.pokeId || "").trim();
        if (pokeId) {
          if (seenPokeIdsRef.current.has(pokeId)) return;
          seenPokeIdsRef.current.add(pokeId);
          if (seenPokeIdsRef.current.size > 200) {
            seenPokeIdsRef.current = new Set([pokeId]);
          }
        }
        const name = String(d.fromDisplayName || "").trim() || tRef.current("defaultUserName");
        appendPokeSystemLine(tRef.current("pokeChatLineReceived", { name }));
        triggerPokeIncomingAttentionCss();
        if (!isChatWindowActivelyViewed() && window.kobiChat?.flashSelf) {
          void window.kobiChat.flashSelf();
        }
        return;
      }

      if (d.type === "socket:poke-sent") {
        const target = normalizeClientUuid(d.peerClientUuid || "");
        if (!target || target !== normalizeClientUuid(peerClientUuid)) return;
        playSound("messageSent");
        appendPokeSystemLine(tRef.current("pokeChatLineSent"));
        triggerPokeSentAttentionCss();
        if (window.kobiChat?.attentionShakeSelf) {
          void window.kobiChat.attentionShakeSelf();
        }
        return;
      }

      if (d.type === "socket:poke-error") {
        const target = normalizeClientUuid(d.peerClientUuid || "");
        if (!target || target !== normalizeClientUuid(peerClientUuid)) return;
        const code = String(d.code || "");
        const key =
          code === "RATE_LIMIT"
            ? "pokeErrorRateLimit"
            : code === "NOT_AVAILABLE"
              ? "pokeErrorNotAvailable"
              : code === "OFFLINE"
                ? "pokeErrorOffline"
                : code === "SELF"
                  ? "pokeErrorSelf"
                  : code === "SESSION"
                    ? "pokeErrorSession"
                    : code === "BAD_REQUEST"
                      ? "pokeErrorBadRequest"
                      : code === "TIMEOUT"
                        ? "pokeErrorTimeout"
                        : code === "NO_SOCKET"
                          ? "pokeErrorNoSocket"
                          : "pokeErrorGeneric";
        playSound("error");
        setPokeNotice({ kind: "err", text: tRef.current(key) });
        window.setTimeout(() => {
          setPokeNotice((cur) => (cur.kind === "err" ? { kind: "", text: "" } : cur));
        }, 7000);
        return;
      }

      if (d.type === "socket:presence-roster") {
        const users = Array.isArray(d.users) ? d.users : [];
        const row = users.find(
          (u) => normalizeClientUuid(u?.clientUuid) === normalizeClientUuid(peerClientUuid)
        );
        if (!row) return;
        const online = row.online !== false && Boolean(String(row.id || "").trim());
        setPeerOnline(online);
        setPeerSocketId(online ? String(row.id || "").trim() : "");
        if (typeof row.status === "string" && row.status.trim()) {
          setPeerStatus(row.status.trim().slice(0, 32));
        }
        if (typeof row.displayName === "string" && row.displayName.trim()) {
          setPeerName(row.displayName.trim().slice(0, 80));
        }
        if (typeof row.profileImage === "string") {
          setPeerProfileImage(row.profileImage.trim().slice(0, 400000));
        }
        return;
      }

      if (d.type === "socket:message:state") {
        const payload = d.payload || {};
        if (payload?.messageId == null || typeof payload?.delivery_state !== "string") return;
        const mid = String(payload.messageId);
        /** bkz. socket:message:status — sahiplik yalnızca doğrulanmışsa işaretlenir. */
        {
          const known = messagesRef.current.find((x) => String(x.id) === mid);
          if (known && isMineMessage(known)) myMessageIdsRef.current.add(mid);
        }
        setMessages((prev) => {
          const next = prev.map((x) =>
            String(x.id) === mid ? { ...x, delivery_state: payload.delivery_state } : x
          );
          messagesRef.current = next;
          return next;
        });
        return;
      }

      if (d.type === "socket:typing") {
        const payload = d.payload || {};
        const convId = String(payload?.conv_id || "").trim();
        const activeConv = String(activeConvIdRef.current || "").trim();
        if (convId && activeConv && convId !== activeConv) return;
        const fromClient = String(payload?.from_client_uuid || "").trim();
        const fromSocket = String(payload?.from_socket_id || "").trim();
        const peerClient = String(peerClientUuid || "").trim();
        const peerSocket = String(peerSocketId || "").trim();
        const sameByClient = Boolean(fromClient && peerClient && fromClient === peerClient);
        const sameBySocket = Boolean(fromSocket && peerSocket && fromSocket === peerSocket);
        if (!sameByClient && !sameBySocket) return;
        const typing = Boolean(payload.isTyping);
        setPeerTyping(typing);
        if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
        if (typing) {
          peerTypingTimerRef.current = setTimeout(() => setPeerTyping(false), 2500);
        }
        return;
      }

    }

    /**
     * `chat:register` ile roster'a kaydoluruz; roster `socket:context`
     * dönmezse `chat:dm-open` hiç emit edilemez ve geçmiş yüklenmez.
     * Roster pencereye geç açılmış olabilir veya BroadcastChannel
     * event'i kaçırmış olabilir; 1500ms içinde context gelmediyse
     * register'ı bir defa daha gönderiyoruz. (`dmOpenSentRef` tek-atış
     * koruması olduğu için context geldiğinde tek dm-open çıkar.)
     */
    let registerRetryTimer = null;
    function sendChatRegister(retryCount = 0) {
      const payload = {
        type: "chat:register",
        peerId: peerSocketId || "",
        peerClientUuid,
        instanceId: inst
      };
      postToRoster(payload);
      if (retryCount < 2) {
        registerRetryTimer = setTimeout(() => {
          if (dmOpenSentRef.current) return;
          sendChatRegister(retryCount + 1);
        }, 1500);
      }
    }

    if (window.kobiChat?.onRelayBroadcast && window.kobiChat?.sendToRoster) {
      bridgeRef.current = { sendToRoster: (p) => window.kobiChat.sendToRoster(p) };
      sendChatRegister(0);
      unsubRelay = window.kobiChat.onRelayBroadcast(onPayload);
    } else {
      ch = new BroadcastChannel(KOBI_BRIDGE);
      bridgeRef.current = ch;
      sendChatRegister(0);
      const onBcMsg = (ev) => onPayload(ev.data);
      ch.addEventListener("message", onBcMsg);
      return () => {
        if (registerRetryTimer) clearTimeout(registerRetryTimer);
        postToRoster({
          type: "chat:unregister",
          peerId: peerSocketId || "",
          peerClientUuid,
          instanceId: inst
        });
        try {
          ch.removeEventListener("message", onBcMsg);
          ch.close();
        } catch {
          // ignored
        }
        bridgeRef.current = null;
      };
    }

    return () => {
      if (registerRetryTimer) clearTimeout(registerRetryTimer);
      postToRoster({
        type: "chat:unregister",
        peerId: peerSocketId || "",
        peerClientUuid,
        instanceId: inst
      });
      if (typeof unsubRelay === "function") unsubRelay();
      bridgeRef.current = null;
    };
  }, [peerSocketId, peerClientUuid, clientUuid, scheduleScrollToBottom, markIncomingAsRead, isChatWindowActivelyViewed, appendPokeSystemLine]);

  const { sessionMessages, pastMessages, pastMessagesTotal, pastHistoryTruncated } = useMemo(() => {
    const stripStart = mainConversationStripStartsAtLocal().getTime();
    const session = [];
    const pastAll = [];
    for (const m of messages) {
      const t = new Date(m.created_at);
      if (Number.isNaN(t.getTime())) {
        pastAll.push(m);
      } else if (t.getTime() >= stripStart) {
        session.push(m);
      } else {
        pastAll.push(m);
      }
    }
    const truncated = pastAll.length > PAST_HISTORY_DISPLAY_LIMIT;
    const past = truncated ? pastAll.slice(-PAST_HISTORY_DISPLAY_LIMIT) : pastAll;
    return {
      sessionMessages: session,
      pastMessages: past,
      pastMessagesTotal: pastAll.length,
      pastHistoryTruncated: truncated
    };
  }, [messages]);
  const pastDayGroups = useMemo(() => groupMessagesByDay(pastMessages, t, locale), [pastMessages, t, locale]);

  /**
   * Ctrl+F arama: TÜM mesajlarda (bugünkü + geçmiş) metin, alt yazı ve dosya
   * adı üzerinde arar. Sonuçlar en yeniden eskiye sıralanır; böylece ekranda
   * render edilmeyen eski mesajlar da bulunabilir.
   */
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase("tr-TR");
    if (q.length < 2) return [];
    const out = [];
    for (const m of messages) {
      const text = String(m?.text_content || "");
      const fname = normalizePossiblyMojibakeFilename(m?.file_name || "");
      if (`${text} ${fname}`.toLocaleLowerCase("tr-TR").includes(q)) out.push(m);
    }
    out.reverse();
    return out.slice(0, 300);
  }, [messages, searchQuery]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  /**
   * Modal açılınca otomatik dibe in: kronolojik sıralamada (eski → yeni)
   * ana sohbet penceresinin mantığını takip ediyoruz. Kullanıcının ilk
   * gördüğü şey "en yakın geçmiş" (örn. dün) olmalı; daha eskileri görmek
   * için yukarı scroll'lasın. Tüm sohbet uygulamaları (WhatsApp, Telegram,
   * Slack) bu şekilde çalışır.
   *
   * `requestAnimationFrame` ile tek tick gecikme: DOM groupları render
   * edilmeden scrollHeight 0 olur, dibe inme yanlış olur.
   */
  useLayoutEffect(() => {
    if (!historyModalOpen) return;
    const el = historyModalBodyRef.current;
    if (!el) return;
    const goBottom = () => {
      if (historyModalBodyRef.current) {
        historyModalBodyRef.current.scrollTop = historyModalBodyRef.current.scrollHeight;
      }
    };
    goBottom();
    requestAnimationFrame(goBottom);
  }, [historyModalOpen, pastDayGroups.length]);

  /**
   * KALDIRILDI: useEffect([messages.length]) auto-scroll'u kaldırıldı.
   * Bu hook her message:state / message:status güncellemesinde tetikleniyor
   * ve `isUserNearBottom` kontrolü DOM güncellendikten sonra yapıldığı için
   * yanlış sonuç veriyordu (yeni mesaj scrollHeight'ı büyütmüş ve mesafe
   * artmış olduğundan "dipte değil" görünüyordu). Sonuç: aynı tick'te
   * past-history layout effect'inin scrollTop yazımıyla çakışıp sallanma.
   *
   * Artık scroll kararını tek nokta veriyor: yeni mesaj geldiğinde
   * `socket:message:new` handler'ı `wasNearBottom`'ı setMessages ÖNCESİ
   * ölçüp ona göre force ediyor; ilk yüklemede `socket:history` handler'ı
   * her durumda dibe çekiyor.
   */

  useEffect(() => {
    /**
     * Pencere odak alınca da yalnızca dipteysek dibe çek; kullanıcı
     * geçmişe bakarken focus'a basıldı diye konum sıfırlanmamalı.
     * Burada force=false olduğu için isUserNearBottom kontrolü çalışır;
     * bu sırada DOM güncel olduğundan kontrol doğru sonuç verir
     * (yeni mesaj eklenmiyor, sadece pencere odak aldı).
     */
    const onFocus = () => scheduleScrollToBottom();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    if (isChatWindowActivelyViewed()) {
      notifyRosterViewed();
    }
    if (!canSend || !mySocketId) return;
    if (isChatWindowActivelyViewed()) {
      requestAnimationFrame(markIncomingAsRead);
    }
  }, [messages.length, canSend, mySocketId, markIncomingAsRead, isChatWindowActivelyViewed, notifyRosterViewed]);

  useEffect(() => {
    const onVisible = () => {
      if (isChatWindowActivelyViewed()) {
        notifyRosterViewed();
        markIncomingAsRead();
      }
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [markIncomingAsRead, isChatWindowActivelyViewed, notifyRosterViewed]);

  const filePublicUrl = useMemo(() => {
    const fileBase = normalizeBase(activeSocketUrl || baseUrl);
    return (rel) => `${fileBase}/files/${encodeURIComponent(rel)}`;
  }, [activeSocketUrl, baseUrl]);

  /**
   * Metin/CSV önizlemesi açıldığında içeriği indirip çözümler. Büyük dosyaları
   * tümüyle çekmemek için Range ile ilk parça istenir; sunucu Range'i
   * desteklemezse yanıt yine de burada kırpılır.
   */
  useEffect(() => {
    const url = attachmentPreview?.url || "";
    const mime = attachmentPreview?.mime || "";
    if (!url || !isTextPreviewMime(mime)) {
      setTextPreview({ state: "idle", rows: null, text: "", truncated: false });
      return undefined;
    }
    let cancelled = false;
    setTextPreview({ state: "loading", rows: null, text: "", truncated: false });
    (async () => {
      try {
        const res = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` } });
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        const sliced = buf.byteLength > TEXT_PREVIEW_MAX_BYTES ? buf.slice(0, TEXT_PREVIEW_MAX_BYTES) : buf;
        const text = decodeTextBytes(sliced);
        const byteTruncated = buf.byteLength >= TEXT_PREVIEW_MAX_BYTES;
        if (mime.toLowerCase() === "text/csv") {
          const rows = parseCsv(text, CSV_PREVIEW_MAX_ROWS);
          setTextPreview({
            state: "ready",
            rows,
            text: "",
            truncated: byteTruncated || rows.length >= CSV_PREVIEW_MAX_ROWS
          });
        } else {
          setTextPreview({ state: "ready", rows: null, text, truncated: byteTruncated });
        }
      } catch {
        if (!cancelled) setTextPreview({ state: "error", rows: null, text: "", truncated: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachmentPreview?.url, attachmentPreview?.mime]);

  useEffect(() => {
    if (!canSend || !mySocketId) {
      const el = composerRef.current;
      if (el) el.innerHTML = "";
      setDraft("");
      setEmojiPickerOpen(false);
      hasAutoFocusRef.current = false;
    }
  }, [canSend, mySocketId]);

  useEffect(() => {
    if (!canSend || !mySocketId) return;
    if (hasAutoFocusRef.current) return;
    const el = composerRef.current;
    if (!el) return;
    hasAutoFocusRef.current = true;
    requestAnimationFrame(() => {
      try {
        el.focus();
      } catch {
        // ignored
      }
    });
  }, [canSend, mySocketId, peerClientUuid]);

  useEffect(() => {
    hasAutoFocusRef.current = false;
    readSentRef.current = new Set();
    myMessageIdsRef.current = new Set();
    setMessageStatusMap({});
    setPeerTyping(false);
    setLocalDownloadByMessageId({});
    setAttachmentPreview(null);
  }, [peerClientUuid]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
    };
  }, []);

  const onChatDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSend || !mySocketId) return;
    setDragOver(true);
  };

  const onChatDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSend || !mySocketId) return;
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  };

  const onChatDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  };

  const onChatDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (dt?.files?.length) await requestUploadFiles(dt.files);
  };

  const onOpenDownloadedPath = useCallback(
    async (diskPath) => {
      const p = String(diskPath || "").trim();
      if (!p) return;
      if (window.kobiChat?.openDownloaded) {
        const r = await window.kobiChat.openDownloaded({ path: p });
        if (!r?.ok) {
          playSound("error");
          const reason = String(r?.reason || "");
          if (reason === "not_found") {
            alert(t("downloadMissingOnServer"));
          } else {
            alert(t("downloadFailed"));
          }
        }
        return;
      }
    },
    [t]
  );

  const onDownloadAttachment = useCallback(
    async ({ url, filename, mime, fileRel, messageId, fileSize, openAfter }) => {
      if (!url && !fileRel) return;
      if (window.kobiChat?.downloadAndHandle) {
        /**
         * İndirme adayları: tıklanan birincil URL + config'teki bilinen
         * sunucu adresleri (`socketUrl`, `centralSocketUrl`). Üçüncü-PC
         * topolojisinde tek paylaşımlı sunucu var; baseUrl bayatlamış
         * olsa bile bu fallback listesi sayesinde gerçek sunucu yine
         * bulunur. Yükleme akışı zaten benzer bir çoklu-hedef stratejisi
         * kullanıyor; indirme de paritesini buradan kazanır.
         */
        const safeRel = typeof fileRel === "string" ? fileRel.trim() : "";
        const candidateBases = [];
        if (activeSocketUrl) candidateBases.push(activeSocketUrl);
        if (window.kobiChat?.getConfig) {
          try {
            const cfg = await window.kobiChat.getConfig();
            if (cfg?.socketUrl) candidateBases.push(cfg.socketUrl);
            if (cfg?.centralSocketUrl) candidateBases.push(cfg.centralSocketUrl);
          } catch {
            // ignored — fallback'siz devam et
          }
        }
        const candidateUrls = [];
        if (url) candidateUrls.push(url);
        if (safeRel) {
          for (const b of uniqueNormalizedUrls([activeSocketUrl, baseUrl, ...candidateBases])) {
            candidateUrls.push(`${b}/files/${encodeURIComponent(safeRel)}`);
            candidateUrls.push(`${b}/api/download/${encodeURIComponent(safeRel)}`);
          }
        } else if (activeSocketUrl || baseUrl || candidateBases.length) {
          /** rel yoksa URL'den uri parçasını çıkarıp diğer base'lere bağla. */
          try {
            const u = new URL(url);
            const tail = u.pathname + (u.search || "") + (u.hash || "");
            for (const b of uniqueNormalizedUrls([activeSocketUrl, baseUrl, ...candidateBases])) {
              candidateUrls.push(`${b}${tail}`);
            }
          } catch {
            // URL parse edilemiyorsa sadece elimizdekini denesin
          }
        }
        const seen = new Set();
        const urls = candidateUrls.filter((u) => {
          if (!u || seen.has(u)) return false;
          seen.add(u);
          return true;
        });
        const res = await window.kobiChat.downloadAndHandle({
          url,
          urls,
          filename: String(filename || ""),
          mime: String(mime || ""),
          fileRel: safeRel,
          messageId: messageId ?? null,
          fileSize: typeof fileSize === "number" && Number.isFinite(fileSize) ? fileSize : undefined
        });
        const ok = typeof res === "boolean" ? res : Boolean(res?.ok);
        const reason = typeof res === "object" && res ? String(res.reason || "") : "";
        const savedPath = typeof res === "object" && res?.path ? String(res.path) : "";
        if (messageId != null) {
          const key = String(messageId);
          // Önce tamamlandı işaretle, sonra temizle: geç gelen %100
          // ilerleme olayları artık çubuğu yeniden gösteremez.
          completedDownloadsRef.current.add(key);
          setDownloadProgress((prev) => { const n = { ...prev }; delete n[key]; return n; });
          // Bir süre sonra işareti kaldır ki tekrar indirmede ilerleme görünebilsin.
          setTimeout(() => completedDownloadsRef.current.delete(key), 2000);
        }
        if (ok && savedPath && messageId != null) {
          setLocalDownloadByMessageId((prev) => ({ ...prev, [String(messageId)]: savedPath }));
        }
        if (!ok) {
          playSound("error");
          const supportRef = res?.ref ? String(res.ref) : "";
          const supportSuffix = supportRef ? `\n\n${t("downloadSupportRef", { ref: supportRef })}` : "";
          if (reason === "missing_on_server") {
            alert(`${t("downloadMissingOnServer")}${supportSuffix}`);
            return;
          }
          alert(`${t("downloadFailed")}${supportSuffix}`);
          return;
        }
        if (openAfter && savedPath && window.kobiChat?.openDownloaded) {
          /**
           * "Aç" butonu (gönderen veya yerelde olmayan alıcı): indirme bittiyse
           * dosyayı sistem programıyla otomatik aç. Hata olsa bile sessizce
           * geç — kullanıcı yine de localPath ile sonradan açabilir.
           */
          try {
            await window.kobiChat.openDownloaded({ path: savedPath });
          } catch {
            // ignored
          }
        }
        return;
      }
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    [t, activeSocketUrl, baseUrl]
  );


  const handleComposerInput = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    normalizeUnicodeEmojiInEditor(el);
    const text = serializeComposer(el);
    setDraft(text);
    const active = text.trim().length > 0;
    sendTypingState(active);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (active) {
      typingTimerRef.current = setTimeout(() => {
        sendTypingState(false);
      }, 1200);
    }
  }, [sendTypingState]);

  /**
   * Mesaj metninden seçim yapılınca "Alıntıla" düğmesi: seçilen yazı "> " satırları olarak
   * mesaj kutusunun sonuna eklenir, imleç altına geçer.
   */
  const [quoteSel, setQuoteSel] = useState(null);

  useEffect(() => {
    const bodyOf = (node) => {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      return el?.closest?.(".msg-body") || null;
    };
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setQuoteSel(null);
        return;
      }
      const text = sel.toString().trim();
      const body = bodyOf(sel.anchorNode);
      if (!text || !body || bodyOf(sel.focusNode) !== body) {
        setQuoteSel(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const below = r.top < 48;
      setQuoteSel({ text, x: r.left + r.width / 2, y: below ? r.bottom : r.top, below });
    };
    const onUp = () => setTimeout(update, 0);
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setQuoteSel(null);
    };
    const hide = () => setQuoteSel(null);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  const quoteSelection = useCallback(() => {
    const el = composerRef.current;
    const quote = toQuoteLines(quoteSel?.text);
    setQuoteSel(null);
    if (!el || !quote || !canSend || !mySocketId) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const existing = serializeComposer(el);
    const prefix = existing.trim() && !existing.endsWith("\n") ? "\n" : "";
    document.execCommand("insertText", false, `${prefix}${quote}\n`);
    handleComposerInput();
  }, [quoteSel, canSend, mySocketId, handleComposerInput]);

  const insertEmoji = (char) => {
    const el = composerRef.current;
    if (!el || !canSend || !mySocketId) return;
    insertEmojiImageAtCaret(el, char);
    normalizeUnicodeEmojiInEditor(el);
    setDraft(serializeComposer(el));
  };

  useEffect(() => {
    return () => {
      sendTypingState(false);
    };
  }, [sendTypingState]);

  const sendTextContent = useCallback(
    (rawText) => {
      const text = String(rawText || "").trim();
      if (!text || !canSend || !mySocketId) return;
      const cid =
        convIdMemo || (clientUuid && peerClientUuid ? conversationId(clientUuid, peerClientUuid) : "");
      const clientMsgId = crypto.randomUUID();
      if (cid) {
        const tempId = `local-${crypto.randomUUID()}`;
        myMessageIdsRef.current.add(String(tempId));
        const optimistic = {
          id: tempId,
          sender: clampDisplayName(displayName) || t("defaultUserName"),
          kind: "text",
          text_content: text,
          file_name: null,
          file_rel: null,
          file_mime: null,
          file_size: null,
          created_at: new Date().toISOString(),
          conv_id: cid,
          from_socket_id: mySocketId,
          /** Sahiplik tespitinin birincil ölçütü (bkz. isMineMessage). */
          from_client_uuid: normalizeClientUuid(clientUuidRef.current || clientUuid),
          client_msg_id: clientMsgId
        };
        setMessages((prev) => {
          const next = mergeMessageListsById([optimistic], prev);
          messagesRef.current = next;
          return next;
        });
        /** Kendi mesajım — pozisyondan bağımsız olarak dibe getir ki yazdığım hemen görünsün. */
        scheduleScrollToBottom({ force: true });
        /**
         * Gönderim onay zaman aşımı: bu süre içinde optimistik mesaj sunucu
         * sürümüyle değiştirilmezse "gönderilemedi" işaretle. Sonradan
         * reconnect'le gerçekten giderse client_msg_id uzlaşması optimistik
         * satırı kaldıracağından işaret kendiliğinden kaybolur.
         */
        window.setTimeout(() => {
          setMessages((prev) => {
            /**
             * Suçlamadan önce son kontrol: aynı client_msg_id ile ONAYLI
             * (sunucu id'li) bir kopya listede varsa mesaj aslında ulaşmıştır;
             * optimistik satırı "gönderilemedi" diye işaretlemek yerine kaldır.
             */
            const confirmed = prev.some(
              (m) =>
                !String(m.id).startsWith("local-") &&
                m.client_msg_id &&
                String(m.client_msg_id) === clientMsgId
            );
            if (confirmed) {
              const cleaned = prev.filter((m) => String(m.id) !== tempId);
              messagesRef.current = cleaned;
              return cleaned;
            }
            let changed = false;
            const next = prev.map((m) => {
              if (String(m.id) === tempId && !m.send_failed) {
                changed = true;
                return { ...m, send_failed: true };
              }
              return m;
            });
            if (!changed) return prev;
            messagesRef.current = next;
            return next;
          });
        }, SEND_CONFIRM_TIMEOUT_MS);
      }
      bridgeSend({
        type: "chat:send-text",
        text,
        displayName: clampDisplayName(displayName) || t("defaultUserName"),
        clientUuid,
        toSocketId: peerSocketId,
        peerClientUuid,
        clientMsgId
      });
      /** Yumuşak "send" sesi — kullanıcı bir şey gönderdiğinin teyidi. */
      playSound("messageSent");
    },
    [
      canSend,
      mySocketId,
      convIdMemo,
      clientUuid,
      peerClientUuid,
      displayName,
      t,
      bridgeSend,
      peerSocketId,
      scheduleScrollToBottom
    ]
  );

  const sendText = () => {
    const el = composerRef.current;
    const text = (el ? serializeComposer(el) : draft).trim();
    sendTextContent(text);
    setDraft("");
    if (el) el.innerHTML = "";
    setEmojiPickerOpen(false);
    sendTypingState(false);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
  };

  /** Gönderilemeyen (⚠) bir mesajı görünümden kaldır. Önbelleğe zaten yazılmıyor. */
  const deleteLocalMessage = useCallback((msg) => {
    const id = String(msg?.id || "");
    if (!id) return;
    setMessages((prev) => {
      const next = prev.filter((m) => String(m.id) !== id);
      messagesRef.current = next;
      return next;
    });
  }, []);

  /** Gönderilemeyen mesajı yeniden gönder: eskisini kaldırıp taze bir gönderim yap. */
  const retryFailedMessage = useCallback(
    (msg) => {
      const text = String(msg?.text_content || "").trim();
      if (!text) return;
      deleteLocalMessage(msg);
      sendTextContent(text);
    },
    [deleteLocalMessage, sendTextContent]
  );

  const openQuickPanel = useCallback(() => {
    setEmojiPickerOpen(false);
    setQuickRows(loadQuickMessages());
    setQuickEditingSlot(null);
    setQuickPanelOpen((v) => !v);
  }, []);

  const closeQuickPanel = useCallback(() => {
    setQuickPanelOpen(false);
    setQuickEditingSlot(null);
  }, []);

  useEffect(() => {
    if (!emojiPickerOpen && !quickPanelOpen) return undefined;
    const onDocPointerDown = (e) => {
      const wrap = composerActionsRef.current;
      if (!wrap) return;
      const target = e.target;
      if (target instanceof Node && wrap.contains(target)) return;
      setEmojiPickerOpen(false);
      closeQuickPanel();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [emojiPickerOpen, quickPanelOpen, closeQuickPanel]);

  useEffect(() => {
    if (canSend && mySocketId) return;
    closeQuickPanel();
  }, [canSend, mySocketId, closeQuickPanel]);

  const onQuickMessageChange = useCallback((index, value) => {
    setQuickRows((prev) => {
      const next = [...prev];
      next[index] = value;
      saveQuickMessages(next);
      return next;
    });
  }, []);

  const sendQuickMessage = useCallback((index) => {
    const text = String(quickRows[index] ?? "").trim();
    if (!text) return;
    sendTextContent(text);
    closeQuickPanel();
  }, [quickRows, sendTextContent, closeQuickPanel]);

  const closePendingImageUpload = useCallback(() => {
    setPendingImageUpload(null);
  }, []);

  useEffect(() => {
    const previewUrl = pendingImageUpload?.previewUrl;
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [pendingImageUpload?.previewUrl]);

  useEffect(() => {
    const onEscClose = (e) => {
      if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (!document.hasFocus()) return;
      if (pendingImageUpload) {
        e.preventDefault();
        e.stopPropagation();
        closePendingImageUpload();
        return;
      }
      if (historyModalOpen) {
        e.preventDefault();
        e.stopPropagation();
        setHistoryModalOpen(false);
        return;
      }
      if (profileZoomOpen) {
        e.preventDefault();
        e.stopPropagation();
        setProfileZoomOpen(false);
        return;
      }
      if (attachmentPreview) {
        e.preventDefault();
        e.stopPropagation();
        setAttachmentPreview(null);
        return;
      }
      if (quickPanelOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeQuickPanel();
        return;
      }
      if (searchOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      window.close();
    };
    document.addEventListener("keydown", onEscClose, true);
    return () => document.removeEventListener("keydown", onEscClose, true);
  }, [profileZoomOpen, attachmentPreview, pendingImageUpload, closePendingImageUpload, historyModalOpen, quickPanelOpen, closeQuickPanel, searchOpen, closeSearch]);

  /** Ctrl+F → mesajlarda arama panelini aç (Chromium'un kendi bulma çubuğunu bastır). */
  useEffect(() => {
    const onFind = (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.code !== "KeyF") return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    document.addEventListener("keydown", onFind, true);
    return () => document.removeEventListener("keydown", onFind, true);
  }, []);

  useEffect(() => {
    if (!canSend || !mySocketId) return undefined;
    const onKeyDown = (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const m = /^Digit([1-7])$/.exec(e.code);
      if (!m) return;
      const idx = parseInt(m[1], 10) - 1;
      const list = loadQuickMessages();
      const text = String(list[idx] ?? "").trim();
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      sendTextContent(text);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [canSend, mySocketId, sendTextContent]);

  const uploadFiles = async (files, caption = "", skipAwayConfirm = false) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !canSend || !mySocketId) return;
    /**
     * Karşı taraf "dışarıda" iken dosya göndermek ESKİDEN engelleniyordu.
     * Bu yanlıştı: sunucu dosyayı zaten kuyruğa alıp kişi dönünce iletiyor ve
     * tamamen ÇEVRİMDIŞI birine dosya göndermek serbestti — masasından yeni
     * kalkmış birine engel koymak tutarsızdı. Üstelik otomatik "dışarıda"
     * (5 dk hareketsizlik) çok sık görülen bir durum. Artık engellemiyoruz;
     * yalnızca kullanıcı onaylasın diye bilgilendiriyoruz. Resimlerde bu
     * uyarı önizleme penceresinde ÖNCEDEN gösterildiği için burada tekrar
     * sorulmaz (emek verilip yazılan alt yazı boşa gitmesin).
     */
    if (peerIsAway && !skipAwayConfirm) {
      const proceed = window.confirm(
        t("fileAwayConfirm", { name: peerName || t("defaultUserName") })
      );
      if (!proceed) return;
    }
    const uploadBase = normalizeBase(activeSocketUrl || baseUrl);
    if (!uploadBase) {
      playSound("error");
      alert(t("uploadFailed"));
      return;
    }
    /**
     * WhatsApp benzeri alt yazı (caption): metin yalnızca TEK mesaja iliştirilir
     * — tercihen ilk resim, resim yoksa ilk dosya. Böylece çoklu yüklemede her
     * dosyaya tekrar yazılmaz.
     */
    const cap = String(caption || "").trim().slice(0, 8000);
    const captionIdx = cap ? Math.max(0, list.findIndex((f) => isImageMime(f.type))) : -1;
    setUploadingCount((c) => c + list.length);
    let okCount = 0;
    /** Sunucu alt yazıyı sakladı mı? (eski sunucularda yok sayılır) */
    let captionStored = false;
    const failedNames = [];
    for (const [idx, file] of list.entries()) {
      const clientMsgId = crypto.randomUUID();
      let uploaded = false;
      const form = new FormData();
      form.append("file", file);
      form.append("displayName", clampDisplayName(displayName) || t("defaultUserName"));
      form.append("clientUuid", clientUuid);
      form.append("fromSocketId", mySocketId);
      form.append("toSocketId", peerSocketId || "");
      form.append("peerClientUuid", peerClientUuid);
      form.append("clientMsgId", clientMsgId);
      if (cap && idx === captionIdx) form.append("caption", cap);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), uploadTimeoutMsForFile(file));
      const sentCaptionHere = Boolean(cap && idx === captionIdx);
      try {
        const res = await fetch(`${uploadBase}/api/upload`, {
          method: "POST",
          body: form,
          signal: controller.signal
        });
        uploaded = res.ok;
        /**
         * Alt yazının GERÇEKTEN saklandığını doğrula: sunucu 1.9.16'dan eski
         * ise `caption` alanını tanımaz, sessizce yok sayar ve yazı kaybolur
         * (composer'ı gönderirken temizlediğimiz için tamamen uçuyordu).
         * Yanıt `text_content` döndürmediyse alt yazı düşmüş demektir.
         */
        if (uploaded && sentCaptionHere) {
          try {
            const data = await res.json();
            captionStored = Boolean(data?.message?.text_content);
          } catch {
            captionStored = false;
          }
        }
      } catch {
        uploaded = false;
      } finally {
        clearTimeout(timeoutId);
        setUploadingCount((c) => Math.max(0, c - 1));
      }
      if (uploaded) {
        okCount += 1;
      } else {
        failedNames.push(file?.name || "");
      }
    }
    /**
     * Alt yazı iliştirilemediyse (eski sunucu) yazıyı kaybetme: ayrı bir
     * metin mesajı olarak gönder. Kullanıcı için sonuç yine "resim + yazı".
     */
    if (cap && okCount > 0 && !captionStored) {
      sendTextContent(cap);
    }
    if (okCount > 0) playSound("fileSent");
    if (failedNames.length === 0) return;
    playSound("error");
    if (failedNames.length === 1) {
      alert(t("uploadFailed"));
      return;
    }
    /**
     * Çoklu yükleme: tüm hatalar tek bir uyarıda toplansın; aksi halde
     * 5 dosyalık bir drop'ta arka arkaya 5 alert kutusu açılıyordu.
     */
    alert(t("uploadFailedMany", { count: failedNames.length }));
  };

  const requestUploadFiles = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !canSend || !mySocketId) return;
    const firstImage = list.find((file) => isImageMime(file.type));
    if (!firstImage) {
      await uploadFiles(list);
      return;
    }
    /** Composer'da yazı varsa alt yazıya taşı (WhatsApp gibi); gönderince temizlenir. */
    const currentDraft = (composerRef.current ? serializeComposer(composerRef.current) : draft).trim();
    setPendingCaption(currentDraft);
    setPendingImageUpload({
      files: list,
      previewFile: firstImage,
      previewUrl: URL.createObjectURL(firstImage),
      imageCount: list.filter((file) => isImageMime(file.type)).length
    });
  };

  const confirmPendingImageUpload = async () => {
    const files = pendingImageUpload?.files || [];
    const caption = pendingCaption;
    closePendingImageUpload();
    setPendingCaption("");
    /** Alt yazı resimle gitti → composer'ı temizle. */
    setDraft("");
    if (composerRef.current) composerRef.current.innerHTML = "";
    await uploadFiles(files, caption, true);
  };

  const onPaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await requestUploadFiles(files);
      return;
    }
    const text = e.clipboardData?.getData("text/plain");
    if (text && composerRef.current && composerRef.current.contains(e.target)) {
      e.preventDefault();
      document.execCommand("insertText", false, text);
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        normalizeUnicodeEmojiInEditor(el);
        setDraft(serializeComposer(el));
      });
    }
  };

  if (!peerClientUuid) {
    return (
      <div className="app-shell app-shell--chat-only">
        <p className="sidebar-hint">{t("chatWindowInvalidPeer")}</p>
      </div>
    );
  }

  return (
    <div className="app-shell app-shell--chat-only" data-chat-window="1">
      <div className="main-layout main-layout--chat-only">
        <div
          ref={chatDropRef}
          className={`chat-column chat-column--solo ${dragOver ? "chat-drop--active" : ""}`}
          onDragEnter={onChatDragEnter}
          onDragOver={onChatDragOver}
          onDragLeave={onChatDragLeave}
          onDrop={onChatDrop}
        >
          <section className="chat-panel">
            <header className="chat-peer-header">
              {peerProfileImage ? (
                <button
                  type="button"
                  className="chat-peer-header__avatar chat-peer-header__avatar-btn"
                  onClick={() => setProfileZoomOpen(true)}
                  title={t("profileImageSection")}
                  aria-label={t("profileImageSection")}
                >
                  <img className="chat-peer-header__avatar-img" src={peerProfileImage} alt="" />
                </button>
              ) : (
                <div className="chat-peer-header__avatar chat-peer-header__avatar--fallback" aria-hidden>
                  <span>{initialLetter(peerName || t("defaultUserName"), locale)}</span>
                </div>
              )}
              <div className="chat-peer-header__text">
                <h2 className="chat-peer-header__name">{peerName || t("defaultUserName")}</h2>
              </div>
              <button
                type="button"
                className="btn btn-poke"
                onClick={() => sendPoke()}
                disabled={!canSend || !mySocketId || !peerAllowsPoke}
                title={
                  !peerOnline
                    ? t("sendPokeDisabledOffline")
                    : !peerAllowsPoke
                      ? t("sendPokeDisabledNotAvailable")
                      : t("sendPokeTitle")
                }
                aria-label={t("sendPokeButton")}
              >
                <PokeBellIcon className="btn-poke__icon" />
                <span className="btn-poke__label">{t("sendPokeButton")}</span>
              </button>
              <button
                type="button"
                className="btn btn-history-open"
                onClick={() => setHistoryModalOpen(true)}
                disabled={!convIdMemo}
                title={t("chatHistoryButtonTitle")}
                aria-label={t("chatHistoryButtonTitle")}
              >
                {t("chatHistoryButtonOpen")}
                {pastMessagesTotal > 0 && !pastHistoryTruncated ? (
                  <span className="btn-history-open__count" aria-hidden>
                    {pastMessagesTotal}
                  </span>
                ) : null}
              </button>
            </header>
            {peerPresenceBannerKind ? (
              <div
                className={`chat-presence-banner chat-presence-banner--${peerPresenceBannerKind}`}
                role="status"
              >
                {peerPresenceBannerKind === "offline"
                  ? t("chatPeerOfflineHint")
                  : peerPresenceBannerKind === "busy"
                    ? t("chatPeerPresenceBusyBanner")
                    : t("chatPeerPresenceAwayBanner")}
              </div>
            ) : null}
            {pokeNotice.kind === "err" && pokeNotice.text ? (
              <div className={`poke-notice poke-notice--${pokeNotice.kind}`} role="alert">
                {pokeNotice.text}
              </div>
            ) : null}
            <div
              ref={scrollContainerRef}
              className="chat-messages-scroll"
              role="log"
              aria-label={t("chatMessagesAria")}
            >
              <p className="chat-session-label">{t("chatSessionLabel")}</p>
              {sessionMessages.length === 0 ? (
                <div className="hint-banner">
                  {pastMessagesTotal > 0 ? t("hintNoMessagesToday") : t("hintNoMessagesEver")}
                </div>
              ) : (
                sessionMessages.map((m) => (
                  <ChatMessageBubble
                    key={m.id}
                    m={m}
                    filePublicUrl={filePublicUrl}
                    isMine={isMineMessage(m)}
                    onDownloadAttachment={onDownloadAttachment}
                    onOpenDownloaded={onOpenDownloadedPath}
                    localPath={localDownloadByMessageId[String(m.id)] || ""}
                    onImagePreview={setAttachmentPreview}
                    statusState={statusStateForMessage(m)}
                    onRetryMessage={retryFailedMessage}
                    onDeleteMessage={deleteLocalMessage}
                    avatarImage={isMineMessage(m) ? myProfileImage : peerProfileImage}
                    avatarName={isMineMessage(m) ? displayName : peerName}
                    downloadProgress={downloadProgress[String(m.id)] || null}
                  />
                ))
              )}
              <div ref={bottomRef} />
            </div>
            {quoteSel && canSend && mySocketId ? (
              <button
                type="button"
                className={`quote-float${quoteSel.below ? " quote-float--below" : ""}`}
                style={{ left: quoteSel.x, top: quoteSel.y }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={quoteSelection}
              >
                <span className="quote-float__icon" aria-hidden>
                  ❝
                </span>
                {t("quoteSelection")}
              </button>
            ) : null}
          </section>

          <div className="chat-typing-strip" aria-live="polite">
            {uploadingCount > 0 ? (
              <div className="typing-indicator chat-upload-indicator" role="status">
                {t("filesUploading", { count: uploadingCount })}
              </div>
            ) : peerTyping ? (
              <div className="typing-indicator" role="status">
                {t("peerTyping", { name: peerName || t("defaultUserName") })}
              </div>
            ) : null}
          </div>
          <footer className="composer composer--stacked composer-drop">
            <div className="composer-row">
              <label className="sr-only" htmlFor="msg-input-chat">
                {t("msgLabel")}
              </label>
              <div className="composer-input-wrap">
                <div
                  ref={composerRef}
                  id="msg-input-chat"
                  className={`composer-editor${draft.trim() === "" ? " composer-editor--empty" : ""}`}
                  data-placeholder={canSend && mySocketId ? t("msgPlaceholder") : ""}
                  contentEditable={Boolean(canSend && mySocketId)}
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  spellCheck
                  onInput={handleComposerInput}
                  onPaste={onPaste}
                  onKeyDown={(e) => {
                    if (handleComposerKeyDown(e.currentTarget, e)) {
                      handleComposerInput();
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                />
              </div>
              <div ref={composerActionsRef} className="composer-actions">
                <button
                  type="button"
                  className={`btn btn-composer-emoji${emojiPickerOpen ? " is-open" : ""}`}
                  onClick={() => {
                    closeQuickPanel();
                    setEmojiPickerOpen((v) => !v);
                  }}
                  disabled={!canSend || !mySocketId}
                  title={t("emojiToolbarAria")}
                  aria-label={t("emojiToolbarAria")}
                  aria-expanded={emojiPickerOpen}
                >
                  <span className="btn-composer-emoji__icon" aria-hidden>
                    🙂
                  </span>
                </button>
                <button
                  type="button"
                  className={`btn btn-composer-quick${quickPanelOpen ? " is-open" : ""}`}
                  onClick={openQuickPanel}
                  disabled={!canSend || !mySocketId}
                  title={t("quickMessagesOpenTitle")}
                  aria-expanded={quickPanelOpen}
                >
                  {t("quickMessagesOpenButton")}
                </button>
                {emojiPickerOpen ? (
                  <div className="emoji-popover" role="toolbar" aria-label={t("emojiToolbarAria")}>
                    <div className="emoji-bar emoji-bar--svg emoji-bar--popover">
                      {EMOJI_QUICK_PICK.map((row) => (
                        <button
                          key={row.labelKey}
                          type="button"
                          className="emoji-bar__btn emoji-bar__btn--svg"
                          title={t(row.labelKey)}
                          onClick={() => insertEmoji(row.char)}
                          disabled={!canSend || !mySocketId}
                        >
                          <span className="emoji-bar__svg-wrap" aria-hidden>
                            <span className="emoji-bar__fallback-char">{row.char}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {quickPanelOpen ? (
                  <div className="qm-panel" role="dialog" aria-label={t("quickMessagesHeading")}>
                    <div className="qm-panel__head">
                      <span className="qm-panel__title">{t("quickMessagesHeading")}</span>
                      <button
                        type="button"
                        className="qm-panel__close"
                        onClick={closeQuickPanel}
                        aria-label={t("quickMessagesClose")}
                      >×</button>
                    </div>
                    <ul className="qm-panel__list">
                      {Array.from({ length: QUICK_MSG_COUNT }, (_, i) => {
                        const text = String(quickRows[i] ?? "").trim();
                        const isEditing = quickEditingSlot === i;
                        return (
                          <li key={i} className={`qm-row${isEditing ? " qm-row--editing" : ""}${!text && !isEditing ? " qm-row--empty" : ""}`}>
                            <kbd className="qm-row__kbd">Ctrl+{i + 1}</kbd>
                            {isEditing ? (
                              <textarea
                                className="qm-row__textarea"
                                autoFocus
                                rows={2}
                                value={quickRows[i] ?? ""}
                                onChange={(e) => onQuickMessageChange(i, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") { e.stopPropagation(); setQuickEditingSlot(null); }
                                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setQuickEditingSlot(null); }
                                }}
                                spellCheck
                                placeholder={t("quickMessagesSlotEmpty")}
                              />
                            ) : (
                              <button
                                type="button"
                                className="qm-row__send"
                                onClick={() => text ? sendQuickMessage(i) : setQuickEditingSlot(i)}
                                title={text ? t("quickMessagesSendHint", { n: i + 1 }) : t("quickMessagesSlotEmptyClick")}
                              >
                                {text
                                  ? <span className="qm-row__text">{text}</span>
                                  : <span className="qm-row__placeholder">{t("quickMessagesSlotEmpty")}</span>
                                }
                              </button>
                            )}
                            {!isEditing ? (
                              <button
                                type="button"
                                className="qm-row__edit"
                                onClick={() => setQuickEditingSlot(i)}
                                title={t("quickMessagesEditSlot")}
                                aria-label={t("quickMessagesEditSlot")}
                              >✎</button>
                            ) : (
                              <button
                                type="button"
                                className="qm-row__edit qm-row__edit--done"
                                onClick={() => setQuickEditingSlot(null)}
                                title={t("quickMessagesDone")}
                                aria-label={t("quickMessagesDone")}
                              >✓</button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="qm-panel__hint">{t("quickMessagesSendHintBottom")}</p>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={sendText}
                disabled={!canSend || !mySocketId || !draft.trim()}
              >
                {t("send")}
              </button>
            </div>
          </footer>
        </div>
      </div>
      {pendingImageUpload ? (
        <div className="modal-backdrop" role="presentation" onClick={closePendingImageUpload}>
          <div
            className="modal image-upload-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-upload-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="image-upload-confirm-title">{t("imageUploadConfirmTitle")}</h2>
              <button
                type="button"
                className="btn-modal-x"
                onClick={closePendingImageUpload}
                aria-label={t("cancel")}
              >
                ×
              </button>
            </div>
            <p className="image-upload-confirm-text">
              {t("imageUploadConfirmText", { name: peerName || t("defaultUserName") })}
            </p>
            <div className="image-upload-confirm-preview">
              <img
                src={pendingImageUpload.previewUrl}
                alt={pendingImageUpload.previewFile?.name || t("imageAlt")}
              />
            </div>
            <div className="image-upload-confirm-meta">
              <strong>{pendingImageUpload.previewFile?.name || t("imageAlt")}</strong>
              <span>
                {t("imageUploadConfirmFileMeta", {
                  size: formatFileSize(pendingImageUpload.previewFile?.size || 0)
                })}
              </span>
            </div>
            {pendingImageUpload.files.length > 1 ? (
              <p className="image-upload-confirm-note">
                {t("imageUploadConfirmMultiple", { count: pendingImageUpload.files.length })}
              </p>
            ) : null}
            {peerIsAway ? (
              <p className="image-upload-confirm-note image-upload-confirm-note--away" role="note">
                {t("fileAwayNotice", { name: peerName || t("defaultUserName") })}
              </p>
            ) : null}
            <textarea
              className="image-upload-caption"
              rows={2}
              autoFocus
              value={pendingCaption}
              onChange={(e) => setPendingCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void confirmPendingImageUpload();
                }
              }}
              placeholder={t("imageCaptionPlaceholder")}
              aria-label={t("imageCaptionPlaceholder")}
            />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={closePendingImageUpload}>
                {t("imageUploadConfirmCancel")}
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmPendingImageUpload}>
                {t("imageUploadConfirmSend")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {profileZoomOpen && peerProfileImage ? (
        <div className="chat-avatar-zoom-backdrop" role="presentation" onClick={() => setProfileZoomOpen(false)}>
          <div className="chat-avatar-zoom-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="chat-avatar-zoom-close"
              onClick={() => setProfileZoomOpen(false)}
              aria-label={t("cancel")}
            >
              ×
            </button>
            <img className="chat-avatar-zoom-image" src={peerProfileImage} alt={peerName || t("defaultUserName")} />
          </div>
        </div>
      ) : null}
      {attachmentPreview?.url ? (
        <div
          className="chat-avatar-zoom-backdrop"
          role="presentation"
          onClick={() => setAttachmentPreview(null)}
        >
          <div
            className="chat-avatar-zoom-modal chat-attachment-zoom-modal"
            role="dialog"
            aria-modal="true"
            aria-label={attachmentPreview.title || t("imageAlt")}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="btn preview-download-btn"
              onClick={() =>
                onDownloadAttachment({
                  messageId: attachmentPreview.messageId,
                  fileSize: attachmentPreview.fileSize,
                  url: attachmentPreview.url,
                  filename: attachmentPreview.title || t("fileFallback"),
                  mime: attachmentPreview.mime || "",
                  fileRel: attachmentPreview.fileRel || "",
                  openAfter: false
                })
              }
            >
              {t("download")}
            </button>
            <button
              type="button"
              className="chat-avatar-zoom-close"
              onClick={() => setAttachmentPreview(null)}
              aria-label={t("cancel")}
            >
              ×
            </button>
            {isImageMime(attachmentPreview.mime) ? (
              <img
                className="chat-avatar-zoom-image"
                src={attachmentPreview.url}
                alt={attachmentPreview.title || t("imageAlt")}
              />
            ) : isTextPreviewMime(attachmentPreview.mime) ? (
              <div className="text-preview">
                <div className="text-preview__title">{attachmentPreview.title || t("fileFallback")}</div>
                {textPreview.state === "loading" ? (
                  <div className="hint-banner">{t("previewLoading")}</div>
                ) : textPreview.state === "error" ? (
                  <div className="hint-banner">{t("previewError")}</div>
                ) : (
                  <>
                    {textPreview.truncated ? (
                      <div className="text-preview__note" role="note">
                        {t("previewTruncated", { rows: CSV_PREVIEW_MAX_ROWS })}
                      </div>
                    ) : null}
                    <div className="text-preview__body">
                      {textPreview.rows ? (
                        <table className="csv-table">
                          <tbody>
                            {textPreview.rows.map((row, ri) => (
                              <tr key={ri} className={ri === 0 ? "csv-table__head" : ""}>
                                {row.map((cell, ci) => (
                                  <td key={ci}>{cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <pre className="text-preview__pre">{textPreview.text}</pre>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <iframe
                className="chat-attachment-preview-frame"
                src={attachmentPreview.url}
                title={attachmentPreview.title || t("fileFallback")}
              />
            )}
          </div>
        </div>
      ) : null}
      {searchOpen ? (
        <div className="modal-backdrop history-modal-backdrop" role="presentation" onClick={closeSearch}>
          <div
            className="modal history-modal search-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="search-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="search-modal-title">
                {t("searchTitle")} — {peerName || t("defaultUserName")}
              </h2>
              <button type="button" className="btn-modal-x" onClick={closeSearch} aria-label={t("cancel")}>
                ×
              </button>
            </div>
            <div className="search-modal-bar">
              <input
                ref={searchInputRef}
                type="text"
                className="search-modal-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                autoFocus
              />
              <span className="search-modal-count">
                {searchQuery.trim().length < 2 ? "" : t("searchResultCount", { count: searchResults.length })}
              </span>
            </div>
            <div className="history-modal-body">
              {searchQuery.trim().length < 2 ? (
                <div className="hint-banner">{t("searchHint")}</div>
              ) : searchResults.length === 0 ? (
                <div className="hint-banner">{t("searchNoResults")}</div>
              ) : (
                searchResults.map((m) => (
                  <div key={m.id} className={`search-result${isMineMessage(m) ? " search-result--mine" : ""}`}>
                    <div className="search-result__meta">
                      <span className="search-result__sender">
                        {isMineMessage(m) ? displayName || t("defaultUserName") : m.sender || peerName}
                      </span>
                      <time className="search-result__time" dateTime={m.created_at}>
                        {formatMsgTime(m.created_at, locale)}
                      </time>
                    </div>
                    <div className="search-result__text">
                      <SearchHighlight
                        text={
                          m.text_content ||
                          normalizePossiblyMojibakeFilename(m.file_name || "") ||
                          t("fileFallback")
                        }
                        query={searchQuery}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
      {historyModalOpen ? (
        <div
          className="modal-backdrop history-modal-backdrop"
          role="presentation"
          onClick={() => setHistoryModalOpen(false)}
        >
          <div
            className="modal history-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="history-modal-title">
                {t("chatHistoryModalTitle")} — {peerName || t("defaultUserName")}
              </h2>
              <button
                type="button"
                className="btn-modal-x"
                onClick={() => setHistoryModalOpen(false)}
                aria-label={t("cancel")}
              >
                ×
              </button>
            </div>
            <div
              ref={historyModalBodyRef}
              className="history-modal-body"
              aria-label={t("chatHistoryAria")}
            >
              {pastDayGroups.length === 0 ? (
                <div className="hint-banner">{t("chatHistoryEmpty")}</div>
              ) : (
                <>
                  {pastHistoryTruncated ? (
                    <div className="hint-banner" role="note">
                      {t("chatHistoryTruncatedNotice", { n: PAST_HISTORY_DISPLAY_LIMIT })}
                    </div>
                  ) : null}
                  {pastDayGroups.map((group) => (
                  <React.Fragment key={group.dayKey}>
                    <div className="chat-day-divider" role="separator" aria-hidden>
                      <span className="chat-day-divider__line" />
                      <span className="chat-day-divider__label">{group.label}</span>
                      <span className="chat-day-divider__line" />
                    </div>
                    {group.messages.map((m) => (
                      <ChatMessageBubble
                        key={m.id}
                        m={m}
                        filePublicUrl={filePublicUrl}
                        isMine={isMineMessage(m)}
                        onDownloadAttachment={onDownloadAttachment}
                        onOpenDownloaded={onOpenDownloadedPath}
                        localPath={localDownloadByMessageId[String(m.id)] || ""}
                        onImagePreview={setAttachmentPreview}
                        statusState={statusStateForMessage(m)}
                        onRetryMessage={retryFailedMessage}
                        onDeleteMessage={deleteLocalMessage}
                        avatarImage={isMineMessage(m) ? myProfileImage : peerProfileImage}
                        avatarName={isMineMessage(m) ? displayName : peerName}
                        downloadProgress={downloadProgress[String(m.id)] || null}
                      />
                    ))}
                  </React.Fragment>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
