import { useId, useRef, useState } from "react";
import { ArrowUturnLeftIcon, CameraIcon } from "@heroicons/react/20/solid";
import { AVATAR_TYPES, MAX_AVATAR_BYTES } from "../../shared/avatars";
import { api, type User } from "../api";
import { errorText } from "../i18n";
import { useApp } from "../state";

export function AvatarEditor({ user, onChange }: { user: User; onChange: (user: User) => void }) {
  const { t, updateUser, bumpFeed, toast } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [busy, setBusy] = useState(false);

  async function save(file?: File) {
    if (busy) return;
    if (file && file.size > MAX_AVATAR_BYTES) {
      toast(t("err.avatar_too_large"), "error");
      return;
    }
    setBusy(true);
    try {
      const updated = await api<User>(`/api/users/${user.id}/avatar`, { method: file ? "PUT" : "DELETE", body: file });
      updateUser(updated);
      onChange(updated);
      bumpFeed();
      toast(t(file ? "avatar.saved" : "avatar.restored"));
    } catch (e) {
      toast(errorText(t, (e as { code: string }).code), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="avatar-editor" aria-busy={busy}>
      <input
        ref={input}
        type="file"
        hidden
        accept={AVATAR_TYPES.join(",")}
        aria-label={t("avatar.upload")}
        disabled={busy}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void save(file);
        }}
      />
      <div className="row-gap">
        <button type="button" className="btn soft sm" disabled={busy} aria-describedby={hintId} onClick={() => input.current?.click()}>
          <CameraIcon className="ic" /> {t(busy ? "avatar.saving" : "avatar.upload")}
        </button>
        {user.customAvatar && (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void save()} title={t("avatar.restoreHint")}>
            <ArrowUturnLeftIcon className="ic" /> {t("avatar.restore")}
          </button>
        )}
      </div>
      <p id={hintId} className="muted small">{t("avatar.hint")}</p>
    </div>
  );
}
