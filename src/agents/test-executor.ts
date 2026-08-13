import { chromium, Browser, Page, BrowserContext, request as playwrightRequest } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { TestStrategy, TestScenario, looksLikeApiCase } from './ticket-analyzer';
import { getRuntimePlugins, RuntimePlugins } from '../plugins';
import { getScreenshotsDir } from '../paths';
import {
  apiAuthHeaders,
  classifyApiStep,
  expectedStatusFromScenario,
  parseApiEndpoint,
  payloadFromSteps,
  resolveApiBaseUrl,
  resolveApiBearerToken,
  resolvePathTemplates,
} from './api-case-steps';

export interface ExecutionResult {
  success: boolean;
  scenarioId: string;
  description: string;
  steps: StepResult[];
  screenshots: Screenshot[];
  errors: string[];
  /** Non-fatal noise (e.g. console.error) — does not fail the scenario alone. */
  warnings: string[];
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
  apiToken?: string | null;
  plugins?: RuntimePlugins;
}

export type ExecutorProgressEvent =
  | {
      type: 'scenario_start';
      index: number;
      total: number;
      scenario: TestScenario;
    }
  | {
      type: 'step_start';
      index: number;
      total: number;
      scenario: TestScenario;
      step: string;
      stepIndex: number;
      stepTotal: number;
    }
  | {
      type: 'step_end';
      index: number;
      total: number;
      scenario: TestScenario;
      step: string;
      stepIndex: number;
      stepTotal: number;
      success: boolean;
      duration: number;
      error?: string;
      screenshot?: string;
    }
  | {
      type: 'scenario_end';
      index: number;
      total: number;
      scenario: TestScenario;
      result: ExecutionResult;
    };

export type ExecutorProgressHandler = (event: ExecutorProgressEvent) => void;

export class TestExecutor {
  private browser: Browser | null = null;
  private screenshotsDir: string;
  private baseUrl: string;
  private testUserEmail: string | null;
  private testUserPassword: string | null;
  private apiToken: string | null;
  /** Cookie/localStorage session from UI login, reused by API request context. */
  private apiStorageState: Awaited<
    ReturnType<BrowserContext['storageState']>
  > | null = null;
  private plugins: RuntimePlugins;
  /** Deep link to restore after login when navigate was redirected to /login. */
  private pendingPostLoginUrl: string | null = null;

  constructor(config?: ExecutorConfig) {
    this.screenshotsDir = getScreenshotsDir();
    this.baseUrl =
      config?.baseUrl || process.env.APP_BASE_URL || 'https://example.com';
    this.testUserEmail =
      config?.testUserEmail ?? process.env.TEST_USER_EMAIL ?? null;
    this.testUserPassword =
      config?.testUserPassword ?? process.env.TEST_USER_PASSWORD ?? null;
    this.apiToken =
      config?.apiToken ??
      process.env.API_TOKEN ??
      process.env.TEST_API_TOKEN ??
      process.env.API_BEARER_TOKEN ??
      null;
    // So generated specs / helpers that read process.env see project creds.
    if (this.testUserEmail) process.env.TEST_USER_EMAIL = this.testUserEmail;
    if (this.testUserPassword) {
      process.env.TEST_USER_PASSWORD = this.testUserPassword;
    }
    this.plugins = config?.plugins ?? getRuntimePlugins();
    logger.info('TestExecutor initialized', {
      baseUrl: this.baseUrl,
      hasQaCredentials: Boolean(this.testUserEmail && this.testUserPassword),
      hasApiToken: Boolean(this.apiToken),
      plugins: this.plugins,
    });
  }

  withConfig(config: ExecutorConfig): TestExecutor {
    return new TestExecutor({
      baseUrl: config.baseUrl ?? this.baseUrl,
      testUserEmail: config.testUserEmail ?? this.testUserEmail,
      testUserPassword: config.testUserPassword ?? this.testUserPassword,
      apiToken: config.apiToken ?? this.apiToken,
      plugins: config.plugins ?? this.plugins,
    });
  }

