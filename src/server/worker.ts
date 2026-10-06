import { authenticate } from "./auth";
import { serveAvatar } from "./avatars";
import { config, emailNotifyEnabled, larkNotifyEnabled, notifyChannels } from "./config";
import { directoryConfigured, maybeSync, syncDirectory, syncRunning } from "./directory";
import { sendTestEmail } from "./email";
import { langOf, notifyPost } from "./notify";
import * as store from "./store";
import { HttpError, type Viewer } from "./store";
import { isPeriod, periodOf, type Range } from "./time";
import { values } from "../shared/values";

// Cloudflare Worker entry. Static files (the web app, fonts) are served from ./dist by
// Workers Static Assets; only /api/*, /avatars/* and /healthz reach this code
// (assets.run_worker_first in the wrangler config).

type Ctx = { req: Request; url: URL; params: Record<string, string>; viewer: Viewer; ctx: ExecutionContext };
type Handler = (c: Ctx) => unknown;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; admin?: boolean };

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler, opts: { admin?: boolean } = {}) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, pattern, keys, handler, ...opts });
}

function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
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

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function me(viewer: Viewer) {
  return {
    user: store.toUser(viewer.row),
    email: viewer.email,
    isAdmin: viewer.isAdmin,
    lang: viewer.row.lang,
    emailNotify: viewer.row.email_notify === 1,
    allowance: await store.allowance(viewer.id),
    config: {
      monthlyAllowance: config.bonus.monthlyAllowance,
      bonusPoints: config.bonus.points,
      // How people thanked or CC'd are notified: "lark", "email".
      notify: notifyChannels(),
      directory: config.directory.source,
      timezone: config.timezone,
      values: values(),
    },
  };
}

// ---------------------------------------------------------------- routes

route("GET", "/api/me", ({ viewer }) => me(viewer));
route("PUT", "/api/me/prefs", async ({ req, viewer }) => store.setPrefs(viewer.id, await body(req)));

route("GET", "/api/users", ({ viewer }) => store.listUsers(viewer));
route("GET", "/api/users/:id", ({ params, viewer }) => store.profile(params.id === "me" ? viewer.id : (intParam(params.id) ?? 0), viewer));

route("GET", "/api/posts", ({ url, viewer }) => {
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
});
route("POST", "/api/posts", async ({ req, viewer, ctx }) => {
  const id = await store.createPost((await body(req)) as unknown as store.NewPost, viewer);
  const [detail, allowance] = await Promise.all([store.postDetail(id, viewer), store.allowance(viewer.id)]);
  ctx.waitUntil(notifyPost(detail.post, allowance.remaining).catch((e: unknown) => console.error("notify", e)));
  return { ...detail, allowance };
});
route("GET", "/api/posts/:id", ({ params, viewer }) => store.postDetail(intParam(params.id) ?? 0, viewer));
route("DELETE", "/api/posts/:id", async ({ params, viewer }) => {
  await store.deletePost(intParam(params.id) ?? 0, viewer);
  return { ok: true, allowance: await store.allowance(viewer.id) };
});
route("POST", "/api/posts/:id/reactions", async ({ req, params, viewer }) =>
  store.toggleReaction(intParam(params.id) ?? 0, (await body(req)).emoji, viewer),
);
route("POST", "/api/posts/:id/comments", async ({ req, params, viewer }) =>
  store.addComment(intParam(params.id) ?? 0, (await body(req)).body, viewer),
);
route("DELETE", "/api/comments/:id", ({ params, viewer }) => store.deleteComment(intParam(params.id) ?? 0, viewer));

route("GET", "/api/overview", () => store.overview());
route(
  "GET",
  "/api/leaderboard",
  ({ url }) => {
    const range = url.searchParams.get("range") as Range;
    const type = url.searchParams.get("type") === "given" ? "given" : "received";
    return store.leaderboard(store.RANGES.includes(range) ? range : "month", type);
  },
  { admin: true },
);

