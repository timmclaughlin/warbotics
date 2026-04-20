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

// Every time a Slack user signs in, we stash a record here so admins can
// pick from a list of "people who've actually logged in" rather than
// typing opaque Slack user IDs. Display name drives the admin UI.
export interface KnownUser {
  slackUserId: string;
  name: string;
  email?: string;
  avatar?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AppConfig {
  // Slack user IDs (U01ABCDE…) of admins — plus the OWNER_EMAIL env user
  // who is always admin as a lockout safety net.
  admins: string[];
  knownUsers: KnownUser[];
  sources: Source[];
  updatedAt?: string;
  updatedBy?: string;
}

const CONFIG_KEY = "config.json";

export const DEFAULT_CONFIG: AppConfig = {
  admins: [],
  knownUsers: [],
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
    // On first-ever load, start with no admins: the OWNER_EMAIL env var
    // grants access until the owner adds other admins via /settings.
    const seeded: AppConfig = { ...DEFAULT_CONFIG };
    await saveConfig(env, seeded, env.OWNER_EMAIL ?? "system");
    return seeded;
  }
  try {
    const text = await obj.text();
    const parsed = JSON.parse(text) as Partial<AppConfig>;
    // Silently drop legacy email-shaped admin entries left over from
    // before admins were slackUserId-based. OWNER_EMAIL still grants
    // access regardless, so no one gets locked out.
    const admins = Array.isArray(parsed.admins)
      ? parsed.admins.map((e) => String(e).trim()).filter((e) => e && !e.includes("@"))
      : [];
    return {
      admins,
      knownUsers: Array.isArray(parsed.knownUsers) ? parsed.knownUsers : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      updatedAt: parsed.updatedAt,
      updatedBy: parsed.updatedBy,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(
  env: Env,
  config: AppConfig,
  updatedBy: string,
): Promise<AppConfig> {
  const normalized: AppConfig = {
    admins: Array.from(new Set((config.admins ?? []).map((e) => String(e).trim()).filter(Boolean))),
    knownUsers: Array.isArray(config.knownUsers) ? config.knownUsers : [],
    sources: Array.isArray(config.sources) ? config.sources : [],
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await env.CONFIG_R2.put(CONFIG_KEY, JSON.stringify(normalized, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return normalized;
}

// Upsert a user into knownUsers on sign-in so admins can pick from a
// list of people who've actually logged in. Never fails the caller —
// swallows errors so a bad R2 write doesn't break login.
export async function recordUserSighting(
  env: Env,
  user: { slackUserId: string; name: string; email?: string; avatar?: string },
): Promise<void> {
  try {
    const config = await loadConfig(env);
    const now = new Date().toISOString();
    const existing = config.knownUsers.find((u) => u.slackUserId === user.slackUserId);
    if (existing) {
      existing.name = user.name;
      existing.email = user.email;
      existing.avatar = user.avatar;
      existing.lastSeenAt = now;
    } else {
      config.knownUsers.push({
        slackUserId: user.slackUserId,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
    await saveConfig(env, config, `session:${user.slackUserId}`);
  } catch (err) {
    console.warn("recordUserSighting failed (non-fatal)", err);
  }
}

export function validateConfig(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "Config must be an object.";
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.admins)) return "`admins` must be an array of Slack user IDs.";
  for (const a of c.admins) {
    if (typeof a !== "string" || !a.trim()) {
      return `Invalid admin entry: ${JSON.stringify(a)}`;
    }
  }
  if (c.knownUsers !== undefined && !Array.isArray(c.knownUsers)) {
    return "`knownUsers` must be an array.";
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
