import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import {
  ArrowRightIcon,
  ChatBubbleOvalLeftIcon,
  EllipsisHorizontalIcon,
  FaceSmileIcon,
  LinkIcon,
  PaperAirplaneIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { SparklesIcon } from "@heroicons/react/20/solid";
import { api, type Comment, type Feed, type Post, type PostDetail, type Users } from "../api";
import { errorText, relativeTime } from "../i18n";
import { Link, navigate } from "../router";
import { useApp } from "../state";
import { LIMITS, PLUS_ONE, REACTIONS } from "../../shared/values";
import { Avatar, AvatarStack, UserName, ValueChip } from "./ui";

export function PostCard({
  post,
  onChange,
  onDeleted,
  openComments = false,
  fresh = false,
  linked = false,
}: {
  post: Post;
  onChange: (p: Post) => void;
  onDeleted: (id: number) => void;
  openComments?: boolean;
  fresh?: boolean;
  /** Clicking the card's empty space opens the post page. */
  linked?: boolean;
}) {
  const { users, t, lang, me, mergeUsers, toast, name, refreshMe } = useApp();
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [showComments, setShowComments] = useState(openComments);
  const [burst, setBurst] = useState<string | null>(null);
  const popoverWasOpen = useRef(false);
  const sender = users[post.senderId];
  const recipients = post.recipientIds.map((id) => users[id]);
  const bonus = post.kind === "bonus";

  async function react(emoji: string) {
    setPicker(false);
    const mine = post.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me.user.id);
    if (!mine) {
      setBurst(emoji);
      setTimeout(() => setBurst(null), 700);
    }
    try {
      const res = await api<Feed>(`/api/posts/${post.id}/reactions`, { method: "POST", body: { emoji } });
      mergeUsers(res.users);
      onChange(res.posts[0]!);
    } catch (e) {
      toast(errorText(t, (e as { code: string }).code), "error");
    }
  }

  async function remove() {
    setMenu(false);
    if (!confirm(t("post.confirmDelete"))) return;
    try {
      await api(`/api/posts/${post.id}`, { method: "DELETE" });
      onDeleted(post.id);
      toast(t("post.deleted"));
      refreshMe();
    } catch (e) {
      toast(errorText(t, (e as { code: string }).code), "error");
    }
  }

  function copyLink() {
    setMenu(false);
    navigator.clipboard?.writeText(`${location.origin}/k/${post.id}`).then(() => toast(t("post.copied")));
  }

  function openFromBlank(e: MouseEvent<HTMLElement>) {
    const el = e.target as Element;
    // A click that just dismissed a popover shouldn't also navigate away.
    if (popoverWasOpen.current) return;
    if (el.closest("a, button, input, textarea, .popover, .comments, .avatar, .kind-badge, .points-badge, .value-chip")) return;
    // Text stays selectable: a drag-select or a click on the words themselves doesn't count.
    if (window.getSelection()?.toString()) return;
    if (!el.closest('[aria-hidden="true"]') && overText(el, e.clientX, e.clientY)) return;
    const to = `/k/${post.id}`;
    if (e.metaKey || e.ctrlKey) window.open(to, "_blank", "noopener");
    else navigate(to);
  }

  // Up to 3 recipients fit in the header; a bigger group gets its own row so nobody is hidden behind "+N".
  const group = recipients.length > 3;

  return (
    <article
      className={`post ${bonus ? "bonus" : ""} ${fresh ? "fresh" : ""} ${linked ? "linked" : ""}`}
      onPointerDown={linked ? () => (popoverWasOpen.current = picker || menu) : undefined}
      onClick={linked ? openFromBlank : undefined}
    >
      {bonus && <div className="post-glow" aria-hidden="true" />}
      <header className="post-head">
        <div className="post-people">
          <Avatar user={sender} size={36} />
          <UserName user={sender} className="sender" />
          <ArrowRightIcon className="post-arrow" aria-hidden="true" />
          {group ? (
            <span className="recipients group-count">{t("post.groupCount", { n: recipients.length })}</span>
          ) : (
            <>
              <AvatarStack users={recipients} size={36} max={3} />
              <span className="recipients">
                {recipients.map((u, i) => (
                  <span key={u?.id ?? i}>
                    {i > 0 && <span className="sep">{t("post.sep")}</span>}
                    <UserName user={u} />
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
        <Link to={`/k/${post.id}`} className="post-time" title={new Date(post.createdAt).toLocaleString()}>
          {relativeTime(post.createdAt, lang, t)}
        </Link>
      </header>

      {group && (
        <ul className="post-group">
          {recipients.map((u, i) => (
            <li key={u?.id ?? i}>
              {u ? (
                <Link to={`/u/${u.id}`} className="group-chip">
                  <Avatar user={u} size={24} link={false} />
                  <span>{name(u)}</span>
                </Link>
              ) : (
                <span className="group-chip">
                  <Avatar user={u} size={24} />
                  <span>…</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="post-body">
        <span className="quote-mark" aria-hidden="true">
          “
        </span>
        <p>
          <span>{post.message}</span>
        </p>
      </div>

      <div className="post-tags">
        <span className={`kind-badge ${post.kind}`}>{bonus ? t("post.bonus") : t("post.kudos")}</span>
        {post.valueTag && <ValueChip id={post.valueTag} size="sm" />}
        {bonus && (
          <span className="points-badge">
            <SparklesIcon className="ic" aria-hidden="true" />+{post.points}
            <small>
              {t("post.pts")}
              {post.recipientIds.length > 1 ? ` · ${t("post.each")}` : ""}
            </small>
          </span>
        )}
      </div>

      {post.ccIds.length > 0 && (
        <div className="post-cc">
          <span className="muted">{t("post.cc")}</span>
          {post.ccIds.map((id, i) => (
            <span key={id}>
              {i > 0 && <span className="sep">{t("post.sep")}</span>}
              <UserName user={users[id]} />
            </span>
          ))}
        </div>
      )}

      <footer className="post-foot">
        <div className="reactions">
          {post.reactions.map((r) => {
            const mine = r.userIds.includes(me.user.id);
            const who = r.userIds.map((id) => name(users[id])).join(t("post.sep"));
            return (
              <button
                key={r.emoji}
                type="button"
                className={`reaction ${mine ? "mine" : ""} ${burst === r.emoji ? "pop" : ""}`}
                onClick={() => react(r.emoji)}
                title={who}
              >
                <span className={`emo ${r.emoji === PLUS_ONE ? "plus-one" : ""}`}>{r.emoji}</span>
                <span className="n">{r.userIds.length}</span>
              </button>
            );
          })}
          {!post.reactions.some((r) => r.emoji === PLUS_ONE) && (
            <button type="button" className={`reaction ghost ${burst === PLUS_ONE ? "pop" : ""}`} onClick={() => react(PLUS_ONE)} title={t("post.plusOne")}>
              <span className="emo plus-one">+1</span>
            </button>
          )}
          <div className="react-add-wrap">
            <button type="button" className="icon-btn" aria-label={t("post.react")} onClick={() => setPicker((v) => !v)}>
              <FaceSmileIcon />
            </button>
            {picker && (
              <Popover onClose={() => setPicker(false)} className="emoji-pop">
                {REACTIONS.map((e) => (
                  <button key={e} type="button" className={e === PLUS_ONE ? "plus-one" : ""} onClick={() => react(e)}>
                    {e}
                  </button>
                ))}
              </Popover>
            )}
          </div>
          {burst && !post.reactions.some((r) => r.emoji === burst) && (
            <span className={`burst ${burst === PLUS_ONE ? "plus-one" : ""}`}>{burst}</span>
          )}
        </div>
        <div className="post-actions">
          <button
            type="button"
            className={`icon-btn with-label ${showComments ? "on" : ""}`}
            onClick={() => setShowComments((v) => !v)}
            aria-expanded={showComments}
          >
            <ChatBubbleOvalLeftIcon />
            {post.commentCount > 0 && <span>{post.commentCount}</span>}
          </button>
          <div className="react-add-wrap">
            <button type="button" className="icon-btn" aria-label="More" onClick={() => setMenu((v) => !v)}>
              <EllipsisHorizontalIcon />
            </button>
            {menu && (
              <Popover onClose={() => setMenu(false)} className="menu-pop">
                <button type="button" onClick={copyLink}>
                  <LinkIcon /> {t("post.copy")}
                </button>
                {post.canDelete && (
                  <button type="button" className="danger" onClick={remove}>
                    <TrashIcon /> {t("post.delete")}
                  </button>
                )}
              </Popover>
            )}
          </div>
        </div>
      </footer>

      {showComments && <Comments post={post} onCount={(n) => onChange({ ...post, commentCount: n })} />}
    </article>
  );
}

/** Whether (x, y) lands on one of el's own text glyphs rather than the empty part of its box. */
function overText(el: Element, x: number, y: number) {
  const range = document.createRange();
  return [...el.childNodes].some((n) => {
    if (n.nodeType !== Node.TEXT_NODE || !n.textContent?.trim()) return false;
    range.selectNodeContents(n);
    return [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  });
}

function Popover({ children, onClose, className }: { children: ReactNode; onClose: () => void; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`popover ${className}`}>
      {children}
    </div>
  );
}

function Comments({ post, onCount }: { post: Post; onCount: (n: number) => void }) {
  const { users, mergeUsers, t, lang, me, toast } = useApp();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (d: PostDetail) => {
    mergeUsers(d.users as Users);
    setComments(d.comments);
    onCount(d.comments.length);
  };

  useEffect(() => {
    api<PostDetail>(`/api/posts/${post.id}`)
      .then((d) => {
        mergeUsers(d.users);
        setComments(d.comments);
      })
      .catch(() => setComments([]));
  }, [post.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      apply(await api<PostDetail>(`/api/posts/${post.id}/comments`, { method: "POST", body: { body: text } }));
      setText("");
    } catch (err) {
      toast(errorText(t, (err as { code: string }).code), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      apply(await api<PostDetail>(`/api/comments/${id}`, { method: "DELETE" }));
    } catch (err) {
      toast(errorText(t, (err as { code: string }).code), "error");
    }
  }

  return (
    <section className="comments">
      {comments === null ? (
        <div className="comments-loading" />
      ) : (
        comments.map((c) => (
          <div key={c.id} className="comment">
            <Avatar user={users[c.userId]} size={28} />
            <div className="comment-main">
              <div className="comment-meta">
                <UserName user={users[c.userId]} />
                <span className="muted">{relativeTime(c.createdAt, lang, t)}</span>
                {c.canDelete && (
                  <button type="button" className="link-btn" onClick={() => remove(c.id)}>
                    {t("post.delete")}
                  </button>
                )}
              </div>
              <p>{c.body}</p>
            </div>
          </div>
        ))
      )}
      <form className="comment-form" onSubmit={submit}>
        <Avatar user={me.user} size={28} link={false} />
        <input
          value={text}
          maxLength={LIMITS.commentMax}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("post.writeComment")}
          aria-label={t("post.writeComment")}
        />
        <button type="submit" className="icon-btn send" disabled={!text.trim() || busy} aria-label={t("post.send")}>
          <PaperAirplaneIcon />
        </button>
      </form>
    </section>
  );
}
