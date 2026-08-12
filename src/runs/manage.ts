import fs from 'fs';
import path from 'path';
import {
  deleteTestRun,
  getDb,
  getTestRun,
  updateTestRun,
  type TestRunRow,
} from '../db';
import { testQueue } from '../queue';
import { getScreenshotsDir } from '../paths';
import { logger } from '../utils/logger';

export class RunCancelledError extends Error {
  constructor(message = 'Ejecución cancelada') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

export function isRunCancelled(runId?: number | null): boolean {
  if (!runId) return false;
  const run = getTestRun(runId);
  return Boolean(
    run && (run.status === 'cancelled' || run.phase === 'cancelled')
  );
}

export function assertRunNotCancelled(runId?: number | null): void {
  if (isRunCancelled(runId)) {
    throw new RunCancelledError();
  }
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
        if (shot.path) {
          const abs = path.resolve(shot.path);
          if (abs.startsWith(screenshotsRoot)) unlinkQuiet(abs);
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
