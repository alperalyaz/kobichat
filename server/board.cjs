const os = require("os");
const https = require("https");
const crypto = require("crypto");

/**
 * Pano (KobiTools'tan taşındı): notlar, günün menüsü, döviz kurları, uygulama
 * kısayolları, zamanlı bildirimler ve şok bildirim. Tümü yerel SQLite'ta durur;
 * internet yalnızca kurlar "Otomatik" moddayken kullanılır.
 *
 * Yetki: pano yalnızca sunucuyu çalıştıran bilgisayardan düzenlenir. Soketin uzak
 * adresi loopback ya da bu makinenin kendi ağ adreslerinden biriyse düzenleme açıktır.
 */

const RATES_URL = "https://open.er-api.com/v6/latest/USD";
const RATES_INTERVAL_MS = 30 * 60 * 1000;
const SCHEDULE_TICK_MS = 15 * 1000;

const NOTE_KINDS = ["", "info", "warning", "important", "success", "note"];
const SCHED_KINDS = ["work", "celebrate", "birthday", "info", "announce", "thanks", "success"];

const MAX_NOTES = 50;
const MAX_APPS = 24;
const MAX_SCHEDULES = 60;
const MEAL_IMAGE_MAX = 1_500_000;

const DEFAULTS = {
  notes: [],
  meal: { text: "", image: "", monthly: "" },
  rates: { mode: "off", base: "TRY", codes: ["USD", "EUR", "GBP"], values: {}, fetchedAt: "", error: "" },
  apps: [],
  schedules: []
};

function str(v, max) {
  return String(v ?? "").slice(0, max);
}

function newId() {
  return crypto.randomUUID();
}

function cleanId(v) {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(s) ? s : newId();
}

function sanitizeNotes(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_NOTES).map((n) => ({
    id: cleanId(n?.id),
    kind: NOTE_KINDS.includes(n?.kind) ? n.kind : "",
    title: str(n?.title, 120).trim(),
    body: str(n?.body, 2000),
    pinned: Boolean(n?.pinned),
    createdAt: str(n?.createdAt, 40) || new Date().toISOString()
  }));
}

function sanitizeMeal(m) {
  const image = String(m?.image ?? "");
  return {
    text: str(m?.text, 500),
    image: image.startsWith("data:image/") && image.length <= MEAL_IMAGE_MAX ? image : "",
    monthly: str(m?.monthly, 20000)
  };
}

function sanitizeCode(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : "";
}

function sanitizeApps(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, MAX_APPS)) {
    const kind = a?.kind === "local" ? "local" : "web";
    const url = str(a?.url, 1000).trim();
    if (kind === "web" && url && !/^https?:\/\//i.test(url)) continue;
    out.push({
      id: cleanId(a?.id),
      name: str(a?.name, 40).trim(),
      kind,
      url: kind === "web" ? url : "",
      icon: str(a?.icon, 8).trim()
    });
  }
  return out;
}

function sanitizeSchedules(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SCHEDULES).map((s) => {
    const days = Array.isArray(s?.days)
      ? [...new Set(s.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s?.time ?? "")) ? s.time : "09:00";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(s?.date ?? "")) ? s.date : "";
    return {
      id: cleanId(s?.id),
      kind: SCHED_KINDS.includes(s?.kind) ? s.kind : "info",
      title: str(s?.title, 120).trim(),
      body: str(s?.body, 1000),
      time,
      days,
      date,
      enabled: s?.enabled !== false
    };
  });
}

function normalizeAddr(a) {
  return String(a || "").replace(/^::ffff:/i, "").trim().toLowerCase();
}

function ownAddresses() {
  const set = new Set(["127.0.0.1", "::1", "localhost"]);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) set.add(normalizeAddr(it.address));
    }
  } catch {
    // ignored
  }
  return set;
}

