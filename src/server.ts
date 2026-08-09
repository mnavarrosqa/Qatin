import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { testQueue } from './queue';
import { logger } from './utils/logger';
import { JiraClient } from './clients/jira-client';
import { z } from 'zod';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main endpoint: Test a Jira ticket
app.post('/api/test-ticket', async (req, res) => {
  try {
    const schema = z.object({
      ticketId: z.string().optional(),
      ticketUrl: z.string().url().optional(),
    }).refine(data => data.ticketId || data.ticketUrl, {
      message: "Either ticketId or ticketUrl must be provided"
    });

    const { ticketId, ticketUrl } = schema.parse(req.body);

    // Extract ticket ID from URL if provided
    let finalTicketId = ticketId;
    if (ticketUrl && !ticketId) {
      const match = ticketUrl.match(/[A-Z]+-\d+/);
      if (match) {
        finalTicketId = match[0];
      } else {
        return res.status(400).json({ error: 'Invalid Jira URL format' });
      }
    }

    if (!finalTicketId) {
      return res.status(400).json({ error: 'Could not determine ticket ID' });
    }

    logger.info(`Received test request for ticket: ${finalTicketId}`);

    // Enqueue the test job
    const job = await testQueue.add('test-ticket', {
      ticketId: finalTicketId,
      timestamp: Date.now(),
      requestedBy: req.ip || 'unknown'
    });

    res.json({
      success: true,
      jobId: job.id,
      ticketId: finalTicketId,
      message: 'Test job queued successfully',
      status: 'Check job status at /api/job-status/:jobId'
    });

  } catch (error) {
    logger.error('Error in /api/test-ticket:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: error.errors });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get job status
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
      failedReason: job.failedReason
    });

  } catch (error) {
    logger.error('Error getting job status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List recent jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    
    const [completed, failed, active, waiting] = await Promise.all([
      testQueue.getCompleted(0, limit),
      testQueue.getFailed(0, limit),
      testQueue.getActive(0, limit),
      testQueue.getWaiting(0, limit)
    ]);

    res.json({
      completed: completed.length,
      failed: failed.length,
      active: active.length,
      waiting: waiting.length,
      jobs: {
        completed: await Promise.all(completed.map(j => formatJob(j))),
        failed: await Promise.all(failed.map(j => formatJob(j))),
        active: await Promise.all(active.map(j => formatJob(j))),
        waiting: await Promise.all(waiting.map(j => formatJob(j)))
      }
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
    finishedOn: job.finishedOn
  };
}

// Webhook endpoint for Jira (optional - auto-trigger on status change)
app.post('/api/webhook/jira', async (req, res) => {
  try {
    const payload = req.body;

    logger.info('Received Jira webhook:', {
      event: payload.webhookEvent,
      issueKey: payload.issue?.key
    });

    // Auto-trigger testing when ticket moves to "Ready for QA"
    if (payload.webhookEvent === 'jira:issue_updated') {
      const issue = payload.issue;
      const statusName = issue.fields?.status?.name;

      if (statusName === 'Ready for QA' || statusName === 'QA') {
        logger.info(`Auto-triggering test for ${issue.key} (status: ${statusName})`);
        
        await testQueue.add('test-ticket', {
          ticketId: issue.key,
          timestamp: Date.now(),
          requestedBy: 'webhook-auto',
          triggeredBy: `status_change:${statusName}`
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Error processing Jira webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`QA Agent server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Jira URL: ${process.env.JIRA_URL}`);
});

// Graceful shutdown
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
