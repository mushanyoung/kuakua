import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Feed as FeedData, type Post } from "../api";
import { errorText } from "../i18n";
import { useApp } from "../state";
import { values } from "../../shared/values";
import { PostCard } from "./PostCard";
import { Empty, Segmented, Spinner, ValueChip } from "./ui";

type Kind = "all" | "kudos" | "bonus";

export function Feed({
  base = "",
  filters = true,
  poll = false,
  emptyAction,
}: {
  base?: string;
  filters?: boolean;
  poll?: boolean;
  emptyAction?: ReactNode;
}) {
  const { t, mergeUsers, feedVersion } = useApp();
  const [kind, setKind] = useState<Kind>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const seenVersion = useRef(feedVersion);

  const qs = useCallback(
    (extra: Record<string, string | number | undefined>) => {
      const p = new URLSearchParams(base);
      if (kind !== "all") p.set("kind", kind);
      if (tag) p.set("tag", tag);
      for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
      return p.toString();
    },
    [base, kind, tag],
  );

  const load = useCallback(
    async (reset: boolean, markFresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const data = await api<FeedData>(`/api/posts?${qs({ cursor: reset ? undefined : (cursor ?? undefined) })}`);
        mergeUsers(data.users);
        setPosts((prev) => {
          if (markFresh && prev) {
            const known = new Set(prev.map((p) => p.id));
            setFresh(new Set(data.posts.filter((p) => !known.has(p.id)).map((p) => p.id)));
          }
          return reset ? data.posts : [...(prev ?? []), ...data.posts];
        });
        setCursor(data.nextCursor);
        if (reset) setPending(0);
      } catch (e) {
        setError(errorText(t, (e as { code: string }).code));
      } finally {
        setLoading(false);
      }
    },
    [qs, cursor, mergeUsers, t],
  );

  useEffect(() => {
    setPosts(null);
    load(true);
  }, [qs]);

  useEffect(() => {
    if (feedVersion === seenVersion.current) return;
    seenVersion.current = feedVersion;
    load(true, true);
  }, [feedVersion]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && !loading && load(false), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, load]);

  useEffect(() => {
    if (!poll) return;
    const id = setInterval(async () => {
      const top = posts?.[0]?.id;
      if (!top || document.hidden) return;
      try {
        const data = await api<FeedData>(`/api/posts?${qs({ after: top, limit: 50 })}`);
        setPending(data.posts.length);
      } catch {}
    }, 45_000);
    return () => clearInterval(id);
  }, [poll, posts, qs]);

  const update = (p: Post) => setPosts((ps) => ps?.map((x) => (x.id === p.id ? p : x)) ?? ps);
  const remove = (id: number) => setPosts((ps) => ps?.filter((x) => x.id !== id) ?? ps);

  return (
    <div className="feed">
      {filters && (
        <div className="feed-filters">
          <Segmented<Kind>
            value={kind}
            onChange={setKind}
            size="sm"
            options={[
              { value: "all", label: t("feed.all") },
              { value: "kudos", label: t("post.kudos") },
              { value: "bonus", label: t("post.bonus") },
            ]}
          />
          <div className="tag-scroll">
            {values().map((v) => (
              <ValueChip key={v.id} id={v.id} size="sm" active={tag === v.id} onClick={() => setTag((c) => (c === v.id ? null : v.id))} />
            ))}
          </div>
        </div>
      )}

      {pending > 0 && (
        <button type="button" className="new-pill" onClick={() => load(true, true)}>
          {t("feed.new", { n: pending })}
        </button>
      )}

      {posts === null && !error && <Spinner label={t("loading")} />}
      {error && (
        <div className="form-error">
          {error}{" "}
          <button type="button" className="link-btn" onClick={() => load(true)}>
            {t("retry")}
          </button>
        </div>
      )}
      {posts?.length === 0 && <Empty title={t("feed.empty")} sub={t("feed.emptySub")} action={emptyAction} />}
      <div className="post-list">
        {posts?.map((p) => <PostCard key={p.id} post={p} onChange={update} onDeleted={remove} fresh={fresh.has(p.id)} linked />)}
      </div>
      <div ref={sentinel} />
      {posts && posts.length > 0 && (
        <div className="feed-end">{cursor ? loading ? <Spinner /> : null : <span>{t("feed.end")}</span>}</div>
      )}
    </div>
  );
}
