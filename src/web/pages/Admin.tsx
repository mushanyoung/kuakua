import { useEffect, useRef, useState } from "react";
import { ArrowDownTrayIcon, ArrowPathIcon, ChevronRightIcon, TrophyIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { api, type Users } from "../api";
import { Avatar, Empty, Spinner, UserName } from "../components/ui";
import { errorText, relativeTime } from "../i18n";
import { Link } from "../router";
import { useApp, useApi } from "../state";

type Run = {
  id: number;
  trigger: string;
  started_at: number;
  finished_at: number | null;
  ok: number | null;
  users_seen: number | null;
  users_active: number | null;
  avatars_updated: number | null;
  error: string | null;
  warnings: string | null;
};
type Status = {
  last: Run | null;
  lastOk: Run | null;
  counts: { total: number; active: number; lark: number; withAvatar: number };
  running: boolean;
  source: "lark" | "roster";
  configured: boolean;
  periods: string[];
};
type Report = { period: string; rows: { userId: number; count: number; points: number; email: string | null }[]; users: Users };

const thisPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function Admin() {
  const { t, lang, me, users, toast, bumpFeed } = useApp();
  const status = useApi<Status>(me.isAdmin ? "/api/admin/status" : null);
  const periods = [...new Set([thisPeriod(), ...(status.data?.periods ?? [])])].sort().reverse();
  const [period, setPeriod] = useState(thisPeriod());
  const report = useApi<Report>(me.isAdmin ? `/api/admin/bonus-report?period=${period}` : null, [period]);

  const wasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(status.data?.running);
    if (wasRunning.current && !running) bumpFeed();
    wasRunning.current = running;
    if (!running) return;
    const id = setTimeout(status.reload, 2000);
    return () => clearTimeout(id);
  }, [status.data]);

  if (!me.isAdmin) return <Empty title={errorText(t, "forbidden")} />;
  const s = status.data;
  const roster = (s?.source ?? me.config.directory) === "roster";
  const warnings: string[] = s?.last?.ok && s.last.warnings ? JSON.parse(s.last.warnings) : [];

  async function sync() {
    try {
      await api("/api/admin/sync", { method: "POST", body: {} });
      status.reload();
    } catch (e) {
      toast(errorText(t, (e as { code: string }).code), "error");
    }
  }

  const runLine = (r: Run | null) =>
    !r ? t("admin.never") : `${relativeTime(r.started_at, lang, t)} · ${r.trigger} · ${r.ok ? t("admin.ok") : r.ok === 0 ? t("admin.failed") : "…"}`;

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">{t("admin.title")}</h1>
      </header>
      <div className="admin-links">
        <Link to="/leaderboard" className="admin-link">
          <TrophyIcon className="admin-link-ic" />
          <span>
            <b>{t("nav.leaderboard")}</b>
            <small>{t("admin.leaderboardDesc")}</small>
          </span>
          <ChevronRightIcon className="ic" />
        </Link>
        <Link to="/people" className="admin-link">
          <UserGroupIcon className="admin-link-ic" />
          <span>
            <b>{t("nav.people")}</b>
            <small>{t("admin.peopleDesc")}</small>
          </span>
          <ChevronRightIcon className="ic" />
        </Link>
      </div>
      <div className="admin-grid">
        <section className="side-card">
          <div className="side-head">
            <h3>{t(roster ? "admin.syncRoster" : "admin.syncLark")}</h3>
            <button type="button" className="btn soft sm" disabled={!s?.configured || s?.running} onClick={sync}>
              <ArrowPathIcon className={`ic ${s?.running ? "spin" : ""}`} /> {s?.running ? t("admin.syncing") : t("admin.syncNow")}
            </button>
          </div>
          {!s && <Spinner />}
          {s && !s.configured && <p className="form-error">{t(roster ? "admin.notConfiguredRoster" : "admin.notConfiguredLark")}</p>}
          {s && (
            <dl className="kv">
              <dt>{t("admin.lastSync")}</dt>
              <dd>{s.lastOk ? `${relativeTime(s.lastOk.finished_at ?? s.lastOk.started_at, lang, t)} · ${t("admin.syncResult", { users: s.lastOk.users_seen ?? 0, avatars: s.lastOk.avatars_updated ?? 0 })}` : t("admin.never")}</dd>
              <dt>{t("admin.lastRun")}</dt>
              <dd>{runLine(s.last)}</dd>
              {s.last?.error && (
                <>
                  <dt>Error</dt>
                  <dd className="form-error mono">{s.last.error}</dd>
                </>
              )}
              <dt>{t("admin.users")}</dt>
              <dd>{s.counts.active ?? 0}</dd>
              <dt>{t("admin.withAvatar")}</dt>
              <dd>{s.counts.withAvatar ?? 0}</dd>
              {warnings.length > 0 && (
                <>
                  <dt>{t("admin.warnings")}</dt>
                  <dd>
                    <ul className="sync-warnings">
                      {warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
          )}
        </section>

        <section className="side-card">
          <div className="side-head">
            <h3>{t("admin.report")}</h3>
            <div className="row-gap">
              <select value={period} onChange={(e) => setPeriod(e.target.value)} className="select">
                {periods.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <a className="btn soft sm" href={`/api/admin/bonus-report?period=${period}&format=csv`}>
                <ArrowDownTrayIcon className="ic" /> {t("admin.download")}
              </a>
            </div>
          </div>
          {report.data?.rows.length === 0 && <p className="muted small">{t("admin.noBonus")}</p>}
          {report.data && report.data.rows.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("admin.person")}</th>
                  <th>{t("admin.count")}</th>
                  <th>{t("admin.points")}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.rows.map((r) => (
                  <tr key={r.userId}>
                    <td>
                      <span className="row-gap">
                        <Avatar user={users[r.userId]} size={28} />
                        <UserName user={users[r.userId]} />
                        <span className="muted small">{r.email}</span>
                      </span>
                    </td>
                    <td>{r.count}</td>
                    <td className="gold">+{r.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
