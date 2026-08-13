import fs from 'fs';
import path from 'path';
import {
  createTestRun,
  deleteTestRun,
  getDb,
  getProject,
  getProjectCredentials,
  getTestRun,
  updateTestRun,
  type TestRunRow,
} from '../db';
import type { LlmProvider } from '../llm';
import { testQueue } from '../queue';
import { getScreenshotsDir, isPathInside } from '../paths';
import { logger } from '../utils/logger';
import {
  buildStrategyFromSavedCases,
  CASES_REQUIRED_ERROR,
} from './strategy-from-cases';

export class RunCancelledError extends Error {
  constructor(message = 'Ejecución cancelada') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

export function isRunCancelled(runId?: number | null): boolean {
  if (!runId) return false;
  const run = getTestRun(runId);
  // Missing row (deleted while active) must stop the worker.
  if (!run) return true;
  return run.status === 'cancelled' || run.phase === 'cancelled';
}

export function assertRunNotCancelled(runId?: number | null): void {
  if (isRunCancelled(runId)) {
    throw new RunCancelledError();
  }
}

/**
 * Atomically mark a run completed/failed. No-ops if already cancelled/deleted
 * so a late worker finish cannot overwrite a user cancel.
 */
export function finalizeTestRun(
  id: number,
  outcome: 'completed' | 'failed',
  patch: { result_json: string; ticket_id?: string }
): 'ok' | 'cancelled' | 'missing' {
  const result = getDb()
    .prepare(
      `UPDATE test_runs SET
         status = ?,
         phase = ?,
         result_json = ?,
         ticket_id = COALESCE(?, ticket_id),
         updated_at = datetime('now')
       WHERE id = ?
         AND status NOT IN ('cancelled', 'completed', 'failed')
         AND IFNULL(phase, '') != 'cancelled'`
    )
    .run(
      outcome,
      outcome,
      patch.result_json,
      patch.ticket_id ?? null,
      id
    );

  if (result.changes > 0) return 'ok';

  const run = getTestRun(id);
  if (!run) return 'missing';
  if (run.status === 'cancelled' || run.phase === 'cancelled') {
    return 'cancelled';
  }
  return 'ok';
}

async function cancelQueueJob(jobId: string | null | undefined): Promise<void> {
  if (!jobId) return;
  try {
    const job = await testQueue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'paused') {
      await job.remove();
      return;
    }
    if (state === 'active') {
      await job.discard();
    }
  } catch (err) {
    logger.warn(`Failed to cancel queue job ${jobId}:`, err);
  }
}

function isTerminalStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
  );
}

export async function cancelTestRun(
  id: number
): Promise<{ run: TestRunRow | null; error?: string }> {
  const run = getTestRun(id);
  if (!run) return { run: null, error: 'Run no encontrado' };
  if (run.status === 'cancelled') return { run };
  if (isTerminalStatus(run.status)) {
    return { run, error: 'La ejecución ya terminó' };
  }

  updateTestRun(id, {
    status: 'cancelled',
    phase: 'cancelled',
    result_json: JSON.stringify({
      success: false,
      cancelled: true,
      error: 'Cancelada por el usuario',
    }),
  });
  await cancelQueueJob(run.job_id);
  return { run: getTestRun(id) };
}

/**
 * Queue a new run with the same ticket/paste payload as a finished one.
 */
