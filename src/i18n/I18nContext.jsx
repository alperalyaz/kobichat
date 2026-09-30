import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LANGS, MESSAGES } from "./messages.js";

const STORAGE_KEY = "kobiChatLanguage";

/** @type {Record<string, string>} */
export const LOCALE_BY_LANG = {
  tr: "tr-TR",
  en: "en-US",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES"
};

export function normalizeLang(code) {
  if (!code || typeof code !== "string") return "tr";
  const base = code.toLowerCase().split("-")[0];
  return LANGS.includes(base) ? base : "tr";
}

export function detectBrowserLang() {
  if (typeof navigator === "undefined") return "tr";
  return normalizeLang(navigator.language || "tr");
}

function translate(lang, key, params) {
  const table = MESSAGES[lang] || MESSAGES.tr;
  let str = table[key] ?? MESSAGES.tr[key] ?? key;
  if (params && typeof str === "string") {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

const I18nContext = createContext({
  lang: "tr",
  setLang: () => {},
  t: (key, params) => translate("tr", key, params),
  locale: "tr-TR"
});

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s && LANGS.includes(s)) return s;
    } catch {
      // ignored
    }
    return detectBrowserLang();
  });

  const setLang = useCallback((next) => {
    const n = normalizeLang(next);
    setLangState(n);
    try {
      localStorage.setItem(STORAGE_KEY, n);
    } catch {
      // ignored
    }
  }, []);

  const t = useCallback((key, params) => translate(lang, key, params), [lang]);

  const locale = LOCALE_BY_LANG[lang] || LOCALE_BY_LANG.tr;

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang;
      try {
        const mode = new URLSearchParams(window.location.search).get("mode");
        if (mode !== "chat" && mode !== "quickMessages" && mode !== "settings" && mode !== "info") {
          document.title = translate(lang, "appTitle");
        }
      } catch {
        document.title = translate(lang, "appTitle");
      }
    }
  }, [lang]);

  const value = useMemo(
    () => ({
      lang,
      setLang,
      t,
      locale
    }),
    [lang, setLang, t, locale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
