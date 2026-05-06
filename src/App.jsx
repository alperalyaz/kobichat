import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { io } from "socket.io-client";
import {
  applyThemeToDocument,
  getStoredTheme,
  peerClientUuidFromConvId,
  setStoredTheme
} from "./theme.js";
import { LANGS, MESSAGES } from "./i18n/messages.js";
import { detectBrowserLang, normalizeLang, useI18n } from "./i18n/I18nContext.jsx";
import { LanguageSelectWithFlags } from "./i18n/LanguageSelect.jsx";
import ChatApp from "./ChatApp.jsx";
import QuickMessagesApp from "./QuickMessagesApp.jsx";
import { KOBI_BRIDGE } from "./socketBridge.js";
import { useAppVersion } from "./useAppVersion.js";

function normalizeBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function getInitialBaseUrl() {
  if (typeof window !== "undefined" && window.kobiChat) {
    const cfg = await window.kobiChat.getConfig();
    return normalizeBase(cfg.socketUrl);
  }
  return normalizeBase(import.meta.env.VITE_SOCKET_URL || "http://127.0.0.1:3847");
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

function presenceDotClass(ui) {
  if (ui === "mesgul") return "presence-dot presence-dot--mesgul";
  if (ui === "disarida") return "presence-dot presence-dot--disarida";
  return "presence-dot presence-dot--uygun";
}

const DISPLAY_NAME_MAX = 21;

function clampDisplayName(s) {
  return String(s ?? "")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
}

function userAvatarClass(ui) {
  if (ui === "mesgul") return "user-avatar user-avatar--mesgul";
  if (ui === "disarida") return "user-avatar user-avatar--disarida";
  return "user-avatar user-avatar--uygun";
}

/** Yerel dosya: public/assets/sounds/notification.mp3 (veya .wav yedek). */
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

function initialLetter(name, dateLocale) {
  if (!name || !String(name).trim()) return "?";
  const ch = String(name).trim()[0];
  return ch.toLocaleUpperCase(dateLocale || "tr-TR");
}

const PROFILE_IMAGE_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const PROFILE_IMAGE_SIZE = 96;

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

function RosterApp() {
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
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(true);
  const [settingsNotificationSound, setSettingsNotificationSound] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverMode, setServerMode] = useState("remote");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState(3847);
  const [localPort, setLocalPort] = useState(3847);
  const [savingSettings, setSavingSettings] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [mySocketId, setMySocketId] = useState(null);
  const [clientUuid, setClientUuid] = useState("");
  const [theme, setTheme] = useState(() => getStoredTheme());
  const [lanReady, setLanReady] = useState(() => typeof window === "undefined" || !window.kobiChat);
  const [discoverInfo, setDiscoverInfo] = useState({ key: "empty" });
  const [presenceStatus, setPresenceStatus] = useState("uygun");
  const [unreadPeerIds, setUnreadPeerIds] = useState([]);

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
  const dmQueueRef = useRef([]);
  const processingDmRef = useRef(false);
  const pendingDmRef = useRef(null);
  const profileInputRef = useRef(null);

  clientUuidRef.current = clientUuid;
  displayNameRef.current = displayName;
  profileImageRef.current = profileImage;
  presenceStatusRef.current = presenceStatus;
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
      setNotificationSoundEnabled(cfg.notificationSound !== false);
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
  }, [applyDiscoveryFirst]);

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
        if (cfg.language) setLang(normalizeLang(cfg.language));
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
    if (!lanReady || serverMode !== "remote" || !window.kobiChat || connected) return undefined;

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
  }, [lanReady, serverMode, connected, applyDiscoveryFirst]);

  useEffect(() => {
    applyThemeToDocument(theme);
    setStoredTheme(theme);
  }, [theme]);

  const clearAttentionUi = useCallback(() => {
    if (window.kobiChat?.clearAttention) {
      void window.kobiChat.clearAttention();
    }
    soundPlayedForRef.current = new Set();
  }, []);

  const removeUnreadPeer = useCallback((peerId) => {
    setUnreadPeerIds((prev) => prev.filter((id) => id !== peerId));
  }, []);

  useEffect(() => {
    if (unreadPeerIds.length === 0) {
      clearAttentionUi();
    }
  }, [unreadPeerIds.length, clearAttentionUi]);

  useEffect(() => {
    if (!lanReady) return undefined;
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
      if (!job?.peerId || !job.peerClientUuid || !job.myClientUuid) {
        dmQueueRef.current.shift();
        processDmQueue();
        return;
      }
      processingDmRef.current = true;
      pendingDmRef.current = { requestId: job.requestId, peerId: job.peerId };
      s.emit("dm:open", {
        peerSocketId: job.peerId,
        peerClientUuid: job.peerClientUuid,
        myClientUuid: job.myClientUuid
      });
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
        const peerKey = String(d.peerClientUuid || d.peerId || "").trim();
        if (peerKey) openChatPeersRef.current.add(peerKey);
        postToChatWindows({
          type: "socket:context",
          replyTo: d.instanceId,
          mySocketId: s.id,
          clientUuid: clientUuidRef.current
        });
      }
      if (d.type === "chat:unregister") {
        const peerKey = String(d.peerClientUuid || d.peerId || "").trim();
        if (peerKey) openChatPeersRef.current.delete(peerKey);
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
          messageId: d.messageId,
          conv_id: d.conv_id
        });
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

    s.on("connect", () => {
      setConnected(true);
      setMySocketId(s.id || null);
      const cu = clientUuidRef.current;
      if (cu) {
        s.emit("presence:join", {
          displayName: clampDisplayName(displayNameRef.current) || tRef.current("defaultUserName"),
          clientUuid: cu,
          status: mapUiPresenceToServer(presenceStatusRef.current),
          profileImage: profileImageRef.current || ""
        });
      }
      postToChatWindows({
        type: "socket:broadcast-context",
        mySocketId: s.id,
        clientUuid: clientUuidRef.current
      });
    });
    s.on("disconnect", () => {
      setConnected(false);
      setMySocketId(null);
    });
    s.on("connect_error", () => setConnected(false));

    s.on("presence:roster", (payload) => {
      const list = Array.isArray(payload?.users) ? payload.users : [];
      setOnlineUsers(list);
    });

    s.on("history", (payload) => {
      const pend = pendingDmRef.current;
      pendingDmRef.current = null;
      processingDmRef.current = false;
      if (pend) {
        postToChatWindows({
          type: "socket:history",
          requestId: pend.requestId,
          peerId: pend.peerId,
          payload
        });
        if (dmQueueRef.current.length > 0) dmQueueRef.current.shift();
      }
      processDmQueue();
    });

    s.on("message:new", (msg) => {
      postToChatWindows({ type: "socket:message:new", msg });

      const fromSocket = msg?.from_socket_id;
      const myId = mySocketIdRef.current;
      const incoming =
        typeof fromSocket === "string" && fromSocket.length > 0 && fromSocket !== myId;

      if (!incoming) return;
      s.emit("message:ack", {
        senderSocketId: fromSocket,
        messageId: msg.id,
        conv_id: msg.conv_id
      });

      const rosterPeer = onlineUsersRef.current.find((u) => u.id === fromSocket);
      const peerClientUuid =
        (rosterPeer?.clientUuid && String(rosterPeer.clientUuid).trim()) ||
        (typeof msg.from_client_uuid === "string" ? msg.from_client_uuid.trim() : "") ||
        peerClientUuidFromConvId(msg.conv_id, clientUuidRef.current);
      const peerKey = String(peerClientUuid || fromSocket || "").trim();
      const hasChatPeer = peerKey ? openChatPeersRef.current.has(peerKey) : false;
      const peerDisplayName =
        (rosterPeer?.displayName && String(rosterPeer.displayName).trim()) ||
        String(msg.sender || "").trim() ||
        tRef.current("messageDefaultTitle");

      if (peerClientUuid && window.kobiChat?.openChatWindow) {
        void window.kobiChat.openChatWindow({
          peerId: fromSocket,
          peerClientUuid,
          peerDisplayName,
          peerStatus: rosterPeer?.status || "available",
          openMinimized: true
        });
      }

      if (!hasChatPeer) {
        setUnreadPeerIds((prev) => (prev.includes(fromSocket) ? prev : [...prev, fromSocket]));
        if (notificationSoundEnabledRef.current) {
          const k = `snd-${fromSocket}-${msg.id}`;
          if (!soundPlayedForRef.current.has(k)) {
            soundPlayedForRef.current.add(k);
            void playNotificationSound();
          }
        }
      }
    });

    s.on("message:status", (payload) => {
      postToChatWindows({ type: "socket:message:status", payload });
    });

    s.on("chat:typing", (payload) => {
      postToChatWindows({ type: "socket:typing", payload });
    });

    s.on("message:error", (p) => {
      if (p?.m) alert(p.m);
    });

    return () => {
      try {
        ch?.close();
      } catch {
        // ignored
      }
      if (typeof unsubBridgeFromChat === "function") unsubBridgeFromChat();
      broadcastChRef.current = null;
      s.removeAllListeners();
      s.close();
      socketRef.current = null;
    };
  }, [baseUrl, lanReady]);

  const mergedOnlineUsers = useMemo(() => {
    const list = onlineUsers.map((u) => ({
      ...u,
      status: u.status || "available"
    }));
    if (connected && mySocketId) {
      const hasSelf = list.some((u) => u.id === mySocketId);
      if (!hasSelf) {
        const nm = clampDisplayName(displayName) || t("defaultUserName");
        list.push({
          id: mySocketId,
          displayName: nm,
          status: mapUiPresenceToServer(presenceStatus),
          profileImage
        });
      }
    }
    const withSelfStatus = list.map((u) =>
      u.id === mySocketId
        ? { ...u, status: mapUiPresenceToServer(presenceStatus), profileImage: profileImage || "" }
        : u
    );
    const collator = new Intl.Collator(locale, { sensitivity: "base" });
    withSelfStatus.sort((a, b) => collator.compare(String(a.displayName), String(b.displayName)));
    return withSelfStatus;
  }, [onlineUsers, connected, mySocketId, displayName, presenceStatus, profileImage, locale, t]);

  const nameCounts = useMemo(() => {
    const m = {};
    for (const u of mergedOnlineUsers) {
      const k = u.displayName;
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  }, [mergedOnlineUsers]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !connected || !clientUuid) return;
    s.emit("presence:join", {
      displayName: clampDisplayName(displayName) || t("defaultUserName"),
      clientUuid,
      status: mapUiPresenceToServer(presenceStatus),
      profileImage
    });
  }, [connected, displayName, clientUuid, presenceStatus, profileImage, t]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s || !connected) return;
    s.emit("presence:status", { status: mapUiPresenceToServer(presenceStatus) });
  }, [connected, presenceStatus]);

  const openSettings = async () => {
    if (window.kobiChat) {
      const s = await window.kobiChat.getSettings();
      setSettingsDisplayName(clampDisplayName(s.displayName) || "");
      setSettingsProfileImage(String(s.profileImage || ""));
      setServerMode(s.serverMode ?? "remote");
      setRemoteHost(s.remoteHost ?? "");
      setRemotePort(Number(s.remotePort) || 3847);
      setLocalPort(Number(s.localPort) || 3847);
      setPresenceStatus(s.presenceStatus || "uygun");
      setSettingsNotificationSound(s.notificationSound !== false);
    }
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!window.kobiChat) {
      setSettingsOpen(false);
      return;
    }
    setSavingSettings(true);
    try {
      await window.kobiChat.saveSettings({
        displayName: clampDisplayName(settingsDisplayName) || t("defaultUserName"),
        profileImage: settingsProfileImage || "",
        presenceStatus,
        language: lang,
        notificationSound: settingsNotificationSound
      });
      await window.kobiChat.refreshTrayMenu?.();
      await applyConfig();
      setSettingsOpen(false);
    } catch (e) {
      alert(t("settingsSaveFailed"));
    } finally {
      setSavingSettings(false);
    }
  };

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

  useEffect(() => {
    const onEscHideRoster = (e) => {
      if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (!document.hasFocus()) return;
      if (settingsOpen) {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen(false);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      window.kobiChat?.hideMainWindow?.();
    };
    document.addEventListener("keydown", onEscHideRoster, true);
    return () => document.removeEventListener("keydown", onEscHideRoster, true);
  }, [settingsOpen]);

  return (
    <div className="app-shell">
      <header className="app-header app-header--roster">
        <div className="app-header-left">
          <img
            className="app-logo"
            src={`${import.meta.env.BASE_URL}icon.png`}
            width={40}
            height={40}
            alt=""
          />
          <div className="app-header-text-block">
            <div className="app-title-row">
              <h1 className="app-title">{t("appTitle")}</h1>
            </div>
            <p className="app-sub">{t("appSubtitleRoster")}</p>
          </div>
        </div>
        <div className="app-header-roster-actions">
          <div className="status-pill" title={connected ? t("statusConnected") : t("statusDisconnected")}>
            <span className={`status-dot ${connected ? "on" : "off"}`} />
            {connected ? t("statusConnected") : t("statusDisconnected")}
          </div>
          <button type="button" className="btn btn-header-settings" onClick={openSettings}>
            {t("settings")}
          </button>
          <button
            type="button"
            className="app-header-close"
            onClick={() => {
              window.kobiChat?.hideMainWindow?.();
            }}
            aria-label={t("rosterHideToTray")}
            title={t("rosterHideToTray")}
          >
            ×
          </button>
        </div>
      </header>

      <div className="main-layout main-layout--roster-only">
        <aside className="sidebar-users" aria-label={t("sidebarAria")}>
          <div className="sidebar-users-header">
            <h2>{t("sidebarOnline")}</h2>
            <p>
              {connected
                ? t("sidebarCount", { n: mergedOnlineUsers.length })
                : t("sidebarNoConnection")}
            </p>
          </div>
          <ul className="sidebar-users-list">
            {!connected ? (
              <li className="sidebar-hint">{t("sidebarHintOffline")}</li>
            ) : mergedOnlineUsers.length === 0 ? (
              <li className="sidebar-hint">{t("sidebarHintLoading")}</li>
            ) : (
              <>
                {mergedOnlineUsers.map((u) => {
                  const isSelf = Boolean(mySocketId && u.id === mySocketId);
                  if (isSelf) {
                    const stSelf = mapServerPresenceToUi(u.status || "available");
                    return (
                      <li key={u.id} className="is-self sidebar-row-static">
                        <span className={userAvatarClass(stSelf)} aria-hidden>
                          {u.profileImage ? (
                            <img className="user-avatar__img" src={u.profileImage} alt="" />
                          ) : (
                            initialLetter(u.displayName, locale)
                          )}
                        </span>
                        <div>
                          <div className="sidebar-self-name-row">
                            <span className="sidebar-self-name-text">
                              {nameCounts[u.displayName] > 1
                                ? `${u.displayName} (${u.id.slice(-4)})`
                                : u.displayName}
                            </span>
                            <span className="sidebar-self-tag">{t("sectionYou")}</span>
                          </div>
                          <div className="user-line-meta user-line-meta--presence">
                            <span
                              className={presenceDotClass(stSelf)}
                              title={presenceText(stSelf)}
                              aria-hidden
                            />
                            <span>{presenceText(stSelf)}</span>
                          </div>
                        </div>
                      </li>
                    );
                  }
                  const dup = nameCounts[u.displayName] > 1;
                  const st = mapServerPresenceToUi(u.status || "available");
                  const hasUnread = unreadPeerIds.includes(u.id);
                  const label = dup ? `${u.displayName} (${u.id.slice(-4)})` : u.displayName;
                  return (
                    <li key={u.id} className="sidebar-peer-item">
                      <button
                        type="button"
                        className={`sidebar-peer-btn ${hasUnread ? "has-unread" : ""}`}
                        title={t("peerDoubleClickOpen")}
                        onClick={() => {
                          if (!u.clientUuid) {
                            alert(t("peerIdentityMissing"));
                            return;
                          }
                          removeUnreadPeer(u.id);
                          clearAttentionUi();
                          if (window.kobiChat?.openChatWindow) {
                            void window.kobiChat.openChatWindow({
                              peerId: u.id,
                              peerClientUuid: u.clientUuid,
                              peerDisplayName: label,
                              peerStatus: u.status || "available"
                            });
                          } else {
                            const q = new URLSearchParams({
                              mode: "chat",
                              peerId: u.id,
                              peerUuid: u.clientUuid,
                              peerName: encodeURIComponent(label),
                              peerStatus: u.status || "available"
                            });
                            window.open(`${window.location.pathname}?${q.toString()}`, "_blank", "noopener");
                          }
                        }}
                      >
                        <span className={userAvatarClass(st)} aria-hidden>
                          {u.profileImage ? (
                            <img className="user-avatar__img" src={u.profileImage} alt="" />
                          ) : (
                            initialLetter(u.displayName, locale)
                          )}
                        </span>
                        <div className="sidebar-peer-text">
                          <span className="sidebar-peer-name">
                            {dup ? `${u.displayName} (${u.id.slice(-4)})` : u.displayName}
                          </span>
                          {!u.clientUuid ? (
                            <span className="user-line-meta">{t("identityWaiting")}</span>
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
                {connected &&
                mergedOnlineUsers.length > 0 &&
                mergedOnlineUsers.every((u) => mySocketId && u.id === mySocketId) ? (
                  <li className="sidebar-hint">{t("sidebarNoOthers")}</li>
                ) : null}
              </>
            )}
          </ul>
        </aside>
      </div>

      {settingsOpen
        ? createPortal(
            <div className="modal-backdrop" role="dialog" aria-modal="true">
              <div className="modal">
            <h2>{t("settingsTitle")}</h2>
            {discoverDisplay ? <p className="modal-discover-info">{discoverDisplay}</p> : null}

            <div className="field field--text-input">
              <label htmlFor="dn">
                {t("displayNameLabel")}{" "}
                <span className="field-hint">{t("displayNameHint", { max: DISPLAY_NAME_MAX })}</span>
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

            <div className="field">
              <span className="settings-section-title">{t("profileImageSection")}</span>
              <div className="profile-image-row">
                <span className="settings-profile-avatar" aria-hidden>
                  {settingsProfileImage ? (
                    <img className="user-avatar__img" src={settingsProfileImage} alt="" />
                  ) : (
                    initialLetter(settingsDisplayName || displayName || t("defaultUserName"), locale)
                  )}
                </span>
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
                  <span className="field-hint">{t("profileImageHint")}</span>
                </div>
              </div>
              <input
                ref={profileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                className="profile-image-input"
                onChange={onProfileFileChange}
              />
            </div>

            <div className="field">
              <span className="settings-section-title">{t("appearance")}</span>
              <div className="radio-row">
                <label>
                  <input
                    type="radio"
                    name="themePick"
                    checked={theme === "light"}
                    onChange={() => setTheme("light")}
                  />
                  {t("themeLight")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="themePick"
                    checked={theme === "dark"}
                    onChange={() => setTheme("dark")}
                  />
                  {t("themeDark")}
                </label>
              </div>
            </div>

            <div className="field">
              <span id="lang-select-heading" className="settings-section-title">
                {t("languageLabel")}
              </span>
              <LanguageSelectWithFlags lang={lang} setLang={setLang} t={t} />
            </div>

            <div className="field">
              <span className="settings-section-title">{t("statusSection")}</span>
              <div className="radio-row">
                <label>
                  <input
                    type="radio"
                    name="ps"
                    checked={presenceStatus === "uygun"}
                    onChange={() => setPresenceStatus("uygun")}
                  />
                  {t("presenceAvailable")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="ps"
                    checked={presenceStatus === "mesgul"}
                    onChange={() => setPresenceStatus("mesgul")}
                  />
                  {t("presenceBusy")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="ps"
                    checked={presenceStatus === "disarida"}
                    onChange={() => setPresenceStatus("disarida")}
                  />
                  {t("presenceAway")}
                </label>
              </div>
            </div>

            <div className="field">
              <span className="settings-section-title">{t("notificationSection")}</span>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settingsNotificationSound}
                  onChange={(e) => setSettingsNotificationSound(e.target.checked)}
                />
                <span>{t("notificationSoundToggle")}</span>
              </label>
            </div>

            <p className="modal-firewall-hint">{t("firewallHint")}</p>

            {appVersion ? (
              <p className="modal-app-version" role="note">
                {t("appVersionLine", { version: appVersion })}
              </p>
            ) : null}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setSettingsOpen(false)}>
                {t("cancel")}
              </button>
              <button type="button" className="btn btn-primary" onClick={saveSettings} disabled={savingSettings}>
                {savingSettings ? t("settingsSaving") : t("save")}
              </button>
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
  return <RosterApp />;
}