export async function rerunTestRun(
  id: number
): Promise<{ run: TestRunRow | null; sourceRun: TestRunRow | null; error?: string }> {
  const source = getTestRun(id);
  if (!source) return { run: null, sourceRun: null, error: 'Run no encontrado' };
  if (!isTerminalStatus(source.status)) {
    return {
      run: null,
      sourceRun: source,
      error: 'La ejecución todavía está en curso. Frenala primero.',
    };
  }
  if (!source.project_id) {
    return { run: null, sourceRun: source, error: 'La ejecución no tiene proyecto' };
  }

  const project = getProject(source.project_id);
  if (!project) {
    return { run: null, sourceRun: source, error: 'Proyecto no encontrado' };
  }

  let ticketId = source.ticket_id;
  if (source.source === 'paste') {
    if (!source.pasted_summary || !source.pasted_description) {
      return {
        run: null,
        sourceRun: source,
        error: 'Faltan datos del ticket pegado para re-ejecutar',
      };
    }
    ticketId = `PASTE-${Date.now()}`;
  } else if (!ticketId) {
    return {
      run: null,
      sourceRun: source,
      error: 'La ejecución no tiene ticket',
    };
  }

  const credentials = getProjectCredentials(project);
  const llmProvider = (project.llm_provider as LlmProvider | null) || undefined;

  const strategy = buildStrategyFromSavedCases(
    source.project_id,
    source.ticket_id || ticketId
  );
  if (!strategy) {
    return {
      run: null,
      sourceRun: source,
      error: CASES_REQUIRED_ERROR,
    };
  }

  const run = createTestRun({
    project_id: source.project_id,
    source: source.source,
    ticket_id: ticketId,
    pasted_summary: source.pasted_summary,
    pasted_description: source.pasted_description,
    status: 'queued',
  });

  const job = await testQueue.add('test-ticket', {
    ticketId,
    projectId: source.project_id,
    runId: run.id,
    source: source.source,
    pastedTicket:
      source.source === 'paste'
        ? {
            summary: source.pasted_summary || undefined,
            description: source.pasted_description || undefined,
          }
        : undefined,
    strategy,
    projectConfig: {
      baseUrl: project.base_url || process.env.APP_BASE_URL,
      stagingUrl: project.staging_url || process.env.APP_STAGING_URL,
      testUserEmail: credentials.email || process.env.TEST_USER_EMAIL,
      testUserPassword: credentials.password || process.env.TEST_USER_PASSWORD,
      llmProvider,
      llmModel: project.llm_model || undefined,
      llmBaseUrl: project.llm_base_url || undefined,
      jiraUrl: project.jira_url || undefined,
      jiraProjectKey: project.jira_project_key || undefined,
    },
    timestamp: Date.now(),
    requestedBy: 'rerun',
    triggeredBy: `rerun:${id}`,
  });

  updateTestRun(run.id, { job_id: String(job.id), status: 'queued' });
  logger.info(`Re-queued run ${run.id} from ${id} as job ${job.id}`);
  return { run: getTestRun(run.id), sourceRun: source };
}

/**
 * Publish a finished Jira-sourced run's results to the ticket (comment, screenshots, label, transition).
 */
