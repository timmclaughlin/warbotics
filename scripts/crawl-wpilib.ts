// Crawl docs.wpilib.org via Cloudflare Browser Rendering → write each page
// into the warbotics-wpilib R2 bucket → (optionally) recreate the wpilib-docs
// AI Search instance pointed at that bucket.
//
// Prereqs (one-time, from the CF dashboard):
//   1. Enable R2.
//   2. `wrangler r2 bucket create warbotics-wpilib`
//   3. API token scoped to:
//        - Workers AI → AI Search: Edit
//        - Browser Rendering: Edit
//        - Account → Workers R2 Storage: Edit
//      Put it in .dev.vars as CLOUDFLARE_API_TOKEN.
//
// Run with: `npm run crawl:wpilib`
//
// Notes on the crawl API (open beta): `POST /browser-rendering/crawl` returns
// a job id. `GET /browser-rendering/crawl/{id}` reports status + results. The
// exact response shape is still evolving; this script logs the raw body when
// it sees something unexpected so we can tune the parser.

import { AiSearch } from "../src/lib/search.js";
import { loadEnvFiles, requireEnv } from "./load-env.js";

const CRAWL_URL = process.env.CRAWL_URL ?? "https://docs.wpilib.org/";
const LIMIT = Number(process.env.CRAWL_LIMIT ?? "100");
const BUCKET = process.env.WPILIB_BUCKET ?? "warbotics-wpilib";
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 1000 * 60 * 45;

type RawPage = {
  url?: string;
  status?: string;
  markdown?: string;
  html?: string;
  metadata?: { title?: string; status?: number; url?: string; lastModified?: string };
};

async function main() {
  loadEnvFiles();
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const namespace = process.env.AI_SEARCH_NAMESPACE ?? "warbotics";
  const wpilibInstance = process.env.AI_SEARCH_INSTANCE_WPILIB ?? "wpilib-docs";
  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const auth = { Authorization: `Bearer ${apiToken}` };
  const jsonHeaders = { ...auth, "Content-Type": "application/json" };

  // 1. Submit crawl job.
  console.log(`Submitting crawl: ${CRAWL_URL} (limit ${LIMIT})…`);
  const submit = await fetch(`${apiBase}/browser-rendering/crawl`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      url: CRAWL_URL,
      limit: LIMIT,
      formats: ["markdown"],
      crawlPurposes: ["ai-input"],
      render: true,
      source: "all",
    }),
  });
  if (!submit.ok) {
    throw new Error(`crawl submit ${submit.status}: ${await submit.text()}`);
  }
  const submitBody = (await submit.json()) as { success?: boolean; result?: unknown };
  const jobId = extractJobId(submitBody);
  if (!jobId) throw new Error(`could not find job id in submit response: ${JSON.stringify(submitBody)}`);
  console.log(`Job: ${jobId}`);

  // 2. Poll until complete.
  const started = Date.now();
  let pages: RawPage[] = [];
  while (true) {
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new Error(`crawl still running after ${POLL_TIMEOUT_MS / 1000}s; check dashboard and re-run`);
    }
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${apiBase}/browser-rendering/crawl/${jobId}`, { headers: auth });
    if (!res.ok) {
      console.warn(`poll ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const body = (await res.json()) as Record<string, unknown>;
    const status = extractStatus(body);
    const count = extractPages(body)?.length;
    console.log(`  [${new Date().toISOString()}] status=${status ?? "?"} pages=${count ?? "?"}`);
    if (isTerminalFailure(status)) {
      throw new Error(`crawl failed: ${JSON.stringify(body).slice(0, 500)}`);
    }
    if (isTerminalSuccess(status)) {
      pages = extractPages(body) ?? [];
      if (pages.length === 0) {
        console.warn("Warning: crawl reports complete but no pages extracted. Raw body:");
        console.warn(JSON.stringify(body, null, 2).slice(0, 2000));
      }
      break;
    }
  }

  // 3. Upload each page to R2 via the REST API.
  console.log(`\nUploading ${pages.length} pages to r2://${BUCKET}/…`);
  let ok = 0;
  let failed = 0;
  for (const page of pages) {
    const url = page.url ?? page.metadata?.url;
    const markdown = page.markdown ?? "";
    if (!url || !markdown || page.status === "failed") {
      failed++;
      continue;
    }
    const title = page.metadata?.title ?? "";
    const body = title ? `# ${title}\n\n${markdown}` : markdown;
    const key = urlToKey(url);
    const put = await fetch(
      `${apiBase}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          ...auth,
          "Content-Type": "text/markdown",
          "X-Amz-Meta-Source-Url": url,
          ...(title ? { "X-Amz-Meta-Title": encodeURIComponent(title) } : {}),
        },
        body,
      },
    );
    if (!put.ok) {
      failed++;
      console.warn(`  FAILED ${key}: ${put.status} ${(await put.text()).slice(0, 200)}`);
    } else {
      ok++;
      if (ok % 25 === 0) console.log(`  …${ok} uploaded`);
    }
  }
  console.log(`Uploaded ${ok}, failed ${failed}.`);

  // 4. Recreate the wpilib AI Search instance as an R2-backed instance.
  if (process.env.SKIP_AI_SEARCH_REBIND === "1") {
    console.log("\nSKIP_AI_SEARCH_REBIND=1 — leaving the AI Search instance alone.");
    return;
  }
  console.log(`\nRebinding ${wpilibInstance} to r2://${BUCKET}…`);
  const client = new AiSearch({ accountId, apiToken, namespace });
  try {
    await client.deleteInstance(wpilibInstance);
  } catch (err) {
    console.warn(`delete ${wpilibInstance} (ok if it didn't exist):`, err instanceof Error ? err.message : err);
  }
  await client.ensureInstance(wpilibInstance, {
    indexMethod: { keyword: true, vector: true },
    keywordTokenizer: "porter",
    reranking: true,
    dataSource: { type: "r2", bucket: BUCKET },
  });
  console.log("Done. The instance will index asynchronously from R2.");
}

function extractJobId(body: unknown): string | null {
  if (typeof body === "object" && body !== null) {
    const b = body as { result?: unknown };
    if (typeof b.result === "string") return b.result;
    if (typeof b.result === "object" && b.result !== null) {
      const r = b.result as Record<string, unknown>;
      if (typeof r.id === "string") return r.id;
      if (typeof r.jobId === "string") return r.jobId;
    }
  }
  return null;
}

function extractStatus(body: Record<string, unknown>): string | undefined {
  const result = body.result as Record<string, unknown> | undefined;
  return (
    (result?.status as string | undefined) ??
    (body.status as string | undefined) ??
    (result?.state as string | undefined)
  );
}

function extractPages(body: Record<string, unknown>): RawPage[] | undefined {
  const result = body.result as Record<string, unknown> | undefined;
  return (
    (result?.records as RawPage[] | undefined) ??
    (result?.pages as RawPage[] | undefined) ??
    (result?.results as RawPage[] | undefined) ??
    (body.records as RawPage[] | undefined)
  );
}

function isTerminalSuccess(status: string | undefined): boolean {
  return !!status && /^(complete|completed|success|succeeded|done)$/i.test(status);
}

function isTerminalFailure(status: string | undefined): boolean {
  return !!status && /^(failed|error|cancelled|canceled)$/i.test(status);
}

function urlToKey(rawUrl: string): string {
  const u = new URL(rawUrl);
  const base = u.pathname.endsWith("/") ? `${u.pathname}index` : u.pathname;
  const key = base.replace(/^\//, "").replace(/[^a-zA-Z0-9/._-]/g, "_");
  return `${key}.md`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
