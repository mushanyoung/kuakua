import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { type User, type Users } from "../api";
import { Constellation, type GraphEdge } from "../components/Constellation";
import { Feed } from "../components/Feed";
import { Avatar, CountUp, UserName } from "../components/ui";
import { shortDate } from "../i18n";
import { Link, navigate } from "../router";
import { useApp, useApi } from "../state";

type Overview = {
  month: { posts: number; points: number; people: number };
  total: number;
  graph: { nodes: number[]; edges: GraphEdge[] };
  users: Users;
};

type Board = { rows: { userId: number; count: number; points: number; people: number }[]; users: Users };

export function Wall() {
  const { t, lang, me, users, name, openComposer, feedVersion } = useApp();
  const overview = useApi<Overview>("/api/overview", [feedVersion]);
  const o = overview.data;

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="live-dot" /> {t("hero.eyebrow")}
          </div>
          <h1 className={`hero-title ${lang}`}>
            <span>{t("hero.title1")}</span>
            <span className="grad">{t("hero.title2")}</span>
          </h1>
          <p className="hero-sub">{t("hero.sub")}</p>
          <div className="hero-actions">
            <button type="button" className="btn primary lg" onClick={() => openComposer()}>
              {t("hero.cta")} <ArrowRightIcon className="ic" />
            </button>
            <button type="button" className="btn ghost lg" onClick={() => openComposer({ kind: "bonus" })}>
              {t("post.bonus")}
            </button>
          </div>
          <dl className="stats">
            <div>
              <dt>{t("stats.posts")}</dt>
              <dd>
                <CountUp value={o?.month.posts ?? 0} />
              </dd>
            </div>
            <div>
              <dt>{t("stats.people")}</dt>
              <dd>
                <CountUp value={o?.month.people ?? 0} />
              </dd>
            </div>
            <div>
              <dt>{t("stats.points")}</dt>
              <dd className="gold">
                <CountUp value={o?.month.points ?? 0} />
              </dd>
            </div>
            <div>
              <dt>{t("stats.total")}</dt>
              <dd>
                <CountUp value={o?.total ?? 0} />
              </dd>
            </div>
          </dl>
        </div>
        <div className="hero-graph">
          {o && (
            <Constellation
              nodeIds={o.graph.nodes}
              edges={o.graph.edges}
              users={{ ...o.users, ...users }}
              meId={me.user.id}
              label={(id) => name(users[id] ?? o.users[id])}
              onPick={(id) => navigate(`/u/${id}`)}
            />
          )}
          <div className="graph-hint">{t("hero.graphHint")}</div>
        </div>
      </section>

      <div className="wall">
        <main className="wall-main">
          <h2 className="section-title">{t("feed.title")}</h2>
          <Feed
            poll
            emptyAction={
              <button type="button" className="btn primary" onClick={() => openComposer()}>
                {t("cta.send")}
              </button>
            }
          />
        </main>
        <aside className="wall-side">
          <MeCard />
          <TopThisMonth />
          <Suggestions />
        </aside>
      </div>
    </>
  );
}

export function AllowanceRing({ remaining, total }: { remaining: number; total: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = total ? remaining / total : 0;
  return (
    <svg className="ring" viewBox="0 0 84 84" aria-hidden="true">
      <defs>
        <linearGradient id="ring-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF6B8B" />
          <stop offset=".6" stopColor="#FF9F6B" />
          <stop offset="1" stopColor="#FFD27A" />
        </linearGradient>
      </defs>
      <circle cx="42" cy="42" r={r} className="ring-track" />
      <circle
        cx="42"
        cy="42"
        r={r}
        className="ring-bar"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform="rotate(-90 42 42)"
      />
    </svg>
  );
}

function MeCard() {
  const { me, t, lang, name, openComposer } = useApp();
  const a = me.allowance;
  return (
    <section className="side-card me-card">
      <div className="me-row">
        <Avatar user={me.user} size={44} ring />
        <div>
          <div className="me-hi">{t("side.hi", { name: name(me.user) })}</div>
          <div className="muted small">{(lang === "en" && me.user.deptEn) || me.user.dept || me.email}</div>
        </div>
      </div>
      <div className="allowance">
        <div className="ring-wrap">
          <AllowanceRing remaining={a.remaining} total={a.total} />
          <div className="ring-num">
            <b>{a.remaining}</b>
            <small>/{a.total}</small>
          </div>
        </div>
        <div className="allowance-copy">
          <div className="eyebrow">{t("side.allowance")}</div>
          <p className="muted small">{t("side.resets", { date: shortDate(a.resetsAt, lang, me.config.timezone) })}</p>
          <button
            type="button"
            className="btn gold sm"
            disabled={a.remaining < Math.min(...me.config.bonusAmounts)}
            onClick={() => openComposer({ kind: "bonus" })}
          >
            {t("post.bonus")}
          </button>
        </div>
      </div>
    </section>
  );
}

function TopThisMonth() {
  const { t, users, feedVersion } = useApp();
  const board = useApi<Board>("/api/leaderboard?range=month&type=received", [feedVersion]);
  const rows = board.data?.rows.slice(0, 5) ?? [];
  return (
    <section className="side-card">
      <div className="side-head">
        <h3>{t("side.top")}</h3>
        <Link to="/leaderboard" className="side-link">
          {t("side.viewAll")} <ArrowRightIcon className="ic" />
        </Link>
      </div>
      {board.data && rows.length === 0 && <p className="muted small">{t("side.noTop")}</p>}
      <ol className="mini-board">
        {rows.map((r, i) => (
          <li key={r.userId}>
            <span className={`rank r${i + 1}`}>{i + 1}</span>
            <Avatar user={users[r.userId]} size={32} />
            <UserName user={users[r.userId]} />
            <span className="mini-count">
              {r.count}
              <small>{t("lb.times")}</small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Suggestions() {
  const { t, lang, name, openComposer, feedVersion } = useApp();
  const s = useApi<User[]>("/api/suggestions", [feedVersion]);
  if (!s.data?.length) return null;
  return (
    <section className="side-card">
      <div className="side-head">
        <h3>{t("side.suggest")}</h3>
      </div>
      <p className="muted small side-sub">{t("side.suggestSub")}</p>
      <ul className="suggest">
        {s.data.map((u) => (
          <li key={u.id}>
            <Avatar user={u} size={36} />
            <div className="suggest-name">
              <Link to={`/u/${u.id}`}>{name(u)}</Link>
              <small className="muted">
                {u.joinedAt && Date.now() - u.joinedAt < 45 * 86400_000 ? (
                  <span className="new-tag">{t("side.new")}</span>
                ) : null}
                {(lang === "en" && u.deptEn) || u.dept || u.title}
              </small>
            </div>
            <button type="button" className="btn soft sm" onClick={() => openComposer({ recipientIds: [u.id] })}>
              {t("side.thank")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
