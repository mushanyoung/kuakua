import { useState } from "react";
import { altName, type User, type Users } from "../api";
import { Feed } from "../components/Feed";
import { KuaLinkButton } from "../components/KuaLink";
import { Avatar, CountUp, Empty, Segmented, Spinner, ValueChip } from "../components/ui";
import { errorText } from "../i18n";
import { Link } from "../router";
import { useApp, useApi } from "../state";
import { AllowanceRing } from "./Wall";

type Profile = {
  user: User;
  stats: { received: { count: number; points: number; people: number }; sent: { count: number; points: number } };
  values: { tag: string; count: number }[];
  supporters: { userId: number; count: number }[];
  users: Users;
};

export function ProfilePage({ id }: { id: string }) {
  const { t, lang, me, users, name, openComposer, feedVersion } = useApp();
  const [tab, setTab] = useState<"received" | "sent">("received");
  const res = useApi<Profile>(`/api/users/${id}`, [feedVersion]);
  const p = res.data;
  if (res.error) return <Empty title={errorText(t, res.error)} />;
  if (!p) return <Spinner label={t("loading")} />;
  const u = p.user;
  const isMe = u.id === me.user.id;
  const maxValue = p.values[0]?.count ?? 1;

  return (
    <div className="page profile">
      <section className="profile-hero">
        <div className="profile-banner" aria-hidden="true" />
        <div className="profile-main">
          <Avatar user={u} size={132} ring link={false} className="profile-avatar" />
          <div className="profile-id">
            <h1>
              {name(u)}
              {lang === "zh" && altName(u) && <span className="en">{altName(u)}</span>}
            </h1>
            <p className="muted">
              {[(lang === "en" && u.deptEn) || u.dept, u.title].filter(Boolean).join(" · ") || u.handle}
            </p>
          </div>
          <div className="profile-cta row-gap">
            {isMe ? (
              <>
                <span className="you-tag">{t("profile.you")}</span>
                {me.isAdmin && (
                  <Link to="/admin" className="btn soft sm">
                    {t("nav.admin")}
                  </Link>
                )}
              </>
            ) : (
              <button type="button" className="btn primary" onClick={() => openComposer({ recipientIds: [u.id] })}>
                {t("profile.thank")}
              </button>
            )}
            <KuaLinkButton user={u} />
          </div>
        </div>
        <dl className="stats profile-stats">
          <div>
            <dt>{t("profile.received")}</dt>
            <dd>
              <CountUp value={p.stats.received.count} />
            </dd>
          </div>
          <div>
            <dt>{t("profile.points")}</dt>
            <dd className="gold">
              <CountUp value={p.stats.received.points} />
            </dd>
          </div>
          <div>
            <dt>{t("profile.people")}</dt>
            <dd>
              <CountUp value={p.stats.received.people} />
            </dd>
          </div>
          <div>
            <dt>{t("profile.sent")}</dt>
            <dd>
              <CountUp value={p.stats.sent.count} />
            </dd>
          </div>
        </dl>
      </section>

      <div className="wall">
        <main className="wall-main">
          <div className="profile-tabs">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "received", label: t("profile.tabReceived") },
                { value: "sent", label: t("profile.tabSent") },
              ]}
            />
          </div>
          <Feed key={tab} base={`user=${u.id}&role=${tab}`} filters={false} />
        </main>
        <aside className="wall-side">
          {isMe && (
            <section className="side-card">
              <div className="allowance">
                <div className="ring-wrap">
                  <AllowanceRing remaining={me.allowance.remaining} total={me.allowance.total} />
                  <div className="ring-num">
                    <b>{me.allowance.remaining}</b>
                    <small>/{me.allowance.total}</small>
                  </div>
                </div>
                <div className="allowance-copy">
                  <div className="eyebrow">{t("side.allowance")}</div>
                </div>
              </div>
            </section>
          )}
          <section className="side-card">
            <h3>{t("profile.values")}</h3>
            {p.values.length === 0 && <p className="muted small">{t("profile.noValues")}</p>}
            <ul className="value-bars">
              {p.values.map((v) => (
                <li key={v.tag}>
                  <ValueChip id={v.tag} size="sm" />
                  <span className="vb-track">
                    <span style={{ width: `${(v.count / maxValue) * 100}%` }} />
                  </span>
                  <b>{v.count}</b>
                </li>
              ))}
            </ul>
          </section>
          <section className="side-card">
            <h3>{t("profile.supporters")}</h3>
            {p.supporters.length === 0 && <p className="muted small">{t("profile.noSupporters")}</p>}
            <ul className="supporters">
              {p.supporters.map((s) => (
                <li key={s.userId} title={name(users[s.userId])}>
                  <Avatar user={users[s.userId]} size={40} />
                  <span className="sup-count">{s.count}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
