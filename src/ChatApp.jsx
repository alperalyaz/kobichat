import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyThemeToDocument,
  conversationId,
  getStoredTheme,
  isDmConvForPeerAndMe
} from "./theme.js";
import { EmojiRichText } from "./EmojiRichText.jsx";
import { EMOJI_QUICK_PICK, emojiFileForChar } from "./emojiMapper.js";
import { LANGS, MESSAGES } from "./i18n/messages.js";
import { detectBrowserLang, normalizeLang, useI18n } from "./i18n/I18nContext.jsx";
import { KOBI_BRIDGE } from "./socketBridge.js";
import {
  handleComposerKeyDown,
  insertEmojiImageAtCaret,
  normalizeUnicodeEmojiInEditor,
  serializeComposer
} from "./composerEmoji.js";
import { loadQuickMessages } from "./quickMessagesStorage.js";

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

function isTodayLocal(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
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

function initialLetter(name, dateLocale) {
  if (!name || !String(name).trim()) return "?";
  const ch = String(name).trim()[0];
  return ch.toLocaleUpperCase(dateLocale || "tr-TR");
}

async function playNotificationSound() {
  if (window.kobiChat?.playNotificationSound) {
    await window.kobiChat.playNotificationSound();
    return;
  }
  const rawBase = import.meta.env.BASE_URL || "/";
  const base = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
  const urls = [`${base}/assets/sounds/notification.mp3`, `${base}/assets/sounds/notification.wav`];
  const tryPlay = (index) => {
    if (index >= urls.length) return;
    try {
      const audio = new Audio(urls[index]);
      audio.volume = 0.42;
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => tryPlay(index + 1));
      }
    } catch {
      tryPlay(index + 1);
    }
  };
  tryPlay(0);
}

function parseChatWindowParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    peerId: String(p.get("peerId") || "").trim(),
    peerClientUuid: String(p.get("peerUuid") || "").trim(),
    peerName: decodeURIComponent(p.get("peerName") || ""),
    peerStatus: p.get("peerStatus") || "available"
  };
}

function ChatMessageBubble({ m, filePublicUrl, isMine, onDownloadAttachment, statusLabel }) {
  const { t, locale } = useI18n();
  const timeLabel = formatMsgTime(m.created_at, locale);
  return (
    <article className={`msg ${isMine ? "msg--mine" : ""}`}>
      <div className="msg-meta">
        <span className="msg-sender">{m.sender}</span>
        <span className="msg-meta-right">
          {isMine && statusLabel ? <span className="msg-status">{statusLabel}</span> : null}
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
                <span className="msg-file-expired__name">{m.file_name}</span>
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
                  <div className="msg-file-card__name" title={m.file_name || ""}>
                    {m.file_name || t("fileFallback")}
                  </div>
                  <div className="msg-file-card__meta">
                    <span className="msg-file-card__size">{formatFileSize(m.file_size)}</span>
                    {m.file_mime ? <span className="msg-file-card__mime">{m.file_mime}</span> : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="msg-file-card__action"
                  onClick={() =>
                    onDownloadAttachment?.({
                      url: filePublicUrl(m.file_rel),
                      filename: m.file_name || t("fileFallback"),
                      mime: m.file_mime || ""
                    })
                  }
                >
                  {t("download")}
                </button>
              </div>
              {isImageMime(m.file_mime) && m.file_rel ? (
                <img
                  className="msg-img msg-img--in-bubble"
                  src={filePublicUrl(m.file_rel)}
                  alt={m.file_name || t("imageAlt")}
                  onClick={() =>
                    onDownloadAttachment?.({
                      url: filePublicUrl(m.file_rel),
                      filename: m.file_name || "image",
                      mime: m.file_mime || ""
                    })
                  }
                />
              ) : null}
            </>
          )}
        </div>
      )}
    </article>
  );
}

