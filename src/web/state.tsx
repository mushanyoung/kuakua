import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Me, type User, type Users } from "./api";
import { makeT, type Lang, type T } from "./i18n";

export type Directory = { users: User[]; departments: { id: string; name: string; enName: string | null; members: number }[] };
export type ComposerPrefill = { recipientIds?: number[]; kind?: "kudos" | "bonus" };
export type Toast = { id: number; text: string; tone: "ok" | "error" };

type AppCtx = {
  me: Me;
  setMe: (me: Me) => void;
  refreshMe: () => Promise<void>;
  lang: Lang;
  setLang: (l: Lang) => void;
  t: T;
  users: Users;
  mergeUsers: (u: Users) => void;
  directory: Directory | null;
  loadDirectory: () => Promise<Directory>;
  openComposer: (prefill?: ComposerPrefill) => void;
  feedVersion: number;
  bumpFeed: () => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  name: (u: User | undefined) => string;
};

const Ctx = createContext<AppCtx | null>(null);

export const useApp = () => useContext(Ctx)!;

export const LANG_KEY = "kuakua.lang";

function initialLang(me: Me): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {}
  return me.lang ?? "zh";
}

export function AppProvider({
  initialMe,
  onOpenComposer,
  children,
}: {
  initialMe: Me;
  onOpenComposer: (p?: ComposerPrefill) => void;
  children: (toasts: Toast[]) => ReactNode;
}) {
  const [me, setMe] = useState(initialMe);
  const [lang, setLangState] = useState<Lang>(() => initialLang(initialMe));
  const [users, setUsers] = useState<Users>({ [initialMe.user.id]: initialMe.user });
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [feedVersion, setFeedVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dirPromise = useRef<Promise<Directory> | null>(null);

  const t = useMemo(() => makeT(lang), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = lang === "zh" ? "夸夸" : "夸夸 · Kuakua";
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {}
    api("/api/me/prefs", { method: "PUT", body: { lang: l } }).catch(() => {});
  }, []);

  const mergeUsers = useCallback((u: Users) => setUsers((prev) => ({ ...prev, ...u })), []);

  const loadDirectory = useCallback(() => {
    dirPromise.current ??= api<Directory>("/api/users").then((d) => {
      setDirectory(d);
      setUsers((prev) => ({ ...prev, ...Object.fromEntries(d.users.map((u) => [u.id, u])) }));
      return d;
    });
    dirPromise.current.catch(() => (dirPromise.current = null));
    return dirPromise.current;
  }, []);

  const refreshMe = useCallback(async () => setMe(await api<Me>("/api/me")), []);

  const bumpFeed = useCallback(() => {
    setFeedVersion((v) => v + 1);
    dirPromise.current = null;
  }, []);

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3200);
  }, []);

  const name = useCallback((u: User | undefined) => (!u ? "…" : lang === "en" ? u.enName || u.name : u.name), [lang]);

  const value: AppCtx = {
    me,
    setMe,
    refreshMe,
    lang,
    setLang,
    t,
    users,
    mergeUsers,
    directory,
    loadDirectory,
    openComposer: onOpenComposer,
    feedVersion,
    bumpFeed,
    toast,
    name,
  };
  return <Ctx.Provider value={value}>{children(toasts)}</Ctx.Provider>;
}

// Small data hook: refetches when deps change; merges any `users` map into the cache.
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const { mergeUsers } = useApp();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: Boolean(path),
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(path)
      .then((data) => {
        if (!alive) return;
        const maybeUsers = (data as { users?: Users }).users;
        if (maybeUsers && !Array.isArray(maybeUsers)) mergeUsers(maybeUsers);
        setState({ data, error: null, loading: false });
      })
      .catch((e: { code?: string }) => alive && setState({ data: null, error: e.code ?? "internal", loading: false }));
    return () => {
      alive = false;
    };
  }, [path, nonce, ...deps]);
  return { ...state, reload: () => setNonce((n) => n + 1), setData: (d: T) => setState((s) => ({ ...s, data: d })) };
}
