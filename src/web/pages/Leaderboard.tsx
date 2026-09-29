import { useState } from "react";
import { type Users } from "../api";
import { Avatar, Empty, Segmented, Spinner, UserName } from "../components/ui";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { Link } from "../router";
import { useApp, useApi } from "../state";

type Range = "month" | "quarter" | "year" | "all";
type Type = "received" | "given";
type Board = { rows: { userId: number; count: number; points: number; people: number }[]; users: Users };

export function Leaderboard() {
  const { t, users, lang, openComposer } = useApp();
  const [range, setRange] = useState<Range>("month");
  const [type, setType] = useState<Type>("received");
  const board = useApi<Board>(`/api/leaderboard?range=${range}&type=${type}`);
  const rows = board.data?.rows ?? [];
  const top = rows.slice(0, 3);
  const rest = rows.slice(3);
  const max = rows[0]?.count ?? 1;
  const line = (r: Board["rows"][number]) =>
    t(type === "received" ? "lb.receivedLine" : "lb.givenLine", { count: r.count, people: r.people });
  const podium = [top[1], top[0], top[2]];

  return (
    <div className="page">
      <Link to="/admin" className="back-link">
        <ArrowLeftIcon className="ic" /> {t("admin.back")}
      </Link>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("lb.title")}</h1>
          <p className="muted">{t("lb.sub")}</p>
        </div>
        <div className="page-controls">
          <Segmented<Type>
            value={type}
            onChange={setType}
            options={[
              { value: "received", label: t("lb.received") },
              { value: "given", label: t("lb.given") },
            ]}
          />
          <Segmented<Range>
            value={range}
            onChange={setRange}
            size="sm"
            options={(["month", "quarter", "year", "all"] as const).map((r) => ({ value: r, label: t(`lb.${r}`) }))}
          />
        </div>
      </header>

      {board.loading && !board.data && <Spinner label={t("loading")} />}
      {board.data && rows.length === 0 && (
        <Empty
          title={t("lb.empty")}
          action={
            <button type="button" className="btn primary" onClick={() => openComposer()}>
              {t("cta.send")}
            </button>
          }
        />
      )}

      {top.length > 0 && (
        <section className="podium">
          {podium.map((r, i) => {
            if (!r) return <div key={i} className="podium-slot empty" />;
            const place = rows.indexOf(r) + 1;
            return (
              <div key={r.userId} className={`podium-slot p${place}`}>
                <div className="podium-avatar">
                  <Avatar user={users[r.userId]} size={place === 1 ? 128 : 96} />
                  <span className="podium-rank">{place}</span>
                </div>
                <UserName user={users[r.userId]} className="podium-name" />
                <div className="muted small">{(lang === "en" && users[r.userId]?.deptEn) || users[r.userId]?.dept}</div>
                <div className="podium-count">
                  <b>{r.count}</b>
                  {r.points > 0 && <span className="gold">+{r.points}</span>}
                </div>
                <div className="muted small">{line(r)}</div>
                <div className="podium-base" />
              </div>
            );
          })}
        </section>
      )}

      {rest.length > 0 && (
        <ol className="board" start={4}>
          {rest.map((r, i) => (
            <li key={r.userId} style={{ animationDelay: `${i * 30}ms` }}>
              <span className="rank">{i + 4}</span>
              <Avatar user={users[r.userId]} size={40} />
              <div className="board-name">
                <UserName user={users[r.userId]} />
                <small className="muted">{line(r)}</small>
              </div>
              <div className="board-bar">
                <span style={{ width: `${Math.max(6, (r.count / max) * 100)}%` }} />
              </div>
              <span className="board-count">{r.count}</span>
              <span className="board-points gold">{r.points > 0 ? `+${r.points}` : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
