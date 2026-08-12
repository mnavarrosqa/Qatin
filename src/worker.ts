import { testQueue } from './queue';
import { getJiraClient } from './clients/jira-mcp-client';
import type { JiraMcpClient } from './clients/jira-mcp-client';
import {
  TicketAnalyzer,
  createSyntheticTicket,
  TestStrategy,
} from './agents/ticket-analyzer';
import { TestExecutor, ExecutionResult } from './agents/test-executor';
import { logger } from './utils/logger';
import {
  getDb,
  getRunMemory,
  formatRunMemoryContext,
  saveRunMemory,
} from './db';
import {
  progressPayload,
  type RunProgressState,
  type ScenarioProgress,
} from './runs/progress';
import {
  assertRunNotCancelled,
  finalizeTestRun,
  RunCancelledError,
} from './runs/manage';import { LlmProvider } from './llm';
import { isInstalled } from './plugins';
import dotenv from 'dotenv';
import { ENV_PATH, ensureAppDirs } from './paths';

dotenv.config({ path: ENV_PATH });
ensureAppDirs();
getDb();

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_TESTS || '3');

interface ProjectJobConfig {
  baseUrl?: string;
  stagingUrl?: string;
  testUserEmail?: string | null;
  testUserPassword?: string | null;
  llmProvider?: LlmProvider;
  llmModel?: string;
  llmBaseUrl?: string;
  jiraUrl?: string;
  jiraProjectKey?: string;
}

interface JobData {
  ticketId: string;
  projectId?: number | null;
  runId?: number;
  source?: 'jira' | 'paste';
  pastedTicket?: { summary?: string; description?: string };
  strategy?: TestStrategy;
  projectConfig?: ProjectJobConfig;
  timestamp?: number;
  requestedBy?: string;
  triggeredBy?: string;
}

/**
 * Worker process that handles test jobs
 */
