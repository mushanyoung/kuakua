import { env } from "cloudflare:workers";

// Thin layer over D1. D1 only binds positional ?NNN parameters; the queries in this app
// are written with $name placeholders, which q() rewrites (the same name maps to the same
// position, so it can repeat). Schema lives in migrations/, applied by wrangler.

type Params = Record<string, unknown>;
type Value = string | number | null | ArrayBuffer;

export function q(sql: string, params: Params = {}): D1PreparedStatement {
  const names: string[] = [];
  const text = sql.replace(/\$([A-Za-z_]\w*)/g, (_, name: string) => {
    let i = names.indexOf(name);
    if (i < 0) i = names.push(name) - 1;
    return `?${i + 1}`;
  });
  const values = names.map((name): Value => {
    if (!(name in params)) throw new Error(`query parameter $${name} is missing`);
    const v = params[name];
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string" || typeof v === "number" || v instanceof ArrayBuffer) return v;
    throw new Error(`query parameter $${name} has unsupported type ${typeof v}`);
  });
  return env.DB.prepare(text).bind(...values);
}

export const db = {
  get: <T>(sql: string, params?: Params) => q(sql, params).first<T>(),
  all: async <T>(sql: string, params?: Params) => (await q(sql, params).all<T>()).results,
  run: async (sql: string, params?: Params) => (await q(sql, params).run()).meta,
  // Atomic: all statements commit together or none do.
  batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
};
