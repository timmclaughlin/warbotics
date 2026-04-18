// Walk src/content/docs/**/*.md and upload each file to the shared
// "warbotics-content" AI Search instance. Frontmatter is passed through
// as metadata so it's available for boosting / filtering at query time.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AiSearch } from "../src/lib/search.js";
import { loadEnvFiles, requireEnv } from "./load-env.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

// Naïve frontmatter parser — good enough for simple key/value + arrays.
function parseFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  if (!src.startsWith("---")) return { data: {}, body: src };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: src };
  const header = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\r?\n/, "");
  const data: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    let value: unknown = m[2].trim();
    if (typeof value === "string") {
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else if (value === "true" || value === "false") {
        value = value === "true";
      } else {
        value = value.replace(/^["']|["']$/g, "");
      }
    }
    data[key] = value;
  }
  return { data, body };
}

async function main() {
  loadEnvFiles();
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const namespace = process.env.AI_SEARCH_NAMESPACE ?? "warbotics";
  const instance = process.env.AI_SEARCH_INSTANCE_CONTENT ?? "warbotics-content";
  const contentDir = resolve(process.cwd(), "src/content/docs");

  const files = walk(contentDir);
  if (!files.length) {
    console.log("No markdown files found under src/content/docs.");
    return;
  }

  const client = new AiSearch({ accountId, apiToken, namespace });
  console.log(`Uploading ${files.length} files to "${instance}"…`);

  for (const path of files) {
    const rel = relative(contentDir, path).replace(/\\/g, "/");
    const raw = readFileSync(path, "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (data.draft === true) {
      console.log(`  skip (draft) ${rel}`);
      continue;
    }
    const metadata = {
      slug: rel.replace(/\.(md|mdx)$/, ""),
      title: data.title ?? rel,
      description: data.description ?? "",
      tags: data.tags ?? [],
      updated: data.updated ?? null,
      source: "warbotics",
    };
    try {
      await client.uploadItem(instance, rel, `# ${metadata.title}\n\n${body}`, metadata);
      console.log(`  uploaded ${rel}`);
    } catch (err) {
      console.error(`  FAILED ${rel}:`, err);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