async function startWorker() {
  logger.info('Starting QA worker...');
  logger.info(`Max concurrent jobs: ${MAX_CONCURRENT}`);

  testQueue.process('test-ticket', MAX_CONCURRENT, async (job) => {
    const data = job.data as JobData;
    const {
      ticketId,
      runId,
      source = 'jira',
      pastedTicket,
      projectConfig,
      projectId,
      strategy: providedStrategy,
    } = data;

    const label = ticketId || `job-${job.id}`;
    logger.info(`Processing job ${job.id} for ${label} (source=${source})`);

    const engramOn = isInstalled('engram');
    const analyzeOptions = {
      memoryContext: undefined as string | undefined,
    };

    if (runId) {
      assertRunNotCancelled(runId);
      writeRunProgress(runId, {
        phase: 'fetching',
        label: 'Leyendo ticket',
      });
    }

    try {
      job.progress(10);
      assertRunNotCancelled(runId);

      let ticket;
      let jiraClient: JiraMcpClient | null = null;

      if (source === 'paste') {
        logger.info(`[${label}] Using pasted ticket description`);
        ticket = createSyntheticTicket({
          key: ticketId || `PASTE-${job.id}`,
          summary: pastedTicket?.summary || 'Ticket pegado',
          description: pastedTicket?.description || '',
        });
      } else {
        logger.info(`[${label}] Fetching ticket from Jira...`);
        jiraClient = await getJiraClient();
        ticket = await jiraClient.getIssue(ticketId);
      }

      if (engramOn) {
        const memories = getRunMemory({
          projectId: projectId ?? null,
          ticketKey: ticket.key,
          limit: 5,
        });
        const ctx = formatRunMemoryContext(memories);
        if (ctx) {
          analyzeOptions.memoryContext = ctx;
          logger.info(`[${label}] Engram loaded ${memories.length} memories`);
        }
      }

      job.progress(30);
      assertRunNotCancelled(runId);

      let testStrategy: TestStrategy;
      if (providedStrategy?.scenarios?.length) {
        logger.info(
          `[${label}] Using provided test strategy with ${providedStrategy.scenarios.length} scenarios`
        );
        testStrategy = providedStrategy;
      } else {
        logger.info(`[${label}] Analyzing ticket...`);
        writeRunProgress(runId, {
          phase: 'analyzing',
          label: 'Preparando casos',
        });

        const analyzer = new TicketAnalyzer({
          provider: projectConfig?.llmProvider,
          model: projectConfig?.llmModel,
          baseUrl: projectConfig?.llmBaseUrl,
        });

        try {
          testStrategy = await analyzer.analyzeTicket(ticket, analyzeOptions);
        } catch (error) {
          logger.warn(`[${label}] AI analysis failed, using fallback strategy`, error);
          testStrategy = await analyzer.generateFallbackStrategy(ticket, analyzeOptions);
        }

        logger.info(
          `[${label}] Generated test strategy with ${testStrategy.scenarios.length} scenarios`
        );
      }

      job.progress(50);
      assertRunNotCancelled(runId);
      logger.info(`[${label}] Executing tests...`);

      const scenarios: ScenarioProgress[] = testStrategy.scenarios.map((s) => ({
        id: s.id,
        description: s.description,
        status: 'pending',
      }));
      writeRunProgress(runId, {
        phase: 'executing',
        label: 'Ejecutando Playwright',
        scenarios,
      });

      const testExecutor = new TestExecutor({
        baseUrl: projectConfig?.baseUrl,
        testUserEmail: projectConfig?.testUserEmail,
        testUserPassword: projectConfig?.testUserPassword,
      });

      const executionResults = await testExecutor.executeTests(
        ticket.key,
        testStrategy,
        (event) => {
          assertRunNotCancelled(runId);
          if (event.type === 'scenario_start') {
            scenarios[event.index] = {
              ...scenarios[event.index],
              status: 'running',
            };
            writeRunProgress(runId, {
              phase: 'executing',
              label: `Caso ${event.index + 1} de ${event.total}: ${event.scenario.description}`,
              scenarios: [...scenarios],
            });
          } else if (event.type === 'step') {
            writeRunProgress(runId, {
              phase: 'executing',
              label: `Caso ${event.index + 1} de ${event.total}: ${event.scenario.description}`,
              currentStep: event.step,
              stepIndex: event.stepIndex,
              stepTotal: event.stepTotal,
              scenarios: [...scenarios],
            });
          } else {
            scenarios[event.index] = {
              id: event.scenario.id,
              description: event.scenario.description,
              status: event.result.success ? 'passed' : 'failed',
              duration: event.result.duration,
              error: event.result.errors[0],
            };
            writeRunProgress(runId, {
              phase: 'executing',
              label: `Caso ${event.index + 1} de ${event.total}: ${event.scenario.description}`,
              scenarios: [...scenarios],
            });
          }
        }
      );

      job.progress(80);
      assertRunNotCancelled(runId);
      logger.info(`[${label}] Compiling results...`);
      writeRunProgress(runId, {
        phase: 'compiling',
        label: 'Compilando resultados',
        scenarios,
      });
      const summary = TestExecutor.getSummary(executionResults);
      const allScreenshots = executionResults.flatMap((r) => r.screenshots);
      const detailsReport = generateDetailedReport(
        testStrategy,
        executionResults,
        summary
      );

      if (engramOn) {
        try {
          saveEngramMemory({
            projectId: projectId ?? null,
            ticketKey: ticket.key,
            strategy: testStrategy,
            results: executionResults,
            summary,
          });
          logger.info(`[${label}] Engram saved run memory`);
        } catch (memErr) {
          logger.warn(`[${label}] Engram failed to save memory:`, memErr);
        }
      }

      if (source === 'jira' && jiraClient) {
        job.progress(90);
        logger.info(`[${label}] Posting results to Jira...`);
        writeRunProgress(runId, {
          phase: 'reporting',
          label: 'Publicando en Jira',
          scenarios,
        });

        try {
          await jiraClient.postTestResults(ticket.key, {
            passed: summary.passed,
            totalTests: summary.total,
            passedTests: summary.successful,
            failedTests: summary.failed,
            screenshots: allScreenshots,
            details: detailsReport,
            executionTime: summary.totalDuration,
          });

          await jiraClient.addLabel(
            ticket.key,
            summary.passed ? 'qa-passed' : 'qa-failed'
          );

          if (summary.passed) {
            await jiraClient.transitionIssue(ticket.key, 'QA Approved');
          } else {
            await jiraClient.transitionIssue(ticket.key, 'QA Failed');
          }
        } catch (jiraError) {
          logger.warn(`[${label}] Failed to post results to Jira:`, jiraError);
        }
      } else {
        job.progress(90);
        logger.info(`[${label}] Skipping Jira post (paste source)`);
      }

      const result = {
        success: true,
        ticketId: ticket.key,
        source,
        summary,
        details: detailsReport,
        screenshots: allScreenshots.map((s) => ({
          name: s.name,
          path: s.path,
        })),
        executionResults: executionResults.map((r) => ({
          scenarioId: r.scenarioId,
          success: r.success,
          duration: r.duration,
          errors: r.errors,
        })),
      };

      if (runId) {
        const fin = finalizeTestRun(runId, 'completed', {
          result_json: JSON.stringify(result),
          ticket_id: ticket.key,
        });
        if (fin === 'cancelled' || fin === 'missing') {
          logger.info(`[${label}] Job finished but run was cancelled/deleted`);
          return { success: false, cancelled: true };
        }
      }

      job.progress(100);
      logger.info(`[${label}] Job completed successfully`);
      return result;
    } catch (error: any) {
      if (
        error instanceof RunCancelledError ||
        error?.name === 'RunCancelledError'
      ) {
        logger.info(`[${label}] Job cancelled by user`);
        return { success: false, cancelled: true };
      }

      logger.error(`[${label}] Job failed:`, error);

      if (runId) {
        const fin = finalizeTestRun(runId, 'failed', {
          result_json: JSON.stringify({
            success: false,
            error: error.message,
            stack: error.stack,
          }),
        });
        if (fin === 'cancelled' || fin === 'missing') {
          return { success: false, cancelled: true };
        }
      }

      if (source === 'jira') {
        try {
          const jiraClient = await getJiraClient();
          await jiraClient.postTestResults(ticketId, {
            passed: false,
            totalTests: 1,
            passedTests: 0,
            failedTests: 1,
            screenshots: [],
            details: `Error executing automated tests:\n${error.message}\n\nStack trace:\n${error.stack}`,
            executionTime: 0,
          });
          await jiraClient.addLabel(ticketId, 'qa-error');
        } catch (postError) {
          logger.error(`[${label}] Failed to post error to Jira:`, postError);
        }
      }

      throw error;
    }
  });

  logger.info('Worker started and waiting for jobs...');
}

