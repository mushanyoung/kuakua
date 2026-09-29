import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cog6ToothIcon, HomeIcon, PlusIcon, TrophyIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type Me } from "./api";
import { Composer } from "./components/Composer";
import { Avatar, HeartMark, Logo } from "./components/ui";
import { makeT } from "./i18n";
import { Admin } from "./pages/Admin";
import { Leaderboard } from "./pages/Leaderboard";
import { People } from "./pages/People";
import { PostPage } from "./pages/PostPage";
import { ProfilePage } from "./pages/Profile";
import { Wall } from "./pages/Wall";
import { Link, match, useLocation } from "./router";
import { AppProvider, LANG_KEY, useApp, type ComposerPrefill } from "./state";

function Nav() {
  const { t, lang, setLang, me, openComposer } = useApp();
  const { path } = useLocation();
  const links = [
    { to: "/", label: t("nav.wall"), icon: HomeIcon, on: path === "/" || path.startsWith("/k/") },
    { to: "/leaderboard", label: t("nav.leaderboard"), icon: TrophyIcon, on: path === "/leaderboard" },
    { to: "/people", label: t("nav.people"), icon: UserGroupIcon, on: path === "/people" },
    ...(me.isAdmin ? [{ to: "/admin", label: t("nav.admin"), icon: Cog6ToothIcon, on: path === "/admin" }] : []),
  ];
  return (
    <>
      <header className="nav">
        <div className="nav-inner">
          <Link to="/" className="nav-logo" aria-label="夸夸">
            <Logo />
          </Link>
          <nav className="nav-links">
            {links.map((l) => (
              <Link key={l.to} to={l.to} className={l.on ? "on" : ""}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="nav-right">
            <button type="button" className="lang-btn" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
              {t("lang.switch")}
            </button>
            <button type="button" className="btn primary sm nav-send" onClick={() => openComposer()}>
              <HeartMark className="ic" /> {t("cta.send")}
            </button>
            <Link to={`/u/${me.user.id}`} className="nav-me" aria-label={t("nav.me")}>
              <Avatar user={me.user} size={34} link={false} ring />
            </Link>
          </div>
        </div>
      </header>
      <nav className="tabbar">
        {links.slice(0, 2).map((l) => (
          <Link key={l.to} to={l.to} className={l.on ? "on" : ""}>
            <l.icon />
            <span>{l.label}</span>
          </Link>
        ))}
        <button type="button" className="tab-send" onClick={() => openComposer()} aria-label={t("cta.send")}>
          <PlusIcon />
        </button>
        <Link to="/people" className={path === "/people" ? "on" : ""}>
          <UserGroupIcon />
          <span>{t("nav.people")}</span>
        </Link>
        <Link to={`/u/${me.user.id}`} className={path === `/u/${me.user.id}` ? "on" : ""}>
          <Avatar user={me.user} size={24} link={false} />
          <span>{t("nav.me")}</span>
        </Link>
      </nav>
    </>
  );
}

function Routes() {
  const { path } = useLocation();
  const { t } = useApp();
  let m: Record<string, string> | null;
  if (path === "/") return <Wall />;
  if (path === "/leaderboard") return <Leaderboard />;
  if (path === "/people") return <People />;
  if (path === "/admin") return <Admin />;
  if ((m = match("/u/:id", path))) return <ProfilePage key={m.id} id={m.id!} />;
  if ((m = match("/k/:id", path))) return <PostPage key={m.id} id={m.id!} />;
  return (
    <div className="page narrow">
      <h1 className="page-title">404</h1>
      <Link to="/">{t("post.back")}</Link>
    </div>
  );
}

function App({ me }: { me: Me }) {
  const [composer, setComposer] = useState<{ prefill?: ComposerPrefill; key: number } | null>(null);
  return (
    <AppProvider initialMe={me} onOpenComposer={(prefill) => setComposer({ prefill, key: Date.now() })}>
      {(toasts) => (
        <>
          <Nav />
          <div className="shell">
            <Routes />
          </div>
          <Footer />
          {composer && <Composer key={composer.key} prefill={composer.prefill} onClose={() => setComposer(null)} />}
          <div className="toasts" aria-live="polite">
            {toasts.map((x) => (
              <div key={x.id} className={`toast ${x.tone}`}>
                {x.tone === "ok" && <HeartMark className="ic" />}
                {x.text}
              </div>
            ))}
          </div>
        </>
      )}
    </AppProvider>
  );
}

function Footer() {
  const { t } = useApp();
  return (
    <footer className="footer">
      <HeartMark className="ic" /> {t("footer")}
    </footer>
  );
}

function Fatal({ code }: { code: string }) {
  const lang = (() => {
    try {
      return localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";
    } catch {
      return "zh";
    }
  })();
  const t = makeT(lang);
  const key = code === "email_domain_not_allowed" ? "err.forbidden" : code === "network" ? "err.network" : "err.unauthenticated";
  return (
    <div className="fatal">
      <HeartMark className="empty-mark" />
      <h2>{t(key as "err.forbidden")}</h2>
      <button type="button" className="btn primary" onClick={() => location.reload()}>
        {t("retry")}
      </button>
    </div>
  );
}

const fonts = document.createElement("link");
fonts.rel = "stylesheet";
fonts.href = "/fonts/fonts.css";
document.head.appendChild(fonts);

const root = createRoot(document.getElementById("root")!);
api<Me>("/api/me")
  .then((me) =>
    root.render(
      <StrictMode>
        <App me={me} />
      </StrictMode>,
    ),
  )
  .catch((e: ApiError) => root.render(<Fatal code={e.code} />));
