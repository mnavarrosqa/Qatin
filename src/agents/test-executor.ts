import { chromium, Browser, Page, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { TestStrategy, TestScenario } from './ticket-analyzer';
import { getRuntimePlugins, RuntimePlugins } from '../plugins';

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
  retries?: number;
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

export interface ExecutorConfig {
  baseUrl?: string;
  testUserEmail?: string | null;
  testUserPassword?: string | null;
  plugins?: RuntimePlugins;
}

export class TestExecutor {
  private browser: Browser | null = null;
  private screenshotsDir: string;
  private baseUrl: string;
  private testUserEmail: string | null;
  private testUserPassword: string | null;
  private plugins: RuntimePlugins;

  constructor(config?: ExecutorConfig) {
    this.screenshotsDir = process.env.SCREENSHOTS_DIR || './screenshots';
    this.baseUrl =
      config?.baseUrl || process.env.APP_BASE_URL || 'https://example.com';
    this.testUserEmail =
      config?.testUserEmail ?? process.env.TEST_USER_EMAIL ?? null;
    this.testUserPassword =
      config?.testUserPassword ?? process.env.TEST_USER_PASSWORD ?? null;
    this.plugins = config?.plugins ?? getRuntimePlugins();
    logger.info('TestExecutor initialized', {
      baseUrl: this.baseUrl,
      plugins: this.plugins,
    });
  }

  withConfig(config: ExecutorConfig): TestExecutor {
    return new TestExecutor({
      baseUrl: config.baseUrl ?? this.baseUrl,
      testUserEmail: config.testUserEmail ?? this.testUserEmail,
      testUserPassword: config.testUserPassword ?? this.testUserPassword,
      plugins: config.plugins ?? this.plugins,
    });
  }

  async executeTests(
    ticketId: string,
    strategy: TestStrategy
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    try {
      await this.launchBrowser();

      const ticketScreenshotsDir = path.join(this.screenshotsDir, ticketId);
      await fs.mkdir(ticketScreenshotsDir, { recursive: true });

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
      context = await this.browser!.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (QA Bot) Playwright/1.40',
        recordVideo: undefined,
      });

      page = await context.newPage();

      page.setDefaultTimeout(
        parseInt(process.env.BROWSER_TIMEOUT || '30000')
      );

      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      page.on('pageerror', (error) => {
        errors.push(`Page error: ${error.message}`);
      });

      const networkErrors: string[] = [];
      if (this.plugins.networkGuard) {
        page.on('response', (response) => {
          const status = response.status();
          if (status >= 400) {
            const url = response.url();
            // Ignore common noise (analytics, favicon)
            if (/favicon|google-analytics|googletagmanager|hotjar/i.test(url)) {
              return;
            }
            networkErrors.push(`${status} ${response.request().method()} ${url}`);
          }
        });
      }

      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        const stepStartTime = Date.now();

        try {
          logger.info(`Step ${i + 1}: ${step}`);

          const retriesUsed = await this.executeStepWithPlugins(
            page,
            step,
            scenario
          );

          const screenshotName = `${scenario.id}-step-${i + 1}.png`;
          const screenshotPath = path.join(screenshotsDir, screenshotName);

          const screenshotBuffer = await page.screenshot({
            path: screenshotPath,
            fullPage: true,
          });

          screenshots.push({
            name: screenshotName,
            path: screenshotPath,
            buffer: screenshotBuffer,
          });

          stepResults.push({
            step,
            success: true,
            duration: Date.now() - stepStartTime,
            screenshot: screenshotName,
            ...(retriesUsed > 0 ? { retries: retriesUsed } : {}),
          });

          await page.waitForTimeout(500);
        } catch (error: any) {
          logger.error(`Step failed: ${step}`, error.message);

          const errorScreenshotName = `${scenario.id}-step-${i + 1}-ERROR.png`;
          const errorScreenshotPath = path.join(
            screenshotsDir,
            errorScreenshotName
          );

          try {
            const errorBuffer = await page.screenshot({
              path: errorScreenshotPath,
              fullPage: true,
            });

            screenshots.push({
              name: errorScreenshotName,
              path: errorScreenshotPath,
              buffer: errorBuffer,
              annotations: [
                {
                  type: 'error',
                  text: error.message,
                  x: 50,
                  y: 50,
                },
              ],
            });
          } catch (screenshotError) {
            logger.error('Failed to take error screenshot:', screenshotError);
          }

          stepResults.push({
            step,
            success: false,
            duration: Date.now() - stepStartTime,
            error: error.message,
            screenshot: errorScreenshotName,
          });

          errors.push(`Step ${i + 1} failed: ${error.message}`);
        }
      }

      if (consoleErrors.length > 0) {
        errors.push(`Console errors: ${consoleErrors.join(', ')}`);
      }

      if (this.plugins.networkGuard && networkErrors.length > 0) {
        const unique = [...new Set(networkErrors)].slice(0, 10);
        errors.push(`Network errors: ${unique.join('; ')}`);
      }

      const success = stepResults.every((r) => r.success) && errors.length === 0;

      return {
        success,
        scenarioId: scenario.id,
        description: scenario.description,
        steps: stepResults,
        screenshots,
        errors,
        duration: Date.now() - startTime,
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
        duration: Date.now() - startTime,
      };
    } finally {
      if (context) {
        await context.close();
      }
    }
  }

  /** Returns number of retries used after the first attempt. */
  private async executeStepWithPlugins(
    page: Page,
    step: string,
    scenario: TestScenario
  ): Promise<number> {
    const maxExtra = this.plugins.flakyRetry
      ? this.plugins.flakyMaxRetries
      : 0;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxExtra; attempt++) {
      try {
        await this.executeStep(page, step, scenario);
        if (attempt > 0) {
          logger.info(`Step recovered after ${attempt} flaky retries`);
        }
        return attempt;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxExtra) {
          const delay = 500 * (attempt + 1);
          logger.warn(
            `Flaky retry ${attempt + 1}/${maxExtra} after ${delay}ms: ${lastError.message}`
          );
          await page.waitForTimeout(delay);
        }
      }
    }

    throw lastError || new Error('Step failed');
  }

  private async executeStep(
    page: Page,
    step: string,
    scenario: TestScenario
  ): Promise<void> {
    const stepLower = step.toLowerCase();
    const processedStep = step.replace(/\{\{BASE_URL\}\}/g, this.baseUrl);

    if (stepLower.includes('navigate') || stepLower.includes('go to')) {
      const urlMatch = processedStep.match(/(https?:\/\/[^\s]+)/);
      if (urlMatch) {
        await page.goto(urlMatch[1], { waitUntil: 'domcontentloaded' });
      }
      return;
    }

    if (stepLower.includes('click')) {
      await this.withSelectorAction(
        page,
        processedStep,
        scenario,
        async (selector) => {
          await page.click(selector);
        },
        async () => {
          const textMatch = processedStep.match(/['"]([^'"]+)['"]/);
          if (textMatch) {
            await page.click(`text=${textMatch[1]}`);
            return true;
          }
          return false;
        }
      );
      return;
    }

    if (
      stepLower.includes('fill') ||
      stepLower.includes('type') ||
      stepLower.includes('enter')
    ) {
      let valueMatch =
        processedStep.match(/with\s+['"]?([^'"]+)['"]?/i) ||
        processedStep.match(/['"]([^'"]+)['"]/);

      await this.withSelectorAction(
        page,
        processedStep,
        scenario,
        async (selector) => {
          let value = valueMatch?.[1];
          if (!value) {
            if (selector.toLowerCase().includes('email') && this.testUserEmail) {
              value = this.testUserEmail;
            } else if (
              selector.toLowerCase().includes('password') &&
              this.testUserPassword
            ) {
              value = this.testUserPassword;
            }
          }
          if (!value) {
            throw new Error('No value to fill');
          }
          await page.fill(selector, value);
        }
      );
      return;
    }

    if (stepLower.includes('wait')) {
      const timeMatch = processedStep.match(
        /(\d+)\s*(seconds?|ms|milliseconds?)/
      );
      if (timeMatch) {
        const time = parseInt(timeMatch[1]);
        const unit = timeMatch[2];
        const ms = unit.includes('second') ? time * 1000 : time;
        await page.waitForTimeout(ms);
      } else {
        await page.waitForTimeout(2000);
      }
      return;
    }

    if (
      stepLower.includes('check') ||
      stepLower.includes('verify') ||
      stepLower.includes('assert')
    ) {
      await this.withSelectorAction(
        page,
        processedStep,
        scenario,
        async (selector) => {
          await page.waitForSelector(selector, { timeout: 5000 });
        },
        async () => {
          const textMatch = processedStep.match(/['"]([^'"]+)['"]/);
          if (textMatch) {
            await page.waitForSelector(`text=${textMatch[1]}`, {
              timeout: 5000,
            });
            return true;
          }
          return false;
        }
      );
      return;
    }

    if (stepLower.includes('scroll')) {
      if (stepLower.includes('bottom')) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      } else if (stepLower.includes('top')) {
        await page.evaluate('window.scrollTo(0, 0)');
      } else {
        await page.evaluate('window.scrollBy(0, 500)');
      }
      return;
    }

    if (stepLower.includes('hover')) {
      await this.withSelectorAction(
        page,
        processedStep,
        scenario,
        async (selector) => {
          await page.hover(selector);
        }
      );
      return;
    }

    if (stepLower.includes('select')) {
      const valueMatch = processedStep.match(/['"]([^'"]+)['"]/);
      await this.withSelectorAction(
        page,
        processedStep,
        scenario,
        async (selector) => {
          if (!valueMatch) throw new Error('No select value');
          await page.selectOption(selector, valueMatch[1]);
        }
      );
      return;
    }

    logger.warn(`Unknown step action: ${step}, waiting 1s`);
    await page.waitForTimeout(1000);
  }

  private async withSelectorAction(
    page: Page,
    step: string,
    scenario: TestScenario,
    action: (selector: string) => Promise<void>,
    fallback?: () => Promise<boolean>
  ): Promise<void> {
    const candidates = this.selectorCandidates(step, scenario);
    let lastError: Error | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const selector = candidates[i];
      try {
        await action(selector);
        if (i > 0 && this.plugins.selfHeal) {
          logger.info(`Self-heal used alternate selector: ${selector}`);
        }
        return;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!this.plugins.selfHeal || i === candidates.length - 1) {
          break;
        }
        logger.warn(
          `Self-heal: selector failed (${selector}), trying next…`
        );
      }
    }

    if (fallback) {
      const ok = await fallback();
      if (ok) return;
    }

    throw lastError || new Error('No matching selector');
  }

  private selectorCandidates(step: string, scenario: TestScenario): string[] {
    const primary = this.extractSelector(step, scenario);
    const out: string[] = [];
    const push = (s: string | null | undefined) => {
      if (s && !out.includes(s)) out.push(s);
    };

    push(primary);

    if (this.plugins.selfHeal) {
      for (const s of scenario.selectors || []) {
        push(s);
      }

      const textMatch = step.match(/['"]([^'"]+)['"]/);
      if (textMatch) {
        const t = textMatch[1];
        push(`text=${t}`);
        push(`button:has-text("${t}")`);
        push(`[aria-label="${t}"]`);
      }

      const keywords = [
        'email',
        'password',
        'submit',
        'login',
        'search',
        'username',
        'name',
      ];
      for (const kw of keywords) {
        if (step.toLowerCase().includes(kw)) {
          push(`[data-testid*="${kw}"]`);
          push(`[name*="${kw}"]`);
          push(`[id*="${kw}"]`);
          if (kw === 'email' || kw === 'password') {
            push(`input[type="${kw}"]`);
          }
        }
      }
    }

    return out.length ? out : primary ? [primary] : [];
  }

  private extractSelector(step: string, scenario: TestScenario): string | null {
    const selectorMatch = step.match(/['"]([#.\[][^'"]+)['"]/);
    if (selectorMatch) {
      return selectorMatch[1];
    }

    if (scenario.selectors && scenario.selectors.length > 0) {
      for (const selector of scenario.selectors) {
        const selectorKeywords = selector.toLowerCase();
        const stepKeywords = step.toLowerCase();

        if (
          (stepKeywords.includes('email') &&
            selectorKeywords.includes('email')) ||
          (stepKeywords.includes('password') &&
            selectorKeywords.includes('password')) ||
          (stepKeywords.includes('submit') &&
            selectorKeywords.includes('submit')) ||
          (stepKeywords.includes('button') &&
            selectorKeywords.includes('button'))
        ) {
          return selector;
        }
      }

      return scenario.selectors[0];
    }

    return null;
  }

  private async launchBrowser(): Promise<void> {
    if (this.browser) return;

    const headless = process.env.HEADLESS !== 'false';

    this.browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    logger.info(`Browser launched (headless: ${headless})`);
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info('Browser closed');
    }
  }

  static getSummary(results: ExecutionResult[]): {
    passed: boolean;
    total: number;
    successful: number;
    failed: number;
    totalDuration: number;
  } {
    const total = results.length;
    const successful = results.filter((r) => r.success).length;
    const failed = total - successful;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    return {
      passed: failed === 0,
      total,
      successful,
      failed,
      totalDuration,
    };
  }
}
