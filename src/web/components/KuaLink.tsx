import { useEffect, useRef, useState } from "react";
import { CheckIcon, LinkIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { type User } from "../api";
import { Link, navigate } from "../router";
import { useApp } from "../state";
import { Avatar, Empty, Spinner } from "./ui";

// Personal "kudos link": /kua/<email handle> opens the composer with that person prefilled.
export const kuaUrl = (u: User) => `${location.origin}/kua/${encodeURIComponent(u.handle ?? String(u.id))}`;

export function KuaLinkButton({ user }: { user: User }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
        <LinkIcon className="ic" /> {t("kua.button")}
      </button>
      {open && <KuaLinkDialog user={user} onClose={() => setOpen(false)} />}
    </>
  );
}

function KuaLinkDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const { t, me, name, toast } = useApp();
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const url = kuaUrl(user);
  const self = user.id === me.user.id;

  useEffect(() => {
    input.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      input.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    toast(t("kua.copied"));
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small kua-dialog" role="dialog" aria-modal="true" aria-labelledby="kua-title">
        <div className="modal-head">
          <h2 id="kua-title">{self ? t("kua.titleSelf") : t("kua.title", { name: name(user) })}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("close")}>
            <XMarkIcon />
          </button>
        </div>
        <div className="kua-who">
          <Avatar user={user} size={44} link={false} ring />
          <p className="muted">{self ? t(me.config.directory === "lark" ? "kua.descSelfLark" : "kua.descSelf") : t("kua.desc", { name: name(user) })}</p>
        </div>
        <div className="kua-copy">
          <input ref={input} readOnly value={url} onFocus={(e) => e.target.select()} aria-label={t("kua.button")} />
          <button type="button" className="btn primary" onClick={copy}>
            {copied ? <CheckIcon className="ic" /> : <LinkIcon className="ic" />}
            {copied ? t("kua.copied") : t("kua.copy")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Route target for /kua/:handle.
export function KuaLinkPage({ handle }: { handle: string }) {
  const { t, me, loadDirectory, openComposer, toast } = useApp();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    loadDirectory()
      .then((d) => {
        if (!alive) return;
        const h = handle.toLowerCase();
        const u = d.users.find((x) => x.handle?.toLowerCase() === h) ?? (/^\d+$/.test(h) ? d.users.find((x) => x.id === Number(h)) : undefined);
        if (!u) return setMissing(true);
        navigate(`/u/${u.id}`, { replace: true });
        if (u.id === me.user.id) toast(t("kua.self"));
        else openComposer({ recipientIds: [u.id] });
      })
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [handle]);

  if (!missing) return <Spinner label={t("loading")} />;
  return (
    <div className="page narrow">
      <Empty
        title={t("kua.notFound")}
        action={
          <Link to="/" className="btn primary">
            {t("post.back")}
          </Link>
        }
      />
    </div>
  );
}