  async executeTests(
    ticketId: string,
    strategy: TestStrategy,
    onProgress?: ExecutorProgressHandler
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const needsBrowser = strategy.scenarios.some((s) => !looksLikeApiCase(s));

    try {
      if (needsBrowser) {
        await this.launchBrowser();
      }

      const ticketScreenshotsDir = path.join(this.screenshotsDir, ticketId);
      await fs.mkdir(ticketScreenshotsDir, { recursive: true });

      const total = strategy.scenarios.length;
      for (let index = 0; index < total; index++) {
        const scenario = strategy.scenarios[index];
        logger.info(`Executing scenario: ${scenario.id}`);
        onProgress?.({ type: 'scenario_start', index, total, scenario });
        const result = looksLikeApiCase(scenario)
          ? await this.executeApiScenario(ticketId, scenario, {
              onStart: (step, stepIndex, stepTotal) => {
                onProgress?.({
                  type: 'step_start',
                  index,
                  total,
                  scenario,
                  step,
                  stepIndex,
                  stepTotal,
                });
              },
              onEnd: (stepResult, stepIndex, stepTotal) => {
                onProgress?.({
                  type: 'step_end',
                  index,
                  total,
                  scenario,
                  step: stepResult.step,
                  stepIndex,
                  stepTotal,
                  success: stepResult.success,
                  duration: stepResult.duration,
                  error: stepResult.error,
                  screenshot: stepResult.screenshot,
                });
              },
            })
          : await this.executeScenario(
              ticketId,
              scenario,
              ticketScreenshotsDir,
              {
                onStart: (step, stepIndex, stepTotal) => {
                  onProgress?.({
                    type: 'step_start',
                    index,
                    total,
                    scenario,
                    step,
                    stepIndex,
                    stepTotal,
                  });
                },
                onEnd: (stepResult, stepIndex, stepTotal) => {
                  onProgress?.({
                    type: 'step_end',
                    index,
                    total,
                    scenario,
                    step: stepResult.step,
                    stepIndex,
                    stepTotal,
                    success: stepResult.success,
                    duration: stepResult.duration,
                    error: stepResult.error,
                    screenshot: stepResult.screenshot,
                  });
                },
              }
            );
        results.push(result);
        onProgress?.({ type: 'scenario_end', index, total, scenario, result });
      }
    } catch (error: any) {
      logger.error('Error executing tests:', error);
      throw error;
    } finally {
      await this.closeBrowser();
    }

    return results;
  }

  private async executeApiScenario(
    ticketId: string,
    scenario: TestScenario,
    onStep?: {
      onStart?: (step: string, stepIndex: number, stepTotal: number) => void;
      onEnd?: (
        result: StepResult,
        stepIndex: number,
        stepTotal: number
      ) => void;
    }
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    const errors: string[] = [];
    const apiBase = resolveApiBaseUrl(this.baseUrl);
    const buildHeaders = () => ({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...apiAuthHeaders(this.apiToken),
    });

    const obtainAuthViaUiLogin = async () => {
      if (!this.testUserEmail || !this.testUserPassword) return false;
      await this.launchBrowser();
      const bctx = await this.browser!.newContext();
      const page = await bctx.newPage();
      try {
        await this.performLogin(page);
        const token = await page.evaluate(() => {
          // Runs in browser; avoid DOM lib types in Node tsc.
          const g = globalThis as unknown as {
            localStorage: {
              getItem: (k: string) => string | null;
              key: (i: number) => string | null;
              length: number;
            };
            sessionStorage: {
              getItem: (k: string) => string | null;
              key: (i: number) => string | null;
              length: number;
            };
          };
          const pick = (store: typeof g.localStorage) => {
            const preferred = [
              'token',
              'access_token',
              'accessToken',
              'authToken',
              'jwt',
              'id_token',
            ];
            for (const k of preferred) {
              const v = store.getItem(k);
              if (v && v.length > 8) return v;
            }
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (!key || !/token|jwt|auth/i.test(key)) continue;
              const v = store.getItem(key);
              if (v && v.length > 20) return v;
            }
            return null;
          };
          return pick(g.localStorage) || pick(g.sessionStorage);
        });
        if (token) {
          this.apiToken = token;
          process.env.API_TOKEN = token;
          logger.info('API auth: bearer from UI login storage', {
            ticketId,
            scenarioId: scenario.id,
          });
          return true;
        }
        this.apiStorageState = await bctx.storageState();
        logger.info('API auth: using UI login cookies/storageState', {
          ticketId,
          scenarioId: scenario.id,
          cookieCount: this.apiStorageState.cookies?.length || 0,
        });
        return true;
      } finally {
        await bctx.close();
      }
    };

