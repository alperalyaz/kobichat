/**
 * KobiChat — merkezi ses motoru.
 *
 * Tek bir API üzerinden olay-bazlı ses çalar:
 *   playSound("messageIncomingAlert")
 *
 * - Kategori bazlı açma/kapama (`message`, `file`, `system`, `presence`)
 * - Ses seviyesine koddan müdahale etmez (dosyanın doğal seviyesi)
 * - Aynı olayın hızlı tekrarı için debounce/throttle
 * - Ses dosyalarını fetch + Blob ile bir kez indirir, ardından `blob:` URL üzerinden
 *   çalar. Bu sayede Electron/Chromium media decoder cache'i bypass edilir; aynı
 *   dosya adıyla geçmişte farklı içerik servis edildiyse "yanlış ses" oynatma
 *   bug'ı çözülmüş olur.
 * - Electron veya saf web fark etmeksizin `<base>/assets/sounds/<dosya>` üzerinden çalışır
 *
 * Settings okuma stratejisi:
 *   - Electron: `window.kobiChat.getSettings()` üzerinden bir kez oku, `onConfigUpdated` ile
 *     güncel kalır. Doğrulama için fallback olarak `localStorage` da okur (saf web/web sürümü).
 *   - Saf web: `localStorage.kobiChatWebSettings` JSON'u.
 *
 * Bu modül "sessizce çalışır": ses çalınamaz/dosya yoksa hata fırlatmaz.
 */

const WEB_SETTINGS_KEY = "kobiChatWebSettings";

/**
 * @typedef {"message" | "file" | "system" | "presence"} SoundCategory
 *
 * @typedef SoundDef
 * @property {string} file        public/assets/sounds/ altındaki dosya adı
 * @property {SoundCategory} category
 * @property {number} volume      Geriye dönük alan; pratikte 1.0 kullanılır
 * @property {number} throttleMs  Aynı olayın bu süre içinde ardışık tetiklenmelerini yutar
 */

/** @type {Record<string, SoundDef>} */
const SOUNDS = {
  /** DM geldi — sohbet penceresi KAPALI */
  messageIncomingAlert: { file: "1.mp3", category: "message", volume: 1, throttleMs: 250 },
  /** DM geldi — sohbet penceresi AÇIK */
  messageIncomingSoft: { file: "2.mp3", category: "message", volume: 1, throttleMs: 200 },
  /** Mesaj gönderildi (giden) */
  messageSent: { file: "3.mp3", category: "message", volume: 1, throttleMs: 200 },

  /** Dosya/ek geldi — pencere kapalı */
  fileIncoming: { file: "4.mp3", category: "file", volume: 1, throttleMs: 400 },
  /** Uzak titreşim (poke) — dikkat çağrısı */
  pokeIncoming: { file: "15.mp3", category: "message", volume: 1, throttleMs: 2500 },
  /** Dosya gönderildi */
  fileSent: { file: "5.mp3", category: "file", volume: 1, throttleMs: 300 },
  /** İndirme tamamlandı */
  downloadComplete: { file: "6.mp3", category: "file", volume: 1, throttleMs: 400 },

  /** Sunucuya bağlanıldı */
  connected: { file: "7.mp3", category: "system", volume: 1, throttleMs: 1500 },
  /** Sunucudan kopuldu */
  disconnected: { file: "8.mp3", category: "system", volume: 1, throttleMs: 1500 },
  /** Yeniden bağlanma denemesi başarısız oldu */
  reconnectFailed: { file: "9.mp3", category: "system", volume: 1, throttleMs: 5000 },

  /** Birisi online oldu */
  userOnline: { file: "10.mp3", category: "presence", volume: 1, throttleMs: 1500 },
  /** Birisi offline oldu */
  userOffline: { file: "11.mp3", category: "presence", volume: 1, throttleMs: 1500 },

  /** Hata / mesaj gönderilemedi */
  error: { file: "14.mp3", category: "system", volume: 1, throttleMs: 600 },

  /** Yeni güncelleme mevcut */
  updateAvailable: { file: "16.mp3", category: "system", volume: 1, throttleMs: 5000 }
};

/**
 * Ses dosyalarının `blob:` URL cache'i.
 *  - Anahtar: dosya adı ("3.mp3")
 *  - Değer: `URL.createObjectURL(blob)` ile üretilmiş kalıcı blob URL
 *
 * Neden blob URL? Electron'un Chromium tabanlı pencere ortamı, aynı dosya
 * adıyla geçmişte farklı içerik servis edilmişse media decoder cache'inden
 * **eski** veriyi oynatabiliyor (query string `?v=` yenilense de). Blob
 * URL her oturumda yeni ve rastgele olduğu için bu cache'i tümüyle atlatır.
 */
