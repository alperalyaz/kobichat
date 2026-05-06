const path = require("path");
const fs = require("fs");
const dgram = require("dgram");
const os = require("os");
const http = require("http");
const https = require("https");
const { createHmac } = require("crypto");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  shell,
  screen
} = require("electron");
const { createChatServer, DEFAULT_PORT, DISCOVERY_UDP_PORT } = require("../server/chat-server.cjs");
const { openSettingsStore } = require("./settings-store.cjs");
const CLUSTER_ID_DEFAULT = "kobichat-lan-v2";
const CLUSTER_SECRET_DEFAULT = "kobichat-cluster-v2-shared";

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Map<string, BrowserWindow>} peerClientUuid → sohbet penceresi (socket id değişse bile tek pencere) */
const chatWindowsByClientUuid = new Map();
/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let aboutWindow = null;
/** @type {BrowserWindow | null} */
let quickMessagesWindow = null;
/** @type {ReturnType<createChatServer> | null} */
let chatInstance = null;
/** @type {ReturnType<openSettingsStore> | null} */
let settingsStore = null;
let appQuitting = false;
const CLUSTER_CTRL_UDP_PORT = 3851;
let clusterSock = null;
let clusterTicker = null;
let clusterTerm = 0;
let clusterRole = "follower";
let clusterLeader = null;
let clusterLeaseUntil = 0;
let clusterBootAt = Date.now();
let clusterElectionAt = Date.now() + 3500;
const clusterPeers = new Map();
let appliedLeaderKey = "";
let lastServerErrorKey = "";
let lastServerErrorAt = 0;

function isAddrInUseError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("EADDRINUSE") || msg.includes("address already in use");
}

function normalizeSettingsForVersion(currentVersion) {
  if (!settingsStore) return;
  const st = settingsStore.getAll();
  if (String(st.lastRunVersion || "") === String(currentVersion || "")) return;
  // Yeni sürümde eski bağlantı/küme tercihleri davranışı etkilemesin.
  settingsStore.save({
    serverMode: "remote",
    remoteHost: "",
    remotePort: DEFAULT_PORT,
    localPort: DEFAULT_PORT,
    clusterMode: true,
    clusterId: CLUSTER_ID_DEFAULT,
    nodeId: "",
    sharedSecret: CLUSTER_SECRET_DEFAULT,
    lastRunVersion: String(currentVersion || "")
  });
}

function signCluster(payload, secret) {
  return createHmac("sha256", String(secret || ""))
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

function distWebPath() {
  return path.join(__dirname, "../dist/web/index.html");
}

function windowIconPath() {
  const p = path.join(__dirname, "../build/icon.png");
  return fs.existsSync(p) ? p : undefined;
}

function loadTrayImage() {
  const p = windowIconPath();
  if (!p) return null;
  try {
    let img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const t = process.platform === "darwin" ? 22 : 16;
    if (width !== t || height !== t) {
      img = img.resize({ width: t, height: t });
    }
    return img;
  } catch {
    return null;
  }
}

function buildConfig() {
  const s = settingsStore.getAll();
  const clusterMode = Boolean(s.clusterMode);
  const isLocal = s.serverMode === "local";
  let port = isLocal ? s.localPort : s.remotePort;
  let host = isLocal ? "127.0.0.1" : s.remoteHost.trim() || "127.0.0.1";
  if (clusterMode && clusterLeader?.host && clusterLeader?.port) {
    host = clusterLeader.host;
    port = clusterLeader.port;
  }
  const socketUrl = `http://${host}:${port}`;
  return {
    socketUrl,
    displayName: s.displayName,
    clientUuid: s.clientUuid,
    serverMode: s.serverMode,
    localPort: s.localPort,
    remoteHost: s.remoteHost,
    remotePort: s.remotePort,
    presenceStatus: s.presenceStatus || "uygun",
    language: s.language || "",
    notificationSound: s.notificationSound !== false,
    profileImage: s.profileImage || "",
    hostname: os.hostname(),
    clusterMode,
    clusterId: s.clusterId || "kobichat-lan",
    nodeId: s.nodeId || "",
    leaderNodeId: clusterLeader?.nodeId || "",
    leaderSocketUrl: clusterLeader?.host && clusterLeader?.port ? `http://${clusterLeader.host}:${clusterLeader.port}` : "",
    clusterRole,
    clusterTerm,
    clusterLeaseUntil
  };
}

function broadcastConfig() {
  const cfg = buildConfig();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send("kobichat:config-updated", cfg);
      } catch {
        // ignored
      }
    }
  }
}

