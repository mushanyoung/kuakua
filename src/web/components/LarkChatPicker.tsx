import { UserGroupIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, type LarkChat, type LarkChatMembers, type LarkChatPage, type Users } from "../api";
import { errorText } from "../i18n";
import { useApp } from "../state";

async function* pages<T extends { nextCursor: string | null }>(path: string, signal: AbortSignal) {
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: T = await api<T>(path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), { signal });
    if (signal.aborted) return;
    yield page;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new ApiError("lark_chats_failed", 502);
    if (cursor) seen.add(cursor);
  } while (cursor);
}

export function LarkChatPicker({
  onAdd,
  onBusyChange,
  disabled,
}: {
  onAdd: (users: Users, skipped: number) => string;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<LarkChat[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingChat, setLoadingChat] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const memberRequest = useRef<AbortController | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const addLatest = useRef(onAdd);
  // Use the latest recipients, CC and post kind even if they change during loading.
  useEffect(() => {
    addLatest.current = onAdd;
  }, [onAdd]);
  useEffect(
    () => () => {
      memberRequest.current?.abort();
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit retry trigger after a failed request.
  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    setChats([]);
    setLoading(true);
    setListError(null);
    (async () => {
      try {
        for await (const page of pages<LarkChatPage>("/api/lark/chats", request.signal)) {
          setChats((prev) => [...new Map([...prev, ...page.chats].map((c) => [c.id, c])).values()]);
        }
      } catch (e) {
        if (!request.signal.aborted) setListError((e as ApiError).code);
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    })();
    return () => request.abort();
  }, [open, reload]);

  function cancel() {
    memberRequest.current?.abort();
    memberRequest.current = null;
    setLoadingChat(null);
    onBusyChange(false);
  }

  async function select(chat: LarkChat) {
    if (memberRequest.current || disabled) return;
    const request = new AbortController();
    memberRequest.current = request;
    setLoadingChat(chat.id);
    setMemberError(null);
    setNotice("");
    onBusyChange(true);
    try {
      const users: Users = {};
      let skipped = 0;
      for await (const page of pages<LarkChatMembers>(`/api/lark/chats/${encodeURIComponent(chat.id)}/members`, request.signal)) {
        Object.assign(users, page.users);
        skipped += page.skipped;
      }
      if (request.signal.aborted) return;
      setNotice(addLatest.current(users, skipped));
      setOpen(false);
      setQuery("");
      toggleRef.current?.focus();
    } catch (e) {
      if (!request.signal.aborted) setMemberError((e as ApiError).code);
    } finally {
      if (!request.signal.aborted) {
        memberRequest.current = null;
        setLoadingChat(null);
        onBusyChange(false);
      }
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const matches = chats.filter((c) => c.name.toLocaleLowerCase().includes(needle));
  return (
    <fieldset
      className="lark-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          cancel();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        className="lark-chat-toggle"
        disabled={disabled}
        aria-expanded={open}
        aria-controls="composer-lark-chats"
        onClick={() => {
          cancel();
          setMemberError(null);
          setOpen(!open);
        }}
      >
        <UserGroupIcon className="ic" /> {t("composer.fromLarkChat")}
      </button>
      {open && (
        <div id="composer-lark-chats" className="lark-chat-panel">
          <p className="hint">{t("composer.larkChatHint")}</p>
          <input
            className="lark-chat-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("composer.larkChatSearch")}
            aria-label={t("composer.larkChatSearch")}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          />
          <ul className="lark-chat-list" aria-label={t("composer.fromLarkChat")}>
            {matches.map((chat) => (
              <li key={chat.id}>
                <button type="button" disabled={disabled || loadingChat !== null} onClick={() => select(chat)}>
                  <UserGroupIcon className="ic" />
                  <span>
                    <b>{chat.name}</b>
                    {chat.description && <small>{chat.description}</small>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {loading && (
            <p className="hint" role="status">
              {t("loading")}
            </p>
          )}
          {!loading && !listError && matches.length === 0 && (
            <p className="hint">{t(query ? "composer.larkChatNoMatch" : "composer.larkChatEmpty")}</p>
          )}
          {listError && (
            <div className="form-error" role="alert">
              {errorText(t, listError)}{" "}
              <button type="button" className="link-btn" onClick={() => setReload((n) => n + 1)}>
                {t("retry")}
              </button>
            </div>
          )}
          {loadingChat && (
            <p className="hint" role="status">
              {t("composer.larkChatLoading")}{" "}
              <button type="button" className="link-btn" onClick={cancel}>
                {t("cancel")}
              </button>
            </p>
          )}
          {memberError && (
            <div className="form-error" role="alert">
              {errorText(t, memberError)}
            </div>
          )}
        </div>
      )}
      {notice && (
        <p className="hint lark-chat-notice" role="status">
          {notice}
        </p>
      )}
    </fieldset>
  );
}
