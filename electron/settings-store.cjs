const path = require("path");
const fs = require("fs");
const os = require("os");
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
  loginItemSetupDone: false
};

async function openSettingsStore(userDataPath) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();

  const dir = userDataPath;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "client-settings.db");

  const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

  let db = null;
  if (fs.existsSync(dbPath)) {
    try {
      const buf = fs.readFileSync(dbPath);
      const candidate = new SQL.Database(buf);
      // Bozuk/yarım yazılmış dosyalar bazen yapıcıda değil ilk sorguda patlar.
      candidate.exec(CREATE_TABLE_SQL);
      db = candidate;
    } catch (e) {
      console.error(
        "client-settings.db okunamadı/bozuk; yedeklenip sıfırdan oluşturuluyor:",
        e?.message || e
      );
      try {
        fs.renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
      } catch {
        // yedeklenemezse de devam et; aşağıda taze DB ile açılır
      }
      db = null;
    }
  }
  if (!db) {
    db = new SQL.Database();
    db.exec(CREATE_TABLE_SQL);
  }

  /**
   * Atomik yazma: önce geçici dosyaya yaz, sonra rename ile yerine koy.
   * Yazma sırasında çökme/elektrik kesintisi olsa bile asıl dosya ya eski
   * (tutarlı) ya da yeni (tam) haldedir; yarım/bozuk kalmaz.
   */
  const saveDb = () => {
    const data = db.export();
    const tmpPath = `${dbPath}.tmp`;
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, dbPath);
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

  /** Yalnızca bellekteki DB'ye yazar; diske flush etmez (toplu yazımlar için). */
  function setValue(key, value) {
    /** Object/array gibi yapısal değerleri JSON olarak yaz; aksi halde primitive stringify. */
    const serialized =
      value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, serialized]);
  }

  function set(key, value) {
    setValue(key, value);
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
    let dirty = false;
    for (const k of Object.keys(DEFAULTS)) {
      const v = get(k);
      if (v !== undefined) out[k] = coerce(k, v);
    }
    if (!out.displayName || !String(out.displayName).trim()) {
      const hn = String(os.hostname() || "").trim() || "Kullanıcı";
      out.displayName = hn.slice(0, 21);
      setValue("displayName", out.displayName);
      dirty = true;
    }
    if (!out.clientUuid || !String(out.clientUuid).trim()) {
      out.clientUuid = crypto.randomUUID().toLowerCase();
      setValue("clientUuid", out.clientUuid);
      dirty = true;
    } else {
      const lo = String(out.clientUuid).trim().toLowerCase();
      if (lo !== String(out.clientUuid).trim()) {
        out.clientUuid = lo;
        setValue("clientUuid", lo);
        dirty = true;
      }
    }
    if (!out.nodeId || !String(out.nodeId).trim()) {
      out.nodeId = crypto.randomUUID();
      setValue("nodeId", out.nodeId);
      dirty = true;
    }
    const targetClusterId = CLUSTER_ID_DEFAULT;
    const targetSecret = CLUSTER_SECRET_DEFAULT;
    if (String(out.clusterId || "") !== targetClusterId) {
      out.clusterId = targetClusterId;
      setValue("clusterId", out.clusterId);
      dirty = true;
    }
    if (String(out.sharedSecret || "") !== targetSecret) {
      out.sharedSecret = targetSecret;
      setValue("sharedSecret", out.sharedSecret);
      dirty = true;
    }
    // Eskiden her eksik alan ayrı bir tam-DB diske yazımı tetikliyordu;
    // artık değişiklikleri biriktirip tek seferde flush ediyoruz.
    if (dirty) saveDb();
    return out;
  }

  function save(partial) {
    const cur = getAll();
    const next = { ...cur, ...partial };
    if (next.serverMode !== "local" && next.serverMode !== "remote") {
      next.serverMode = DEFAULTS.serverMode;
    }
    // Tüm anahtarları belleğe yaz, sonra TEK diske flush. Eskiden her anahtar
    // ayrı bir tam-DB yazımı yapıyordu (~18+ yazma / save çağrısı).
    for (const k of Object.keys(DEFAULTS)) {
      if (next[k] !== undefined) setValue(k, next[k]);
    }
    saveDb();
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
