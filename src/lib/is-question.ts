// Shared heuristic used by /chat (where questions go through the LLM and
// non-questions are treated as keyword queries) and /search (where
// questions get bounced over to /chat). Keep both pages in sync.

const QUESTION_WORDS = new Set([
  "what", "how", "why", "when", "where", "who", "which",
  "can", "could", "should", "would", "do", "does", "did",
  "is", "are", "am", "was", "were", "will", "may", "might",
  "shall", "must", "have", "has",
  "tell", "show", "explain", "help", "describe", "find", "list", "give",
]);

export function isQuestion(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.endsWith("?")) return true;
  // First word, lowercased; split on straight or curly apostrophes (iOS
  // auto-substitutes ' → ’), drop remaining non-letters. Then accept the
  // stem if it's a question word, or if stripping a trailing "s" makes it
  // one (lazy typing like "whats" / "hows").
  const firstWord = s.split(/\s+/)[0].toLowerCase();
  const stem = firstWord.split(/['’`]/)[0].replace(/[^a-z]/g, "");
  if (QUESTION_WORDS.has(stem)) return true;
  if (stem.length > 2 && stem.endsWith("s") && QUESTION_WORDS.has(stem.slice(0, -1))) return true;
  return false;
}