export default function ChatApp() {
  const initialPeer = parseChatWindowParams();
  const peerClientUuid = initialPeer.peerClientUuid;
  const [peerSocketId, setPeerSocketId] = useState(initialPeer.peerId);
  const [peerName, setPeerName] = useState(initialPeer.peerName);
  const { t, locale, lang, setLang } = useI18n();
  const [baseUrl, setBaseUrl] = useState(() => "http://127.0.0.1:3847");
  const [displayName, setDisplayName] = useState(() => MESSAGES.tr.defaultUserName);
  const [clientUuid, setClientUuid] = useState("");
  const [mySocketId, setMySocketId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [lanReady, setLanReady] = useState(() => typeof window === "undefined" || !window.kobiChat);
  const [activeConvId, setActiveConvId] = useState(null);
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(true);
  const [messageStatusMap, setMessageStatusMap] = useState({});
  const [peerTyping, setPeerTyping] = useState(false);

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

  useEffect(() => {
    const name = (peerName && String(peerName).trim()) || t("defaultUserName");
    document.title = `${name} — KobiChat`;
  }, [peerName, t]);

  useEffect(() => {
    if (!window.kobiChat?.onChatPeerSocket) return undefined;
    return window.kobiChat.onChatPeerSocket((p) => {
      if (p?.peerId) setPeerSocketId(String(p.peerId).trim());
      if (typeof p?.peerDisplayName === "string" && p.peerDisplayName.trim()) {
        setPeerName(p.peerDisplayName.trim().slice(0, 80));
      }
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

  const scheduleScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    });
    setTimeout(scrollToBottom, 80);
  }, [scrollToBottom]);

  const applyConfig = useCallback(async () => {
    if (window.kobiChat) {
      const cfg = await window.kobiChat.getConfig();
      setBaseUrl(normalizeBase(cfg.socketUrl));
      setDisplayName(clampDisplayName(cfg.displayName) || t("defaultUserName"));
      if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
      setNotificationSoundEnabled(cfg.notificationSound !== false);
      if (cfg.language) setLang(normalizeLang(cfg.language));
    } else {
      setBaseUrl(normalizeBase(import.meta.env.VITE_SOCKET_URL || "http://127.0.0.1:3847"));
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

  useEffect(() => {
    let unsub;
    if (window.kobiChat) {
      unsub = window.kobiChat.onConfigUpdated((cfg) => {
        setBaseUrl(normalizeBase(cfg.socketUrl));
        setDisplayName(clampDisplayName(cfg.displayName) || t("defaultUserName"));
        if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
        setNotificationSoundEnabled(cfg.notificationSound !== false);
        if (cfg.language) setLang(normalizeLang(cfg.language));
      });
    }
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [t, setLang]);

  const convIdMemo = useMemo(() => {
    if (!clientUuid || !peerClientUuid) return null;
    return conversationId(clientUuid, peerClientUuid);
  }, [clientUuid, peerClientUuid]);

  const canChat = Boolean(peerSocketId && peerClientUuid && clientUuid);

  const isMineMessage = (m) => {
    if (!mySocketId || !m) return false;
    if (m.from_socket_id) return m.from_socket_id === mySocketId;
    return String(m.sender || "").trim() === (clampDisplayName(displayName) || t("defaultUserName"));
  };

  const bridgeSend = useCallback((payload) => {
    if (window.kobiChat?.sendToRoster) {
      window.kobiChat.sendToRoster(payload);
    } else {
      bridgeRef.current?.postMessage?.(payload);
    }
  }, []);

  const statusLabelForMessage = useCallback(
    (m) => {
      if (!m?.id || !isMineMessage(m)) return "";
      const st = messageStatusMap[String(m.id)];
      if (st === "read") return `✓✓ ${t("messageRead")}`;
      if (st === "delivered") return `✓ ${t("messageDelivered")}`;
      return "";
    },
    [messageStatusMap, t]
  );

  const markIncomingAsRead = useCallback(() => {
    if (!canChat || !mySocketId) return;
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
        messageId: m.id,
        conv_id: m.conv_id
      });
    }
  }, [canChat, mySocketId, bridgeSend]);

  const sendTypingState = useCallback(
    (isTyping) => {
      if (!canChat || !mySocketId) return;
      bridgeSend({
        type: "chat:typing",
        clientUuid,
        toSocketId: peerSocketId,
        peerClientUuid,
        conv_id: activeConvIdRef.current || convIdMemo || "",
        isTyping: Boolean(isTyping)
      });
    },
    [canChat, mySocketId, bridgeSend, clientUuid, peerSocketId, peerClientUuid, convIdMemo]
  );

  const isChatWindowActivelyViewed = useCallback(() => {
    return document.visibilityState === "visible" && document.hasFocus();
  }, []);

  useEffect(() => {
    setActiveConvId(convIdMemo);
  }, [convIdMemo]);

  useEffect(() => {
    if (!lanReady || !peerSocketId || !peerClientUuid) return undefined;
    const inst = instanceIdRef.current;
    const rid = dmRequestIdRef.current;
    const convKey = `${peerSocketId}|${peerClientUuid}`;
    if (bridgeConvKeyRef.current !== convKey) {
      bridgeConvKeyRef.current = convKey;
      dmOpenSentRef.current = false;
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
        if (!dmOpenSentRef.current) {
          dmOpenSentRef.current = true;
          postToRoster({
            type: "chat:dm-open",
            peerId: peerSocketId,
            peerClientUuid,
            myClientUuid: clientUuidRef.current || clientUuid,
            requestId: rid,
            instanceId: inst
          });
        }
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
        return;
      }

      if (d.type === "socket:history" && d.requestId === rid && d.peerId === peerSocketId) {
        const list = Array.isArray(d.payload?.messages) ? d.payload.messages : [];
        setMessages((prev) => {
          const combined = mergeMessageListsById(list, prev);
          messagesRef.current = combined;
          return combined;
        });
        return;
      }

      if (d.type === "socket:message:new") {
        const msg = d.msg;
        if (!msg?.conv_id) return;
        const my = clientUuidRef.current;
        const peer = peerClientUuid;
        if (!peer) return;
        if (!isDmConvForPeerAndMe(msg.conv_id, peer, my)) return;
        const fromSocket = msg?.from_socket_id;
        const sid = mySocketIdRef.current;
        const incoming =
          typeof fromSocket === "string" && fromSocket.length > 0 && fromSocket !== sid;
        if (incoming) {
          const appActive = document.hasFocus() && document.visibilityState !== "hidden";
          if (!appActive && notificationSoundEnabledRef.current) {
            const k = `snd-${fromSocket}-${msg.id}`;
            if (!soundPlayedForRef.current.has(k)) {
              soundPlayedForRef.current.add(k);
              void playNotificationSound();
            }
          }
          if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
          setPeerTyping(false);
        }
        setMessages((prev) => {
          if (prev.some((x) => String(x.id) === String(msg.id))) return prev;
          let base = prev;
          const sid = mySocketIdRef.current;
          const fromSelf =
            typeof msg?.from_socket_id === "string" &&
            sid &&
            String(msg.from_socket_id) === String(sid);
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
        scheduleScrollToBottom();
        if (incoming && isChatWindowActivelyViewed()) {
          requestAnimationFrame(markIncomingAsRead);
        }
        return;
      }

      if (d.type === "socket:message:status") {
        const payload = d.payload || {};
        if (payload?.messageId == null || typeof payload?.status !== "string") return;
        setMessageStatusMap((prev) => {
          const key = String(payload.messageId);
          const nextStatus = payload.status === "read" ? "read" : "delivered";
          const cur = prev[key];
          if (cur === "read" || cur === nextStatus) return prev;
          return { ...prev, [key]: nextStatus };
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

    if (window.kobiChat?.onRelayBroadcast && window.kobiChat?.sendToRoster) {
      bridgeRef.current = { sendToRoster: (p) => window.kobiChat.sendToRoster(p) };
      postToRoster({
        type: "chat:register",
        peerId: peerSocketId,
        peerClientUuid,
        instanceId: inst
      });
      unsubRelay = window.kobiChat.onRelayBroadcast(onPayload);
    } else {
      ch = new BroadcastChannel(KOBI_BRIDGE);
      bridgeRef.current = ch;
      ch.postMessage({ type: "chat:register", peerId: peerSocketId, peerClientUuid, instanceId: inst });
      const onBcMsg = (ev) => onPayload(ev.data);
      ch.addEventListener("message", onBcMsg);
      return () => {
        postToRoster({ type: "chat:unregister", peerId: peerSocketId, peerClientUuid, instanceId: inst });
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
      postToRoster({ type: "chat:unregister", peerId: peerSocketId, peerClientUuid, instanceId: inst });
      if (typeof unsubRelay === "function") unsubRelay();
      bridgeRef.current = null;
    };
  }, [lanReady, peerSocketId, peerClientUuid, scheduleScrollToBottom, markIncomingAsRead, isChatWindowActivelyViewed]);

  const pastMessages = useMemo(() => messages.filter((m) => !isTodayLocal(m.created_at)), [messages]);
  const sessionMessages = useMemo(() => messages.filter((m) => isTodayLocal(m.created_at)), [messages]);
  const pastDayGroups = useMemo(() => groupMessagesByDay(pastMessages, t, locale), [pastMessages, t, locale]);

  useEffect(() => {
    scheduleScrollToBottom();
  }, [messages.length, scheduleScrollToBottom]);

  useEffect(() => {
    const onFocus = () => scheduleScrollToBottom();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    if (!canChat || !mySocketId) return;
    if (isChatWindowActivelyViewed()) {
      requestAnimationFrame(markIncomingAsRead);
    }
  }, [messages.length, canChat, mySocketId, markIncomingAsRead, isChatWindowActivelyViewed]);

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
    return (rel) => `${baseUrl}/files/${encodeURIComponent(rel)}`;
  }, [baseUrl]);

  useEffect(() => {
    if (!canChat || !mySocketId) {
      const el = composerRef.current;
      if (el) el.innerHTML = "";
      setDraft("");
      setEmojiPickerOpen(false);
      hasAutoFocusRef.current = false;
    }
  }, [canChat, mySocketId]);

  useEffect(() => {
    if (!canChat || !mySocketId) return;
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
  }, [canChat, mySocketId, peerClientUuid]);

  useEffect(() => {
    hasAutoFocusRef.current = false;
    readSentRef.current = new Set();
    setMessageStatusMap({});
    setPeerTyping(false);
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
    if (!canChat || !mySocketId) return;
    setDragOver(true);
  };

  const onChatDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canChat || !mySocketId) return;
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
    if (dt?.files?.length) await uploadFiles(dt.files);
  };

  const onDownloadAttachment = useCallback(
    async ({ url, filename, mime }) => {
      if (!url) return;
      if (window.kobiChat?.downloadAndHandle) {
        const ok = await window.kobiChat.downloadAndHandle({
          url,
          filename: String(filename || ""),
          mime: String(mime || "")
        });
        if (!ok) {
          alert(t("downloadFailed"));
        }
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [t]
  );

  useEffect(() => {
    if (!emojiPickerOpen) return undefined;
    const onDocPointerDown = (e) => {
      const wrap = composerActionsRef.current;
      if (!wrap) return;
      const target = e.target;
      if (target instanceof Node && wrap.contains(target)) return;
      setEmojiPickerOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [emojiPickerOpen]);

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
    if (!el || !canChat || !mySocketId) return;
    insertEmojiImageAtCaret(el, char);
    normalizeUnicodeEmojiInEditor(el);
    setDraft(serializeComposer(el));
    setEmojiPickerOpen(false);
  };

  useEffect(() => {
    return () => {
      sendTypingState(false);
    };
  }, [sendTypingState]);

  const sendTextContent = useCallback(
    (rawText) => {
      const text = String(rawText || "").trim();
      if (!text || !canChat || !mySocketId) return;
      const cid =
        convIdMemo || (clientUuid && peerClientUuid ? conversationId(clientUuid, peerClientUuid) : "");
      const clientMsgId = crypto.randomUUID();
      if (cid) {
        const tempId = `local-${crypto.randomUUID()}`;
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
        scrollToBottom();
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
    },
    [
      canChat,
      mySocketId,
      convIdMemo,
      clientUuid,
      peerClientUuid,
      displayName,
      t,
      bridgeSend,
      peerSocketId,
      scrollToBottom
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

  const openQuickMessagesEditor = useCallback(() => {
    if (window.kobiChat?.openQuickMessagesWindow) {
      void window.kobiChat.openQuickMessagesWindow();
      return;
    }
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("mode", "quickMessages");
      window.open(u.toString(), "kobichat_quick_msgs", "noopener,noreferrer,width=440,height=540");
    } catch {
      // ignored
    }
  }, []);

  useEffect(() => {
    const onEscClose = (e) => {
      if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (!document.hasFocus()) return;
      e.preventDefault();
      e.stopPropagation();
      window.close();
    };
    document.addEventListener("keydown", onEscClose, true);
    return () => document.removeEventListener("keydown", onEscClose, true);
  }, []);

  useEffect(() => {
    if (!canChat || !mySocketId) return undefined;
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
  }, [canChat, mySocketId, sendTextContent]);

  const uploadFiles = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length || !canChat || !mySocketId) return;
    let targets = [baseUrl];
    if (window.kobiChat?.getConfig) {
      try {
        const cfg = await window.kobiChat.getConfig();
        targets = uniqueNormalizedUrls([baseUrl, cfg?.leaderSocketUrl, cfg?.socketUrl]);
      } catch {
        // ignored
      }
    }
    for (const file of list) {
      const clientMsgId = crypto.randomUUID();
      let uploaded = false;
      for (const target of targets) {
        const form = new FormData();
        form.append("file", file);
        form.append("displayName", clampDisplayName(displayName) || t("defaultUserName"));
        form.append("clientUuid", clientUuid);
        form.append("fromSocketId", mySocketId);
        form.append("toSocketId", peerSocketId);
        form.append("peerClientUuid", peerClientUuid);
        form.append("clientMsgId", clientMsgId);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), uploadTimeoutMsForFile(file));
        try {
          const res = await fetch(`${target}/api/upload`, {
            method: "POST",
            body: form,
            signal: controller.signal
          });
          if (res.ok) {
            uploaded = true;
            break;
          }
          const err = await res.json().catch(() => ({}));
          const msg = String(err?.error || "");
          // Peer offline/leader not ready gibi durumlarda sıradaki adayı dene.
          if (
            msg.includes("Karşı taraf çevrimiçi değil") ||
            msg.includes("Lider düğüm yazma için hazır değil")
          ) {
            continue;
          }
        } catch {
          // timeout/network — next target
        } finally {
          clearTimeout(timeoutId);
        }
      }
      if (!uploaded) {
        alert(t("uploadFailed"));
      }
    }
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
      await uploadFiles(files);
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

  if (!peerSocketId || !peerClientUuid) {
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
            <div className="chat-history-panel">
              <button
                type="button"
                className="chat-history-toggle"
                onClick={() => setHistoryOpen((o) => !o)}
                aria-expanded={historyOpen}
              >
                {t("chatHistoryToggle")}
                {pastMessages.length > 0 ? t("chatHistoryRecords", { n: pastMessages.length }) : ""}
              </button>
              {historyOpen ? (
                <div className="chat-history-scroll chat-history-scroll--compact" role="region" aria-label={t("chatHistoryAria")}>
                  {pastMessages.length === 0 ? (
                    <p className="chat-history-empty">{t("chatHistoryEmpty")}</p>
                  ) : (
                    pastDayGroups.map((group) => (
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
                            statusLabel={statusLabelForMessage(m)}
                          />
                        ))}
                      </React.Fragment>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <p className="chat-session-label">{t("chatSessionLabel")}</p>
            <div
              ref={scrollContainerRef}
              className="chat-messages-scroll"
              role="log"
              aria-label={t("chatMessagesAria")}
            >
              {sessionMessages.length === 0 ? (
                <div className="hint-banner">
                  {pastMessages.length > 0 ? t("hintNoMessagesToday") : t("hintNoMessagesEver")}
                </div>
              ) : (
                sessionMessages.map((m) => (
                      <ChatMessageBubble
                        key={m.id}
                        m={m}
                        filePublicUrl={filePublicUrl}
                        isMine={isMineMessage(m)}
                        onDownloadAttachment={onDownloadAttachment}
                        statusLabel={statusLabelForMessage(m)}
                      />
                    ))
              )}
              <div ref={bottomRef} />
            </div>
          </section>

          <div className="chat-typing-strip" aria-live="polite">
            {peerTyping ? (
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
                  data-placeholder={canChat && mySocketId ? t("msgPlaceholder") : ""}
                  contentEditable={Boolean(canChat && mySocketId)}
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
                  onClick={() => setEmojiPickerOpen((v) => !v)}
                  disabled={!canChat || !mySocketId}
                  title={t("emojiToolbarAria")}
                  aria-label={t("emojiToolbarAria")}
                  aria-expanded={emojiPickerOpen}
                >
                  <img
                    className="btn-composer-emoji__icon"
                    src={`${import.meta.env.BASE_URL || "./"}assets/emojis/${emojiFileForChar("😊")}`}
                    alt=""
                    draggable={false}
                  />
                </button>
                <button
                  type="button"
                  className="btn btn-composer-quick"
                  onClick={openQuickMessagesEditor}
                  disabled={!canChat || !mySocketId}
                  title={t("quickMessagesOpenTitle")}
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
                          disabled={!canChat || !mySocketId}
                        >
                          <span className="emoji-bar__svg-wrap" aria-hidden>
                            <img
                              className="emoji-bar__svg-icon"
                              src={`${import.meta.env.BASE_URL || "./"}assets/emojis/${emojiFileForChar(row.char)}`}
                              alt=""
                              draggable={false}
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                                const s = e.currentTarget.nextSibling;
                                if (s && s.classList?.contains("emoji-bar__fallback-char")) {
                                  s.style.display = "inline";
                                }
                              }}
                            />
                            <span className="emoji-bar__fallback-char" style={{ display: "none" }}>
                              {row.char}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={sendText}
                disabled={!canChat || !mySocketId || !draft.trim()}
              >
                {t("send")}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
