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
  | 'completed'
  | 'failed'
  | 'cancelled';

export const PHASE_LABELS: Record<RunPhase, string> = {
  queued: 'En cola',
  fetching: 'Leyendo ticket',
  analyzing: 'Cargando casos',
  executing: 'Ejecutando Playwright',
  compiling: 'Compilando resultados',
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
  /** 0-based index of the step currently running / last finished while running */
  stepIndex?: number;
  stepTotal?: number;
  currentStep?: string;
};

export type RunProgressState = {
  phase: RunPhase;
  label: string;
  currentStep?: string;
  stepIndex?: number;
  stepTotal?: number;
  scenarioIndex?: number;
  scenarioTotal?: number;
  lastStepOk?: boolean;
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
  stepIndex: number | null;
  stepTotal: number | null;
  scenarioIndex: number | null;
  scenarioTotal: number | null;
  progressLabel: string | null;
  created_at: string;
  updated_at: string;
  steps: PipelineStep[];
  scenarios: ScenarioProgress[];
  summary: RunSummary | null;
  error: string | null;
  jiraPosted: boolean;
  canPublishToJira: boolean;
  followPath: string;
};

export type PresentedRunDetail = PresentedRun & {
  screenshots: RunScreenshot[];
};

const PIPELINE: Array<{ id: RunPhase; label: string }> = [
  { id: 'queued', label: 'En cola' },
  { id: 'fetching', label: 'Leyendo ticket' },
  { id: 'analyzing', label: 'Cargando casos' },
  { id: 'executing', label: 'Ejecutando Playwright' },
  { id: 'compiling', label: 'Compilando resultados' },
];

const PHASES = new Set<string>(Object.keys(PHASE_LABELS));

export function isRunPhase(value: string | null | undefined): value is RunPhase {
  return Boolean(value && PHASES.has(value));
}

