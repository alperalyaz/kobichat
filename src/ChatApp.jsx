import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyThemeToDocument,
  conversationId,
  getStoredTheme,
  isDmConvForPeerAndMe,
  normalizeClientUuid
} from "./theme.js";
import { EmojiRichText } from "./EmojiRichText.jsx";
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

/** Geçmiş modalında gösterilecek en fazla “önceki gün” mesajı (son N). */
const PAST_HISTORY_DISPLAY_LIMIT = 100;

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

/** Sunucudan gelen geçmiş ile ekrandaki (message:new ile eklenen) mesajları birleştirir; geç gelen history yanıtı yeni mesajları silmez. */
function mergeMessageListsById(incoming, previous) {
  const map = new Map();
  for (const m of incoming) {
    if (m?.id != null) map.set(String(m.id), m);
  }
  for (const m of previous) {
    if (m?.id != null && !map.has(String(m.id))) map.set(String(m.id), m);
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
}

function clampDisplayName(s) {
  return String(s ?? "")
    .trim()
    .slice(0, 21);
}

const MSG_CACHE_PREFIX = "kobiChatMsgCache_v1_";
const MSG_CACHE_MAX = 200;
const MSG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    const toSave = messages.slice(-MSG_CACHE_MAX);
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
  downloadProgress
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
            {isMine && statusState ? (
              <span
                className={`msg-status msg-status--${statusState}`}
                title={
                  statusState === "read"
                    ? t("messageRead")
                    : statusState === "delivered"
                      ? t("messageDelivered")
                      : statusState === "queued"
                        ? t("messageQueued")
                        : t("send")
                }
                aria-label={
                  statusState === "read"
                    ? t("messageRead")
                    : statusState === "delivered"
                      ? t("messageDelivered")
                      : statusState === "queued"
                        ? t("messageQueued")
                        : t("send")
                }
              >
                {statusState === "delivered" || statusState === "read" ? "✓✓" : "✓"}
              </span>
            ) : null}
            {timeLabel ? (
              <time className="msg-time" dateTime={m.created_at} title={timeLabel}>
                {timeLabel}
              </time>
            ) : null}
          </span>
        </div>
        {m.kind === "text" && (
          <div className="msg-body msg-body--emoji-rich">
            <EmojiRichText text={m.text_content ?? ""} />
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
                            mime: m.file_mime || ""
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
                        mime: m.file_mime || ""
                      })
                    }
                  />
                ) : null}
              </>
            )}
          </div>
        )}
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
  /** Electron: indirilen dosyanın tam yolu (mesaj id → path) */
  const [localDownloadByMessageId, setLocalDownloadByMessageId] = useState({});
  /** Electron: aktif indirme ilerlemesi (mesaj id → { received, total }) */
  const [downloadProgress, setDownloadProgress] = useState({});
  const [pendingImageUpload, setPendingImageUpload] = useState(null);
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

  const isMineMessage = (m) => {
    if (!m) return false;
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
      const incoming =
        typeof fromSocket === "string" && fromSocket.length > 0 && fromSocket !== sid;
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
        let base = prev;
        const sid2 = mySocketIdRef.current;
        const fromSelf =
          typeof msg?.from_socket_id === "string" &&
          sid2 &&
          String(msg.from_socket_id) === String(sid2);
        if (fromSelf && msg.kind === "text") {
          base = prev.filter((m) => {
            if (!String(m.id).startsWith("local-")) return true;
            return !(
              m.kind === "text" &&
              m.text_content === msg.text_content &&
              m.conv_id === msg.conv_id
            );
          });
        }
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
          const combined = mergeMessageListsById(list, prev);
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
        myMessageIdsRef.current.add(String(payload.messageId));
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
        myMessageIdsRef.current.add(mid);
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
    if (!canSend || !mySocketId) return;
    if (isChatWindowActivelyViewed()) {
      requestAnimationFrame(markIncomingAsRead);
    }
  }, [messages.length, canSend, mySocketId, markIncomingAsRead, isChatWindowActivelyViewed]);

  useEffect(() => {
    const onVisible = () => {
      if (isChatWindowActivelyViewed()) {
        markIncomingAsRead();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [markIncomingAsRead, isChatWindowActivelyViewed]);

  const filePublicUrl = useMemo(() => {
    const fileBase = normalizeBase(activeSocketUrl || baseUrl);
    return (rel) => `${fileBase}/files/${encodeURIComponent(rel)}`;
  }, [activeSocketUrl, baseUrl]);

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
          setDownloadProgress((prev) => { const n = { ...prev }; delete n[String(messageId)]; return n; });
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
          client_msg_id: clientMsgId
        };
        setMessages((prev) => {
          const next = mergeMessageListsById([optimistic], prev);
          messagesRef.current = next;
          return next;
        });
        /** Kendi mesajım — pozisyondan bağımsız olarak dibe getir ki yazdığım hemen görünsün. */
        scheduleScrollToBottom({ force: true });
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
      e.preventDefault();
      e.stopPropagation();
      window.close();
    };
    document.addEventListener("keydown", onEscClose, true);
    return () => document.removeEventListener("keydown", onEscClose, true);
  }, [profileZoomOpen, attachmentPreview, pendingImageUpload, closePendingImageUpload, historyModalOpen, quickPanelOpen, closeQuickPanel]);

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

  const uploadFiles = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !canSend || !mySocketId) return;
    const uploadBase = normalizeBase(activeSocketUrl || baseUrl);
    if (!uploadBase) {
      playSound("error");
      alert(t("uploadFailed"));
      return;
    }
    setUploadingCount((c) => c + list.length);
    let okCount = 0;
    const failedNames = [];
    for (const file of list) {
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), uploadTimeoutMsForFile(file));
      try {
        const res = await fetch(`${uploadBase}/api/upload`, {
          method: "POST",
          body: form,
          signal: controller.signal
        });
        uploaded = res.ok;
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
    setPendingImageUpload({
      files: list,
      previewFile: firstImage,
      previewUrl: URL.createObjectURL(firstImage),
      imageCount: list.filter((file) => isImageMime(file.type)).length
    });
  };

  const confirmPendingImageUpload = async () => {
    const files = pendingImageUpload?.files || [];
    closePendingImageUpload();
    await uploadFiles(files);
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
                {pastMessagesTotal > 0 ? (
                  <span className="btn-history-open__count" aria-hidden>
                    {pastHistoryTruncated ? `${PAST_HISTORY_DISPLAY_LIMIT}+` : pastMessagesTotal}
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
                    avatarImage={isMineMessage(m) ? myProfileImage : peerProfileImage}
                    avatarName={isMineMessage(m) ? displayName : peerName}
                    downloadProgress={downloadProgress[String(m.id)] || null}
                  />
                ))
              )}
              <div ref={bottomRef} />
            </div>
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
