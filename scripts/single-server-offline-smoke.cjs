/**
 * Tek merkezi sunucu: çevrimdışı alıcıda kuyruk + yeniden bağlanınca flush + client_msg_id idempotent.
 * Çalıştır: node scripts/single-server-offline-smoke.cjs
 */
const path = require("path");
const fs = require("fs");
const { io } = require("socket.io-client");
const { createChatServer } = require("../server/chat-server.cjs");

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dataDir = path.join(__dirname, "..", "data", `_smoke-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const chat = await createChatServer({ dataDir, staticDir: null });
  await new Promise((resolve, reject) => {
    chat.server.once("error", reject);
    chat.listen("127.0.0.1", 0, () => resolve());
  });
  const addr = chat.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3847;
  const url = `http://127.0.0.1:${port}`;

  const uuidA = `smoke-a-${Date.now()}`;
  const uuidB = `smoke-b-${Date.now()}`;

  const a = io(url, { transports: ["websocket"], reconnection: false });
  const b = io(url, { transports: ["websocket"], reconnection: false });
  await Promise.all([
    new Promise((res, rej) => {
      a.once("connect_error", rej);
      a.once("connect", res);
    }),
    new Promise((res, rej) => {
      b.once("connect_error", rej);
      b.once("connect", res);
    })
  ]);

  a.emit("presence:join", { displayName: "A", clientUuid: uuidA, status: "available", profileImage: "" });
  b.emit("presence:join", { displayName: "B", clientUuid: uuidB, status: "available", profileImage: "" });
  await waitMs(120);

  b.removeAllListeners();
  b.close();
  await waitMs(150);

  const fromA = [];
  a.on("message:new", (m) => {
    if (String(m.from_client_uuid || "") === uuidA) fromA.push(m);
  });

  const cmid = `smoke-cmid-${Date.now()}`;
  a.emit("chat:message", {
    text: "hello-offline-queue",
    displayName: "A",
    clientUuid: uuidA,
    toSocketId: "",
    peerClientUuid: uuidB,
    clientMsgId: cmid
  });
  await waitMs(200);
  if (fromA.length !== 1) throw new Error(`expected 1 own message:new, got ${fromA.length}`);
  if (String(fromA[0].delivery_state) !== "queued") {
    throw new Error(`expected delivery_state queued, got ${fromA[0].delivery_state}`);
  }

  a.emit("chat:message", {
    text: "duplicate",
    displayName: "A",
    clientUuid: uuidA,
    toSocketId: "",
    peerClientUuid: uuidB,
    clientMsgId: cmid
  });
  await waitMs(80);
  if (fromA.length !== 1) throw new Error("duplicate client_msg_id should not emit second message:new");

  const b2 = io(url, { transports: ["websocket"], reconnection: false });
  await new Promise((res, rej) => {
    b2.once("connect_error", rej);
    b2.once("connect", res);
  });
  const toB = [];
  b2.on("message:new", (m) => {
    if (String(m.text_content || "") === "hello-offline-queue") toB.push(m);
  });
  b2.emit("presence:join", { displayName: "B", clientUuid: uuidB, status: "available", profileImage: "" });
  await waitMs(350);
  if (toB.length !== 1) throw new Error(`B expected 1 flushed message, got ${toB.length}`);
  if (String(toB[0].delivery_state) !== "sent") {
    throw new Error(`B expected delivery_state sent after flush, got ${toB[0].delivery_state}`);
  }

  a.removeAllListeners();
  a.close();
  b2.removeAllListeners();
  b2.close();
  await waitMs(80);
  await new Promise((res) => chat.close(res));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignored
  }
  console.log("single-server-offline-smoke OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
