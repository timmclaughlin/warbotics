// Clone wpilibsuite/frc-docs and push every .rst/.md file under `source/`
// straight into the `wpilib-docs` AI Search instance via the items API.
//
// Why direct upload instead of R2 sync?
//   - `docs.wpilib.org` is behind Cloudflare's bot challenge, so the
//     `web-crawler` data source can't fetch it.
//   - R2-backed instances did accept our uploads, but their sync jobs
//     ran for hours without ever indexing any content (even a root-level
//     .md probe). The items API indexes within seconds — same path our
//     `warbotics-content` instance uses — so we use that instead.
//
// Usage: `npm run index:wpilib`
// Requires in .dev.vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { AiSearch } from "../src/lib/search.js";
import { loadEnvFiles, requireEnv } from "./load-env.js";

const REPO = process.env.WPILIB_REPO ?? "https://github.com/wpilibsuite/frc-docs.git";
const BRANCH = process.env.WPILIB_BRANCH ?? "main";
const SOURCE_SUBDIR = process.env.WPILIB_SOURCE_DIR ?? "source";
const EXTENSIONS = (process.env.WPILIB_EXTENSIONS ?? ".rst,.md").split(",");
const SKIP_DIRS = new Set(["images", "diagrams", "_static", "_templates"]);
const MAX_FILE_BYTES = 3 * 1024 * 1024; // AI Search's per-file cap is 4MB
const CONCURRENCY = Number(process.env.WPILIB_CONCURRENCY ?? "8");

async function main() {
  loadEnvFiles();
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const namespace = process.env.AI_SEARCH_NAMESPACE ?? "warbotics";
  const instance = process.env.AI_SEARCH_INSTANCE_WPILIB ?? "wpilib-docs";
  const client = new AiSearch({ accountId, apiToken, namespace });

  const workDir = mkdtempSync(join(tmpdir(), "frc-docs-"));
  console.log(`Cloning ${REPO}#${BRANCH} → ${workDir}…`);
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--depth=1",
        "--branch", BRANCH,
        "--single-branch",
        "--no-tags",
        "--filter=blob:none",
        REPO,
        workDir,
      ],
      { stdio: "inherit" },
    );

    const sourceRoot = join(workDir, SOURCE_SUBDIR);
    statSync(sourceRoot);

    const files = walk(sourceRoot).filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)));
    console.log(`Found ${files.length} doc files under ${SOURCE_SUBDIR}/.`);

    let ok = 0;
    let skipped = 0;
    let failed = 0;
    const queue = [...files];

    async function worker(): Promise<void> {
      while (queue.length) {
        const path = queue.shift();
        if (!path) return;
        const rel = relative(sourceRoot, path).replace(/\\/g, "/");
        const stat = statSync(path);
        if (stat.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }
        const raw = readFileSync(path, "utf8");
        const title = extractTitle(raw, rel);
        const body = title ? `# ${title}\n\n${raw}` : raw;
        // Use .md extension in the item key so AI Search's built-in
        // renderers treat it as markdown (RST is markdown-compatible enough
        // for search purposes; the source-path metadata preserves the
        // original filename for anyone who wants to link back).
        const key = rel.replace(/\.rst$/, ".md");
        try {
          await client.uploadItem(instance, key, body, {
            title,
            source_path: rel,
            source_repo: "wpilibsuite/frc-docs",
          });
          ok++;
          if (ok % 50 === 0) console.log(`  …${ok} uploaded`);
        } catch (err) {
          failed++;
          if (failed <= 5) {
            console.warn(`  FAILED ${key}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    console.log(`\nUploaded ${ok}, skipped ${skipped} (too large), failed ${failed}.`);
    console.log("Items will appear in search as they finish indexing (usually seconds per file).");
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