function localLanHost() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function clusterScore(term, bootAt, nodeId) {
  return `${String(term).padStart(12, "0")}:${String(9999999999999 - bootAt).padStart(13, "0")}:${nodeId}`;
}

function hasAnyValidPeer(now = Date.now()) {
  for (const p of clusterPeers.values()) {
    if ((Number(p.leaseUntil) || 0) > now) return true;
  }
  return false;
}

function computeClusterLeader(s) {
  const candidates = [];
  const now = Date.now();
  if (clusterLeaseUntil > now && s.nodeId) {
    candidates.push({
      nodeId: s.nodeId,
      term: clusterTerm,
      bootAt: clusterBootAt,
      host: localLanHost(),
      port: s.localPort || DEFAULT_PORT,
      leaseUntil: clusterLeaseUntil
    });
  }
  for (const p of clusterPeers.values()) {
    if (!p.nodeId || !p.host || !p.port) continue;
    if ((Number(p.leaseUntil) || 0) <= now) continue;
    candidates.push(p);
  }
  candidates.sort((a, b) => {
    const as = clusterScore(a.term || 0, a.bootAt || now, a.nodeId || "");
    const bs = clusterScore(b.term || 0, b.bootAt || now, b.nodeId || "");
    return as > bs ? -1 : as < bs ? 1 : 0;
  });
  return candidates[0] || null;
}

async function applyClusterLeaderToSettings() {
  if (!settingsStore) return;
  const s = settingsStore.getAll();
  if (!s.clusterMode) return;
  const leader = computeClusterLeader(s);
  clusterLeader = leader;
  if (leader?.nodeId === s.nodeId) {
    clusterRole = "leader";
    clusterLeaseUntil = Date.now() + 4200;
  } else {
    clusterRole = "follower";
  }
  if (leader?.host && leader?.port) {
    const mode = leader.nodeId === s.nodeId ? "local" : "remote";
    const key = `${mode}|${leader.host}|${leader.port}|${leader.nodeId}`;
    settingsStore.save({
      serverMode: leader.nodeId === s.nodeId ? "local" : "remote",
      remoteHost: leader.host,
      remotePort: leader.port
    });
    if (appliedLeaderKey !== key) {
      appliedLeaderKey = key;
      await applyServerMode();
    }
  }
}

function stopClusterCoordinator() {
  if (clusterTicker) {
    clearInterval(clusterTicker);
    clusterTicker = null;
  }
  if (clusterSock) {
    try {
      clusterSock.close();
    } catch {
      // ignored
    }
    clusterSock = null;
  }
}

