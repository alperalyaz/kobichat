const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const REG_KEY = "HKCU\\Software\\KobiChat";

function readRegistryUuid() {
  if (process.platform !== "win32") return null;
  try {
    const out = execSync(`reg query "${REG_KEY}" /v ClientUUID`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/ClientUUID\s+REG_SZ\s+([0-9a-f-]{36})/i);
    return m ? m[1].trim().toLowerCase() : null;
  } catch { return null; }
}

function writeRegistryUuid(uuid) {
  if (process.platform !== "win32") return;
  try {
    execSync(`reg add "${REG_KEY}" /v ClientUUID /t REG_SZ /d "${uuid}" /f`, { stdio: "ignore" });
  } catch {}
}
const CLUSTER_ID_DEFAULT = "kobichat-lan-v2";
const CLUSTER_SECRET_DEFAULT = "kobichat-cluster-v2-shared";

const DEFAULTS = {
  displayName: "",
  clientUuid: "",
  serverMode: "local",
  remoteHost: "",
  remotePort: 3847,
  localPort: 3847,
  /** uygun | mesgul | disarida */
  presenceStatus: "uygun",
  /** tr | en | de | fr | es — boş: istemci tarayıcı dilinden türetir */
  language: "",
  /** Sohbet bildirim sesi ana anahtarı (master switch). */
  notificationSound: true,
  /**
   * Kategori bazlı ses anahtarları.
   * - message: yeni mesaj sesi (gelen + giden)
   * - file: dosya sesleri (gelen/giden/indirme tamam)
   * - system: bağlantı, hata, güncelleme sesleri
   * - presence: birisi online/offline oldu sesleri (varsayılan kapalı — gürültücü olmasın)
   */
  soundCategories: { message: true, file: true, system: true, presence: false },
  /** Tüm seslere uygulanan global ses seviyesi (0..1). */
  soundVolume: 1,
  /** Kullanıcının profil görseli (data URL) */
  profileImage: "",
  /** Otomatik lider seçimi ve sunucu devri */
  clusterMode: true,
  /** Aynı LAN kümesi için ortak kimlik */
  clusterId: CLUSTER_ID_DEFAULT,
  /** Bu düğümün kalıcı kimliği */
  nodeId: "",
  /** Discovery/election imza anahtarı (LAN içi paylaşımlı gizli anahtar) */
  sharedSecret: "",
  /** Hangi uygulama sürümünde son kez normalize edildi */
  lastRunVersion: "",
  /** Bir kez true yapıldıktan sonra oturum açılışında başlatmayı tekrar zorlamaz */
  loginItemSetupDone: false,
  /**
   * Kişi listesini öne getiren genel (global) kısayol — Electron accelerator
   * biçiminde. Bazı uygulamalarla çakışabildiği için kullanıcı değiştirebilir.
   */
  globalShortcut: "CommandOrControl+Shift+K"
};

/** Electron accelerator doğrulaması: en az bir değiştirici + bir ana tuş. */
const ACCEL_MODIFIERS = new Set(["CommandOrControl", "Command", "Control", "Ctrl", "Alt", "Option", "AltGr", "Shift", "Super", "Meta"]);

