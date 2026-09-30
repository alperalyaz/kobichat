import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { useI18n } from "../i18n/I18nContext.jsx";
import {
  NOTE_KINDS,
  SCHED_KINDS,
  WEEK_ORDER,
  mealCellsForToday,
  newLocalId,
  noteKind,
  parseMonthly,
  schedKind,
  shrinkImageFile,
  weekdayShort
} from "./kinds.js";
import "./board.css";

const LOCAL_APP_KEY = "kobiBoardLocalApp:";

function readLocalAppPath(id) {
  try {
    return localStorage.getItem(LOCAL_APP_KEY + id) || "";
  } catch {
    return "";
  }
}

function writeLocalAppPath(id, p) {
  try {
    if (p) localStorage.setItem(LOCAL_APP_KEY + id, p);
    else localStorage.removeItem(LOCAL_APP_KEY + id);
  } catch {
    // ignored
  }
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function moveItem(list, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Düzenleme penceresi: bölümler kaydedince kapatır, kaydedilmemiş değişikliği bildirir. */
const EditModalContext = createContext(null);

/** Sunucu değerinden taslak; kaydedilmemiş değişiklik yokken sunucu güncellemesi taslağa yansır. */
function useSection(key, value, emitAck) {
  const modal = useContext(EditModalContext);
  const valueJson = JSON.stringify(value ?? null);
  const [draft, setDraft] = useState(() => JSON.parse(valueJson));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!dirty) setDraft(JSON.parse(valueJson));
  }, [valueJson, dirty]);

  useEffect(() => {
    modal?.setDirty(dirty);
  }, [modal, dirty]);

  const update = useCallback((next) => {
    setDirty(true);
    setStatus("");
    setDraft(next);
  }, []);

  const cancel = useCallback(() => {
    setDirty(false);
    setStatus("");
  }, []);

  const save = useCallback(
    async (override) => {
      setStatus("saving");
      const r = await emitAck("board:set", { key, value: override ?? draft });
      if (r?.ok) {
        setDirty(false);
        setStatus("");
        modal?.close(true);
      } else {
        setStatus("error");
      }
    },
    [emitAck, key, draft, modal]
  );

  return { draft, update, dirty, status, save, cancel };
}

function SaveBar({ t, section, disabled }) {
  const { dirty, status, save, cancel } = section;
  const modal = useContext(EditModalContext);
  return (
    <div className="bd-savebar">
      <span className={`bd-savebar__status ${status === "error" ? "is-error" : ""}`}>
        {status === "saving"
          ? t("boardSaving")
          : status === "error"
              ? t("boardSaveError")
              : dirty
                ? t("boardUnsaved")
                : ""}
      </span>
      <button
        type="button"
        className="btn"
        onClick={() => {
          cancel();
          modal?.close(true);
        }}
        disabled={status === "saving"}
      >
        {t("cancel")}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void save()}
        disabled={!dirty || disabled || status === "saving"}
      >
        {t("boardSave")}
      </button>
    </div>
  );
}

function RowTools({ t, onUp, onDown, onDelete, isFirst, isLast }) {
  return (
    <div className="bd-rowtools">
      <button type="button" className="bd-iconbtn" onClick={onUp} disabled={isFirst} title={t("boardMoveUp")}>
        ↑
      </button>
      <button type="button" className="bd-iconbtn" onClick={onDown} disabled={isLast} title={t("boardMoveDown")}>
        ↓
      </button>
      <button type="button" className="bd-iconbtn bd-iconbtn--danger" onClick={onDelete} title={t("boardDelete")}>
        ✕
      </button>
    </div>
  );
}

/* ───────────── Görünüm ───────────── */

function CardHead({ t, title, onEdit }) {
  return (
    <div className="bd-card__head">
      <h2 className="bd-card__title">{title}</h2>
      {onEdit ? (
        <button type="button" className="bd-edit-btn" onClick={onEdit} title={t("boardEdit")} aria-label={t("boardEdit")}>
          ✎
        </button>
      ) : null}
    </div>
  );
}

