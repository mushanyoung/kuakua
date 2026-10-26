import "../../scripts/lib/privacy.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndParseConfig } from "@cloudflare/config";
import { Log, LogLevel, Miniflare, WorkerOptionsSchema } from "miniflare";
import { required } from "../../src/shared/required.ts";
import { ROOT } from "../../scripts/lib/env.ts";
import { applyLocalMigrations } from "../../scripts/lib/local-d1.ts";
import { createWorkerConfig } from "../../scripts/lib/worker-config.ts";

// Exercise cf's actual Vite build in workerd, with isolated D1/R2 and no remote bindings.
export function createRuntime(initialVars: Record<string, string> = {}, fixedClock = false) {
  let vars = initialVars;
  let runtime: Miniflare | undefined;
  let state: string | undefined;
  const logs: unknown[] = [];
  class TestLog extends Log {
    protected override log(message: string) {
      logs.push(message);
    }
  }
  async function options() {
    const parsed = await resolveAndParseConfig({ worker: createWorkerConfig() }, { mode: "development", isPreview: false });
    if (!parsed.success) throw parsed.error;
    const config = { ...required(parsed.data.worker) };
    Reflect.deleteProperty(config, "entrypoint");
    const bundle = await readFile(join(ROOT, ".cloudflare/output/v0/workers/default/bundle/index.js"), "utf8");
    const worker = WorkerOptionsSchema.parse({
      config: {
        ...config,
        env: { ...config.env, ...Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: "text", value }])) },
        assets: { ...config.assets, directory: join(ROOT, "dist"), hasUserWorker: true },
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": {
              type: "esm",
              contents: `${fixedClock ? 'Date.now = () => Date.parse("2026-10-26T12:00:00.000Z");\n' : ""}${bundle}`,
            },
          },
        },
      },
    });
    return {
      workers: [worker],
      host: "127.0.0.1",
      port: 0,
      cf: false,
      resourcePersistencePath: join(required(state), "v3"),
      isolatedResourcePersistencePath: join(required(state), "isolated"),
      unsafeEnableSharedStorage: true,
      unsafeDevRegistryPath: join(required(state), "registry"),
      telemetry: { enabled: false },
      log: new TestLog(LogLevel.DEBUG),
      handleStructuredLogs: (log: unknown) => {
        logs.push(log);
      },
    };
  }
  async function getRuntime() {
    if (!runtime) throw new Error("Call listen() before using the test runtime");
    return runtime;
  }
  const worker = {
    async fetch(path: string, init?: Omit<RequestInit, "body"> & { body?: BodyInit | Uint8Array<ArrayBufferLike> }) {
      const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : init?.body;
      return fetch(new URL(path, await (await getRuntime()).ready), { ...init, body });
    },
    async getEnv() {
      return (await getRuntime()).getBindings<Env>();
    },
    async scheduled(options: { cron: string }) {
      const service = await (await getRuntime()).getWorker();
      // workerd Fetcher exposes scheduled(); Miniflare beta's Node type omits it.
      if (!("scheduled" in service) || typeof service.scheduled !== "function") throw new Error("Missing scheduled event dispatcher");
      const result: unknown = await service.scheduled(options);
      if (typeof result !== "object" || result === null || !("outcome" in result) || result.outcome !== "ok") {
        throw new Error(`Scheduled event failed: ${JSON.stringify(result)}`);
      }
    },
  };
  const server = {
    async listen() {
      state = await mkdtemp(join(tmpdir(), "kuakua-runtime-"));
      try {
        applyLocalMigrations(state);
        runtime = new Miniflare(await options());
        return { url: await runtime.ready };
      } catch (error) {
        await server.close();
        throw error;
      }
    },
    async setVars(next: Record<string, string>) {
      vars = next;
      if (runtime) await runtime.setOptions(await options());
    },
    getLogs() {
      return logs;
    },
    clearLogs() {
      logs.length = 0;
    },
    async close() {
      try {
        await runtime?.dispose();
      } finally {
        if (state) await rm(state, { recursive: true, force: true });
      }
    },
  };
  return { server, worker };
}
