// Optional production secrets are absent from the development config used for type generation.
declare namespace Cloudflare {
  interface Env {
    LARK_APP_SECRET?: string;
  }
}
