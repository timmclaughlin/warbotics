// Trigger an immediate sync for an AI Search instance, bypassing the
// built-in 6-hour schedule. Useful right after uploading new content to
// an R2-backed instance (like warbotics-wpilib) so the site sees the
// updates without waiting for the next scheduled pull.
//
// Usage:
//   npm run sync:instance -- wpilib-docs
//   npm run sync:wpilib              # convenience wrapper

import { loadEnvFiles, requireEnv } from "./load-env.js";

async function main() {
  loadEnvFiles();
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const namespace = process.env.AI_SEARCH_NAMESPACE ?? "warbotics";
  const instance = process.argv[2] ?? process.env.AI_SEARCH_INSTANCE ?? "wpilib-docs";
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/namespaces/${namespace}/instances/${instance}`;
  const auth = { Authorization: `Bearer ${apiToken}` };

  console.log(`Triggering sync for "${instance}"…`);
  const res = await fetch(`${base}/jobs`, { method: "POST", headers: auth });
  const body = (await res.json()) as {
    success: boolean;
    result?: { id?: string };
    errors?: unknown[];
  };
  if (!res.ok || !body.success) {
    console.error(`Failed: ${res.status}`, body.errors ?? body);
    process.exit(1);
  }
  const jobId = body.result?.id;
  console.log(`Job ${jobId ?? "(unknown)"} queued. Polling until done…`);

  const started = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000;
  while (true) {
    await new Promise((r) => setTimeout(r, 20_000));
    if (Date.now() - started > TIMEOUT_MS) {
      console.error("Timed out after 30m. Check the dashboard.");
      process.exit(1);
    }
    const jobsRes = await fetch(`${base}/jobs`, { headers: auth });
    const jobsBody = (await jobsRes.json()) as {
      result?: Array<{ id?: string; ended_at?: string | null; end_reason?: string | null }>;
    };
    const job = jobsBody.result?.find((j) => j.id === jobId) ?? jobsBody.result?.[0];
    const done = job?.ended_at;
    const reason = job?.end_reason;
    const itemsRes = await fetch(`${base}/items?limit=1`, { headers: auth });
    const itemsBody = (await itemsRes.json()) as {
      result_info?: { total_count?: number };
    };
    const count = itemsBody.result_info?.total_count ?? 0;
    console.log(
      `  [${new Date().toISOString()}] ended_at=${done ?? "—"} reason=${reason ?? "—"} items=${count}`,
    );
    if (done) {
      console.log(`\nDone. Reason: ${reason ?? "(unspecified)"}. Items indexed: ${count}.`);
      if (reason && /fail|error/i.test(reason)) process.exit(1);
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
