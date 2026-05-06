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
  }) => Promise<{ ok?: boolean; created?: boolean } | void>;
  clearAttention?: () => Promise<void>;
  playNotificationSound?: () => Promise<boolean>;
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
    profileImage?: string;
    hostname?: string;
  }>;
  getSettings: () => Promise<Record<string, unknown>>;
  saveSettings: (partial: Record<string, unknown>) => Promise<unknown>;
  downloadAndHandle?: (payload: { url: string; filename?: string; mime?: string }) => Promise<boolean>;
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
