const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const { randomUUID } = require("crypto");
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
  screen,
  net,
  clipboard,
  powerMonitor
} = require("electron");
const { createChatServer, DEFAULT_PORT } = require("../server/chat-server.cjs");
const { openSettingsStore } = require("./settings-store.cjs");

/** Kişi listesini öne getiren genel kısayolun varsayılanı. */
const DEFAULT_GLOBAL_SHORTCUT = "CommandOrControl+Shift+K";

/**
 * Chromium'un autoplay politikasını devre dışı bırak; bu sayede tray'e
 * küçültülmüş veya arka plandaki bir pencere bile Audio API ile ses çalabilir.
 * Ayar app.whenReady()'den ÖNCE çağrılmalıdır.
 */
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Map<string, BrowserWindow>} peerClientUuid → sohbet penceresi (socket id değişse bile tek pencere) */
const chatWindowsByClientUuid = new Map();

/** Renderer `theme.js` ile aynı kurallar — harita anahtarı tutarlı olsun. */
function peerWindowKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let infoWindow = null;
/** @type {BrowserWindow | null} */
let quickMessagesWindow = null;
/** @type {BrowserWindow | null} */
let settingsWindow = null;
/** @type {ReturnType<createChatServer> | null} */
let chatInstance = null;
/** @type {ReturnType<openSettingsStore> | null} */
let settingsStore = null;
let appQuitting = false;
let lastServerErrorKey = "";
let lastServerErrorAt = 0;
/** Titreşim (poke) — yalnızca ilgili sohbet penceresi; çift tetiklemeyi sınırlar. */
let lastAttentionShakeAt = 0;
/** Görev çubuğu yanıp sönme döngüleri — pencere odaklanınca iptal edilir. */
const taskbarPulseStateByWinId = new Map();

function stopTaskbarPulse(win) {
  if (!win || win.isDestroyed()) return;
  const state = taskbarPulseStateByWinId.get(win.id);
  if (state?.timer) {
    clearTimeout(state.timer);
  }
  taskbarPulseStateByWinId.delete(win.id);
  try {
    win.flashFrame(false);
  } catch {
    // ignored
  }
}

/**
 * Windows görev çubuğunda sürekli yanıp söndürür.
 * Kullanıcı pencereye tıklayıp odaklanana kadar durmaz.
 */
function pulseTaskbarFlash(win, options = {}) {
  if (!win || win.isDestroyed()) return;
  if (win.isFocused()) return;

  const onMs = Math.max(120, Number(options.onMs) || 380);
  const offMs = Math.max(80, Number(options.offMs) || 320);

  stopTaskbarPulse(win);

  const state = { timer: null };
  taskbarPulseStateByWinId.set(win.id, state);

  const finish = () => {
    stopTaskbarPulse(win);
  };

  const step = () => {
    if (win.isDestroyed() || win.isFocused()) {
      finish();
      return;
    }
    try {
      win.flashFrame(true);
    } catch {
      finish();
      return;
    }
    state.timer = setTimeout(() => {
      if (win.isDestroyed() || win.isFocused()) {
        finish();
        return;
      }
      try {
        win.flashFrame(false);
      } catch {
        // ignored
      }
      state.timer = setTimeout(step, offMs);
    }, onMs);
  };

  step();
}

/**
 * IPC'yi çağıran BrowserWindow'u kısa süre OS düzeyinde sallar.
 * Yalnızca sohbet renderer'ından `attentionShakeSelf` ile tetiklenmeli (roster değil).
 */
function runAttentionShakeOnWindow(win) {
  if (!win || win.isDestroyed()) return;

  const now = Date.now();
  if (now - lastAttentionShakeAt < 850) return;

  let b;
  try {
    b = win.getBounds();
  } catch {
    return;
  }

  lastAttentionShakeAt = now;
  const snapshots = [{ w: win, b }];

  for (const { w } of snapshots) {
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.moveTop();
    } catch {
      // ignored
    }
  }
  try {
    win.focus();
  } catch {
    // ignored
  }

  let step = 0;
  const maxSteps = 18;
  const timer = setInterval(() => {
    if (step >= maxSteps) {
      clearInterval(timer);
      for (const { w, b } of snapshots) {
        try {
          w.setBounds(b);
        } catch {
          // ignored
        }
      }
      return;
    }
    const amp = (step % 2 === 0 ? 1 : -1) * (19 + (step % 5));
    const ampY = (step % 2 === 0 ? -1 : 1) * (12 + (step % 3));
    const grow = step % 6 < 2 ? 22 : step % 6 < 4 ? -18 : 0;
    for (const { w, b } of snapshots) {
      try {
        w.setBounds({
          x: b.x + amp,
          y: b.y + ampY,
          width: Math.max(360, b.width + grow),
          height: Math.max(280, b.height - Math.round(grow * 0.3))
        });
      } catch {
        // ignored
      }
    }
    step++;
  }, 68);
}

/**
 * Gelen poke: pencere odakta değilse görev çubuğunda yanıp söndür; odaktaysa OS sallaması.
 */
function applyIncomingPokeAttentionToChatWindow(win) {
  if (!win || win.isDestroyed()) return false;

  let needsTaskbarFlash = false;
  try {
    needsTaskbarFlash = !win.isFocused() || win.isMinimized() || !win.isVisible();
  } catch {
    needsTaskbarFlash = true;
  }

  if (needsTaskbarFlash) {
    try {
      if (win.isMinimized()) {
        win.restore();
      }
      if (!win.isVisible()) {
        if (typeof win.showInactive === "function") {
          win.showInactive();
        } else {
          win.show();
        }
      }
      if (!win.isFocused()) {
        win.flashFrame(true);
      }
    } catch {
      // ignored
    }
  } else {
    runAttentionShakeOnWindow(win);
  }

  try {
    win.webContents.send("kobichat:attention-css-burst");
  } catch {
    // ignored
  }
  return true;
}

let updaterTooltipBase = "";
const MANUAL_UPDATE_MIN_INTERVAL_MS = 30 * 1000;
let lastManualUpdateCheckAt = 0;
let suppressInfoBlurCloseUntil = 0;
let infoBlurCloseTimer = null;
let infoPartyActive = false;
let ignoreInfoMoveUntil = 0;
let lastInfoMoveSample = null;

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  try {
    const m = String(err?.message || err || "Bilinmeyen hata");
    dialog.showErrorBox("Beklenmeyen hata", m);
  } catch {
    // ignored
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  try {
    const m = String(reason?.message || reason || "Bilinmeyen hata");
    dialog.showErrorBox("Beklenmeyen hata", m);
  } catch {
    // ignored
  }
});

/** Microsoft Store güncelleme sayfası (GitHub otomatik güncelleme devre dışı). */
const MICROSOFT_STORE_PRODUCT_ID = "9N01GLSS1KBJ";
const MICROSOFT_STORE_WEB_URL =
  "https://apps.microsoft.com/detail/9N01GLSS1KBJ?hl=tr-tr&gl=TR";
const MICROSOFT_STORE_PROTOCOL_URL = `ms-windows-store://pdp/?productid=${MICROSOFT_STORE_PRODUCT_ID}`;

/**
 * Renderer pencerelerine "şu sesi çal" sinyali yollar.
 * `src/sounds.js` modülü `onPlaySound` ile dinler ve kategori/master ayarlarına göre çalar.
 */
function broadcastPlaySound(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send("kobichat:play-sound", { name: trimmed });
      } catch {
        // ignored
      }
    }
  }
}

