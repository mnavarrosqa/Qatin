import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { testQueue } from './queue';
import { logger } from './utils/logger';
import { z } from 'zod';
import { getDb, createTestRun, updateTestRun } from './db';
import apiRouter from './routes/api';

dotenv.config();
getDb();

const app = express();
const PORT = process.env.PORT || 8545;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', apiRouter);

// Legacy endpoint: Test a Jira ticket (no project)
app.post('/api/test-ticket', async (req, res) => {
  try {
    const schema = z
      .object({
        ticketId: z.string().optional(),
        ticketUrl: z.string().url().optional(),
        projectId: z.number().optional(),
      })
      .refine((data) => data.ticketId || data.ticketUrl, {
        message: 'Either ticketId or ticketUrl must be provided',
      });

    const { ticketId, ticketUrl, projectId } = schema.parse(req.body);

    let finalTicketId = ticketId;
    if (ticketUrl && !ticketId) {
      const match = ticketUrl.match(/[A-Z][A-Z0-9]+-\d+/i);
      if (match) {
        finalTicketId = match[0].toUpperCase();
      } else {
        return res.status(400).json({ error: 'Invalid Jira URL format' });
      }
    }

    if (!finalTicketId) {
      return res.status(400).json({ error: 'Could not determine ticket ID' });
    }

    logger.info(`Received test request for ticket: ${finalTicketId}`);

    const run = createTestRun({
      project_id: projectId ?? null,
      source: 'jira',
      ticket_id: finalTicketId,
      status: 'queued',
    });

    const job = await testQueue.add('test-ticket', {
      ticketId: finalTicketId,
      projectId: projectId ?? null,
      runId: run.id,
      source: 'jira',
      timestamp: Date.now(),
      requestedBy: req.ip || 'unknown',
    });

    updateTestRun(run.id, { job_id: String(job.id) });

    res.json({
      success: true,
      jobId: job.id,
      runId: run.id,
      ticketId: finalTicketId,
      message: 'Test job queued successfully',
      status: 'Check job status at /api/job-status/:jobId',
    });
  } catch (error) {
    logger.error('Error in /api/test-ticket:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/job-status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await testQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();
    const result = job.returnvalue;

    res.json({
      jobId: job.id,
      state,
      progress,
      result,
      createdAt: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    });
  } catch (error) {
    logger.error('Error getting job status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;

    const [completed, failed, active, waiting] = await Promise.all([
      testQueue.getCompleted(0, limit),
      testQueue.getFailed(0, limit),
      testQueue.getActive(0, limit),
      testQueue.getWaiting(0, limit),
    ]);

    res.json({
      completed: completed.length,
      failed: failed.length,
      active: active.length,
      waiting: waiting.length,
      jobs: {
        completed: await Promise.all(completed.map((j) => formatJob(j))),
        failed: await Promise.all(failed.map((j) => formatJob(j))),
        active: await Promise.all(active.map((j) => formatJob(j))),
        waiting: await Promise.all(waiting.map((j) => formatJob(j))),
      },
    });
  } catch (error) {
    logger.error('Error listing jobs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function formatJob(job: any) {
  const state = await job.getState();
  return {
    id: job.id,
    data: job.data,
    state,
    progress: job.progress(),
    createdAt: job.timestamp,
    finishedOn: job.finishedOn,
  };
}

app.post('/api/webhook/jira', async (req, res) => {
  try {
    const payload = req.body;

    logger.info('Received Jira webhook:', {
      event: payload.webhookEvent,
      issueKey: payload.issue?.key,
    });

    if (payload.webhookEvent === 'jira:issue_updated') {
      const issue = payload.issue;
      const statusName = issue.fields?.status?.name;

      if (statusName === 'Ready for QA' || statusName === 'QA') {
        logger.info(`Auto-triggering test for ${issue.key} (status: ${statusName})`);

        const run = createTestRun({
          source: 'jira',
          ticket_id: issue.key,
          status: 'queued',
        });

        const job = await testQueue.add('test-ticket', {
          ticketId: issue.key,
          runId: run.id,
          source: 'jira',
          timestamp: Date.now(),
          requestedBy: 'webhook-auto',
          triggeredBy: `status_change:${statusName}`,
        });

        updateTestRun(run.id, { job_id: String(job.id) });
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Error processing Jira webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const publicDir = path.join(process.cwd(), 'public');
const screenshotsDir = path.resolve(
  process.env.SCREENSHOTS_DIR || './screenshots'
);
fs.mkdirSync(screenshotsDir, { recursive: true });
app.use('/screenshots', express.static(screenshotsDir));
app.use(express.static(publicDir));
app.get(/^(?!\/api(?:\/|$)|\/health$|\/screenshots(?:\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) {
      res.status(404).send('UI not built yet. Run npm run build:web');
    }
  });
});

app.listen(PORT, () => {
  logger.info(`QA Agent server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Jira URL: ${process.env.JIRA_URL || '(not set)'}`);

  const setupMarker = path.join(process.cwd(), 'data', '.setup-complete');
  if (!fs.existsSync(setupMarker)) {
    logger.warn(
      'Setup inicial pendiente. Corré `npm run setup` para Playwright, MCP y plugins.'
    );
  } else {
    try {
      // Soft check: Playwright browser missing → tests UI van a fallar
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { chromium } = require('playwright') as typeof import('playwright');
      const exe = chromium.executablePath();
      if (!exe || !fs.existsSync(exe)) {
        logger.warn(
          'Playwright Chromium no está instalado. Corré `npx playwright install chromium` o `npm run setup`.'
        );
      }
    } catch {
      logger.warn(
        'No se pudo verificar Playwright. Corré `npm run setup` si los tests UI fallan.'
      );
    }
  }
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  await testQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT signal received: closing HTTP server');
  await testQueue.close();
  process.exit(0);
});
