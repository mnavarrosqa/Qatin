/**
 * Run-memory formatting and few-shot examples for the ticket analyzer.
 */
import {
  getRunMemory,
  listTestCases,
  listTestRuns,
  type RunMemoryRow,
  type TestCasePublic,
} from '../db';
import type { TestSurface } from './ticket-analyzer';
import { looksLikeApiCase } from './ticket-analyzer';

export function formatRunMemoryContext(rows: RunMemoryRow[]): string {
  if (rows.length === 0) return '';

  return rows
    .map((row, i) => {
      const selectors = row.selectors_json
        ? `\n  Notes: ${row.selectors_json}`
        : '';
      return `${i + 1}. [${row.outcome || 'unknown'}] ${row.ticket_key || 'n/a'}: ${row.summary}${selectors}`;
    })
    .join('\n');
}

/**
 * Build 1–2 few-shot examples from cases that belong to tickets with a
 * recent passed (or mostly-passed) run in this project.
 * When surface is api, only API-shaped cases are used (empty if none — avoids UI bias).
 */
export function buildFewShotFromProject(
  projectId: number,
  opts?: {
    excludeTicketKey?: string;
    limit?: number;
    surface?: TestSurface;
  }
): string {
  const limit = opts?.limit ?? 2;
  const exclude = (opts?.excludeTicketKey || '').toUpperCase();
  const surface = opts?.surface || 'ui';

  const matchesSurface = (c: TestCasePublic): boolean => {
    const api = looksLikeApiCase(c);
    if (surface === 'api') return api;
    if (surface === 'ui') return !api;
    return true; // mixed: any solid example
  };

  const passedMemories = getRunMemory({ projectId, limit: 20 }).filter(
    (m) =>
      (m.outcome === 'passed' || m.outcome === 'mixed') &&
      m.ticket_key &&
      m.ticket_key.toUpperCase() !== exclude
  );

  const examples: string[] = [];
  const seenTickets = new Set<string>();

  for (const mem of passedMemories) {
    if (examples.length >= limit) break;
    const key = mem.ticket_key!.toUpperCase();
    if (seenTickets.has(key)) continue;
    seenTickets.add(key);

    const cases = listTestCases({ projectId, ticketKey: key }).filter(
      (c) =>
        matchesSurface(c) &&
        c.steps.length >= 4 &&
        (c.expectedResults?.length || 0) >= 1
    );
    if (!cases.length) continue;

    const pick = pickBestCase(cases);
    examples.push(formatCaseExample(pick, mem.outcome || 'passed'));
  }

  // Fallback: any solid saved case in the project (same surface filter)
  if (!examples.length) {
    const all = listTestCases({ projectId })
      .filter(
        (c) =>
          matchesSurface(c) &&
          c.ticket_key?.toUpperCase() !== exclude &&
          c.steps.length >= 5 &&
          (c.expectedResults?.length || 0) >= 2
      )
      .slice(0, limit);
    for (const c of all) {
      examples.push(formatCaseExample(c, 'saved'));
    }
  }

  // API tickets: never fall back to UI examples (that reintroduces Playwright bias).
  if (!examples.length) return '';

  return `Use these REAL project examples as shape/quality reference (adapt fields to THIS ticket — do not copy paths/labels blindly):\n\n${examples.join('\n\n')}`;
}

function pickBestCase(cases: TestCasePublic[]): TestCasePublic {
  return [...cases].sort((a, b) => {
    const score = (c: TestCasePublic) =>
      c.steps.length +
      (c.expectedResults?.length || 0) * 2 +
      (c.selectors?.length || 0) +
      (c.urls?.length || 0);
    return score(b) - score(a);
  })[0];
}

function formatCaseExample(c: TestCasePublic, tag: string): string {
  const steps = c.steps
    .slice(0, 10)
    .map((s, i) => `    ${i + 1}. ${s}`)
    .join('\n');
  const expected = (c.expectedResults || [])
    .slice(0, 6)
    .map((s) => `    - ${s}`)
    .join('\n');
  const selectors = c.selectors?.length
    ? `\n  selectors: ${c.selectors.slice(0, 5).join(', ')}`
    : '';
  return `[${tag}] ${c.ticket_key || '?'} / ${c.case_key}
  description: ${c.description.slice(0, 280)}
  steps:
${steps}
  expectedResults:
${expected}${selectors}`;
}

/** Enrich memory notes from execution failures (step text + error). */
export function buildFailureNotes(
  results: Array<{
    scenarioId: string;
    success: boolean;
    errors?: string[];
    steps?: Array<{ step: string; success: boolean; error?: string }>;
  }>,
  scenarios: Array<{ id: string; selectors?: string[] }>
): string[] {
  const notes: string[] = [];

  for (const scenario of scenarios) {
    const result = results.find((r) => r.scenarioId === scenario.id);
    if (!result) continue;
    const status = result.success ? 'ok' : 'fail';

    if (scenario.selectors?.length) {
      notes.push(
        `${scenario.id}[${status}]: ${scenario.selectors.slice(0, 5).join(', ')}`
      );
    }

    if (!result.success) {
      const failedStep = result.steps?.find((s) => !s.success);
      if (failedStep) {
        notes.push(
          `${scenario.id} failed step: "${failedStep.step.slice(0, 120)}"${
            failedStep.error ? ` → ${failedStep.error.slice(0, 160)}` : ''
          }`
        );
      } else if (result.errors?.length) {
        notes.push(
          `${scenario.id} errors: ${result.errors.slice(0, 2).join('; ').slice(0, 200)}`
        );
      }
    }
  }

  return notes;
}

/** Tickets that recently completed successfully — for few-shot ranking. */
export function recentPassedTicketKeys(
  projectId: number,
  limit = 10
): string[] {
  const runs = listTestRuns(40, projectId);
  const keys: string[] = [];
  for (const run of runs) {
    if (run.status !== 'completed' || !run.ticket_id) continue;
    try {
      const result = run.result_json ? JSON.parse(run.result_json) : null;
      if (result?.summary?.passed || result?.summary?.failed === 0) {
        const k = run.ticket_id.toUpperCase();
        if (!keys.includes(k)) keys.push(k);
      }
    } catch {
      /* ignore */
    }
    if (keys.length >= limit) break;
  }
  return keys;
}
