const initSqlJs = require("sql.js");
const { createHmac } = require("crypto");
const { createClusterReplication } = require("../server/cluster-replication.cjs");

function sign(payload, secret) {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const saveDb = () => {};
  const repl = createClusterReplication({ db, saveDb, nodeId: "node-a", quorumSize: 1 });

  const a = repl.appendLog({
    logType: "text-message",
    idempotencyKey: "k-1",
    payload: { msg: "hello" },
    term: 1
  });
  const b = repl.appendLog({
    logType: "text-message",
    idempotencyKey: "k-1",
    payload: { msg: "hello" },
    term: 1
  });
  if (!a.ok || a.duplicate) throw new Error("İlk append başarısız");
  if (!b.ok || !b.duplicate) throw new Error("Idempotency duplicate koruması başarısız");

  const body = { t: "kobichat-discover", v: 1, clusterId: "c1", nodeId: "n1", nonce: "abc" };
  const s1 = sign(body, "sec");
  const s2 = sign(body, "sec");
  const s3 = sign({ ...body, nonce: "xyz" }, "sec");
  if (s1 !== s2) throw new Error("İmza deterministik değil");
  if (s1 === s3) throw new Error("İmza değişen içerikte aynı kaldı");

  console.log("cluster-hardening-check: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