function NotesCard({ t, notes, onEdit }) {
  const sorted = useMemo(() => [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned)), [notes]);
  return (
    <section className="bd-card bd-card--notes">
      <CardHead t={t} title={t("boardNotesTitle")} onEdit={onEdit} />
      {sorted.length === 0 ? (
        <p className="bd-empty">{t("boardNotesEmpty")}</p>
      ) : (
        <ul className="bd-notes">
          {sorted.map((n) => {
            const k = noteKind(n.kind);
            return (
              <li key={n.id} className="bd-note" style={k.color ? { borderLeftColor: k.color } : undefined}>
                <div className="bd-note__head">
                  {k.icon ? <span className="bd-note__icon">{k.icon}</span> : null}
                  {n.title ? <strong className="bd-note__title">{n.title}</strong> : null}
                  {n.pinned ? <span className="bd-note__pin" title={t("boardPinned")}>📌</span> : null}
                </div>
                {n.body ? <p className="bd-note__body">{n.body}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function MealCard({ t, meal, onEdit }) {
  const cells = mealCellsForToday(meal?.monthly);
  const text = String(meal?.text ?? "").trim();
  const image = String(meal?.image ?? "");
  return (
    <section className="bd-card bd-card--meal">
      <CardHead t={t} title={t("boardMealTitle")} onEdit={onEdit} />
      {image ? (
        <img className="bd-meal__img" src={image} alt={t("boardMealTitle")} />
      ) : cells ? (
        <div className="bd-meal__grid">
          {cells.map((c, i) => (
            <span key={i} className="bd-meal__cell">
              {c || " "}
            </span>
          ))}
        </div>
      ) : text ? (
        <p className="bd-meal__text">{text}</p>
      ) : (
        <p className="bd-empty">{t("boardMealEmpty")}</p>
      )}
    </section>
  );
}

function RatesCard({ t, locale, rates, onEdit }) {
  const fmt = useMemo(
    () => new Intl.NumberFormat(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    [locale]
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    [locale]
  );
  const fetchedAt = rates.fetchedAt ? timeFmt.format(new Date(rates.fetchedAt)) : "";
  if (rates.mode !== "auto") {
    return (
      <section className="bd-card bd-card--rates">
        <CardHead t={t} title={t("boardRatesTitle")} onEdit={onEdit} />
        <p className="bd-empty">
          {t("boardRatesOff")} — {t("boardRatesOffHint")}
        </p>
      </section>
    );
  }
  return (
    <section className="bd-card bd-card--rates">
      <CardHead t={t} title={t("boardRatesTitle")} onEdit={onEdit} />
      <ul className="bd-rates">
        {rates.codes.map((code) => {
          const v = rates.values?.[code];
          const dir = !v || v.prev == null ? 0 : v.value > v.prev ? 1 : v.value < v.prev ? -1 : 0;
          return (
            <li key={code} className="bd-rate">
              <span className="bd-rate__code">
                {code}/{rates.base}
              </span>
              <span className="bd-rate__value">{v ? fmt.format(v.value) : "—"}</span>
              <span className={`bd-rate__dir ${dir > 0 ? "is-up" : dir < 0 ? "is-down" : ""}`} aria-hidden>
                {dir > 0 ? "▲" : dir < 0 ? "▼" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="bd-card__foot">
        {rates.error
          ? fetchedAt
            ? t("boardRatesStale", { time: fetchedAt })
            : t("boardRatesUnavailable")
          : fetchedAt
            ? t("boardRatesUpdated", { time: fetchedAt })
            : t("boardRatesWaiting")}
      </p>
    </section>
  );
}

function AppsCard({ t, apps, onNotice, onEdit }) {
  const [, force] = useState(0);
  const desktop = typeof window !== "undefined" && Boolean(window.kobiChat);

  async function pick(app) {
    const p = await window.kobiChat.pickLocalApp();
    if (!p) return "";
    writeLocalAppPath(app.id, p);
    force((n) => n + 1);
    return p;
  }

  async function launch(app) {
    if (app.kind === "web") {
      if (window.kobiChat?.openExternal) void window.kobiChat.openExternal(app.url);
      else window.open(app.url, "_blank", "noopener");
      return;
    }
    if (!desktop) {
      onNotice(t("boardAppLocalDesktopOnly"));
      return;
    }
    let p = readLocalAppPath(app.id);
    if (!p) p = await pick(app);
    if (!p) return;
    const ok = await window.kobiChat.openLocalApp(p);
    if (!ok) {
      writeLocalAppPath(app.id, "");
      force((n) => n + 1);
      onNotice(t("boardAppLocalMissing"));
    }
  }

  return (
    <section className="bd-card bd-card--apps">
      <CardHead t={t} title={t("boardAppsTitle")} onEdit={onEdit} />
      {apps.length === 0 ? (
        <p className="bd-empty">{t("boardAppsEmpty")}</p>
      ) : (
        <div className="bd-apps">
          {apps.map((app) => {
            const localPath = app.kind === "local" ? readLocalAppPath(app.id) : "";
            return (
              <div key={app.id} className="bd-app">
                <button
                  type="button"
                  className="bd-app__btn"
                  onClick={() => void launch(app)}
                  title={app.kind === "web" ? app.url : localPath || t("boardAppLocalPick")}
                >
                  <span className="bd-app__icon">{app.icon || (app.kind === "web" ? "🌐" : "🖥️")}</span>
                  <span className="bd-app__name">{app.name || app.url}</span>
                </button>
                {app.kind === "local" && localPath && desktop ? (
                  <button
                    type="button"
                    className="bd-app__change"
                    onClick={() => void pick(app)}
                    title={t("boardAppLocalChange")}
                  >
                    ⋯
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function BoardView({ t, locale, board, canEdit, onNotice, onEdit }) {
  const edit = (key) => (canEdit ? () => onEdit(key) : undefined);
  /** Kurlar kapalıyken panel yalnızca düzenleyene görünür (açabilmesi için). */
  const showRates = board.rates?.mode === "auto" || canEdit;
  return (
    <div className="bd-grid">
      <NotesCard t={t} notes={board.notes || []} onEdit={edit("notes")} />
      <div className="bd-side">
        <MealCard t={t} meal={board.meal} onEdit={edit("meal")} />
        {showRates ? <RatesCard t={t} locale={locale} rates={board.rates} onEdit={edit("rates")} /> : null}
        <AppsCard t={t} apps={board.apps || []} onNotice={onNotice} onEdit={edit("apps")} />
      </div>
      {!canEdit ? <p className="bd-readonly">{t("boardReadonlyHint")}</p> : null}
    </div>
  );
}

/* ───────────── Yönetim ───────────── */

function NotesSection({ t, value, emitAck }) {
  const sec = useSection("notes", value, emitAck);
  const list = sec.draft || [];
  const set = (i, patch) => sec.update(list.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  return (
    <div className="bd-section">
      {list.map((n, i) => (
        <div key={n.id} className="bd-edit-row">
          <div className="bd-edit-row__line">
            <select className="bd-input bd-input--kind" value={n.kind} onChange={(e) => set(i, { kind: e.target.value })}>
              {NOTE_KINDS.map((k) => (
                <option key={k.v} value={k.v}>
                  {k.icon ? `${k.icon} ` : ""}
                  {t(k.tkey)}
                </option>
              ))}
            </select>
            <input
              className="bd-input bd-grow"
              value={n.title}
              maxLength={120}
              placeholder={t("boardFieldTitle")}
              onChange={(e) => set(i, { title: e.target.value })}
            />
            <label className="bd-check">
              <input type="checkbox" checked={n.pinned} onChange={(e) => set(i, { pinned: e.target.checked })} />
              {t("boardPinned")}
            </label>
            <RowTools
              t={t}
              isFirst={i === 0}
              isLast={i === list.length - 1}
              onUp={() => sec.update(moveItem(list, i, -1))}
              onDown={() => sec.update(moveItem(list, i, 1))}
              onDelete={() => sec.update(list.filter((_, j) => j !== i))}
            />
          </div>
          <textarea
            className="bd-input"
            rows={2}
            value={n.body}
            maxLength={2000}
            placeholder={t("boardFieldBody")}
            onChange={(e) => set(i, { body: e.target.value })}
          />
        </div>
      ))}
      <button
        type="button"
        className="btn"
        disabled={list.length >= 50}
        onClick={() =>
          sec.update([
            ...list,
            { id: newLocalId(), kind: "", title: "", body: "", pinned: false, createdAt: new Date().toISOString() }
          ])
        }
      >
        + {t("boardNoteAdd")}
      </button>
      <SaveBar t={t} section={sec} />
    </div>
  );
}

function MealSection({ t, value, emitAck }) {
  const sec = useSection("meal", value, emitAck);
  const meal = sec.draft || { text: "", image: "", monthly: "" };
  const [imgErr, setImgErr] = useState("");
  const monthlyOk = parseMonthly(meal.monthly).ok;

  async function onImage(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      setImgErr("");
      sec.update({ ...meal, image: await shrinkImageFile(f) });
    } catch {
      setImgErr(t("boardMealImageError"));
    }
  }

  return (
    <div className="bd-section">
      <label className="bd-label">{t("boardMealImage")}</label>
      <div className="bd-edit-row__line">
        <input type="file" accept="image/*" onChange={onImage} />
        {meal.image ? (
          <button type="button" className="btn" onClick={() => sec.update({ ...meal, image: "" })}>
            {t("boardMealImageRemove")}
          </button>
        ) : null}
      </div>
      {meal.image ? <img className="bd-meal__preview" src={meal.image} alt="" /> : null}
      {imgErr ? <p className="bd-error">{imgErr}</p> : null}
      <p className="bd-hint">{t("boardMealImageHint")}</p>

      <label className="bd-label">{t("boardMealText")}</label>
      <textarea
        className="bd-input"
        rows={3}
        maxLength={500}
        value={meal.text}
        onChange={(e) => sec.update({ ...meal, text: e.target.value })}
      />

      <label className="bd-label">{t("boardMealMonthly")}</label>
      <textarea
        className="bd-input bd-mono"
        rows={6}
        value={meal.monthly}
        placeholder='{"yil":2026,"ay":5,"gunler":[{"gun":1,"yemek1":"Mercimek","yemek2":"Pilav"}]}'
        onChange={(e) => sec.update({ ...meal, monthly: e.target.value })}
      />
      {!monthlyOk ? <p className="bd-error">{t("boardMealMonthlyInvalid")}</p> : null}
      <p className="bd-hint">{t("boardMealMonthlyHint")}</p>
      <SaveBar t={t} section={sec} disabled={!monthlyOk} />
    </div>
  );
}

function SchedulesSection({ t, locale, value, emitAck }) {
  const sec = useSection("schedules", value, emitAck);
  const list = sec.draft || [];
  const set = (i, patch) => sec.update(list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  function preview(s) {
    const k = schedKind(s.kind);
    void window.kobiChat?.showNotify?.({
      title: s.title,
      message: s.body,
      icon: k.icon,
      color: k.color,
      okLabel: t("boardNotifyOk"),
      brandLabel: t("boardBrand")
    });
  }

  return (
    <div className="bd-section">
      <p className="bd-hint">{t("boardSchedHint")}</p>
      {list.map((s, i) => {
        const weekly = !s.date;
        return (
          <div key={s.id} className={`bd-edit-row ${s.enabled ? "" : "is-disabled"}`}>
            <div className="bd-edit-row__line">
              <select className="bd-input bd-input--kind" value={s.kind} onChange={(e) => set(i, { kind: e.target.value })}>
                {SCHED_KINDS.map((k) => (
                  <option key={k.v} value={k.v}>
                    {k.icon} {t(k.tkey)}
                  </option>
                ))}
              </select>
              <input
                className="bd-input bd-grow"
                value={s.title}
                maxLength={120}
                placeholder={t("boardFieldTitle")}
                onChange={(e) => set(i, { title: e.target.value })}
              />
              <input
                className="bd-input bd-input--time"
                type="time"
                value={s.time}
                onChange={(e) => set(i, { time: e.target.value || "09:00" })}
              />
              <RowTools
                t={t}
                isFirst={i === 0}
                isLast={i === list.length - 1}
                onUp={() => sec.update(moveItem(list, i, -1))}
                onDown={() => sec.update(moveItem(list, i, 1))}
                onDelete={() => sec.update(list.filter((_, j) => j !== i))}
              />
            </div>
            <textarea
              className="bd-input"
              rows={2}
              maxLength={1000}
              value={s.body}
              placeholder={t("boardFieldBody")}
              onChange={(e) => set(i, { body: e.target.value })}
            />
            <div className="bd-edit-row__line">
              <select
                className="bd-input bd-input--repeat"
                value={weekly ? "weekly" : "date"}
                onChange={(e) => set(i, { date: e.target.value === "date" ? todayIso() : "" })}
              >
                <option value="weekly">{t("boardSchedWeekly")}</option>
                <option value="date">{t("boardSchedOnDate")}</option>
              </select>
              {weekly ? (
                <div className="bd-days">
                  {WEEK_ORDER.map((d) => {
                    const on = s.days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        className={`bd-day ${on ? "is-on" : ""}`}
                        onClick={() => set(i, { days: on ? s.days.filter((x) => x !== d) : [...s.days, d] })}
                      >
                        {weekdayShort(locale, d)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input
                  className="bd-input bd-input--date"
                  type="date"
                  value={s.date}
                  onChange={(e) => set(i, { date: e.target.value || todayIso() })}
                />
              )}
              <label className="bd-check">
                <input type="checkbox" checked={s.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
                {t("boardSchedEnabled")}
              </label>
              {window.kobiChat?.showNotify ? (
                <button type="button" className="btn" onClick={() => preview(s)}>
                  {t("boardSchedPreview")}
                </button>
              ) : null}
            </div>
            {weekly && s.days.length === 0 ? <p className="bd-error">{t("boardSchedNoDays")}</p> : null}
          </div>
        );
      })}
      <button
        type="button"
        className="btn"
        disabled={list.length >= 60}
        onClick={() =>
          sec.update([
            ...list,
            { id: newLocalId(), kind: "info", title: "", body: "", time: "09:00", days: [1, 2, 3, 4, 5], date: "", enabled: true }
          ])
        }
      >
        + {t("boardSchedAdd")}
      </button>
      <SaveBar t={t} section={sec} />
    </div>
  );
}

function RatesSection({ t, locale, rates, emitAck }) {
  const value = useMemo(() => ({ mode: rates.mode, base: rates.base, codes: rates.codes }), [rates]);
  const sec = useSection("rates", value, emitAck);
  const d = sec.draft || value;
  const [refreshing, setRefreshing] = useState(false);
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    [locale]
  );

  async function refresh() {
    setRefreshing(true);
    await emitAck("board:rates-refresh", {});
    setTimeout(() => setRefreshing(false), 1500);
  }

  return (
    <div className="bd-section">
      <div className="bd-radio-col">
        <label className="bd-check">
          <input type="radio" name="ratesMode" checked={d.mode !== "auto"} onChange={() => sec.update({ ...d, mode: "off" })} />
          <span>
            <strong>{t("boardRatesOff")}</strong> — {t("boardRatesOffHint")}
          </span>
        </label>
        <label className="bd-check">
          <input type="radio" name="ratesMode" checked={d.mode === "auto"} onChange={() => sec.update({ ...d, mode: "auto" })} />
          <span>
            <strong>{t("boardRatesAuto")}</strong> — {t("boardRatesAutoHint")}
          </span>
        </label>
      </div>
      <div className="bd-edit-row__line">
        <label className="bd-label bd-label--inline">
          {t("boardRatesBase")}
          <input
            className="bd-input bd-input--code"
            value={d.base}
            maxLength={3}
            onChange={(e) => sec.update({ ...d, base: e.target.value.toUpperCase() })}
          />
        </label>
        <label className="bd-label bd-label--inline bd-grow">
          {t("boardRatesCodes")}
          <input
            className="bd-input bd-grow"
            value={d.codes.join(", ")}
            onChange={(e) => sec.update({ ...d, codes: e.target.value.split(",").map((s) => s.trim().toUpperCase()) })}
            placeholder="USD, EUR, GBP"
          />
        </label>
      </div>
      {rates.mode === "auto" ? (
        <div className="bd-edit-row__line">
          <span className="bd-hint">
            {rates.error
              ? t("boardRatesErrorLine", { error: rates.error })
              : rates.fetchedAt
                ? t("boardRatesUpdated", { time: timeFmt.format(new Date(rates.fetchedAt)) })
                : t("boardRatesWaiting")}
          </span>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={refreshing}>
            {t("boardRatesRefresh")}
          </button>
        </div>
      ) : null}
      <SaveBar t={t} section={sec} />
    </div>
  );
}

function AppsSection({ t, value, emitAck }) {
  const sec = useSection("apps", value, emitAck);
  const list = sec.draft || [];
  const set = (i, patch) => sec.update(list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const badUrl = list.some((a) => a.kind === "web" && a.url && !/^https?:\/\//i.test(a.url));
  return (
    <div className="bd-section">
      <p className="bd-hint">{t("boardAppsHint")}</p>
      {list.map((a, i) => (
        <div key={a.id} className="bd-edit-row">
          <div className="bd-edit-row__line">
            <input
              className="bd-input bd-input--icon"
              value={a.icon}
              maxLength={8}
              placeholder="🌐"
              title={t("boardAppIcon")}
              onChange={(e) => set(i, { icon: e.target.value })}
            />
            <input
              className="bd-input bd-grow"
              value={a.name}
              maxLength={40}
              placeholder={t("boardAppName")}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <select className="bd-input bd-input--kind" value={a.kind} onChange={(e) => set(i, { kind: e.target.value })}>
              <option value="web">{t("boardAppKindWeb")}</option>
              <option value="local">{t("boardAppKindLocal")}</option>
            </select>
            <RowTools
              t={t}
              isFirst={i === 0}
              isLast={i === list.length - 1}
              onUp={() => sec.update(moveItem(list, i, -1))}
              onDown={() => sec.update(moveItem(list, i, 1))}
              onDelete={() => sec.update(list.filter((_, j) => j !== i))}
            />
          </div>
          {a.kind === "web" ? (
            <input
              className="bd-input"
              value={a.url}
              maxLength={1000}
              placeholder="https://"
              onChange={(e) => set(i, { url: e.target.value.trim() })}
            />
          ) : (
            <p className="bd-hint">{t("boardAppLocalHint")}</p>
          )}
        </div>
      ))}
      {badUrl ? <p className="bd-error">{t("boardAppUrlInvalid")}</p> : null}
      <button
        type="button"
        className="btn"
        disabled={list.length >= 24}
        onClick={() => sec.update([...list, { id: newLocalId(), name: "", kind: "web", url: "", icon: "" }])}
      >
        + {t("boardAppAdd")}
      </button>
      <SaveBar t={t} section={sec} disabled={badUrl} />
    </div>
  );
}

function ShockSection({ t, emitAck }) {
  const modal = useContext(EditModalContext);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  async function send() {
    if (!title.trim() && !body.trim()) return;
    if (!window.confirm(t("boardShockConfirm"))) return;
    setStatus("sending");
    const r = await emitAck("board:shock", { title, body });
    if (r?.ok) {
      setTitle("");
      setBody("");
      setStatus("sent");
      modal?.close(true);
    } else {
      setStatus("error");
    }
  }
  return (
    <div className="bd-section">
      <p className="bd-hint">{t("boardShockHint")}</p>
      <input
        className="bd-input"
        value={title}
        maxLength={120}
        placeholder={t("boardFieldTitle")}
        onChange={(e) => {
          setTitle(e.target.value);
          setStatus("");
        }}
      />
      <textarea
        className="bd-input"
        rows={3}
        maxLength={1000}
        value={body}
        placeholder={t("boardFieldBody")}
        onChange={(e) => {
          setBody(e.target.value);
          setStatus("");
        }}
      />
      <div className="bd-savebar">
        <span className={`bd-savebar__status ${status === "error" ? "is-error" : ""}`}>
          {status === "sent" ? t("boardShockSent") : status === "error" ? t("boardSaveError") : ""}
        </span>
        <button
          type="button"
          className="btn bd-btn-danger"
          onClick={() => void send()}
          disabled={status === "sending" || (!title.trim() && !body.trim())}
        >
          🚨 {t("boardShockSend")}
        </button>
      </div>
    </div>
  );
}

const EDITOR_TITLES = {
  notes: "boardNotesTitle",
  meal: "boardMealTitle",
  rates: "boardRatesTitle",
  apps: "boardAppsTitle",
  schedules: "boardSchedulesTitle",
  shock: "boardShockTitle"
};

function EditModal({ t, title, onClose, children }) {
  const dirtyRef = useRef(false);
  const close = useCallback(
    (force) => {
      if (!force && dirtyRef.current && !window.confirm(t("boardDiscardConfirm"))) return;
      onClose();
    },
    [onClose, t]
  );
  const ctx = useMemo(
    () => ({
      close,
      setDirty: (d) => {
        dirtyRef.current = d;
      }
    }),
    [close]
  );

  useEffect(() => {
    /** Liste penceresinin "Esc = pencereyi gizle" davranışı düzenleme sırasında devre dışı. */
    document.body.dataset.boardModal = "1";
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      delete document.body.dataset.boardModal;
      document.removeEventListener("keydown", onKey);
    };
  }, [close]);

  return (
    <div
      className="bd-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div className="bd-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="bd-modal__head">
          <h2 className="bd-modal__title">{title}</h2>
          <button type="button" className="btn-modal-x" onClick={() => close(false)} aria-label={t("boardClose")}>
            ✕
          </button>
        </div>
        <div className="bd-modal__body">
          <EditModalContext.Provider value={ctx}>{children}</EditModalContext.Provider>
        </div>
      </div>
    </div>
  );
}

/* ───────────── Ana penceredeki Pano sekmesi ───────────── */

/** Sekme açıkken kendi soketini tutar (presence:join yok, kişi listesinde görünmez). */
export default function BoardPanel({ socketUrl }) {
  const { t, locale } = useI18n();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [board, setBoard] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  /** Açık düzenleme penceresi: notes | meal | rates | apps | schedules | shock */
  const [editing, setEditing] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    const s = io(socketUrl, {
      transports: ["polling", "websocket"],
      upgrade: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 12000,
      timeout: 20000
    });
    socketRef.current = s;
    s.on("connect", () => {
      setConnected(true);
      s.emit("board:get");
    });
    s.on("disconnect", () => setConnected(false));
    s.on("board:state", (st) => {
      const { canEdit: ce, ...rest } = st || {};
      setBoard(rest);
      setCanEdit(Boolean(ce));
      if (!ce) setEditing("");
    });
    s.on("board:patch", (p) => {
      if (!p?.key) return;
      setBoard((prev) => (prev ? { ...prev, [p.key]: p.value } : prev));
    });
    return () => {
      s.close();
      socketRef.current = null;
    };
  }, [socketUrl]);

  const emitAck = useCallback(
    (event, payload) =>
      new Promise((resolve) => {
        const s = socketRef.current;
        if (!s || !s.connected) {
          resolve({ ok: false, error: "offline" });
          return;
        }
        s.timeout(10000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: "timeout" } : res));
      }),
    []
  );

  const dateLine = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(now);
    } catch {
      return now.toDateString();
    }
  }, [locale, now]);
  const timeLine = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(now);
    } catch {
      return "";
    }
  }, [locale, now]);

  return (
    <div className="bd-shell">
      <header className="bd-header">
        <div className="bd-header__when">
          <span className="bd-header__time">{timeLine}</span>
          <span className="bd-header__date">{dateLine}</span>
        </div>
        <div className="bd-header__right">
          {!connected ? <span className="bd-offline">{t("boardOffline")}</span> : null}
          {canEdit ? (
            <>
              <button type="button" className="btn" onClick={() => setEditing("schedules")}>
                ⏰ {t("boardSchedulesTitle")}
                {board?.schedules?.length ? ` (${board.schedules.length})` : ""}
              </button>
              <button type="button" className="btn bd-btn-danger-outline" onClick={() => setEditing("shock")}>
                🚨 {t("boardShockTitle")}
              </button>
            </>
          ) : null}
        </div>
      </header>
      {notice ? <div className="bd-notice">{notice}</div> : null}
      <main className="bd-main">
        {!board ? (
          <p className="bd-empty bd-empty--center">{connected ? t("boardLoading") : t("boardOffline")}</p>
        ) : (
          <BoardView t={t} locale={locale} board={board} canEdit={canEdit} onNotice={setNotice} onEdit={setEditing} />
        )}
      </main>
      {board && canEdit && editing ? (
        <EditModal t={t} title={t(EDITOR_TITLES[editing])} onClose={() => setEditing("")}>
          {editing === "notes" ? <NotesSection t={t} value={board.notes} emitAck={emitAck} /> : null}
          {editing === "meal" ? <MealSection t={t} value={board.meal} emitAck={emitAck} /> : null}
          {editing === "rates" ? <RatesSection t={t} locale={locale} rates={board.rates} emitAck={emitAck} /> : null}
          {editing === "apps" ? <AppsSection t={t} value={board.apps} emitAck={emitAck} /> : null}
          {editing === "schedules" ? (
            <SchedulesSection t={t} locale={locale} value={board.schedules} emitAck={emitAck} />
          ) : null}
          {editing === "shock" ? <ShockSection t={t} emitAck={emitAck} /> : null}
        </EditModal>
      ) : null}
    </div>
  );
}
