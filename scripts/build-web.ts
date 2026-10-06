// Builds the web app into dist/ for Workers Static Assets: the bundled page plus the
// self-hosted fonts (/fonts/*; Google Fonts isn't reliably reachable from mainland China).
//   bun scripts/build-web.ts            one build
//   bun scripts/build-web.ts --watch    rebuild on changes (bun run dev)
import { copyFileSync, mkdirSync, rmSync, watch } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist");

// OFL fonts, served at /fonts/<name> and referenced by src/web/fonts.css.
const FONTS: Record<string, string> = {
  "bricolage-latin.woff2": "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
  "bricolage-latin-ext.woff2": "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-ext-wght-normal.woff2",
  "figtree-latin.woff2": "@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
  "figtree-latin-ext.woff2": "@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2",
  "jetbrains-mono-latin.woff2": "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  "instrument-serif-latin-italic.woff2": "@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2",
};

async function build() {
  const started = performance.now();
  rmSync(OUT, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/web/index.html")],
    outdir: OUT,
    minify: true,
    sourcemap: "linked",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  mkdirSync(join(OUT, "fonts"), { recursive: true });
  copyFileSync(join(ROOT, "src/web/fonts.css"), join(OUT, "fonts/fonts.css"));
  for (const [name, path] of Object.entries(FONTS)) copyFileSync(join(ROOT, "node_modules", path), join(OUT, "fonts", name));
  console.log(`[web] built dist/ in ${Math.round(performance.now() - started)} ms`);
  return true;
}

if (!(await build()) && !process.argv.includes("--watch")) process.exit(1);
if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of ["src/web", "src/shared"]) {
    watch(join(ROOT, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void build(), 150);
    });
  }
  console.log("[web] watching src/web and src/shared");
}