function readPackagedDistribution() {
  try {
    const pjPath = path.join(app.getAppPath(), "package.json");
    const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
    return String(pj.kobichatDistribution || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function isMicrosoftStoreDistribution() {
  return readPackagedDistribution() === "store";
}

function applyTrayPresenceTooltip(presenceKey) {
  if (!tray || tray.isDestroyed()) return;
  const key = presenceKey != null ? presenceKey : settingsStore.getAll().presenceStatus || "uygun";
  updaterTooltipBase = `KobiChat — ${trayPresenceKeyToLabel(key)}`;
  tray.setToolTip(updaterTooltipBase);
}

/** Ayarlar / tepsi: Microsoft Store ürün sayfasını açar. */
async function openMicrosoftStoreForUpdates() {
  if (!app.isPackaged) return { ok: false, reason: "not-packaged" };
  const now = Date.now();
  const retryAfterMs = MANUAL_UPDATE_MIN_INTERVAL_MS - (now - lastManualUpdateCheckAt);
  if (retryAfterMs > 0) {
    return { ok: false, throttled: true, retryAfterMs };
  }
  lastManualUpdateCheckAt = now;
  try {
    if (process.platform === "win32") {
      await shell.openExternal(MICROSOFT_STORE_PROTOCOL_URL);
    } else {
      await shell.openExternal(MICROSOFT_STORE_WEB_URL);
    }
  } catch (e) {
    console.warn("Store protokolü açılamadı, web URL deneniyor:", e?.message || e);
    try {
      await shell.openExternal(MICROSOFT_STORE_WEB_URL);
    } catch (e2) {
      console.error("openMicrosoftStoreForUpdates:", e2?.message || e2);
      return { ok: false, reason: "open-failed" };
    }
  }
  return { ok: true, opened: "microsoft-store" };
}

function normalizeSettingsForVersion(currentVersion) {
  if (!settingsStore) return;
  const st = settingsStore.getAll();
  if (String(st.lastRunVersion || "") === String(currentVersion || "")) return;
  // Sürüm geçişinde kullanıcı bağlantı tercihlerini KORU.
  // Önceki sürümlerde burada serverMode/localPort zorla resetleniyordu.
  settingsStore.save({
    lastRunVersion: String(currentVersion || "")
  });
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
  const localPort = Number(s.localPort) || DEFAULT_PORT;
  const remotePort = Number(s.remotePort) || DEFAULT_PORT;
  /** Tek merkezi sunucu: uzak modda tüm istemciler `remoteHost:remotePort` adresine bağlanır. */
  const isRemote = String(s.serverMode || "local").toLowerCase() === "remote";
  const remoteHost = String(s.remoteHost || "").trim();
  const socketUrl = isRemote && remoteHost
    ? `http://${remoteHost}:${remotePort}`
    : `http://127.0.0.1:${localPort}`;
  return {
    socketUrl,
    displayName: s.displayName,
    clientUuid: s.clientUuid,
    serverMode: s.serverMode,
    localPort: s.localPort,
    remoteHost: s.remoteHost,
    remotePort: s.remotePort,
    /** Uzak sunucu tabanı (socket.io); yerel modda 127.0.0.1 + localPort */
    centralSocketUrl: socketUrl,
    presenceStatus: s.presenceStatus || "uygun",
    language: s.language || "",
    notificationSound: s.notificationSound !== false,
    soundCategories: s.soundCategories || { message: true, file: true, system: true, presence: false },
    soundVolume: typeof s.soundVolume === "number" ? s.soundVolume : 1,
    profileImage: s.profileImage || "",
    /** Kişi listesini öne getiren genel kısayol + son kayıt denemesinin sonucu. */
    globalShortcut: s.globalShortcut || DEFAULT_GLOBAL_SHORTCUT,
    globalShortcutOk,
    hostname: os.hostname()
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

const ROSTER_SCREEN_MARGIN = 12;

function positionMainWindowBottomRight() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindowMode === "board") return;
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

/** Ana pencere: "roster" (dar kişi listesi, sağ alt köşe) veya "board" (Pano sekmesi, aynı köşeden genişler). */
let mainWindowMode = "roster";
/** @type {{ bounds: Electron.Rectangle, minSize: number[] } | null} */
let rosterStateBeforeBoard = null;
const BOARD_TAB_SIZE = { width: 960, height: 640 };

function setMainWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = mode === "board" ? "board" : "roster";
  if (next === mainWindowMode) return true;
  try {
    if (next === "board") {
      const bounds = mainWindow.getBounds();
      rosterStateBeforeBoard = { bounds, minSize: mainWindow.getMinimumSize() };
      const wa = screen.getDisplayMatching(bounds).workArea;
      const width = Math.min(BOARD_TAB_SIZE.width, wa.width);
      const height = Math.min(BOARD_TAB_SIZE.height, wa.height);
      mainWindowMode = "board";
      mainWindow.setMinimumSize(Math.min(720, width), Math.min(520, height));
      /** Olduğu yerde büyüsün: sağ alt köşe sabit, sola ve yukarı açılır; ekran dışına taşmaz. */
      const right = Math.min(bounds.x + bounds.width, wa.x + wa.width);
      const bottom = Math.min(bounds.y + bounds.height, wa.y + wa.height);
      mainWindow.setBounds({
        x: Math.max(wa.x, right - width),
        y: Math.max(wa.y, bottom - height),
        width,
        height
      });
    } else {
      mainWindowMode = "roster";
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      const prev = rosterStateBeforeBoard;
      rosterStateBeforeBoard = null;
      if (prev) {
        mainWindow.setMinimumSize(prev.minSize[0], prev.minSize[1]);
        mainWindow.setBounds(prev.bounds);
      } else {
        mainWindow.setContentSize(275, 520);
        positionMainWindowBottomRight();
      }
    }
  } catch {
    return false;
  }
  return true;
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

function openDevToolsWhenReady(win) {
  if (app.isPackaged || !win || win.isDestroyed()) return;
  win.webContents.once("did-finish-load", () => {
    if (!win.isDestroyed()) {
      win.webContents.openDevTools({ mode: "detach" });
    }
  });
}

function removeDefaultWindowMenu(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setMenu(null);
    win.setAutoHideMenuBar(true);
  } catch {
    // Menü kaldırma bazı platformlarda desteklenmeyebilir.
  }
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
  removeDefaultWindowMenu(quickMessagesWindow);
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
    openDevToolsWhenReady(quickMessagesWindow);
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

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appIconDataUrl() {
  try {
    const p = windowIconPath();
    if (!p) return "";
    return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
  } catch {
    return "";
  }
}

/** Şok bildirim: tam ekran, yanıp sönen kırmızı, sesli acil uyarı (pano → herkese). */
function showShockWindow(title, message, opts) {
  const o = opts || {};
  const okLabel = escHtml(o.okLabel) || "Anladım";
  const brandLabel = escHtml(o.brandLabel) || "KobiChat";
  const titleFallback = escHtml(o.titleFallback) || "ÖNEMLİ BİLDİRİM";
  let bounds = { x: 0, y: 0, width: 1280, height: 800 };
  try {
    bounds = screen.getPrimaryDisplay().bounds;
  } catch {
    // varsayılan
  }
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: true,
    backgroundColor: "#dc2626",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required"
    }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // platforma bağlı
  }
  const logoSrc = appIconDataUrl();
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;height:100%;font-family:system-ui,'Segoe UI',sans-serif;}` +
    `body{display:flex;align-items:center;justify-content:center;` +
    `background:#b91c1c;animation:kc-flash .6s steps(1) infinite;}` +
    `@keyframes kc-flash{0%{background:#dc2626}50%{background:#7f1d1d}100%{background:#dc2626}}` +
    `.card{background:#fff;border-radius:22px;padding:40px 36px;max-width:760px;width:82%;` +
    `max-height:88vh;box-sizing:border-box;text-align:center;box-shadow:0 24px 90px rgba(0,0,0,.55);` +
    `border:4px solid #dc2626;overflow:auto}` +
    `.icon{font-size:72px;line-height:1}` +
    `h1{color:#b91c1c;font-size:34px;margin:12px 0 16px;word-break:break-word}` +
    `p{color:#1f2937;font-size:20px;line-height:1.55;margin:0 0 28px;white-space:pre-line;word-break:break-word}` +
    `button{background:#dc2626;color:#fff;border:none;border-radius:12px;padding:16px 36px;` +
    `font-size:18px;font-weight:700;cursor:pointer;min-width:200px}` +
    `.brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px;` +
    `color:#94a3b8;font-size:14px;font-weight:600}` +
    `.brand img{width:22px;height:22px;border-radius:6px}</style></head><body>` +
    `<div class="card"><div class="icon">🚨</div><h1>${escHtml(title) || titleFallback}</h1>` +
    (escHtml(message) ? `<p>${escHtml(message)}</p>` : "") +
    `<button id="b" onclick="window.close()">${okLabel} (<span id="c">20</span>)</button>` +
    `<div class="brand">${logoSrc ? `<img src="${logoSrc}" alt=""/>` : ""}${brandLabel}</div></div>` +
    `<script>` +
    `try{var AC=window.AudioContext||window.webkitAudioContext;var ac=new AC();` +
    `function beep(t){var o=ac.createOscillator();var g=ac.createGain();o.connect(g);g.connect(ac.destination);` +
    `o.type='square';o.frequency.value=880;g.gain.setValueAtTime(0.0001,t);` +
    `g.gain.exponentialRampToValueAtTime(0.35,t+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t+0.28);` +
    `o.start(t);o.stop(t+0.3);}var b=ac.currentTime;for(var i=0;i<6;i++){beep(b+i*0.45);}}catch(e){}` +
    `var n=20;var t=setInterval(function(){n--;if(n<=0){clearInterval(t);window.close();}` +
    `else{document.getElementById('c').textContent=n;}},1000);</script></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    try {
      win.flashFrame(true);
    } catch {
      // ignored
    }
  });
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, 23000);
}

/** Zamanlı bildirim: ekranın ortasında küçük, sakin pencere + nazik çıngırak. */
function showNotifyWindow(title, message, opts) {
  const o = opts || {};
  const W = 460;
  const H = 320;
  let x = 0;
  let y = 0;
  try {
    const area = screen.getPrimaryDisplay().workArea;
    x = Math.round(area.x + (area.width - W) / 2);
    y = Math.round(area.y + (area.height - H) / 2);
  } catch {
    // varsayılan
  }
  const accent = /^#[0-9a-fA-F]{6}$/.test(o.color || "") ? o.color : "#4f46e5";
  const icon = escHtml(o.icon) || "🔔";
  const secs = Number(o.seconds) > 0 ? Math.min(300, Math.round(Number(o.seconds))) : 45;
  const win = new BrowserWindow({
    x,
    y,
    width: W,
    height: H,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required"
    }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // platforma bağlı
  }
  const logoSrc = appIconDataUrl();
  const ok = escHtml(o.okLabel) || "Tamam";
  const brand = escHtml(o.brandLabel) || "KobiChat";
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;height:100%;background:transparent;font-family:system-ui,'Segoe UI',sans-serif;overflow:hidden;}` +
    `body{display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;}` +
    `.card{position:relative;background:#fff;border-radius:18px;width:100%;height:100%;box-sizing:border-box;` +
    `padding:24px 26px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;` +
    `box-shadow:0 18px 60px rgba(15,23,42,.45);animation:kc-pop .3s cubic-bezier(.2,.9,.3,1.3);overflow:hidden;}` +
    `.card:before{content:"";position:absolute;top:0;left:0;right:0;height:6px;` +
    `background:linear-gradient(90deg,${accent},${accent}99);}` +
    `@keyframes kc-pop{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}` +
    `.icon{font-size:46px;line-height:1;margin-bottom:6px}` +
    `h1{color:#0f172a;font-size:21px;margin:0 0 8px;word-break:break-word;line-height:1.25}` +
    `p{color:#475569;font-size:15px;line-height:1.5;margin:0 0 18px;white-space:pre-line;word-break:break-word;` +
    `max-height:96px;overflow:auto}` +
    `button{background:${accent};color:#fff;border:none;border-radius:10px;padding:10px 26px;` +
    `font-size:14px;font-weight:700;cursor:pointer}` +
    `.brand{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;` +
    `color:#94a3b8;font-size:12px;font-weight:600}` +
    `.brand img{width:18px;height:18px;border-radius:5px}</style></head><body>` +
    `<div class="card"><div class="icon">${icon}</div>` +
    (escHtml(title) ? `<h1>${escHtml(title)}</h1>` : "") +
    (escHtml(message) ? `<p>${escHtml(message)}</p>` : "") +
    `<button id="b" onclick="window.close()">${ok} (<span id="c">${secs}</span>)</button>` +
    `<div class="brand">${logoSrc ? `<img src="${logoSrc}" alt=""/>` : ""}${brand}</div></div>` +
    `<script>` +
    `try{var AC=window.AudioContext||window.webkitAudioContext;var ac=new AC();` +
    `function tone(f,s,d,p){var o=ac.createOscillator();var g=ac.createGain();o.type='sine';o.frequency.value=f;` +
    `o.connect(g);g.connect(ac.destination);g.gain.setValueAtTime(0.00001,s);` +
    `g.gain.exponentialRampToValueAtTime(p,s+0.02);g.gain.exponentialRampToValueAtTime(0.00001,s+d);` +
    `o.start(s);o.stop(s+d+0.02);}var b=ac.currentTime+0.04;` +
    `tone(587.33,b,0.3,0.2);tone(783.99,b+0.16,0.3,0.2);tone(1046.5,b+0.32,0.5,0.22);}catch(e){}` +
    `var n=${secs};var t=setInterval(function(){n--;if(n<=0){clearInterval(t);window.close();}` +
    `else{document.getElementById('c').textContent=n;}},1000);</script></body></html>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => {
    win.show();
  });
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, (secs + 2) * 1000);
}

function loadInfoWindowContent(win, query) {
  if (!win || win.isDestroyed()) return;
  if (!app.isPackaged) {
    const qs = new URLSearchParams(query);
    win.loadURL(`http://localhost:5173/?${qs.toString()}`);
    openDevToolsWhenReady(win);
    return;
  }
  const p = distWebPath();
  if (fs.existsSync(p)) {
    win.loadFile(p, { query });
  } else {
    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;background:#0f172a;color:#e2e8f0">build eksik</body></html>`
      )}`
    );
  }
}

function suppressInfoBlurClose(ms = 900) {
  suppressInfoBlurCloseUntil = Date.now() + ms;
}

function activateInfoPartyMode() {
  if (!infoWindow || infoWindow.isDestroyed() || infoPartyActive) return;
  infoPartyActive = true;
  ignoreInfoMoveUntil = Date.now() + 1200;
  loadInfoWindowContent(infoWindow, { mode: "info", party: "1" });
}

function deactivateInfoPartyMode() {
  if (!infoWindow || infoWindow.isDestroyed() || !infoPartyActive) return;
  infoPartyActive = false;
  ignoreInfoMoveUntil = Date.now() + 1200;
  loadInfoWindowContent(infoWindow, { mode: "info" });
}

function toggleInfoPartyMode() {
  if (infoPartyActive) deactivateInfoPartyMode();
  else activateInfoPartyMode();
}

function watchInfoWindowMove() {
  if (!infoWindow || infoWindow.isDestroyed()) return;
  const now = Date.now();
  if (now < ignoreInfoMoveUntil) {
    lastInfoMoveSample = null;
    return;
  }
  const bounds = infoWindow.getBounds();
  const sample = { x: bounds.x, y: bounds.y, at: now };
  if (!lastInfoMoveSample) {
    lastInfoMoveSample = sample;
    return;
  }
  const dt = Math.max(1, sample.at - lastInfoMoveSample.at);
  const dx = sample.x - lastInfoMoveSample.x;
  const dy = sample.y - lastInfoMoveSample.y;
  const distance = Math.hypot(dx, dy);
  lastInfoMoveSample = sample;
  if (dt <= 220 && distance >= 90 && distance / dt >= 0.75) {
    toggleInfoPartyMode();
    lastInfoMoveSample = null;
  }
}

function openInfoWindow(options = {}) {
  suppressInfoBlurClose();
  const party = Boolean(options && options.party);
  if (infoWindow && !infoWindow.isDestroyed()) {
    if (party) {
      infoPartyActive = true;
      loadInfoWindowContent(infoWindow, { mode: "info", party: "1" });
    }
    infoWindow.focus();
    return { ok: true };
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const panelWidth = 400;
  const panelHeight = 520;
  infoPartyActive = party;
  lastInfoMoveSample = null;
  ignoreInfoMoveUntil = Date.now() + 1400;
  infoWindow = new BrowserWindow({
    width: panelWidth,
    height: panelHeight,
    minWidth: panelWidth,
    minHeight: panelHeight,
    show: false,
    frame: false,
    parent,
    title: "Bilgi - KobiChat",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  removeDefaultWindowMenu(infoWindow);
  attachDownloadReveal(infoWindow.webContents.session);
  infoWindow.once("ready-to-show", () => {
    if (infoWindow && !infoWindow.isDestroyed()) {
      if (parent && !parent.isDestroyed()) {
        const gap = 8;
        const parentBounds = parent.getBounds();
        const display = screen.getDisplayMatching(parentBounds);
        const workArea = display.workArea;
        const rightX = parentBounds.x + parentBounds.width + gap;
        const leftX = parentBounds.x - panelWidth - gap;
        const x =
          rightX + panelWidth <= workArea.x + workArea.width
            ? rightX
            : Math.max(workArea.x, leftX);
        const y = Math.min(
          Math.max(workArea.y, parentBounds.y),
          workArea.y + workArea.height - panelHeight
        );
        infoWindow.setPosition(x, y, false);
      }
      infoWindow.show();
      ignoreInfoMoveUntil = Date.now() + 700;
    }
  });
  infoWindow.on("closed", () => {
    if (infoBlurCloseTimer) {
      clearTimeout(infoBlurCloseTimer);
      infoBlurCloseTimer = null;
    }
    infoWindow = null;
    infoPartyActive = false;
    lastInfoMoveSample = null;
  });
  infoWindow.on("move", watchInfoWindowMove);
  infoWindow.on("blur", () => {
    if (infoBlurCloseTimer) clearTimeout(infoBlurCloseTimer);
    infoBlurCloseTimer = setTimeout(() => {
      infoBlurCloseTimer = null;
      if (!infoWindow || infoWindow.isDestroyed()) return;
      if (Date.now() < suppressInfoBlurCloseUntil) return;
      if (!app.isPackaged && infoWindow.webContents.isDevToolsOpened()) return;
      infoWindow.close();
    }, 350);
  });
  infoWindow.webContents.on("will-navigate", (e, url) => {
    if (typeof url === "string" && /^(mailto:|https?:\/\/)/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  infoWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  const q = party ? { mode: "info", party: "1" } : { mode: "info" };
  loadInfoWindowContent(infoWindow, q);
  return { ok: true };
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return { ok: true };
  }
  settingsWindow = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 360,
    minHeight: 520,
    show: false,
    /** Frameless pencere — Windows'un sistem çerçevesi gizli; başlık/drag/kapat tamamen renderer'da. */
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "KobiChat — Ayarlar",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  removeDefaultWindowMenu(settingsWindow);
  attachDownloadReveal(settingsWindow.webContents.session);
  settingsWindow.once("ready-to-show", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
    }
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  const q = { mode: "settings" };
  if (!app.isPackaged) {
    const qs = new URLSearchParams(q);
    settingsWindow.loadURL(`http://localhost:5173/?${qs.toString()}`);
    openDevToolsWhenReady(settingsWindow);
  } else {
    const p = distWebPath();
    if (fs.existsSync(p)) {
      settingsWindow.loadFile(p, { query: q });
    } else {
      settingsWindow.loadURL(
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
      applyTrayPresenceTooltip(key);
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
    ...(app.isPackaged
      ? [
          {
            label: "Microsoft Store'da güncelle",
            click: () => {
              void openMicrosoftStoreForUpdates();
            }
          },
          { type: "separator" }
        ]
      : []),
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
    applyTrayPresenceTooltip();
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
    applyTrayPresenceTooltip();
  }
}

/**
 * Otomatik "Dışarıda" (auto-away) — Softros benzeri boşta kalma algılama.
 * powerMonitor.getSystemIdleTime() sistem GENELİNDE son klavye/fare
 * girdisinden bu yana geçen saniyeyi verir (uygulama arka planda olsa bile).
 * Eşik aşılınca roster penceresine idle=true, ilk harekette idle=false
 * gönderilir; durum kararını (yalnızca "uygun" iken dışarıya düşme,
 * kullanıcının elle seçtiği durumu ezmeme) renderer verir.
 * KOBICHAT_AUTO_AWAY_MINUTES=0 ile kapatılabilir (varsayılan 5 dk).
 */
const AUTO_AWAY_IDLE_SECONDS = (() => {
  const env = process.env.KOBICHAT_AUTO_AWAY_MINUTES;
  if (env === "0") return 0;
  return Math.max(60, Math.round((Number(env) || 5) * 60));
})();
let lastReportedIdle = false;

function startSystemIdleWatcher() {
  if (!AUTO_AWAY_IDLE_SECONDS) return;
  setInterval(() => {
    let idleSeconds = 0;
    try {
      idleSeconds = powerMonitor.getSystemIdleTime();
    } catch {
      return;
    }
    const idle = idleSeconds >= AUTO_AWAY_IDLE_SECONDS;
    if (idle === lastReportedIdle) return;
    lastReportedIdle = idle;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("kobichat:system-idle", { idle, idleSeconds });
    }
  }, 5000);
}

