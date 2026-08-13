/**
 * Jira-like keys (PROJ-123) vs test-case ids (TC-01).
 * Case keys look like tickets to a naive regex — always filter them out.
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

/** All Jira-like keys in text, excluding TC-01 style case ids. */
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
 * Keys the user likely *requested*, not related keys buried in a long paste.
 * Short messages: all keys. Long messages: prefer head, then tail.
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

  // Huge paste with keys only in the middle: do not expand to every related key.
  return all.slice(0, 1);
}

/** Last Jira-like key in text, or null. */
export function extractJiraTicketKey(text: string): string | null {
  const keys = extractJiraTicketKeys(text);
  return keys.length ? keys[keys.length - 1] : null;
}

/**
 * Prefer ticket keys the user typed (most recent user message with a key).
 * Avoids picking related keys buried in assistant CSV/descriptions.
 */
export function extractJiraTicketKeyFromUserTurns(
  messages: Array<{ role?: string; content?: string | null }>
): string | null {
  const keys = extractJiraTicketKeysFromUserTurns(messages);
  return keys.length ? keys[keys.length - 1] : null;
}

/**
 * Requested keys from the most recent user message that contains at least one
 * Jira-like key (order of appearance). Ignores assistant dumps.
 */
export function extractJiraTicketKeysFromUserTurns(
  messages: Array<{ role?: string; content?: string | null }>
): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m.role || '').toLowerCase() !== 'user') continue;
    const keys = extractRequestedJiraTicketKeys(m.content || '');
    if (keys.length) return keys;
  }
  return [];
}

/**
 * Resolve a ticket from an explicit id and/or URL.
 * Rejects test-case keys so "TC-02" never becomes a ticket id.
 */
export function resolveTicketKey(
  ticketId?: string | null,
  ticketUrl?: string | null
): string | null {
  if (ticketId?.trim()) {
    const k = ticketId.trim().toUpperCase();
    if (isTestCaseKey(k)) return null;
    if (isJiraTicketKey(k)) return k;
    // Allow non-Jira pasted ids only if they don't look like case keys
    if (!/^TC-/i.test(k)) return k;
    return null;
  }
  if (!ticketUrl) return null;
  return extractJiraTicketKey(ticketUrl);
}