function isServerMachineSocket(socket) {
  const addr = normalizeAddr(socket?.handshake?.address);
  return Boolean(addr) && ownAddresses().has(addr);
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
        if (raw.length > 1_000_000) req.destroy(new Error("too large"));
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function attachBoard({ db, saveDb, io }) {
  db.run(`
    CREATE TABLE IF NOT EXISTS board_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const state = {};
  for (const key of Object.keys(DEFAULTS)) {
    state[key] = JSON.parse(JSON.stringify(DEFAULTS[key]));
  }
  try {
    const stmt = db.prepare("SELECT key, value_json FROM board_kv");
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (!(row.key in DEFAULTS)) continue;
      try {
        const v = JSON.parse(String(row.value_json));
        state[row.key] = Array.isArray(DEFAULTS[row.key]) ? v : { ...DEFAULTS[row.key], ...v };
      } catch {
        // bozuk satır: varsayılan kalır
      }
    }
    stmt.free();
  } catch (e) {
    console.error("board load:", e?.message || e);
  }

  function store(key, value) {
    state[key] = value;
    db.run(
      `INSERT INTO board_kv (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), new Date().toISOString()]
    );
    setImmediate(() => {
      try {
        saveDb();
      } catch (e) {
        console.error("saveDb (board):", e);
      }
    });
    io.emit("board:patch", { key, value });
  }

  let ratesBusy = false;
  async function refreshRates() {
    if (ratesBusy || state.rates.mode !== "auto") return;
    ratesBusy = true;
    const cur = state.rates;
    try {
      const data = await fetchJson(RATES_URL, 10000);
      const r = data?.rates;
      const baseRate = Number(r?.[cur.base]);
      if (!r || !Number.isFinite(baseRate) || baseRate <= 0) throw new Error("bad response");
      const values = {};
      for (const code of cur.codes) {
        const cr = Number(r[code]);
        if (!Number.isFinite(cr) || cr <= 0) continue;
        const value = baseRate / cr;
        const old = cur.values?.[code];
        const prev = old && old.value !== value ? old.value : old?.prev ?? null;
        values[code] = { value, prev };
      }
      store("rates", { ...state.rates, values, fetchedAt: new Date().toISOString(), error: "" });
    } catch (e) {
      store("rates", { ...state.rates, error: String(e?.message || e).slice(0, 120) });
    } finally {
      ratesBusy = false;
    }
  }

  /**
   * Bugün gösterilen zamanlı bildirimler (id|saat). Veritabanında da tutulur ki
   * sunucu aynı dakika içinde yeniden başlarsa bildirim ikinci kez çıkmasın.
   */
  const fired = new Set();
  let firedDay = "";
  try {
    const stmt = db.prepare("SELECT value_json FROM board_kv WHERE key = 'fired'");
    if (stmt.step()) {
      const v = JSON.parse(String(stmt.getAsObject().value_json));
      firedDay = String(v?.day || "");
      for (const k of Array.isArray(v?.keys) ? v.keys : []) fired.add(String(k));
    }
    stmt.free();
  } catch {
    // ignored
  }

  function persistFired() {
    db.run(
      `INSERT INTO board_kv (key, value_json, updated_at) VALUES ('fired', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [JSON.stringify({ day: firedDay, keys: [...fired] }), new Date().toISOString()]
    );
    try {
      saveDb();
    } catch (e) {
      console.error("saveDb (board fired):", e);
    }
  }

  function tickSchedules() {
    const now = new Date();
    const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const hm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    if (day !== firedDay) {
      fired.clear();
      firedDay = day;
    }
    let changed = false;
    for (const s of state.schedules) {
      if (!s.enabled || s.time !== hm) continue;
      const matches = s.date ? s.date === day : s.days.includes(now.getDay());
      if (!matches) continue;
      const key = `${s.id}|${hm}`;
      if (fired.has(key)) continue;
      fired.add(key);
      changed = true;
      io.emit("board:notify", { id: s.id, kind: s.kind, title: s.title, body: s.body });
    }
    if (changed) persistFired();
  }

  let ratesTimer = null;
  let scheduleTimer = null;
  function start() {
    if (!ratesTimer) {
      ratesTimer = setInterval(() => void refreshRates(), RATES_INTERVAL_MS);
      void refreshRates();
    }
    if (!scheduleTimer) scheduleTimer = setInterval(tickSchedules, SCHEDULE_TICK_MS);
  }
  function stop() {
    if (ratesTimer) clearInterval(ratesTimer);
    if (scheduleTimer) clearInterval(scheduleTimer);
    ratesTimer = null;
    scheduleTimer = null;
  }

  function onConnection(socket) {
    /** Tam durum yalnızca pano penceresi isteyince; liste penceresi yalnızca değişiklik olaylarını alır. */
    socket.on("board:get", () => {
      socket.emit("board:state", { ...state, canEdit: isServerMachineSocket(socket) });
    });

    const guard = (fn) => (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!isServerMachineSocket(socket)) {
        reply({ ok: false, error: "forbidden" });
        return;
      }
      try {
        fn(payload || {});
        reply({ ok: true });
      } catch (e) {
        console.error("board:", e?.message || e);
        reply({ ok: false, error: "failed" });
      }
    };

    socket.on(
      "board:set",
      guard(({ key, value }) => {
        if (key === "notes") store("notes", sanitizeNotes(value));
        else if (key === "meal") store("meal", sanitizeMeal(value));
        else if (key === "apps") store("apps", sanitizeApps(value));
        else if (key === "schedules") store("schedules", sanitizeSchedules(value));
        else if (key === "rates") {
          const mode = value?.mode === "auto" ? "auto" : "off";
          const base = sanitizeCode(value?.base) || "TRY";
          const codes = Array.isArray(value?.codes)
            ? [...new Set(value.codes.map(sanitizeCode).filter((c) => c && c !== base))].slice(0, 6)
            : state.rates.codes;
          const changed = base !== state.rates.base || codes.join() !== state.rates.codes.join();
          store("rates", {
            ...state.rates,
            mode,
            base,
            codes,
            values: changed ? {} : state.rates.values,
            error: ""
          });
          if (mode === "auto") void refreshRates();
        } else throw new Error("unknown key");
      })
    );

    socket.on(
      "board:rates-refresh",
      guard(() => {
        void refreshRates();
      })
    );

    socket.on(
      "board:shock",
      guard(({ title, body }) => {
        const t = str(title, 120).trim();
        const b = str(body, 1000);
        if (!t && !b.trim()) throw new Error("empty");
        io.emit("board:shock", { id: newId(), title: t, body: b, at: new Date().toISOString() });
      })
    );
  }

  return { onConnection, start, stop };
}

module.exports = { attachBoard };