/** Son kayıt denemesinin sonucu — ayarlar penceresi çakışmayı bildirebilsin diye. */
let globalShortcutOk = true;

/**
 * Genel kısayolu ayarlardan (yeniden) kaydeder. Kullanıcının seçtiği kombinasyon
 * başka bir uygulama tarafından tutuluyorsa `register` false döner; bu durumda
 * kullanıcı kısayolsuz kalmasın diye varsayılana geri düşülür ve sonuç
 * `globalShortcutOk` ile arayüze bildirilir.
 */
function applyGlobalShortcut() {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignored
  }
  const desired =
    String(settingsStore?.getAll?.().globalShortcut || "").trim() || DEFAULT_GLOBAL_SHORTCUT;
  const tryRegister = (accel) => {
    try {
      return globalShortcut.register(accel, () => showRosterWindow());
    } catch (e) {
      console.error("Kısayol kaydı:", accel, e?.message || e);
      return false;
    }
  };
  let ok = tryRegister(desired);
  if (!ok && desired !== DEFAULT_GLOBAL_SHORTCUT) {
    tryRegister(DEFAULT_GLOBAL_SHORTCUT);
  }
  globalShortcutOk = ok;
  return ok;
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
    const dataDir = path.join(app.getPath("userData"), "server-data");
    const staticDir = path.join(__dirname, "../dist/web");
    const staticOk = fs.existsSync(path.join(staticDir, "index.html"));
    createChatServer({
      dataDir,
      staticDir: staticOk ? staticDir : null
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
  const s = settingsStore.getAll();
  if (String(s.serverMode || "local").toLowerCase() !== "local") {
    broadcastConfig();
    return;
  }
  try {
    await startChatServerFromSettings();
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e || "");
    const isAddrInUse = msg.includes("EADDRINUSE");
    if (isAddrInUse) {
      // Aynı makinede zaten çalışan bir sunucu varsa, bu instance'ı istemciye düşür.
      const fallbackPort = Number(s.localPort) || DEFAULT_PORT;
      settingsStore.save({
        serverMode: "remote",
        remoteHost: "127.0.0.1",
        remotePort: fallbackPort
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        const key = `addrinuse:${fallbackPort}`;
        const now = Date.now();
        if (key !== lastServerErrorKey || now - lastServerErrorAt > 10000) {
          lastServerErrorKey = key;
          lastServerErrorAt = now;
          dialog.showErrorBox(
            "Sunucu zaten çalışıyor",
            `Bu bilgisayarda ${fallbackPort} portunu kullanan bir KobiChat sunucusu zaten açık.\n\nBu oturum istemci moduna alındı ve mevcut yerel sunucuya bağlanacak.`
          );
        }
      }
      broadcastConfig();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const key = msg;
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
      pulseTaskbarFlash(win);
    }, 150);
  }, 0);
}

