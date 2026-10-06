import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HomeIcon, PlusIcon } from "@heroicons/react/24/outline";
import { api, ApiError, type Me } from "./api";
import { Composer } from "./components/Composer";
import { KuaLinkPage } from "./components/KuaLink";
import { Avatar, HeartMark, Logo } from "./components/ui";
import { makeT } from "./i18n";
import { Admin } from "./pages/Admin";
import { Leaderboard } from "./pages/Leaderboard";
import { People } from "./pages/People";
import { PostPage } from "./pages/PostPage";
import { ProfilePage } from "./pages/Profile";
import { Wall } from "./pages/Wall";
import { Link, match, navigate, useLocation } from "./router";
import { AppProvider, LANG_KEY, useApp, type ComposerPrefill } from "./state";
import { setValues } from "../shared/values";

function Nav() {
  const { t, lang, setLang, me, openComposer } = useApp();
  const { path } = useLocation();
  // Leaderboard and people directory are admin-only and reached from the admin page.
  const adminArea = path === "/admin" || path === "/leaderboard" || path === "/people";
  const links = [
    { to: "/", label: t("nav.wall"), on: path === "/" || path.startsWith("/k/") },
    ...(me.isAdmin ? [{ to: "/admin", label: t("nav.admin"), on: adminArea }] : []),
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
        <Link to="/" className={links[0]!.on ? "on" : ""}>
          <HomeIcon />
          <span>{t("nav.wall")}</span>
        </Link>
        <button type="button" className="tab-send" onClick={() => openComposer()} aria-label={t("cta.send")}>
          <PlusIcon />
        </button>
        <Link to={`/u/${me.user.id}`} className={path === `/u/${me.user.id}` ? "on" : ""}>
          <Avatar user={me.user} size={24} link={false} />
          <span>{t("nav.me")}</span>
        </Link>
      </nav>
    </>
  );
}

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

function Routes() {
  const { path } = useLocation();
  const { t, me } = useApp();
  let m: Record<string, string> | null;
  if (path === "/") return <Wall />;
  if (path === "/leaderboard") return me.isAdmin ? <Leaderboard /> : <Redirect to="/" />;
  if (path === "/people") return me.isAdmin ? <People /> : <Redirect to="/" />;
  if (path === "/admin") return <Admin />;
  if ((m = match("/u/:id", path))) return <ProfilePage key={m.id} id={m.id!} />;
  if ((m = match("/k/:id", path))) return <PostPage key={m.id} id={m.id!} />;
  if ((m = match("/kua/:handle", path))) return <KuaLinkPage key={m.handle} handle={m.handle!} />;
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
  .then((me) => {
    setValues(me.config.values);
    root.render(
      <StrictMode>
        <App me={me} />
      </StrictMode>,
    );
  })
  .catch((e: ApiError) => root.render(<Fatal code={e.code} />));
