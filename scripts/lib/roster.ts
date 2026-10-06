// Reads ROSTER_FILE from disk: parses it (shared with the Worker) and checks the avatar
// files it points at, since those are uploaded next to it.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseRoster, type ParsedRoster } from "../../src/server/roster-file";

const AVATAR_WARN_BYTES = 1024 * 1024;

export function imageType(path: string) {
  const head = new Uint8Array(12);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const ascii = (from: number, s: string) => [...s].every((c, i) => head[from + i] === c.charCodeAt(0));
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (ascii(1, "PNG")) return "image/png";
  if (ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "GIF")) return "image/gif";
  return null;
}

export type LocalRoster = ParsedRoster & { file: string; dir: string };

export function readRosterFile(file: string): LocalRoster {
  const dir = dirname(file);
  if (!existsSync(file)) return { entries: [], errors: [`roster file not found: ${file}`], warnings: [], file, dir };
  const roster = parseRoster(readFileSync(file, "utf8"), file.toLowerCase().endsWith(".json"));
  for (const e of roster.entries) {
    if (e.avatar?.kind !== "file") continue;
    const path = resolve(dir, e.avatar.path);
    let problem: string | null = null;
    if (!existsSync(path)) problem = `not found: ${path}`;
    else if (!imageType(path)) problem = `is not a JPEG, PNG, WebP or GIF: ${path}`;
    if (problem) {
      roster.warnings.push(`line ${e.line}: avatar for ${e.email} ${problem}`);
      e.avatar = null;
    } else if (statSync(path).size > AVATAR_WARN_BYTES) {
      roster.warnings.push(`line ${e.line}: avatar for ${e.email} is over 1 MB; a ~640px square is plenty`);
    }
  }
  return { ...roster, file, dir };
}
