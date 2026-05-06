const crypto = require("crypto");

/**
 * Basit durable log + idempotency katmanı.
 * Not: Bu sürüm tek düğümde quorum=1 çalışır; API çok düğümlü replikasyona hazırdır.
 */
function createClusterReplication({ db, saveDb, nodeId, quorumSize = 1 }) {
  const me = String(nodeId || "node-unknown");
  const quorum = Number.isFinite(quorumSize) && quorumSize > 0 ? Math.floor(quorumSize) : 1;

  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_key TEXT NOT NULL UNIQUE,
      log_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      term INTEGER NOT NULL DEFAULT 0,
      leader_node_id TEXT NOT NULL,
      ack_count INTEGER NOT NULL DEFAULT 1,
      committed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cluster_log_term_id ON cluster_log(term, id);

    CREATE TABLE IF NOT EXISTS message_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      message_id INTEGER NOT NULL,
      conv_id TEXT,
      status TEXT NOT NULL,
      reader_socket_id TEXT,
      sender_socket_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  function stableJson(x) {
    return JSON.stringify(x ?? {});
  }

  function appendLog({ logType, idempotencyKey, payload, term = 0 }) {
    const now = new Date().toISOString();
    const body = stableJson(payload);
    const key =
      String(idempotencyKey || "").trim() ||
      crypto.createHash("sha256").update(`${logType}|${body}`).digest("hex");

    const check = db.prepare("SELECT id FROM cluster_log WHERE log_key = ?");
    check.bind([key]);
    const has = check.step();
    check.free();
    if (has) {
      return { ok: true, duplicate: true, key };
    }

    db.run(
      `INSERT INTO cluster_log (log_key, log_type, payload_json, term, leader_node_id, ack_count, committed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, String(logType || "unknown"), body, Number(term) || 0, me, quorum, 1, now]
    );
    saveDb();
    return { ok: true, duplicate: false, key };
  }

  function recordStatusEvent({
    eventKey,
    messageId,
    convId,
    status,
    readerSocketId,
    senderSocketId
  }) {
    const k = String(eventKey || "").trim();
    if (!k || messageId == null) return { ok: false };
    const check = db.prepare("SELECT id FROM message_status_events WHERE event_key = ?");
    check.bind([k]);
    const has = check.step();
    check.free();
    if (has) return { ok: true, duplicate: true };
    db.run(
      `INSERT INTO message_status_events
       (event_key, message_id, conv_id, status, reader_socket_id, sender_socket_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        k,
        Number(messageId),
        convId ? String(convId) : null,
        String(status || ""),
        readerSocketId ? String(readerSocketId) : null,
        senderSocketId ? String(senderSocketId) : null,
        new Date().toISOString()
      ]
    );
    saveDb();
    return { ok: true, duplicate: false };
  }

  return {
    quorum,
    appendLog,
    recordStatusEvent
  };
}

module.exports = { createClusterReplication };

