import { env } from "cloudflare:workers";
import { userRowById } from "./store";

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
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  return "application/octet-stream";
}

export async function serveAvatar(id: number, size: string | null, versioned: boolean) {
  const row = await userRowById(id);
  if (!row) return new Response("not found", { status: 404 });
  const cache = versioned ? "private, max-age=31536000, immutable" : "private, max-age=3600";
  if (row.avatar_ver && row.avatar_key) {
    const big = row.avatar_key.endsWith("-240") ? row.avatar_key.replace(/-240$/, "-640") : null;
    for (const key of size === "640" && big ? [big, row.avatar_key] : [row.avatar_key]) {
      const obj = await env.FILES.get(key);
      if (!obj) continue;
      return new Response(obj.body, {
        headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream", "Cache-Control": cache },
      });
    }
  }
  return new Response(placeholder(id, row.name), {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, max-age=3600" },
  });
}