function startClusterCoordinator() {
  if (!settingsStore) return;
  const s = settingsStore.getAll();
  if (!s.clusterMode) {
    stopClusterCoordinator();
    return;
  }
  stopClusterCoordinator();
  clusterBootAt = Date.now();
  clusterRole = "leader";
  clusterTerm = Math.max(clusterTerm, 1);
  clusterLeaseUntil = Date.now() + 4200;
  clusterElectionAt = Date.now() + 20000;
  clusterPeers.clear();
  clusterSock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  clusterSock.on("error", () => {});
  clusterSock.on("message", async (buf, rinfo) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m?.t !== "kobichat-cluster" || Number(m.v) !== 1) return;
      if (String(m.clusterId || "") !== String(s.clusterId || "")) return;
      const advertisedHost = String(m.host || "");
      const body = {
        t: m.t,
        v: Number(m.v),
        clusterId: String(m.clusterId || ""),
        nodeId: String(m.nodeId || ""),
        role: String(m.role || ""),
        term: Number(m.term) || 0,
        leaseUntil: Number(m.leaseUntil) || 0,
        host: advertisedHost,
        port: Number(m.port) || 0,
        bootAt: Number(m.bootAt) || 0,
        ts: Number(m.ts) || 0
      };
      if (s.sharedSecret && signCluster(body, s.sharedSecret) !== String(m.signature || "")) return;
      const observedHost = String(rinfo?.address || "").trim();
      if (observedHost && observedHost !== "0.0.0.0") {
        body.host = observedHost;
      }
      if (!body.nodeId || body.nodeId === s.nodeId) return;
      clusterPeers.set(body.nodeId, body);
      if (body.term > clusterTerm) {
        clusterTerm = body.term;
        clusterRole = "follower";
      }
      const leader = computeClusterLeader(s);
      const prevLeader = clusterLeader?.nodeId || "";
      clusterLeader = leader;
      if (leader?.nodeId !== prevLeader) {
        await applyClusterLeaderToSettings();
        broadcastConfig();
      }
    } catch {
      // ignored
    }
  });
  clusterSock.bind(CLUSTER_CTRL_UDP_PORT, "0.0.0.0", () => {
    try {
      clusterSock.setBroadcast(true);
    } catch {
      // ignored
    }
  });

  clusterTicker = setInterval(async () => {
    if (!settingsStore) return;
    const st = settingsStore.getAll();
    if (!st.clusterMode) return;
    const now = Date.now();
    for (const [id, p] of clusterPeers.entries()) {
      if ((Number(p.leaseUntil) || 0) + 1500 < now) clusterPeers.delete(id);
    }
    const leader = computeClusterLeader(st);
    const peersPresent = hasAnyValidPeer(now);
    if (!leader || leader.leaseUntil <= now) {
      clusterTerm += 1;
      clusterRole = "leader";
      clusterLeaseUntil = now + 4200;
      clusterElectionAt = now + 3500 + Math.floor(Math.random() * 1200);
    } else if (leader.nodeId !== st.nodeId && peersPresent) {
      clusterRole = "follower";
      clusterLeaseUntil = now + 1200;
    } else {
      clusterRole = "leader";
      clusterLeaseUntil = now + 4200;
    }

    const body = {
      t: "kobichat-cluster",
      v: 1,
      clusterId: String(st.clusterId || ""),
      nodeId: String(st.nodeId || ""),
      role: clusterRole,
      term: clusterTerm,
      leaseUntil: clusterLeaseUntil,
      host: localLanHost(),
      port: Number(st.localPort) || DEFAULT_PORT,
      bootAt: clusterBootAt,
      ts: now
    };
    const pkt = {
      ...body,
      signature: st.sharedSecret ? signCluster(body, st.sharedSecret) : ""
    };
    const msg = Buffer.from(JSON.stringify(pkt));
    try {
      clusterSock.send(msg, CLUSTER_CTRL_UDP_PORT, "255.255.255.255", () => {});
    } catch {
      // ignored
    }
    await applyClusterLeaderToSettings();
    broadcastConfig();
  }, 1200);
}

const ROSTER_SCREEN_MARGIN = 12;

function positionMainWindowBottomRight() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const [w, h] = mainWindow.getSize();
    const x = Math.round(wa.x + wa.width - w - ROSTER_SCREEN_MARGIN);
    const y = Math.round(wa.y + wa.height - h - ROSTER_SCREEN_MARGIN);
    mainWindow.setPosition(x, y);
  } catch {
    // ignored
  }
}

function showRosterWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    positionMainWindowBottomRight();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch {
    // ignored
  }
}

function trayPresenceKeyToLabel(key) {
  if (key === "mesgul") return "Meşgul";
  if (key === "disarida") return "Dışarıda";
  return "Uygun";
}

function escapeAboutHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildAboutPageHtml() {
  const ver = escapeAboutHtml(app.getVersion());
  const year = new Date().getFullYear();
  const tagline = "Yerel ağ masaüstü sohbet ve dosya paylaşım uygulaması";
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>KobiChat — Bilgi</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px 18px 14px;
    font-family: system-ui, "Segoe UI", sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    font-size: 14px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .tag {
    font-size: 0.85rem;
    color: #94a3b8;
    margin: 0 0 10px;
  }
  .row { margin-bottom: 8px; }
  dt {
    font-size: 0.72rem;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 2px;
  }
  dd { margin: 0; color: #e2e8f0; }
  a { color: #38bdf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #334155;
    font-size: 0.78rem;
    color: #94a3b8;
    line-height: 1.5;
  }
  .shortcut {
    margin-top: 4px;
  }
</style>
</head>
<body>
  <h1>KobiChat</h1>
  <p class="tag">${escapeAboutHtml(tagline)}</p>
  <dl>
    <div class="row">
      <dt>Sürüm</dt>
      <dd>${ver}</dd>
    </div>
    <div class="row">
      <dt>Yıl</dt>
      <dd>${year}</dd>
    </div>
    <div class="row">
      <dt>Telif hakkı</dt>
      <dd>© ${year} Mercan Yazılım. Tüm hakları saklıdır.</dd>
    </div>
    <div class="row">
      <dt>Teknik destek</dt>
      <dd><a href="mailto:serkanyavuzmercan@gmail.com">serkanyavuzmercan@gmail.com</a></dd>
    </div>
    <div class="row">
      <dt>Kısa yollar</dt>
      <dd class="shortcut">Ctrl + Shift + K ile çevrimiçi liste açılır.</dd>
    </div>
  </dl>
  <div class="footer">
    Bu uygulama yerel ağ üzerinden çalışır. Sorun ve önerileriniz için yukarıdaki e-posta ile iletişime geçebilirsiniz.
  </div>
</body>
</html>`;
}

function openAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  aboutWindow = new BrowserWindow({
    width: 400,
    height: 460,
    minWidth: 400,
    maxWidth: 400,
    minHeight: 460,
    maxHeight: 460,
    resizable: false,
    maximizable: false,
    show: false,
    parent,
    modal: Boolean(parent),
    title: "KobiChat — Bilgi",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  aboutWindow.setMenu(null);
  aboutWindow.once("ready-to-show", () => {
    if (aboutWindow && !aboutWindow.isDestroyed()) {
      aboutWindow.center();
      aboutWindow.show();
    }
  });
  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });
  aboutWindow.webContents.on("will-navigate", (e, url) => {
    if (typeof url === "string" && url.startsWith("mailto:")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildAboutPageHtml())}`
  );
}

