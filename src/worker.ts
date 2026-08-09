import { testQueue } from './queue';
import { JiraClient } from './clients/jira-client';
import { TicketAnalyzer } from './agents/ticket-analyzer';
import { TestExecutor } from './agents/test-executor';
import { logger } from './utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_TESTS || '3');

/**
 * Worker process that handles test jobs
 */
async function startWorker() {
  logger.info('Starting QA worker...');
  logger.info(`Max concurrent jobs: ${MAX_CONCURRENT}`);

  const jiraClient = new JiraClient();
  const ticketAnalyzer = new TicketAnalyzer();
  const testExecutor = new TestExecutor();

  // Process jobs from the queue
  testQueue.process('test-ticket', MAX_CONCURRENT, async (job) => {
    const { ticketId } = job.data;
    
    logger.info(`Processing job ${job.id} for ticket ${ticketId}`);

    try {
      // Step 1: Fetch ticket from Jira
      job.progress(10);
      logger.info(`[${ticketId}] Fetching ticket from Jira...`);
      const ticket = await jiraClient.getIssue(ticketId);

      // Step 2: Analyze ticket and generate test strategy
      job.progress(30);
      logger.info(`[${ticketId}] Analyzing ticket...`);
      let testStrategy;
      
      try {
        testStrategy = await ticketAnalyzer.analyzeTicket(ticket);
      } catch (error) {
        logger.warn(`[${ticketId}] AI analysis failed, using fallback strategy`, error);
        testStrategy = await ticketAnalyzer.generateFallbackStrategy(ticket);
      }

      logger.info(`[${ticketId}] Generated test strategy with ${testStrategy.scenarios.length} scenarios`);

      // Step 3: Execute tests
      job.progress(50);
      logger.info(`[${ticketId}] Executing tests...`);
      const executionResults = await testExecutor.executeTests(
        ticketId,
        testStrategy
      );

      // Step 4: Compile results
      job.progress(80);
      logger.info(`[${ticketId}] Compiling results...`);
      const summary = TestExecutor.getSummary(executionResults);

      // Collect all screenshots
      const allScreenshots = executionResults.flatMap(r => r.screenshots);

      // Generate detailed report
      const detailsReport = generateDetailedReport(
        testStrategy,
        executionResults,
        summary
      );

      // Step 5: Post results to Jira
      job.progress(90);
      logger.info(`[${ticketId}] Posting results to Jira...`);
      
      await jiraClient.postTestResults(ticketId, {
        passed: summary.passed,
        totalTests: summary.total,
        passedTests: summary.successful,
        failedTests: summary.failed,
        screenshots: allScreenshots,
        details: detailsReport,
        executionTime: summary.totalDuration
      });

      // Add label
      await jiraClient.addLabel(ticketId, summary.passed ? 'qa-passed' : 'qa-failed');

      // Optionally transition issue
      if (summary.passed) {
        await jiraClient.transitionIssue(ticketId, 'QA Approved');
      } else {
        await jiraClient.transitionIssue(ticketId, 'QA Failed');
      }

      job.progress(100);
      logger.info(`[${ticketId}] Job completed successfully`);

      return {
        success: true,
        ticketId,
        summary,
        executionResults: executionResults.map(r => ({
          scenarioId: r.scenarioId,
          success: r.success,
          duration: r.duration,
          errors: r.errors
        }))
      };

    } catch (error: any) {
      logger.error(`[${ticketId}] Job failed:`, error);

      // Try to post error to Jira
      try {
        await jiraClient.postTestResults(ticketId, {
          passed: false,
          totalTests: 1,
          passedTests: 0,
          failedTests: 1,
          screenshots: [],
          details: `Error executing automated tests:\n${error.message}\n\nStack trace:\n${error.stack}`,
          executionTime: 0
        });

        await jiraClient.addLabel(ticketId, 'qa-error');
      } catch (postError) {
        logger.error(`[${ticketId}] Failed to post error to Jira:`, postError);
      }

      throw error;
    }
  });

  logger.info('Worker started and waiting for jobs...');
}

/**
 * Generate detailed test report
 */
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
    const status = result.success ? '✅ PASSED' : '❌ FAILED';
    report += `[${result.scenarioId}] ${status}\n`;
    report += `Description: ${result.description}\n`;
    report += `Duration: ${(result.duration / 1000).toFixed(2)}s\n`;
    report += `\n`;

    report += `Steps:\n`;
    for (let i = 0; i < result.steps.length; i++) {
      const step = result.steps[i];
      const stepStatus = step.success ? '✓' : '✗';
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

// Handle shutdown gracefully
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

// Start the worker
startWorker().catch((error) => {
  logger.error('Failed to start worker:', error);
  process.exit(1);
});