    const ensureApiAuth = async (reason: string) => {
      if (this.apiToken || this.apiStorageState) return;
      const obtained = await resolveApiBearerToken({
        apiBase,
        email: this.testUserEmail,
        password: this.testUserPassword,
        request: playwrightRequest,
      });
      if (obtained) {
        this.apiToken = obtained;
        process.env.API_TOKEN = obtained;
        logger.info(`API auth (${reason}): bearer token ready`, {
          ticketId,
          scenarioId: scenario.id,
        });
        return;
      }
      if (await obtainAuthViaUiLogin()) return;
      if (!this.testUserEmail || !this.testUserPassword) {
        throw new Error(
          'Autenticación API: faltan credenciales QA del proyecto (Proyectos → mail/password de test) o API_TOKEN'
        );
      }
      throw new Error(
        'Autenticación API: no se pudo obtener sesión con el usuario QA del proyecto (login API/UI).'
      );
    };

    await ensureApiAuth('preflight').catch((err) => {
      // Soft preflight: auth step (if present) will fail hard; otherwise send may 401.
      logger.warn(String(err?.message || err), {
        ticketId,
        scenarioId: scenario.id,
      });
    });

    let context = await playwrightRequest.newContext({
      baseURL: apiBase,
      extraHTTPHeaders: buildHeaders(),
      ...(this.apiStorageState ? { storageState: this.apiStorageState } : {}),
    });

    let payload: Record<string, unknown> = payloadFromSteps(scenario.steps || []);
    let lastStatus: number | undefined;
    let lastBody: unknown;

    try {
      const steps = scenario.steps || [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepStart = Date.now();
        onStep?.onStart?.(step, i, steps.length);
        try {
          const kind = classifyApiStep(step);
          const ep = parseApiEndpoint(scenario, step);
          if (kind === 'auth') {
            await ensureApiAuth('step');
            await context.dispose();
            context = await playwrightRequest.newContext({
              baseURL: apiBase,
              extraHTTPHeaders: buildHeaders(),
              ...(this.apiStorageState
                ? { storageState: this.apiStorageState }
                : {}),
            });
          } else if (kind === 'pending_discovery') {
            throw new Error(
              `Caso bloqueado (sin inventar): ${step}. Confirmá METHOD/path/params en Network/Swagger y actualizá el caso.`
            );
          } else if (kind === 'prepare_payload') {
            payload = { ...payload, ...payloadFromSteps([step]) };
          } else if (kind === 'send') {
            const method = ep.method;
            const rawPath =
              ep.path === '/' ? parseApiEndpoint(scenario).path : ep.path;
            const pathName = resolvePathTemplates(rawPath);
            const res =
              method === 'GET'
                ? await context.get(pathName)
                : method === 'DELETE'
                  ? await context.delete(pathName)
                  : method === 'PUT'
                    ? await context.put(pathName, { data: payload })
                    : method === 'PATCH'
                      ? await context.patch(pathName, { data: payload })
                      : await context.post(pathName, { data: payload });
            lastStatus = res.status();
            lastBody = await res.json().catch(async () => res.text());
            logger.info(`API ${method} ${apiBase}${pathName} → ${lastStatus}`, {
              ticketId,
              scenarioId: scenario.id,
            });
          } else if (kind === 'assert_status') {
            const expected = expectedStatusFromScenario({
              steps: [step],
              expectedResults: scenario.expectedResults,
            });
            if (lastStatus === undefined) {
              throw new Error('No hubo response para assert de status');
            }
            if (lastStatus !== expected) {
              throw new Error(
                `Status HTTP esperado ${expected}, recibido ${lastStatus}. Body: ${JSON.stringify(lastBody).slice(0, 400)}`
              );
            }
          } else {
            // assert_body / other — soft check on quoted token or that we got a response
            const quoted = step.match(/['"]([^'"]+)['"]/)?.[1];
            if (lastStatus === undefined) {
              throw new Error(`Paso API sin request previo: ${step}`);
            }
            if (quoted) {
              const blob = JSON.stringify(lastBody ?? '');
              if (!blob.includes(quoted)) {
                throw new Error(
                  `Body no contiene '${quoted}'. Status=${lastStatus}. Body: ${blob.slice(0, 400)}`
                );
              }
            } else if (lastStatus >= 500) {
              throw new Error(
                `Status ${lastStatus} (server error). Body: ${JSON.stringify(lastBody).slice(0, 400)}`
              );
            }
          }

          const stepResult: StepResult = {
            step,
            success: true,
            duration: Date.now() - stepStart,
          };
          stepResults.push(stepResult);
          onStep?.onEnd?.(stepResult, i, steps.length);
        } catch (error: any) {
          const errorMessage = TestExecutor.formatErrorMessage(error);
          const stepResult: StepResult = {
            step,
            success: false,
            duration: Date.now() - stepStart,
            error: errorMessage,
          };
          stepResults.push(stepResult);
          errors.push(errorMessage);
          onStep?.onEnd?.(stepResult, i, steps.length);
          break;
        }
      }
    } finally {
      await context.dispose();
    }