const blobUrlCache = new Map();
/** Yüklenmesi tamamlanmamış preload promise'lerini takip eder. */
const inflightLoads = new Map();
const lastPlayedAt = new Map();

/**
 * @typedef SoundPrefs
 * @property {boolean} enabled                 Master switch
 * @property {Record<SoundCategory, boolean>} categories
 * @property {number} volume                   Master volume 0..1
 */

/** Varsayılan ayarlar — ilk açılışta veya tanımsızsa kullanılır. */
const DEFAULT_PREFS = Object.freeze({
  enabled: true,
  categories: { message: true, file: true, system: true, presence: false },
  volume: 1
});

/** @type {SoundPrefs} */
let currentPrefs = clonePrefs(DEFAULT_PREFS);

function clonePrefs(p) {
  return {
    enabled: p?.enabled !== false,
    categories: {
      message: p?.categories?.message !== false,
      file: p?.categories?.file !== false,
      system: p?.categories?.system !== false,
      presence: p?.categories?.presence === true
    },
    volume: clampVolume(p?.volume)
  };
}

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_PREFS.volume;
  return Math.max(0, Math.min(1, n));
}

/** Sunucu/yerel tarafından gelen ham settings'ten `SoundPrefs` türetir. */
export function readPrefsFromRawSettings(raw) {
  const enabledRaw = raw?.notificationSound;
  const enabled = enabledRaw !== false;
  const cats = raw?.soundCategories || {};
  const vol = raw?.soundVolume;
  return clonePrefs({
    enabled,
    categories: {
      message: cats.message !== false,
      file: cats.file !== false,
      system: cats.system !== false,
      presence: cats.presence === true
    },
    volume: typeof vol === "number" ? vol : DEFAULT_PREFS.volume
  });
}

/** Saf web (localStorage) ortamı için ayar okuma. */
function readWebPrefs() {
  try {
    const raw = localStorage.getItem(WEB_SETTINGS_KEY);
    if (!raw) return clonePrefs(DEFAULT_PREFS);
    const parsed = JSON.parse(raw);
    return readPrefsFromRawSettings(parsed || {});
  } catch {
    return clonePrefs(DEFAULT_PREFS);
  }
}

/** Modül tarafından kullanılacak güncel ayarları yerine koyar. */
export function setSoundPrefs(prefs) {
  currentPrefs = clonePrefs(prefs);
}

export function getSoundPrefs() {
  return clonePrefs(currentPrefs);
}

/**
 * Settings'i Electron veya web ortamından bir kez yükler ve
 * Electron'da yapılandırma değişikliklerini canlı dinler.
 * Çağrı tek seferlik yapılmalı (genelde App'in mount'ında).
 */
export async function bootstrapSoundPrefs() {
  if (typeof window === "undefined") return;
  try {
    if (window.kobiChat?.getSettings) {
      const s = await window.kobiChat.getSettings();
      setSoundPrefs(readPrefsFromRawSettings(s || {}));
      if (typeof window.kobiChat.onConfigUpdated === "function" && !window.__kobiSoundsConfigBound) {
        window.__kobiSoundsConfigBound = true;
        window.kobiChat.onConfigUpdated((cfg) => {
          setSoundPrefs(readPrefsFromRawSettings(cfg || {}));
        });
      }
    } else {
      setSoundPrefs(readWebPrefs());
    }
  } catch {
    setSoundPrefs(readWebPrefs());
  }

  /**
   * Ana pencere ses çalsın diye main process'in yolladığı IPC sinyalini
   * (ör. indirme tamam) tek noktadan yakalar.
   */
  if (
    typeof window.kobiChat?.onPlaySound === "function" &&
    !window.__kobiSoundsRemoteBound
  ) {
    window.__kobiSoundsRemoteBound = true;
    window.kobiChat.onPlaySound((payload) => {
      const name = String(payload?.name || "").trim();
      if (name) playSound(name);
    });
  }
}

/**
 * Oturum bazlı cache buster.
 * Browser ve Vite dev sunucusu, aynı URL ile gelen `<audio>` isteklerini agresif
 * şekilde önbelleğe alabiliyor. Aynı dosya adıyla içerik değiştiğinde
 * (örn. yeni `3.mp3` koyduğunda) eski tampon oynayabiliyor. Bu sebeple URL'e
 * oturum başına sabit bir tag iliştiriyoruz; yeni oturumda yeni tag → yeni indirme.
 */
const CACHE_BUSTER = (() => {
  if (typeof window === "undefined") return String(Date.now());
  if (typeof window.__kobiSoundsCacheBuster === "string") return window.__kobiSoundsCacheBuster;
  const v = String(Date.now());
  window.__kobiSoundsCacheBuster = v;
  return v;
})();

