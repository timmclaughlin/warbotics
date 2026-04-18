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

  console.log(`Ensuring content instance "${contentInstance}"…`);
  await client.ensureInstance(contentInstance, {
    indexMethod: { keyword: true, vector: true },
    keywordTokenizer: "porter",
    reranking: true,
  });

  console.log(`Ensuring wpilib crawl instance "${wpilibInstance}"…`);
  await client.ensureInstance(wpilibInstance, {
    indexMethod: { keyword: true, vector: true },
    keywordTokenizer: "porter",
    reranking: true,
    website: { url: "https://docs.wpilib.org/" },
  });

  console.log("\nDone. Next steps:");
  console.log("  1. npm run index:content   # push /src/content/docs into warbotics-content");
  console.log("  2. Wait for the wpilib crawl to complete (check the CF dashboard).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
