const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kobiChat", {
  hideMainWindow: () => ipcRenderer.invoke("kobichat:hide-main-window"),
  openChatWindow: (payload) => ipcRenderer.invoke("kobichat:open-chat", payload),
  openQuickMessagesWindow: () => ipcRenderer.invoke("kobichat:open-quick-messages"),
  downloadAndHandle: (payload) => ipcRenderer.invoke("kobichat:download-and-handle", payload),
  playNotificationSound: () => ipcRenderer.invoke("kobichat:play-notification-sound"),
  clearAttention: () => ipcRenderer.invoke("kobichat:clear-attention"),
  refreshTrayMenu: () => ipcRenderer.invoke("kobichat:refresh-tray-menu"),
  getConfig: () => ipcRenderer.invoke("kobichat:config"),
  getAppVersion: () => ipcRenderer.invoke("kobichat:app-version"),
  getSettings: () => ipcRenderer.invoke("kobichat:settings:get"),
  saveSettings: (partial) => ipcRenderer.invoke("kobichat:settings:save", partial),
  discoverLan: () => ipcRenderer.invoke("kobichat:discover"),
  onConfigUpdated: (fn) => {
    const handler = (_e, cfg) => fn(cfg);
    ipcRenderer.on("kobichat:config-updated", handler);
    return () => ipcRenderer.removeListener("kobichat:config-updated", handler);
  },
  onTrayPresence: (fn) => {
    const handler = (_e, p) => fn(p);
    ipcRenderer.on("kobichat:presence-tray", handler);
    return () => ipcRenderer.removeListener("kobichat:presence-tray", handler);
  },
  /** Liste penceresi → tüm pencerelere (sohbet) socket olayları */
  relayBroadcast: (payload) => ipcRenderer.send("kobichat:relay-broadcast", payload),
  onRelayBroadcast: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("kobichat:relay-broadcast-in", handler);
    return () => ipcRenderer.removeListener("kobichat:relay-broadcast-in", handler);
  },
  /** Sohbet penceresi → yalnızca liste (socket köprüsü) */
  sendToRoster: (payload) => ipcRenderer.send("kobichat:send-to-roster", payload),
  onBridgeFromChat: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("kobichat:bridge-from-chat", handler);
    return () => ipcRenderer.removeListener("kobichat:bridge-from-chat", handler);
  },
  /** Aynı kişi için pencere yeniden kullanıldığında güncel socket id (yeniden bağlanma) */
  onChatPeerSocket: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("kobichat:chat-peer-socket", handler);
    return () => ipcRenderer.removeListener("kobichat:chat-peer-socket", handler);
  }
});