export async function publishRunToJira(
  id: number
): Promise<{ run: TestRunRow | null; error?: string }> {
  const run = getTestRun(id);
  if (!run) return { run: null, error: 'Run no encontrado' };

  if (run.source !== 'jira') {
    return { run, error: 'Solo se pueden publicar resultados de tickets Jira' };
  }
  if (!run.ticket_id) {
    return { run, error: 'La ejecución no tiene ticket' };
  }
  if (run.status !== 'completed' && run.status !== 'failed') {
    return {
      run,
      error: 'La ejecución todavía no terminó. Esperá a que complete o falle.',
    };
  }
  if (run.jira_posted_at) {
    return { run, error: 'Los resultados ya se publicaron en Jira' };
  }
  if (!run.result_json) {
    return { run, error: 'No hay resultados para publicar' };
  }

  let parsed: {
    success?: boolean;
    summary?: {
      passed?: boolean;
      total?: number;
      successful?: number;
      failed?: number;
      totalDuration?: number;
    };
    details?: string;
    screenshots?: Array<{ name?: string; path?: string }>;
    error?: string;
    stack?: string;
  };
  try {
    parsed = JSON.parse(run.result_json);
  } catch {
    return { run, error: 'Los resultados están corruptos' };
  }

  const summary = parsed.summary;
  const passed = Boolean(summary?.passed ?? parsed.success);
  const totalTests = summary?.total ?? 1;
  const passedTests = summary?.successful ?? (passed ? 1 : 0);
  const failedTests = summary?.failed ?? (passed ? 0 : 1);
  const executionTime = summary?.totalDuration ?? 0;
  const details =
    typeof parsed.details === 'string'
      ? parsed.details
      : parsed.error
        ? `Error executing automated tests:\n${parsed.error}${
            parsed.stack ? `\n\nStack trace:\n${parsed.stack}` : ''
          }`
        : 'Sin detalle';

  const screenshots: Array<{ name: string; path: string; buffer: Buffer }> = [];
  const screenshotsRoot = getScreenshotsDir();
  for (const shot of parsed.screenshots || []) {
    if (!shot.path) continue;
    const abs = path.resolve(shot.path);
    if (!isPathInside(screenshotsRoot, abs) || !fs.existsSync(abs)) continue;
    try {
      screenshots.push({
        name: shot.name || path.basename(abs),
        path: abs,
        buffer: fs.readFileSync(abs),
      });
    } catch (err) {
      logger.warn(`Skipping screenshot ${abs}:`, err);
    }
  }

  const { getJiraClient } = await import('../clients/jira-mcp-client');
  const jiraClient = await getJiraClient();

  try {
    await jiraClient.postTestResults(run.ticket_id, {
      passed,
      totalTests,
      passedTests,
      failedTests,
      screenshots,
      details,
      executionTime,
    });

    if (parsed.error && !summary) {
      await jiraClient.addLabel(run.ticket_id, 'qa-error');
    } else {
      await jiraClient.addLabel(
        run.ticket_id,
        passed ? 'qa-passed' : 'qa-failed'
      );
      try {
        await jiraClient.transitionIssue(
          run.ticket_id,
          passed ? 'QA Approved' : 'QA Failed'
        );
      } catch (transitionErr) {
        logger.warn(
          `Published results but could not transition ${run.ticket_id}:`,
          transitionErr
        );
      }
    }
  } catch (err: any) {
    logger.error(`Failed to publish run ${id} to Jira:`, err);
    return {
      run,
      error: err?.message || 'No se pudieron publicar los resultados en Jira',
    };
  }

  const updated = updateTestRun(id, {
    jira_posted_at: new Date().toISOString(),
  });
  logger.info(`Published run ${id} results to ${run.ticket_id}`);
  return { run: updated };
}

function unlinkQuiet(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn(`Failed to delete file ${filePath}:`, err);
  }
}

function removeDirIfEmpty(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

function countOtherRunsWithTicket(ticketId: string, excludeId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM test_runs
       WHERE ticket_id = ? AND id != ?`
    )
    .get(ticketId, excludeId) as { n: number };
  return row?.n ?? 0;
}

export function deleteRunArtifacts(run: TestRunRow): void {
  const screenshotsRoot = getScreenshotsDir();

  if (run.result_json) {
    try {
      const result = JSON.parse(run.result_json) as {
        screenshots?: Array<{ path?: string; name?: string }>;
      };
      for (const shot of result.screenshots || []) {
        if (shot.path && isPathInside(screenshotsRoot, shot.path)) {
          unlinkQuiet(path.resolve(shot.path));
        }
      }
    } catch {
      // ignore bad json
    }
  }

  const ticketKey = run.ticket_id;
  if (!ticketKey) return;

  const ticketDir = path.join(screenshotsRoot, ticketKey);
  if (!fs.existsSync(ticketDir)) return;

  if (countOtherRunsWithTicket(ticketKey, run.id) === 0) {
    try {
      fs.rmSync(ticketDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`Failed to remove screenshot dir ${ticketDir}:`, err);
    }
    return;
  }

  removeDirIfEmpty(ticketDir);
}

export async function removeTestRun(
  id: number
): Promise<{ ok: boolean; error?: string }> {
  const run = getTestRun(id);
  if (!run) return { ok: false, error: 'Run no encontrado' };

  if (!isTerminalStatus(run.status)) {
    await cancelTestRun(id);
  }

  const fresh = getTestRun(id);
  if (fresh) deleteRunArtifacts(fresh);
  const deleted = deleteTestRun(id);
  return deleted ? { ok: true } : { ok: false, error: 'No se pudo borrar' };
}
