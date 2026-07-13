const fs = require("fs");
const path = require("path");
const http = require("http");
const { Transform } = require("stream");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Server } = require("socket.io");
const { randomUUID, createHash } = require("crypto");

const DEFAULT_PORT = 3847;
/**
 * DM geçmişi: sohbet açılışında yüklenecek en son N mesaj (kronolojik sırada döner).
 * ORDER BY id DESC + reverse — en eski N kayıt değil, en güncel pencere.
 */
const HISTORY_LIMIT = Math.max(100, Number(process.env.KOBICHAT_HISTORY_LIMIT) || 500);
const MESSAGE_RETENTION_DAYS = Math.max(14, Number(process.env.KOBICHAT_MESSAGE_RETENTION_DAYS) || 90);
const MAX_TEXT_MESSAGES = Math.max(5000, Number(process.env.KOBICHAT_MAX_TEXT_MESSAGES) || 50000);
/**
 * Dosya eklerinin diskte saklanma süresi (gün). 1’in altına düşmez.
 * Eski sürüm yalnızca o günkü dosyaları tutuyordu; offline kullanıcılar
 * 1 gün sonra dosya indiremiyor görünüyordu. Varsayılanı 7 güne çıkardık,
 * çevre değişkeniyle artırılabilir.
 */
const FILE_RETENTION_DAYS = Math.max(1, Number(process.env.KOBICHAT_FILE_RETENTION_DAYS) || 7);
/** DM metin gövdesi — karakter (UTF-16 code unit, JS `String.length` ile uyumlu). */
const MAX_DM_TEXT_CHARS = Math.max(256, Number(process.env.KOBICHAT_MAX_DM_TEXT_CHARS) || 8000);
/** Bir alıcıya `delivery_state=queued` iken düşecek DM (metin+dosya) üst sınırı. */
const MAX_QUEUED_PER_RECIPIENT = Math.max(100, Number(process.env.KOBICHAT_MAX_QUEUED_PER_RECIPIENT) || 1000);
/** Sliding window: her sokette en fazla bu kadar giden DM (chat + dosya yükleme) sayılır. */
const DM_SEND_BURST = Math.max(5, Number(process.env.KOBICHAT_DM_SEND_BURST) || 30);
const DM_SEND_WINDOW_MS = Math.max(5000, Number(process.env.KOBICHAT_DM_SEND_WINDOW_MS) || 60_000);
/**
 * Upload bant genişliği sınırı (byte/sn). Varsayılan 5 MB/s = 40 Mbps.
 * Router belleğini doldurmamak için TCP akış kontrolüyle göndericiyi yavaşlatır.
 * KOBICHAT_UPLOAD_RATE_BYTES_PER_SEC=0 ile devre dışı bırakılabilir.
 */
const UPLOAD_RATE_BYTES_PER_SEC = (() => {
  const env = process.env.KOBICHAT_UPLOAD_RATE_BYTES_PER_SEC;
  if (env === "0") return 0;
  return Math.max(256 * 1024, Number(env) || 5 * 1024 * 1024);
})();
/**
 * Phantom delivery koruması: Alıcı socket'i bulduğumuzda mesajı `sent`
 * kaydederiz ve canlı emit yaparız; ancak alıcı tam o anda ağ kesintisi
 * yaşıyorsa (TCP ping timeout ~45 sn boyunca presence haritasında “canlı”
 * görünür) emit ölü sokete düşer. Bu sürenin sonunda hâlâ `delivered_at`
 * yoksa ve alıcı artık çevrimdışıysa mesajı tekrar `queued`'a düşürürüz;
 * böylece alıcı bağlandığında flush ile yeniden iletilir.
 */
const ACK_TIMEOUT_MS = Math.max(15_000, Number(process.env.KOBICHAT_ACK_TIMEOUT_MS) || 60_000);
const ACK_RECONCILE_INTERVAL_MS = Math.max(15_000, Number(process.env.KOBICHAT_ACK_RECONCILE_INTERVAL_MS) || 30_000);
/** Aynı gönderen → aynı alıcı için titreşim (poke) en az bu kadar arayla (ms). */
const POKE_MIN_INTERVAL_MS = Math.max(30_000, Number(process.env.KOBICHAT_POKE_MIN_INTERVAL_MS) || 120_000);

const PROFILE_IMAGE_DB_MAX = 120000;
const PROFILE_IMAGE_SOCKET_MAX = 90000;
const OFFLINE_ROSTER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function sanitizeProfileImage(raw, maxLen = PROFILE_IMAGE_SOCKET_MAX) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text.startsWith("data:image/")) return "";
  return text.slice(0, maxLen);
}

