import { listTestCases, type TestCasePublic } from '../db';
import type { TestStrategy, TestScenario } from '../agents/ticket-analyzer';
import { looksLikeApiCase } from '../agents/ticket-analyzer';

export function inferTestTypeFromCases(
  cases: TestCasePublic[]
): TestStrategy['testType'] {
  if (!cases.length) return 'ui';
  const apiCount = cases.filter((c) => looksLikeApiCase(c)).length;
  if (apiCount === 0) return 'ui';
  if (apiCount === cases.length) return 'api';
  if (apiCount >= Math.ceil(cases.length / 2)) return 'api';
  return 'mixed';
}

export function casesToStrategy(
  cases: TestCasePublic[],
  opts?: { ticketKey?: string | null; summary?: string }
): TestStrategy | null {
  if (!cases.length) return null;

  const scenarios: TestScenario[] = cases.map((c, i) => ({
    id: c.case_key || `TC-${String(i + 1).padStart(2, '0')}`,
    description: c.description,
    steps: c.steps || [],
    expectedResults: c.expectedResults || [],
    ...(c.urls?.length ? { urls: c.urls } : {}),
    ...(c.selectors?.length ? { selectors: c.selectors } : {}),
    ...(c.apiEndpoints?.length ? { apiEndpoints: c.apiEndpoints } : {}),
  }));

  const ticket = opts?.ticketKey ? ` ${opts.ticketKey}` : '';
  const testType = inferTestTypeFromCases(cases);
  return {
    testType,
    summary:
      opts?.summary?.trim() ||
      `Estrategia desde ${cases.length} caso(s) guardado(s)${ticket}`,
    estimatedDuration: Math.max(15, cases.length * 8),
    priority: 'medium',
    scenarios,
  };
}

/** Load persisted cases for a ticket and build an executable strategy. */
export function buildStrategyFromSavedCases(
  projectId: number,
  ticketKey: string
): TestStrategy | null {
  const key = ticketKey.trim().toUpperCase();
  if (!key) return null;
  const cases = listTestCases({ projectId, ticketKey: key });
  return casesToStrategy(cases, { ticketKey: key });
}

export const CASES_REQUIRED_ERROR =
  'No hay casos de prueba guardados para este ticket. Primero generá y guardá los casos; después podés ejecutar Playwright.';
