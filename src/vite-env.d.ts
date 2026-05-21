/// <reference types="vite/client" />

interface KobiChatApi {
  hideMainWindow?: () => Promise<void>;
  openChatWindow?: (payload: {
    peerId: string;
    peerClientUuid: string;
    peerDisplayName?: string;
    peerName?: string;
    peerStatus?: string;
    openMinimized?: boolean;
    pokeAttention?: boolean;
  }) => Promise<{ ok?: boolean; created?: boolean } | void>;
  clearAttention?: () => Promise<void>;
  flashSelf?: () => Promise<void>;
  flashMainWindow?: () => Promise<void>;
  /** Sohbet penceresi: bu webContents'in BrowserWindow'unu OS düzeyinde sallar. */
  attentionShakeSelf?: () => Promise<boolean | void>;
  /** Roster → ana süreç: belirtilen peerClientUuid'ye ait sohbet penceresini doğrudan sallat. */
  shakeChatWindow?: (peerClientUuid: string) => Promise<boolean | void>;
  onAttentionCssBurst?: (fn: () => void) => () => void;
  onChatWindowClosed?: (fn: (p: { peerClientUuid: string }) => void) => () => void;
  /** Geriye uyumluluk için no-op kalır; renderer artık sesi src/sounds.js ile çalar. */
  playNotificationSound?: (payload?: { mode?: "short" | "alert" }) => Promise<boolean>;
  /** Main process'ten "şu sesi çal" sinyalleri (update-available, downloadComplete vb.). */
  onPlaySound?: (fn: (p: { name: string }) => void) => () => void;
  refreshTrayMenu: () => Promise<boolean>;
  getConfig: () => Promise<{
    socketUrl: string;
    displayName?: string;
    clientUuid?: string;
    serverMode?: string;
    localPort?: number;
    remoteHost?: string;
    remotePort?: number;
    presenceStatus?: string;
    language?: string;
    notificationSound?: boolean;
    soundCategories?: { message?: boolean; file?: boolean; system?: boolean; presence?: boolean };
    soundVolume?: number;
    profileImage?: string;
    hostname?: string;
  }>;
  checkUpdatesNow?: () => Promise<{
    ok?: boolean;
    throttled?: boolean;
    retryAfterMs?: number;
    reason?: string;
    opened?: string;
  } | void>;
  getSettings: () => Promise<Record<string, unknown>>;
  saveSettings: (partial: Record<string, unknown>) => Promise<unknown>;
  downloadAndHandle?: (payload: {
    url: string;
    urls?: string[];
    filename?: string;
    mime?: string;
    fileSize?: number;
  }) => Promise<{ ok?: boolean; reason?: string; path?: string; reused?: boolean } | boolean>;
  openDownloaded?: (payload: { path: string }) => Promise<{ ok?: boolean; reason?: string }>;
  discoverLan: () => Promise<Array<{ socketUrl: string; host: string; port: number }>>;
  onConfigUpdated: (fn: (cfg: unknown) => void) => () => void;
  onTrayPresence?: (fn: (p: { presenceStatus?: string }) => void) => () => void;
}

declare global {
  interface Window {
    kobiChat?: KobiChatApi;
  }
}

export {};
