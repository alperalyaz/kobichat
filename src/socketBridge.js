/**
 * Yerel çoklu pencere köprüsü (Electron / tarayıcı)
 *
 * Protokol: KOBI_BRIDGE kanalı üzerinden JSON payload.
 * - Yalnızca liste (roster) penceresinde gerçek socket.io bağlantısı vardır.
 * - `message:new` sunucudan gelir → roster `postToChatWindows({ type: 'socket:message:new', msg })`
 *   ile tüm sohbet pencerelerine senkron yayınlanır (IPC relay veya BroadcastChannel).
 * - Sohbet → roster: `chat:send-text`, `chat:register`, `chat:dm-open` vb.
 *
 * Anlık iletişim: Socket.IO `message:new` → hemen relay; sunucu tarafında kalıcılık
 * `setImmediate(saveDb)` ile emit’ten hemen sonra ayrı kuyrukta yapılır.
 */
export const KOBI_BRIDGE = "kobi-chat-socket-v1";

function safeFn(fn) {
  return typeof fn === "function" ? fn : () => {};
}

/**
 * Roster/chat pencereleri arasında tek API ile haberleşme sağlar.
 * Electron IPC varsa onu, yoksa BroadcastChannel kullanır.
 */
export function createSocketBridge() {
  const electron = window.kobiChat;
  if (electron?.sendToRoster && electron?.onRelayBroadcast) {
    return {
      postMessage(payload) {
        electron.sendToRoster(payload);
      },
      subscribe(handler) {
        return safeFn(electron.onRelayBroadcast(handler));
      },
      close() {}
    };
  }

  const ch = new BroadcastChannel(KOBI_BRIDGE);
  return {
    postMessage(payload) {
      ch.postMessage(payload);
    },
    subscribe(handler) {
      const onMessage = (ev) => handler(ev.data);
      ch.addEventListener("message", onMessage);
      return () => ch.removeEventListener("message", onMessage);
    },
    close() {
      try {
        ch.close();
      } catch {
        // ignored
      }
    }
  };
}
