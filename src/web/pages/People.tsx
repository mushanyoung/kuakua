import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { altName } from "../api";
import { Avatar, Empty, Spinner } from "../components/ui";
import { Link, navigate } from "../router";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { useApp } from "../state";

export function People() {
  const { t, lang, name, directory, loadDirectory, openComposer, me } = useApp();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadDirectory().catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (directory?.users ?? []).filter(
      (u) =>
        (!dept || u.dept === dept) &&
        (!s || [u.name, u.enName, u.handle, u.dept, u.deptEn, u.title].some((f) => f?.toLowerCase().includes(s))),
    );
  }, [directory, q, dept]);

  return (
    <div className="page">
      <Link to="/admin" className="back-link">
        <ArrowLeftIcon className="ic" /> {t("admin.back")}
      </Link>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("people.title")}</h1>
          <p className="muted">{t("people.sub", { n: directory?.users.length ?? "…" })}</p>
        </div>
      </header>

      <div className="search-bar">
        <MagnifyingGlassIcon className="ic" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("people.search")} />
        <kbd>/</kbd>
      </div>
      {directory && directory.departments.length > 1 && (
        <div className="dept-scroll">
          <button type="button" className={`dept-chip ${dept === null ? "on" : ""}`} onClick={() => setDept(null)}>
            {t("people.allDepts")}
          </button>
          {directory.departments.map((d) => (
            <button key={d.id} type="button" className={`dept-chip ${dept === d.name ? "on" : ""}`} onClick={() => setDept(d.name)}>
              {(lang === "en" && d.enName) || d.name} <small>{d.members}</small>
            </button>
          ))}
        </div>
      )}

      {!directory && <Spinner label={t("loading")} />}
      {directory && list.length === 0 && <Empty title={t("people.empty")} />}
      <div className="people-grid">
        {list.map((u, i) => (
          <div
            key={u.id}
            className="person"
            style={{ animationDelay: `${Math.min(i, 24) * 18}ms` }}
            onClick={() => navigate(`/u/${u.id}`)}
          >
            <Avatar user={u} size={72} link={false} ring={(u.received ?? 0) > 0} />
            <Link to={`/u/${u.id}`} className="person-name" onClick={(e) => e.stopPropagation()}>
              {name(u)}
            </Link>
            <div className="person-sub">
              {lang === "zh" && altName(u) ? <span>{altName(u)}</span> : null}
              <span>{(lang === "en" && u.deptEn) || u.dept || u.title || u.handle}</span>
            </div>
            <div className="person-foot">
              <span className="muted small">{t("people.received", { n: u.received ?? 0 })}</span>
              {u.id !== me.user.id && (
                <button
                  type="button"
                  className="btn soft sm"
                  onClick={(e) => (e.stopPropagation(), openComposer({ recipientIds: [u.id] }))}
                >
                  {t("side.thank")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
