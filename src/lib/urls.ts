// Map an AI Search chunk back to a URL the user can click through to.
// Used by /api/search (UI results) and by the chat agent tools so the
// LLM can cite hits with real `[title](url)` links.

export function sourceUrl(
  instanceId: string,
  key?: string,
  metadata?: Record<string, unknown>,
): string | undefined {
  if (!key) return undefined;

  if (instanceId === "warbotics-content") {
    const slug =
      typeof metadata?.slug === "string"
        ? metadata.slug
        : key.replace(/\.(md|mdx)$/, "");
    return `/docs/${slug}`;
  }

  if (instanceId === "wpilib-docs") {
    // The indexer renamed .rst to .md. Public docs live at
    // https://docs.wpilib.org/en/stable/<same-path>.html.
    const path = key.replace(/\.md$/, ".html");
    return `https://docs.wpilib.org/en/stable/${path}`;
  }

  // user-<slackUserId> instances have no external URL.
  return undefined;
}
