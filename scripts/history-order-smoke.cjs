/**
 * DM geçmişi: sunucu en son N mesajı kronolojik döndürmeli (en eski ilk kayıtlar değil).
 * Çalıştır: node scripts/history-order-smoke.cjs
 */
const path = require("path");
const fs = require("fs");

const prevLimit = process.env.KOBICHAT_HISTORY_LIMIT;
const prevBurst = process.env.KOBICHAT_DM_SEND_BURST;
process.env.KOBICHAT_HISTORY_LIMIT = "100";
process.env.KOBICHAT_DM_SEND_BURST = "200";

const { io } = require("socket.io-client");
const { createChatServer } = require("../server/chat-server.cjs");

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dataDir = path.join(__dirname, "..", "data", `_hist-smoke-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const chat = await createChatServer({ dataDir, staticDir: null });
  await new Promise((resolve, reject) => {
    chat.server.once("error", reject);
    chat.listen("127.0.0.1", 0, () => resolve());
  });
  const addr = chat.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 3847;
  const url = `http://127.0.0.1:${port}`;

  const uuidA = `hist-a-${Date.now()}`;
  const uuidB = `hist-b-${Date.now()}`;

  const a = io(url, { transports: ["websocket"], reconnection: false });
  await new Promise((res, rej) => {
    a.once("connect_error", rej);
    a.once("connect", res);
  });
  a.emit("presence:join", { displayName: "A", clientUuid: uuidA, status: "available", profileImage: "" });
  await waitMs(80);

  for (let i = 0; i < 120; i++) {
    a.emit("chat:message", {
      text: `msg-${i}`,
      displayName: "A",
      clientUuid: uuidA,
      toSocketId: "",
      peerClientUuid: uuidB,
      clientMsgId: `cmid-hist-${i}`
    });
    if (i % 10 === 9) await waitMs(15);
  }
  await waitMs(300);

  const historyPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("history timeout")), 8000);
    a.once("history", (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });

  a.emit("dm:open", { peerClientUuid: uuidB, myClientUuid: uuidA });
  const payload = await historyPromise;
  const messages = payload?.messages || [];
  if (messages.length !== 100) {
    throw new Error(`expected 100 messages (HISTORY_LIMIT), got ${messages.length}`);
  }
  const first = messages[0];
  const last = messages[messages.length - 1];
  // Tam eşleşme: substring `includes("msg-20")` aynı zamanda "msg-200" vb.
  // ile de eşleşirdi (kırılgan yanlış-pozitif). Birebir karşılaştır.
  if (String(first?.text_content || "") !== "msg-20") {
    throw new Error(`expected oldest in window msg-20, got ${first?.text_content}`);
  }
  if (String(last?.text_content || "") !== "msg-119") {
    throw new Error(`expected newest msg-119, got ${last?.text_content}`);
  }
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].id < messages[i - 1].id) {
      throw new Error("messages not in ascending id order");
    }
  }

  a.close();
  await new Promise((r) => chat.close(r));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ignored
  }
  console.log("history-order-smoke: OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    if (prevLimit === undefined) delete process.env.KOBICHAT_HISTORY_LIMIT;
    else process.env.KOBICHAT_HISTORY_LIMIT = prevLimit;
    if (prevBurst === undefined) delete process.env.KOBICHAT_DM_SEND_BURST;
    else process.env.KOBICHAT_DM_SEND_BURST = prevBurst;
  });
