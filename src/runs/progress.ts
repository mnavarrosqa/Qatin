import path from 'path';
import fs from 'fs';
import { getScreenshotsDir, isPathInside } from '../paths';
import type { TestRunRow } from '../db';

export type RunPhase =
  | 'queued'
  | 'fetching'
  | 'analyzing'
  | 'executing'
  | 'compiling'
  | 'reporting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const PHASE_LABELS: Record<RunPhase, string> = {
  queued: 'En cola',
  fetching: 'Leyendo ticket',
  analyzing: 'Preparando casos',
  executing: 'Ejecutando Playwright',
  compiling: 'Compilando resultados',
  reporting: 'Publicando en Jira',
  completed: 'Completada',
  failed: 'Fallida',
  cancelled: 'Cancelada',
};

export type ScenarioProgress = {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  duration?: number;
  error?: string;
};

export type RunProgressState = {
  phase: RunPhase;
  label: string;
  currentStep?: string;
  stepIndex?: number;
  stepTotal?: number;
  scenarios?: ScenarioProgress[];
};

export type PipelineStep = {
  id: string;
  label: string;
  state: 'done' | 'current' | 'pending' | 'failed';
};

export type RunScreenshot = {
  name: string;
  url: string;
};

export type RunSummary = {
  total: number;
  successful: number;
  failed: number;
  passed: boolean;
  totalDuration?: number;
};

export type PresentedRun = {
  id: number;
  project_id: number | null;
  job_id: string | null;
  source: 'jira' | 'paste';
  ticket_id: string | null;
  pasted_summary: string | null;
  status: string;
  phase: RunPhase;
  phaseLabel: string;
  currentStep: string | null;
  created_at: string;
  updated_at: string;
  steps: PipelineStep[];
  scenarios: ScenarioProgress[];
  summary: RunSummary | null;
  error: string | null;
  followPath: string;
};

export type PresentedRunDetail = PresentedRun & {
  screenshots: RunScreenshot[];
};

const PIPELINE: Array<{ id: RunPhase; label: string; jiraOnly?: boolean }> = [
  { id: 'queued', label: 'En cola' },
  { id: 'fetching', label: 'Leyendo ticket' },
  { id: 'analyzing', label: 'Preparando casos' },
  { id: 'executing', label: 'Ejecutando Playwright' },
  { id: 'compiling', label: 'Compilando resultados' },
  { id: 'reporting', label: 'Publicando en Jira', jiraOnly: true },
];

const PHASES = new Set<string>(Object.keys(PHASE_LABELS));

export function isRunPhase(value: string | null | undefined): value is RunPhase {
  return Boolean(value && PHASES.has(value));
}

export function resolvePhase(run: TestRunRow): RunPhase {
  if (run.status === 'completed') return 'completed';
  if (run.status === 'cancelled' || run.phase === 'cancelled') return 'cancelled';
  if (run.status === 'failed') return 'failed';
  if (
    isRunPhase(run.phase) &&
    run.phase !== 'completed' &&
    run.phase !== 'failed' &&
    run.phase !== 'cancelled'
  ) {
    return run.phase;
  }
  if (run.status === 'queued') return 'queued';
  return 'executing';
}

