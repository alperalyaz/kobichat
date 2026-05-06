const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Server } = require("socket.io");
const { randomUUID, createHmac, createHash } = require("crypto");
const dgram = require("dgram");
const os = require("os");
const { createClusterReplication } = require("./cluster-replication.cjs");

const DEFAULT_PORT = 3847;
/** UDP — ağda sunucu keşfi (istemci yayına sorar, sunucu yanıtlar) */
const DISCOVERY_UDP_PORT = 3850;
const HISTORY_LIMIT = 500;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function conversationId(uuidA, uuidB) {
  const [x, y] = [String(uuidA || ""), String(uuidB || "")].sort();
  return `dm:${x}:${y}`;
}

/** sql.js satır kimliği → JSON/socket için güvenli sayı (BigInt / yapılandırılmış klon uyumu) */
function lastInsertRowId(idRow) {
  const raw = idRow[0]?.values[0]?.[0];
  if (raw == null) return raw;
  if (typeof raw === "bigint") return Number(raw);
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
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
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg_id ON messages(client_msg_id)");
  return { SQL, db };
}

function persistDb(dbPath, db) {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function getLanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

function signClusterPayload(payload, sharedSecret) {
  const json = JSON.stringify(payload || {});
  return createHmac("sha256", String(sharedSecret || ""))
    .update(json)
    .digest("hex");
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

async function createChatServer(options) {
  const dataDir = options.dataDir;
  ensureDir(dataDir);
  const uploadsDir = path.join(dataDir, "uploads");
  ensureDir(uploadsDir);

  const dbPath = path.join(dataDir, "messages.db");
  const { db } = await initDb(dbPath);

  const saveDb = () => persistDb(dbPath, db);
  const cluster = options.cluster || {};
  const clusterState = {
    clusterEnabled: cluster.clusterEnabled !== false,
    clusterId: String(cluster.clusterId || "kobichat-lan"),
    nodeId: String(cluster.nodeId || randomUUID()),
    sharedSecret: String(cluster.sharedSecret || ""),
    getRole: typeof cluster.getRole === "function" ? cluster.getRole : () => "leader",
    getTerm: typeof cluster.getTerm === "function" ? cluster.getTerm : () => 0,
    getLeaseUntil: typeof cluster.getLeaseUntil === "function" ? cluster.getLeaseUntil : () => Date.now() + 4000
  };
  const repl = createClusterReplication({
    db,
    saveDb,
    nodeId: clusterState.nodeId,
    quorumSize: 1
  });

  function ensureLeader(socket) {
    if (!clusterState.clusterEnabled) return true;
    const role = clusterState.getRole();
    const leaseUntil = Number(clusterState.getLeaseUntil()) || 0;
    if ((role !== "leader" && role !== "candidate") || leaseUntil <= Date.now()) {
      if (socket?.emit) {
        socket.emit("message:error", { m: "Yazma işlemi için lider düğüm aktif değil." });
      }
      return false;
    }
    return true;
  }

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "2mb" }));

  const staticDir = options.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
  }

  app.use("/files", express.static(uploadsDir, { fallthrough: false }));

  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, uploadsDir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname) || "";
      cb(null, `${randomUUID()}${ext}`);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: 80 * 1024 * 1024 }
  });

  /** @type {import('socket.io').Server | null} */
  let ioRef = null;
  /** @type {import('dgram').Socket | null} */
  let discoverySocket = null;

  /** socket.id değişince (yeniden bağlantı) sohbet penceresindeki eski peerId geçersiz kalır; clientUuid ile güncel oturumu buluruz */
  const presence = new Map();

  function resolvePeerSocketId(toSocketId, peerClientUuid) {
    const targetUuid = String(peerClientUuid || "").trim();
    if (!targetUuid) return null;
    const hint = String(toSocketId || "").trim();
    if (hint && presence.has(hint)) {
      const row = presence.get(hint);
      if (row && String(row.clientUuid || "").trim() === targetUuid) {
        return hint;
      }
    }
    for (const [id, data] of presence.entries()) {
      if (String(data.clientUuid || "").trim() === targetUuid) {
        return id;
      }
    }
    return null;
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
      client_msg_id: obj.client_msg_id || null
    };
  }

  function hasMessageByClientMsgId(clientMsgId) {
    const stmt = db.prepare("SELECT id FROM messages WHERE client_msg_id = ?");
    stmt.bind([String(clientMsgId || "")]);
    const has = stmt.step();
    stmt.free();
    return has;
  }

  function loadHistoryForConv(convId) {
    const stmt = db.prepare(`
      SELECT id, sender, kind, text_content, file_name, file_rel, file_mime, file_size, created_at, conv_id, from_socket_id
             , file_sha256, client_msg_id
      FROM messages
      WHERE conv_id = ?
      ORDER BY id ASC
      LIMIT ?
    `);
    stmt.bind([convId, HISTORY_LIMIT]);
    const rows = [];
    while (stmt.step()) {
      rows.push(mapRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  app.post("/api/upload", upload.single("file"), async (req, res) => {
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
      const fromSocketId = String(req.body.fromSocketId || "").trim();
      const toSocketId = String(req.body.toSocketId || "").trim();
      const clientUuid = String(req.body.clientUuid || "").trim();
      const peerClientUuid = String(req.body.peerClientUuid || "").trim();
      if (!fromSocketId || !clientUuid || !peerClientUuid) {
        res.status(400).json({ error: "Eksik alan (özel sohbet için gerekli)" });
        return;
      }
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      const convId = conversationId(clientUuid, peerClientUuid);
      const createdAt = new Date().toISOString();
      const rel = req.file.filename;
      const fileSha256 = await computeFileSha256(req.file.path);
      const clientMsgId = String(req.body.clientMsgId || randomUUID()).trim().slice(0, 120);
      if (hasMessageByClientMsgId(clientMsgId)) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      db.run(
        `INSERT INTO messages (sender, kind, text_content, file_name, file_rel, file_mime, file_size, file_sha256, created_at, conv_id, from_socket_id, client_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sender,
          "file",
          null,
          req.file.originalname || req.file.filename,
          rel,
          req.file.mimetype || "application/octet-stream",
          req.file.size,
          fileSha256,
          createdAt,
          convId,
          fromSocketId,
          clientMsgId
        ]
      );
      const idRow = db.exec("SELECT last_insert_rowid() as id");
      const id = lastInsertRowId(idRow);
      const payload = {
        id,
        sender,
        kind: "file",
        text_content: null,
        file_name: req.file.originalname || req.file.filename,
        file_rel: rel,
        file_mime: req.file.mimetype || "application/octet-stream",
        file_size: req.file.size,
        file_sha256: fileSha256,
        created_at: createdAt,
        conv_id: convId,
        from_socket_id: fromSocketId,
        from_client_uuid: clientUuid,
        client_msg_id: clientMsgId
      };
      repl.appendLog({
        logType: "file-message",
        idempotencyKey: clientMsgId,
        payload,
        term: clusterState.getTerm()
      });
      if (ioRef) {
        if (resolvedTo) {
          ioRef.to(resolvedTo).emit("message:new", payload);
        }
        ioRef.to(fromSocketId).emit("message:new", payload);
      }
      setImmediate(() => {
        try {
          saveDb();
        } catch (e) {
          console.error("saveDb (upload):", e);
        }
      });
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
    perMessageDeflate: false
  });
  ioRef = io;

  function normalizeStatus(s) {
    const x = String(s || "").toLowerCase();
    if (x === "busy" || x === "mesgul") return "busy";
    if (x === "away" || x === "disarida") return "away";
    return "available";
  }

  function rosterPayload() {
    const users = [];
    for (const [id, data] of presence.entries()) {
      users.push({
        id,
        displayName: data.displayName,
        clientUuid: data.clientUuid || "",
        status: data.status || "available",
        profileImage: data.profileImage || ""
      });
    }
    users.sort((a, b) => a.displayName.localeCompare(b.displayName, "tr"));
    return { users };
  }

  function broadcastRoster() {
    io.emit("presence:roster", rosterPayload());
  }

  io.on("connection", (socket) => {
    socket.emit("presence:roster", rosterPayload());

    socket.on("presence:join", (data) => {
      const name =
        typeof data?.displayName === "string" ? data.displayName.slice(0, 21) : "Anonim";
      const clientUuid =
        typeof data?.clientUuid === "string" ? data.clientUuid.slice(0, 80).trim() : "";
      const status = normalizeStatus(data?.status);
      const profileImageRaw =
        typeof data?.profileImage === "string" ? data.profileImage.trim().slice(0, 400000) : "";
      const profileImage = profileImageRaw.startsWith("data:image/") ? profileImageRaw : "";
      presence.set(socket.id, {
        displayName: name.trim() || "Anonim",
        clientUuid,
        status,
        profileImage
      });
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
      if (!ensureLeader(socket)) return;
      const senderSocketId = typeof data?.senderSocketId === "string" ? data.senderSocketId.trim() : "";
      const messageId = data?.messageId;
      if (!senderSocketId || messageId == null) return;
      repl.recordStatusEvent({
        eventKey: `ack:${messageId}:${senderSocketId}`,
        messageId,
        convId: typeof data?.conv_id === "string" ? data.conv_id : undefined,
        status: "delivered",
        readerSocketId: socket.id,
        senderSocketId
      });
      io.to(senderSocketId).emit("message:status", {
        messageId,
        status: "delivered",
        conv_id: typeof data?.conv_id === "string" ? data.conv_id : undefined
      });
    });

    socket.on("message:read", (data) => {
      if (!ensureLeader(socket)) return;
      const senderSocketId = typeof data?.senderSocketId === "string" ? data.senderSocketId.trim() : "";
      const messageId = data?.messageId;
      if (!senderSocketId || messageId == null) return;
      repl.recordStatusEvent({
        eventKey: `read:${messageId}:${senderSocketId}`,
        messageId,
        convId: typeof data?.conv_id === "string" ? data.conv_id : undefined,
        status: "read",
        readerSocketId: socket.id,
        senderSocketId
      });
      io.to(senderSocketId).emit("message:status", {
        messageId,
        status: "read",
        conv_id: typeof data?.conv_id === "string" ? data.conv_id : undefined
      });
    });

    socket.on("dm:open", (data) => {
      const peerSocketId = typeof data?.peerSocketId === "string" ? data.peerSocketId : "";
      const peerClientUuid = typeof data?.peerClientUuid === "string" ? data.peerClientUuid : "";
      const myClientUuid = typeof data?.myClientUuid === "string" ? data.myClientUuid : "";
      if (!peerSocketId || !peerClientUuid || !myClientUuid) {
        socket.emit("history", { messages: [], convId: null, error: "Eksik dm:open alanları" });
        return;
      }
      const convId = conversationId(myClientUuid, peerClientUuid);
      const messages = loadHistoryForConv(convId);
      socket.emit("history", { messages, convId });
    });

    socket.on("chat:message", (data) => {
      if (!ensureLeader(socket)) return;
      const text = typeof data?.text === "string" ? data.text : "";
      const sender = typeof data?.displayName === "string" ? data.displayName.slice(0, 21) : "Anonim";
      const toSocketId = typeof data?.toSocketId === "string" ? data.toSocketId : "";
      const peerClientUuid = typeof data?.peerClientUuid === "string" ? data.peerClientUuid : "";
      const myClientUuid = typeof data?.clientUuid === "string" ? data.clientUuid : "";
      if (!text.trim()) return;
      if (!peerClientUuid || !myClientUuid) {
        socket.emit("message:error", { m: "Alıcı seçilmedi veya eksik bilgi" });
        return;
      }
      const resolvedTo = resolvePeerSocketId(toSocketId, peerClientUuid);
      if (!resolvedTo) {
        socket.emit("message:error", { m: "Karşı taraf çevrimiçi değil" });
        return;
      }
      const convId = conversationId(myClientUuid, peerClientUuid);
      const createdAt = new Date().toISOString();
      const clientMsgId = String(data?.clientMsgId || randomUUID()).trim().slice(0, 120);
      if (hasMessageByClientMsgId(clientMsgId)) return;
      db.run(
        `INSERT INTO messages (sender, kind, text_content, file_name, file_rel, file_mime, file_size, file_sha256, created_at, conv_id, from_socket_id, client_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sender, "text", text, null, null, null, null, null, createdAt, convId, socket.id, clientMsgId]
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
        client_msg_id: clientMsgId
      };
      repl.appendLog({
        logType: "text-message",
        idempotencyKey: clientMsgId,
        payload,
        term: clusterState.getTerm()
      });
      io.to(resolvedTo).emit("message:new", payload);
      socket.emit("message:new", payload);
      setImmediate(() => {
        try {
          saveDb();
        } catch (e) {
          console.error("saveDb (chat:message):", e);
        }
      });
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
      if (!requester || requester.clientUuid !== peerClientUuid) return;
      const responder = presence.get(socket.id);
      if (!responder || responder.clientUuid !== myClientUuid) return;
      io.to(resolvedTo).emit("remotecontrol:result", {
        requestId,
        accepted,
        responderDisplayName: responder.displayName || "Anonim",
        responderClientUuid: myClientUuid
      });
    });

    socket.on("disconnect", () => {
      presence.delete(socket.id);
      broadcastRoster();
    });
  });

  /** Yerel takvim gününe göre: bugün değilse iletilen dosya eklerini diskten ve kayıttan düşürür. */
  function purgeExpiredFileAttachments() {
    const now = new Date();
    const ty = now.getFullYear();
    const tm = now.getMonth();
    const td = now.getDate();
    const stmt = db.prepare(
      `SELECT id, file_rel, created_at FROM messages WHERE kind = 'file' AND file_rel IS NOT NULL AND file_rel != ''`
    );
    const idsToClear = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const rel = String(row.file_rel || "").trim();
      if (!rel) continue;
      const d = new Date(row.created_at);
      if (Number.isNaN(d.getTime())) continue;
      const isToday =
        d.getFullYear() === ty && d.getMonth() === tm && d.getDate() === td;
      if (isToday) continue;
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
    };
    run();
    setInterval(run, 60 * 60 * 1000);
  }

  function startDiscovery(httpPort) {
    if (discoverySocket) {
      try {
        discoverySocket.close();
      } catch {
        // ignored
      }
      discoverySocket = null;
    }
    try {
      discoverySocket = dgram.createSocket("udp4");
      discoverySocket.on("error", (err) => {
        console.error("Keşif UDP:", err.message);
      });
      discoverySocket.bind(DISCOVERY_UDP_PORT, "0.0.0.0", () => {
        console.log(`KobiChat keşif dinleniyor: UDP ${DISCOVERY_UDP_PORT} → HTTP ${httpPort}`);
      });
      discoverySocket.on("message", (msg, rinfo) => {
        try {
          const o = JSON.parse(msg.toString());
          if (o.t === "kobichat-discover" && Number(o.v) === 1) {
            if (o.clusterId && String(o.clusterId) !== clusterState.clusterId) return;
            if (clusterState.sharedSecret) {
              const check = {
                t: o.t,
                v: Number(o.v) || 1,
                clusterId: String(o.clusterId || ""),
                nodeId: String(o.nodeId || ""),
                nonce: String(o.nonce || "")
              };
              const expectedSig = signClusterPayload(check, clusterState.sharedSecret);
              if (String(o.signature || "") !== expectedSig) return;
            }
            const host = getLanIPv4();
            const payload = {
              t: "kobichat-offer",
              v: 1,
              host,
              httpPort,
              clusterId: clusterState.clusterId,
              nodeId: clusterState.nodeId,
              role: clusterState.getRole(),
              term: Number(clusterState.getTerm()) || 0,
              leaseUntil: Number(clusterState.getLeaseUntil()) || Date.now() + 4000,
              ts: Date.now()
            };
            payload.signature = clusterState.sharedSecret
              ? signClusterPayload(
                  {
                    t: payload.t,
                    v: payload.v,
                    host: payload.host,
                    httpPort: payload.httpPort,
                    clusterId: payload.clusterId,
                    nodeId: payload.nodeId,
                    role: payload.role,
                    term: payload.term,
                    leaseUntil: payload.leaseUntil,
                    ts: payload.ts
                  },
                  clusterState.sharedSecret
                )
              : "";
            const reply = Buffer.from(JSON.stringify(payload));
            discoverySocket.send(reply, rinfo.port, rinfo.address, () => {});
          }
        } catch {
          // ignored
        }
      });
    } catch (e) {
      console.error("Keşif başlatılamadı:", e?.message || e);
    }
  }

  return {
    app,
    server,
    io,
    listen(host, port, cb) {
      server.listen(port, host, () => {
        const addr = server.address();
        const p = addr && typeof addr === "object" && addr.port ? addr.port : port;
        startDiscovery(p);
        scheduleFilePurge();
        if (cb) cb();
      });
    },
    close(cb) {
      if (discoverySocket) {
        try {
          discoverySocket.close();
        } catch {
          // ignored
        }
        discoverySocket = null;
      }
      try {
        saveDb();
        db.close();
      } catch {
        // ignored
      }
      io.close(() => {
        server.close(() => {
          if (cb) cb();
        });
      });
    },
    getClusterState() {
      return {
        clusterId: clusterState.clusterId,
        nodeId: clusterState.nodeId,
        role: clusterState.getRole(),
        term: Number(clusterState.getTerm()) || 0,
        leaseUntil: Number(clusterState.getLeaseUntil()) || 0
      };
    }
  };
}

async function main() {
  const dataDir = path.join(__dirname, "..", "data");
  const staticDir = path.join(__dirname, "..", "dist", "web");
  const chat = await createChatServer({ dataDir, staticDir });
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || "0.0.0.0";
  chat.listen(host, port, () => {
    console.log(`KobiChat sunucusu http://${host}:${port}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createChatServer, DEFAULT_PORT, DISCOVERY_UDP_PORT };