/**
 * Windows'un odak çalma korumasını aşarak pencereyi kesin ön plana getirir.
 * setAlwaysOnTop(true) → focus → setAlwaysOnTop(false) sıralaması
 * Windows'ta BrowserWindow.focus()'un tek başına yetersiz kaldığı
 * durumları (arka plandaki uygulama) çözer.
 */
function bringWindowToFront(win) {
  if (!win || win.isDestroyed()) return;
  try { if (win.isMinimized()) win.restore(); } catch { /* ignored */ }
  try { win.show(); } catch { /* ignored */ }
  try {
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
  } catch { /* ignored */ }
}

/**
 * Pencereyi arka planda (odağı çalmadan) gösterir ve görev çubuğunda yanıp söndürür.
 * Kullanıcı aktif olarak başka bir sohbette yazıyorken gelen mesaj bildirimi için kullanılır.
 *
 * Windows'ta `flashFrame(true)` tek çağrıyla kullanıcı pencereye tıklayana kadar
 * sürekli yanıp söner — manuel pulse döngüsüne gerek yok.
 * `showInactive()` sonrası kısa gecikme, pencerenin görev çubuğuna yerleşmesini bekler.
 */
function showWindowInBackground(win) {
  if (!win || win.isDestroyed()) return;
  try { if (win.isMinimized()) win.restore(); } catch { /* ignored */ }
  try {
    if (typeof win.showInactive === "function") {
      win.showInactive();
    } else {
      win.show();
    }
  } catch { /* ignored */ }
  setTimeout(() => {
    if (win.isDestroyed() || win.isFocused()) return;
    try { win.flashFrame(true); } catch { /* ignored */ }
  }, 200);
}

