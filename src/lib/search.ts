// Thin wrapper over the Cloudflare AI Search REST API.
//
// We use REST (not the Worker binding) so the same helpers work in Node
// scripts and in the SSR Worker. Swap to the binding once its surface is
// stable — the shape of SearchResult here mirrors the documented response.

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface SearchConfig {
  accountId: string;
  apiToken: string;
  namespace: string;
}

export interface SearchResult {
  id: string;
  score: number;
  instance_id?: string;
  metadata?: Record<string, unknown>;
  snippet?: string;
  content?: string;
  source?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
}

interface InstanceCreateOptions {
  indexMethod?: { keyword?: boolean; vector?: boolean };
  keywordTokenizer?: "porter" | "trigram";
  reranking?: boolean;
  // External data source. `web-crawler` requires the domain to be verified on
  // your Cloudflare account; `r2` indexes an R2 bucket you own. Omit for a
  // "builtin"-source instance populated via uploadItem().
  dataSource?:
    | { type: "web-crawler"; url: string }
    | { type: "r2"; bucket: string; prefix?: string };
}

export class AiSearch {
  constructor(private cfg: SearchConfig) {}

  private url(path: string): string {
    const { accountId, namespace } = this.cfg;
    return `${API_BASE}/accounts/${accountId}/ai-search/namespaces/${namespace}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiToken}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string>) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`AI Search ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as { success?: boolean; result?: T; errors?: unknown[] };
    if (json.success === false) {
      throw new Error(`AI Search error: ${JSON.stringify(json.errors)}`);
    }
    return (json.result ?? (json as unknown)) as T;
  }

  async ensureNamespace(name: string): Promise<void> {
    try {
      await fetch(
        `${API_BASE}/accounts/${this.cfg.accountId}/ai-search/namespaces`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ name }),
        },
      ).then(async (res) => {
        if (!res.ok) {
          const body = await res.text();
          if (!/already exists|409|conflict/i.test(body)) {
            throw new Error(`ensureNamespace ${name}: ${res.status} ${body}`);
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|409|conflict/i.test(msg)) throw err;
    }
  }

  async createInstance(id: string, opts: InstanceCreateOptions = {}): Promise<void> {
    const body: Record<string, unknown> = {
      id,
      index_method: opts.indexMethod ?? { keyword: true, vector: true },
    };
    if (opts.keywordTokenizer) {
      body.indexing_options = { keyword_tokenizer: opts.keywordTokenizer };
    }
    if (opts.reranking) {
      body.reranking = true;
    }
    if (opts.dataSource) {
      if (opts.dataSource.type === "web-crawler") {
        body.type = "web-crawler";
        body.source = opts.dataSource.url;
      } else {
        body.type = "r2";
        body.source = opts.dataSource.bucket;
        if (opts.dataSource.prefix) body.prefix = opts.dataSource.prefix;
      }
    }
    await this.request("/instances", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async ensureInstance(id: string, opts: InstanceCreateOptions = {}): Promise<void> {
    try {
      await this.createInstance(id, opts);
    } catch (err) {
      // A conflict means the instance already exists — that's fine.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|409|conflict/i.test(msg)) throw err;
    }
  }

  async deleteInstance(id: string): Promise<void> {
    await this.request(`/instances/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async uploadItem(
    instanceId: string,
    key: string,
    content: string | Uint8Array,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const form = new FormData();
    const blob =
      typeof content === "string"
        ? new Blob([content], { type: "text/markdown" })
        : new Blob([content as BlobPart]);
    form.append("file", blob, key);
    form.append("metadata", JSON.stringify(metadata));
    const res = await fetch(this.url(`/instances/${encodeURIComponent(instanceId)}/items`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.apiToken}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`uploadItem ${key}: ${res.status} ${await res.text()}`);
    }
  }

  async search(
    query: string,
    instanceIds: string[],
    opts: { limit?: number; rerank?: boolean } = {},
  ): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
      query,
      ai_search_options: {
        instance_ids: instanceIds,
        ...(opts.rerank ? { reranking: { enabled: true } } : {}),
      },
      ...(opts.limit ? { limit: opts.limit } : {}),
    };
    return await this.request<SearchResponse>("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

export function searchClientFromEnv(env: Env): AiSearch {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
  }
  return new AiSearch({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    namespace: env.AI_SEARCH_NAMESPACE,
  });
}

export function userInstanceId(slackUserId: string): string {
  return `user-${slackUserId.toLowerCase()}`;
}
