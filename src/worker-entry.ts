// Worker entry that wraps @astrojs/cloudflare's generated output so we can
// export additional classes (Workflows, Durable Objects) alongside Astro's
// default fetch handler. Wrangler's `main` points here instead of directly
// at dist/_worker.js/index.js.
//
// Build order: `astro build` first (writes dist/_worker.js/index.js),
// then `wrangler deploy` (bundles this file, pulls in both). The npm
// `deploy` script chains them.

// The dist path doesn't exist until `astro build` has run; wrangler
// bundles this file, so it resolves at deploy time.
// @ts-ignore — path resolves at deploy time
export { default } from "../dist/_worker.js/index.js";
export { ReindexSourceWorkflow } from "./workflows/reindex.ts";