function isValidAccelerator(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 64) return false;
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.length === 0) return false;
  if (!mods.every((m) => ACCEL_MODIFIERS.has(m))) return false;
  /** Yalnızca Shift yeterli değil: normal yazmayı ele geçirir. */
  if (mods.every((m) => m === "Shift")) return false;
  if (ACCEL_MODIFIERS.has(key)) return false;
  return /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Return|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|[`~!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|])$/.test(key);
}

async function openSettingsStore(userDataPath) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();

  const dir = userDataPath;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "client-settings.db");

  let db;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const saveDb = () => {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  };

  function get(key) {
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    stmt.bind([key]);
    let v;
    if (stmt.step()) {
      v = stmt.getAsObject().value;
    }
    stmt.free();
    return v;
  }

  function set(key, value) {
    /** Object/array gibi yapısal değerleri JSON olarak yaz; aksi halde primitive stringify. */
    const serialized =
      value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, serialized]);
    saveDb();
  }

  function coerce(k, raw) {
    if (k === "remotePort" || k === "localPort") {
      const n = parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULTS[k];
    }
    if (k === "serverMode") {
      return raw === "remote" ? "remote" : "local";
    }
    if (k === "loginItemSetupDone") {
      if (raw === "true" || raw === "1" || raw === true) return true;
      return false;
    }
    if (k === "clusterMode") {
      if (raw === "false" || raw === "0" || raw === false) return false;
      return true;
    }
    if (k === "notificationSound") {
      if (raw === "false" || raw === "0" || raw === false) return false;
      return true;
    }
    if (k === "soundCategories") {
      let parsed = raw;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
      }
      const def = DEFAULTS.soundCategories;
      if (!parsed || typeof parsed !== "object") return { ...def };
      return {
        message: parsed.message !== false,
        file: parsed.file !== false,
        system: parsed.system !== false,
        presence: parsed.presence === true
      };
    }
    if (k === "soundVolume") {
      const n = parseFloat(String(raw));
      if (!Number.isFinite(n)) return DEFAULTS.soundVolume;
      return Math.max(0, Math.min(1, n));
    }
    if (k === "presenceStatus") {
      const s = String(raw || "").toLowerCase();
      if (s === "mesgul" || s === "disarida" || s === "uygun") return s;
      return DEFAULTS.presenceStatus;
    }
    if (k === "displayName") {
      return String(raw ?? "")
        .trim()
        .slice(0, 21);
    }
    if (k === "profileImage") {
      const v = String(raw ?? "").trim();
      if (!v) return "";
      if (!v.startsWith("data:image/")) return "";
      return v.slice(0, 400000);
    }
    if (k === "language") {
      const v = String(raw || "")
        .trim()
        .toLowerCase();
      if (v === "tr" || v === "en" || v === "de" || v === "fr" || v === "es") return v;
      return "";
    }
    if (k === "clusterId") {
      return String(raw ?? "")
        .trim()
        .slice(0, 80);
    }
    if (k === "nodeId") {
      return String(raw ?? "")
        .trim()
        .slice(0, 120);
    }
    if (k === "sharedSecret") {
      return String(raw ?? "")
        .trim()
        .slice(0, 200);
    }
    if (k === "globalShortcut") {
      const v = String(raw ?? "").trim();
      return isValidAccelerator(v) ? v : DEFAULTS.globalShortcut;
    }
    if (k === "lastRunVersion") {
      return String(raw ?? "")
        .trim()
        .slice(0, 32);
    }
    return String(raw);
  }

  function getAll() {
    const out = { ...DEFAULTS };
    const crypto = require("crypto");
    for (const k of Object.keys(DEFAULTS)) {
      const v = get(k);
      if (v !== undefined) out[k] = coerce(k, v);
    }
    if (!out.displayName || !String(out.displayName).trim()) {
      const hn = String(os.hostname() || "").trim() || "Kullanıcı";
      out.displayName = hn.slice(0, 21);
      set("displayName", out.displayName);
    }
    const dbUuid = out.clientUuid ? String(out.clientUuid).trim().toLowerCase() : null;
    const regUuid = readRegistryUuid();
    if (dbUuid) {
      out.clientUuid = dbUuid;
      // Registry'ye de yaz (eksikse)
      if (!regUuid) writeRegistryUuid(dbUuid);
    } else if (regUuid) {
      // AppData silindi ama Registry'de UUID var — aynı kimliği geri yükle
      out.clientUuid = regUuid;
      set("clientUuid", regUuid);
    } else {
      // İlk kurulum — yeni UUID üret, her iki yere de kaydet
      out.clientUuid = crypto.randomUUID().toLowerCase();
      set("clientUuid", out.clientUuid);
      writeRegistryUuid(out.clientUuid);
    }
    if (!out.nodeId || !String(out.nodeId).trim()) {
      out.nodeId = crypto.randomUUID();
      set("nodeId", out.nodeId);
    }
    const targetClusterId = CLUSTER_ID_DEFAULT;
    const targetSecret = CLUSTER_SECRET_DEFAULT;
    if (String(out.clusterId || "") !== targetClusterId) {
      out.clusterId = targetClusterId;
      set("clusterId", out.clusterId);
    }
    if (String(out.sharedSecret || "") !== targetSecret) {
      out.sharedSecret = targetSecret;
      set("sharedSecret", out.sharedSecret);
    }
    return out;
  }

  function save(partial) {
    const cur = getAll();
    const next = { ...cur, ...partial };
    if (next.serverMode !== "local" && next.serverMode !== "remote") {
      next.serverMode = DEFAULTS.serverMode;
    }
    for (const k of Object.keys(DEFAULTS)) {
      if (next[k] !== undefined) set(k, next[k]);
    }
    return getAll();
  }

  return {
    getAll,
    save,
    close: () => {
      try {
        saveDb();
        db.close();
      } catch {
        // ignored
      }
    }
  };
}

module.exports = { openSettingsStore, DEFAULTS };