function openQuickMessagesWindow() {
  if (quickMessagesWindow && !quickMessagesWindow.isDestroyed()) {
    quickMessagesWindow.focus();
    return { ok: true };
  }
  quickMessagesWindow = new BrowserWindow({
    width: 440,
    height: 540,
    minWidth: 360,
    minHeight: 400,
    show: false,
    frame: true,
    title: "KobiChat — Hazır mesajlar",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  attachDownloadReveal(quickMessagesWindow.webContents.session);
  quickMessagesWindow.once("ready-to-show", () => {
    if (quickMessagesWindow && !quickMessagesWindow.isDestroyed()) {
      quickMessagesWindow.show();
    }
  });
  quickMessagesWindow.on("closed", () => {
    quickMessagesWindow = null;
  });
  const q = { mode: "quickMessages" };
  if (!app.isPackaged) {
    const qs = new URLSearchParams(q);
    quickMessagesWindow.loadURL(`http://localhost:5173/?${qs.toString()}`);
  } else {
    const p = distWebPath();
    if (fs.existsSync(p)) {
      quickMessagesWindow.loadFile(p, { query: q });
    } else {
      quickMessagesWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;background:#0f172a;color:#e2e8f0">build eksik</body></html>`
        )}`
      );
    }
  }
  return { ok: true };
}

function buildTrayMenu() {
  const s = settingsStore.getAll();
  const cur = s.presenceStatus || "uygun";
  const setStatus = (key) => {
    settingsStore.save({ presenceStatus: key });
    broadcastConfig();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("kobichat:presence-tray", { presenceStatus: key });
    }
    if (tray) {
      tray.setToolTip(`KobiChat — ${trayPresenceKeyToLabel(key)}`);
    }
  };

  return Menu.buildFromTemplate([
    {
      label: "KobiChat — göster",
      click: () => {
        showRosterWindow();
      }
    },
    { type: "separator" },
    {
      label: "Uygun",
      type: "radio",
      checked: cur === "uygun",
      click: () => setStatus("uygun")
    },
    {
      label: "Meşgul",
      type: "radio",
      checked: cur === "mesgul",
      click: () => setStatus("mesgul")
    },
    {
      label: "Dışarıda",
      type: "radio",
      checked: cur === "disarida",
      click: () => setStatus("disarida")
    },
    { type: "separator" },
    {
      label: "Bilgi…",
      click: () => {
        openAboutWindow();
      }
    },
    { type: "separator" },
    {
      label: "Çıkış",
      click: () => {
        appQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  const img = loadTrayImage();
  if (!img) {
    console.warn("[tray] ikon yüklenemedi");
    return;
  }
  try {
    tray = new Tray(img);
    tray.setToolTip(`KobiChat — ${trayPresenceKeyToLabel(settingsStore.getAll().presenceStatus || "uygun")}`);
    tray.setContextMenu(buildTrayMenu());
    tray.on("double-click", () => {
      showRosterWindow();
    });
  } catch (e) {
    console.error("[tray]", e);
  }
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function stopChatServer() {
  return new Promise((resolve) => {
    if (!chatInstance) {
      resolve();
      return;
    }
    const inst = chatInstance;
    chatInstance = null;
    inst.close(() => resolve());
  });
}

function startChatServerFromSettings() {
  return new Promise((resolve, reject) => {
    const s = settingsStore.getAll();
    const shouldRunLocal = s.clusterMode ? clusterRole === "leader" : s.serverMode === "local";
    if (!shouldRunLocal) {
      resolve();
      return;
    }
    const dataDir = path.join(app.getPath("userData"), "server-data");
    const staticDir = path.join(__dirname, "../dist/web");
    const staticOk = fs.existsSync(path.join(staticDir, "index.html"));
    createChatServer({
      dataDir,
      staticDir: staticOk ? staticDir : null,
      cluster: {
        clusterEnabled: s.clusterMode,
        clusterId: s.clusterId,
        nodeId: s.nodeId,
        sharedSecret: s.sharedSecret,
        getRole: () => clusterRole,
        getTerm: () => clusterTerm,
        getLeaseUntil: () => clusterLeaseUntil
      }
    })
      .then((instance) => {
        chatInstance = instance;
        const port = s.localPort || DEFAULT_PORT;
        chatInstance.listen("0.0.0.0", port, () => {
          resolve();
        });
        chatInstance.server.on("error", (err) => {
          reject(err);
        });
      })
      .catch(reject);
  });
}

async function applyServerMode() {
  await stopChatServer();
  try {
    await startChatServerFromSettings();
  } catch (e) {
    console.error(e);
    const s = settingsStore?.getAll?.() || {};
    if (isAddrInUseError(e) && s.clusterMode) {
      // Port çakışmasında yanlışlıkla localhost'a sabitlenmek yerine mevcut lider/hedefe düş.
      const fallbackHost =
        (clusterLeader?.host && String(clusterLeader.host).trim()) ||
        (String(s.remoteHost || "").trim() ? String(s.remoteHost).trim() : "127.0.0.1");
      const fallbackPort =
        Number(clusterLeader?.port) || Number(s.remotePort) || Number(s.localPort) || DEFAULT_PORT;
      settingsStore.save({
        serverMode: "remote",
        remoteHost: fallbackHost,
        remotePort: fallbackPort
      });
      clusterRole = "follower";
      clusterLeaseUntil = Date.now() + 1200;
      broadcastConfig();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const key = `${e?.message || e}`;
      const now = Date.now();
      if (key !== lastServerErrorKey || now - lastServerErrorAt > 10000) {
        lastServerErrorKey = key;
        lastServerErrorAt = now;
        dialog.showErrorBox(
          "Sunucu başlatılamadı",
          `Port kullanımda olabilir veya izin yok.\n\n${e?.message || e}`
        );
      }
    }
  }
  broadcastConfig();
}

function discoverLanServers() {
  return new Promise((resolve) => {
    const s = settingsStore?.getAll?.() || {};
    const clusterId = String(s.clusterId || CLUSTER_ID_DEFAULT);
    const secret = String(s.sharedSecret || CLUSTER_SECRET_DEFAULT);
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try {
        sock.close();
      } catch {
        // ignored
      }
      resolve(Array.from(found.values()));
    };
    sock.on("error", () => done());
    sock.on("message", (buf, rinfo) => {
      try {
        const o = JSON.parse(buf.toString());
        if (o.t === "kobichat-offer" && o.host && o.httpPort) {
          if (o.clusterId && String(o.clusterId) !== clusterId) return;
          if (secret) {
            const body = {
              t: String(o.t || ""),
              v: Number(o.v) || 1,
              host: String(o.host || ""),
              httpPort: Number(o.httpPort) || 0,
              clusterId: String(o.clusterId || ""),
              nodeId: String(o.nodeId || ""),
              role: String(o.role || ""),
              term: Number(o.term) || 0,
              leaseUntil: Number(o.leaseUntil) || 0,
              ts: Number(o.ts) || 0
            };
            const sig = signCluster(body, secret);
            if (String(o.signature || "") !== sig) return;
          }
          const packetHost = String(rinfo?.address || "").trim();
          const offerHost = String(o.host || "").trim();
          const host = packetHost && packetHost !== "0.0.0.0" ? packetHost : offerHost;
          const socketUrl = `http://${host}:${o.httpPort}`;
          found.set(socketUrl, {
            socketUrl,
            host,
            port: o.httpPort,
            role: o.role || "follower",
            term: Number(o.term) || 0,
            leaseUntil: Number(o.leaseUntil) || 0,
            nodeId: String(o.nodeId || "")
          });
        }
      } catch {
        // ignored
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // ignored
      }
      const body = {
        t: "kobichat-discover",
        v: 1,
        clusterId,
        nodeId: String(s.nodeId || ""),
        nonce
      };
      const msg = Buffer.from(
        JSON.stringify({
          ...body,
          signature: secret ? signCluster(body, secret) : ""
        })
      );
      sock.send(msg, DISCOVERY_UDP_PORT, "255.255.255.255", () => {});
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === "IPv4" && !net.internal && net.address) {
            const p = net.address.split(".").map(Number);
            if (p.length === 4) {
              const bcast = `${p[0]}.${p[1]}.${p[2]}.255`;
              try {
                sock.send(msg, DISCOVERY_UDP_PORT, bcast, () => {});
              } catch {
                // ignored
              }
            }
          }
        }
      }
    });
    setTimeout(() => {
      const list = Array.from(found.values()).sort((a, b) => {
        const aLeader = a.role === "leader" ? 1 : 0;
        const bLeader = b.role === "leader" ? 1 : 0;
        if (aLeader !== bLeader) return bLeader - aLeader;
        if ((a.term || 0) !== (b.term || 0)) return (b.term || 0) - (a.term || 0);
        if ((a.leaseUntil || 0) !== (b.leaseUntil || 0)) return (b.leaseUntil || 0) - (a.leaseUntil || 0);
        const an = String(a.nodeId || "");
        const bn = String(b.nodeId || "");
        if (an !== bn) return an.localeCompare(bn);
        const ah = String(a.host || "");
        const bh = String(b.host || "");
        if (ah !== bh) return ah.localeCompare(bh);
        return Number(a.port || 0) - Number(b.port || 0);
      });
      if (!finished) {
        finished = true;
        try {
          sock.close();
        } catch {
          // ignored
        }
        resolve(list);
      }
    }, 2200);
  });
}