/**
 * Herhangi bir BrowserWindow (sohbet, roster, vs.) şu anda odakta mı?
 * Başka bir pencere odaktaysa, gelen mesaj bildirimi odağı çalmamalı.
 */
function isAnyAppWindowFocused() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isFocused()) return true;
  }
  return false;
}

/**
 * Gelen mesaj bildirimi için akıllı pencere açma:
 * - Başka bir pencere odaktaysa → arka planda göster + görev çubuğunda yanıp söndür
 * - Hiçbir pencere odakta değilse → ön plana getir
 */
function smartShowForIncoming(win) {
  if (!win || win.isDestroyed()) return;
  if (isAnyAppWindowFocused()) {
    showWindowInBackground(win);
  } else {
    bringWindowToFront(win);
  }
}

/**
 * @param {{ peerId: string, peerClientUuid: string, peerDisplayName?: string, peerName?: string, peerStatus?: string, openMinimized?: boolean, pokeAttention?: boolean }} payload
 * @returns {{ ok: boolean, created?: boolean }}
 */
function openChatWindowFromPayload(payload) {
  const peerId = String(payload.peerId || "").trim();
  const peerClientUuid = String(payload.peerClientUuid || "").trim();
  if (!peerClientUuid) return { ok: false };
  const openMinimized = Boolean(payload.openMinimized);
  const pokeAttention = Boolean(payload.pokeAttention);
  const peerName = String(payload.peerDisplayName || payload.peerName || "").slice(0, 80);
  const peerStatus = String(payload.peerStatus || "available").slice(0, 32);
  const peerProfileImage = String(payload.peerProfileImage || "").trim().slice(0, 400000);
  const peerMapKey = peerWindowKey(peerClientUuid);
  const existing = chatWindowsByClientUuid.get(peerMapKey);
  if (existing && !existing.isDestroyed()) {
    try {
      existing.webContents.send("kobichat:chat-peer-socket", {
        peerId,
        peerDisplayName: peerName,
        peerStatus,
        peerProfileImage
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
        if (pokeAttention) {
          applyIncomingPokeAttentionToChatWindow(existing);
        } else {
          smartShowForIncoming(existing);
        }
      } catch {
        // ignored
      }
      return { ok: true, created: false };
    }
    bringWindowToFront(existing);
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
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  removeDefaultWindowMenu(win);
  attachDownloadReveal(win.webContents.session);
  win.on("focus", () => {
    stopTaskbarPulse(win);
  });
  win.once("ready-to-show", () => {
    if (pokeAttention) {
      win.show();
      runAttentionShakeOnWindow(win);
      try {
        win.webContents.send("kobichat:attention-css-burst");
      } catch {
        // ignored
      }
    } else if (openMinimized) {
      smartShowForIncoming(win);
    } else {
      bringWindowToFront(win);
    }
  });
  chatWindowsByClientUuid.set(peerMapKey, win);
  win.on("closed", () => {
    chatWindowsByClientUuid.delete(peerMapKey);
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send("kobichat:chat-window-closed", { peerClientUuid });
      } catch {
        // ignored
      }
    }
  });
  const q = {
    mode: "chat",
    peerId,
    peerUuid: peerClientUuid,
    peerName: peerName || "—",
    peerStatus,
    peerProfileImage
  };
  if (!app.isPackaged) {
    const qs = new URLSearchParams(q);
    win.loadURL(`http://localhost:5173/?${qs.toString()}`);
    openDevToolsWhenReady(win);
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

/**
 * Sık kullanılan MIME türleri için dosya uzantısı tablosu. İndirilen dosyanın
 * adında geçerli bir uzantı yoksa Windows dosyayı hangi programla açacağını
 * bilemez ("belge/pdf açılmıyor"). MIME bilgisinden doğru uzantıyı türetiriz.
 */
const MIME_EXTENSION_MAP = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "application/x-rar-compressed": ".rar",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/json": ".json",
  "application/rtf": ".rtf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tif",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov"
};

/**
 * Dosya adında zaten makul bir uzantı varsa dokunmaz; yoksa (veya
 * uzantı yer tutucu gibi anlamsızsa) MIME'dan türetilen uzantıyı ekler.
 */
function ensureFileExtension(name, mime) {
  const safeName = safeDownloadName(name, "download");
  const ext = path.extname(safeName).toLowerCase();
  // 1-5 harfli (örn. .pdf, .docx) bir uzantı varsa olduğu gibi bırak.
  if (ext && /^\.[a-z0-9]{1,5}$/i.test(ext)) return safeName;
  const wanted = MIME_EXTENSION_MAP[String(mime || "").trim().toLowerCase()];
  if (!wanted) return safeName;
  return `${safeName}${wanted}`;
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

/**
 * İndirme hedefi: aynı isim + beklenen boyut ile mevcut dosya varsa yeniden indirmeden kullan.
 * Boyut bilgisi yoksa veya uyuşmazsa `uniqueFilePath` ile çakışmayı çöz.
 */
function resolveChatDownloadSavePath(targetDir, filename, expectedSize) {
  const safeName = safeDownloadName(filename, "download");
  const direct = path.join(targetDir, safeName);
  const exp =
    typeof expectedSize === "number" && Number.isFinite(expectedSize) && expectedSize >= 0
      ? Math.trunc(expectedSize)
      : null;

  if (fs.existsSync(direct)) {
    try {
      const st = fs.statSync(direct);
      if (st.isFile() && exp !== null && st.size === exp) {
        return { savePath: direct, reused: true };
      }
    } catch {
      // fall through
    }
    return { savePath: uniqueFilePath(targetDir, safeName), reused: false };
  }
  return { savePath: direct, reused: false };
}

function isPathUnderDirectory(filePath, rootDir) {
  const file = path.resolve(filePath);
  const root = path.resolve(rootDir);
  if (process.platform === "win32") {
    return file.toLowerCase().startsWith(root.toLowerCase() + path.sep) || file.toLowerCase() === root.toLowerCase();
  }
  return file.startsWith(root + path.sep) || file === root;
}

const DOWNLOAD_DIAGNOSTIC_LOG = "download-diagnostics.jsonl";

function downloadDiagnosticLogPath() {
  return path.join(app.getPath("userData"), "logs", DOWNLOAD_DIAGNOSTIC_LOG);
}

function writeDownloadDiagnostic(entry) {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      appVersion: app.getVersion(),
      ...entry
    })}\n`;
    fs.appendFileSync(path.join(dir, DOWNLOAD_DIAGNOSTIC_LOG), line, "utf8");
  } catch (e) {
    console.error("writeDownloadDiagnostic:", e?.message || e);
  }
}

function serverBasesFromDownloadCandidates(candidates) {
  const bases = new Set();
  for (const raw of candidates || []) {
    try {
      const url = new URL(String(raw || "").trim());
      bases.add(`${url.protocol}//${url.host}`);
    } catch {
      // ignored
    }
  }
  return [...bases];
}

