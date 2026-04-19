// Persistent app config stored in r2://warbotics-config/config.json.
//
// Two top-level sections, both editable by admins from /settings:
//   - admins  : email addresses that can change this config
//   - sources : list of indexed data sources (one entry per AI Search
//               instance + how we fill it)
//
// The OWNER_EMAIL env var is always treated as an admin too — safety net
// against the admin list being emptied or the file going missing.

export type SourceKind = "github" | "r2" | "url-list" | "local-content";

export interface Source {
  id: string;
  label: string;
  kind: SourceKind;
  instance: string;
  enabled: boolean;
  // Kind-specific config — kept loose so we can evolve without a migration.
  config: Record<string, unknown>;
  lastIndexedAt?: string;
}

export interface AppConfig {
  admins: string[];
  sources: Source[];
  updatedAt?: string;
  updatedBy?: string;
}

const CONFIG_KEY = "config.json";

export const DEFAULT_CONFIG: AppConfig = {
  admins: [],
  sources: [
    {
      id: "warbotics-content",
      label: "Warbotics team docs",
      kind: "local-content",
      instance: "warbotics-content",
      enabled: true,
      config: {
        path: "src/content/docs/**/*.{md,mdx}",
        note: "Indexed by `npm run index:content` from the main repo.",
      },
    },
    {
      id: "wpilib-docs",
      label: "WPILib frc-docs",
      kind: "github",
      instance: "wpilib-docs",
      enabled: true,
      config: {
        repo: "wpilibsuite/frc-docs",
        branch: "main",
        sourceDir: "source",
        extensions: [".rst", ".md"],
        note: "Indexed by `npm run index:wpilib`.",
      },
    },
  ],
};

export async function loadConfig(env: Env): Promise<AppConfig> {
  const obj = await env.CONFIG_R2.get(CONFIG_KEY);
  if (!obj) {
    const seeded: AppConfig = {
      ...DEFAULT_CONFIG,
      admins: env.OWNER_EMAIL ? [env.OWNER_EMAIL.toLowerCase()] : [],
    };
    await saveConfig(env, seeded, env.OWNER_EMAIL ?? "system");
    return seeded;
  }
  try {
    const text = await obj.text();
    const parsed = JSON.parse(text) as Partial<AppConfig>;
    return {
      admins: Array.isArray(parsed.admins) ? parsed.admins.map((e) => e.toLowerCase()) : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      updatedAt: parsed.updatedAt,
      updatedBy: parsed.updatedBy,
    };
  } catch {
    return { ...DEFAULT_CONFIG, admins: env.OWNER_EMAIL ? [env.OWNER_EMAIL.toLowerCase()] : [] };
  }
}

export async function saveConfig(
  env: Env,
  config: AppConfig,
  updatedBy: string,
): Promise<AppConfig> {
  const normalized: AppConfig = {
    admins: Array.from(new Set((config.admins ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))),
    sources: Array.isArray(config.sources) ? config.sources : [],
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await env.CONFIG_R2.put(CONFIG_KEY, JSON.stringify(normalized, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return normalized;
}

export function validateConfig(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "Config must be an object.";
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.admins)) return "`admins` must be an array of email addresses.";
  for (const a of c.admins) {
    if (typeof a !== "string" || !/.+@.+\..+/.test(a)) {
      return `Invalid admin email: ${JSON.stringify(a)}`;
    }
  }
  if (!Array.isArray(c.sources)) return "`sources` must be an array.";
  for (const s of c.sources as unknown[]) {
    if (!s || typeof s !== "object") return "Each source must be an object.";
    const src = s as Record<string, unknown>;
    for (const field of ["id", "label", "kind", "instance"] as const) {
      if (typeof src[field] !== "string" || !src[field]) {
        return `Source is missing required string field: ${field}`;
      }
    }
    if (typeof src.enabled !== "boolean") return "Source.enabled must be a boolean.";
    if (src.config == null || typeof src.config !== "object") {
      return "Source.config must be an object.";
    }
  }
  return null;
}