/** Aynı tick içinde minimize + flash birleşince Windows’ta görev çubuğu yanıp sönmez; küçültmeyi ve flash’ı erteleyelim. */
function scheduleMinimizeAndFlash(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (typeof win.showInactive === "function") {
      win.showInactive();
    } else {
      win.show();
    }
  } catch {
    try {
      win.show();
    } catch {
      // ignored
    }
  }
  setTimeout(() => {
    if (win.isDestroyed()) return;
    try {
      win.minimize();
    } catch {
      // ignored
    }
    setTimeout(() => {
      if (win.isDestroyed()) return;
      try {
        win.flashFrame(true);
      } catch {
        // ignored
      }
    }, 150);
  }, 0);
}

/**
 * @param {{ peerId: string, peerClientUuid: string, peerDisplayName?: string, peerName?: string, peerStatus?: string, openMinimized?: boolean }} payload
 * @returns {{ ok: boolean, created?: boolean }}
 */
function openChatWindowFromPayload(payload) {
  const peerId = String(payload.peerId || "").trim();
  const peerClientUuid = String(payload.peerClientUuid || "").trim();
  if (!peerId || !peerClientUuid) return { ok: false };
  const openMinimized = Boolean(payload.openMinimized);
  const peerName = String(payload.peerDisplayName || payload.peerName || "").slice(0, 80);
  const peerStatus = String(payload.peerStatus || "available").slice(0, 32);
  const existing = chatWindowsByClientUuid.get(peerClientUuid);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.webContents.send("kobichat:chat-peer-socket", {
        peerId,
        peerDisplayName: peerName,
        peerStatus
      });
    } catch {
      // ignored
    }
    try {
      if (peerName) {
        existing.setTitle(`${peerName} — KobiChat`);
      }
    } catch {
      // ignored
    }
    if (openMinimized) {
      try {
        if (!existing.isFocused()) {
          if (!existing.isMinimized()) {
            scheduleMinimizeAndFlash(existing);
          } else {
            setTimeout(() => {
              if (existing.isDestroyed()) return;
              try {
                existing.flashFrame(true);
              } catch {
                // ignored
              }
            }, 150);
          }
        }
      } catch {
        // ignored
      }
      return { ok: true, created: false };
    }
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { ok: true, created: false };
  }
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 420,
    minHeight: 380,
    show: false,
    skipTaskbar: false,
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    title: peerName ? `${peerName} — KobiChat` : "KobiChat",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  attachDownloadReveal(win.webContents.session);
  win.on("focus", () => {
    try {
      win.flashFrame(false);
    } catch {
      // ignored
    }
  });
  win.once("ready-to-show", () => {
    if (openMinimized) {
      scheduleMinimizeAndFlash(win);
    } else {
      win.show();
    }
  });
  chatWindowsByClientUuid.set(peerClientUuid, win);
  win.on("closed", () => {
    chatWindowsByClientUuid.delete(peerClientUuid);
  });
  const q = {
    mode: "chat",
    peerId,
    peerUuid: peerClientUuid,
    peerName: peerName || "—",
    peerStatus
  };
  if (!app.isPackaged) {
    const qs = new URLSearchParams(q);
    win.loadURL(`http://localhost:5173/?${qs.toString()}`);
  } else {
    const p = distWebPath();
    if (fs.existsSync(p)) {
      win.loadFile(p, { query: q });
    } else {
      win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;background:#0f172a;color:#e2e8f0">build eksik</body></html>`
        )}`
      );
    }
  }
  return { ok: true, created: true };
}

function attachDownloadReveal(session) {
  session.on("will-download", (_event, item) => {
    item.once("done", (_e, state) => {
      if (state !== "completed") return;
      try {
        const p = item.getSavePath();
        if (p && fs.existsSync(p)) {
          shell.showItemInFolder(p);
        }
      } catch {
        // ignored
      }
    });
  });
}

function safeDownloadName(rawName, fallback = "download") {
  const cleaned = String(rawName || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  return cleaned || fallback;
}

function uniqueFilePath(targetDir, filename) {
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = path.join(targetDir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function downloadFileToPath(rawUrl, savePath) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const maxRedirects = 5;
    const doRequest = (urlStr) => {
      let urlObj;
      try {
        urlObj = new URL(urlStr);
      } catch {
        reject(new Error("Geçersiz indirme URL'si"));
        return;
      }
      const client = urlObj.protocol === "https:" ? https : http;
      const req = client.get(urlObj, (res) => {
        const status = Number(res.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          redirects += 1;
          if (redirects > maxRedirects) {
            reject(new Error("Çok fazla yönlendirme"));
            return;
          }
          const nextUrl = new URL(res.headers.location, urlObj).toString();
          doRequest(nextUrl);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const out = fs.createWriteStream(savePath);
        out.on("error", reject);
        res.on("error", reject);
        out.on("finish", () => resolve(true));
        res.pipe(out);
      });
      req.on("error", reject);
    };
    doRequest(rawUrl);
  });
}

async function downloadAndHandleAttachment(payload) {
  const rawUrl = String(payload?.url || "").trim();
  if (!rawUrl) return false;
  const filename = safeDownloadName(payload?.filename, "download");
  const docsDir = app.getPath("documents");
  const targetDir = path.join(docsDir, "kobiChat");
  fs.mkdirSync(targetDir, { recursive: true });
  const savePath = uniqueFilePath(targetDir, filename);
  await downloadFileToPath(rawUrl, savePath);
  const openErr = await shell.openPath(targetDir);
  if (openErr) {
    shell.showItemInFolder(savePath);
  }
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 600,
    minWidth: 380,
    maxWidth: 380,
    minHeight: 600,
    maxHeight: 600,
    resizable: false,
    maximizable: false,
    frame: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  attachDownloadReveal(mainWindow.webContents.session);

  mainWindow.once("ready-to-show", () => {
    positionMainWindowBottomRight();
    mainWindow.show();
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://localhost:5173/?mode=roster");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const p = distWebPath();
    if (fs.existsSync(p)) mainWindow.loadFile(p, { query: { mode: "roster" } });
    else {
      mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"/><title>Hata</title></head><body style="font-family:system-ui;padding:24px;background:#0f172a;color:#e2e8f0"><h1>Önce derleme gerekli</h1><p>npm run build çalıştırın.</p></body></html>`
        )}`
      );
    }
  }

  mainWindow.on("close", (e) => {
    if (!appQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showRosterWindow();
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.mercan.kobichat");
    }
    settingsStore = await openSettingsStore(app.getPath("userData"));
    normalizeSettingsForVersion(app.getVersion());
    const st = settingsStore.getAll();
    if (
      !st.loginItemSetupDone &&
      app.isPackaged &&
      (process.platform === "win32" || process.platform === "darwin")
    ) {
      try {
        app.setLoginItemSettings({
          openAtLogin: true,
          path: process.execPath,
          enabled: true
        });
        settingsStore.save({ loginItemSetupDone: true });
      } catch (e) {
        console.error("Oturum açılışında başlatma ayarlanamadı:", e);
      }
    }
    startClusterCoordinator();
    await applyServerMode();
    createWindow();
    createTray();

    try {
      globalShortcut.register("CommandOrControl+Shift+K", () => {
        showRosterWindow();
      });
    } catch (e) {
      console.error("Kısayol kaydı:", e);
    }

    ipcMain.handle("kobichat:hide-main-window", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
      return true;
    });

    ipcMain.on("kobichat:relay-broadcast", (_event, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          try {
            w.webContents.send("kobichat:relay-broadcast-in", payload);
          } catch {
            // ignored
          }
        }
      }
    });

    ipcMain.on("kobichat:send-to-roster", (event, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send("kobichat:bridge-from-chat", payload);
        } catch {
          // ignored
        }
      }
    });

    ipcMain.handle("kobichat:config", () => buildConfig());
    ipcMain.handle("kobichat:app-version", () => app.getVersion());
    ipcMain.handle("kobichat:settings:get", () => settingsStore.getAll());
    ipcMain.handle("kobichat:settings:save", async (_e, partial) => {
      settingsStore.save(partial || {});
      startClusterCoordinator();
      await applyServerMode();
      refreshTrayMenu();
      broadcastConfig();
      return settingsStore.getAll();
    });

    ipcMain.handle("kobichat:discover", () => discoverLanServers());

    ipcMain.handle("kobichat:clear-attention", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) {
        try {
          w.flashFrame(false);
        } catch {
          // ignored
        }
      }
    });

    ipcMain.handle("kobichat:play-notification-sound", () => {
      try {
        shell.beep();
      } catch {
        // ignored
      }
      return true;
    });

    ipcMain.handle("kobichat:open-chat", (_e, payload) => {
      if (!payload || typeof payload !== "object") return { ok: false };
      return openChatWindowFromPayload(payload);
    });

    ipcMain.handle("kobichat:open-quick-messages", () => openQuickMessagesWindow());
    ipcMain.handle("kobichat:download-and-handle", async (_e, payload) => {
      try {
        return await downloadAndHandleAttachment(payload);
      } catch (e) {
        console.error("Dosya indirme/açma hatası:", e);
        return false;
      }
    });

    ipcMain.handle("kobichat:refresh-tray-menu", () => {
      refreshTrayMenu();
      return true;
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else {
        showRosterWindow();
      }
    });
  });

  app.on("will-quit", () => {
    stopClusterCoordinator();
    try {
      globalShortcut.unregisterAll();
    } catch {
      // ignored
    }
  });

  app.on("window-all-closed", async () => {
    if (process.platform === "darwin") return;
    await stopChatServer();
    if (settingsStore) {
      try {
        settingsStore.close();
      } catch {
        // ignored
      }
      settingsStore = null;
    }
    app.quit();
  });

  app.on("before-quit", () => {
    appQuitting = true;
  });
}