    return {
      success: errors.length === 0 && stepResults.every((s) => s.success),
      scenarioId: scenario.id,
      description: scenario.description,
      steps: stepResults,
      screenshots: [],
      errors,
      warnings: [],
      duration: Date.now() - startTime,
    };
  }

  private async executeScenario(
    ticketId: string,
    scenario: TestScenario,
    screenshotsDir: string,
    onStep?: {
      onStart?: (step: string, stepIndex: number, stepTotal: number) => void;
      onEnd?: (
        result: StepResult,
        stepIndex: number,
        stepTotal: number
      ) => void;
    }
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    const screenshots: Screenshot[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const pageErrors: string[] = [];

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      this.pendingPostLoginUrl = null;
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
        pageErrors.push(`Page error: ${error.message}`);
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
        const stepTotal = scenario.steps.length;
        onStep?.onStart?.(step, i, stepTotal);

        try {
          logger.info(`Step ${i + 1}: ${step}`);

          const retriesUsed = await this.executeStepWithPlugins(
            page,
            step,
            scenario
          );

          const stepResult: StepResult = {
            step,
            success: true,
            duration: Date.now() - stepStartTime,
            ...(retriesUsed > 0 ? { retries: retriesUsed } : {}),
          };

          if (!TestExecutor.isWaitOnlyStep(step)) {
            const screenshotName = `${scenario.id}-step-${i + 1}.png`;
            const screenshotPath = path.join(screenshotsDir, screenshotName);
            const screenshotBuffer = await page.screenshot({
              path: screenshotPath,
              fullPage: false,
            });
            screenshots.push({
              name: screenshotName,
              path: screenshotPath,
              buffer: screenshotBuffer,
            });
            stepResult.screenshot = screenshotName;
          }

          stepResults.push(stepResult);
          onStep?.onEnd?.(stepResult, i, stepTotal);
        } catch (error: any) {
          const errorMessage = TestExecutor.formatErrorMessage(error);
          logger.error(`Step failed: ${step}`, errorMessage);

          const errorScreenshotName = `${scenario.id}-step-${i + 1}-ERROR.png`;
          const errorScreenshotPath = path.join(
            screenshotsDir,
            errorScreenshotName
          );

          try {
            await this.injectErrorBanner(page, errorMessage);
            const errorBuffer = await page.screenshot({
              path: errorScreenshotPath,
              fullPage: true,
            });
            await this.removeErrorBanner(page);

            screenshots.push({
              name: errorScreenshotName,
              path: errorScreenshotPath,
              buffer: errorBuffer,
              annotations: [
                {
                  type: 'error',
                  text: errorMessage,
                  x: 50,
                  y: 50,
                },
              ],
            });
          } catch (screenshotError) {
            logger.error('Failed to take error screenshot:', screenshotError);
            try {
              await this.removeErrorBanner(page);
            } catch {
              /* page may already be gone */
            }
          }

          const stepResult: StepResult = {
            step,
            success: false,
            duration: Date.now() - stepStartTime,
            error: errorMessage,
            screenshot: errorScreenshotName,
          };
          stepResults.push(stepResult);
          onStep?.onEnd?.(stepResult, i, stepTotal);

          errors.push(`Step ${i + 1} failed: ${errorMessage}`);
          break; // fail-fast: stop remaining steps in this scenario
        }
      }

      if (consoleErrors.length > 0) {
        const unique = [...new Set(consoleErrors)].slice(0, 10);
        warnings.push(`Console errors: ${unique.join('; ')}`);
      }

      if (pageErrors.length > 0) {
        errors.push(...pageErrors);
      }

      if (this.plugins.networkGuard && networkErrors.length > 0) {
        const unique = [...new Set(networkErrors)].slice(0, 10);
        errors.push(`Network errors: ${unique.join('; ')}`);
      }

      const stepsOk = stepResults.every((r) => r.success);
      const success =
        stepsOk &&
        pageErrors.length === 0 &&
        !(this.plugins.networkGuard && networkErrors.length > 0);

      return {
        success,
        scenarioId: scenario.id,
        description: scenario.description,
        steps: stepResults,
        screenshots,
        errors,
        warnings,
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      logger.error('Scenario execution failed:', error);
      errors.push(`Scenario failed: ${TestExecutor.formatErrorMessage(error)}`);

      return {
        success: false,
        scenarioId: scenario.id,
        description: scenario.description,
        steps: stepResults,
        screenshots,
        errors,
        warnings,
        duration: Date.now() - startTime,
      };
    } finally {
      if (context) {
        await context.close();
      }
    }
  }

  /** True when the step only waits (no UI change worth capturing). */
  static isWaitOnlyStep(step: string): boolean {
    const lower = step.toLowerCase().trim();
    return (
      /^(esperar|wait)\b/.test(lower) ||
      /^aguardar\b/.test(lower) ||
      /\besperar\s+\d+\s*(segundos?|seconds?|ms|milisegundos?)/i.test(lower)
    );
  }

  static formatErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error);
  }

  private async injectErrorBanner(page: Page, message: string): Promise<void> {
    const text = message.slice(0, 280);
    await page.evaluate((msg) => {
      // Runs in the browser; avoid Node TS needing DOM libs.
      const g = globalThis as any;
      const doc = g.document;
      if (!doc) return;
      const id = '__qatin_error_banner__';
      doc.getElementById(id)?.remove();
      const el = doc.createElement('div');
      el.id = id;
      el.setAttribute('data-qatin-error-banner', '1');
      el.textContent = msg;
      Object.assign(el.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: '2147483647',
        padding: '12px 16px',
        background: 'rgba(180, 35, 24, 0.92)',
        color: '#fff',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '14px',
        lineHeight: '1.35',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        pointerEvents: 'none',
      });
      doc.documentElement.appendChild(el);
    }, text);
  }

  private async removeErrorBanner(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        const doc = (globalThis as any).document;
        doc?.getElementById('__qatin_error_banner__')?.remove();
      })
      .catch(() => undefined);
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

    // Prefer navigate/click before login so "go to /login" / "click Login" work.
    if (this.isNavigateStep(stepLower, processedStep)) {
      const url = this.resolveNavigationUrl(processedStep);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page
        .waitForLoadState('networkidle', { timeout: 5000 })
        .catch(() => undefined);
      // Auth wall: remember the intended deep link so login can restore it.
      if (this.isLoginUrl(page.url()) && !this.isLoginUrl(url)) {
        this.pendingPostLoginUrl = url;
      }
      return;
    }

    if (
      /\bclick\b|\bclic\b|\bpulsar\b|\bpresionar\b|\bconfirmar\b|\bguardar\b|\benviar\b/.test(
        stepLower
      )
    ) {
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
          // Vague "Confirmar la acción principal" → try primary submit.
          if (/\bconfirmar\b|\bguardar\b|\benviar\b/.test(stepLower)) {
            const submit = page
              .locator(
                'button[type="submit"], input[type="submit"], button:has-text("Guardar"), button:has-text("Confirmar"), button:has-text("Enviar"), button:has-text("Crear")'
              )
              .first();
            if (await submit.isVisible().catch(() => false)) {
              await submit.click();
              return true;
            }
          }
          return false;
        }
      );
      return;
    }

    if (this.isLoginStep(stepLower)) {
      await this.performLogin(page);
      return;
    }

    if (this.isFillStep(stepLower, processedStep)) {
      const valueMatch =
        processedStep.match(/(?:with|con)\s+['"]([^'"]+)['"]/i) ||
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
            throw new Error(
              "No value to fill: el paso debe incluir el valor entre comillas (ej. Completar el campo 'Cliente' con 'ACME')"
            );
          }
          await page.fill(selector, value);
        }
      );
      return;
    }

    if (/\besperar\b|\bwait\b/.test(stepLower)) {
      const timeMatch = processedStep.match(
        /(\d+)\s*(seconds?|segundos?|ms|milliseconds?|milisegundos?)/i
      );
      if (timeMatch) {
        const time = parseInt(timeMatch[1]);
        const unit = timeMatch[2].toLowerCase();
        const ms =
          unit.startsWith('seg') || unit.startsWith('second')
            ? time * 1000
            : time;
        await page.waitForTimeout(ms);
      } else {
        await page.waitForTimeout(2000);
      }
      return;
    }

    if (
      /\bverificar\b|\bcomprobar\b|\bvalidar\b|\basegurar\b|\bcheck\b|\bverify\b|\bassert\b/.test(
        stepLower
      )
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
          // No selector/text — at least confirm we left about:blank.
          if (page.url() === 'about:blank') {
            throw new Error('La página no cargó (sigue en about:blank)');
          }
          await page.waitForLoadState('domcontentloaded');
          return true;
        }
      );
      return;
    }

    if (/\bscroll\b|\bdesplaz/.test(stepLower)) {
      if (/bottom|abajo|final/.test(stepLower)) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      } else if (/top|arriba|inicio/.test(stepLower)) {
        await page.evaluate('window.scrollTo(0, 0)');
      } else {
        await page.evaluate('window.scrollBy(0, 500)');
      }
      return;
    }

    if (/\bhover\b|\bpasar\s+(el\s+)?mouse\b|\bencima\b/.test(stepLower)) {
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

    if (/\bselect\b|\bseleccion/.test(stepLower)) {
      const valueMatch = processedStep.match(/['"]([^'"]+)['"]/);
      await this.withSelectorAction(
        page,
        processedStep,
        scenario,
        async (selector) => {
          if (!valueMatch) {
            throw new Error(
              "No select value: el paso debe incluir la opción entre comillas (ej. Seleccionar 'Agroinsumos')"
            );
          }
          await page.selectOption(selector, valueMatch[1]);
        },
        async () => {
          // Non-<select> UIs: click the option text if quoted.
          if (!valueMatch) return false;
          await page.click(`text=${valueMatch[1]}`);
          return true;
        }
      );
      return;
    }

    throw new Error(`Acción de paso no reconocida: ${step}`);
  }

  private isNavigateStep(stepLower: string, processedStep: string): boolean {
    if (
      /\bnavegar\b|\bir\s+a\b|\bvisitar\b|\bnavigate\b|\bgo\s+to\b|\bingresar\s+a\b|\bentrar\s+(a|en)\b/.test(
        stepLower
      )
    ) {
      return true;
    }
    // "abrir/open" only when it looks like navigation (URL/path/page), not "abrir el menú".
    if (/\babrir\b|\bopen\b/.test(stepLower)) {
      return /(https?:\/\/|\/[A-Za-z0-9]|p[aá]gina|url|sitio|app|aplicaci[oó]n|\bpage\b|\bsite\b)/i.test(
        processedStep
      );
    }
    return false;
  }

  private isLoginStep(stepLower: string): boolean {
    if (/iniciar\s+sesi[oó]n|\blog\s*in\b|\bsign\s*in\b|\bautentic/.test(stepLower)) {
      return true;
    }
    // Bare "login" as the action (not a button label after click/navigate).
    return /^(hacer\s+)?login\b/.test(stepLower.trim());
  }

  private isFillStep(stepLower: string, processedStep: string): boolean {
    if (
      /\bcompletar\b|\brellenar\b|\bescribir\b|\btipear\b|\bfill\b|\btype\b/.test(
        stepLower
      )
    ) {
      return true;
    }
    // "ingresar el email" / "ingresar 'x'" — not "ingresar a /dashboard".
    if (/\bingresar\b(?!\s+a\b)/.test(stepLower)) return true;
    // "enter 'value'" / "enter with 'value'" — not bare "press Enter".
    if (/\benter\s+['"]/.test(stepLower)) return true;
    if (/\benter\b/.test(stepLower) && /(?:with|con)\s+['"]/i.test(processedStep)) {
      return true;
    }
    return false;
  }

  private resolveNavigationUrl(processedStep: string): string {
    const abs = processedStep.match(/(https?:\/\/[^\s"'<>]+)/i);
    if (abs) {
      return abs[1].replace(/[.,;:)\]}]+$/, '');
    }

    const rel = processedStep.match(/\s(\/[A-Za-z0-9_./?#&=%-]*)/);
    if (rel) {
      const base = this.baseUrl.replace(/\/$/, '');
      return `${base}${rel[1]}`;
    }

    return this.baseUrl;
  }

  private async performLogin(page: Page): Promise<void> {
    if (!this.testUserEmail || !this.testUserPassword) {
      throw new Error(
        'Credenciales QA no configuradas (email/password del proyecto)'
      );
    }

    const loginUrl = this.isLoginUrl(this.baseUrl)
      ? this.baseUrl
      : `${this.baseUrl.replace(/\/$/, '')}/login`;

    if (!page.url().startsWith('http') || !this.isLoginUrl(page.url())) {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    }

    const emailSelectors = [
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="mail" i]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[autocomplete="username"]',
      'input[name*="user" i]',
      '.login-input[type="email"]',
    ];
    const passwordSelectors = [
      'input[type="password"]',
      'input[placeholder*="contraseña" i]',
      'input[placeholder*="password" i]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[autocomplete="current-password"]',
    ];
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("ENTRAR")',
      'button:has-text("Entrar")',
      'button:has-text("Iniciar")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
    ];

    const findVisible = async (selectors: string[]) => {
      for (const sel of selectors) {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0)) {
          if (await loc.isVisible().catch(() => false)) return loc;
        }
      }
      return null;
    };

    // SPA login forms often appear after Angular boots.
    try {
      await page
        .locator('input[type="email"], input[type="password"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      // fall through to selector scan / retry
    }

    let email = await findVisible(emailSelectors);
    if (!email) {
      await page.goto(loginUrl, { waitUntil: 'networkidle' }).catch(() =>
        page.goto(loginUrl, { waitUntil: 'domcontentloaded' })
      );
      await page
        .locator('input[type="email"], input[type="password"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => undefined);
      email = await findVisible(emailSelectors);
    }
    if (!email) {
      throw new Error('No se encontró el campo de email/usuario para login');
    }

    const password = await findVisible(passwordSelectors);
    if (!password) {
      throw new Error('No se encontró el campo de password para login');
    }

    const returnUrl = page.url();
    const returnIsLogin = this.isLoginUrl(returnUrl);

    await email.fill(this.testUserEmail);
    await password.fill(this.testUserPassword);

    const submit = await findVisible(submitSelectors);
    if (submit) {
      await submit.click();
    } else {
      await password.press('Enter');
    }

    // Duo (and similar MFA) keeps the login form up while approving.
    // networkidle returns too early — wait until the form is actually gone.
    await this.waitForLoginComplete(page);

    // Prefer the deep link remembered from a prior navigate that hit the auth wall.
    const deepLink = this.pendingPostLoginUrl;
    this.pendingPostLoginUrl = null;
    const restoreTarget =
      deepLink || (!returnIsLogin ? returnUrl : null);

    if (
      restoreTarget &&
      page.url().split('?')[0] !== restoreTarget.split('?')[0]
    ) {
      await page.goto(restoreTarget, { waitUntil: 'domcontentloaded' });
      await this.waitForLoginComplete(page);
    }
  }

  private isLoginUrl(url: string): boolean {
    try {
      return /\/login(?:\/|$|\?)/i.test(new URL(url).pathname);
    } catch {
      return /\/login/i.test(url);
    }
  }

  /** Wait until MFA/Duo finishes and the login form leaves the page. */
  private async waitForLoginComplete(page: Page): Promise<void> {
    const timeout = parseInt(process.env.LOGIN_TIMEOUT_MS || '120000', 10);
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error('Browser cerrado durante el login');
      }

      const onLogin = this.isLoginUrl(page.url());
      const passwordVisible = await page
        .locator('input[type="password"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (!onLogin || !passwordVisible) {
        await page
          .waitForLoadState('domcontentloaded')
          .catch(() => undefined);
        return;
      }

      await page.waitForTimeout(500);
    }

    const duoStillWaiting = await page
      .getByText(/Duo Mobile/i)
      .first()
      .isVisible()
      .catch(() => false);

    throw new Error(
      duoStillWaiting
        ? `Login no completó tras ${Math.round(timeout / 1000)}s (sigue esperando Duo Mobile)`
        : `Login no completó tras ${Math.round(timeout / 1000)}s`
    );
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
