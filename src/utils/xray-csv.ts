/**
 * Build CSV ready for Xray Test Case Importer.
 * Issue Id groups step rows; Summary/Description/Test Type only on the first step.
 * @see https://docs.getxray.app/ (Test Case Importer)
 */

export const XRAY_CSV_HEADERS = [
  'Issue Id',
  'Summary',
  'Description',
  'Test Type',
  'Step',
  'Data',
  'Expected Result',
] as const;

export type XrayCsvCaseInput = {
  caseKey?: string;
  description: string;
  /** If set, used as Xray Summary as-is (still prefixed with ticket if missing). */
  summary?: string;
  steps?: string[];
  expectedResults?: string[];
};

export type XrayCsvBuildResult = {
  headers: string[];
  rows: string[][];
  csv: string;
  caseCount: number;
  stepCount: number;
  filename: string;
};

function escCsv(cell: string): string {
  if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

export function serializeXrayCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map(escCsv).join(',')).join('\n');
}

/** Strip [Happy]/[Unhappy]/[Corner] and take the first sentence (no mid-word cut). */
export function summaryFromDescription(
  caseKey: string | undefined,
  description: string,
  ticketKey?: string | null
): string {
  const cleaned = description
    .replace(/^\[(Happy|Unhappy|Corner)\]\s*/i, '')
    .trim();
  const first =
    cleaned.split(/(?<=\.)\s+/).find((s) => s.trim())?.trim() || cleaned;
  const ticket = (ticketKey || '').trim().toUpperCase();
  const key = (caseKey || '').trim();

  let body = first || key || 'Caso de prueba';
  if (key) {
    const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*[:—-]\\s*`, 'i');
    if (keyRe.test(body)) {
      // keep as-is
    } else if (!body.toUpperCase().startsWith(key.toUpperCase())) {
      body = `${key}: ${body}`;
    }
  }

  if (ticket) {
    const ticketRe = new RegExp(`^${escapeRegExp(ticket)}\\b`, 'i');
    if (!ticketRe.test(body)) {
      return `${ticket} — ${body}`;
    }
  }
  return body;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pull quoted fill values into the Data column when present. */
export function extractStepData(step: string): string {
  const m =
    step.match(/\bcon\s+'([^']+)'/i) ||
    step.match(/\bcon\s+"([^"]+)"/i) ||
    step.match(/\b=\s*'([^']+)'/) ||
    step.match(/\b=\s*"([^"]+)"/);
  return m ? m[1] : '';
}

function ticketFromText(text: string): string | null {
  const m = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

/**
 * Project base_url is often the login entry (…/v2/login).
 * For path joins use the app root; for bare {{BASE_URL}} keep the entry URL.
 */
export function resolveManualBaseUrls(baseUrl: string | null | undefined): {
  root: string;
  entry: string;
} | null {
  const raw = (baseUrl || '').trim();
  if (!raw) return null;
  const entry = raw.replace(/\/+$/, '');
  try {
    const u = new URL(entry);
    let root = entry;
    if (/\/login\/?$/i.test(u.pathname)) {
      const stripped = u.pathname.replace(/\/login\/?$/i, '');
      u.pathname = stripped || '/';
      root = u.toString().replace(/\/+$/, '');
      if (!root || root === u.protocol + '//') root = u.origin;
    }
    return { root, entry };
  } catch {
    return { root: entry, entry };
  }
}

/** Expand {{BASE_URL}} to a concrete URL for manual Xray runs. */
export function expandManualUrls(
  text: string,
  baseUrl: string | null | undefined
): string {
  if (!text) return text;
  const resolved = resolveManualBaseUrls(baseUrl);
  if (!resolved) return text;
  const { root, entry } = resolved;
  return text
    .replace(
      /\{\{\s*BASE_URL\s*\}\}(\/[^\s"',)]*)?/gi,
      (_m, pathSuffix: string | undefined) =>
        pathSuffix ? `${root}${pathSuffix}` : entry
    )
    .replace(
      /\{\{\s*APP_BASE_URL\s*\}\}(\/[^\s"',)]*)?/gi,
      (_m, pathSuffix: string | undefined) =>
        pathSuffix ? `${root}${pathSuffix}` : entry
    );
}

function expandCaseForManual(
  c: XrayCsvCaseInput,
  baseUrl: string | null | undefined
): XrayCsvCaseInput {
  return {
    ...c,
    summary: c.summary
      ? expandManualUrls(c.summary, baseUrl)
      : c.summary,
    description: expandManualUrls(c.description || '', baseUrl),
    steps: (c.steps || []).map((s) => expandManualUrls(s, baseUrl)),
    expectedResults: (c.expectedResults || []).map((s) =>
      expandManualUrls(s, baseUrl)
    ),
  };
}

export function buildXrayCsv(
  cases: XrayCsvCaseInput[],
  opts?: { ticketKey?: string | null; baseUrl?: string | null }
): XrayCsvBuildResult {
  const headers = [...XRAY_CSV_HEADERS];
  const rows: string[][] = [];
  let stepCount = 0;

  const ticket =
    (opts?.ticketKey || '').trim().toUpperCase() ||
    ticketFromText(cases.map((c) => c.description).join(' ')) ||
    null;

  const prepared = cases.map((c) => expandCaseForManual(c, opts?.baseUrl));

  prepared.forEach((c, index) => {
    const issueId = String(index + 1);
    const caseKey = (c.caseKey || '').trim() || undefined;
    const description = (c.description || '').trim();
    const summary = (c.summary || '').trim()
      ? ensureTicketInSummary(c.summary!.trim(), ticket)
      : summaryFromDescription(caseKey, description, ticket);
    const steps = (c.steps || []).map((s) => s.trim()).filter(Boolean);
    const expected = (c.expectedResults || []).map((s) => s.trim());
    const stepList = steps.length ? steps : [description || summary];

    stepList.forEach((step, si) => {
      stepCount += 1;
      const isFirst = si === 0;
      rows.push([
        issueId,
        isFirst ? summary : '',
        isFirst ? description : '',
        isFirst ? 'Manual' : '',
        step,
        extractStepData(step),
        expected[si] || expected[expected.length - 1] || '',
      ]);
    });
  });

  return {
    headers,
    rows,
    csv: serializeXrayCsv(headers, rows) + '\n',
    caseCount: cases.length,
    stepCount,
    filename: ticket ? `${ticket}-xray.csv` : 'casos-xray.csv',
  };
}

function ensureTicketInSummary(summary: string, ticket: string | null): string {
  if (!ticket) return summary;
  const ticketRe = new RegExp(`^${escapeRegExp(ticket)}\\b`, 'i');
  if (ticketRe.test(summary)) return summary;
  return `${ticket} - ${summary}`;
}
