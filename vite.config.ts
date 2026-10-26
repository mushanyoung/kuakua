import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { LOCAL_STATE } from "./scripts/lib/worker-config.ts";

// The existing esbuild/PostCSS step produces these assets before cf runs Vite.
export default defineConfig({
  envDir: false,
  publicDir: "dist",
  cacheDir: ".cloudflare/vite/cache",
  plugins: [cloudflare({ persistState: { path: LOCAL_STATE }, remoteBindings: false, inspectorPort: false, types: { generate: false } })],
  server: { host: "127.0.0.1", port: 4381, strictPort: true },
  build: { outDir: ".cloudflare/vite/build", minify: true, sourcemap: false },
});