/** PRIMARY KEY ve Set eşlemesi için tek biçim (UUID çakışmasını önler, roster çift satırını düzeltir). */
function normalizeClientUuid(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

function migratePresenceCacheUuidsToLowerCase(db) {
  try {
    const stmt = db.prepare(
      `SELECT rowid, client_uuid, display_name, profile_image, last_status, last_seen_at, updated_at FROM presence_cache`
    );
    const groups = new Map();
    while (stmt.step()) {
      const r = stmt.getAsObject();
      const lo = normalizeClientUuid(r.client_uuid);
      if (!lo) continue;
      if (!groups.has(lo)) groups.set(lo, []);
      groups.get(lo).push(r);
    }
    stmt.free();
    for (const [, rows] of groups) {
      if (rows.length <= 1) {
        const r = rows[0];
        const lo = normalizeClientUuid(r.client_uuid);
        if (lo && lo !== String(r.client_uuid || "").trim()) {
          try {
            db.run(`UPDATE presence_cache SET client_uuid = ? WHERE rowid = ?`, [lo, r.rowid]);
          } catch {
            // çakışma: satırı düşür
            db.run(`DELETE FROM presence_cache WHERE rowid = ?`, [r.rowid]);
          }
        }
        continue;
      }
      rows.sort((a, b) => String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")));
      const keep = rows[0];
      for (const r of rows) {
        if (r.rowid === keep.rowid) {
          const lo = normalizeClientUuid(r.client_uuid);
          if (!lo) continue;
          if (lo !== String(r.client_uuid || "").trim()) {
            try {
              db.run(`UPDATE presence_cache SET client_uuid = ? WHERE rowid = ?`, [lo, r.rowid]);
            } catch {
              db.run(`DELETE FROM presence_cache WHERE rowid = ?`, [r.rowid]);
            }
          }
        } else {
          db.run(`DELETE FROM presence_cache WHERE rowid = ?`, [r.rowid]);
        }
      }
    }
  } catch (e) {
    console.error("migratePresenceCacheUuidsToLowerCase:", e?.message || e);
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function appendJsonlLog(logDir, fileName, entry) {
  try {
    ensureDir(logDir);
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    fs.appendFileSync(path.join(logDir, fileName), line, "utf8");
  } catch (e) {
    console.error("appendJsonlLog:", e?.message || e);
  }
}

function conversationId(uuidA, uuidB) {
  const [x, y] = [normalizeClientUuid(uuidA), normalizeClientUuid(uuidB)].sort();
  if (!x || !y) return "dm::";
  return `dm:${x}:${y}`;
}

/** DM konuşma kimliğinden `excludeUuid` dışındaki tarafın client_uuid değeri */
function otherPartyInConv(convId, excludeUuid) {
  const m = /^dm:([^:]+):([^:]+)$/.exec(String(convId || ""));
  if (!m) return "";
  const na = normalizeClientUuid(m[1]);
  const nb = normalizeClientUuid(m[2]);
  const ex = normalizeClientUuid(excludeUuid);
  if (na === ex) return nb;
  if (nb === ex) return na;
  return "";
}

/** sql.js satır kimliği → JSON/socket için güvenli sayı (BigInt / yapılandırılmış klon uyumu) */
function lastInsertRowId(idRow) {
  const raw = idRow[0]?.values[0]?.[0];
  if (raw == null) return raw;
  if (typeof raw === "bigint") return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

function isFreshOfflineRosterDate(raw) {
  const at = Date.parse(String(raw || ""));
  if (!Number.isFinite(at)) return false;
  return Date.now() - at <= OFFLINE_ROSTER_MAX_AGE_MS;
}

async function initDb(dbPath) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  let db;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      kind TEXT NOT NULL,
      text_content TEXT,
      file_name TEXT,
      file_rel TEXT,
      file_mime TEXT,
      file_size INTEGER,
      file_sha256 TEXT,
      created_at TEXT NOT NULL,
      conv_id TEXT NOT NULL DEFAULT 'global',
      client_msg_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);
  `);
  try {
    db.exec("ALTER TABLE messages ADD COLUMN conv_id TEXT NOT NULL DEFAULT 'global'");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN from_socket_id TEXT");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN client_msg_id TEXT");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN file_sha256 TEXT");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN to_client_uuid TEXT");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'sent'");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN delivered_at TEXT");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN read_at TEXT");
  } catch {
    // sütun var
  }
  try {
    db.exec("ALTER TABLE messages ADD COLUMN from_client_uuid TEXT");
  } catch {
    // sütun var
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_cache (
      client_uuid TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      profile_image TEXT,
      last_status TEXT,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  migratePresenceCacheUuidsToLowerCase(db);
  // Eski sürümlerden kalabilecek aşırı büyük/bozuk profile_image verileri OOM üretebilir.
  db.run(
    `UPDATE presence_cache
       SET profile_image = CASE
         WHEN profile_image IS NULL THEN ''
         WHEN profile_image NOT LIKE 'data:image/%' THEN ''
         WHEN length(profile_image) > ? THEN substr(profile_image, 1, ?)
         ELSE profile_image
       END`,
    [PROFILE_IMAGE_DB_MAX, PROFILE_IMAGE_DB_MAX]
  );
  // presence_cache sadece roster ipucu; büyük görselleri DB cache'te tutmak gereksiz bellek baskısı yapıyor.
  db.run(`UPDATE presence_cache SET profile_image = '' WHERE profile_image IS NOT NULL AND profile_image != ''`);
  db.run(`DELETE FROM presence_cache WHERE last_seen_at IS NULL OR last_seen_at < ?`, [
    new Date(Date.now() - OFFLINE_ROSTER_MAX_AGE_MS).toISOString()
  ]);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg_id ON messages(client_msg_id)");
  return { SQL, db };
}

function persistDb(dbPath, db) {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Token-bucket tabanlı upload hız sınırlayıcı.
 * req.pipe üzerinden geçen veriyi yavaşlatarak TCP geri basıncıyla
 * göndericiyi de yavaşlatır → router tampon taşması önlenir.
 */
function makeUploadThrottle(rateLimit) {
  let tokens = rateLimit;
  let lastRefill = Date.now();
  return new Transform({
    transform(chunk, _enc, cb) {
      const now = Date.now();
      const elapsed = (now - lastRefill) / 1000;
      lastRefill = now;
      tokens = Math.min(rateLimit, tokens + elapsed * rateLimit);
      if (tokens >= chunk.length) {
        tokens -= chunk.length;
        this.push(chunk);
        cb();
      } else {
        const delay = Math.ceil(((chunk.length - tokens) / rateLimit) * 1000);
        tokens = 0;
        setTimeout(() => { this.push(chunk); cb(); }, delay);
      }
    }
  });
}

function uploadThrottleMiddleware(req, _res, next) {
  if (!UPLOAD_RATE_BYTES_PER_SEC) return next();
  const originalPipe = req.pipe.bind(req);
  req.pipe = (dest, opts) => {
    const throttle = makeUploadThrottle(UPLOAD_RATE_BYTES_PER_SEC);
    throttle.pipe(dest, opts);
    originalPipe(throttle);
    return dest;
  };
  next();
}

async function createChatServer(options) {
  const dataDir = options.dataDir;
  ensureDir(dataDir);
  const uploadsDir = path.join(dataDir, "uploads");
  ensureDir(uploadsDir);
  const logDir = path.join(dataDir, "logs");

  const dbPath = path.join(dataDir, "messages.db");
  const { db } = await initDb(dbPath);
  let isShuttingDown = false;

  const saveDb = () => persistDb(dbPath, db);
  function ensureLeader() {
    return true;
  }

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "2mb" }));

  const staticDir = options.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
  }

  function resolveUploadFilePath(fileRel) {
    const rel = decodeURIComponent(String(fileRel || "").trim());
    if (!rel || rel.includes("..") || /[/\\]/.test(rel)) return null;
    const safe = path.basename(rel);
    return { safe, abs: path.join(uploadsDir, safe) };
  }

  app.get("/files/:fileRel", (req, res) => {
    const resolved = resolveUploadFilePath(req.params.fileRel);
    if (!resolved) {
      res.status(400).json({ error: "Geçersiz dosya adı" });
      return;
    }
    if (!fs.existsSync(resolved.abs)) {
      appendJsonlLog(logDir, "downloads.log", {
        event: "file_missing",
        fileRel: resolved.safe,
        route: "/files",
        ip: req.ip
      });
      res.status(404).json({ error: "Dosya bulunamadı" });
      return;
    }
    res.sendFile(resolved.abs);
  });

  app.get("/api/download/:fileRel", (req, res) => {
    const resolved = resolveUploadFilePath(req.params.fileRel);
    if (!resolved) {
      res.status(400).json({ error: "Geçersiz dosya adı" });
      return;
    }
    if (!fs.existsSync(resolved.abs)) {
      appendJsonlLog(logDir, "downloads.log", {
        event: "file_missing",
        fileRel: resolved.safe,
        route: "/api/download",
        ip: req.ip
      });
      res.status(404).json({ error: "Dosya bulunamadı" });
      return;
    }
    res.download(resolved.abs, resolved.safe);
  });

  app.post("/api/client-diagnostics", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    appendJsonlLog(logDir, "client-diagnostics.jsonl", {
      event: "client_diagnostic",
      ip: req.ip,
      ...body
    });
    res.json({ ok: true });
  });

  /**
   * Hangi süreç / hangi çalışma dizini / hangi özellik setinin ayakta olduğunu doğrulamak için.
   * Merkezi sunucuda Görev Zamanlayıcısı yanlış klasörden `node` çalıştırıyorsa burada cwd/argv görünür.
   */
  app.get("/api/server-meta", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      app: "kobichat-chat-server",
      /** İstemci titreşim (poke) için Socket.IO ack bekler; eski sunucuda bu alan yoktur. */
      pokeSendAck: true,
      pid: process.pid,
      cwd: process.cwd(),
      script: process.argv[1] || "",
      /** Sağlık kontrolü: tarayıcıdan açıp sunucunun ayakta olduğunu görmek için. */
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      onlineUsers: presence.size,
      serverTime: new Date().toISOString()
    });
  });

  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, uploadsDir);
    },
    filename(_req, file, cb) {
      const normalizedName = normalizeUploadOriginalName(file.originalname);
      const ext = path.extname(normalizedName || file.originalname) || "";
      cb(null, `${randomUUID()}${ext}`);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: 80 * 1024 * 1024 }
  });

  function normalizeUploadOriginalName(name) {
    const raw = String(name || "").trim();
    if (!raw) return "";
    // Yalnızca UTF-8 metin latin1 gibi okunmuşsa düzelt (örn: "yapÄ±lacaklar.txt").
    if (!/[ÃÄÅÇÐÑÕÖÜ]/.test(raw)) return raw;
    try {
      const decoded = Buffer.from(raw, "latin1").toString("utf8");
      return decoded.includes("�") ? raw : decoded;
    } catch {
      return raw;
    }
  }

  /** @type {import('socket.io').Server | null} */
  let ioRef = null;
  /** socket.id değişince (yeniden bağlantı) sohbet penceresindeki eski peerId geçersiz kalır; clientUuid ile güncel oturumu buluruz */
  const presence = new Map();
  /** Giden DM hız sınırı: `socket.id` veya HTTP upload’taki `fromSocketId` anahtarı. */
  const dmSendTimestampsBySenderKey = new Map();
  /** `fromUuid>toUuid` → son poke zamanı (ms) — spam önleme. */
  const pokeLastAtByPair = new Map();

  function allowOutboundDm(senderKey) {
    const key = String(senderKey || "").trim();
    if (!key) return false;
    const now = Date.now();
    let arr = dmSendTimestampsBySenderKey.get(key);
    if (!arr) {
      arr = [];
      dmSendTimestampsBySenderKey.set(key, arr);
    }
    const cutoff = now - DM_SEND_WINDOW_MS;
    while (arr.length > 0 && arr[0] < cutoff) arr.shift();
    if (arr.length >= DM_SEND_BURST) return false;
    arr.push(now);
    return true;
  }

  function countQueuedForRecipient(recipientClientUuid) {
    const r = normalizeClientUuid(recipientClientUuid);
    if (!r) return 0;
    try {
      const stmt = db.prepare(
        `SELECT COUNT(*) AS c FROM messages
         WHERE delivery_state = 'queued'
           AND trim(coalesce(to_client_uuid, '')) != ''
           AND lower(trim(to_client_uuid)) = ?`
      );
      stmt.bind([r]);
      let n = 0;
      if (stmt.step()) n = Number(stmt.getAsObject().c || 0);
      stmt.free();
      return n;
    } catch (e) {
      console.error("countQueuedForRecipient:", e?.message || e);
      return 0;
    }
  }

  function resolvePeerSocketId(toSocketId, peerClientUuid) {
    const targetUuid = normalizeClientUuid(peerClientUuid);
    if (!targetUuid) return null;
    const hint = String(toSocketId || "").trim();
    if (hint && presence.has(hint)) {
      const row = presence.get(hint);
      if (row && normalizeClientUuid(row.clientUuid) === targetUuid) {
        return hint;
      }
    }
    for (const [id, data] of presence.entries()) {
      if (normalizeClientUuid(data.clientUuid) === targetUuid) {
        return id;
      }
    }
    return null;
  }

  function upsertPresenceCacheRow({ clientUuid, displayName, profileImage, status, nowIso }) {
    if (isShuttingDown) return;
    const cu = normalizeClientUuid(clientUuid);
    if (!cu) return;
    const n = nowIso || new Date().toISOString();
    const dn = String(displayName || "Anonim").slice(0, 21).trim() || "Anonim";
    const pi = sanitizeProfileImage(profileImage, PROFILE_IMAGE_DB_MAX);
    const st = String(status || "available").slice(0, 32);
    db.run(
      `INSERT INTO presence_cache (client_uuid, display_name, profile_image, last_status, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_uuid) DO UPDATE SET
         display_name = excluded.display_name,
         profile_image = CASE WHEN length(trim(excluded.profile_image)) > 12 THEN excluded.profile_image ELSE presence_cache.profile_image END,
         last_status = excluded.last_status,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      [cu, dn, pi, st, n, n]
    );
  }

  function purgeGhostUuids(activeClientUuid, displayName) {
    const cu = normalizeClientUuid(activeClientUuid);
    const dn = String(displayName || "").trim().toLowerCase();
    if (!cu || !dn) return;
    try {
      db.run(
        `DELETE FROM presence_cache WHERE lower(display_name) = ? AND client_uuid != ?`,
        [dn, cu]
      );
    } catch {}
  }

  function touchPresenceLastSeen(clientUuid) {
    if (isShuttingDown) return;
    const cu = normalizeClientUuid(clientUuid);
    if (!cu) return;
    const n = new Date().toISOString();
    db.run(`UPDATE presence_cache SET last_seen_at = ?, updated_at = ? WHERE client_uuid = ?`, [n, n, cu]);
  }

  function listCachedUsersNotOnline(onlineUuidSet) {
    try {
      const byUuid = new Map();
      const stmt = db.prepare(
        `SELECT client_uuid, display_name, profile_image, last_status, last_seen_at
         FROM presence_cache
         LIMIT 400`
      );
      while (stmt.step()) {
        const o = stmt.getAsObject();
        const uuid = normalizeClientUuid(o.client_uuid);
        if (!uuid || onlineUuidSet.has(uuid)) continue;
        if (!isFreshOfflineRosterDate(o.last_seen_at)) continue;
        byUuid.set(uuid, {
          id: `offline:${uuid}`,
          displayName: String(o.display_name || "Anonim").trim() || "Anonim",
          clientUuid: uuid,
          status: o.last_status || "available",
          profileImage: sanitizeProfileImage(o.profile_image, PROFILE_IMAGE_SOCKET_MAX),
          online: false,
          last_seen_at: o.last_seen_at || null
        });
      }
      stmt.free();
      const msgStmt = db.prepare(
        `SELECT from_client_uuid, sender, MAX(created_at) AS last_seen_at
         FROM messages
         WHERE from_client_uuid IS NOT NULL AND trim(from_client_uuid) != ''
         GROUP BY from_client_uuid
         ORDER BY last_seen_at DESC
         LIMIT 400`
      );
      while (msgStmt.step()) {
        const o = msgStmt.getAsObject();
        const uuid = normalizeClientUuid(o.from_client_uuid);
        if (!uuid || onlineUuidSet.has(uuid) || byUuid.has(uuid)) continue;
        if (!isFreshOfflineRosterDate(o.last_seen_at)) continue;
        byUuid.set(uuid, {
          id: `offline:${uuid}`,
          displayName: String(o.sender || "Anonim").trim() || "Anonim",
          clientUuid: uuid,
          status: "available",
          profileImage: "",
          online: false,
          last_seen_at: o.last_seen_at || null
        });
      }
      msgStmt.free();
      /**
       * Ek fallback: yalnızca ALICI olarak görünen peer'lar (kullanıcı
       * onlara mesaj atmış ama onlar hiç cevap vermemiş). `from_client_uuid`
       * sorgusu bu peer'ları yakalamıyor; `to_client_uuid` da kontrol etmek
       * gerek. Aksi halde offline olduğunda roster'da hiç görünmezler ve
       * geçmiş diyalog erişilemez hale gelir.
       *
       * Sender ismi olarak presence_cache'i ya da boş bırakırız ki client
       * `Anonim (xxxx)` formatında peerClientUuid son 4 hane ile gösterir.
       */
      const recvStmt = db.prepare(
        `SELECT to_client_uuid, MAX(created_at) AS last_seen_at
         FROM messages
         WHERE to_client_uuid IS NOT NULL AND trim(to_client_uuid) != ''
         GROUP BY to_client_uuid
         ORDER BY last_seen_at DESC
         LIMIT 400`
      );
      while (recvStmt.step()) {
        const o = recvStmt.getAsObject();
        const uuid = normalizeClientUuid(o.to_client_uuid);
        if (!uuid || onlineUuidSet.has(uuid) || byUuid.has(uuid)) continue;
        if (!isFreshOfflineRosterDate(o.last_seen_at)) continue;
        byUuid.set(uuid, {
          id: `offline:${uuid}`,
          displayName: "Anonim",
          clientUuid: uuid,
          status: "available",
          profileImage: "",
          online: false,
          last_seen_at: o.last_seen_at || null
        });
      }
      recvStmt.free();
      const out = Array.from(byUuid.values());
      out.sort((a, b) => a.displayName.localeCompare(b.displayName, "tr"));
      return out;
    } catch (e) {
      console.error("listCachedUsersNotOnline:", e?.message || e);
      return [];
    }
  }

  function mapRow(obj) {
    return {
      id: obj.id,
      sender: obj.sender,
      kind: obj.kind,
      text_content: obj.text_content,
      file_name: obj.file_name,
      file_rel: obj.file_rel,
      file_mime: obj.file_mime,
      file_size: obj.file_size,
      file_sha256: obj.file_sha256 || null,
      created_at: obj.created_at,
      conv_id: obj.conv_id,
      from_socket_id: obj.from_socket_id || null,
      client_msg_id: obj.client_msg_id || null,
      to_client_uuid: obj.to_client_uuid || null,
      delivery_state: obj.delivery_state || "sent",
      delivered_at: obj.delivered_at || null,
      read_at: obj.read_at || null,
      from_client_uuid: obj.from_client_uuid || null
    };
  }

  function flushQueuedMessagesForRecipient(recipientSocketId, recipientClientUuid) {
    const rUuid = normalizeClientUuid(recipientClientUuid);
    const rSock = String(recipientSocketId || "").trim();
    if (!rUuid || !rSock || !ioRef) return;
    const stmt = db.prepare(
      `SELECT id, sender, kind, text_content, file_name, file_rel, file_mime, file_size, created_at, conv_id, from_socket_id
             , file_sha256, client_msg_id, to_client_uuid, delivery_state, delivered_at, read_at, from_client_uuid
       FROM messages WHERE delivery_state = 'queued' AND trim(coalesce(to_client_uuid,'')) != '' AND lower(trim(to_client_uuid)) = ? ORDER BY id ASC`
    );
    stmt.bind([rUuid]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (rows.length === 0) return;
    for (const row of rows) {
      const obj = mapRow(row);
      const fromUuid =
        String(obj.from_client_uuid || "").trim() || otherPartyInConv(obj.conv_id, rUuid);
      const now = new Date().toISOString();
      db.run(`UPDATE messages SET delivery_state = 'sent' WHERE id = ?`, [obj.id]);
      /**
       * `was_queued: true` işareti istemciye, bu mesajların kuyruktan toplu
       * akış sırasında geldiğini söyler. İstemci böylece her mesaj için
       * ayrı ayrı bildirim/ses üretmek yerine peer başına tek özet bildirim
       * gösterir (kullanıcı 50 mesaj birikmişken 50 ses duymaz).
       */
      const payload = { ...obj, from_client_uuid: fromUuid, delivery_state: "sent", was_queued: true };
      ioRef.to(rSock).emit("message:new", payload);
      const senderSock = fromUuid ? resolvePeerSocketId("", fromUuid) : null;
      if (senderSock && senderSock !== rSock) {
        ioRef.to(senderSock).emit("message:state", {
          messageId: obj.id,
          conv_id: obj.conv_id,
          delivery_state: "sent",
          at: now
        });
      }
    }
    try {
      saveDb();
    } catch (e) {
      console.error("saveDb (flush):", e);
    }
  }

  function hasMessageByClientMsgId(clientMsgId) {
    const stmt = db.prepare("SELECT id FROM messages WHERE client_msg_id = ?");
    stmt.bind([String(clientMsgId || "")]);
    const has = stmt.step();
    stmt.free();
    return has;
  }

  function loadHistoryForDm(convId, myClientUuid, peerClientUuid) {
    const stmt = db.prepare(`
      SELECT id, sender, kind, text_content, file_name, file_rel, file_mime, file_size, created_at, conv_id, from_socket_id
             , file_sha256, client_msg_id, to_client_uuid, delivery_state, delivered_at, read_at, from_client_uuid
      FROM messages
      WHERE conv_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    stmt.bind([convId, HISTORY_LIMIT]);
    const rows = [];
    while (stmt.step()) {
      const m = mapRow(stmt.getAsObject());
      if (!m.from_client_uuid && m.to_client_uuid && m.conv_id) {
        m.from_client_uuid = otherPartyInConv(m.conv_id, m.to_client_uuid);
      }
      rows.push(m);
    }
    stmt.free();
    rows.reverse();
    return rows;
  }

  app.post("/api/upload", uploadThrottleMiddleware, upload.single("file"), async (req, res) => {
    try {
      if (!ensureLeader()) {
        res.status(503).json({ error: "Lider düğüm yazma için hazır değil" });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "Dosya yok" });
        return;
      }
      const sender = String(req.body.displayName || "Anonim").slice(0, 21);
      /** WhatsApp benzeri alt yazı: dosya mesajıyla birlikte gelen metin (text_content). */
      const caption = String(req.body.caption || "").slice(0, MAX_DM_TEXT_CHARS).trim() || null;
      let fromSocketId = String(req.body.fromSocketId || "").trim();
      const toSocketId = String(req.body.toSocketId || "").trim();
      const clientUuid = normalizeClientUuid(req.body.clientUuid || "");
      const peerClientUuid = normalizeClientUuid(req.body.peerClientUuid || "");
      if (!fromSocketId || !clientUuid || !peerClientUuid) {
        res.status(400).json({ error: "Eksik alan (özel sohbet için gerekli)" });
        return;
      }
      /**
       * Doğrulama (gevşetilmiş): Önce verilen `fromSocketId` ile presence eşleşmesi
       * aranır. Eğer reconnect anına denk geldiğimiz için presence'da o socket
       * yoksa veya başka bir clientUuid'a aitse, `clientUuid` üzerinden o
       * kullanıcının güncel aktif soketini bulup onu kabul ederiz. Bu sayede
       * upload tam ağ kesintisi/yeniden bağlanma sırasında reddedilmiyor;
       * yine de tamamen yabancı bir oturumdan gelen yüklemeler engellenir.
       */
      let senderPresence = presence.get(fromSocketId);
      let senderClientUuid = normalizeClientUuid(senderPresence?.clientUuid || "");
      if (!senderPresence || senderClientUuid !== clientUuid) {
        const altSock = resolvePeerSocketId("", clientUuid);
        if (altSock) {
          const altPresence = presence.get(altSock);
          const altClientUuid = normalizeClientUuid(altPresence?.clientUuid || "");
          if (altPresence && altClientUuid === clientUuid) {
            senderPresence = altPresence;
            senderClientUuid = altClientUuid;
            fromSocketId = altSock;
          }
        }
      }
      if (!senderPresence || senderClientUuid !== clientUuid) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignored
        }
        res.status(409).json({ error: "Gönderen oturumu geçersiz veya güncel değil" });
        return;
      }
      const clientMsgId = String(req.body.clientMsgId || randomUUID()).trim().slice(0, 120);
      if (hasMessageByClientMsgId(clientMsgId)) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo && countQueuedForRecipient(peerClientUuid) >= MAX_QUEUED_PER_RECIPIENT) {
        res.status(429).json({
          error: `Alıcı çevrimdışı ve bekleyen mesaj kuyruğu dolu (en fazla ${MAX_QUEUED_PER_RECIPIENT}).`
        });
        return;
      }
      if (!allowOutboundDm(fromSocketId)) {
        res.status(429).json({
          error: `Çok hızlı mesaj veya dosya gönderiyorsunuz (en fazla ${DM_SEND_BURST} işlem / ${Math.round(DM_SEND_WINDOW_MS / 1000)} sn).`
        });
        return;
      }
      const convId = conversationId(clientUuid, peerClientUuid);
      const createdAt = new Date().toISOString();
      const rel = req.file.filename;
      const fileSha256 = await computeFileSha256(req.file.path);
      const originalFileName = normalizeUploadOriginalName(req.file.originalname) || req.file.filename;
      const deliveryState = resolvedTo ? "sent" : "queued";
      db.run(
        `INSERT INTO messages (sender, kind, text_content, file_name, file_rel, file_mime, file_size, file_sha256, created_at, conv_id, from_socket_id, client_msg_id, to_client_uuid, delivery_state, from_client_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sender,
          "file",
          caption,
          originalFileName,
          rel,
          req.file.mimetype || "application/octet-stream",
          req.file.size,
          fileSha256,
          createdAt,
          convId,
          fromSocketId,
          clientMsgId,
          peerClientUuid,
          deliveryState,
          clientUuid
        ]
      );
      const idRow = db.exec("SELECT last_insert_rowid() as id");
      const id = lastInsertRowId(idRow);
      const payload = {
        id,
        sender,
        kind: "file",
        text_content: caption,
        file_name: originalFileName,
        file_rel: rel,
        file_mime: req.file.mimetype || "application/octet-stream",
        file_size: req.file.size,
        file_sha256: fileSha256,
        created_at: createdAt,
        conv_id: convId,
        from_socket_id: fromSocketId,
        from_client_uuid: clientUuid,
        client_msg_id: clientMsgId,
        to_client_uuid: peerClientUuid,
        delivery_state: deliveryState
      };
      try {
        saveDb();
      } catch (e) {
        console.error("saveDb (upload):", e);
      }
      if (ioRef) {
        if (resolvedTo) {
          ioRef.to(resolvedTo).emit("message:new", payload);
        }
        /**
         * Upload HTTP üzerinden geldiği için `fromSocketId` bazen stale kalabiliyor
         * (socket reconnect sonrası). Bu durumda gönderen kendi dosya mesajını
         * anlık göremiyor. Önce verilen socket'e, bulunamazsa clientUuid ile güncel
         * socket'e yayınla.
         */
        const resolvedFrom = resolvePeerSocketId(fromSocketId, clientUuid);
        if (resolvedFrom) {
          ioRef.to(resolvedFrom).emit("message:new", payload);
        } else if (fromSocketId) {
          ioRef.to(fromSocketId).emit("message:new", payload);
        }
      }
      res.json({ ok: true, message: payload });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Yükleme hatası" });
    }
  });

  app.get("*", (req, res, next) => {
    if (!staticDir) return next();
    const indexHtml = path.join(staticDir, "index.html");
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else next();
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 5e6,
    /** Küçük paketlerde sıkıştırma gecikmesini azaltır (Engine.IO). */
    httpCompression: false,
    /** WebSocket çerçevesi deflate kapalı (düşük gecikme). */
    perMessageDeflate: false,
    /**
     * Tailscale / gizli Electron penceresi / arka plan kısıtlaması: varsayılan pingTimeout
     * altında istemci “ölü” sayılıp presence düşebiliyor. Biraz gevşetmek daha stabil roster verir.
     */
    pingInterval: 25000,
    pingTimeout: 45000,
    connectTimeout: 45000
  });
  ioRef = io;

  function normalizeStatus(s) {
    const x = String(s || "").toLowerCase();
    if (x === "busy" || x === "mesgul") return "busy";
    if (x === "away" || x === "disarida") return "away";
    return "available";
  }

  function rosterPayload() {
    const onlineUuids = new Set();
    const users = [];
    const byClientUuid = new Map();
    for (const [id, data] of presence.entries()) {
      const cu = normalizeClientUuid(data.clientUuid);
      const user = {
        id,
        displayName: data.displayName,
        clientUuid: cu,
        status: data.status || "available",
        profileImage: sanitizeProfileImage(data.profileImage, PROFILE_IMAGE_SOCKET_MAX),
        online: true
      };
      if (cu) {
        onlineUuids.add(cu);
        // Aynı clientUuid için tek satır göster (yeniden bağlantıdan kalan mükerrer socket'leri gizle).
        byClientUuid.set(cu, user);
      } else {
        users.push(user);
      }
    }
    users.push(...byClientUuid.values());
    users.sort((a, b) => a.displayName.localeCompare(b.displayName, "tr"));
    const offline = listCachedUsersNotOnline(onlineUuids);
    /**
     * "Ajan Smith" temizliği: Bir kullanıcının PC'si UUID kalıcılığını
     * kaybedip her açılışta yeni clientUuid üretirse, eski UUID'ler mesaj
     * geçmişinde kaldığı için offline roster onları "hayalet" olarak yeniden
     * üretir (aynı isimden 3-4 kopya). purgeGhostUuids yalnızca presence_cache'i
     * temizlediğinden mesaj kaynaklı hayaletleri yakalayamıyor. Burada roster
     * seviyesinde ADA göre birleştiriyoruz (veri silinmez, yalnızca gösterim):
     *   - Aynı isim çevrimiçiyse tüm offline kopyalarını gizle (çevrimiçi otorite).
     *   - Birden fazla offline aynı isim varsa yalnızca en güncelini tut.
     *   - İsimsiz / "Anonim" satırlar birleştirilmez (farklı bilinmeyen peer'lar).
     */
    const normName = (s) => String(s || "").trim().toLowerCase();
    const onlineNames = new Set(
      users.map((u) => normName(u.displayName)).filter((n) => n && n !== "anonim")
    );
    const bestOfflineByName = new Map();
    const offlineKept = [];
    for (const u of offline) {
      const nm = normName(u.displayName);
      if (!nm || nm === "anonim") {
        offlineKept.push(u);
        continue;
      }
      if (onlineNames.has(nm)) continue;
      const prev = bestOfflineByName.get(nm);
      if (!prev || String(u.last_seen_at || "") > String(prev.last_seen_at || "")) {
        bestOfflineByName.set(nm, u);
      }
    }
    offlineKept.push(...bestOfflineByName.values());
    return { users: [...users, ...offlineKept] };
  }

  function broadcastRoster() {
    io.emit("presence:roster", rosterPayload());
  }

  io.on("connection", (socket) => {
    socket.emit("presence:roster", rosterPayload());

    /**
     * Bağlantı yaşam döngüsü logu (connections.jsonl): aralıklı kopma
     * sorunlarını teşhis için. `transport` polling/websocket ayrımını,
     * disconnect `reason` ise kopma sebebini (transport close = ağ koptu,
     * ping timeout = ağ yavaş/tıkalı) gösterir.
     */
    socket.data.connectedAt = Date.now();
    appendJsonlLog(logDir, "connections.jsonl", {
      event: "connect",
      socketId: socket.id,
      transport: socket.conn?.transport?.name || "",
      ip: socket.handshake?.address || ""
    });

    socket.on("presence:join", (data) => {
      const name =
        typeof data?.displayName === "string" ? data.displayName.slice(0, 21) : "Anonim";
      const clientUuid = normalizeClientUuid(
        typeof data?.clientUuid === "string" ? data.clientUuid : ""
      );
      const status = normalizeStatus(data?.status);
      const profileImage = sanitizeProfileImage(data?.profileImage, PROFILE_IMAGE_SOCKET_MAX);
      if (clientUuid) {
        for (const [sid, row] of presence.entries()) {
          if (sid === socket.id) continue;
          if (normalizeClientUuid(row?.clientUuid) === clientUuid) {
            presence.delete(sid);
            try {
              const stale = io.sockets.sockets.get(sid);
              if (stale && stale.connected) stale.disconnect(true);
            } catch (e) {
              console.error("presence duplicate disconnect:", e?.message || e);
            }
          }
        }
      }
      presence.set(socket.id, {
        displayName: name.trim() || "Anonim",
        clientUuid,
        status,
        profileImage
      });
      upsertPresenceCacheRow({
        clientUuid,
        displayName: name.trim() || "Anonim",
        profileImage,
        status
      });
      purgeGhostUuids(clientUuid, name.trim() || "Anonim");
      setImmediate(() => {
        try {
          saveDb();
        } catch (e) {
          console.error("saveDb (presence:join):", e);
        }
      });
      flushQueuedMessagesForRecipient(socket.id, clientUuid);
      broadcastRoster();
    });

    socket.on("presence:status", (data) => {
      const cur = presence.get(socket.id);
      if (!cur) return;
      cur.status = normalizeStatus(data?.status);
      presence.set(socket.id, cur);
      broadcastRoster();
    });

    socket.on("message:ack", (data) => {
      if (!ensureLeader()) return;
      const messageId = data?.messageId;
      const senderClientUuid = typeof data?.senderClientUuid === "string" ? data.senderClientUuid.trim() : "";
      const hint = typeof data?.senderSocketId === "string" ? data.senderSocketId.trim() : "";
      const senderSocketId =
        (senderClientUuid && resolvePeerSocketId("", senderClientUuid)) || hint || "";
      if (!senderSocketId || messageId == null) return;
      const now = new Date().toISOString();
      /**
       * Delivery state tek yönlü ilerlemeli: queued → sent → delivered → read.
       * Eğer mesaj zaten 'read' işaretlenmişse (peer pencere odakta iken read
       * event'i ack'ten önce işlendiyse), delayed ack geldiğinde DB'yi
       * 'delivered'a düşürmemeliyiz; aksi halde pencere yeniden açıldığında
       * history mavi tikleri kaybeder.
       */
      db.run(
        `UPDATE messages SET delivery_state = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND delivery_state != 'read'`,
        [now, Number(messageId)]
      );
      io.to(senderSocketId).emit("message:status", {
        messageId,
        status: "delivered",
        conv_id: typeof data?.conv_id === "string" ? data.conv_id : undefined
      });
      setImmediate(() => {
        try {
          saveDb();
        } catch (e) {
          console.error("saveDb (ack):", e);
        }
      });
    });

    socket.on("message:read", (data) => {
      if (!ensureLeader()) return;
      const messageId = data?.messageId;
      const senderClientUuid = typeof data?.senderClientUuid === "string" ? data.senderClientUuid.trim() : "";
      const hint = typeof data?.senderSocketId === "string" ? data.senderSocketId.trim() : "";
      const senderSocketId =
        (senderClientUuid && resolvePeerSocketId("", senderClientUuid)) || hint || "";
      if (!senderSocketId || messageId == null) return;
      const now = new Date().toISOString();
      db.run(
        `UPDATE messages SET delivery_state = 'read', read_at = COALESCE(read_at, ?), delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`,
        [now, now, Number(messageId)]
      );
      io.to(senderSocketId).emit("message:status", {
        messageId,
        status: "read",
        conv_id: typeof data?.conv_id === "string" ? data.conv_id : undefined
      });
      setImmediate(() => {
        try {
          saveDb();
        } catch (e) {
          console.error("saveDb (read):", e);
        }
      });
    });

    socket.on("dm:open", (data) => {
      const peerClientUuid = typeof data?.peerClientUuid === "string" ? data.peerClientUuid : "";
      const myClientUuid = typeof data?.myClientUuid === "string" ? data.myClientUuid : "";
      const cuPeer = normalizeClientUuid(peerClientUuid);
      const cuMine = normalizeClientUuid(myClientUuid);
      if (!cuPeer || !cuMine) {
        socket.emit("history", {
          messages: [],
          convId: null,
          error: "Eksik dm:open alanları",
          peerClientUuid: cuPeer,
          myClientUuid: cuMine
        });
        return;
      }
      const convId = conversationId(cuMine, cuPeer);
      const messages = loadHistoryForDm(convId, cuMine, cuPeer);
      socket.emit("history", {
        messages,
        convId,
        peerClientUuid: cuPeer,
        myClientUuid: cuMine
      });
    });

    socket.on("chat:message", (data) => {
      if (!ensureLeader()) return;
      const text = typeof data?.text === "string" ? data.text : "";
      const sender = typeof data?.displayName === "string" ? data.displayName.slice(0, 21) : "Anonim";
      const toSocketId = typeof data?.toSocketId === "string" ? data.toSocketId : "";
      const peerClientUuid = normalizeClientUuid(data?.peerClientUuid || "");
      const myClientUuid = normalizeClientUuid(data?.clientUuid || "");
      if (!text.trim()) return;
      if (!peerClientUuid || !myClientUuid) {
        socket.emit("message:error", { m: "Alıcı seçilmedi veya eksik bilgi" });
        return;
      }
      if (text.length > MAX_DM_TEXT_CHARS) {
        socket.emit("message:error", {
          m: `Mesaj çok uzun (en fazla ${MAX_DM_TEXT_CHARS} karakter).`
        });
        return;
      }
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo && countQueuedForRecipient(peerClientUuid) >= MAX_QUEUED_PER_RECIPIENT) {
        socket.emit("message:error", {
          m: `Alıcı çevrimdışı ve bekleyen mesaj kuyruğu dolu (en fazla ${MAX_QUEUED_PER_RECIPIENT}).`
        });
        return;
      }
      const convId = conversationId(myClientUuid, peerClientUuid);
      const createdAt = new Date().toISOString();
      const clientMsgId = String(data?.clientMsgId || randomUUID()).trim().slice(0, 120);
      if (hasMessageByClientMsgId(clientMsgId)) return;
      if (!allowOutboundDm(socket.id)) {
        socket.emit("message:error", {
          m: `Çok hızlı mesaj gönderiyorsunuz (en fazla ${DM_SEND_BURST} mesaj / ${Math.round(DM_SEND_WINDOW_MS / 1000)} sn).`
        });
        return;
      }
      const deliveryState = resolvedTo ? "sent" : "queued";
      db.run(
        `INSERT INTO messages (sender, kind, text_content, file_name, file_rel, file_mime, file_size, file_sha256, created_at, conv_id, from_socket_id, client_msg_id, to_client_uuid, delivery_state, from_client_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sender,
          "text",
          text,
          null,
          null,
          null,
          null,
          null,
          createdAt,
          convId,
          socket.id,
          clientMsgId,
          peerClientUuid,
          deliveryState,
          myClientUuid
        ]
      );
      const idRow = db.exec("SELECT last_insert_rowid() as id");
      const id = lastInsertRowId(idRow);
      const payload = {
        id,
        sender,
        kind: "text",
        text_content: text,
        file_name: null,
        file_rel: null,
        file_mime: null,
        file_size: null,
        file_sha256: null,
        created_at: createdAt,
        conv_id: convId,
        from_socket_id: socket.id,
        from_client_uuid: myClientUuid,
        client_msg_id: clientMsgId,
        to_client_uuid: peerClientUuid,
        delivery_state: deliveryState
      };
      try {
        saveDb();
      } catch (e) {
        console.error("saveDb (chat:message):", e);
      }
      if (resolvedTo) {
        io.to(resolvedTo).emit("message:new", payload);
      }
      socket.emit("message:new", payload);
    });

    socket.on("chat:typing", (data) => {
      const toSocketId = typeof data?.toSocketId === "string" ? data.toSocketId : "";
      const peerClientUuid = typeof data?.peerClientUuid === "string" ? data.peerClientUuid : "";
      const myClientUuidRaw = typeof data?.clientUuid === "string" ? data.clientUuid : "";
      if (!peerClientUuid) return;
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo) return;
      const convId = typeof data?.conv_id === "string" ? data.conv_id : "";
      const senderPresence = presence.get(socket.id);
      const myClientUuid = String(myClientUuidRaw || senderPresence?.clientUuid || "").trim();
      io.to(resolvedTo).emit("chat:typing", {
        from_socket_id: socket.id,
        from_client_uuid: myClientUuid,
        conv_id: convId,
        isTyping: Boolean(data?.isTyping)
      });
    });

    socket.on("poke:send", (data, ack) => {
      const reply = (payload) => {
        if (typeof ack !== "function") return;
        try {
          ack(payload);
        } catch {
          // ignored
        }
      };
      const toSocketId = typeof data?.toSocketId === "string" ? data.toSocketId.trim() : "";
      const peerClientUuid = normalizeClientUuid(data?.peerClientUuid || "");
      const myClientUuid = normalizeClientUuid(data?.myClientUuid || "");
      if (!peerClientUuid || !myClientUuid) {
        reply({ ok: false, code: "BAD_REQUEST", peerClientUuid });
        return;
      }
      if (peerClientUuid === myClientUuid) {
        reply({ ok: false, code: "SELF", peerClientUuid });
        return;
      }
      const me = presence.get(socket.id);
      if (!me || normalizeClientUuid(me.clientUuid) !== myClientUuid) {
        reply({ ok: false, code: "SESSION", peerClientUuid });
        return;
      }
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo) {
        reply({ ok: false, code: "OFFLINE", peerClientUuid });
        return;
      }
      const target = presence.get(resolvedTo);
      if (!target || normalizeClientUuid(target.clientUuid) !== peerClientUuid) {
        reply({ ok: false, code: "OFFLINE", peerClientUuid });
        return;
      }
      if (normalizeStatus(target.status) !== "available") {
        reply({ ok: false, code: "NOT_AVAILABLE", peerClientUuid });
        return;
      }
      const pairKey = `${myClientUuid}>${peerClientUuid}`;
      const now = Date.now();
      const last = pokeLastAtByPair.get(pairKey) || 0;
      if (now - last < POKE_MIN_INTERVAL_MS) {
        reply({ ok: false, code: "RATE_LIMIT", peerClientUuid });
        return;
      }
      pokeLastAtByPair.set(pairKey, now);
      const fromDisplayName = String(me.displayName || "Anonim").trim().slice(0, 21) || "Anonim";
      io.to(resolvedTo).emit("poke:incoming", {
        fromSocketId: socket.id,
        fromClientUuid: myClientUuid,
        fromDisplayName,
        at: new Date().toISOString()
      });
      reply({ ok: true, peerClientUuid });
    });

    socket.on("remotecontrol:request", (data) => {
      const toSocketId = typeof data?.toSocketId === "string" ? data.toSocketId.trim() : "";
      const peerClientUuid = typeof data?.peerClientUuid === "string" ? data.peerClientUuid.trim() : "";
      const myClientUuid = typeof data?.myClientUuid === "string" ? data.myClientUuid.trim() : "";
      if (!peerClientUuid || !myClientUuid) {
        socket.emit("remotecontrol:error", { m: "Eksik bilgi" });
        return;
      }
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo) {
        socket.emit("remotecontrol:error", { m: "Karşı taraf çevrimiçi değil" });
        return;
      }
      const me = presence.get(socket.id);
      const requestId = randomUUID();
      io.to(resolvedTo).emit("remotecontrol:incoming", {
        requestId,
        fromSocketId: socket.id,
        fromDisplayName: me?.displayName || "Anonim",
        fromClientUuid: myClientUuid
      });
      socket.emit("remotecontrol:sent", { requestId, toSocketId: resolvedTo });
    });

    socket.on("remotecontrol:response", (data) => {
      const toSocketId = typeof data?.toSocketId === "string" ? data.toSocketId.trim() : "";
      const peerClientUuid = typeof data?.peerClientUuid === "string" ? data.peerClientUuid.trim() : "";
      const myClientUuid = typeof data?.myClientUuid === "string" ? data.myClientUuid.trim() : "";
      const requestId = typeof data?.requestId === "string" ? data.requestId.trim() : "";
      const accepted = Boolean(data?.accepted);
      if (!peerClientUuid || !myClientUuid || !requestId) return;
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo) return;
      const requester = presence.get(resolvedTo);
      if (!requester || normalizeClientUuid(requester.clientUuid) !== normalizeClientUuid(peerClientUuid))
        return;
      const responder = presence.get(socket.id);
      if (!responder || normalizeClientUuid(responder.clientUuid) !== normalizeClientUuid(myClientUuid))
        return;
      io.to(resolvedTo).emit("remotecontrol:result", {
        requestId,
        accepted,
        responderDisplayName: responder.displayName || "Anonim",
        responderClientUuid: myClientUuid
      });
    });

    socket.on("disconnect", (reason) => {
      const cur = presence.get(socket.id);
      const connectedAt = socket.data?.connectedAt || 0;
      appendJsonlLog(logDir, "connections.jsonl", {
        event: "disconnect",
        socketId: socket.id,
        reason: String(reason || ""),
        displayName: cur?.displayName || "",
        clientUuid: cur?.clientUuid || "",
        sessionSeconds: connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : null
      });
      if (!isShuttingDown && cur && String(cur.clientUuid || "").trim()) {
        upsertPresenceCacheRow({
          clientUuid: cur.clientUuid,
          displayName: cur.displayName,
          profileImage: cur.profileImage || "",
          status: cur.status || "available"
        });
        touchPresenceLastSeen(cur.clientUuid);
        setImmediate(() => {
          try {
            saveDb();
          } catch (e) {
            console.error("saveDb (presence:disconnect):", e);
          }
        });
      }
      presence.delete(socket.id);
      dmSendTimestampsBySenderKey.delete(socket.id);
      broadcastRoster();
    });
  });

  /**
   * Dosya eklerini `FILE_RETENTION_DAYS` gününden eskileri için diskten ve
   * kayıttan düşürür. Eskiden “sadece bugün” mantığı vardı; bu, offline
   * kullanıcılar için 1 günden eski dosyaların asla indirilemediği anlamına
   * geliyordu. Artık varsayılan 7 gün, ayrıca çevre değişkeniyle
   * yapılandırılabilir.
   */
  function purgeExpiredFileAttachments() {
    const cutoffMs = Date.now() - FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const stmt = db.prepare(
      `SELECT id, file_rel, created_at FROM messages WHERE kind = 'file' AND file_rel IS NOT NULL AND file_rel != ''`
    );
    const idsToClear = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const rel = String(row.file_rel || "").trim();
      if (!rel) continue;
      const ts = Date.parse(row.created_at);
      if (!Number.isFinite(ts)) continue;
      if (ts >= cutoffMs) continue;
      if (rel.includes("..") || /[/\\]/.test(rel)) continue;
      const safe = path.basename(rel);
      const abs = path.join(uploadsDir, safe);
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (e) {
        console.error("Dosya silinemedi:", abs, e?.message || e);
      }
      idsToClear.push(row.id);
    }
    stmt.free();
    for (const id of idsToClear) {
      db.run(
        `UPDATE messages SET file_rel = NULL, file_mime = NULL, file_size = NULL WHERE id = ?`,
        [id]
      );
    }
    if (idsToClear.length > 0) {
      try {
        saveDb();
      } catch (e) {
        console.error("saveDb (purge):", e);
      }
    }
  }

  /**
   * Phantom delivery uzlaşmacısı: `sent` durumda olup `delivered_at` boş kalan
   * (ack gelmemiş) DM'leri belirli bir süre sonra (ACK_TIMEOUT_MS) bulur.
   * Eğer alıcı şu anda çevrimdışıysa mesajı tekrar `queued` durumuna düşürür;
   * böylece alıcı bağlandığında `flushQueuedMessagesForRecipient` ile aynı
   * mesaj yeniden canlı olarak iletilir ve “tek tik aldım sandım, gerçekte
   * hiç ulaşmadı” yarışı kapanır. Alıcı çevrimiçiyse müdahale etmez (mesaj
   * büyük ihtimalle teslim edildi, sadece ack hatla geri dönmedi).
   */
  function reconcileUndeliveredSentMessages() {
    const cutoffIso = new Date(Date.now() - ACK_TIMEOUT_MS).toISOString();
    const stmt = db.prepare(
      `SELECT id, to_client_uuid FROM messages
       WHERE delivery_state = 'sent'
         AND delivered_at IS NULL
         AND created_at < ?
         AND trim(coalesce(to_client_uuid, '')) != ''`
    );
    stmt.bind([cutoffIso]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    if (rows.length === 0) return;

    const onlineUuids = new Set();
    for (const data of presence.values()) {
      const cu = normalizeClientUuid(data?.clientUuid);
      if (cu) onlineUuids.add(cu);
    }

    let changed = 0;
    for (const r of rows) {
      const recipientUuid = normalizeClientUuid(r.to_client_uuid);
      if (!recipientUuid) continue;
      if (onlineUuids.has(recipientUuid)) continue;
      db.run(
        `UPDATE messages SET delivery_state = 'queued'
         WHERE id = ? AND delivery_state = 'sent' AND delivered_at IS NULL`,
        [Number(r.id)]
      );
      changed++;
    }
    if (changed > 0) {
      try {
        saveDb();
      } catch (e) {
        console.error("saveDb (reconcile):", e);
      }
    }
  }

  /** Metin mesaj arşivini boyutlandırır (zaman + toplam adet sınırı). */
  function purgeMessageHistoryIfNeeded() {
    const cutoffIso = new Date(Date.now() - MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM messages WHERE kind = 'text' AND created_at < ?`, [cutoffIso]);
    const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE kind = 'text'`);
    let textCount = 0;
    if (countStmt.step()) {
      textCount = Number(countStmt.getAsObject().c || 0);
    }
    countStmt.free();
    const overflow = textCount - MAX_TEXT_MESSAGES;
    if (overflow > 0) {
      db.run(
        `DELETE FROM messages WHERE id IN (
          SELECT id FROM messages WHERE kind = 'text' ORDER BY id ASC LIMIT ?
        )`,
        [overflow]
      );
    }
    try {
      saveDb();
    } catch (e) {
      console.error("saveDb (history-purge):", e);
    }
  }

  let filePurgeScheduled = false;
  function scheduleFilePurge() {
    if (filePurgeScheduled) return;
    filePurgeScheduled = true;
    const run = () => {
      try {
        purgeExpiredFileAttachments();
      } catch (e) {
        console.error("purgeExpiredFileAttachments:", e);
      }
      try {
        purgeMessageHistoryIfNeeded();
      } catch (e) {
        console.error("purgeMessageHistoryIfNeeded:", e);
      }
    };
    run();
    setInterval(run, 60 * 60 * 1000);
  }

  let ackReconcileScheduled = false;
  function scheduleAckReconcile() {
    if (ackReconcileScheduled) return;
    ackReconcileScheduled = true;
    const run = () => {
      try {
        reconcileUndeliveredSentMessages();
      } catch (e) {
        console.error("reconcileUndeliveredSentMessages:", e);
      }
    };
    setInterval(run, ACK_RECONCILE_INTERVAL_MS);
  }

  return {
    app,
    server,
    io,
    listen(host, port, cb) {
      server.listen(port, host, () => {
        scheduleFilePurge();
        scheduleAckReconcile();
        console.log(
          `[kobichat] Sunucu http://${host}:${port} (pid=${process.pid}) — poke-ack aktif; doğrulama: GET /api/server-meta`
        );
        if (cb) cb();
      });
    },
    close(cb) {
      isShuttingDown = true;
      io.close(() => {
        server.close(() => {
          try {
            saveDb();
            db.close();
          } catch {
            // ignored
          }
          if (cb) cb();
        });
      });
    }
  };
}

async function main() {
  const dataDir = path.join(__dirname, "..", "data");
  const staticDir = path.join(__dirname, "..", "dist", "web");
  const chat = await createChatServer({ dataDir, staticDir });
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || "0.0.0.0";
  chat.listen(host, port, () => {});
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createChatServer, DEFAULT_PORT };
