import { useEffect, useState } from "react";

/* global __KOBI_PACKAGE_VERSION__ */

/**
 * Electron: app.getVersion() (preload IPC).
 * Vite derlemesi: package.json ile aynı sürüm (__KOBI_PACKAGE_VERSION__).
 */
export function useAppVersion() {
  const buildTime =
    typeof __KOBI_PACKAGE_VERSION__ !== "undefined" ? String(__KOBI_PACKAGE_VERSION__) : "";
  const [version, setVersion] = useState(buildTime);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window !== "undefined" && window.kobiChat?.getAppVersion) {
          const v = await window.kobiChat.getAppVersion();
          if (!cancelled && typeof v === "string" && v.trim()) {
            setVersion(v.trim());
            return;
          }
        }
      } catch {
        // buildTime kalır
      }
      if (!cancelled && buildTime) setVersion(buildTime);
    })();
    return () => {
      cancelled = true;
    };
  }, [buildTime]);

  return version || null;
}
