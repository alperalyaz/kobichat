const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kobiChat", {
  hideMainWindow: () => ipcRenderer.invoke("kobichat:hide-main-window"),
  openChatWindow: (payload) => ipcRenderer.invoke("kobichat:open-chat", payload),
  openInfoWindow: (options) => ipcRenderer.invoke("kobichat:open-info-window", options),
  openSettingsWindow: () => ipcRenderer.invoke("kobichat:open-settings-window"),
  openQuickMessagesWindow: () => ipcRenderer.invoke("kobichat:open-quick-messages"),
  openExternal: (url) => ipcRenderer.invoke("kobichat:open-external", url),
  downloadAndHandle: (payload) => ipcRenderer.invoke("kobichat:download-and-handle", payload),
  openDownloaded: (payload) => ipcRenderer.invoke("kobichat:open-downloaded", payload),
  /**
   * Main process'in renderer'a "şu sesi çal" diye yolladığı sinyali dinler.
   * Ör. autoUpdater'dan "update-available" geldiğinde.
   */
  onPlaySound: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("kobichat:play-sound", handler);
    return () => ipcRenderer.removeListener("kobichat:play-sound", handler);
  },
  clearAttention: () => ipcRenderer.invoke("kobichat:clear-attention"),
  flashSelf: () => ipcRenderer.invoke("kobichat:flash-self"),
  refreshTrayMenu: () => ipcRenderer.invoke("kobichat:refresh-tray-menu"),
  getConfig: () => ipcRenderer.invoke("kobichat:config"),
  getAppVersion: () => ipcRenderer.invoke("kobichat:app-version"),
  checkUpdatesNow: () => ipcRenderer.invoke("kobichat:check-updates-now"),
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
  },
  /** Main process → roster: sohbet penceresi kapandığında openChatPeersRef temizliği */
  onChatWindowClosed: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("kobichat:chat-window-closed", handler);
    return () => ipcRenderer.removeListener("kobichat:chat-window-closed", handler);
  },
  flashMainWindow: () => ipcRenderer.invoke("kobichat:flash-main-window"),
  /** Sohbet penceresi: bu webContents'in BrowserWindow'unu sallar (roster haritası gerekmez). */
  attentionShakeSelf: () => ipcRenderer.invoke("kobichat:attention-shake-self"),
  /** Roster → ana süreç: belirtilen peerClientUuid'ye ait sohbet penceresini doğrudan sallat. */
  shakeChatWindow: (peerClientUuid) => ipcRenderer.invoke("kobichat:shake-chat-window", peerClientUuid),
  setWindowTitle: (title) => ipcRenderer.invoke("kobichat:set-chat-window-title", title),
  onDownloadProgress: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("kobichat:download-progress", handler);
    return () => ipcRenderer.removeListener("kobichat:download-progress", handler);
  },
  onAttentionCssBurst: (fn) => {
    const handler = () => {
      try {
        fn();
      } catch {
        // ignored
      }
    };
    ipcRenderer.on("kobichat:attention-css-burst", handler);
    return () => ipcRenderer.removeListener("kobichat:attention-css-burst", handler);
  }
});
