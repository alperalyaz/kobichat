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
