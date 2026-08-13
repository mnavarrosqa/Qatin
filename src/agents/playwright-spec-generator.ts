import fs from 'fs';
import path from 'path';
import type { TestScenario, TestStrategy } from './ticket-analyzer';
import { looksLikeApiCase } from './ticket-analyzer';
import {
  classifyApiStep,
  expectedStatusFromScenario,
  parseApiEndpoint,
  payloadFromSteps,
  resolveApiBaseUrl,
} from './api-case-steps';
import { getPlaywrightGeneratedDir } from '../paths';

export type GeneratedSpecFile = {
  /** Absolute path written (or would be written). */
  path: string;
  /** Path relative to APP_ROOT. */
  relativePath: string;
  content: string;
  filename: string;
};

export type GeneratePlaywrightSpecsInput = {
  strategy: TestStrategy;
  ticketKey: string;
  baseUrl?: string | null;
  /** When false, only build content — do not write. Default true. */
  write?: boolean;
};

export type GeneratePlaywrightSpecsResult = {
  ticketKey: string;
  files: GeneratedSpecFile[];
  scenarioCount: number;
};

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escTemplate(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function firstQuoted(step: string): string | null {
  const m = step.match(/['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

function fillValue(step: string): string | null {
  const withMatch = step.match(/(?:with|con)\s+['"]([^'"]+)['"]/i);
  if (withMatch) return withMatch[1];
  const all = [...step.matchAll(/['"]([^'"]+)['"]/g)];
  if (all.length >= 2) return all[all.length - 1][1];
  return all[0]?.[1] ?? null;
}

function fillLabel(step: string): string | null {
  const all = [...step.matchAll(/['"]([^'"]+)['"]/g)];
  if (all.length >= 2) return all[0][1];
  // "Completar el campo X con 'val'" without quotes on label
  const m = step.match(
    /(?:campo|field|input)\s+['"]?([^'"]+?)['"]?\s+(?:con|with)\s+['"]/i
  );
  return m ? m[1].trim() : firstQuoted(step);
}

function resolveNavUrl(step: string, baseUrl: string): string {
  const processed = step.replace(/\{\{BASE_URL\}\}/g, baseUrl);
  const abs = processed.match(/(https?:\/\/[^\s"'<>]+)/i);
  if (abs) return abs[1].replace(/[.,;:)\]}]+$/, '');
  const rel = processed.match(/\s(\/[A-Za-z0-9_./?#&=%-]*)/);
  if (rel) {
    const base = baseUrl.replace(/\/$/, '');
    return `${base}${rel[1]}`;
  }
  if (/\{\{BASE_URL\}\}/.test(step) || /base_url/i.test(step)) {
    return baseUrl;
  }
  return baseUrl;
}

function pickSelector(
  step: string,
  scenario: TestScenario,
  stepIndex: number
): string | null {
  const quoted = firstQuoted(step);
  const selectors = scenario.selectors || [];
  if (!selectors.length) return null;
  if (quoted) {
    const hit = selectors.find(
      (s) =>
        s.includes(quoted) ||
        s.toLowerCase().includes(quoted.toLowerCase())
    );
    if (hit) return hit;
  }
  return selectors[Math.min(stepIndex, selectors.length - 1)] || null;
}

function locatorExpr(selector: string | null, fallbackText: string | null): string {
  if (selector) {
    if (selector.startsWith('text=') || selector.startsWith('text=/')) {
      const t = selector.replace(/^text=/i, '').replace(/^\/|\/$/g, '');
      return `page.getByText('${esc(t)}')`;
    }
    if (selector.startsWith('role=')) {
      return `page.locator('${esc(selector)}')`;
    }
    return `page.locator('${esc(selector)}')`;
  }
  if (fallbackText) {
    return `page.getByText('${esc(fallbackText)}')`;
  }
  return 'page.locator("body")';
}

type StepKind =
  | 'navigate'
  | 'click'
  | 'login'
  | 'fill'
  | 'wait'
  | 'verify'
  | 'scroll'
  | 'hover'
  | 'select'
  | 'unknown';

function classifyStep(step: string): StepKind {
  const stepLower = step.toLowerCase();
  if (
    /\bnavegar\b|\bir\s+a\b|\bvisitar\b|\bnavigate\b|\bgo\s+to\b|\bingresar\s+a\b|\bentrar\s+(a|en)\b/.test(
      stepLower
    ) ||
    (/\babrir\b|\bopen\b/.test(stepLower) &&
      /(https?:\/\/|\/[A-Za-z0-9]|p[aá]gina|url|sitio|app|aplicaci[oó]n|\bpage\b|\bsite\b|\{\{BASE_URL\}\})/i.test(
        step
      ))
  ) {
    return 'navigate';
  }
  if (
    /\bclick\b|\bclic\b|\bpulsar\b|\bpresionar\b|\bconfirmar\b|\bguardar\b|\benviar\b/.test(
      stepLower
    )
  ) {
    return 'click';
  }
  if (
    /iniciar\s+sesi[oó]n|\blog\s*in\b|\bsign\s*in\b|\bautentic/.test(stepLower) ||
    /^(hacer\s+)?login\b/.test(stepLower.trim())
  ) {
    return 'login';
  }
  if (
    /\bcompletar\b|\brellenar\b|\bescribir\b|\btipear\b|\bfill\b|\btype\b/.test(
      stepLower
    ) ||
    /\bingresar\b(?!\s+a\b)/.test(stepLower) ||
    /\benter\s+['"]/.test(stepLower) ||
    (/\benter\b/.test(stepLower) && /(?:with|con)\s+['"]/i.test(step))
  ) {
    return 'fill';
  }
  if (/\besperar\b|\bwait\b/.test(stepLower)) return 'wait';
  if (
    /\bverificar\b|\bcomprobar\b|\bvalidar\b|\basegurar\b|\bcheck\b|\bverify\b|\bassert\b/.test(
      stepLower
    )
  ) {
    return 'verify';
  }
  if (/\bscroll\b|\bdesplaz/.test(stepLower)) return 'scroll';
  if (/\bhover\b|\bpasar\s+(el\s+)?mouse\b|\bencima\b/.test(stepLower)) {
    return 'hover';
  }
  if (/\bselect\b|\bseleccion/.test(stepLower)) return 'select';
  return 'unknown';
}

function emitStepLines(
  step: string,
  scenario: TestScenario,
  stepIndex: number,
  baseUrl: string
): string[] {
  const kind = classifyStep(step);
  const processed = step.replace(/\{\{BASE_URL\}\}/g, baseUrl);
  const selector = pickSelector(processed, scenario, stepIndex);
  const quoted = firstQuoted(processed);
  const title = esc(step.slice(0, 80));

  switch (kind) {
    case 'navigate': {
      const url = resolveNavUrl(processed, baseUrl);
      return [
        `  await test.step('${title}', async () => {`,
        `    await page.goto('${esc(url)}');`,
        `    await page.waitForLoadState('domcontentloaded');`,
        `  });`,
      ];
    }
    case 'click': {
      const target = locatorExpr(selector, quoted);
      return [
        `  await test.step('${title}', async () => {`,
        `    await ${target}.first().click();`,
        `  });`,
      ];
    }
    case 'login':
      return [
        `  await test.step('${title}', async () => {`,
        `    await loginWithEnvCredentials(page);`,
        `  });`,
      ];
    case 'fill': {
      const label = fillLabel(processed);
      const value = fillValue(processed) || '';
      const target = selector
        ? locatorExpr(selector, null)
        : label
          ? `page.getByLabel('${esc(label)}').or(page.getByPlaceholder('${esc(label)}')).or(page.locator('[name="${esc(label)}"]'))`
          : locatorExpr(null, quoted);
      return [
        `  await test.step('${title}', async () => {`,
        `    await ${target}.first().fill('${esc(value)}');`,
        `  });`,
      ];
    }
    case 'wait': {
      const timeMatch = processed.match(
        /(\d+)\s*(seconds?|segundos?|ms|milliseconds?|milisegundos?)/i
      );
      let ms = 2000;
      if (timeMatch) {
        const time = parseInt(timeMatch[1], 10);
        const unit = timeMatch[2].toLowerCase();
        ms =
          unit.startsWith('seg') || unit.startsWith('second')
            ? time * 1000
            : time;
      }
      return [
        `  await test.step('${title}', async () => {`,
        `    await page.waitForTimeout(${ms});`,
        `  });`,
      ];
    }
    case 'verify': {
      const target = locatorExpr(selector, quoted);
      const lines = [
        `  await test.step('${title}', async () => {`,
      ];
      if (selector || quoted) {
        lines.push(`    await expect(${target}.first()).toBeVisible({ timeout: 5000 });`);
      } else {
        lines.push(`    await expect(page).not.toHaveURL('about:blank');`);
      }
      lines.push(`  });`);
      return lines;
    }
    case 'scroll': {
      const expr = /bottom|abajo|final/.test(processed.toLowerCase())
        ? 'window.scrollTo(0, document.body.scrollHeight)'
        : /top|arriba|inicio/.test(processed.toLowerCase())
          ? 'window.scrollTo(0, 0)'
          : 'window.scrollBy(0, 500)';
      return [
        `  await test.step('${title}', async () => {`,
        `    await page.evaluate(() => { ${expr}; });`,
        `  });`,
      ];
    }
    case 'hover': {
      const target = locatorExpr(selector, quoted);
      return [
        `  await test.step('${title}', async () => {`,
        `    await ${target}.first().hover();`,
        `  });`,
      ];
    }
    case 'select': {
      const value = quoted || '';
      const target = locatorExpr(selector, null);
      if (selector) {
        return [
          `  await test.step('${title}', async () => {`,
          `    await ${target}.first().selectOption('${esc(value)}');`,
          `  });`,
        ];
      }
      return [
        `  await test.step('${title}', async () => {`,
        `    await page.getByText('${esc(value)}').first().click();`,
        `  });`,
      ];
    }
    default:
      return [
        `  await test.step('${title}', async () => {`,
        `    // Paso no traducido automáticamente — revisá el caso NL`,
        `    throw new Error(\`Paso no traducido: ${escTemplate(step)}\`);`,
        `  });`,
      ];
  }
}

function sanitizeTestTitle(description: string, id: string): string {
  const cleaned = description
    .replace(/\[(Happy|Unhappy|Corner)\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${id}: ${cleaned || 'scenario'}`;
}

function needsLoginHelper(scenarios: TestScenario[]): boolean {
  return scenarios.some(
    (s) =>
      !looksLikeApiCase(s) &&
      (s.steps || []).some((step) => classifyStep(step) === 'login')
  );
}

function emitApiScenarioBody(scenario: TestScenario, apiBase: string): string[] {
  const steps = scenario.steps || [];
  const lines: string[] = [];
  const { method, path: epPath } = parseApiEndpoint(scenario);
  const payload = payloadFromSteps(steps);
  const status = expectedStatusFromScenario(scenario);
  const payloadLit = JSON.stringify(payload, null, 2).replace(/\n/g, '\n    ');

  lines.push(`    let __payload: Record<string, unknown> = ${payloadLit};`);
  lines.push(`    let __response: APIResponse | undefined;`);
  lines.push(`    let __body: unknown;`);

  if (!steps.length) {
    lines.push(`    test.skip(true, 'Sin pasos guardados');`);
    return lines;
  }

  for (const step of steps) {
    const kind = classifyApiStep(step);
    const title = esc(step.slice(0, 80));
    const ep = parseApiEndpoint(scenario, step);
    const useMethod = ep.path !== '/' ? ep.method : method;
    const usePath = ep.path !== '/' ? ep.path : epPath;
    const urlExpr = `\`\${API_BASE}${esc(usePath)}\``;

    switch (kind) {
      case 'auth': {
        lines.push(`    await test.step('${title}', async () => {`);
        lines.push(
          `      // Qatin injects project QA credentials / API_TOKEN at run time`
        );
        lines.push(
          `      if (!process.env.API_TOKEN && !(process.env.TEST_USER_EMAIL && process.env.TEST_USER_PASSWORD)) {`
        );
        lines.push(
          `        throw new Error('Missing API auth: set API_TOKEN or TEST_USER_EMAIL/PASSWORD (project QA user)');`
        );
        lines.push(`      }`);
        lines.push(`    });`);
        break;
      }
      case 'pending_discovery': {
        lines.push(`    await test.step('${title}', async () => {`);
        lines.push(
          `      test.skip(true, 'Pendiente confirmar en Network/Swagger — no inventar params');`
        );
        lines.push(`    });`);
        break;
      }
      case 'prepare_payload': {
        const stepPayload = payloadFromSteps([step]);
        const merged =
          Object.keys(stepPayload).length > 0 ? stepPayload : payload;
        lines.push(`    await test.step('${title}', async () => {`);
        lines.push(
          `      __payload = { ...__payload, ...${JSON.stringify(merged)} };`
        );
        lines.push(`    });`);
        break;
      }
      case 'send': {
        const methodLower = useMethod.toLowerCase();
        const pathLit = esc(usePath);
        lines.push(`    await test.step('${title}', async () => {`);
        lines.push(
          `      const __path = '${pathLit}'.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => {`
        );
        lines.push(
          `        const v = process.env[k]; if (!v) throw new Error('Falta env ' + k + ' (ID real; no inventar)'); return v;`
        );
        lines.push(`      });`);
        if (useMethod === 'GET' || useMethod === 'DELETE') {
          lines.push(
            `      __response = await request.${methodLower}(\`\${API_BASE}\${__path}\`, { headers: API_HEADERS });`
          );
        } else {
          lines.push(
            `      __response = await request.${methodLower}(\`\${API_BASE}\${__path}\`, { data: __payload, headers: API_HEADERS });`
          );
        }
        lines.push(
          `      __body = await __response.json().catch(async () => __response!.text());`
        );
        lines.push(`    });`);
        break;
      }
      case 'assert_status': {
        const st = expectedStatusFromScenario({
          steps: [step],
          expectedResults: scenario.expectedResults,
        });
        lines.push(`    await test.step('${title}', async () => {`);
        lines.push(`      expect(__response, 'missing response').toBeTruthy();`);
        lines.push(`      expect(__response!.status()).toBe(${st || status});`);
        lines.push(`    });`);
        break;
      }
      case 'assert_body':
      case 'other':
      default: {
        const quoted = firstQuoted(step);
        lines.push(`    await test.step('${title}', async () => {`);
        lines.push(`      expect(__response, 'missing response').toBeTruthy();`);
        if (quoted) {
          lines.push(
            `      expect(JSON.stringify(__body)).toContain('${esc(quoted)}');`
          );
        } else {
          lines.push(
            `      expect(__response!.ok() || __response!.status() < 500).toBeTruthy();`
          );
        }
        lines.push(`    });`);
        break;
      }
    }
  }

  const expected = scenario.expectedResults || [];
  if (expected.length) {
    lines.push(`    // Expected results (from case):`);
    for (const er of expected.slice(0, 8)) {
      lines.push(`    // - ${er.replace(/\n/g, ' ').slice(0, 160)}`);
    }
  }

  void apiBase;
  return lines;
}

function emitUiScenarioBody(
  scenario: TestScenario,
  baseUrl: string
): string[] {
  const lines: string[] = [];
  const steps = scenario.steps || [];
  if (!steps.length) {
    lines.push(`    test.skip(true, 'Sin pasos guardados');`);
    return lines;
  }
  for (let i = 0; i < steps.length; i++) {
    const stepLines = emitStepLines(steps[i], scenario, i, baseUrl);
    for (const line of stepLines) {
      lines.push(`  ${line}`);
    }
  }
  const expected = scenario.expectedResults || [];
  if (expected.length) {
    lines.push(`    // Expected results (from case):`);
    for (const er of expected.slice(0, 8)) {
      lines.push(`    // - ${er.replace(/\n/g, ' ').slice(0, 160)}`);
    }
  }
  return lines;
}

export function renderPlaywrightSpec(opts: {
  ticketKey: string;
  strategy: TestStrategy;
  baseUrl: string;
}): string {
  const { ticketKey, strategy, baseUrl } = opts;
  const scenarios = strategy.scenarios || [];
  const apiBase = resolveApiBaseUrl(baseUrl);
  const hasApi = scenarios.some((s) => looksLikeApiCase(s));
  const hasUi = scenarios.some((s) => !looksLikeApiCase(s));
  const loginHelper = needsLoginHelper(scenarios);

  const imports = hasUi
    ? hasApi
      ? `import { test, expect, type Page, type APIResponse } from '@playwright/test';`
      : `import { test, expect, type Page } from '@playwright/test';`
    : `import { test, expect, type APIResponse } from '@playwright/test';`;

  const lines: string[] = [
    imports,
    ``,
    `/**`,
    ` * Generated by Qatin from saved test cases.`,
    ` * Ticket: ${ticketKey}`,
    ` * Summary: ${strategy.summary || '(sin resumen)'}`,
    ` * testType: ${strategy.testType}`,
    ` * UI base: ${baseUrl}`,
    ` * API base: ${apiBase}`,
    ` *`,
    ` * Auth: when run via Qatin, project QA credentials are injected.`,
    ` * Standalone: set TEST_USER_EMAIL / TEST_USER_PASSWORD (UI) and optional API_TOKEN (Bearer).`,
    ` * Override API host with API_BASE_URL.`,
    ` */`,
    ``,
    `const BASE_URL = process.env.APP_BASE_URL || '${esc(baseUrl)}';`,
    `const API_BASE = process.env.API_BASE_URL || '${esc(apiBase)}';`,
    `const API_HEADERS: Record<string, string> = process.env.API_TOKEN`,
    `  ? { Authorization: \`Bearer \${process.env.API_TOKEN}\` }`,
    `  : {};`,
    ``,
  ];

  if (loginHelper) {
    lines.push(
      `async function loginWithEnvCredentials(page: Page) {`,
      `  const email = process.env.TEST_USER_EMAIL || '';`,
      `  const password = process.env.TEST_USER_PASSWORD || '';`,
      `  if (!email || !password) {`,
      `    throw new Error('Missing QA credentials: set TEST_USER_EMAIL/TEST_USER_PASSWORD or configure them on the Qatin project');`,
      `  }`,
      `  const emailField = page.getByLabel(/email|usuario|user/i).or(page.locator('input[type="email"], input[name*="user" i], input[name*="email" i]')).first();`,
      `  const passwordField = page.getByLabel(/password|contraseña|clave/i).or(page.locator('input[type="password"]')).first();`,
      `  await emailField.fill(email);`,
      `  await passwordField.fill(password);`,
      `  await page.getByRole('button', { name: /iniciar|login|entrar|sign in/i }).first().click();`,
      `  await page.waitForLoadState('networkidle').catch(() => undefined);`,
      `}`,
      ``
    );
  }

  lines.push(`test.describe('${esc(ticketKey)}', () => {`);

  for (const scenario of scenarios) {
    const id = scenario.id || 'TC';
    const title = sanitizeTestTitle(scenario.description || '', id);
    const isApi = looksLikeApiCase(scenario);
    if (isApi) {
      lines.push(`  test('${esc(title)}', async ({ request }) => {`);
      if (scenario.description) {
        lines.push(
          `    // ${scenario.description.replace(/\n/g, ' ').slice(0, 200)}`
        );
      }
      lines.push(...emitApiScenarioBody(scenario, apiBase));
    } else {
      lines.push(`  test('${esc(title)}', async ({ page }) => {`);
      if (scenario.description) {
        lines.push(
          `    // ${scenario.description.replace(/\n/g, ' ').slice(0, 200)}`
        );
      }
      lines.push(...emitUiScenarioBody(scenario, baseUrl));
    }
    lines.push(`  });`);
    lines.push(``);
  }

  lines.push(`});`);
  lines.push(``);
  return lines.join('\n');
}

/** Directory for a ticket's generated specs. */
export function playwrightSpecDir(ticketKey: string): string {
  const key = ticketKey.trim().toUpperCase() || 'UNKNOWN';
  return path.join(getPlaywrightGeneratedDir(), key);
}

export function playwrightSpecPath(ticketKey: string): string {
  const key = ticketKey.trim().toUpperCase() || 'UNKNOWN';
  const safe = key.replace(/[^A-Z0-9._-]/gi, '_');
  return path.join(playwrightSpecDir(key), `${safe}.spec.ts`);
}

export function hasPlaywrightSpecsOnDisk(ticketKey: string): boolean {
  const p = playwrightSpecPath(ticketKey);
  return fs.existsSync(p);
}

/**
 * Build Playwright Test specs from a strategy and optionally write them under
 * generated/playwright/<TICKET>/.
 */
export function generatePlaywrightSpecs(
  input: GeneratePlaywrightSpecsInput
): GeneratePlaywrightSpecsResult {
  const ticketKey = input.ticketKey.trim().toUpperCase();
  const baseUrl =
    (input.baseUrl || process.env.APP_BASE_URL || 'http://localhost:3000').replace(
      /\/$/,
      ''
    ) || 'http://localhost:3000';
  const content = renderPlaywrightSpec({
    ticketKey,
    strategy: input.strategy,
    baseUrl,
  });
  const abs = playwrightSpecPath(ticketKey);
  const filename = path.basename(abs);
  const appRel = path.join('generated', 'playwright', ticketKey, filename);

  if (input.write !== false) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  return {
    ticketKey,
    scenarioCount: input.strategy.scenarios?.length || 0,
    files: [
      {
        path: abs,
        relativePath: appRel,
        content,
        filename,
      },
    ],
  };
}
