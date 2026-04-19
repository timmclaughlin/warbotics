// Access control: who can view/edit /settings.
//
// A user is an admin if their Slack-verified email matches either:
//   - OWNER_EMAIL (the bootstrap owner, set in wrangler.toml)
//   - any address in AppConfig.admins (editable via /settings)

import type { AppConfig } from "~/lib/settings";

export interface UserLike {
  email?: string;
}

export function isAdmin(user: UserLike | undefined, config: AppConfig, env: Env): boolean {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;
  if (env.OWNER_EMAIL && email === env.OWNER_EMAIL.trim().toLowerCase()) return true;
  return config.admins.includes(email);
}
