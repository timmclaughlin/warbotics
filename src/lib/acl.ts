// Access control: who can view/edit /settings.
//
// A user is an admin if EITHER
//   - their Slack email matches OWNER_EMAIL (the lockout safety net), OR
//   - their Slack user id is in AppConfig.admins (editable via /settings)

import type { AppConfig } from "~/lib/settings";

export interface UserLike {
  slackUserId?: string;
  email?: string;
}

export function isAdmin(user: UserLike | undefined, config: AppConfig, env: Env): boolean {
  if (!user) return false;
  const email = user.email?.trim().toLowerCase();
  if (email && env.OWNER_EMAIL && email === env.OWNER_EMAIL.trim().toLowerCase()) return true;
  if (user.slackUserId && config.admins.includes(user.slackUserId)) return true;
  return false;
}
