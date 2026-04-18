// Create (or ensure) the shared AI Search instances:
//   - warbotics-content  — indexed from ./src/content/docs via index-content.ts
//   - wpilib-docs        — website data source, Cloudflare crawls it for us
//
// Safe to run repeatedly; existing instances are left alone.

import { AiSearch } from "../src/lib/search.js";
import { loadEnvFiles, requireEnv } from "./load-env.js";

async function main() {
  loadEnvFiles();

  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const namespace = process.env.AI_SEARCH_NAMESPACE ?? "warbotics";

  const contentInstance = process.env.AI_SEARCH_INSTANCE_CONTENT ?? "warbotics-content";
  const wpilibInstance = process.env.AI_SEARCH_INSTANCE_WPILIB ?? "wpilib-docs";

  const client = new AiSearch({ accountId, apiToken, namespace });

  console.log(`Ensuring namespace "${namespace}"…`);
  await client.ensureNamespace(namespace);

  console.log(`Ensuring content instance "${contentInstance}"…`);
  await client.ensureInstance(contentInstance, {
    indexMethod: { keyword: true, vector: true },
    keywordTokenizer: "porter",
    reranking: true,
  });

  // NOTE: Cloudflare's AI Search web-crawler source requires the target
  // domain to be a verified zone on your account. docs.wpilib.org isn't
  // one of ours, so the crawl route is blocked for this instance. We
  // still create an empty instance so the search code can include it in
  // cross-instance queries once populated. Two paths to fill it:
  //   1. Scrape docs.wpilib.org locally, upload to an R2 bucket you own,
  //      and recreate the instance with { type: "r2", bucket: "<name>" }.
  //   2. Scrape + call client.uploadItem(wpilibInstance, key, body, md).
  console.log(`Ensuring (empty) wpilib instance "${wpilibInstance}"…`);
  await client.ensureInstance(wpilibInstance, {
    indexMethod: { keyword: true, vector: true },
    keywordTokenizer: "porter",
    reranking: true,
  });

  console.log("\nDone. Next steps:");
  console.log("  1. npm run index:content   # push /src/content/docs into warbotics-content");
  console.log("  2. Populate wpilib-docs via R2 or direct upload (see README).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
