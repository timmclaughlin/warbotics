// Minimal .dev.vars / .env loader for node scripts.
// We avoid dotenv to keep dependencies tight — the file format is trivial.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadEnvFiles(files: string[] = [".dev.vars", ".env"]): void {
  for (const rel of files) {
    const path = resolve(process.cwd(), rel);
    if (!existsSync(path)) continue;
    const contents = readFileSync(path, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const pair = parseLine(line);
      if (!pair) continue;
      const [key, value] = pair;
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
  return v;
}
