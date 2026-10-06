// Secrets aren't in wrangler.jsonc, so `wrangler types` doesn't know about them.
declare namespace Cloudflare {
  interface Env {
    LARK_APP_SECRET?: string;
  }
}
