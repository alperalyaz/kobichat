import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { LANGS } from "./messages.js";

/** Dil kodu → bayrak dosya adı (İngilizce → GB) */
const FLAG_FILE = { tr: "tr", en: "gb", de: "de", fr: "fr", es: "es" };

const LABEL_KEY = { tr: "langTr", en: "langEn", de: "langDe", fr: "langFr", es: "langEs" };

function flagUrl(code) {
  const base = import.meta.env.BASE_URL || "./";
  const file = FLAG_FILE[code] || "tr";
  return `${base}assets/flags/${file}.svg`;
}

export function LanguageSelectWithFlags({ lang, setLang, t, labelId = "lang-select-heading" }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const listId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [close]);

  return (
    <div className="language-select" ref={wrapRef}>
      <button
        type="button"
        id="lang-select-trigger"
        className="language-select__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <img
          className="language-select__flag"
          src={flagUrl(lang)}
          width={22}
          height={15}
          alt=""
          decoding="async"
          draggable={false}
        />
        <span className="language-select__label">{t(LABEL_KEY[lang])}</span>
        <span className="language-select__chev" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <ul id={listId} className="language-select__menu" role="listbox" aria-labelledby={labelId}>
          {LANGS.map((code) => (
            <li key={code} role="none">
              <button
                type="button"
                role="option"
                aria-selected={code === lang}
                className={`language-select__option ${code === lang ? "is-selected" : ""}`}
                onClick={() => {
                  setLang(code);
                  close();
                }}
              >
                <img
                  className="language-select__flag"
                  src={flagUrl(code)}
                  width={22}
                  height={15}
                  alt=""
                  decoding="async"
                  draggable={false}
                />
                <span>{t(LABEL_KEY[code])}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
