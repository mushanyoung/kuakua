import { env } from "cloudflare:workers";
import { avatarVersion, HttpError, toUser, userRowById, type UserRow, type Viewer } from "./store";
import { db } from "./db";
import { AVATAR_TYPES, MAX_AVATAR_BYTES } from "../shared/avatars";

// Avatars live in R2 (the FILES bucket). users.avatar_key names the 240px image; Lark
// avatars also have a 640px one at the same key with "-640". Roster avatars are served
// straight from where scripts/deploy.sh uploaded them (roster/...).

export async function putAvatar(key: string, bytes: Uint8Array) {
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: sniff(bytes) } });
}

export async function shortHash(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GRADIENTS = [
  ["#FF6B8B", "#FF9F6B"],
  ["#FF9F6B", "#FFD27A"],
  ["#B79BFF", "#FF8FB1"],
  ["#7FB2FF", "#B79BFF"],
  ["#5EE6C0", "#7FB2FF"],
  ["#FFD27A", "#FF6B8B"],
];

function initials(name: string) {
  const trimmed = name.trim();
  if (/[㐀-鿿]/.test(trimmed)) return [...trimmed].slice(-2).join("");
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : trimmed.slice(0, 2)).toUpperCase();
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function placeholder(id: number, name: string) {
  const [a, b] = GRADIENTS[id % GRADIENTS.length]!;
  const text = escape(initials(name) || "?");
  const size = [...text].length > 1 && /[㐀-鿿]/.test(text) ? 34 : 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="120" height="120" fill="url(#g)"/>
<text x="60" y="61" text-anchor="middle" dominant-baseline="central" fill="#1a1024" fill-opacity="0.82"
 font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, sans-serif" font-weight="700" font-size="${size}">${text}</text>
</svg>`;
}

export function sniff(bytes: Uint8Array) {
  const at = (offset: number, signature: number[]) => signature.every((b, i) => bytes[offset + i] === b);
  const ascii = (offset: number, text: string) => at(offset, [...text].map((c) => c.charCodeAt(0)));
  if (bytes.length >= 4 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 24 && at(0, [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) && ascii(12, "IHDR")) return "image/png";
  if (bytes.length >= 20 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (bytes.length >= 13 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return "image/gif";
  return "application/octet-stream";
}

async function editableUser(id: number, viewer: Viewer) {
  if (id !== viewer.id && !viewer.isAdmin) throw new HttpError(403, "forbidden");
  const row = await userRowById(id);
  if (!row) throw new HttpError(404, "user_not_found");
  return row;
}

// Bound the actual stream as well as Content-Length, which may be absent or inaccurate.
async function readUpload(req: Request) {
  if (Number(req.headers.get("content-length")) > MAX_AVATAR_BYTES) throw new HttpError(413, "avatar_too_large");
  if (!req.body) throw new HttpError(400, "avatar_invalid");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AVATAR_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "avatar_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!AVATAR_TYPES.includes(sniff(bytes))) throw new HttpError(415, "avatar_invalid");
  return bytes;
}

async function cleanup(key: string) {
  // A cleanup failure must not turn a successfully saved avatar into a failed request.
  await env.FILES.delete(key).catch((e: unknown) => console.error("[avatar] cleanup failed", key, e));
}

async function replaceCustomAvatar(row: UserRow, key: string | null) {
  // Compare-and-swap prevents simultaneous uploads/removals from deleting the winner's file.
  const result = await db.run(
    `UPDATE users SET custom_avatar_key = $key, updated_at = $now
     WHERE id = $id AND custom_avatar_key IS $previous`,
    { key, now: Date.now(), id: row.id, previous: row.custom_avatar_key },
  );
  if (!result.changes) throw new HttpError(409, "avatar_changed");
}

export async function uploadAvatar(id: number, viewer: Viewer, req: Request) {
  const row = await editableUser(id, viewer);
  const bytes = await readUpload(req);
  const key = `custom-avatars/${id}/${crypto.randomUUID()}`;
  await putAvatar(key, bytes);
  try {
    await replaceCustomAvatar(row, key);
  } catch (e) {
    await cleanup(key);
    throw e;
  }
  if (row.custom_avatar_key) await cleanup(row.custom_avatar_key);
  return toUser((await userRowById(id))!);
}

export async function removeAvatar(id: number, viewer: Viewer) {
  const row = await editableUser(id, viewer);
  if (row.custom_avatar_key) {
    await replaceCustomAvatar(row, null);
    await cleanup(row.custom_avatar_key);
  }
  return toUser((await userRowById(id))!);
}

export async function serveAvatar(id: number, size: string | null, version: string | null) {
  const row = await userRowById(id);
  if (!row) return new Response("not found", { status: 404 });
  // Never cache today's bytes under a stale version URL after a replacement or removal.
  let cache = version === avatarVersion(row) ? "private, max-age=31536000, immutable" : "private, no-store";
  const imageResponse = (obj: R2ObjectBody) => new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (row.custom_avatar_key) {
    const obj = await env.FILES.get(row.custom_avatar_key);
    if (obj) return imageResponse(obj);
    cache = "private, no-store";
  }
  if (row.avatar_ver && row.avatar_key) {
    const big = row.avatar_key.endsWith("-240") ? row.avatar_key.replace(/-240$/, "-640") : null;
    for (const key of size === "640" && big ? [big, row.avatar_key] : [row.avatar_key]) {
      const obj = await env.FILES.get(key);
      if (!obj) continue;
      return imageResponse(obj);
    }
  }
  return new Response(placeholder(id, row.name), {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" },
  });
}
