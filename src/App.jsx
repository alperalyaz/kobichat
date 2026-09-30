import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { io } from "socket.io-client";
import {
  applyThemeToDocument,
  getStoredTheme,
  normalizeClientUuid,
  peerClientUuidFromConvId,
  setStoredTheme
} from "./theme.js";
import { LANGS, MESSAGES } from "./i18n/messages.js";
import { detectBrowserLang, normalizeLang, useI18n } from "./i18n/I18nContext.jsx";
import { LanguageSelectWithFlags } from "./i18n/LanguageSelect.jsx";
import ChatApp from "./ChatApp.jsx";
import QuickMessagesApp from "./QuickMessagesApp.jsx";
import BoardPanel from "./board/BoardPanel.jsx";
import { schedKind } from "./board/kinds.js";
import { KOBI_BRIDGE } from "./socketBridge.js";
import { useAppVersion } from "./useAppVersion.js";
import htLogoUrl from "../ht_logo.webp";
import {
  bootstrapSoundPrefs,
  playSound,
  preloadAllSounds,
  setSoundPrefs
} from "./sounds.js";

/** Kişi listesini öne getiren genel kısayolun varsayılanı (Electron accelerator). */
const DEFAULT_GLOBAL_SHORTCUT = "CommandOrControl+Shift+K";

/**
 * Klavye olayını Electron accelerator biçimine çevirir ("CommandOrControl+Shift+K").
 * Değiştirici tuş içermeyen ya da yalnızca Shift'li kombinasyonlar reddedilir:
 * genel kısayol oldukları için normal yazmayı ele geçirirlerdi.
 * Harf/rakam tespitinde `e.code` kullanılır; böylece klavye düzeninden bağımsızdır.
 */
function acceleratorFromKeyEvent(e) {
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const code = String(e.code || "");
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  else if (code === "Enter") key = "Return";
  else if (code === "Tab") key = "Tab";
  else if (code === "Backslash") key = "\\";
  else if (code === "Slash") key = "/";
  else if (code === "Period") key = ".";
  else if (code === "Comma") key = ",";
  else if (code === "Minus") key = "-";
  else if (code === "Equal") key = "=";
  else if (code === "BracketLeft") key = "[";
  else if (code === "BracketRight") key = "]";
  else if (code === "Semicolon") key = ";";
  else if (code === "Quote") key = "'";
  else if (code === "Backquote") key = "`";
  if (!key) return "";
  if (mods.length === 0) return "";
  if (mods.every((m) => m === "Shift")) return "";
  return [...mods, key].join("+");
}

/** Accelerator'ı okunabilir biçimde göster: "CommandOrControl+Shift+K" → "Ctrl + Shift + K" */
function prettyAccelerator(accel) {
  return String(accel || "")
    .split("+")
    .map((p) => (p === "CommandOrControl" || p === "Control" ? "Ctrl" : p === "Super" || p === "Meta" ? "Win" : p))
    .join(" + ");
}

function normalizeBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

function activeSocketBaseFromRef(socketRef, fallbackBase = "") {
  const connectedUri = normalizeBase(socketRef?.current?.io?.uri || "");
  if (connectedUri) return connectedUri;
  return normalizeBase(fallbackBase || "");
}

function mapUiPresenceToServer(ui) {
  if (ui === "mesgul") return "busy";
  if (ui === "disarida") return "away";
  return "available";
}

function mapServerPresenceToUi(s) {
  if (s === "busy") return "mesgul";
  if (s === "away") return "disarida";
  return "uygun";
}

/** Sunucu listesinde aynı clientUuid için hem çevrimiçi hem cache satırı gelirse çevrimiçiyi tut. */
function dedupeRosterByClientUuid(users) {
  const noUuid = [];
  const byKey = new Map();
  for (const u of users) {
    const k = normalizeClientUuid(u.clientUuid);
    if (!k) {
      noUuid.push(u);
      continue;
    }
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, u);
      continue;
    }
    const prevOn = prev.online !== false;
    const uOn = u.online !== false;
    let pick = prev;
    if (uOn && !prevOn) pick = u;
    else if (prevOn && !uOn) pick = prev;
    else {
      const prevOffline = String(prev.id || "").startsWith("offline:");
      const uOffline = String(u.id || "").startsWith("offline:");
      if (prevOffline && !uOffline) pick = u;
      else if (!prevOffline && uOffline) pick = prev;
      else pick = u;
    }
    byKey.set(k, pick);
  }
  return [...noUuid, ...byKey.values()];
}

function presenceDotClass(ui) {
  if (ui === "mesgul") return "presence-dot presence-dot--mesgul";
  if (ui === "disarida") return "presence-dot presence-dot--disarida";
  return "presence-dot presence-dot--uygun";
}

const DISPLAY_NAME_MAX = 21;
const UPDATE_BUTTON_COOLDOWN_MS = 30 * 1000;
const ROSTER_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const ROSTER_CACHE_KEY = "kobiChatRosterCache";
/**
 * Aynı peer için art arda gelen `message:new` bildirimlerinin (ses + flash +
 * sohbet penceresi açma) bastırılma penceresi. Queued flush sırasında 50+
 * mesaj birden gelebilir; bu süre içindeki ek mesajlar yalnızca okunmamış
 * sayacına eklenir, ek dikkat sinyali üretmez.
 */
const INCOMING_ATTENTION_THROTTLE_MS = 2500;
/** Sunucu `PROFILE_IMAGE_SOCKET_MAX` ile uyumlu; localStorage şişmesini sınırlar. */
const ROSTER_CACHE_PROFILE_IMAGE_MAX = 90000;

function sanitizeRosterProfileImage(raw) {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("data:image/")) return "";
  if (s.length > ROSTER_CACHE_PROFILE_IMAGE_MAX) return s.slice(0, ROSTER_CACHE_PROFILE_IMAGE_MAX);
  return s;
}

function clampDisplayName(s) {
  return String(s ?? "")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
}

function normalizeRosterCacheUser(u) {
  const clientUuid = normalizeClientUuid(u?.clientUuid);
  if (!clientUuid) return null;
  return {
    id: `offline:${clientUuid}`,
    displayName: clampDisplayName(u?.displayName) || "Anonim",
    clientUuid,
    status: u?.status || "available",
    profileImage: sanitizeRosterProfileImage(u?.profileImage),
    online: false,
    last_seen_at: u?.last_seen_at || new Date().toISOString()
  };
}