function postDownloadDiagnosticToServers(bases, body) {
  const raw = JSON.stringify(body);
  for (const base of bases.slice(0, 4)) {
    try {
      const url = new URL("/api/client-diagnostics", base);
      const client = url.protocol === "https:" ? https : http;
      const req = client.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(raw)
          }
        },
        (res) => {
          res.resume();
        }
      );
      req.on("error", () => {});
      req.setTimeout(4000, () => {
        req.destroy();
      });
      req.end(raw);
    } catch {
      // ignored
    }
  }
}

/**
 * İndirme klasörünü belirler ve yazılabilirliğini doğrular.
 * `Documents\kobiChat` önceliklidir; yazılamıyorsa (OneDrive yönlendirmesi,
 * eksik profil, izin sorunu vb.) `Downloads\kobiChat` ve `userData` sırasıyla denenir.
 */
function resolveWritableDownloadDir() {
  const candidates = [
    path.join(app.getPath("documents"), "kobiChat"),
    path.join(app.getPath("downloads"), "kobiChat"),
    path.join(app.getPath("userData"), "kobiChat-downloads")
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.kobichat-write-test-${Date.now()}`);
      fs.writeFileSync(probe, "ok", "utf8");
      fs.unlinkSync(probe);
      return dir;
    } catch {
      // writable değil, sonraki aday
    }
  }
  const fallback = candidates[0];
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Ek dosya indirmesi: Node `http`/`https` yerine Electron `net` kullanılır.
 * Chromium ile aynı ağ yığını (sistem vekili, kurumsal kök sertifikalar, vb.)
 * kullanıldığı için bazı kullanıcılarda sohbet içi `<img src=...>` çalışırken
 * ana işlem indirmesinin başarısız olması (proxy / TLS farkı) giderilir.
 */
function downloadFileToPath(rawUrl, savePath, onProgress) {
  return new Promise((resolve, reject) => {
    const urlStr = String(rawUrl || "").trim();
    let req;
    try {
      req = net.request({
        method: "GET",
        url: urlStr,
        redirect: "follow"
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    req.on("response", (response) => {
      const status = Number(response.statusCode || 0);
      if (status < 200 || status >= 300) {
        try {
          response.resume();
        } catch {
          // ignored
        }
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const total = parseInt(response.headers["content-length"] || "0", 10) || 0;
      let received = 0;
      const out = fs.createWriteStream(savePath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          out.destroy();
        } catch {
          // ignored
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      out.on("error", fail);
      response.on("error", fail);
      out.on("finish", () => {
        if (settled) return;
        settled = true;
        resolve(true);
      });
      if (typeof onProgress === "function" && total > 0) {
        response.on("data", (chunk) => {
          received += chunk.length;
          try { onProgress(received, total); } catch { /* ignored */ }
        });
      }
      response.pipe(out);
    });
    req.on("error", reject);
    req.end();
  });
}

async function downloadAndHandleAttachment(payload, onProgress) {
  /**
   * Aday URL listesi:
   *  - Yeni protokol: `payload.urls = string[]` — sırayla dene, ilk başarılıda dur.
   *  - Eski protokol: `payload.url = string` — tek URL deniyor (geri uyumluluk).
   *
   * 404 alınmasına rağmen başka bir aday URL başarılı oluyorsa indirme
   * başarılı sayılır. Tüm adaylar 404 ile döndüyse `missing_on_server`,
   * herhangi bir ağ hatası olduysa `download_failed` döndürürüz.
   *
   * `payload.fileSize`: sunucudaki bayt boyutu; aynı isimli yerel dosya bu boyutta
   * ise yeniden indirilmez (`reused: true`). İndirme bitince klasör açılmaz;
   * renderer "Aç" ile `kobichat:open-downloaded` çağırır.
   */
  const urlsList = Array.isArray(payload?.urls)
    ? payload.urls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  const singleUrl = String(payload?.url || "").trim();
  const seenUrl = new Set();
  const candidates = [];
  for (const u of [singleUrl, ...urlsList]) {
    if (!u || seenUrl.has(u)) continue;
    seenUrl.add(u);
    candidates.push(u);
  }
  if (candidates.length === 0) return { ok: false, reason: "invalid_url" };

  const filename = ensureFileExtension(payload?.filename, payload?.mime);
  const rawSize = payload?.fileSize;
  const expectedSize = typeof rawSize === "number" && Number.isFinite(rawSize) ? rawSize : null;
  const targetDir = resolveWritableDownloadDir();
  const { savePath, reused: alreadyHave } = resolveChatDownloadSavePath(targetDir, filename, expectedSize);
  if (alreadyHave) {
    return { ok: true, path: savePath, reused: true };
  }
  const attempts = [];
  let allMissing = true;
  for (const u of candidates) {
    try {
      await downloadFileToPath(u, savePath, typeof onProgress === "function"
        ? (received, total) => onProgress(payload?.messageId ?? null, received, total)
        : undefined);
      broadcastPlaySound("downloadComplete");
      return { ok: true, path: savePath, reused: false };
    } catch (e) {
      const msg = String(e?.message || e || "unknown");
      attempts.push({ url: u, error: msg });
      if (!msg.includes("HTTP 404")) {
        allMissing = false;
      }
      try {
        if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
      } catch {
        // ignored
      }
    }
  }
  const reason = allMissing ? "missing_on_server" : "download_failed";
  const ref = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const diagnostic = {
    ref,
    reason,
    filename,
    fileRel: String(payload?.fileRel || "").trim(),
    messageId: payload?.messageId ?? null,
    fileSize: expectedSize,
    attempts
  };
  writeDownloadDiagnostic({ event: "download_failed", ...diagnostic });
  postDownloadDiagnosticToServers(serverBasesFromDownloadCandidates(candidates), {
    type: "download_failed",
    ...diagnostic
  });
  return {
    ok: false,
    reason,
    ref,
    logPath: downloadDiagnosticLogPath(),
    attempts
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 275,
    height: 520,
    minWidth: 275,
    minHeight: 520,
    useContentSize: true,
    resizable: true,
    maximizable: true,
    frame: true,
    show: false,
    skipTaskbar: false,
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * Roster gizliyken (X ile kapat → hide) Chromium zamanlayıcılarını ağır kestiği için
       * Socket.IO ping'leri kaçabiliyor; sunucu oturumu düşüyor ve kişi sürekli çevrimdışı görünüyor.
       * Sohbet penceresinden mesaj bu süreçte kısa süreli “online” yanılsaması yaratabilir.
       */
      backgroundThrottling: false
    }
  });

  removeDefaultWindowMenu(mainWindow);
  attachDownloadReveal(mainWindow.webContents.session);

  mainWindow.once("ready-to-show", () => {
    positionMainWindowBottomRight();
    mainWindow.show();
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://localhost:5173/?mode=roster");
    openDevToolsWhenReady(mainWindow);
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

  mainWindow.on("focus", () => {
    try { mainWindow.flashFrame(false); } catch { /* ignored */ }
  });

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

/**
 * Sağ tık menüsü ve klavye kısayolu etiketleri (uygulama diline göre).
 * Kopyala/Kes/Yapıştır için rol kullanılır ancak etiketleri Türkçe görünür.
 */
const EDIT_MENU_LABELS = {
  tr: { copy: "Kopyala", cut: "Kes", paste: "Yapıştır", selectAll: "Tümünü Seç", copyLink: "Bağlantıyı Kopyala" },
  en: { copy: "Copy", cut: "Cut", paste: "Paste", selectAll: "Select All", copyLink: "Copy Link" },
  de: { copy: "Kopieren", cut: "Ausschneiden", paste: "Einfügen", selectAll: "Alles auswählen", copyLink: "Link kopieren" },
  fr: { copy: "Copier", cut: "Couper", paste: "Coller", selectAll: "Tout sélectionner", copyLink: "Copier le lien" },
  es: { copy: "Copiar", cut: "Cortar", paste: "Pegar", selectAll: "Seleccionar todo", copyLink: "Copiar enlace" }
};

function editMenuLabels() {
  let lang = "";
  try {
    lang = String(settingsStore?.getAll?.().language || "").slice(0, 2).toLowerCase();
  } catch {
    /* settingsStore henüz hazır değilse Türkçe varsayılan */
  }
  return EDIT_MENU_LABELS[lang] || EDIT_MENU_LABELS.tr;
}

/**
 * Menu.setApplicationMenu(null) kullanıldığında Windows/Linux'ta standart
 * düzenleme kısayolları (Ctrl+C/V/X/A/Z/Y) ve sağ tık kopyalama devre dışı
 * kalır. Bu fonksiyon her webContents için bu davranışları geri kazandırır.
 */
function setupWebContentsEditing(contents) {
  // 1) Klavye kısayolları
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (!mod || input.alt) return;
    switch (String(input.key || "").toLowerCase()) {
      case "c":
        contents.copy();
        event.preventDefault();
        break;
      case "x":
        contents.cut();
        event.preventDefault();
        break;
      case "v":
        contents.paste();
        event.preventDefault();
        break;
      case "a":
        contents.selectAll();
        event.preventDefault();
        break;
      case "z":
        if (input.shift) contents.redo();
        else contents.undo();
        event.preventDefault();
        break;
      case "y":
        contents.redo();
        event.preventDefault();
        break;
      default:
        break;
    }
  });

  // 2) Sağ tık menüsü (seçili metni / bağlantıyı kopyala)
  contents.on("context-menu", (_event, params) => {
    const L = editMenuLabels();
    const items = [];
    const hasSelection = Boolean(params.selectionText && params.selectionText.trim());
    if (params.linkURL) {
      items.push({ label: L.copyLink, click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: "separator" });
    }
    if (params.isEditable) {
      items.push({ role: "cut", label: L.cut, enabled: params.editFlags.canCut });
      items.push({ role: "copy", label: L.copy, enabled: params.editFlags.canCopy });
      items.push({ role: "paste", label: L.paste, enabled: params.editFlags.canPaste });
      items.push({ type: "separator" });
      items.push({ role: "selectAll", label: L.selectAll });
    } else if (hasSelection) {
      items.push({ role: "copy", label: L.copy });
      items.push({ type: "separator" });
      items.push({ role: "selectAll", label: L.selectAll });
    }
    if (!items.length) return;
    const win = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(items).popup(win ? { window: win } : undefined);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showRosterWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // Menü kaldırıldığından kopyalama kısayolları + sağ tık menüsünü
    // her pencere (webContents) için elle geri kazandır.
    app.on("web-contents-created", (_evt, contents) => {
      setupWebContentsEditing(contents);
    });
    if (process.platform === "win32") {
      app.setAppUserModelId("com.hidroteknik.kobichat");
    }
    settingsStore = await openSettingsStore(app.getPath("userData"));
    normalizeSettingsForVersion(app.getVersion());
    const st = settingsStore.getAll();
    /**
     * MSIX / Microsoft Store paketinde otomatik başlatma manifest'teki
     * `windows.startupTask` uzantısıyla yapılır (package.json →
     * build.appx.addAutoLaunchExtension). Registry sanallaştırması yüzünden
     * `setLoginItemSettings` orada HKCU\Run'a gerçekten yazamaz; yazsa bile
     * paket hive'ına hapsolur ve oturum açılışında çalışmaz. Bu yüzden Store
     * sürümünde bu yolu hiç denemiyoruz. `process.windowsStore`, uygulama
     * AppX/MSIX olarak çalışıyorsa true olur.
     */
    const isMsixPackaged = process.platform === "win32" && Boolean(process.windowsStore);
    if (app.isPackaged && !isMsixPackaged && (process.platform === "win32" || process.platform === "darwin")) {
      /**
       * NSIS (.exe) kurulumları: otomatik başlatmayı HER açılışta doğrula
       * (eskiden yalnızca ilk açılışta bir kez kuruluyordu). Windows güncelleme
       * sonrası execPath değişince veya Run anahtarı temizlenince eski
       * davranışta bir daha asla geri gelmiyordu; bazı bilgisayarlarda
       * "başlangıçta açılmıyor" sorununun nedeni buydu. Kapalıysa yeniden aç —
       * kendi kendini onarır. Kullanıcı Görev Yöneticisi'nden bilinçli
       * kapattıysa Windows StartupApproved kaydı geçerli kalır; bu çağrı onu
       * ezmez.
       */
      try {
        const li = app.getLoginItemSettings();
        if (!li.openAtLogin) {
          app.setLoginItemSettings({
            openAtLogin: true,
            path: process.execPath,
            enabled: true
          });
        }
        if (!st.loginItemSetupDone) settingsStore.save({ loginItemSetupDone: true });
      } catch (e) {
        console.error("Oturum açılışında başlatma ayarlanamadı:", e);
      }
    }
    await applyServerMode();
    createWindow();
    createTray();
    startSystemIdleWatcher();

    applyGlobalShortcut();

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

    ipcMain.on("kobichat:send-to-roster", (_event, payload) => {
      const send = (w) => {
        try {
          w.webContents.send("kobichat:bridge-from-chat", payload);
        } catch {
          // ignored
        }
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        send(mainWindow);
        return;
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
          const url = String(w.webContents.getURL() || "");
          if (url.includes("mode=roster") || url.includes("mode%3Droster")) {
            send(w);
            return;
          }
        } catch {
          // ignored
        }
      }
    });

    ipcMain.handle("kobichat:config", () => buildConfig());
    ipcMain.handle("kobichat:app-version", () => app.getVersion());
    ipcMain.handle("kobichat:settings:get", () => settingsStore.getAll());
    ipcMain.handle("kobichat:settings:save", async (_e, partial) => {
      const before = settingsStore.getAll();
      settingsStore.save(partial || {});
      const after = settingsStore.getAll();
      const serverRuntimeChanged =
        String(before.serverMode || "") !== String(after.serverMode || "") ||
        Number(before.localPort || 0) !== Number(after.localPort || 0);
      if (serverRuntimeChanged) {
        await applyServerMode();
      }
      if (String(before.globalShortcut || "") !== String(after.globalShortcut || "")) {
        applyGlobalShortcut();
      }
      refreshTrayMenu();
      broadcastConfig();
      return settingsStore.getAll();
    });

    ipcMain.handle("kobichat:discover", () => []);

    ipcMain.handle("kobichat:clear-attention", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) {
        stopTaskbarPulse(w);
      }
    });

    ipcMain.handle("kobichat:flash-self", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed() && !w.isFocused()) {
        try { w.flashFrame(true); } catch { /* ignored */ }
      }
    });

    /**
     * Eski API uyum katmanı: önceki sürümlerde bu kanal `shell.beep()` çalardı.
     * Renderer artık tüm sesleri kendi modülünden (src/sounds.js) çalıyor;
     * burada uyumluluk için no-op tutuyoruz, böylece eski preload bağlamlarında
     * çağrılırsa hata fırlatmaz.
     */
    ipcMain.handle("kobichat:play-notification-sound", () => {
      return true;
    });

    ipcMain.handle("kobichat:open-chat", (_e, payload) => {
      if (!payload || typeof payload !== "object") return { ok: false };
      return openChatWindowFromPayload(payload);
    });

    ipcMain.handle("kobichat:flash-main-window", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isFocused()) return;
      try { mainWindow.flashFrame(true); } catch { /* ignored */ }
    });

    ipcMain.handle("kobichat:attention-shake-self", (event) => {
      try {
        const w = BrowserWindow.fromWebContents(event.sender);
        if (!w || w.isDestroyed()) return false;
        runAttentionShakeOnWindow(w);
      } catch (e) {
        console.error("attention-shake-self:", e);
      }
      return true;
    });

    ipcMain.handle("kobichat:shake-chat-window", (_event, peerClientUuid) => {
      const key = peerWindowKey(peerClientUuid);
      if (!key) return false;
      const win = chatWindowsByClientUuid.get(key);
      if (!win || win.isDestroyed()) return false;
      return applyIncomingPokeAttentionToChatWindow(win);
    });

    ipcMain.handle("kobichat:open-info-window", (_e, options) => openInfoWindow(options));
    ipcMain.handle("kobichat:open-settings-window", () => openSettingsWindow());
    ipcMain.handle("kobichat:open-quick-messages", () => openQuickMessagesWindow());
    ipcMain.handle("kobichat:set-main-window-mode", (_e, mode) => setMainWindowMode(mode));
    ipcMain.handle("kobichat:show-shock", (_e, payload) => {
      showShockWindow(payload?.title, payload?.message, payload || {});
    });
    ipcMain.handle("kobichat:show-notify", (_e, payload) => {
      showNotifyWindow(payload?.title, payload?.message, payload || {});
    });
    /** Pano "yerel program" kısayolu: yol her bilgisayarda kullanıcının kendi seçimi. */
    ipcMain.handle("kobichat:pick-local-app", async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender) || undefined;
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters:
          process.platform === "win32"
            ? [
                { name: "Programs", extensions: ["exe", "lnk", "bat", "cmd", "url"] },
                { name: "*", extensions: ["*"] }
              ]
            : [{ name: "*", extensions: ["*"] }]
      });
      if (r.canceled || !r.filePaths?.[0]) return "";
      return r.filePaths[0];
    });
    ipcMain.handle("kobichat:open-local-app", async (_e, rawPath) => {
      const p = String(rawPath || "").trim();
      if (!p || !path.isAbsolute(p) || !fs.existsSync(p)) return false;
      const err = await shell.openPath(p);
      return !err;
    });
    ipcMain.handle("kobichat:open-external", (_e, rawUrl) => {
      const url = String(rawUrl || "").trim();
      if (!/^(mailto:|https?:\/\/)/i.test(url)) return false;
      void shell.openExternal(url);
      return true;
    });
    ipcMain.handle("kobichat:check-updates-now", () => openMicrosoftStoreForUpdates());
    ipcMain.handle("kobichat:download-and-handle", async (event, payload) => {
      try {
        const sender = event.sender;
        const onProgress = (messageId, received, total) => {
          if (sender && !sender.isDestroyed()) {
            try { sender.send("kobichat:download-progress", { messageId, received, total }); } catch { /* ignored */ }
          }
        };
        return await downloadAndHandleAttachment(payload, onProgress);
      } catch (e) {
        console.error("Dosya indirme/açma hatası:", e);
        return { ok: false, reason: "download_failed" };
      }
    });

    ipcMain.handle("kobichat:open-downloaded", async (_e, payload) => {
      const raw = String(payload?.path || "").trim();
      if (!raw) return { ok: false, reason: "invalid_path" };
      try {
        const resolved = path.resolve(raw);
        if (!fs.existsSync(resolved)) return { ok: false, reason: "not_found" };
        const allowedDirs = [
          path.join(app.getPath("documents"), "kobiChat"),
          path.join(app.getPath("downloads"), "kobiChat"),
          path.join(app.getPath("userData"), "kobiChat-downloads")
        ];
        const allowed = allowedDirs.some((dir) => isPathUnderDirectory(resolved, dir));
        if (!allowed) return { ok: false, reason: "forbidden" };
        const errMsg = await shell.openPath(resolved);
        if (errMsg) {
          // Açılamadıysa (ilişkili program yok vb.) dosyayı klasörde göster
          // ki kullanıcı manuel açabilsin.
          try {
            shell.showItemInFolder(resolved);
          } catch {
            // ignored
          }
        }
        return { ok: !errMsg, err: errMsg || undefined };
      } catch (e) {
        console.error("open-downloaded:", e);
        return { ok: false, reason: "open_failed" };
      }
    });

    ipcMain.handle("kobichat:refresh-tray-menu", () => {
      refreshTrayMenu();
      return true;
    });

    ipcMain.handle("kobichat:set-chat-window-title", (event, title) => {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w || w.isDestroyed()) return false;
      try {
        const s = typeof title === "string" ? title.trim() : "";
        w.setTitle(s || "KobiChat");
        return true;
      } catch {
        return false;
      }
    });

    /**
     * Sohbet penceresinin görev çubuğu / pencere simgesini karşı tarafın
     * profil resmiyle değiştirir; taskbar'da hangi sohbetin kim olduğu tek
     * bakışta anlaşılsın diye. Renderer PNG data URL gönderir: profil
     * resimleri webp saklanıyor ve nativeImage webp'i her platformda
     * çözemiyor, dönüştürme renderer'da canvas ile yapılıyor.
     * Boş/geçersiz değerde varsayılan uygulama simgesine dönülür.
     */
    ipcMain.handle("kobichat:set-chat-window-icon", (event, pngDataUrl) => {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w || w.isDestroyed()) return false;
      try {
        const s = typeof pngDataUrl === "string" ? pngDataUrl.trim() : "";
        if (!s.startsWith("data:image/png;base64,")) {
          const p = windowIconPath();
          if (p) w.setIcon(p);
          return true;
        }
        const img = nativeImage.createFromDataURL(s);
        if (img.isEmpty()) return false;
        w.setIcon(img);
        return true;
      } catch {
        return false;
      }
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else {
        showRosterWindow();
      }
    });
  });

  app.on("will-quit", () => {
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
