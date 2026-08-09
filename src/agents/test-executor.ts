import { chromium, Browser, Page, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { TestStrategy, TestScenario } from './ticket-analyzer';

export interface ExecutionResult {
  success: boolean;
  scenarioId: string;
  description: string;
  steps: StepResult[];
  screenshots: Screenshot[];
  errors: string[];
  duration: number;
}

export interface StepResult {
  step: string;
  success: boolean;
  duration: number;
  error?: string;
  screenshot?: string;
}

export interface Screenshot {
  name: string;
  path: string;
  buffer: Buffer;
  annotations?: Annotation[];
}

export interface Annotation {
  type: 'success' | 'error' | 'info';
  text: string;
  x: number;
  y: number;
}

export class TestExecutor {
  private browser: Browser | null = null;
  private screenshotsDir: string;
  private baseUrl: string;

  constructor() {
    this.screenshotsDir = process.env.SCREENSHOTS_DIR || './screenshots';
    this.baseUrl = process.env.APP_BASE_URL || 'https://example.com';
    logger.info('TestExecutor initialized');
  }

  /**
   * Execute all test scenarios
   */
  async executeTests(
    ticketId: string,
    strategy: TestStrategy
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    try {
      // Launch browser
      await this.launchBrowser();

      // Create screenshots directory for this ticket
      const ticketScreenshotsDir = path.join(this.screenshotsDir, ticketId);
      await fs.mkdir(ticketScreenshotsDir, { recursive: true });

      // Execute each scenario
      for (const scenario of strategy.scenarios) {
        logger.info(`Executing scenario: ${scenario.id}`);
        const result = await this.executeScenario(
          ticketId,
          scenario,
          ticketScreenshotsDir
        );
        results.push(result);
      }

    } catch (error: any) {
      logger.error('Error executing tests:', error);
      throw error;
    } finally {
      await this.closeBrowser();
    }

    return results;
  }

  /**
   * Execute a single test scenario
   */
  private async executeScenario(
    ticketId: string,
    scenario: TestScenario,
    screenshotsDir: string
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    const screenshots: Screenshot[] = [];
    const errors: string[] = [];

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      // Create new context for isolation
      context = await this.browser!.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (QA Bot) Playwright/1.40',
        recordVideo: undefined // Can enable if needed
      });

      page = await context.newPage();

      // Set default timeout
      page.setDefaultTimeout(
        parseInt(process.env.BROWSER_TIMEOUT || '30000')
      );

      // Listen for console errors
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      // Listen for page errors
      page.on('pageerror', (error) => {
        errors.push(`Page error: ${error.message}`);
      });

      // Execute each step
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        const stepStartTime = Date.now();

        try {
          logger.info(`Step ${i + 1}: ${step}`);

          await this.executeStep(page, step, scenario);

          // Take screenshot after each step
          const screenshotName = `${scenario.id}-step-${i + 1}.png`;
          const screenshotPath = path.join(screenshotsDir, screenshotName);
          
          const screenshotBuffer = await page.screenshot({
            path: screenshotPath,
            fullPage: true
          });

          screenshots.push({
            name: screenshotName,
            path: screenshotPath,
            buffer: screenshotBuffer
          });

          stepResults.push({
            step,
            success: true,
            duration: Date.now() - stepStartTime,
            screenshot: screenshotName
          });

          // Wait a bit for UI to stabilize
          await page.waitForTimeout(500);

        } catch (error: any) {
          logger.error(`Step failed: ${step}`, error.message);

          // Take error screenshot
          const errorScreenshotName = `${scenario.id}-step-${i + 1}-ERROR.png`;
          const errorScreenshotPath = path.join(screenshotsDir, errorScreenshotName);
          
          try {
            const errorBuffer = await page.screenshot({
              path: errorScreenshotPath,
              fullPage: true
            });

            screenshots.push({
              name: errorScreenshotName,
              path: errorScreenshotPath,
              buffer: errorBuffer,
              annotations: [{
                type: 'error',
                text: error.message,
                x: 50,
                y: 50
              }]
            });
          } catch (screenshotError) {
            logger.error('Failed to take error screenshot:', screenshotError);
          }

          stepResults.push({
            step,
            success: false,
            duration: Date.now() - stepStartTime,
            error: error.message,
            screenshot: errorScreenshotName
          });

          errors.push(`Step ${i + 1} failed: ${error.message}`);
        }
      }

      // Check for console errors
      if (consoleErrors.length > 0) {
        errors.push(`Console errors: ${consoleErrors.join(', ')}`);
      }

      const success = stepResults.every(r => r.success) && errors.length === 0;

      return {
        success,
        scenarioId: scenario.id,
        description: scenario.description,
        steps: stepResults,
        screenshots,
        errors,
        duration: Date.now() - startTime
      };

    } catch (error: any) {
      logger.error('Scenario execution failed:', error);
      errors.push(`Scenario failed: ${error.message}`);

      return {
        success: false,
        scenarioId: scenario.id,
        description: scenario.description,
        steps: stepResults,
        screenshots,
        errors,
        duration: Date.now() - startTime
      };

    } finally {
      if (context) {
        await context.close();
      }
    }
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    page: Page,
    step: string,
    scenario: TestScenario
  ): Promise<void> {
    const stepLower = step.toLowerCase();

    // Replace placeholders
    const processedStep = step.replace(/\{\{BASE_URL\}\}/g, this.baseUrl);

    // Navigate
    if (stepLower.includes('navigate') || stepLower.includes('go to')) {
      const urlMatch = processedStep.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch) {
        await page.goto(urlMatch[1], { waitUntil: 'domcontentloaded' });
      }
      return;
    }

    // Click
    if (stepLower.includes('click')) {
      const selector = this.extractSelector(processedStep, scenario);
      if (selector) {
        await page.click(selector);
      } else {
        // Try to find button by text
        const textMatch = processedStep.match(/['"]([^'"]+)['"]/);
        if (textMatch) {
          await page.click(`text=${textMatch[1]}`);
        }
      }
      return;
    }

    // Fill / Type
    if (stepLower.includes('fill') || stepLower.includes('type') || stepLower.includes('enter')) {
      const selector = this.extractSelector(processedStep, scenario);
      const valueMatch = processedStep.match(/with\s+['"]?([^'"]+)['"]?/i) ||
                        processedStep.match(/['"]([^'"]+)['"]/);
      
      if (selector && valueMatch) {
        await page.fill(selector, valueMatch[1]);
      }
      return;
    }

    // Wait
    if (stepLower.includes('wait')) {
      const timeMatch = processedStep.match(/(\d+)\s*(seconds?|ms|milliseconds?)/);
      if (timeMatch) {
        const time = parseInt(timeMatch[1]);
        const unit = timeMatch[2];
        const ms = unit.includes('second') ? time * 1000 : time;
        await page.waitForTimeout(ms);
      } else {
        await page.waitForTimeout(2000); // Default 2s
      }
      return;
    }

    // Check / Verify
    if (stepLower.includes('check') || stepLower.includes('verify') || stepLower.includes('assert')) {
      const selector = this.extractSelector(processedStep, scenario);
      if (selector) {
        await page.waitForSelector(selector, { timeout: 5000 });
      } else {
        // Try to verify text
        const textMatch = processedStep.match(/['"]([^'"]+)['"]/);
        if (textMatch) {
          await page.waitForSelector(`text=${textMatch[1]}`, { timeout: 5000 });
        }
      }
      return;
    }

    // Scroll
    if (stepLower.includes('scroll')) {
      if (stepLower.includes('bottom')) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else if (stepLower.includes('top')) {
        await page.evaluate(() => window.scrollTo(0, 0));
      } else {
        await page.evaluate(() => window.scrollBy(0, 500));
      }
      return;
    }

    // Hover
    if (stepLower.includes('hover')) {
      const selector = this.extractSelector(processedStep, scenario);
      if (selector) {
        await page.hover(selector);
      }
      return;
    }

    // Select
    if (stepLower.includes('select')) {
      const selector = this.extractSelector(processedStep, scenario);
      const valueMatch = processedStep.match(/['"]([^'"]+)['"]/);
      if (selector && valueMatch) {
        await page.selectOption(selector, valueMatch[1]);
      }
      return;
    }

    // Generic: just wait a bit
    logger.warn(`Unknown step action: ${step}, waiting 1s`);
    await page.waitForTimeout(1000);
  }

  /**
   * Extract CSS selector from step text or scenario
   */
  private extractSelector(step: string, scenario: TestScenario): string | null {
    // Try to extract selector from step text
    const selectorMatch = step.match(/['"]([#.\[][^'"]+)['"]/);
    if (selectorMatch) {
      return selectorMatch[1];
    }

    // Check if scenario has selectors
    if (scenario.selectors && scenario.selectors.length > 0) {
      // Try to match keywords with selectors
      for (const selector of scenario.selectors) {
        const selectorKeywords = selector.toLowerCase();
        const stepKeywords = step.toLowerCase();
        
        if (
          (stepKeywords.includes('email') && selectorKeywords.includes('email')) ||
          (stepKeywords.includes('password') && selectorKeywords.includes('password')) ||
          (stepKeywords.includes('submit') && selectorKeywords.includes('submit')) ||
          (stepKeywords.includes('button') && selectorKeywords.includes('button'))
        ) {
          return selector;
        }
      }
      
      // Return first selector as fallback
      return scenario.selectors[0];
    }

    return null;
  }

  /**
   * Launch browser
   */
  private async launchBrowser(): Promise<void> {
    if (this.browser) return;

    const headless = process.env.HEADLESS !== 'false';

    this.browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    logger.info(`Browser launched (headless: ${headless})`);
  }

  /**
   * Close browser
   */
  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Browser closed');
    }
  }

  /**
   * Get summary of execution results
   */
  static getSummary(results: ExecutionResult[]): {
    passed: boolean;
    total: number;
    successful: number;
    failed: number;
    totalDuration: number;
  } {
    const total = results.length;
    const successful = results.filter(r => r.success).length;
    const failed = total - successful;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    return {
      passed: failed === 0,
      total,
      successful,
      failed,
      totalDuration
    };
  }
}