route(
  "GET",
  "/api/admin/status",
  async () => ({
    // First, so runs it closes as interrupted show up as such below.
    running: await syncRunning(),
    ...(await store.syncStatus()),
    source: config.directory.source,
    configured: await directoryConfigured(),
    periods: await store.bonusPeriods(),
    notify: {
      lark: larkNotifyEnabled(),
      larkBroadcast: larkNotifyEnabled() && Boolean(config.lark.broadcastChatId),
      email: emailNotifyEnabled(),
      emailFrom: config.email.notify ? config.email.from : null,
    },
  }),
  { admin: true },
);
// Sends a test email to the admin, to check EMAIL_FROM's domain is onboarded.
route(
  "POST",
  "/api/admin/test-email",
  async ({ viewer }) => {
    if (!emailNotifyEnabled()) throw new HttpError(409, "email_not_configured");
    try {
      return { ok: true, to: viewer.email, messageId: await sendTestEmail(viewer.email, langOf(viewer.row)) };
    } catch (e) {
      return { ok: false, to: viewer.email, error: (e as Error).message };
    }
  },
  { admin: true },
);
// Runs the sync inside the request rather than after responding: work left to waitUntil()
// gets cut off ~30 s after the response, which a full Lark sync can exceed.
route(
  "POST",
  "/api/admin/sync",
  async () => {
    if (!(await directoryConfigured())) throw new HttpError(409, "directory_not_configured");
    try {
      const result = await syncDirectory("manual");
      return result ? { ok: true, ...result } : { ok: true, alreadyRunning: true };
    } catch (e) {
      throw new HttpError(502, "sync_failed", (e as Error).message);
    }
  },
  { admin: true },
);
route(
  "GET",
  "/api/admin/bonus-report",
  async ({ url }) => {
    const period = url.searchParams.get("period") ?? periodOf();
    if (!isPeriod(period)) throw new HttpError(400, "bad_period");
    const report = await store.bonusReport(period);
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
);

// ---------------------------------------------------------------- entry

// The roster is re-read when its upload changes; page loads check for that, at most once a
// minute per Worker instance (this is a cache of "recently checked", not request state).
let rosterCheckedAt = 0;

async function handleApi(req: Request, url: URL, ctx: ExecutionContext) {
  try {
    const match = routes.find((r) => r.pattern.test(url.pathname));
    if (!match) throw new HttpError(404, "not_found");
    const found = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!found) throw new HttpError(405, "method_not_allowed");
    if (req.method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "bad_origin");
    const viewer = await store.resolveViewer(await authenticate(req));
    if (found.admin && !viewer.isAdmin) throw new HttpError(403, "admin_only");
    const m = found.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(found.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
    if (config.directory.source === "roster" && Date.now() - rosterCheckedAt > 60_000) {
      rosterCheckedAt = Date.now();
      ctx.waitUntil(maybeSync("request").catch(() => {}));
    }
    const result = await found.handler({ req, url, params, viewer, ctx });
    return result instanceof Response ? result : Response.json(result ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.code }, { status: e.status });
    console.error(e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Public (Access bypass); the version header lets scripts/deploy.sh see the new code is live.
    if (url.pathname === "/healthz") return new Response("ok", { headers: { "X-Kuakua-Version": config.version } });
    if (url.pathname.startsWith("/api/")) return handleApi(req, url, ctx);
    const avatar = /^\/avatars\/(\d+)$/.exec(url.pathname);
    if (avatar && req.method === "GET") {
      try {
        await authenticate(req);
      } catch (e) {
        if (e instanceof HttpError) return new Response(e.code, { status: e.status });
        throw e;
      }
      return serveAvatar(Number(avatar[1]), url.searchParams.get("s"), url.searchParams.has("v"));
    }
    return env.ASSETS.fetch(req);
  },

  // Awaited rather than handed to waitUntil(): a cron invocation may run for up to 15 minutes.
  async scheduled() {
    await maybeSync("schedule");
  },
} satisfies ExportedHandler<Env>;
