// ReindexSourceWorkflow — durable reindex of a single source in Config.
//
// Why a Workflow and not inline in the API handler:
//   - cloning + uploading 440 files takes minutes, well past a Worker
//     request's budget even under ctx.waitUntil.
//   - Workflows are resumable: if the Worker is evicted mid-run, the
//     next invocation picks up from the last committed step.
//   - Each step.do(…) block gets its own 50-subrequest budget, so we
//     batch the per-file uploads to fit.
//
// Supported source kinds:
//   - github        : clone-equivalent via tree API + raw.githubusercontent.com,
//                     then POST each file into AI Search items.
//   - local-content : noop from here — that lives in the git repo and is
//                     pushed by `npm run index:content` during deploy.
//   - r2 / url-list : not yet implemented.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AiSearch } from "~/lib/search";
import { loadConfig, saveConfig, type Source } from "~/lib/settings";

export interface ReindexParams {
  sourceId: string;
  initiatedBy: string;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
// Per-file upload does TWO fetches (GitHub raw + AI Search items), so 20
// files per batch = 40 subrequests, safely under the 50-per-step cap.
const FILE_BATCH_SIZE = 20;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

export class ReindexSourceWorkflow extends WorkflowEntrypoint<Env, ReindexParams> {
  async run(event: WorkflowEvent<ReindexParams>, step: WorkflowStep): Promise<unknown> {
    const { sourceId, initiatedBy } = event.payload;

    // step.do's return type is Serializable<T> which trips on the loose
    // Record<string, unknown> inside Source.config — stringify at the
    // boundary and parse on the outside. The content is JSON-safe.
    const sourceJson = await step.do("load-source", async () => {
      const config = await loadConfig(this.env);
      const found = config.sources.find((s) => s.id === sourceId);
      if (!found) throw new Error(`source not found: ${sourceId}`);
      if (!found.enabled) throw new Error(`source is disabled: ${sourceId}`);
      return JSON.stringify(found);
    });
    const source = JSON.parse(sourceJson) as Source;

    if (source.kind === "local-content") {
      return { status: "skipped", reason: "local-content is indexed by the deploy pipeline" };
    }
    if (source.kind !== "github") {
      return { status: "unsupported", kind: source.kind };
    }

    const repo = asString(source.config.repo);
    const branch = asString(source.config.branch ?? "main");
    const sourceDir = asString(source.config.sourceDir ?? "").replace(/^\/+|\/+$/g, "");
    const extensions = Array.isArray(source.config.extensions)
      ? (source.config.extensions as string[])
      : [".md"];
    if (!repo) throw new Error("source.config.repo is required for github kind");

    const sha = await step.do("fetch-head-sha", async () => {
      const res = await fetch(`${GITHUB_API}/repos/${repo}/commits/${branch}`, {
        headers: { "User-Agent": "warbotics-reindex", Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`github commit ${res.status}: ${await res.text()}`);
      return (await res.json() as { sha: string }).sha;
    });

    const files = await step.do("fetch-tree", async () => {
      const res = await fetch(
        `${GITHUB_API}/repos/${repo}/git/trees/${sha}?recursive=1`,
        { headers: { "User-Agent": "warbotics-reindex", Accept: "application/vnd.github+json" } },
      );
      if (!res.ok) throw new Error(`github tree ${res.status}: ${await res.text()}`);
      const body = await res.json() as { tree?: TreeEntry[]; truncated?: boolean };
      if (body.truncated) {
        // Very large repos. For now we just note it; follow-up is to
        // walk subtrees. frc-docs is ~1500 entries, well under the limit.
        console.warn(`github tree truncated for ${repo}`);
      }
      const entries = (body.tree ?? []).filter((e) => {
        if (e.type !== "blob") return false;
        if (sourceDir && !e.path.startsWith(`${sourceDir}/`)) return false;
        if (!extensions.some((ext) => e.path.endsWith(ext))) return false;
        if (e.size != null && e.size > MAX_FILE_BYTES) return false;
        return true;
      });
      return entries.map((e) => ({ path: e.path, sha: e.sha, size: e.size }));
    });

    // Items API doesn't dedupe by key — re-uploading the same file creates
    // a new item id, so the instance would double on every reindex. Clear
    // existing items first. Done in batches of 40 per step to stay under
    // the 50-subrequest-per-step budget.
    const existingIds = await step.do("list-existing-items", async () => {
      const client = new AiSearch({
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: this.env.CLOUDFLARE_API_TOKEN,
        namespace: this.env.AI_SEARCH_NAMESPACE,
      });
      return client.listItemIds(source.instance);
    });

    const DELETE_BATCH = 40;
    for (let i = 0; i < existingIds.length; i += DELETE_BATCH) {
      const slice = existingIds.slice(i, i + DELETE_BATCH);
      await step.do(
        `delete-batch-${Math.floor(i / DELETE_BATCH) + 1}`,
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          const client = new AiSearch({
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: this.env.CLOUDFLARE_API_TOKEN,
            namespace: this.env.AI_SEARCH_NAMESPACE,
          });
          return client.deleteItems(source.instance, slice);
        },
      );
    }

    const totalFiles = files.length;
    const batches: Array<Array<{ path: string; sha: string; size?: number }>> = [];
    for (let i = 0; i < files.length; i += FILE_BATCH_SIZE) {
      batches.push(files.slice(i, i + FILE_BATCH_SIZE));
    }

    type BatchResult = { ok: number; failed: number };
    const stats: BatchResult = { ok: 0, failed: 0 };

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const res = await step.do(
        `upload-batch-${i + 1}-of-${batches.length}`,
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async (): Promise<BatchResult> => {
          const client = new AiSearch({
            accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
            apiToken: this.env.CLOUDFLARE_API_TOKEN,
            namespace: this.env.AI_SEARCH_NAMESPACE,
          });
          let ok = 0;
          let failed = 0;
          for (const entry of batch) {
            try {
              const raw = await fetch(`${GITHUB_RAW}/${repo}/${sha}/${entry.path}`);
              if (!raw.ok) {
                failed++;
                continue;
              }
              const text = await raw.text();
              const title = extractTitle(text, entry.path);
              const body = title ? `# ${title}\n\n${text}` : text;
              // Rewrite `.rst` → `.md` so AI Search treats the item as markdown.
              const key = entry.path.replace(/\.rst$/, ".md");
              await client.uploadItem(source.instance, key, body, {
                title,
                source_path: entry.path,
                source_repo: repo,
                source_sha: sha,
              });
              ok++;
            } catch {
              failed++;
            }
          }
          return { ok, failed };
        },
      );
      stats.ok += res.ok;
      stats.failed += res.failed;
    }

    await step.do("update-config", async () => {
      const current = await loadConfig(this.env);
      const s = current.sources.find((x) => x.id === sourceId);
      if (s) {
        s.config = { ...s.config, lastIndexedSha: sha };
        s.lastIndexedAt = new Date().toISOString();
        await saveConfig(this.env, current, `workflow:${initiatedBy}`);
      }
    });

    return { status: "completed", sha, stats, totalFiles };
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
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

// Silence unused-type warning for Source — it's re-exported for other
// consumers that import from this module alongside the workflow.
export type { Source };
