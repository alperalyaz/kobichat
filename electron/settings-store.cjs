const path = require("path");
const fs = require("fs");
const os = require("os");
const CLUSTER_ID_DEFAULT = "kobichat-lan-v2";
const CLUSTER_SECRET_DEFAULT = "kobichat-cluster-v2-shared";

const DEFAULTS = {
  displayName: "",
  clientUuid: "",
  serverMode: "remote",
  remoteHost: "",
  remotePort: 3847,
  localPort: 3847,
  /** uygun | mesgul | disarida */
  presenceStatus: "uygun",
  /** tr | en | de | fr | es — boş: istemci tarayıcı dilinden türetir */
  language: "",
  /** Sohbet bildirim sesi açık/kapalı */
  notificationSound: true,
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
  loginItemSetupDone: false
};

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
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(value)]);
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
    if (!out.clientUuid || !String(out.clientUuid).trim()) {
      out.clientUuid = crypto.randomUUID();
      set("clientUuid", out.clientUuid);
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
