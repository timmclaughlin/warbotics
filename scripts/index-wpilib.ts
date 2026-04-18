// Clone wpilibsuite/frc-docs and upload every .rst file under `source/` to
// the r2://warbotics-wpilib bucket. The wpilib-docs AI Search instance is
// bound to that bucket (type: "r2"), so it syncs from R2 on its own schedule.
//
// We use git clone over crawling because docs.wpilib.org is behind
// Cloudflare's bot challenge — Browser Rendering gets blocked on the first
// request. The source repo gives us the full doc tree cleanly.
//
// Usage: `npm run index:wpilib`
//
// Requires in .dev.vars:
//   CLOUDFLARE_ACCOUNT_ID=...
//   CLOUDFLARE_API_TOKEN=...   (scoped: R2 Storage Edit + AI Search Edit)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFiles, requireEnv } from "./load-env.js";

const REPO = process.env.WPILIB_REPO ?? "https://github.com/wpilibsuite/frc-docs.git";
const BRANCH = process.env.WPILIB_BRANCH ?? "main";
const SOURCE_SUBDIR = process.env.WPILIB_SOURCE_DIR ?? "source";
const BUCKET = process.env.WPILIB_BUCKET ?? "warbotics-wpilib";
const KEY_PREFIX = process.env.WPILIB_KEY_PREFIX ?? "wpilib";
const EXTENSIONS = (process.env.WPILIB_EXTENSIONS ?? ".rst,.md").split(",");
// Skip binary-heavy dirs that don't contribute searchable text.
const SKIP_DIRS = new Set(["images", "diagrams", "_static", "_templates"]);
const MAX_FILE_BYTES = 3 * 1024 * 1024; // stay under AI Search's 4MB per-file cap

async function main() {
  loadEnvFiles();
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const auth = { Authorization: `Bearer ${apiToken}` };

  const workDir = mkdtempSync(join(tmpdir(), "frc-docs-"));
  console.log(`Cloning ${REPO}#${BRANCH} → ${workDir}…`);
  try {
    execFileSync("git", [
      "clone",
      "--depth=1",
      "--branch", BRANCH,
      "--single-branch",
      "--no-tags",
      "--filter=blob:none",
      REPO,
      workDir,
    ], { stdio: "inherit" });

    const sourceRoot = join(workDir, SOURCE_SUBDIR);
    statSync(sourceRoot); // throws if missing

    const files = walk(sourceRoot).filter((f) =>
      EXTENSIONS.some((ext) => f.endsWith(ext)),
    );
    console.log(`Found ${files.length} doc files under ${SOURCE_SUBDIR}/.`);

    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (const path of files) {
      const rel = relative(sourceRoot, path).replace(/\\/g, "/");
      const stat = statSync(path);
      if (stat.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      const raw = readFileSync(path, "utf8");
      const title = extractTitle(raw, rel);
      const body = title ? `# ${title}\n\n${raw}` : raw;
      const key = `${KEY_PREFIX}/${rel}`;
      const put = await fetch(
        `${apiBase}/r2/buckets/${BUCKET}/objects/${encodeURI(key)}`,
        {
          method: "PUT",
          headers: {
            ...auth,
            "Content-Type": rel.endsWith(".md") ? "text/markdown" : "text/plain",
            "X-Amz-Meta-Source-Path": rel,
            "X-Amz-Meta-Source-Repo": "wpilibsuite/frc-docs",
          },
          body,
        },
      );
      if (!put.ok) {
        failed++;
        if (failed <= 3) {
          console.warn(`  FAILED ${key}: ${put.status} ${(await put.text()).slice(0, 200)}`);
        }
        continue;
      }
      ok++;
      if (ok % 50 === 0) console.log(`  …${ok} uploaded`);
    }
    console.log(`\nUploaded ${ok}, skipped ${skipped} (too large), failed ${failed}.`);
    console.log(`AI Search will pick these up on its next sync (≤ 6 hours).`);
    console.log("To trigger an immediate re-sync, run `wrangler ai-search update wpilib-docs`.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// Pull the first non-empty heading as a human-readable title.
// RST: underline-style headings (===== / ----- under a line of text).
// Markdown: leading `# `.
function extractTitle(content: string, fallback: string): string {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("# ")) return line.slice(2).trim();
    const next = lines[i + 1]?.trim() ?? "";
    if (next.length >= 3 && /^[=\-~^"*+#]+$/.test(next)) {
      return line;
    }
  }
  return fallback;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
