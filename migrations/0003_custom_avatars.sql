-- Keep uploaded avatars separate from the directory's avatar, so syncing never
-- overwrites an upload and removing it restores the latest directory avatar.
ALTER TABLE users ADD COLUMN custom_avatar_key TEXT;
