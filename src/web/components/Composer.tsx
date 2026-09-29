import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import confetti from "canvas-confetti";
import { ChatBubbleLeftRightIcon, GiftIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { BellAlertIcon } from "@heroicons/react/20/solid";
import { altName, api, type PostDetail, type Allowance, type User } from "../api";
import { errorText } from "../i18n";
import { useApp, type ComposerPrefill } from "../state";
import { LIMITS, VALUES } from "../../shared/values";
import { Avatar, ValueChip } from "./ui";

const HEART = confetti.shapeFromPath({
  path: "M167 72c19-38 37-56 75-56 42 0 76 33 76 75 0 76-76 151-151 227-76-76-151-151-151-227 0-42 33-75 75-75 38 0 57 18 76 56z",
});

export function celebrate(from?: DOMRect | null) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const origin = from
    ? { x: (from.left + from.width / 2) / innerWidth, y: (from.top + from.height / 2) / innerHeight }
    : { x: 0.5, y: 0.6 };
  const colors = ["#FF6B8B", "#FF9F6B", "#FFD27A", "#B79BFF", "#FFF1E6"];
  const base = { origin, colors, zIndex: 1000, disableForReducedMotion: true };
  confetti({ ...base, particleCount: 70, spread: 75, startVelocity: 42, scalar: 1 });
  confetti({ ...base, particleCount: 26, spread: 100, startVelocity: 30, shapes: [HEART], scalar: 1.6, ticks: 260 });
}

function matches(u: User, q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [u.name, u.enName, u.handle, u.dept, u.deptEn].some((f) => f?.toLowerCase().includes(s));
}