/** İlgili dosyanın tam URL'si (Vite BASE_URL'e saygı duyarak + cache buster). */
function urlFor(file) {
  const rawBase = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
  const base = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
  return `${base}/assets/sounds/${file}?v=${CACHE_BUSTER}`;
}

/**
 * Bir ses dosyasını fetch ile indirir, `Blob` haline getirir ve `blob:` URL
 * üretir. Aynı dosya için tekrar çağrıldığında daha önceden hazırlanmış
 * URL'i döndürür; halen yükleniyorsa aynı promise'i paylaşır.
 *
 * Geri dönüş: `blob:` URL veya hata halinde `null` (fallback için).
 */
function ensureLoaded(def) {
  const cached = blobUrlCache.get(def.file);
  if (cached) return Promise.resolve(cached);
  const inflight = inflightLoads.get(def.file);
  if (inflight) return inflight;

  if (typeof fetch !== "function" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve(null);
  }

  const url = urlFor(def.file);
  /**
   * `cache: "no-store"` Electron Chromium'un media decoder cache'ini ve HTTP
   * cache'ini ikisini birden bypass eder. Sonuçta ortaya çıkan blob, bellekte
   * tek başına yaşar; aynı oturumdaki tüm `play()` çağrıları aynı blob'u
   * paylaşır → ek HTTP isteği olmaz.
   */
  const promise = fetch(url, { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${def.file}`);
      return res.blob();
    })
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      blobUrlCache.set(def.file, blobUrl);
      inflightLoads.delete(def.file);
      return blobUrl;
    })
    .catch((err) => {
      inflightLoads.delete(def.file);
      return null;
    });

  inflightLoads.set(def.file, promise);
  return promise;
}

/** Modül yüklenir yüklenmez tüm sesleri arka planda hazırla. */
export function preloadAllSounds() {
  for (const def of Object.values(SOUNDS)) {
    /** Fire-and-forget; dönüş değeriyle ilgilenmiyoruz. */
    void ensureLoaded(def);
  }
}

/**
 * Tek bir sesi çalar. Bilinmeyen olay → no-op.
 * - Kategori kapalıysa veya master kapalıysa çalmaz.
 * - Throttle sayesinde hızlı ardışık tetiklemeler yutulur.
 */
export function playSound(name) {
  const def = SOUNDS[name];
  if (!def) return;

  const prefs = currentPrefs;
  if (!prefs.enabled) return;
  if (!prefs.categories[def.category]) return;

  const now = Date.now();
  const prev = lastPlayedAt.get(name) || 0;
  if (now - prev < def.throttleMs) return;
  lastPlayedAt.set(name, now);

  /**
   * Strateji:
   *  1) Eğer dosya daha önce blob URL olarak yüklendiyse onu kullan (en hızlı, cache-bypass).
   *  2) Aksi halde fetch ile yükle ve sonra çal (ilk seferinde küçük bir gecikme olur).
   *  3) İkisi de mümkün değilse en son çare olarak doğrudan HTTP URL'inden çalmayı dene.
   */
  const cachedBlobUrl = blobUrlCache.get(def.file);
  const targetVolume = clampVolume(prefs.volume);

  const playFromUrl = (src, srcKind) => {
    try {
      const player = new Audio(src);
      player.preload = "auto";
      player.volume = targetVolume;
      const p = player.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  };

  if (cachedBlobUrl) {
    playFromUrl(cachedBlobUrl, "blob");
    return;
  }

  /**
   * Henüz yüklenmedi: arka planda yükle ve geldiğinde çal. Bu kısa süreli bir
   * gecikme yaratır ama yalnızca sesin ilk kullanımı için söz konusudur, sonraki
   * tüm çağrılar cache'ten anında çalar.
   */
  Promise.resolve(ensureLoaded(def))
    .then((blobUrl) => {
      if (blobUrl) {
        playFromUrl(blobUrl, "blob");
      } else {
        /** En son çare: doğrudan HTTP URL'i. Cache yine eski içeriği oynatabilir. */
        const fallback = urlFor(def.file);
        playFromUrl(fallback, "url");
      }
    })
    .catch(() => {
      const fallback = urlFor(def.file);
      playFromUrl(fallback, "url");
    });
}

/** Modülün dışına dökülmemesi gereken sabitler ama tip kontrolünde kullanılabilir. */
export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));
export const SOUND_CATEGORIES = Object.freeze(["message", "file", "system", "presence"]);
export { DEFAULT_PREFS as DEFAULT_SOUND_PREFS };
