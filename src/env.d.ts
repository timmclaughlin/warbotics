/// <reference types="astro/client" />

type KVNamespace = import("@cloudflare/workers-types").KVNamespace;
type Fetcher = import("@cloudflare/workers-types").Fetcher;

interface Env {
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  AI_SEARCH_NAMESPACE: string;
  AI_SEARCH_NAMESPACE_ID: string;
  AI_SEARCH_INSTANCE_CONTENT: string;
  AI_SEARCH_INSTANCE_WPILIB: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_REDIRECT_URI: string;
  SLACK_TEAM_ID: string;
  SESSION_SECRET: string;
  CONTENT_REPO: string;
  CONTENT_BRANCH: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    user?: {
      id: string;
      slackUserId: string;
      slackTeamId: string;
      name: string;
      email?: string;
      avatar?: string;
      aiSearchInstanceId: string;
    };
    sessionId?: string;
  }
}