function writeRunProgress(
  runId: number | undefined,
  state: RunProgressState
): void {
  if (!runId) return;
  const result = getDb()
    .prepare(
      `UPDATE test_runs SET
         status = ?,
         phase = ?,
         progress_json = ?,
         updated_at = datetime('now')
       WHERE id = ?
         AND status NOT IN ('cancelled', 'completed', 'failed')
         AND IFNULL(phase, '') != 'cancelled'`
    )
    .run(
      state.phase === 'queued' ? 'queued' : 'active',
      state.phase,
      progressPayload(state),
      runId
    );
  if (result.changes === 0) {
    // Cancelled/deleted → stop; already terminal → ignore late progress.
    assertRunNotCancelled(runId);
  }
}

function saveEngramMemory(opts: {
  projectId: number | null;
  ticketKey: string;
  strategy: TestStrategy;
  results: ExecutionResult[];
  summary: { total: number; successful: number; failed: number; passed: boolean };
}): void {
  const { projectId, ticketKey, strategy, results, summary } = opts;
  const outcome = summary.passed
    ? 'passed'
    : summary.failed === summary.total
      ? 'failed'
      : 'mixed';

  const failedIds = results.filter((r) => !r.success).map((r) => r.scenarioId);
  const memorySummary = [
    strategy.summary,
    `${summary.successful}/${summary.total} passed`,
    failedIds.length ? `failed: ${failedIds.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const selectorNotes: string[] = [];
  for (const scenario of strategy.scenarios) {
    const result = results.find((r) => r.scenarioId === scenario.id);
    const status = result?.success ? 'ok' : 'fail';
    if (scenario.selectors?.length) {
      selectorNotes.push(
        `${scenario.id}[${status}]: ${scenario.selectors.slice(0, 5).join(', ')}`
      );
    }
  }

  saveRunMemory({
    project_id: projectId,
    ticket_key: ticketKey,
    summary: memorySummary,
    outcome,
    selectors_json: selectorNotes.length
      ? JSON.stringify(selectorNotes)
      : null,
  });
}

function generateDetailedReport(
  strategy: any,
  results: any[],
  summary: any
): string {
  let report = `TEST EXECUTION REPORT\n`;
  report += `${'='.repeat(60)}\n\n`;

  report += `Summary: ${strategy.summary}\n`;
  report += `Test Type: ${strategy.testType}\n`;
  report += `Total Scenarios: ${summary.total}\n`;
  report += `Passed: ${summary.successful}\n`;
  report += `Failed: ${summary.failed}\n`;
  report += `Total Duration: ${(summary.totalDuration / 1000).toFixed(2)}s\n`;
  report += `\n`;

  report += `SCENARIO DETAILS\n`;
  report += `${'-'.repeat(60)}\n\n`;

  for (const result of results) {
    const status = result.success ? 'PASSED' : 'FAILED';
    report += `[${result.scenarioId}] ${status}\n`;
    report += `Description: ${result.description}\n`;
    report += `Duration: ${(result.duration / 1000).toFixed(2)}s\n`;
    report += `\n`;

    report += `Steps:\n`;
    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i];
      const stepStatus = step.success ? 'OK' : 'FAIL';
      report += `  ${i + 1}. [${stepStatus}] ${step.step}\n`;
      if (step.error) {
        report += `     Error: ${step.error}\n`;
      }
      if (step.screenshot) {
        report += `     Screenshot: ${step.screenshot}\n`;
      }
    }

    if (result.errors.length > 0) {
      report += `\nErrors:\n`;
      for (const error of result.errors) {
        report += `  - ${error}\n`;
      }
    }

    report += `\n${'-'.repeat(60)}\n\n`;
  }

  return report;
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down worker...');
  await testQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down worker...');
  await testQueue.close();
  process.exit(0);
});

startWorker().catch((error) => {
  logger.error('Failed to start worker:', error);
  process.exit(1);
});
