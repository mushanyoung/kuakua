import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { Link } from "../router";
import { useApp } from "../state";
import { LIMITS, PLUS_ONE, REACTIONS } from "../../shared/values";
import { Avatar, AvatarStack, UserName, ValueChip } from "./ui";

export function PostCard({
  post,
  onChange,
  onDeleted,
  openComments = false,
  fresh = false,
}: {
  post: Post;
  onChange: (p: Post) => void;
  onDeleted: (id: number) => void;
  openComments?: boolean;
  fresh?: boolean;
}) {
  const { users, t, lang, me, mergeUsers, toast, name, refreshMe } = useApp();
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [showComments, setShowComments] = useState(openComments);
  const [burst, setBurst] = useState<string | null>(null);
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

  const recipientNames =
    recipients.length <= 3
      ? recipients.map((u) => <UserName key={u?.id} user={u} />)
      : [
          ...recipients.slice(0, 2).map((u) => <UserName key={u?.id} user={u} />),
          <span key="more" className="muted">
            {t("post.andMore", { n: recipients.length - 2 })}
          </span>,
        ];

  return (
    <article className={`post ${bonus ? "bonus" : ""} ${fresh ? "fresh" : ""}`}>
      {bonus && <div className="post-glow" aria-hidden="true" />}
      <header className="post-head">
        <div className="post-people">
          <Avatar user={sender} size={36} />
          <UserName user={sender} className="sender" />
          <ArrowRightIcon className="post-arrow" aria-hidden="true" />
          <AvatarStack users={recipients} size={36} max={3} />
          <span className="recipients">
            {recipientNames.flatMap((n, i) => (i ? [<span key={`s${i}`} className="sep">{t("post.sep")}</span>, n] : [n]))}
          </span>
        </div>
        <Link to={`/k/${post.id}`} className="post-time" title={new Date(post.createdAt).toLocaleString()}>
          {relativeTime(post.createdAt, lang, t)}
        </Link>
      </header>

      <div className="post-body">
        <span className="quote-mark" aria-hidden="true">
          “
        </span>
        <p>{post.message}</p>
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