export function Composer({ prefill, onClose }: { prefill?: ComposerPrefill; onClose: () => void }) {
  const { me, setMe, t, lang, loadDirectory, directory, users, name, bumpFeed, toast, mergeUsers } = useApp();
  const allowance = me.allowance;
  const amounts = me.config.bonusAmounts;
  const [kind, setKind] = useState<"kudos" | "bonus">(prefill?.kind ?? "kudos");
  const [recipientIds, setRecipientIds] = useState<number[]>(prefill?.recipientIds?.filter((id) => id !== me.user.id) ?? []);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [valueTag, setValueTag] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [points, setPoints] = useState(amounts[0] ?? 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    loadDirectory().catch(() => {});
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (recipientIds.length ? messageRef : searchRef).current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const candidates = useMemo(() => {
    const pool = (directory?.users ?? []).filter((u) => u.id !== me.user.id && !recipientIds.includes(u.id));
    if (query.trim()) return pool.filter((u) => matches(u, query)).slice(0, 8);
    const mine = pool.filter((u) => u.dept && u.dept === me.user.dept);
    return [...mine, ...pool.filter((u) => !mine.includes(u))].slice(0, 6);
  }, [directory, query, recipientIds, me.user]);

  const n = recipientIds.length;
  const minAmount = Math.min(...amounts);
  const bonusAvailable = allowance.remaining >= minAmount;
  const cost = kind === "bonus" ? points * Math.max(1, n) : 0;
  const tooExpensive = kind === "bonus" && cost > allowance.remaining;
  const tooShort = kind === "bonus" && message.trim().length < LIMITS.messageMinBonus;
  const canSend = n > 0 && message.trim().length > 0 && !tooExpensive && !tooShort && !busy;

  useEffect(() => {
    if (kind === "bonus" && points * Math.max(1, n) > allowance.remaining) {
      const affordable = [...amounts].reverse().find((a) => a * Math.max(1, n) <= allowance.remaining);
      if (affordable) setPoints(affordable);
    }
  }, [n, kind]);

  function add(u: User) {
    setRecipientIds((ids) => (ids.length >= LIMITS.recipientsMax ? ids : [...ids, u.id]));
    setQuery("");
    setCursor(0);
    searchRef.current?.focus();
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, candidates.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
    else if (e.key === "Enter" && candidates[cursor]) (e.preventDefault(), add(candidates[cursor]!));
    else if (e.key === "Backspace" && !query && n) setRecipientIds((ids) => ids.slice(0, -1));
    else if (e.key === "Escape" && (query || focused)) (e.stopPropagation(), setQuery(""), searchRef.current?.blur());
  }

  function insertIdea(text: string) {
    setMessage((m) => (m ? `${m}${m.endsWith(" ") || m.endsWith("\n") ? "" : " "}${text}` : text));
    requestAnimationFrame(() => {
      const el = messageRef.current;
      if (!el) return;
      el.focus();
      const blank = el.value.lastIndexOf("___");
      if (blank >= 0) el.setSelectionRange(blank, blank + 3);
    });
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) {
      if (!n) setError(t("err.recipients_required"));
      else if (!message.trim()) setError(t("err.message_required"));
      else if (tooShort) setError(t("composer.minBonus", { n: LIMITS.messageMinBonus }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<PostDetail & { allowance: Allowance }>("/api/posts", {
        method: "POST",
        body: { kind, recipientIds, message, valueTag, points: kind === "bonus" ? points : 0 },
      });
      mergeUsers(res.users);
      setMe({ ...me, allowance: res.allowance });
      celebrate(submitRef.current?.getBoundingClientRect());
      toast(t("composer.success"));
      bumpFeed();
      onClose();
    } catch (err) {
      setError(errorText(t, (err as { code: string }).code));
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <form className="modal composer" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <div className="modal-head">
          <h2 id="composer-title">{t("composer.title")}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("close")}>
            <XMarkIcon />
          </button>
        </div>

        <div className="kind-picker">
          <button type="button" className={`kind-opt ${kind === "kudos" ? "on" : ""}`} onClick={() => setKind("kudos")}>
            <ChatBubbleLeftRightIcon className="kind-ic" />
            <span>
              <b>{t("composer.kudos")}</b>
              <small>{t("composer.kudosDesc")}</small>
            </span>
          </button>
          <button
            type="button"
            className={`kind-opt bonus ${kind === "bonus" ? "on" : ""}`}
            onClick={() => bonusAvailable && setKind("bonus")}
            disabled={!bonusAvailable}
          >
            <GiftIcon className="kind-ic" />
            <span>
              <b>{t("composer.bonus")}</b>
              <small>{t("composer.bonusDesc", { n: allowance.remaining })}</small>
            </span>
          </button>
        </div>

        <label className="field-label" htmlFor="composer-to">
          {t("composer.to")}
        </label>
        <div className={`picker ${focused ? "focus" : ""}`} onClick={() => searchRef.current?.focus()}>
          {recipientIds.map((id) => (
            <span key={id} className="chip-person">
              <Avatar user={users[id]} size={22} link={false} />
              {name(users[id])}
              <button
                type="button"
                aria-label="remove"
                onClick={(e) => (e.stopPropagation(), setRecipientIds((ids) => ids.filter((x) => x !== id)))}
              >
                <XMarkIcon />
              </button>
            </span>
          ))}
          <input
            id="composer-to"
            ref={searchRef}
            value={query}
            autoComplete="off"
            onChange={(e) => (setQuery(e.target.value), setCursor(0))}
            onKeyDown={onSearchKey}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            placeholder={n ? "" : t("composer.toPlaceholder")}
          />
          {focused && (
            <ul className="picker-list" role="listbox">
              {candidates.length === 0 && <li className="picker-empty">{directory ? t("composer.noMatch") : t("loading")}</li>}
              {candidates.map((u, i) => (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={i === cursor}
                  className={i === cursor ? "on" : ""}
                  onPointerDown={(e) => (e.preventDefault(), add(u))}
                  onPointerEnter={() => setCursor(i)}
                >
                  <Avatar user={u} size={32} link={false} />
                  <span className="pl-name">
                    <b>{name(u)}</b>
                    {lang === "zh" && altName(u) && <small>{altName(u)}</small>}
                  </span>
                  <span className="pl-dept">{(lang === "en" && u.deptEn) || u.dept || u.handle}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="field-label">
          {t("composer.why")} <small>{t("composer.optional")}</small>
        </div>
        <div className="value-grid">
          {VALUES.map((v) => (
            <ValueChip key={v.id} id={v.id} active={valueTag === v.id} onClick={() => setValueTag((cur) => (cur === v.id ? null : v.id))} />
          ))}
        </div>

        <label className="field-label" htmlFor="composer-msg">
          {t("composer.message")}
        </label>
        <div className="textarea-wrap">
          <textarea
            id="composer-msg"
            ref={messageRef}
            value={message}
            maxLength={LIMITS.messageMax}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("composer.messagePlaceholder")}
            rows={4}
          />
          <span className="counter">
            {message.length}/{LIMITS.messageMax}
          </span>
        </div>
        <div className="ideas">
          <span className="muted">{t("composer.ideas")}</span>
          {(["composer.idea1", "composer.idea2", "composer.idea3"] as const).map((k) => (
            <button key={k} type="button" className="idea" onClick={() => insertIdea(t(k))}>
              {t(k).replace(/[,，!！.。\s]+$/, "")}
            </button>
          ))}
        </div>

        {kind === "bonus" && (
          <div className="bonus-box">
            <div className="field-label">{t("composer.amount")}</div>
            <div className="amounts">
              {amounts.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`amount ${points === a ? "on" : ""}`}
                  disabled={a * Math.max(1, n) > allowance.remaining}
                  onClick={() => setPoints(a)}
                >
                  +{a}
                </button>
              ))}
            </div>
            <div className={`bonus-total ${tooExpensive ? "bad" : ""}`}>
              {t("composer.total", { total: cost, remaining: allowance.remaining })}
            </div>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-foot">
          <span className="hint">
            {me.config.lark ? (
              <>
                <BellAlertIcon className="ic" /> {t("composer.notify")}
              </>
            ) : (
              t("composer.shortcut")
            )}
          </span>
          <button ref={submitRef} type="submit" className="btn primary" disabled={busy}>
            {busy ? t("composer.submitting") : t("composer.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
