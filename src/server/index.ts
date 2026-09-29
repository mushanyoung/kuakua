import type { BunRequest } from "bun";
import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import index from "../web/index.html";
import { config, larkEnabled } from "./config";
import { authenticate } from "./auth";
import { db } from "./db";
import { serveAvatar } from "./avatars";
import { lastSuccessfulSync, notifyPost, syncDirectory, syncRunning } from "./lark";
import * as store from "./store";
import { HttpError, type Viewer } from "./store";
import { isPeriod, periodOf, type Range } from "./time";

type Ctx<P extends string> = { req: BunRequest<P>; viewer: Viewer; url: URL };

function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

async function body(req: Request) {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new HttpError(415, "json_required");
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

const intParam = (v: string | null | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function api<P extends string>(handler: (ctx: Ctx<P>) => unknown, opts: { admin?: boolean } = {}) {
  return async (req: BunRequest<P>) => {
    try {
      if (req.method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "bad_origin");
      const viewer = store.resolveViewer(await authenticate(req));
      if (opts.admin && !viewer.isAdmin) throw new HttpError(403, "admin_only");
      const result = await handler({ req, viewer, url: new URL(req.url) });
      return result instanceof Response ? result : Response.json(result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.code }, { status: e.status });
      console.error(e);
      return Response.json({ error: "internal" }, { status: 500 });
    }
  };
}

function me(viewer: Viewer) {
  return {
    user: store.toUser(viewer.row),
    email: viewer.email,
    isAdmin: viewer.isAdmin,
    lang: viewer.row.lang,
    allowance: store.allowance(viewer.id),
    config: {
      monthlyAllowance: config.bonus.monthlyAllowance,
      bonusPoints: config.bonus.points,
      lark: larkEnabled(),
      timezone: config.timezone,
    },
  };
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Self-hosted fonts (OFL), served straight from node_modules. Google Fonts is not
// reliably reachable from mainland China.
const FONTS: Record<string, string> = {
  "bricolage-latin.woff2": "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
  "bricolage-latin-ext.woff2": "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-ext-wght-normal.woff2",
  "figtree-latin.woff2": "@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
  "figtree-latin-ext.woff2": "@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2",
  "jetbrains-mono-latin.woff2": "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  "instrument-serif-latin-italic.woff2": "@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2",
};
const nodeModules = join(import.meta.dir, "../../node_modules");

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  development: config.production ? false : { hmr: true, console: true },
  routes: {
    "/healthz": new Response("ok"),

    "/api/me": { GET: api(({ viewer }) => me(viewer)) },
    "/api/me/prefs": {
      PUT: api(async ({ req, viewer }) => store.setLang(viewer.id, String((await body(req)).lang))),
    },

    "/api/users": { GET: api(() => store.listUsers()) },
    "/api/users/:id": {
      GET: api<"/api/users/:id">(({ req, viewer }) =>
        store.profile(req.params.id === "me" ? viewer.id : (intParam(req.params.id) ?? 0)),
      ),
    },

    "/api/posts": {
      GET: api(({ url, viewer }) => {
        const q = url.searchParams;
        return store.feed(
          {
            cursor: intParam(q.get("cursor")),
            after: intParam(q.get("after")),
            limit: intParam(q.get("limit")),
            kind: q.get("kind") ?? undefined,
            tag: q.get("tag") ?? undefined,
            userId: intParam(q.get("user")),
            role: (q.get("role") as "received" | "sent" | "any") ?? "any",
          },
          viewer,
        );
      }),
      POST: api(async ({ req, viewer }) => {
        const input = await body(req);
        const id = store.createPost(input as unknown as store.NewPost, viewer);
        const detail = store.postDetail(id, viewer);
        const p = detail.post;
        const allowance = store.allowance(viewer.id);
        notifyPost(p, allowance.remaining).catch((e) => console.error("notify", e));
        return { ...detail, allowance };
      }),
    },
    "/api/posts/:id": {
      GET: api<"/api/posts/:id">(({ req, viewer }) => store.postDetail(intParam(req.params.id) ?? 0, viewer)),
      DELETE: api<"/api/posts/:id">(({ req, viewer }) => {
        store.deletePost(intParam(req.params.id) ?? 0, viewer);
        return { ok: true, allowance: store.allowance(viewer.id) };
      }),
    },
    "/api/posts/:id/reactions": {
      POST: api<"/api/posts/:id/reactions">(async ({ req, viewer }) =>
        store.toggleReaction(intParam(req.params.id) ?? 0, (await body(req)).emoji, viewer),
      ),
    },
    "/api/posts/:id/comments": {
      POST: api<"/api/posts/:id/comments">(async ({ req, viewer }) =>
        store.addComment(intParam(req.params.id) ?? 0, (await body(req)).body, viewer),
      ),
    },
    "/api/comments/:id": {
      DELETE: api<"/api/comments/:id">(({ req, viewer }) => store.deleteComment(intParam(req.params.id) ?? 0, viewer)),
    },

    "/api/overview": { GET: api(() => store.overview()) },
    "/api/leaderboard": {
      GET: api(
        ({ url }) => {
          const range = url.searchParams.get("range") as Range;
          const type = url.searchParams.get("type") === "given" ? "given" : "received";
          return store.leaderboard(store.RANGES.includes(range) ? range : "month", type);
        },
        { admin: true },
      ),
    },

    "/api/admin/status": {
      GET: api(() => ({ ...store.syncStatus(), running: syncRunning(), lark: larkEnabled(), periods: store.bonusPeriods() }), {
        admin: true,
      }),
    },
    "/api/admin/sync": {
      POST: api(
        () => {
          if (!larkEnabled()) throw new HttpError(409, "lark_not_configured");
          syncDirectory("manual").catch(() => {});
          return { started: true };
        },
        { admin: true },
      ),
    },
    "/api/admin/bonus-report": {
      GET: api(
        ({ url }) => {
          const period = url.searchParams.get("period") ?? periodOf();
          if (!isPeriod(period)) throw new HttpError(400, "bad_period");
          const report = store.bonusReport(period);
          if (url.searchParams.get("format") !== "csv") return report;
          const lines = [["email", "name", "en_name", "department", "bonus_count", "points"].join(",")];
          for (const r of report.rows) {
            const u = report.users[r.userId];
            lines.push([r.email, u?.name, u?.enName, u?.dept, r.count, r.points].map(csvCell).join(","));
          }
          return new Response("﻿" + lines.join("\n") + "\n", {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="peer-bonus-${period}.csv"`,
            },
          });
        },
        { admin: true },
      ),
    },
    "/api/*": Response.json({ error: "not_found" }, { status: 404 }),

    // Kept out of the HTML bundle so Bun doesn't inline every subset as base64.
    "/fonts/fonts.css": new Response(Bun.file(join(import.meta.dir, "fonts.css")), {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    }),
    "/fonts/:file": (req: BunRequest<"/fonts/:file">) => {
      const path = FONTS[req.params.file];
      if (!path) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(nodeModules, path)), {
        headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    },

    "/avatars/:id": {
      GET: api<"/avatars/:id">(({ req, url }) =>
        serveAvatar(intParam(req.params.id) ?? 0, url.searchParams.get("s"), url.searchParams.has("v")),
      ),
    },

    "/*": index,
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(`kuakua listening on ${server.url} (${config.production ? "production" : "development"})`);

// ---------------------------------------------------------------- background jobs

function maybeSync() {
  if (!larkEnabled() || syncRunning()) return;
  const status = store.syncStatus() as { last: { ok: number | null; started_at: number } | null };
  if (status.last && !status.last.ok && Date.now() - status.last.started_at < 30 * 60_000) return;
  if (Date.now() - lastSuccessfulSync() < config.lark.syncIntervalHours * 3600_000) return;
  syncDirectory("schedule").catch(() => {});
}

function backupDaily() {
  const dir = join(config.dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `kuakua-${new Date().toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) return;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir).filter((f) => f.startsWith("kuakua-")).sort().slice(0, -14);
  for (const f of old) rmSync(join(dir, f));
}

// A sync that was running when the process died will never finish; close it out.
db.query("UPDATE sync_runs SET finished_at = started_at, ok = 0, error = 'interrupted' WHERE finished_at IS NULL").run();
setTimeout(maybeSync, 3_000);
setInterval(maybeSync, 10 * 60_000);
if (config.production) {
  backupDaily();
  setInterval(backupDaily, 3600_000);
}
