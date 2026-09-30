import React, { useEffect, useMemo, useState } from "react";
import { applyThemeToDocument, getStoredTheme } from "../theme.js";
import BoardPanel from "./BoardPanel.jsx";

/**
 * Sustalı Pano çekmecesi penceresi (şeffaf, çerçevesiz; kişi listesinin solunda).
 * İçerik kapalıyken sağa, listenin arkasına kaymış durur; açılınca sola kayarak çıkar.
 */
export default function BoardDrawerApp() {
  const socketUrl = useMemo(
    () => new URLSearchParams(window.location.search).get("socketUrl") || "http://127.0.0.1:3847",
    []
  );
  const [open, setOpen] = useState(false);
  /** Liste sol kenardaysa çekmece sağdan açılır. */
  const [side, setSide] = useState("left");

  useEffect(() => {
    document.documentElement.classList.add("is-board-drawer");
    applyThemeToDocument(getStoredTheme());
    const sync = () => applyThemeToDocument(getStoredTheme());
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  useEffect(() => {
    const off = window.kobiChat?.onBoardDrawer?.((p) => {
      const next = Boolean(p?.open);
      if (p?.side === "left" || p?.side === "right") setSide(p.side);
      /** Pencere yeni gösterildiyse önce kapalı konumu çizilsin, sonra kaysın. */
      if (next) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
      } else {
        setOpen(false);
      }
    });
    window.kobiChat?.boardDrawerReady?.();
    return off;
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || document.body.dataset.boardModal === "1") return;
      e.preventDefault();
      void window.kobiChat?.toggleBoardDrawer?.({ open: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className={`drawer-root drawer-root--${side} ${open ? "is-open" : ""}`}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === "transform" && !open) {
          window.kobiChat?.boardDrawerHidden?.();
        }
      }}
    >
      <BoardPanel socketUrl={socketUrl} />
    </div>
  );
}