export function parseProgress(raw: string | null): RunProgressState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RunProgressState;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseResult(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function screenshotPublicUrl(filePath: string): string {
  const screenshotsRoot = getScreenshotsDir();
  const abs = path.resolve(filePath);
  if (isPathInside(screenshotsRoot, abs)) {
    const rel = path.relative(screenshotsRoot, abs).split(path.sep).join('/');
    return `/screenshots/${rel}`;
  }
  return filePath;
}

export function listTicketScreenshots(ticketKey: string): RunScreenshot[] {
  const dir = path.join(getScreenshotsDir(), ticketKey);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .map((name) => ({
      name,
      url: screenshotPublicUrl(path.join(dir, name)),
    }));
}

function pipelineSteps(run: TestRunRow, phase: RunPhase): PipelineStep[] {
  const steps = PIPELINE.filter((s) => !s.jiraOnly || run.source === 'jira');
  if (phase === 'completed') {
    return steps.map((s) => ({ id: s.id, label: s.label, state: 'done' as const }));
  }

  const progress = parseProgress(run.progress_json);
  const failedAt =
    phase === 'failed' || phase === 'cancelled'
      ? progress &&
        isRunPhase(progress.phase) &&
        progress.phase !== 'failed' &&
        progress.phase !== 'cancelled'
        ? progress.phase
        : isRunPhase(run.phase) &&
            run.phase !== 'failed' &&
            run.phase !== 'cancelled'
          ? run.phase
          : 'executing'
      : null;

  if (failedAt) {
    let seen = false;
    return steps.map((s) => {
      if (s.id === failedAt) {
        seen = true;
        return { id: s.id, label: s.label, state: 'failed' as const };
      }
      if (!seen) return { id: s.id, label: s.label, state: 'done' as const };
      return { id: s.id, label: s.label, state: 'pending' as const };
    });
  }

  const idx = steps.findIndex((s) => s.id === phase);
  const current = idx < 0 ? 0 : idx;
  return steps.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: i < current ? 'done' : i === current ? 'current' : 'pending',
  }));
}

function scenariosFromResult(
  result: Record<string, unknown> | null
): ScenarioProgress[] {
  const rows = result?.executionResults;
  if (!Array.isArray(rows)) return [];
  return rows.map((row: any) => ({
    id: String(row.scenarioId || ''),
    description: String(row.description || row.scenarioId || ''),
    status: row.success ? 'passed' : 'failed',
    duration: typeof row.duration === 'number' ? row.duration : undefined,
    error: Array.isArray(row.errors) && row.errors.length ? String(row.errors[0]) : undefined,
  }));
}

function summaryFromResult(result: Record<string, unknown> | null): RunSummary | null {
  const summary = result?.summary;
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as any;
  if (typeof s.total !== 'number') return null;
  return {
    total: s.total,
    successful: s.successful ?? 0,
    failed: s.failed ?? 0,
    passed: Boolean(s.passed),
    totalDuration: typeof s.totalDuration === 'number' ? s.totalDuration : undefined,
  };
}

export function presentRun(run: TestRunRow): PresentedRun {
  const phase = resolvePhase(run);
  const progress = parseProgress(run.progress_json);
  const result = parseResult(run.result_json);
  const scenarios =
    progress?.scenarios?.length ? progress.scenarios : scenariosFromResult(result);
  const error =
    result && typeof result.error === 'string' ? result.error : null;
  const currentStep =
    progress?.currentStep ||
    (progress?.label && phase === 'executing' ? progress.label : null);

  return {
    id: run.id,
    project_id: run.project_id,
    job_id: run.job_id,
    source: run.source,
    ticket_id: run.ticket_id,
    pasted_summary: run.pasted_summary,
    status: run.status,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    currentStep,
    created_at: run.created_at,
    updated_at: run.updated_at,
    steps: pipelineSteps(run, phase),
    scenarios,
    summary: summaryFromResult(result),
    error,
    followPath: `/runs?id=${run.id}`,
  };
}

export function presentRunDetail(run: TestRunRow): PresentedRunDetail {
  const presented = presentRun(run);
  const result = parseResult(run.result_json);
  const fromResult =
    result && Array.isArray(result.screenshots)
      ? (result.screenshots as Array<{ name?: string; path?: string }>).map((s) => ({
          name: s.name || path.basename(s.path || ''),
          url: s.path ? screenshotPublicUrl(s.path) : '',
        })).filter((s) => s.url)
      : [];
  const ticketKey = run.ticket_id || '';
  const screenshots = fromResult.length
    ? fromResult
    : ticketKey
      ? listTicketScreenshots(ticketKey)
      : [];

  return { ...presented, screenshots };
}

export function progressPayload(state: RunProgressState): string {
  return JSON.stringify(state);
}
