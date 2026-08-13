/**
 * Jira-like keys (PROJ-123) vs test-case ids (TC-01).
 * Keep in sync with src/utils/ticket-key.ts
 */

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/gi;
const CASE_KEY_RE = /^TC-\d+$/i;

export function isTestCaseKey(key: string): boolean {
  return CASE_KEY_RE.test(key.trim());
}

export function isJiraTicketKey(key: string): boolean {
  const k = key.trim();
  if (!k || isTestCaseKey(k)) return false;
  return /^[A-Z][A-Z0-9]+-\d+$/i.test(k);
}

export function extractJiraTicketKeys(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of text.matchAll(JIRA_KEY_RE)) {
    const key = match[1].toUpperCase();
    if (isTestCaseKey(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

/**
 * Keys the user likely requested (not related keys buried in a long paste).
 * Keep in sync with src/utils/ticket-key.ts
 */
export function extractRequestedJiraTicketKeys(text: string): string[] {
  if (!text) return [];
  const all = extractJiraTicketKeys(text);
  if (all.length <= 1) return all;
  if (text.length <= 400) return all;

  const blank = text.search(/\n\s*\n/);
  const head =
    blank > 0 && blank <= 400 ? text.slice(0, blank) : text.slice(0, 280);
  const fromHead = extractJiraTicketKeys(head);
  if (fromHead.length) return fromHead;

  const fromTail = extractJiraTicketKeys(text.slice(-280));
  if (fromTail.length) return fromTail;

  return all.slice(0, 1);
}

export function extractJiraTicketKey(text: string): string | null {
  const keys = extractJiraTicketKeys(text);
  return keys.length ? keys[keys.length - 1] : null;
}

/** Prefer keys the user typed; ignore related keys inside assistant dumps. */
export function extractJiraTicketKeyFromUserTurns(
  messages: Array<{ kind?: string; role?: string; content?: string }>
): string | null {
  const keys = extractJiraTicketKeysFromUserTurns(messages);
  return keys.length ? keys[keys.length - 1] : null;
}

/**
 * Requested keys from the most recent user message that contains at least one
 * Jira-like key (order of appearance). Ignores assistant dumps.
 */
export function extractJiraTicketKeysFromUserTurns(
  messages: Array<{ kind?: string; role?: string; content?: string }>
): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isUser =
      m.kind === 'user' || (m.role || '').toLowerCase() === 'user';
    if (!isUser) continue;
    const keys = extractRequestedJiraTicketKeys(m.content || '');
    if (keys.length) return keys;
  }
  return [];
}
