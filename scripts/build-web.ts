// Builds the web app into dist/ for Workers Static Assets: the bundled page plus the
// self-hosted fonts (/fonts/*; Google Fonts isn't reliably reachable from mainland China).
//   node scripts/build-web.ts            one build
//   node scripts/build-web.ts --watch    rebuild on changes (pnpm run dev)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { build as bundle } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const ROOT = resolve(import.meta.dirname, "..");
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
  const result = await bundle({
    entryPoints: [join(ROOT, "src/web/main.tsx")],
    outdir: OUT,
    entryNames: "[name]-[hash]",
    bundle: true,
    format: "esm",
    target: "es2024",
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    publicPath: "/",
    minify: true,
    sourcemap: "linked",
  });
  const entry = Object.keys(result.metafile.outputs).find((path) => path.endsWith(".js"));
  if (!entry) throw new Error("Missing browser entry bundle");
  const cssFile = join(ROOT, "src/web/styles.css");
  const css = await postcss([tailwindcss({ optimize: true })]).process(readFileSync(cssFile, "utf8"), { from: cssFile, to: join(OUT, "styles.css") });
  writeFileSync(join(OUT, "styles.css"), css.css);
  copyFileSync(join(ROOT, "src/web/favicon.svg"), join(OUT, "favicon.svg"));
  const html = readFileSync(join(ROOT, "src/web/index.html"), "utf8")
    .replace('./main.tsx', `/${entry.split("/").pop()}`)
    .replace('./styles.css', '/styles.css')
    .replace('./favicon.svg', '/favicon.svg');
  if (/(?:src|href)="\.\//.test(html)) {
    console.error("[web] index.html links assets relatively; deep links like /kua/x would load a blank page");
    return false;
  }
  writeFileSync(join(OUT, "index.html"), html);
  mkdirSync(join(OUT, "fonts"), { recursive: true });
  copyFileSync(join(ROOT, "src/web/fonts.css"), join(OUT, "fonts/fonts.css"));
  for (const [name, path] of Object.entries(FONTS)) copyFileSync(join(ROOT, "node_modules", path), join(OUT, "fonts", name));
  console.log(`[web] built dist/ in ${Math.round(performance.now() - started)} ms`);
  return true;
}

if (!(await build()) && !process.argv.includes("--watch")) process.exit(1);
if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  for (const dir of ["src/web", "src/shared"]) {
    watch(join(ROOT, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending = pending.then(() => build()).then(() => undefined).catch(console.error);
      }, 150);
    });
  }
  console.log("[web] watching src/web and src/shared");
}
