import React, { useEffect, useMemo, useState } from "react";
import { applyThemeToDocument, getStoredTheme } from "./theme.js";
import { useI18n } from "./i18n/I18nContext.jsx";
import {
  QUICK_MSG_COUNT,
  loadQuickMessages,
  saveQuickMessages
} from "./quickMessagesStorage.js";

export default function QuickMessagesApp() {
  const { t } = useI18n();
  const [rows, setRows] = useState(() => loadQuickMessages());

  useEffect(() => {
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
    document.title = t("quickMessagesDocTitle");
  }, [t]);

  const onChangeLine = (index, value) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = value;
      saveQuickMessages(next);
      return next;
    });
  };

  const indices = useMemo(() => Array.from({ length: QUICK_MSG_COUNT }, (_, i) => i), []);

  return (
    <div className="quick-msgs-shell">
      <header className="quick-msgs-header">
        <h1 className="quick-msgs-title">{t("quickMessagesHeading")}</h1>
        <button
          type="button"
          className="quick-msgs-close"
          onClick={() => window.close()}
          aria-label={t("quickMessagesClose")}
          title={t("quickMessagesClose")}
        >
          ×
        </button>
      </header>
      <p className="quick-msgs-hint">{t("quickMessagesHint")}</p>
      <ul className="quick-msgs-list">
        {indices.map((i) => (
          <li key={i} className="quick-msgs-item">
            <label className="quick-msgs-label" htmlFor={`qm-${i}`}>
              {t("quickMessagesSlotLabel", { n: i + 1 })}
            </label>
            <textarea
              id={`qm-${i}`}
              className="quick-msgs-textarea"
              rows={2}
              value={rows[i] ?? ""}
              onChange={(e) => onChangeLine(i, e.target.value)}
              spellCheck
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