export function resolvePhase(run: TestRunRow): RunPhase {
  if (run.status === 'completed') return 'completed';
  if (run.status === 'cancelled' || run.phase === 'cancelled') return 'cancelled';
  if (run.status === 'failed') return 'failed';
  // Legacy phase from when Jira publish ran inside the worker.
  if (run.phase === 'reporting') return 'compiling';
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

export function listTicketScreenshots(
  ticketKey: string,
  opts?: { since?: Date | string | null }
): RunScreenshot[] {
  const dir = path.join(getScreenshotsDir(), ticketKey);
  if (!fs.existsSync(dir)) return [];
  const sinceMs = parseSqliteTimeMs(opts?.since);
  const sinceOk = sinceMs != null;

  return fs
    .readdirSync(dir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .filter((name) => {
      if (!sinceOk) return true;
      try {
        const st = fs.statSync(path.join(dir, name));
        // 5s skew between SQLite created_at (UTC) and filesystem mtime
        return st.mtimeMs >= sinceMs! - 5000;
      } catch {
        return false;
      }
    })
    .map((name) => ({
      name,
      url: screenshotPublicUrl(path.join(dir, name)),
    }));
}

/** SQLite `datetime('now')` is UTC without a timezone suffix. */
function parseSqliteTimeMs(value: Date | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const iso =
    /Z$|[+-]\d{2}:?\d{2}$/.test(raw)
      ? raw
      : raw.includes('T')
        ? `${raw}Z`
        : `${raw.replace(' ', 'T')}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Screenshots that belong to THIS run only.
 * Never fall back to the whole ticket folder (that mixes prior runs).
 */
export function screenshotsForRun(run: TestRunRow): RunScreenshot[] {
  const result = parseResult(run.result_json);
  const fromResult =
    result && Array.isArray(result.screenshots)
      ? (result.screenshots as Array<{ name?: string; path?: string }>)
          .map((s) => ({
            name: s.name || path.basename(s.path || ''),
            url: s.path ? screenshotPublicUrl(s.path) : '',
          }))
          .filter((s) => s.url)
      : [];
  if (fromResult.length) return fromResult;

  const phase = resolvePhase(run);
  // No evidence yet — do not surface leftovers from older runs.
  if (
    phase === 'queued' ||
    phase === 'fetching' ||
    phase === 'analyzing'
  ) {
    return [];
  }

  const ticketKey = run.ticket_id || '';
  if (!ticketKey) return [];
  return listTicketScreenshots(ticketKey, { since: run.created_at });
}

function pipelineSteps(run: TestRunRow, phase: RunPhase): PipelineStep[] {
  const steps = PIPELINE;
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
  return rows.map((row: any) => {
    const failedStep = Array.isArray(row.steps)
      ? row.steps.find((s: any) => s && s.success === false)
      : null;
    const stepError =
      failedStep && typeof failedStep.error === 'string'
        ? String(failedStep.error)
        : undefined;
    const listError =
      Array.isArray(row.errors) && row.errors.length
        ? String(row.errors[0])
        : undefined;
    return {
      id: String(row.scenarioId || ''),
      description: String(row.description || row.scenarioId || ''),
      status: row.success ? 'passed' : 'failed',
      duration: typeof row.duration === 'number' ? row.duration : undefined,
      error: stepError || listError,
    };
  });
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
  const stepIndex =
    typeof progress?.stepIndex === 'number' ? progress.stepIndex : null;
  const stepTotal =
    typeof progress?.stepTotal === 'number' ? progress.stepTotal : null;
  const scenarioIndex =
    typeof progress?.scenarioIndex === 'number' ? progress.scenarioIndex : null;
  const scenarioTotal =
    typeof progress?.scenarioTotal === 'number' ? progress.scenarioTotal : null;
  const rawStep =
    progress?.currentStep ||
    (progress?.label && phase === 'executing' ? progress.label : null);
  const progressLabel = formatLiveProgressLabel({
    phase,
    phaseLabel: PHASE_LABELS[phase],
    label: progress?.label,
    currentStep: rawStep,
    stepIndex,
    stepTotal,
    scenarioIndex,
    scenarioTotal,
    lastStepOk: progress?.lastStepOk,
  });
  const currentStep = progressLabel || rawStep;

  const jiraPosted = Boolean(run.jira_posted_at);
  const canPublishToJira =
    run.source === 'jira' &&
    Boolean(run.ticket_id) &&
    (phase === 'completed' || phase === 'failed') &&
    Boolean(result) &&
    !jiraPosted;

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
    stepIndex,
    stepTotal,
    scenarioIndex,
    scenarioTotal,
    progressLabel,
    created_at: run.created_at,
    updated_at: run.updated_at,
    steps: pipelineSteps(run, phase),
    scenarios,
    summary: summaryFromResult(result),
    error,
    jiraPosted,
    canPublishToJira,
    followPath: `/runs?id=${run.id}`,
  };
}

export function formatLiveProgressLabel(opts: {
  phase: RunPhase;
  phaseLabel: string;
  label?: string | null;
  currentStep?: string | null;
  stepIndex?: number | null;
  stepTotal?: number | null;
  scenarioIndex?: number | null;
  scenarioTotal?: number | null;
  lastStepOk?: boolean;
}): string | null {
  if (opts.phase !== 'executing') {
    return opts.label || opts.phaseLabel || null;
  }

  const parts: string[] = [];
  if (
    typeof opts.scenarioIndex === 'number' &&
    typeof opts.scenarioTotal === 'number' &&
    opts.scenarioTotal > 0
  ) {
    parts.push(`Caso ${opts.scenarioIndex + 1}/${opts.scenarioTotal}`);
  }
  if (
    typeof opts.stepIndex === 'number' &&
    typeof opts.stepTotal === 'number' &&
    opts.stepTotal > 0
  ) {
    parts.push(`Paso ${opts.stepIndex + 1}/${opts.stepTotal}`);
  }
  if (opts.lastStepOk === false) {
    parts.push('falló');
  }

  const stepText = opts.currentStep?.trim();
  if (stepText && !stepText.startsWith('Caso ')) {
    const short =
      stepText.length > 90 ? `${stepText.slice(0, 87)}…` : stepText;
    if (parts.length) return `${parts.join(' · ')} · ${short}`;
    return short;
  }

  if (parts.length) return parts.join(' · ');
  return opts.label || opts.phaseLabel || null;
}

export function presentRunDetail(run: TestRunRow): PresentedRunDetail {
  const presented = presentRun(run);
  return { ...presented, screenshots: screenshotsForRun(run) };
}

export function progressPayload(state: RunProgressState): string {
  return JSON.stringify(state);
}