function loadRosterCache() {
  try {
    const raw = localStorage.getItem(ROSTER_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeRosterByClientUuid(parsed.map(normalizeRosterCacheUser).filter(Boolean)).slice(0, 400);
  } catch {
    return [];
  }
}

function saveRosterCache(users) {
  try {
    localStorage.setItem(
      ROSTER_CACHE_KEY,
      JSON.stringify((users || []).map(normalizeRosterCacheUser).filter(Boolean).slice(0, 400))
    );
  } catch {
    // ignored
  }
}

function mergeRosterCache(prev, users, selfClientUuid = "") {
  const self = normalizeClientUuid(selfClientUuid);
  const byUuid = new Map();
  for (const u of prev || []) {
    const normalized = normalizeRosterCacheUser(u);
    if (!normalized || normalized.clientUuid === self) continue;
    byUuid.set(normalized.clientUuid, normalized);
  }
  for (const u of users || []) {
    const normalized = normalizeRosterCacheUser(u);
    if (!normalized || normalized.clientUuid === self) continue;
    byUuid.set(normalized.clientUuid, {
      ...normalized,
      displayName: clampDisplayName(u.displayName) || normalized.displayName,
      status: u.status || normalized.status,
      last_seen_at: u.last_seen_at || new Date().toISOString(),
      profileImage:
        sanitizeRosterProfileImage(u.profileImage) || normalized.profileImage || ""
    });
  }
  return Array.from(byUuid.values()).slice(0, 400);
}

function userAvatarClass(ui) {
  if (ui === "mesgul") return "user-avatar user-avatar--mesgul";
  if (ui === "disarida") return "user-avatar user-avatar--disarida";
  return "user-avatar user-avatar--uygun";
}

function initialLetter(name, dateLocale) {
  if (!name || !String(name).trim()) return "?";
  const ch = String(name).trim()[0];
  return ch.toLocaleUpperCase(dateLocale || "tr-TR");
}

const PROFILE_IMAGE_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const PROFILE_IMAGE_SIZE = 96;
const WEB_SETTINGS_KEY = "kobiChatWebSettings";

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

function saveWebSettings(partial) {
  const cur = loadWebSettings();
  const next = { ...cur, ...partial };
  try {
    localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignored
  }
  return next;
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

async function getInitialBaseUrl() {
  if (typeof window !== "undefined" && window.kobiChat) {
    const cfg = await window.kobiChat.getConfig();
    return normalizeBase(cfg.socketUrl);
  }
  const fromQuery = readBrowserSocketUrlFromQuery();
  if (fromQuery) return fromQuery;
  const ws = loadWebSettings();
  const fromWebSettings = normalizeBase(ws.socketUrl || "");
  return fromWebSettings || normalizeBase(import.meta.env.VITE_SOCKET_URL || "http://127.0.0.1:3847");
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode-failed"));
      img.onload = () => resolve(img);
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

async function normalizeProfileImageDataUrl(file) {
  if (!file) return "";
  if (!String(file.type || "").startsWith("image/")) {
    throw new Error("invalid-type");
  }
  if (Number(file.size || 0) > PROFILE_IMAGE_MAX_INPUT_BYTES) {
    throw new Error("too-large");
  }
  const img = await loadImageFromFile(file);
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const sx = Math.max(0, ((img.naturalWidth || img.width) - side) / 2);
  const sy = Math.max(0, ((img.naturalHeight || img.height) - side) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = PROFILE_IMAGE_SIZE;
  canvas.height = PROFILE_IMAGE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-failed");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, PROFILE_IMAGE_SIZE, PROFILE_IMAGE_SIZE);
  return canvas.toDataURL("image/webp", 0.86);
}

function InfoApp() {
  const { t } = useI18n();
  const appVersion = useAppVersion();
  const isPartyMode = new URLSearchParams(window.location.search).get("party") === "1";
  const officialNoticeUrl =
    "https://www.hidroteknik.com.tr/bizden-haberler/kobichat-uygulamam%C4%B1z-yay%C4%B1nland%C4%B1";

  useEffect(() => {
    document.title = "Bilgi - KobiChat";
  }, []);

  const openLink = (e, url) => {
    if (!window.kobiChat?.openExternal) return;
    e.preventDefault();
    void window.kobiChat.openExternal(url);
  };

  useEffect(() => {
    if (!isPartyMode) return undefined;
    const audio = new Audio(`${import.meta.env.BASE_URL}hidroteknik.mp3`);
    audio.volume = 0.55;
    audio.loop = true;
    void audio.play().catch(() => {
      // Electron bazı ortamlarda autoplay'i kısabilir; görsel şaka yine çalışır.
    });
    return () => {
      audio.pause();
      audio.src = "";
    };
  }, [isPartyMode]);

  return (
    <div className={`info-window-shell ${isPartyMode ? "info-window-shell--party info-window-shell--party-enter" : ""}`}>
      <header className="info-titlebar">
        <button
          type="button"
          className="info-close-btn"
          onClick={() => window.close()}
          aria-label={t("cancel")}
          title={t("cancel")}
        >
          ×
        </button>
      </header>

      <div className="info-body">
        {/* ── Marka kartı ── */}
        <div className="info-hero">
          <img className="info-hero-logo" src={`${import.meta.env.BASE_URL}icon.png`} alt="KobiChat" />
          <div className="info-hero-text">
            <span className="info-hero-name">KobiChat</span>
            {appVersion ? <span className="info-hero-version">v{appVersion}</span> : null}
          </div>
        </div>

        {/* ── Hakkında ── */}
        <div className="info-section">
          <span className="info-section-label">{t("infoProduct")}</span>
          <p className="info-section-body">
            KOBİ&apos;lerin ücretsiz ve özgürce faydalanabilmesi için bu uygulama tamamen ücretsiz, sınırsız ve
            özelleştirilebilir şekilde sunulmaktadır. Hidroteknik Anonim Şirketi çalışanlarının diğer KOBİ
            emekçilerine bir hediyesidir.
          </p>
        </div>

        {/* ── Teknik destek ── */}
        <div className="info-section">
          <span className="info-section-label">{t("infoSupport")}</span>
          <div className="info-section-body">
            <span className="info-support-role">Proje Lideri ve Sorumlusu</span>
            <span className="info-support-name">Serkan Yavuz Mercan</span>
            <a
              className="info-support-mail"
              href="mailto:serkan.mercan@hidroteknik.com.tr"
              onClick={(e) => openLink(e, "mailto:serkan.mercan@hidroteknik.com.tr")}
            >
              serkan.mercan@hidroteknik.com.tr
            </a>
          </div>
        </div>

        {/* ── Kurumsal bildirim ── */}
        <a
          className="info-corporate-card"
          href={officialNoticeUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => openLink(e, officialNoticeUrl)}
        >
          <img className="info-corporate-ht-logo" src={htLogoUrl} alt="Hidroteknik" />
          <span className="info-corporate-label">Hidroteknik Kurumsal Bildirim →</span>
        </a>
      </div>
    </div>
  );
}

function RosterApp({ settingsOnly = false }) {
  const { t, locale, lang, setLang } = useI18n();
  const appVersion = useAppVersion();

  const presenceText = useCallback(
    (ui) => {
      if (ui === "mesgul") return t("presenceBusy");
      if (ui === "disarida") return t("presenceAway");
      return t("presenceAvailable");
    },
    [t]
  );

  const [baseUrl, setBaseUrl] = useState(() => "http://127.0.0.1:3847");
  const [connected, setConnected] = useState(false);
  const [displayName, setDisplayName] = useState(() => MESSAGES.tr.defaultUserName);
  const [settingsDisplayName, setSettingsDisplayName] = useState("");
  const [profileImage, setProfileImage] = useState("");
  const [settingsProfileImage, setSettingsProfileImage] = useState("");
  const [settingsSocketUrl, setSettingsSocketUrl] = useState("");
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(true);
  const [settingsNotificationSound, setSettingsNotificationSound] = useState(true);
  /** Yeni: kategori bazlı ses anahtarları (varsayılan: presence kapalı). */
  const [soundCategories, setSoundCategoriesState] = useState({
    message: true,
    file: true,
    system: true,
    presence: false
  });
  const [settingsSoundCategories, setSettingsSoundCategories] = useState({
    message: true,
    file: true,
    system: true,
    presence: false
  });
  /** Yeni: master volume 0..1 (varsayılan 1.0). */
  const [soundVolume, setSoundVolumeState] = useState(1);
  const [settingsSoundVolume, setSettingsSoundVolume] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverMode, setServerMode] = useState("remote");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState(3847);
  const [localPort, setLocalPort] = useState(3847);
  const [savingSettings, setSavingSettings] = useState(false);
  const [checkingUpdateNow, setCheckingUpdateNow] = useState(false);
  const [updateCooldownUntil, setUpdateCooldownUntil] = useState(0);
  const [updateCooldownNow, setUpdateCooldownNow] = useState(() => Date.now());
  const [updateCheckNotice, setUpdateCheckNotice] = useState("");
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [rosterCacheUsers, setRosterCacheUsers] = useState(() => loadRosterCache());
  const [mySocketId, setMySocketId] = useState(null);
  const [clientUuid, setClientUuid] = useState("");
  const [theme, setTheme] = useState(() => getStoredTheme());
  const [lanReady, setLanReady] = useState(() => typeof window === "undefined" || !window.kobiChat);
  const [discoverInfo, setDiscoverInfo] = useState({ key: "empty" });
  const [presenceStatus, setPresenceStatus] = useState("uygun");
  /** Sistem boşta (klavye/fare hareketsiz) — main process powerMonitor'dan gelir. */
  const [systemIdle, setSystemIdle] = useState(false);
  const [settingsPresenceStatus, setSettingsPresenceStatus] = useState("uygun");
  const [settingsLang, setSettingsLang] = useState(() => normalizeLang(lang));
  const [settingsTheme, setSettingsTheme] = useState(() => getStoredTheme());
  /** Genel kısayol (taslak) + son kayıt denemesinin sonucu. */
  const [settingsShortcut, setSettingsShortcut] = useState(DEFAULT_GLOBAL_SHORTCUT);
  const [shortcutOk, setShortcutOk] = useState(true);
  const [unreadPeerIds, setUnreadPeerIds] = useState([]);
  const [rosterDropPeerKey, setRosterDropPeerKey] = useState("");
  /**
   * Toplu mesaj: Ctrl+tık ile seçilen kişilerin clientUuid listesi, yazma
   * penceresi ve gönderim durumu.
   */
  const [bulkSelected, setBulkSelected] = useState([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkSending, setBulkSending] = useState(false);
  /** Pano notu/menüsü değişti, kullanıcı henüz panoyu açmadı. */
  const [boardUnseen, setBoardUnseen] = useState(false);
  /** Pano çekmecesi (sustalı): listenin solundan kayarak açılır. */
  const [boardOpen, setBoardOpen] = useState(false);
  /** Çekmece açıkken liste sütunu sabit genişlikte kalır; pano kalan alana yayılır. */
  const [rosterColWidth, setRosterColWidth] = useState(0);
  const rosterColRef = useRef(null);
  const boardAnimatingRef = useRef(false);

  const toggleBoard = useCallback(async () => {
    if (boardAnimatingRef.current) return;
    boardAnimatingRef.current = true;
    try {
      if (!boardOpen) {
        const w = rosterColRef.current?.getBoundingClientRect().width || 0;
        setRosterColWidth(window.kobiChat ? Math.round(w) : Math.min(Math.round(w), 300));
        setBoardOpen(true);
        setBoardUnseen(false);
        await window.kobiChat?.setMainWindowMode?.("board");
      } else {
        await window.kobiChat?.setMainWindowMode?.("roster");
        setBoardOpen(false);
      }
    } finally {
      boardAnimatingRef.current = false;
    }
  }, [boardOpen]);

  useEffect(() => {
    /** Yeniden yüklemede pencere Pano boyutunda kalmasın. */
    if (!settingsOnly) void window.kobiChat?.setMainWindowMode?.("roster");
  }, [settingsOnly]);

  useEffect(() => {
    if (!settingsOnly) return;
    document.title = `${t("settingsTitle")} — KobiChat`;
  }, [settingsOnly, t]);

  useEffect(() => {
    if (typeof window.kobiChat?.onAttentionCssBurst !== "function") return undefined;
    return window.kobiChat.onAttentionCssBurst(() => {
      const root = document.getElementById("root") || document.documentElement;
      root.classList.remove("kobi-attention-poke-incoming");
      void root.offsetWidth;
      root.classList.add("kobi-attention-poke-incoming");
      window.setTimeout(() => {
        root.classList.remove("kobi-attention-poke-incoming");
      }, 1200);
    });
  }, []);

  const socketRef = useRef(null);
  const tRef = useRef(t);
  const clientUuidRef = useRef("");
  const displayNameRef = useRef("");
  const profileImageRef = useRef("");
  const presenceStatusRef = useRef("uygun");
  const notificationSoundEnabledRef = useRef(true);
  const mySocketIdRef = useRef(null);
  const onlineUsersRef = useRef([]);
  const soundPlayedForRef = useRef(new Set());
  const broadcastChRef = useRef(null);
  const openChatPeersRef = useRef(new Set());
  const dmOpenMetaByPeerRef = useRef(new Map());
  /**
   * Peer başına son bildirim (ses + flash + pencere açma) zamanı.
   * Offline kullanıcı bağlandığında 50–100 queued mesaj birden gelebilir;
   * her biri için ayrı ses çalmak ve pencere açma IPC'si göndermek hem
   * yararsız hem de can sıkıcı. Bu Map sayesinde aynı peer için kısa
   * süre içinde tekrarlayan dikkat sinyalleri sessize alınır.
   */
  const lastAttentionAtByPeerRef = useRef(new Map());
  /** Önceki bağlantı durumu — false → true geçişinde "connected" sesi çıkar. */
  const wasConnectedRef = useRef(false);
  /**
   * Uygulama oturumu boyunca en az bir kez başarılı bağlantı kuruldu mu?
   * `connect_error` yalnızca true iken sesli uyarıya dönüşür.
   */
  const hadConnectedAtLeastOnceRef = useRef(false);
  /**
   * Önceki roster snapshot'ında kimler "online" idi (clientUuid set'i).
   * `null` iken: ilk roster geldiğinde sessizce baseline'ı kur (ses çalma).
   */
  const prevRosterCuRef = useRef(null);

  /**
   * Yeni roster geldiğinde online/offline geçişlerini sesle bildirir.
   * - Self kullanıcıyı dışarıda bırakır.
   * - İlk roster'da hiç ses çalmaz (uygulama yeni açılmış olabilir).
   * - Aynı seste 1500 ms throttle modül tarafından uygulanır.
   */
  function detectPresenceTransitionsAndPlay(nextList) {
    const myCu = String(clientUuidRef.current || "").trim().toLowerCase();
    const nextOnlineCus = new Set();
    for (const u of nextList) {
      if (u?.online === false) continue;
      const k = String(u?.clientUuid || "").trim().toLowerCase();
      if (!k) continue;
      if (myCu && k === myCu) continue;
      nextOnlineCus.add(k);
    }

    const prev = prevRosterCuRef.current;
    if (prev == null) {
      /** İlk roster — yalnızca baseline kur, ses yok. */
      prevRosterCuRef.current = nextOnlineCus;
      return;
    }

    let camOnline = false;
    let wentOffline = false;
    for (const k of nextOnlineCus) {
      if (!prev.has(k)) camOnline = true;
    }
    for (const k of prev) {
      if (!nextOnlineCus.has(k)) wentOffline = true;
    }
    prevRosterCuRef.current = nextOnlineCus;
    if (camOnline) playSound("userOnline");
    if (wentOffline) playSound("userOffline");
  }
  const dmQueueRef = useRef([]);
  const processingDmRef = useRef(false);
  const pendingDmRef = useRef(null);
  const suppressPeerClickUntilRef = useRef(0);
  const profileInputRef = useRef(null);
  const settingsLastSavedRef = useRef(null);
  const settingsAutoSaveTimerRef = useRef(null);

  clientUuidRef.current = clientUuid;
  displayNameRef.current = displayName;
  profileImageRef.current = profileImage;
  presenceStatusRef.current = presenceStatus;
  /**
   * Otomatik "Dışarıda" (Softros benzeri): sistem boştayken ve kullanıcı
   * "uygun" iken efektif durum "disarida" olur. Kullanıcının ELLE seçtiği
   * meşgul/dışarıda asla ezilmez; ayarlara da yazılmaz (kalıcı tercih
   * "uygun" kalır) — ilk harekette türetilmiş değer kendiliğinden geri döner.
   */
  const effectivePresenceStatus =
    systemIdle && presenceStatus === "uygun" ? "disarida" : presenceStatus;
  const effectivePresenceStatusRef = useRef("uygun");
  effectivePresenceStatusRef.current = effectivePresenceStatus;
  notificationSoundEnabledRef.current = notificationSoundEnabled;
  tRef.current = t;

  useEffect(() => {
    mySocketIdRef.current = mySocketId;
  }, [mySocketId]);

  const discoverDisplay = useMemo(() => {
    const d = discoverInfo;
    switch (d.key) {
      case "empty":
        return "";
      case "scanning":
        return t("discoverScanning");
      case "scanning_network":
        return t("discoverScanNetwork");
      case "local_server":
        return t("discoverLocalServer");
      case "found_auto":
        return t("discoverFoundAuto", { host: d.host, port: d.port });
      case "found_manual":
        return t("discoverFoundManual", { host: d.host, port: d.port });
      case "not_found":
        return t("discoverNotFound");
      case "not_found_fixed":
        return t("discoverNotFoundFixed", { host: d.host, port: d.port });
      case "not_found_rescan":
        return t("discoverNotFoundRescan");
      default:
        return "";
    }
  }, [discoverInfo, t]);

  const applyConfig = useCallback(async () => {
    if (window.kobiChat) {
      const cfg = await window.kobiChat.getConfig();
      setBaseUrl(normalizeBase(cfg.leaderSocketUrl || cfg.socketUrl));
      setDisplayName(clampDisplayName(cfg.displayName) || t("defaultUserName"));
      setProfileImage(String(cfg.profileImage || ""));
      if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
      setServerMode(cfg.serverMode ?? "remote");
      setRemoteHost(cfg.remoteHost ?? "");
      setRemotePort(Number(cfg.remotePort) || 3847);
      setLocalPort(Number(cfg.localPort) || 3847);
      if (cfg.presenceStatus) setPresenceStatus(cfg.presenceStatus);
      if (typeof cfg.globalShortcutOk === "boolean") setShortcutOk(cfg.globalShortcutOk);
      setNotificationSoundEnabled(cfg.notificationSound !== false);
      applySoundCategoriesFromSource(cfg);
      applySoundVolumeFromSource(cfg);
      if (cfg.language) setLang(normalizeLang(cfg.language));
    } else {
      setBaseUrl(await getInitialBaseUrl());
      const k = "kobiChatClientUuid";
      let u = localStorage.getItem(k);
      if (!u) {
        u = localStorage.getItem("lanChatClientUuid");
        if (u) localStorage.setItem(k, u);
      }
      if (!u) {
        u = crypto.randomUUID();
        localStorage.setItem(k, u);
      }
      const ws = loadWebSettings();
      const dn = clampDisplayName(ws.displayName || "");
      setDisplayName(dn || t("defaultUserName"));
      setProfileImage(String(ws.profileImage || ""));
      setNotificationSoundEnabled(ws.notificationSound !== false);
      applySoundCategoriesFromSource(ws);
      applySoundVolumeFromSource(ws);
      if (typeof ws.presenceStatus === "string" && ws.presenceStatus) {
        setPresenceStatus(ws.presenceStatus);
      }
      setClientUuid(u);
    }
  }, [t, setLang]);

  /** UDP ile bulunan ilk sunucuyu kaydeder ve baseUrl günceller. */
  const applyDiscoveryFirst = useCallback(async (list, infoKey = "found_manual") => {
    if (!window.kobiChat || !list?.length) return false;
    const first = list[0];
    const u = new URL(first.socketUrl);
    const host = u.hostname;
    const port = parseInt(String(u.port || "3847"), 10);
    await window.kobiChat.saveSettings({ remoteHost: host, remotePort: port });
    setBaseUrl(normalizeBase(first.socketUrl));
    setRemoteHost(host);
    setRemotePort(port);
    setDiscoverInfo({
      key: infoKey === "found_auto" ? "found_auto" : "found_manual",
      host,
      port: String(port)
    });
    return true;
  }, []);

  const rescanLan = useCallback(async () => {
    if (!window.kobiChat || serverMode === "local") return;
    setDiscoverInfo({ key: "scanning_network" });
    const list = await window.kobiChat.discoverLan();
    if (list?.length > 0) {
      await applyDiscoveryFirst(list, "found_manual");
    } else {
      setDiscoverInfo({ key: "not_found_rescan" });
    }
  }, [serverMode, applyDiscoveryFirst]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      /** Ayarlar penceresi: formlar için state yeter; socket/LAN keşfi ana pencerede kalsın. */
      if (settingsOnly) {
        if (!window.kobiChat) {
          await applyConfig();
          setLanReady(true);
          return;
        }
        const s = await window.kobiChat.getSettings();
        const cfg = await window.kobiChat.getConfig();
        if (cancelled) return;
        setDisplayName(clampDisplayName(s.displayName || cfg.displayName) || t("defaultUserName"));
        setProfileImage(String(s.profileImage || cfg.profileImage || ""));
        if (s.clientUuid) setClientUuid(s.clientUuid);
        else if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
        setServerMode(s.serverMode ?? "remote");
        setRemoteHost(s.remoteHost ?? "");
        setRemotePort(Number(s.remotePort) || 3847);
        setLocalPort(Number(s.localPort) || 3847);
        setPresenceStatus(s.presenceStatus || cfg.presenceStatus || "uygun");
        setNotificationSoundEnabled((s.notificationSound ?? cfg.notificationSound) !== false);
        applySoundCategoriesFromSource(s.soundCategories ? s : cfg);
        applySoundVolumeFromSource(typeof s.soundVolume === "number" ? s : cfg);
        const rawLang = s.language;
        if (rawLang && LANGS.includes(rawLang)) {
          setLang(rawLang);
        } else if (!rawLang) {
          setLang(detectBrowserLang());
        }
        if (s.serverMode === "local") {
          setBaseUrl(normalizeBase(cfg.leaderSocketUrl || cfg.socketUrl));
          setDiscoverInfo({ key: "local_server" });
        } else {
          const savedRemoteHost = (s.remoteHost || "").trim();
          const savedRemotePort = Number(s.remotePort) || 3847;
          if (savedRemoteHost) {
            setBaseUrl(normalizeBase(`http://${savedRemoteHost}:${savedRemotePort}`));
          } else {
            setBaseUrl(normalizeBase(cfg.socketUrl));
          }
          setDiscoverInfo({ key: "empty" });
        }
        setLanReady(true);
        return;
      }

      if (!window.kobiChat) {
        await applyConfig();
        setLanReady(true);
        return;
      }
      const s = await window.kobiChat.getSettings();
      const cfg = await window.kobiChat.getConfig();
      setDisplayName(clampDisplayName(s.displayName || cfg.displayName) || t("defaultUserName"));
      setProfileImage(String(s.profileImage || cfg.profileImage || ""));
      if (s.clientUuid) setClientUuid(s.clientUuid);
      else if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
      setServerMode(s.serverMode ?? "remote");
      setRemoteHost(s.remoteHost ?? "");
      setRemotePort(Number(s.remotePort) || 3847);
      setLocalPort(Number(s.localPort) || 3847);
      setPresenceStatus(s.presenceStatus || cfg.presenceStatus || "uygun");
      setNotificationSoundEnabled((s.notificationSound ?? cfg.notificationSound) !== false);
      applySoundCategoriesFromSource(s.soundCategories ? s : cfg);
      applySoundVolumeFromSource(typeof s.soundVolume === "number" ? s : cfg);

      const rawLang = s.language;
      if (rawLang && LANGS.includes(rawLang)) {
        setLang(rawLang);
      } else if (!rawLang) {
        const d = detectBrowserLang();
        setLang(d);
        await window.kobiChat.saveSettings({ language: d });
      }

      if (s.serverMode === "local") {
        setBaseUrl(normalizeBase(cfg.leaderSocketUrl || cfg.socketUrl));
        setDiscoverInfo({ key: "local_server" });
        setLanReady(true);
        return;
      }

      const savedRemoteHost = (s.remoteHost || "").trim();
      const savedRemotePort = Number(s.remotePort) || 3847;
      if (savedRemoteHost) {
        setBaseUrl(normalizeBase(`http://${savedRemoteHost}:${savedRemotePort}`));
      }

      setDiscoverInfo({ key: "scanning" });
      const list = await window.kobiChat.discoverLan();
      if (cancelled) return;

      if (list?.length > 0) {
        await applyDiscoveryFirst(list, "found_auto");
      } else if (savedRemoteHost) {
        setBaseUrl(normalizeBase(`http://${savedRemoteHost}:${savedRemotePort}`));
        setDiscoverInfo({
          key: "not_found_fixed",
          host: savedRemoteHost,
          port: String(savedRemotePort)
        });
      } else {
        setBaseUrl(normalizeBase(cfg.socketUrl));
        setDiscoverInfo({ key: "not_found" });
      }
      setLanReady(true);
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, [applyDiscoveryFirst, settingsOnly, applyConfig, t, setLang]);

  useEffect(() => {
    let unsub;
    if (window.kobiChat) {
      unsub = window.kobiChat.onConfigUpdated((cfg) => {
        setBaseUrl(normalizeBase(cfg.leaderSocketUrl || cfg.socketUrl));
        if (!settingsOpen) {
          setDisplayName(clampDisplayName(cfg.displayName) || t("defaultUserName"));
        }
        setProfileImage(String(cfg.profileImage || ""));
        if (cfg.clientUuid) setClientUuid(cfg.clientUuid);
        setServerMode(cfg.serverMode ?? "remote");
        setRemoteHost(cfg.remoteHost ?? "");
        setRemotePort(Number(cfg.remotePort) || 3847);
        setLocalPort(Number(cfg.localPort) || 3847);
        if (cfg.presenceStatus) setPresenceStatus(cfg.presenceStatus);
        setNotificationSoundEnabled(cfg.notificationSound !== false);
        applySoundCategoriesFromSource(cfg);
        applySoundVolumeFromSource(cfg);
        if (!settingsOpen && cfg.language) setLang(normalizeLang(cfg.language));
      });
    }
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [settingsOpen, t, setLang]);

  useEffect(() => {
    let unsub;
    if (window.kobiChat?.onTrayPresence) {
      unsub = window.kobiChat.onTrayPresence(({ presenceStatus: ps }) => {
        if (ps) setPresenceStatus(ps);
      });
    }
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, []);

  useEffect(() => {
    onlineUsersRef.current = onlineUsers;
  }, [onlineUsers]);

  /** Uzak mod + bağlantı yok: periyodik UDP taraması (sunucu açılınca adres güncellenir). */
  useEffect(() => {
    if (settingsOnly || !lanReady || serverMode !== "remote" || !window.kobiChat || connected)
      return undefined;

    const id = setInterval(() => {
      void (async () => {
        if (!window.kobiChat) return;
        const st = await window.kobiChat.getSettings();
        if (st.serverMode === "local") return;
        const list = await window.kobiChat.discoverLan();
        if (list?.length > 0) {
          await applyDiscoveryFirst(list, "found_manual");
        }
      })();
    }, 25000);

    return () => clearInterval(id);
  }, [settingsOnly, lanReady, serverMode, connected, applyDiscoveryFirst]);

  useEffect(() => {
    applyThemeToDocument(theme);
    setStoredTheme(theme);
  }, [theme]);

  /**
   * Ses motoru: ayarları (kategoriler + master volume) Electron veya web'den yükle,
   * dosyaları arka planda ön-yükle. Bağlanma değişikliklerini de canlı dinler.
   */
  useEffect(() => {
    void bootstrapSoundPrefs();
    preloadAllSounds();
  }, []);

  /**
   * Master state değişince merkezi ses modülü güncel kalsın
   * (canlı toggle + slider deneyimi için).
   */
  useEffect(() => {
    setSoundPrefs({
      enabled: notificationSoundEnabled !== false,
      categories: soundCategories,
      volume: soundVolume
    });
  }, [notificationSoundEnabled, soundCategories, soundVolume]);

  /** Yüklenen ham bir ayar nesnesinden kategori değerlerini alıp state'e yazar. */
  function applySoundCategoriesFromSource(src) {
    const sc = src?.soundCategories;
    if (!sc || typeof sc !== "object") return;
    setSoundCategoriesState({
      message: sc.message !== false,
      file: sc.file !== false,
      system: sc.system !== false,
      presence: sc.presence === true
    });
  }

  /** Yüklenen ham bir ayar nesnesinden master volume'ü alıp state'e yazar. */
  function applySoundVolumeFromSource(src) {
    const v = src?.soundVolume;
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    setSoundVolumeState(Math.max(0, Math.min(1, v)));
  }

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key && e.key !== "kobiChatTheme") return;
      setTheme(getStoredTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const clearAttentionUi = useCallback(() => {
    if (window.kobiChat?.clearAttention) {
      void window.kobiChat.clearAttention();
    }
    soundPlayedForRef.current = new Set();
  }, []);

  const removeUnreadPeer = useCallback((peerId) => {
    setUnreadPeerIds((prev) => prev.filter((id) => id !== peerId));
  }, []);

  /** Toplu mesaj seçimi: Ctrl+tık ile kişiyi listeye ekle/çıkar. */
  const toggleBulkSelect = useCallback((peer) => {
    const cu = normalizeClientUuid(peer?.clientUuid || "");
    if (!cu) return;
    setBulkSelected((prev) => (prev.includes(cu) ? prev.filter((x) => x !== cu) : [...prev, cu]));
  }, []);

  const clearBulkSelection = useCallback(() => {
    setBulkSelected([]);
    setBulkOpen(false);
    setBulkText("");
  }, []);


  const uploadFilesToRosterPeer = useCallback(
    async (peer, files) => {
      const list = Array.from(files || []).filter(Boolean);
      if (!list.length) return false;
      if (!window.kobiChat || !mySocketId || !clientUuid || !peer?.clientUuid || !connected) {
        alert(t("uploadFailed"));
        return false;
      }
      /**
       * "Dışarıda" olana dosya göndermek artık ENGELLENMİYOR (bkz. ChatApp
       * uploadFiles): sunucu dosyayı kuyruğa alıp kişi dönünce iletiyor.
       * Yalnızca kullanıcı bilerek göndersin diye onay isteniyor.
       */
      if (peer.online !== false && String(peer.status || "").toLowerCase() === "away") {
        const proceed = window.confirm(
          t("fileAwayConfirm", { name: String(peer.displayName || "").trim() || t("defaultUserName") })
        );
        if (!proceed) return false;
      }
      const uploadBase = activeSocketBaseFromRef(socketRef, baseUrl);
      if (!uploadBase) {
        alert(t("uploadFailed"));
        return false;
      }

      for (const file of list) {
        let uploaded = false;
        const clientMsgId = crypto.randomUUID();
        const form = new FormData();
        form.append("file", file);
        form.append("displayName", clampDisplayName(displayName) || t("defaultUserName"));
        form.append("clientUuid", clientUuid);
        form.append("fromSocketId", mySocketId);
        form.append("toSocketId", peer.online === false ? "" : String(peer.id || ""));
        form.append("peerClientUuid", String(peer.clientUuid || ""));
        form.append("clientMsgId", clientMsgId);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ROSTER_UPLOAD_TIMEOUT_MS);
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
        }
        if (!uploaded) {
          playSound("error");
          alert(t("uploadFailed"));
          return false;
        }
        /** Dosya başarıyla gönderildi (her dosya için bir kez çal). */
        playSound("fileSent");
      }
      return true;
    },
    [baseUrl, clientUuid, connected, displayName, mySocketId, t]
  );

  const openPeerChatFromRoster = useCallback(
    (u, label) => {
      if (!u?.clientUuid) {
        alert(t("peerIdentityMissing"));
        return;
      }
      if (window.kobiChat?.openChatWindow) {
        void window.kobiChat.openChatWindow({
          peerId: u.online === false ? "" : u.id,
          peerClientUuid: u.clientUuid,
          peerDisplayName: label,
          peerStatus: u.status || "available",
          peerProfileImage: String(u.profileImage || "")
        });
      } else {
        const q = new URLSearchParams({
          mode: "chat",
          peerId: u.online === false ? "" : u.id,
          peerUuid: u.clientUuid,
          peerName: encodeURIComponent(label),
          peerStatus: u.status || "available",
          peerProfileImage: encodeURIComponent(String(u.profileImage || ""))
        });
        window.open(`${window.location.pathname}?${q.toString()}`, "_blank", "noopener");
      }
    },
    [t]
  );

  const onRosterPeerDrop = useCallback(
    async (e, peer) => {
      e.preventDefault();
      e.stopPropagation();
      suppressPeerClickUntilRef.current = Date.now() + 600;
      setRosterDropPeerKey("");
      const dt = e.dataTransfer;
      if (!dt?.files?.length) return;
      if (!peer?.clientUuid) {
        alert(t("peerIdentityMissing"));
        return;
      }
      const ok = await uploadFilesToRosterPeer(peer, dt.files);
      if (ok) {
        openPeerChatFromRoster(peer, String(peer.displayName || "").trim() || t("defaultUserName"));
      }
    },
    [openPeerChatFromRoster, t, uploadFilesToRosterPeer]
  );

  useEffect(() => {
    if (unreadPeerIds.length === 0) {
      clearAttentionUi();
    }
  }, [unreadPeerIds.length, clearAttentionUi]);

  /** Otomatik "Dışarıda": main process'ten sistem boşta/aktif geçişlerini dinle. */
  useEffect(() => {
    if (settingsOnly || !window.kobiChat?.onSystemIdle) return undefined;
    const unsub = window.kobiChat.onSystemIdle((p) => {
      setSystemIdle(Boolean(p?.idle));
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [settingsOnly]);

  useEffect(() => {
    /**
     * Ayarlar ayrı BrowserWindow'da `settingsOnly` ile açılıyor; burada da socket açılırsa
     * aynı clientUuid ile ikinci bağlantı oluşur ve sunucu birini disconnect eder → ana pencere "logout".
     */
    if (!lanReady || settingsOnly) return undefined;
    const s = io(baseUrl, {
      /** Önce polling ile güvenli bağlan, sonra websocket'e yükselt (eski Windows'ta daha stabil). */
      transports: ["polling", "websocket"],
      upgrade: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 12000,
      timeout: 20000
    });
    socketRef.current = s;

    function processDmQueue() {
      if (processingDmRef.current) return;
      if (dmQueueRef.current.length === 0) return;
      const job = dmQueueRef.current[0];
      if (!job?.peerClientUuid) {
        dmQueueRef.current.shift();
        processDmQueue();
        return;
      }
      const myClientUuid = String(job?.myClientUuid || clientUuidRef.current || "").trim();
      if (!myClientUuid) {
        // Kimlik gelmeden queued job kalırsa kuyruk kilitlenmesin.
        dmQueueRef.current.shift();
        processDmQueue();
        return;
      }
      processingDmRef.current = true;
      pendingDmRef.current = {
        requestId: job.requestId,
        peerId: job.peerId || "",
        peerClientUuid: job.peerClientUuid,
        emittedAt: Date.now()
      };
      const peerKeyMeta = String(job.peerClientUuid || "").trim().toLowerCase();
      if (peerKeyMeta) {
        dmOpenMetaByPeerRef.current.set(peerKeyMeta, {
          requestId: job.requestId,
          peerId: job.peerId || ""
        });
      }
      s.emit("dm:open", {
        peerSocketId: job.peerId || "",
        peerClientUuid: job.peerClientUuid,
        myClientUuid
      });
      // Beklenmeyen durumlarda dm:open cevabı gelmezse queue kilidini çöz.
      setTimeout(() => {
        if (!processingDmRef.current) return;
        const pend = pendingDmRef.current;
        if (!pend || pend.requestId !== job.requestId) return;
        pendingDmRef.current = null;
        processingDmRef.current = false;
        if (dmQueueRef.current.length > 0) dmQueueRef.current.shift();
        processDmQueue();
      }, 60000);
    }

    let ch = null;
    let unsubBridgeFromChat = null;

    function postToChatWindows(payload) {
      if (window.kobiChat?.relayBroadcast) {
        window.kobiChat.relayBroadcast(payload);
      } else if (broadcastChRef.current) {
        broadcastChRef.current.postMessage(payload);
      }
    }

    function handleChatBridgeMessage(d) {
      if (!d || typeof d !== "object") return;
      if (d.type === "chat:register") {
        const peerKey = String(d.peerClientUuid || d.peerId || "").trim().toLowerCase();
        if (peerKey) openChatPeersRef.current.add(peerKey);
        postToChatWindows({
          type: "socket:context",
          replyTo: d.instanceId,
          mySocketId: s.id,
          clientUuid: clientUuidRef.current,
          socketUrl: activeSocketBaseFromRef(socketRef, baseUrl)
        });
      }
      if (d.type === "chat:unregister") {
        const peerKey = String(d.peerClientUuid || d.peerId || "").trim().toLowerCase();
        if (peerKey) openChatPeersRef.current.delete(peerKey);
      }
      if (d.type === "chat:viewed") {
        /**
         * Sohbet penceresi görüntülenip mesajlar okununca roster'daki
         * "okunmamış" (turuncu has-unread) çerçevesini temizle. Aksi halde
         * kullanıcı mesajı sohbet penceresinde okusa bile çerçeve kalıyordu.
         */
        const peerKey = String(d.peerClientUuid || d.peerId || "").trim().toLowerCase();
        if (peerKey) setUnreadPeerIds((prev) => prev.filter((id) => id !== peerKey));
      }
      if (d.type === "chat:dm-open") {
        dmQueueRef.current.push(d);
        processDmQueue();
      }
      if (d.type === "chat:send-text") {
        s.emit("chat:message", {
          text: d.text,
          displayName: d.displayName,
          clientUuid: d.clientUuid,
          toSocketId: d.toSocketId,
          peerClientUuid: d.peerClientUuid,
          clientMsgId: d.clientMsgId
        });
      }
      if (d.type === "chat:typing") {
        s.emit("chat:typing", {
          toSocketId: d.toSocketId,
          peerClientUuid: d.peerClientUuid,
          clientUuid: d.clientUuid,
          conv_id: d.conv_id,
          isTyping: Boolean(d.isTyping)
        });
      }
      if (d.type === "chat:message-read") {
        s.emit("message:read", {
          senderSocketId: d.senderSocketId,
          senderClientUuid: d.senderClientUuid,
          messageId: d.messageId,
          conv_id: d.conv_id
        });
      }
      if (d.type === "chat:send-poke") {
        const peerCu = normalizeClientUuid(d.peerClientUuid || "");
        const myCu = normalizeClientUuid(d.myClientUuid || "");
        const toSid = String(d.toSocketId || "").trim();
        if (!peerCu || !myCu) {
          postToChatWindows({
            type: "socket:poke-error",
            code: "BAD_REQUEST",
            peerClientUuid: peerCu
          });
          return;
        }
        if (!s.connected) {
          postToChatWindows({
            type: "socket:poke-error",
            code: "NO_SOCKET",
            peerClientUuid: peerCu
          });
          return;
        }
        /**
         * Sunucu `poke:send` için ack döner; eski sunucu / ağ kopması için
         * `timeout` ile sessiz kalmayı önleriz.
         */
        s.timeout(5000).emit(
          "poke:send",
          { toSocketId: toSid, peerClientUuid: peerCu, myClientUuid: myCu },
          (err, resp) => {
            if (err) {
              postToChatWindows({
                type: "socket:poke-error",
                code: "TIMEOUT",
                peerClientUuid: peerCu
              });
              return;
            }
            if (resp && resp.ok === false) {
              postToChatWindows({
                type: "socket:poke-error",
                code: String(resp.code || "UNKNOWN"),
                peerClientUuid: normalizeClientUuid(resp.peerClientUuid || peerCu)
              });
              return;
            }
            if (resp && resp.ok === true) {
              postToChatWindows({
                type: "socket:poke-sent",
                peerClientUuid: normalizeClientUuid(resp.peerClientUuid || peerCu)
              });
            }
          }
        );
      }
    }

    if (window.kobiChat?.onBridgeFromChat) {
      unsubBridgeFromChat = window.kobiChat.onBridgeFromChat(handleChatBridgeMessage);
    }
    if (typeof BroadcastChannel !== "undefined" && !window.kobiChat?.relayBroadcast) {
      ch = new BroadcastChannel(KOBI_BRIDGE);
      broadcastChRef.current = ch;
      ch.onmessage = (ev) => handleChatBridgeMessage(ev.data);
    } else {
      broadcastChRef.current = null;
    }

    /**
     * Main process → roster: sohbet penceresi kapandı. `chat:unregister` IPC'si
     * window destroy sırasında kaybolabildiğinden (race condition), bu ikinci
     * güvenlik ağı `openChatPeersRef`'in bayatlamamasını garanti eder.
     */
    let unsubChatClosed;
    if (window.kobiChat?.onChatWindowClosed) {
      unsubChatClosed = window.kobiChat.onChatWindowClosed((payload) => {
        const cu = String(payload?.peerClientUuid || "").trim().toLowerCase();
        if (cu) openChatPeersRef.current.delete(cu);
      });
    }

    s.on("connect", () => {
      setConnected(true);
      setMySocketId(s.id || null);
      /** Önceden bağlantısızdan bağlıya geçtikse "giriş" sesi çıkar. */
      if (!wasConnectedRef.current) {
        wasConnectedRef.current = true;
        playSound("connected");
      }
      hadConnectedAtLeastOnceRef.current = true;
      const cu = clientUuidRef.current;
      if (cu) {
        s.emit("presence:join", {
          displayName: clampDisplayName(displayNameRef.current) || tRef.current("defaultUserName"),
          clientUuid: cu,
          status: mapUiPresenceToServer(effectivePresenceStatusRef.current),
          profileImage: profileImageRef.current || ""
        });
      }
      postToChatWindows({
        type: "socket:broadcast-context",
        mySocketId: s.id,
        clientUuid: clientUuidRef.current,
        socketUrl: activeSocketBaseFromRef(socketRef, baseUrl)
      });
    });
    s.on("disconnect", () => {
      setConnected(false);
      setMySocketId(null);
      /** Yalnızca gerçekten bağlı iken kopulduysa "çıkış" sesi çıkar. */
      if (wasConnectedRef.current) {
        wasConnectedRef.current = false;
        playSound("disconnected");
        /** Yeni roster diff'inin baseline'ı yeniden hesaplansın. */
        prevRosterCuRef.current = null;
      }
    });
    s.on("connect_error", () => {
      setConnected(false);
      /**
       * Uygulama yeni açılırken sunucu henüz hazır değilse `connect_error` doğal olarak
       * çıkar; o durumda ses çalmasın. Yalnızca **daha önce bağlandığımız** bir oturum
       * koptuktan sonra reconnect başarısız oluyorsa kullanıcı uyarılsın.
       */
      if (hadConnectedAtLeastOnceRef.current) {
        playSound("reconnectFailed");
      }
    });

    s.on("presence:roster", (payload) => {
      const list = Array.isArray(payload?.users) ? payload.users : [];
      /**
       * Roster diff — kim yeni online/offline oldu? İlk geldiğinde (baseline)
       * tüm online kullanıcılar yeni gibi görünür; o yüzden ilk roster'ı sessizce
       * baseline yap, sonraki değişiklikleri seslendir.
       */
      detectPresenceTransitionsAndPlay(list);
      setRosterCacheUsers((prev) => {
        const next = mergeRosterCache(prev, list, clientUuidRef.current);
        saveRosterCache(next);
        return next;
      });
      setOnlineUsers(list);
      postToChatWindows({ type: "socket:presence-roster", users: list });
    });

    /** Pano: şok bildirim ve zamanlı bildirimler bu bilgisayarda yalnızca liste penceresinden gösterilir. */
    s.on("board:shock", (p) => {
      const tr = tRef.current;
      void window.kobiChat?.showShock?.({
        title: p?.title || "",
        message: p?.body || "",
        okLabel: tr("boardShockOk"),
        titleFallback: tr("boardShockFallback"),
        brandLabel: tr("boardBrand")
      });
    });
    s.on("board:notify", (p) => {
      const tr = tRef.current;
      const k = schedKind(p?.kind);
      void window.kobiChat?.showNotify?.({
        title: p?.title || "",
        message: p?.body || "",
        icon: k.icon,
        color: k.color,
        okLabel: tr("boardNotifyOk"),
        brandLabel: tr("boardBrand")
      });
    });
    s.on("board:patch", (p) => {
      if (p?.key === "notes" || p?.key === "meal") setBoardUnseen(true);
    });

    s.on("history", (payload) => {
      const pend = pendingDmRef.current;
      pendingDmRef.current = null;
      processingDmRef.current = false;
      /**
       * Sunucu `history` içinde `peerClientUuid` / `myClientUuid` döner (normalize).
       * Böylece `pendingDmRef` zaman aşımı veya yarış yüzünden boş kalsa bile
       * sohbet penceresi yanıtı `peerClientUuid` ile eşleştirip geçmişi yükler.
       */
      const peerFromPayload = normalizeClientUuid(payload?.peerClientUuid || "");
      const envelopePeer =
        peerFromPayload || normalizeClientUuid(pend?.peerClientUuid || "");
      const peerKeyHist = String(envelopePeer || pend?.peerClientUuid || "").trim().toLowerCase();
      const meta = peerKeyHist ? dmOpenMetaByPeerRef.current.get(peerKeyHist) : null;
      if (peerKeyHist) dmOpenMetaByPeerRef.current.delete(peerKeyHist);
      postToChatWindows({
        type: "socket:history",
        requestId: pend?.requestId || meta?.requestId || "",
        peerId: pend?.peerId || meta?.peerId || "",
        peerClientUuid: envelopePeer,
        payload
      });
      if (pend && dmQueueRef.current.length > 0) dmQueueRef.current.shift();
      processDmQueue();
    });

    s.on("message:new", (msg) => {
      postToChatWindows({ type: "socket:message:new", msg });

      const fromSocket = msg?.from_socket_id;
      const myId = mySocketIdRef.current;
      const incoming =
        typeof fromSocket === "string" && fromSocket.length > 0 && fromSocket !== myId;

      if (!incoming) return;

      const fromCu =
        typeof msg.from_client_uuid === "string" ? String(msg.from_client_uuid).trim() : "";
      if (fromCu) {
        const seenUser = {
          clientUuid: fromCu,
          displayName: String(msg.sender || "").trim() || tRef.current("defaultUserName"),
          status: "available"
        };
        setRosterCacheUsers((prev) => {
          const next = mergeRosterCache(prev, [seenUser], clientUuidRef.current);
          saveRosterCache(next);
          return next;
        });
        const fromCuLo = fromCu.toLowerCase();
        setOnlineUsers((prev) => {
          let found = false;
          const next = prev.map((u) => {
            const uk = String(u.clientUuid || "").trim().toLowerCase();
            if (uk && uk === fromCuLo) {
              found = true;
              return {
                ...u,
                id: fromSocket,
                online: true,
                displayName:
                  String(msg.sender || "").trim() ||
                  String(u.displayName || "").trim() ||
                  u.displayName
              };
            }
            return u;
          });
          if (found) return dedupeRosterByClientUuid(next);
          return dedupeRosterByClientUuid([
            ...next,
            {
              id: fromSocket,
              clientUuid: fromCu,
              displayName: String(msg.sender || "").trim() || tRef.current("defaultUserName"),
              status: "available",
              profileImage: "",
              online: true
            }
          ]);
        });
      }

      s.emit("message:ack", {
        senderSocketId: fromSocket,
        senderClientUuid:
          typeof msg.from_client_uuid === "string" ? String(msg.from_client_uuid).trim() : "",
        messageId: msg.id,
        conv_id: msg.conv_id
      });

      const fromCuLo = fromCu ? fromCu.toLowerCase() : "";
      const rosterPeer = onlineUsersRef.current.find(
        (u) =>
          u.id === fromSocket || (fromCuLo && String(u.clientUuid || "").trim().toLowerCase() === fromCuLo)
      );
      const peerClientUuid =
        (rosterPeer?.clientUuid && String(rosterPeer.clientUuid).trim()) ||
        (typeof msg.from_client_uuid === "string" ? msg.from_client_uuid.trim() : "") ||
        peerClientUuidFromConvId(msg.conv_id, clientUuidRef.current);
      const peerKey = String(peerClientUuid || fromSocket || "").trim().toLowerCase();
      const hasChatPeer = peerKey ? openChatPeersRef.current.has(peerKey) : false;
      const peerDisplayName =
        (rosterPeer?.displayName && String(rosterPeer.displayName).trim()) ||
        String(msg.sender || "").trim() ||
        tRef.current("messageDefaultTitle");
      const peerProfileImage =
        (rosterPeer?.profileImage && String(rosterPeer.profileImage).trim()) || "";

      if (!hasChatPeer) {
        /**
         * Sohbet penceresi bu peer için KAYITLI DEĞİL → kullanıcı ya
         * başka biriyle konuşuyor ya da hiçbir sohbet penceresi açık değil.
         *
         * 1) Sohbet penceresini arka planda göster; görev çubuğunda yanıp sönsün.
         * 2) Güçlü bildirim sesi (1.mp3 / 4.mp3) çal.
         *
         * Önemli: Peer offline → online geçişinde sunucu kuyruktaki TÜM
         * mesajları (50–100 olabilir) ardışık `message:new` olarak fırlatır.
         * `was_queued: true` işaretli toplu akışta her mesaj için ayrı
         * pencere açma IPC'si göndermek + ses çalmak rahatsız edici olur.
         * Aşağıdaki peer-bazlı zamanlayıcı `INCOMING_ATTENTION_THROTTLE_MS`
         * süresince ek dikkat sinyallerini bastırır; okunmamış sayacı yine
         * her mesaj için artırılır (kullanıcı sayıyı görür).
         */
        setUnreadPeerIds((prev) => (prev.includes(peerKey) ? prev : [...prev, peerKey]));
        const now = Date.now();
        const lastAttentionAt =
          (peerKey && lastAttentionAtByPeerRef.current.get(peerKey)) || 0;
        const shouldFireAttention = now - lastAttentionAt > INCOMING_ATTENTION_THROTTLE_MS;
        if (shouldFireAttention) {
          if (peerKey) lastAttentionAtByPeerRef.current.set(peerKey, now);
          if (peerClientUuid && window.kobiChat?.openChatWindow) {
            void window.kobiChat.openChatWindow({
              peerId: fromSocket,
              peerClientUuid,
              peerDisplayName,
              peerStatus: rosterPeer?.status || "available",
              peerProfileImage,
              openMinimized: true
            });
            /**
             * `message:new` relay'i çoğu zaman bu yeni BrowserWindow oluşmadan ÖNCE
             * yayınlanır; pencere açıldığında ilk mesaj düşmez. Birkaç gecikmeyle
             * tekrar yayın — ChatApp aynı `id` ile birleştirir (çift ses yok).
             */
            for (const delayMs of [400, 1000, 2200, 4500]) {
              window.setTimeout(() => {
                postToChatWindows({ type: "socket:message:new", msg });
              }, delayMs);
            }
          }
          const k = `snd-${fromSocket}-${msg.id}`;
          if (!soundPlayedForRef.current.has(k)) {
            soundPlayedForRef.current.add(k);
            const isFileMsg = String(msg?.kind || "").toLowerCase() === "file";
            playSound(isFileMsg ? "fileIncoming" : "messageIncomingAlert");
          }
        }
      }
    });

    s.on("message:status", (payload) => {
      postToChatWindows({ type: "socket:message:status", payload });
    });

    s.on("message:state", (payload) => {
      postToChatWindows({ type: "socket:message:state", payload });
    });

    s.on("chat:typing", (payload) => {
      postToChatWindows({ type: "socket:typing", payload });
    });

    s.on("poke:incoming", (payload) => {
      playSound("pokeIncoming");
      const fromCu = String(payload?.fromClientUuid || "").trim();
      const peerKey = fromCu.toLowerCase();
      const fromSocket = String(payload?.fromSocketId || "").trim();
      const rosterPeer = onlineUsersRef.current.find(
        (u) => String(u.clientUuid || "").trim().toLowerCase() === peerKey
      );
      const fromDisplayName =
        String(payload?.fromDisplayName || "").trim() || tRef.current("defaultUserName");
      const peerProfileImage =
        (rosterPeer?.profileImage && String(rosterPeer.profileImage).trim()) || "";

      /**
       * `pokeId`: bu relay aşağıda bir kez daha (1500 ms sonra) yollanıyor —
       * sohbet penceresi yeni açılıyorsa ilkini kaçırabildiği için. Pencere
       * zaten açıksa ikisi de ulaşıp mükerrer "Titreşim aldınız" satırı
       * oluşuyordu; alıcı taraf bu kimlikle tekilleştirir.
       */
      const pokeRelayPayload = {
        type: "socket:poke-incoming",
        pokeId: `${fromCu || "?"}-${Date.now()}`,
        fromDisplayName: payload?.fromDisplayName,
        fromClientUuid: payload?.fromClientUuid
      };

      postToChatWindows(pokeRelayPayload);

      if (fromCu && window.kobiChat?.openChatWindow) {
        void window.kobiChat.openChatWindow({
          peerId: fromSocket,
          peerClientUuid: fromCu,
          peerDisplayName: fromDisplayName,
          peerStatus: rosterPeer?.status || "available",
          peerProfileImage,
          openMinimized: true,
          pokeAttention: true
        });
      }

      setTimeout(() => postToChatWindows(pokeRelayPayload), 1500);
    });

    s.on("message:error", (p) => {
      /**
       * Sunucu, offline alıcıya gönderilen mesajı sessizce kuyruğa alır
       * (delivery_state="queued"); bu yol `message:error` *çıkarmaz*. Yine de
       * geleceğe karşı: anlamlı bir hata mesajı yoksa hata sesini bastır.
       */
      const msg = String(p?.m || "").trim();
      if (!msg) return;

      /**
       * Bazı sunucu mesajları "error" event'iyle gelse de aslında **normal akış**
       * sayılırlar (örn. alıcı offline → mesaj queue'ya alındı, sonra teslim
       * edilecek). Bu durumlarda kullanıcıya hata sesi çalmak yanıltıcı olur:
       * her offline DM'de "tıklama + hata tonu" üst üste binip kullanıcı
       * mesajının başarısız olduğunu zanneder. Aşağıdaki desenler hata sesini
       * bastırır ama log yine bilgi olarak görünür (debug için).
       */
      const benignPatterns = [
        /çevrim ?içi de(g|ğ)il/i, // "Karşı taraf çevrimiçi değil"
        /offline/i,
        /lider d(ü|u)(g|ğ)(ü|u)m/i, // "Lider düğüm yazma için hazır değil"
        /queued?$/i,
        /kuyru(g|ğ)a alındı/i
      ];
      if (benignPatterns.some((re) => re.test(msg))) {
        console.info("message:info (sessiz):", msg);
        return;
      }

      playSound("error");
      console.warn("message:error:", msg);
    });

    return () => {
      try {
        ch?.close();
      } catch {
        // ignored
      }
      if (typeof unsubBridgeFromChat === "function") unsubBridgeFromChat();
      if (typeof unsubChatClosed === "function") unsubChatClosed();
      broadcastChRef.current = null;
      s.removeAllListeners();
      s.close();
      socketRef.current = null;
    };
  }, [baseUrl, lanReady, settingsOnly]);

  const mergedOnlineUsers = useMemo(() => {
    const selfClientUuid = normalizeClientUuid(clientUuid);
    const cachedOfflineUsers = rosterCacheUsers
      .map(normalizeRosterCacheUser)
      .filter((u) => u && u.clientUuid !== selfClientUuid);
    const list = dedupeRosterByClientUuid(
      [
        ...onlineUsers.map((u) => ({
          ...u,
          status: u.status || "available",
          online: u.online !== false
        })),
        ...cachedOfflineUsers
      ]
    );
    if (connected && mySocketId && clientUuid) {
      /** Aynı clientUuid başka sokette (kopya ayar) olsa bile yalnızca kendi socket id'miz "ben" sayılır. */
      const hasSelf = list.some((u) => mySocketId && u.id === mySocketId);
      if (!hasSelf) {
        const nm = clampDisplayName(displayName) || t("defaultUserName");
        list.push({
          id: mySocketId,
          displayName: nm,
          clientUuid,
          status: mapUiPresenceToServer(effectivePresenceStatus),
          profileImage,
          online: true
        });
      }
    }
    const withSelfStatus = list.map((u) => {
      const isSelfUser = Boolean(mySocketId && u.id === mySocketId);
      return isSelfUser
        ? { ...u, status: mapUiPresenceToServer(effectivePresenceStatus), profileImage: profileImage || u.profileImage || "" }
        : u;
    });
    /**
     * "Ajan Smith" temizliği (istemci-taraf savunma katmanı): Sunucu eski
     * sürümdeyse hayaletleri hâlâ gönderebilir. Burada da ada göre birleştiriyoruz:
     * aynı isim çevrimiçiyse offline kopyaları gizle; birden fazla offline aynı
     * isim varsa en günceli tut; isimsiz/Anonim satırlar birleştirilmez.
     */
    const normNameRoster = (s) => String(s || "").trim().toLowerCase();
    const onlineNamesRoster = new Set(
      withSelfStatus
        .filter((u) => u.online !== false)
        .map((u) => normNameRoster(u.displayName))
        .filter((n) => n && n !== "anonim")
    );
    const bestOfflineByName = new Map();
    const dedupedRoster = [];
    for (const u of withSelfStatus) {
      if (u.online !== false) {
        dedupedRoster.push(u);
        continue;
      }
      const nm = normNameRoster(u.displayName);
      if (!nm || nm === "anonim") {
        dedupedRoster.push(u);
        continue;
      }
      if (onlineNamesRoster.has(nm)) continue;
      const prev = bestOfflineByName.get(nm);
      if (!prev) {
        bestOfflineByName.set(nm, u);
        continue;
      }
      const uk = String(u.last_seen_at || u.lastSeenAt || "");
      const pk = String(prev.last_seen_at || prev.lastSeenAt || "");
      if (uk > pk) bestOfflineByName.set(nm, u);
    }
    dedupedRoster.push(...bestOfflineByName.values());
    const collator = new Intl.Collator(locale, { sensitivity: "base" });
    const isSelfUser = (u) => Boolean(mySocketId && u.id === mySocketId);
    const isOfflineRosterUser = (u) => u.online === false;
    dedupedRoster.sort((a, b) => {
      const aSelf = isSelfUser(a);
      const bSelf = isSelfUser(b);
      if (aSelf && !bSelf) return 1;
      if (!aSelf && bSelf) return -1;
      const aOffline = isOfflineRosterUser(a);
      const bOffline = isOfflineRosterUser(b);
      if (aOffline && !bOffline) return 1;
      if (!aOffline && bOffline) return -1;
      // Çevrimiçi grubun içinde "dışarıda" (away) olanlar aktiflerin altına iner.
      const aAway = !aOffline && String(a.status || "").toLowerCase() === "away";
      const bAway = !bOffline && String(b.status || "").toLowerCase() === "away";
      if (aAway && !bAway) return 1;
      if (!aAway && bAway) return -1;
      return collator.compare(String(a.displayName), String(b.displayName));
    });
    return dedupedRoster;
  }, [
    onlineUsers,
    rosterCacheUsers,
    connected,
    mySocketId,
    clientUuid,
    displayName,
    effectivePresenceStatus,
    profileImage,
    locale,
    t
  ]);

  const selfRosterUser = useMemo(
    () => mergedOnlineUsers.find((u) => mySocketId && u.id === mySocketId) || null,
    [mergedOnlineUsers, mySocketId]
  );

  const rosterPeerUsers = useMemo(
    () => mergedOnlineUsers.filter((u) => !(mySocketId && u.id === mySocketId)),
    [mergedOnlineUsers, mySocketId]
  );

  /**
   * Seçili kişilerin hepsine aynı metni ayrı birer özel mesaj olarak gönderir.
   * Sunucu tarafında DM hız sınırı var (varsayılan 30 mesaj / 60 sn), bu yüzden
   * gönderimler arasına küçük bir aralık konur. Alıcı çevrimdışıysa toSocketId
   * boş gider ve sunucu mesajı kuyruğa alır.
   */
  const sendBulkMessage = useCallback(async () => {
    const s = socketRef.current;
    const text = bulkText.trim();
    if (!s || !connected || !clientUuid || !text || bulkSelected.length === 0) return;
    setBulkSending(true);
    const byUuid = new Map(
      rosterPeerUsers.map((u) => [normalizeClientUuid(u.clientUuid || ""), u]).filter(([k]) => k)
    );
    let sent = 0;
    for (const cu of bulkSelected) {
      const peer = byUuid.get(cu);
      if (!peer) continue;
      try {
        s.emit("chat:message", {
          text,
          displayName: clampDisplayName(displayName) || t("defaultUserName"),
          clientUuid,
          toSocketId: peer.online === false ? "" : String(peer.id || ""),
          peerClientUuid: cu,
          clientMsgId: crypto.randomUUID()
        });
        sent += 1;
      } catch {
        // tek alıcıda hata diğerlerini engellemesin
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    setBulkSending(false);
    clearBulkSelection();
    if (sent > 0) playSound("messageSent");
  }, [
    bulkText,
    bulkSelected,
    connected,
    clientUuid,
    displayName,
    rosterPeerUsers,
    t,
    clearBulkSelection
  ]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !connected || !clientUuid) return;
    s.emit("presence:join", {
      displayName: clampDisplayName(displayName) || t("defaultUserName"),
      clientUuid,
      status: mapUiPresenceToServer(effectivePresenceStatus),
      profileImage
    });
  }, [connected, displayName, clientUuid, effectivePresenceStatus, profileImage, t]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !connected) return;
    s.emit("presence:status", { status: mapUiPresenceToServer(effectivePresenceStatus) });
  }, [connected, effectivePresenceStatus]);

  const openSettings = async () => {
    /** Mevcut state'lerden geçerli ses ayarlarını al; ham source yoksa fallback. */
    const fallbackCats = { ...soundCategories };
    const fallbackVol = soundVolume;

    if (window.kobiChat) {
      const s = await window.kobiChat.getSettings();
      const cats = (s && typeof s.soundCategories === "object" && s.soundCategories) || fallbackCats;
      const vol = typeof s?.soundVolume === "number" ? s.soundVolume : fallbackVol;
      const loadedDraft = {
        displayName: clampDisplayName(s.displayName) || "",
        profileImage: String(s.profileImage || ""),
        presenceStatus: s.presenceStatus || "uygun",
        language: normalizeLang(s.language || lang),
        theme,
        notificationSound: s.notificationSound !== false,
        soundCategories: {
          message: cats.message !== false,
          file: cats.file !== false,
          system: cats.system !== false,
          presence: cats.presence === true
        },
        soundVolume: Math.max(0, Math.min(1, Number(vol))),
        serverMode: s.serverMode ?? "remote",
        remoteHost: s.remoteHost ?? "",
        remotePort: Number(s.remotePort) || 3847,
        localPort: Number(s.localPort) || 3847,
        globalShortcut: String(s.globalShortcut || "").trim() || DEFAULT_GLOBAL_SHORTCUT,
        socketUrl: ""
      };
      settingsLastSavedRef.current = loadedDraft;
      setSettingsDisplayName(loadedDraft.displayName);
      setSettingsProfileImage(loadedDraft.profileImage);
      setServerMode(loadedDraft.serverMode);
      setRemoteHost(loadedDraft.remoteHost);
      setRemotePort(loadedDraft.remotePort);
      setLocalPort(loadedDraft.localPort);
      setPresenceStatus(loadedDraft.presenceStatus);
      setSettingsPresenceStatus(loadedDraft.presenceStatus);
      setSettingsLang(loadedDraft.language);
      setSettingsTheme(loadedDraft.theme);
      setSettingsShortcut(loadedDraft.globalShortcut);
      setSettingsNotificationSound(loadedDraft.notificationSound);
      setSettingsSoundCategories(loadedDraft.soundCategories);
      setSettingsSoundVolume(loadedDraft.soundVolume);
    } else {
      const loadedDraft = {
        displayName: clampDisplayName(displayName) || "",
        profileImage: String(profileImage || ""),
        presenceStatus: presenceStatus || "uygun",
        language: normalizeLang(lang),
        theme,
        notificationSound: notificationSoundEnabled !== false,
        soundCategories: { ...fallbackCats },
        soundVolume: fallbackVol,
        serverMode,
        remoteHost,
        remotePort: Number(remotePort) || 3847,
        localPort: Number(localPort) || 3847,
        globalShortcut: settingsShortcut || DEFAULT_GLOBAL_SHORTCUT,
        socketUrl: normalizeBase(baseUrl)
      };
      settingsLastSavedRef.current = loadedDraft;
      setSettingsDisplayName(loadedDraft.displayName);
      setSettingsProfileImage(loadedDraft.profileImage);
      setSettingsPresenceStatus(loadedDraft.presenceStatus);
      setSettingsLang(loadedDraft.language);
      setSettingsTheme(loadedDraft.theme);
      setSettingsNotificationSound(loadedDraft.notificationSound);
      setSettingsSoundCategories(loadedDraft.soundCategories);
      setSettingsSoundVolume(loadedDraft.soundVolume);
      setSettingsSocketUrl(loadedDraft.socketUrl);
    }
    setSettingsOpen(true);
  };

  const buildSettingsDraft = useCallback(
    () => ({
      displayName: clampDisplayName(settingsDisplayName) || t("defaultUserName"),
      profileImage: settingsProfileImage || "",
      presenceStatus: settingsPresenceStatus || "uygun",
      language: normalizeLang(settingsLang),
      theme: settingsTheme,
      notificationSound: settingsNotificationSound !== false,
      soundCategories: {
        message: settingsSoundCategories.message !== false,
        file: settingsSoundCategories.file !== false,
        system: settingsSoundCategories.system !== false,
        presence: settingsSoundCategories.presence === true
      },
      soundVolume: Math.max(0, Math.min(1, Number(settingsSoundVolume))),
      serverMode,
      remoteHost: String(remoteHost || "").trim(),
      remotePort: Number(remotePort) || 3847,
      localPort: Number(localPort) || 3847,
      globalShortcut: settingsShortcut || DEFAULT_GLOBAL_SHORTCUT,
      socketUrl:
        normalizeBase(settingsSocketUrl || "") ||
        normalizeBase(baseUrl) ||
        normalizeBase(import.meta.env.VITE_SOCKET_URL || "http://127.0.0.1:3847")
    }),
    [
      settingsDisplayName,
      settingsProfileImage,
      settingsPresenceStatus,
      settingsLang,
      settingsTheme,
      settingsNotificationSound,
      settingsSoundCategories,
      settingsSoundVolume,
      serverMode,
      remoteHost,
      remotePort,
      localPort,
      settingsShortcut,
      settingsSocketUrl,
      baseUrl,
      t
    ]
  );

  const sameDraft = (a, b) => {
    if (!a || !b) return false;
    const sameCats =
      !!a.soundCategories &&
      !!b.soundCategories &&
      a.soundCategories.message === b.soundCategories.message &&
      a.soundCategories.file === b.soundCategories.file &&
      a.soundCategories.system === b.soundCategories.system &&
      a.soundCategories.presence === b.soundCategories.presence;
    return (
      a.displayName === b.displayName &&
      a.profileImage === b.profileImage &&
      a.presenceStatus === b.presenceStatus &&
      a.language === b.language &&
      a.theme === b.theme &&
      a.notificationSound === b.notificationSound &&
      sameCats &&
      a.soundVolume === b.soundVolume &&
      a.serverMode === b.serverMode &&
      a.remoteHost === b.remoteHost &&
      a.remotePort === b.remotePort &&
      a.localPort === b.localPort &&
      a.globalShortcut === b.globalShortcut &&
      a.socketUrl === b.socketUrl
    );
  };

  const saveSettings = async () => {
    closeSettingsUi();
  };

  useEffect(() => {
    if (!settingsOpen) return;
    const draft = buildSettingsDraft();
    const last = settingsLastSavedRef.current;
    if (!last) {
      settingsLastSavedRef.current = draft;
      return;
    }
    if (sameDraft(draft, last)) return;
    if (settingsAutoSaveTimerRef.current) clearTimeout(settingsAutoSaveTimerRef.current);
    settingsAutoSaveTimerRef.current = setTimeout(async () => {
      setSavingSettings(true);
      try {
        if (!window.kobiChat) {
          setDisplayName(draft.displayName);
          setProfileImage(draft.profileImage);
          setNotificationSoundEnabled(draft.notificationSound);
          setSoundCategoriesState(draft.soundCategories);
          setSoundVolumeState(draft.soundVolume);
          setPresenceStatus(draft.presenceStatus);
          setLang(draft.language);
          setTheme(draft.theme);
          setBaseUrl(draft.socketUrl);
          saveWebSettings({
            displayName: draft.displayName,
            profileImage: draft.profileImage,
            presenceStatus: draft.presenceStatus,
            notificationSound: draft.notificationSound,
            soundCategories: draft.soundCategories,
            soundVolume: draft.soundVolume,
            socketUrl: draft.socketUrl
          });
        } else {
          await window.kobiChat.saveSettings({
            displayName: draft.displayName,
            profileImage: draft.profileImage,
            presenceStatus: draft.presenceStatus,
            language: draft.language,
            notificationSound: draft.notificationSound,
            soundCategories: draft.soundCategories,
            soundVolume: draft.soundVolume,
            serverMode: draft.serverMode,
            remoteHost: draft.remoteHost,
            remotePort: draft.remotePort,
            localPort: draft.localPort,
            globalShortcut: draft.globalShortcut
          });
          setLang(draft.language);
          setTheme(draft.theme);
          await window.kobiChat.refreshTrayMenu?.();
          await applyConfig();
        }
        settingsLastSavedRef.current = draft;
      } catch (e) {
        console.error("auto-save settings:", e);
      } finally {
        setSavingSettings(false);
      }
    }, 350);
    return () => {
      if (settingsAutoSaveTimerRef.current) clearTimeout(settingsAutoSaveTimerRef.current);
    };
  }, [settingsOpen, buildSettingsDraft, setLang, applyConfig]);

  const onPickProfileImage = useCallback(() => {
    profileInputRef.current?.click?.();
  }, []);

  const onProfileFileChange = useCallback(
    async (e) => {
      const file = e.target?.files?.[0];
      if (!file) return;
      try {
        const normalized = await normalizeProfileImageDataUrl(file);
        setSettingsProfileImage(normalized);
      } catch (err) {
        if (err?.message === "too-large") {
          alert(t("profileImageTooLarge"));
        } else {
          alert(t("profileImageInvalid"));
        }
      } finally {
        if (e.target) e.target.value = "";
      }
    },
    [t]
  );

  const closeSettingsUi = useCallback(() => {
    if (settingsOnly && window.kobiChat) {
      window.close();
      return;
    }
    setSettingsOpen(false);
  }, [settingsOnly]);

  useEffect(() => {
    if (!settingsOpen) return undefined;
    const id = window.setInterval(() => setUpdateCooldownNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [settingsOpen]);

  const updateCooldownSecondsLeft = Math.max(0, Math.ceil((updateCooldownUntil - updateCooldownNow) / 1000));

  const onCheckUpdatesNow = useCallback(async () => {
    if (!window.kobiChat?.checkUpdatesNow) return;
    if (checkingUpdateNow || savingSettings || updateCooldownSecondsLeft > 0) return;
    setCheckingUpdateNow(true);
    try {
      const res = await window.kobiChat.checkUpdatesNow();
      if (res?.throttled) {
        const retryAfterMs = Number(res.retryAfterMs) || UPDATE_BUTTON_COOLDOWN_MS;
        setUpdateCooldownUntil(Date.now() + retryAfterMs);
        setUpdateCheckNotice(t("checkUpdatesCooldownNotice", { n: Math.ceil(retryAfterMs / 1000) }));
        return;
      }
      if (res?.reason === "not-packaged") {
        setUpdateCheckNotice(t("checkUpdatesDevOnlyNotice"));
        return;
      }
      setUpdateCooldownUntil(Date.now() + UPDATE_BUTTON_COOLDOWN_MS);
      setUpdateCheckNotice(t("checkUpdatesStartedNotice"));
    } finally {
      setCheckingUpdateNow(false);
    }
  }, [checkingUpdateNow, savingSettings, t, updateCooldownSecondsLeft]);

  useEffect(() => {
    const onEscHideRoster = (e) => {
      if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (!document.hasFocus()) return;
      if (document.body.dataset.boardModal === "1") return;
      if (boardOpen && !settingsOpen) {
        e.preventDefault();
        e.stopPropagation();
        void toggleBoard();
        return;
      }
      if (settingsOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeSettingsUi();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      window.kobiChat?.hideMainWindow?.();
    };
    document.addEventListener("keydown", onEscHideRoster, true);
    return () => document.removeEventListener("keydown", onEscHideRoster, true);
  }, [settingsOpen, closeSettingsUi, boardOpen, toggleBoard]);

  useEffect(() => {
    if (!settingsOnly) return;
    void openSettings();
  }, [settingsOnly]);

  /**
   * settingsOnly penceresi frameless açıldığı için, modal'ı pencere yüzeyine
   * tam-ekran kaplayan bir görünüme sokuyoruz. Body üzerindeki bu attribute
   * CSS'in drag-bar ve full-bleed kurallarını bağlamasını sağlar.
   */
  useEffect(() => {
    if (!settingsOnly) return undefined;
    const prev = document.body.dataset.settingsOnly;
    document.body.dataset.settingsOnly = "1";
    return () => {
      if (prev === undefined) delete document.body.dataset.settingsOnly;
      else document.body.dataset.settingsOnly = prev;
    };
  }, [settingsOnly]);

  const onOpenSettingsClick = useCallback(() => {
    if (window.kobiChat && !settingsOnly) {
      void window.kobiChat.openSettingsWindow?.();
      return;
    }
    void openSettings();
  }, [settingsOnly]);

  const onOpenInfoClick = useCallback((e) => {
    const target = e.target;
    if (target && typeof target.closest === "function" && target.closest("button, a, input, select, textarea")) {
      return;
    }
    if (window.kobiChat?.openInfoWindow) {
      void window.kobiChat.openInfoWindow();
      return;
    }
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("mode", "info");
      window.open(u.toString(), "kobichat_info", "noopener,noreferrer,width=420,height=460");
    } catch {
      // ignored
    }
  }, []);

  const onSidebarBlankClick = useCallback((e) => {
    const target = e.target;
    if (target && typeof target.closest === "function") {
      if (target.closest(".sidebar-peer-btn, .sidebar-row-self-action, .sidebar-users-header, .sidebar-self-slot")) {
        return;
      }
    }
    const activeEl = document.activeElement;
    if (activeEl && typeof activeEl.blur === "function") {
      activeEl.blur();
    }
  }, []);

  return (
    <div className={`app-shell ${settingsOnly ? "" : "app-shell--roster"}`}>
      {!settingsOnly ? (
        <div className={`roster-row ${boardOpen ? "is-board-open" : ""}`}>
          {boardOpen ? (
            <div className="board-drawer">
              <BoardPanel socketUrl={activeSocketBaseFromRef(socketRef, baseUrl)} />
            </div>
          ) : null}
          <button
            type="button"
            className={`board-handle ${boardOpen ? "is-open" : ""} ${boardUnseen && !boardOpen ? "has-news" : ""}`}
            onClick={() => void toggleBoard()}
            aria-expanded={boardOpen}
            title={boardOpen ? t("boardClose") : boardUnseen ? t("boardUpdated") : t("boardOpen")}
          >
            {boardUnseen && !boardOpen ? <span className="board-handle__dot" aria-hidden /> : null}
            <span className="board-handle__grip" aria-hidden />
            <span className="board-handle__label">{t("boardOpen")}</span>
            <span className="board-handle__chev" aria-hidden>
              ‹
            </span>
            <span className="board-handle__grip" aria-hidden />
          </button>
        <div
          ref={rosterColRef}
          className="main-layout main-layout--roster-only"
          style={boardOpen && rosterColWidth ? { flex: "none", width: rosterColWidth } : undefined}
        >
          <aside className="sidebar-users" aria-label={t("sidebarAria")} onClick={onSidebarBlankClick}>
          <ul className="sidebar-users-list">
            {!connected ? (
              <li className="sidebar-hint">{t("sidebarHintOffline")}</li>
            ) : rosterPeerUsers.length === 0 ? (
              <li className="sidebar-hint">{t("sidebarNoOthers")}</li>
            ) : (
              <>
                {rosterPeerUsers.map((u) => {
                  const isOfflineRoster = u.online === false;
                  const st = isOfflineRoster ? "uygun" : mapServerPresenceToUi(u.status || "available");
                  const peerUnreadKey = String(u.clientUuid || u.id || "").trim().toLowerCase();
                  const hasUnread = peerUnreadKey ? unreadPeerIds.includes(peerUnreadKey) : false;
                  const peerChatTitle =
                    String(u.displayName || "").trim() || t("defaultUserName");
                  const dropKey = String(u.clientUuid || u.id || "");
                  const isDropTarget = dropKey && rosterDropPeerKey === dropKey;
                  const bulkKey = normalizeClientUuid(u.clientUuid || "");
                  const isBulkSelected = Boolean(bulkKey) && bulkSelected.includes(bulkKey);
                  return (
                    <li
                      key={u.id}
                      className="sidebar-peer-item"
                      onDragEnter={(e) => {
                        const hasFileType = Array.from(e.dataTransfer?.types || []).includes("Files");
                        if (!hasFileType) return;
                        e.preventDefault();
                        setRosterDropPeerKey(dropKey);
                      }}
                      onDragOver={(e) => {
                        const hasFileType = Array.from(e.dataTransfer?.types || []).includes("Files");
                        if (!hasFileType) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setRosterDropPeerKey(dropKey);
                      }}
                      onDragLeave={() => {
                        setRosterDropPeerKey((prev) => (prev === dropKey ? "" : prev));
                      }}
                      onDrop={(e) => void onRosterPeerDrop(e, u)}
                    >
                      <button
                        type="button"
                        className={`sidebar-peer-btn ${hasUnread ? "has-unread" : ""} ${isOfflineRoster ? "is-offline" : ""} ${isDropTarget ? "is-drop-target" : ""} ${isBulkSelected ? "is-bulk-selected" : ""}`}
                        title={t("peerDoubleClickOpen")}
                        onDragEnter={(e) => {
                          const hasFileType = Array.from(e.dataTransfer?.types || []).includes("Files");
                          if (!hasFileType) return;
                          e.preventDefault();
                          setRosterDropPeerKey(dropKey);
                        }}
                        onDragOver={(e) => {
                          const hasFileType = Array.from(e.dataTransfer?.types || []).includes("Files");
                          if (!hasFileType) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          setRosterDropPeerKey(dropKey);
                        }}
                        onDrop={(e) => void onRosterPeerDrop(e, u)}
                        onClick={(e) => {
                          if (Date.now() < suppressPeerClickUntilRef.current) return;
                          /** Ctrl/Cmd+tık: sohbeti açma, toplu mesaj için seç/kaldır. */
                          if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleBulkSelect(u);
                            return;
                          }
                          removeUnreadPeer(peerUnreadKey || u.id);
                          clearAttentionUi();
                          openPeerChatFromRoster(u, peerChatTitle);
                        }}
                      >
                        <span
                          className={
                            isOfflineRoster ? "user-avatar user-avatar--offline" : userAvatarClass(st)
                          }
                          aria-hidden
                        >
                          {u.profileImage ? (
                            <img className="user-avatar__img" src={u.profileImage} alt="" />
                          ) : (
                            initialLetter(u.displayName, locale)
                          )}
                        </span>
                        <div className="sidebar-peer-text">
                          <span className="sidebar-peer-name">{u.displayName}</span>
                          {!u.clientUuid ? (
                            <span className="user-line-meta">{t("identityWaiting")}</span>
                          ) : isOfflineRoster ? (
                            <span className="user-line-meta user-line-meta--offline">
                              {t("presenceUserOffline")}
                            </span>
                          ) : (
                            <span className="user-line-meta user-line-meta--presence">
                              <span className={presenceDotClass(st)} title={presenceText(st)} aria-hidden />
                              <span>{presenceText(st)}</span>
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
                {connected && rosterPeerUsers.length === 0 ? (
                  <li className="sidebar-hint">{t("sidebarNoOthers")}</li>
                ) : null}
              </>
            )}
          </ul>
          {bulkSelected.length > 0 ? (
            <div className="bulk-bar" role="region" aria-label={t("bulkTitle")}>
              <span className="bulk-bar__count">
                {t("bulkSelectedCount", { count: bulkSelected.length })}
              </span>
              <div className="bulk-bar__actions">
                <button type="button" className="btn bulk-bar__clear" onClick={clearBulkSelection}>
                  {t("bulkClear")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setBulkOpen(true)}
                  disabled={!connected}
                >
                  {t("bulkSend")}
                </button>
              </div>
            </div>
          ) : null}
          {selfRosterUser ? (
            <ul className="sidebar-self-slot">
              {(() => {
                const stSelf = mapServerPresenceToUi(selfRosterUser.status || "available");
                const selfProfileImage = profileImage || selfRosterUser.profileImage || "";
                return (
                  <li
                    className={`is-self sidebar-row-static sidebar-row-self--${stSelf} sidebar-row-self-action`}
                    onClick={onOpenSettingsClick}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenSettingsClick();
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    title={t("settings")}
                  >
                    <span className={userAvatarClass(stSelf)} aria-hidden>
                      {selfProfileImage ? (
                        <img className="user-avatar__img" src={selfProfileImage} alt="" />
                      ) : (
                        initialLetter(selfRosterUser.displayName, locale)
                      )}
                    </span>
                    <div>
                      <div className="sidebar-self-name-row">
                        <span className="sidebar-self-name-text">{selfRosterUser.displayName}</span>
                      </div>
                      <div className="user-line-meta user-line-meta--presence">
                        <span className={presenceDotClass(stSelf)} title={presenceText(stSelf)} aria-hidden />
                        <span>{presenceText(stSelf)}</span>
                        <span className="sidebar-self-settings-hint">{t("settings")}</span>
                      </div>
                    </div>
                  </li>
                );
              })()}
            </ul>
          ) : null}
          <div className="sidebar-users-header" onClick={onOpenInfoClick}>
            <div className="sidebar-users-header-top">
              <div className="sidebar-footer-note">
                Hidroteknik Kurum İçi İleti Uygulaması
                {appVersion ? ` - v${appVersion}` : ""}
              </div>
              {!selfRosterUser ? (
                <button
                  type="button"
                  className="btn btn-fallback-settings"
                  onClick={onOpenSettingsClick}
                >
                  {t("settings")}
                </button>
              ) : null}
            </div>
          </div>
          </aside>
        </div>
        </div>
      ) : null}

      {bulkOpen
        ? createPortal(
            <div
              className="modal-backdrop"
              role="presentation"
              onClick={() => (bulkSending ? null : setBulkOpen(false))}
            >
              <div
                className="modal bulk-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="bulk-modal-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modal-header">
                  <h2 id="bulk-modal-title">{t("bulkTitle")}</h2>
                  <button
                    type="button"
                    className="btn-modal-x"
                    onClick={() => setBulkOpen(false)}
                    disabled={bulkSending}
                    aria-label={t("cancel")}
                  >
                    ×
                  </button>
                </div>
                <p className="bulk-modal__recipients">
                  {t("bulkRecipients", {
                    names: rosterPeerUsers
                      .filter((u) => bulkSelected.includes(normalizeClientUuid(u.clientUuid || "")))
                      .map((u) => String(u.displayName || "").trim() || t("defaultUserName"))
                      .join(", ")
                  })}
                </p>
                <textarea
                  className="bulk-modal__textarea"
                  rows={5}
                  autoFocus
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendBulkMessage();
                    }
                  }}
                  placeholder={t("bulkPlaceholder")}
                  aria-label={t("bulkPlaceholder")}
                  disabled={bulkSending}
                />
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setBulkOpen(false)}
                    disabled={bulkSending}
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void sendBulkMessage()}
                    disabled={bulkSending || !bulkText.trim() || !connected}
                  >
                    {bulkSending ? t("bulkSending") : t("bulkSendNow")}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {settingsOpen
        ? createPortal(
            <div className="modal-backdrop" role="dialog" aria-modal="true">
              <div className="modal settings-modal">

                {/* ── Başlık ── */}
                <div className="modal-header">
                  <h2>{t("settingsTitle")}</h2>
                  <button type="button" className="btn-modal-x" onClick={closeSettingsUi} aria-label={t("cancel")}>✕</button>
                </div>

                {/* ── Profil kartı ── */}
                <div className="settings-card settings-card--profile">
                  <div className="settings-profile-avatar-wrap">
                    <span className="settings-profile-avatar settings-profile-avatar--lg" aria-hidden>
                      {settingsProfileImage ? (
                        <img className="user-avatar__img" src={settingsProfileImage} alt="" />
                      ) : (
                        initialLetter(settingsDisplayName || displayName || t("defaultUserName"), locale)
                      )}
                    </span>
                  </div>
                  <div className="settings-profile-fields">
                    <div className="field field--text-input">
                      <label htmlFor="dn">
                        {t("displayNameLabel")}
                        <span className="field-hint"> {t("displayNameHint", { max: DISPLAY_NAME_MAX })}</span>
                      </label>
                      <input
                        id="dn"
                        type="text"
                        value={settingsDisplayName}
                        onChange={(e) => setSettingsDisplayName(e.target.value.slice(0, DISPLAY_NAME_MAX))}
                        autoComplete="nickname"
                        maxLength={DISPLAY_NAME_MAX}
                      />
                    </div>
                    <div className="profile-image-actions">
                      <button type="button" className="btn" onClick={onPickProfileImage}>
                        {t("profileImageChoose")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setSettingsProfileImage("")}
                        disabled={!settingsProfileImage}
                      >
                        {t("profileImageRemove")}
                      </button>
                    </div>
                    <span className="field-hint">{t("profileImageHint")}</span>
                  </div>
                  <input
                    ref={profileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                    className="profile-image-input"
                    onChange={onProfileFileChange}
                  />
                </div>

                {/* ── Durum ── */}
                <div className="settings-card">
                  <span className="settings-section-label">{t("statusSection")}</span>
                  <div className="settings-status-row">
                    {[
                      { key: "uygun",    dot: "dot--uygun",   label: t("presenceAvailable") },
                      { key: "mesgul",   dot: "dot--mesgul",  label: t("presenceBusy") },
                      { key: "disarida", dot: "dot--disarida",label: t("presenceAway") }
                    ].map(({ key, dot, label }) => (
                      <label key={key} className={`settings-status-btn${settingsPresenceStatus === key ? " is-active" : ""}`}>
                        <input
                          type="radio"
                          name="ps"
                          className="sr-only"
                          checked={settingsPresenceStatus === key}
                          onChange={() => setSettingsPresenceStatus(key)}
                        />
                        <span className={`presence-dot-sm ${dot}`} aria-hidden />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                {/* ── Görünüm + Dil (yan yana) ── */}
                <div className="settings-row-two">
                  <div className="settings-card settings-card--half">
                    <span className="settings-section-label">{t("appearance")}</span>
                    <div className="settings-theme-row">
                      {[
                        { key: "light", icon: "☀️", label: t("themeLight") },
                        { key: "dark",  icon: "🌙", label: t("themeDark") }
                      ].map(({ key, icon, label }) => (
                        <label key={key} className={`settings-theme-btn${settingsTheme === key ? " is-active" : ""}`}>
                          <input
                            type="radio"
                            name="themePick"
                            className="sr-only"
                            checked={settingsTheme === key}
                            onChange={() => setSettingsTheme(key)}
                          />
                          <span className="settings-theme-icon" aria-hidden>{icon}</span>
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="settings-card settings-card--half">
                    <span id="lang-select-heading" className="settings-section-label">{t("languageLabel")}</span>
                    <LanguageSelectWithFlags
                      lang={settingsLang}
                      setLang={(nextLang) => setSettingsLang(normalizeLang(nextLang))}
                      t={t}
                    />
                  </div>
                </div>

                {/* ── Bağlantı ── */}
                {window.kobiChat ? (
                  <div className="settings-card">
                    <span className="settings-section-label">{t("connectionSettings")}</span>
                    <div className="radio-row" style={{ marginTop: 6 }}>
                      <label>
                        <input
                          type="radio"
                          name="connMode"
                          checked={serverMode === "local"}
                          onChange={() => setServerMode("local")}
                        />
                        {t("modeLocal")}
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="connMode"
                          checked={serverMode === "remote"}
                          onChange={() => setServerMode("remote")}
                        />
                        {t("modeRemote")}
                      </label>
                    </div>
                    <div className="field-hint" style={{ marginTop: 4 }}>{t("connectionSettingsHint")}</div>

                    {serverMode === "remote" ? (
                      <div className="settings-conn-fields">
                        <div className="field field--text-input">
                          <label htmlFor="remoteHost">{t("remoteHostLabel")}</label>
                          <input
                            id="remoteHost"
                            type="text"
                            value={remoteHost}
                            onChange={(e) => setRemoteHost(e.target.value)}
                            placeholder="192.168.1.66"
                            autoComplete="off"
                          />
                        </div>
                        <div className="field field--text-input">
                          <label htmlFor="remotePort">{t("remotePortLabel")}</label>
                          <input
                            id="remotePort"
                            type="number"
                            min={1}
                            max={65535}
                            value={remotePort}
                            onChange={(e) => setRemotePort(Number(e.target.value) || 3847)}
                          />
                        </div>
                      </div>
                    ) : null}

                    {serverMode === "local" ? (
                      <div className="settings-conn-fields">
                        <div className="field field--text-input">
                          <label htmlFor="localPort">{t("localPortLabel")}</label>
                          <input
                            id="localPort"
                            type="number"
                            min={1}
                            max={65535}
                            value={localPort}
                            onChange={(e) => setLocalPort(Number(e.target.value) || 3847)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {window.kobiChat ? (
                  <div className="settings-card">
                    <span className="settings-section-label">{t("shortcutSection")}</span>
                    <div className="field field--text-input">
                      <label htmlFor="globalShortcut">
                        {t("shortcutLabel")}
                        <span className="field-hint"> {t("shortcutHint")}</span>
                      </label>
                      <div className="shortcut-row">
                        <input
                          id="globalShortcut"
                          type="text"
                          className="shortcut-input"
                          readOnly
                          value={prettyAccelerator(settingsShortcut)}
                          placeholder={t("shortcutPlaceholder")}
                          onKeyDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const accel = acceleratorFromKeyEvent(e);
                            if (accel) setSettingsShortcut(accel);
                          }}
                        />
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setSettingsShortcut(DEFAULT_GLOBAL_SHORTCUT)}
                          disabled={settingsShortcut === DEFAULT_GLOBAL_SHORTCUT}
                        >
                          {t("shortcutReset")}
                        </button>
                      </div>
                      {!shortcutOk ? (
                        <div className="field-hint field-hint--warn">{t("shortcutConflict")}</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* ── Alt çubuk: sürüm + butonlar ── */}
                <div className="settings-footer">
                  <div className="settings-footer-version">
                    {appVersion ? (
                      <span className="modal-app-version" role="note">{t("appVersionLine", { version: appVersion })}</span>
                    ) : null}
                    {updateCheckNotice ? <span className="modal-app-version">{updateCheckNotice}</span> : null}
                  </div>
                  <div className="modal-actions">
                    {window.kobiChat?.checkUpdatesNow ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={onCheckUpdatesNow}
                        disabled={savingSettings || checkingUpdateNow || updateCooldownSecondsLeft > 0}
                      >
                        {checkingUpdateNow
                          ? t("checkUpdatesBusy")
                          : updateCooldownSecondsLeft > 0
                            ? t("checkUpdatesCooldown", { n: updateCooldownSecondsLeft })
                            : t("checkUpdatesNow")}
                      </button>
                    ) : null}
                    <button type="button" className="btn" onClick={closeSettingsUi}>
                      {t("cancel")}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export default function App() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("mode") === "chat") return <ChatApp />;
  if (p.get("mode") === "quickMessages") return <QuickMessagesApp />;
  if (p.get("mode") === "info") return <InfoApp />;
  if (p.get("mode") === "settings") return <RosterApp settingsOnly />;
  return <RosterApp />;
}
