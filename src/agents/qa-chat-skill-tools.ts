/**
 * Chat tools gated by installed Skills (Settings → Skills).
 */
import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import {
  getProject,
  listTestCases,
  listTestRuns,
  getTestRun,
} from '../db';
import { DirectJiraClient } from '../clients/jira-mcp-client';
import {
  getCreateInJira,
  getExploratoryMaxPages,
  isSkillInstalled,
} from '../skills';
import { ToolDefinition } from '../llm';
import { getScreenshotsDir, isPathInside } from '../paths';
import { logger } from '../utils/logger';

function screenshotPublicUrl(filePath: string): string {
  const screenshotsRoot = getScreenshotsDir();
  const abs = path.resolve(filePath);
  if (isPathInside(screenshotsRoot, abs)) {
    const rel = path.relative(screenshotsRoot, abs).split(path.sep).join('/');
    return `/screenshots/${rel}`;
  }
  return filePath;
}

export const SKILL_CHAT_TOOLS: ToolDefinition[] = [
  {
    name: 'review_test_plan',
    description:
      'Revisa casos/strategy guardados de un ticket: gaps de cobertura, selectores frágiles, pasos ambiguos. Devuelve findings + readyToEnqueue.',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'draft_bug',
    description:
      'Arma un borrador de bug a partir de un run fallido (run_id) o el último fail del proyecto. Incluye pasos, expected/actual y screenshots.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'number' },
        ticket_key: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_jira_bug',
    description:
      'Crea un Bug en Jira del proyecto activo. Requiere skill Bug writer con createInJira activo y confirmación del usuario. Podés pasar summary/description o run_id para armarlos.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        description: { type: 'string' },
        run_id: { type: 'number' },
        attach_screenshots: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_selectors',
    description:
      'Abre una URL con Playwright y sugiere selectores estables (data-testid, role/name, name, id) para un hint opcional.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        hint: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'explore_app',
    description:
      'Explora la app (crawl acotado) y sugiere gaps de cobertura frente a casos guardados del proyecto.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_pages: { type: 'number' },
        ticket_key: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

const FRAGILE_SELECTOR =
  /nth-child|nth-of-type|>\s*div\s*>|\/html|body\s*>/i;
const AMBIGUOUS_STEP =
  /^(check|verify|assert|validar|verificar|comprobar)\b/i;

export async function runSkillTool(
  name: string,
  args: Record<string, unknown>,
  projectId: number
): Promise<unknown> {
  switch (name) {
    case 'review_test_plan':
      return reviewTestPlan(projectId, args);
    case 'draft_bug':
      return draftBug(projectId, args);
    case 'create_jira_bug':
      return createJiraBug(projectId, args);
    case 'suggest_selectors':
      return suggestSelectors(projectId, args);
    case 'explore_app':
      return exploreApp(projectId, args);
    default:
      return { error: `Skill tool desconocida: ${name}` };
  }
}

function reviewTestPlan(
  projectId: number,
  args: Record<string, unknown>
): unknown {
  if (!isSkillInstalled('test-plan-reviewer')) {
    return { error: 'Skill Test plan reviewer no está activa (Configuración → Skills)' };
  }

  const ticketKey =
    typeof args.ticket_key === 'string'
      ? args.ticket_key.trim().toUpperCase()
      : '';
  const cases = listTestCases({
    projectId,
    ticketKey: ticketKey || undefined,
  });

  if (!cases.length) {
    return {
      readyToEnqueue: false,
      findings: [
        {
          severity: 'high',
          type: 'coverage',
          message: ticketKey
            ? `No hay casos guardados para ${ticketKey}`
            : 'No hay casos guardados en el proyecto',
        },
      ],
      summary: 'Sin casos para revisar. Generá o guardá casos primero.',
    };
  }

  const findings: Array<{
    severity: 'high' | 'medium' | 'low';
    type: string;
    case_key?: string;
    message: string;
  }> = [];

  let fragile = 0;
  let ambiguous = 0;
  let emptySteps = 0;
  let hasNegative = false;

  for (const c of cases) {
    const steps = c.steps || [];
    const selectors = c.selectors || [];
    const desc = (c.description || '').toLowerCase();

    if (
      /negativ|error|invalid|fail|edge|vac[ií]o|sin |sin_/.test(desc) ||
      /negativ|error|invalid/.test(c.case_key.toLowerCase())
    ) {
      hasNegative = true;
    }

    if (!steps.length) {
      emptySteps++;
      findings.push({
        severity: 'high',
        type: 'steps',
        case_key: c.case_key,
        message: 'Caso sin pasos',
      });
    }

    for (const step of steps) {
      if (AMBIGUOUS_STEP.test(step.trim()) && !/['"`]/.test(step)) {
        ambiguous++;
        findings.push({
          severity: 'medium',
          type: 'ambiguous_step',
          case_key: c.case_key,
          message: `Paso ambiguo (sin texto/selector concreto): "${step.slice(0, 80)}"`,
        });
      }
    }

    for (const sel of selectors) {
      if (FRAGILE_SELECTOR.test(sel)) {
        fragile++;
        findings.push({
          severity: 'medium',
          type: 'fragile_selector',
          case_key: c.case_key,
          message: `Selector frágil: ${sel}`,
        });
      }
    }
  }

  if (!hasNegative && cases.length >= 2) {
    findings.push({
      severity: 'medium',
      type: 'coverage',
      message:
        'No se detectaron casos negativos/edge explícitos. Considerá agregar al menos uno.',
    });
  }

  const high = findings.filter((f) => f.severity === 'high').length;
  const readyToEnqueue = high === 0;

  return {
    ticket_key: ticketKey || null,
    casesReviewed: cases.length,
    stats: { fragileSelectors: fragile, ambiguousSteps: ambiguous, emptySteps },
    findings: findings.slice(0, 40),
    readyToEnqueue,
    summary: readyToEnqueue
      ? `Plan OK para encolar (${cases.length} casos). ${findings.length} observaciones menores.`
      : `Hay ${high} hallazgos altos; corregí antes de encolar o pedí "encolá igual".`,
  };
}

function draftBug(
  projectId: number,
  args: Record<string, unknown>
): unknown {
  if (!isSkillInstalled('bug-writer')) {
    return { error: 'Skill Bug writer no está activa (Configuración → Skills)' };
  }

  const run = resolveFailedRun(projectId, args);
  if ('error' in run) return run;

  const result = parseRunResult(run.result_json);
  const failedScenarios = Array.isArray(result?.executionResults)
    ? (result.executionResults as any[]).filter((s) => s && s.success === false)
    : [];

  const first = failedScenarios[0];
  const steps: string[] = [];
  if (first?.steps && Array.isArray(first.steps)) {
    for (const st of first.steps) {
      const mark = st.success ? 'OK' : 'FAIL';
      steps.push(`[${mark}] ${st.step}${st.error ? ` — ${st.error}` : ''}`);
    }
  }

  const ticketId = run.ticket_id || 'UNKNOWN';
  const summary = `[QA] Fallo automatizado en ${ticketId}${
    first?.description ? `: ${String(first.description).slice(0, 80)}` : ''
  }`;

  const errors = first?.errors?.length
    ? first.errors.join('\n')
    : failedScenarios.map((s) => s.errors?.join?.('; ') || s.description).join('\n');

  const screenshots = listScreenshotsForTicket(ticketId);

  const description = [
    `Entorno: proyecto Qatin #${projectId}`,
    `Run: #${run.id} · ticket ${ticketId} · status ${run.status}`,
    '',
    '## Steps to reproduce',
    ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ['(sin pasos en el resultado)']),
    '',
    '## Expected',
    'Todos los escenarios del plan deberían pasar.',
    '',
    '## Actual',
    errors || 'Escenario(s) fallaron (ver evidencias).',
    '',
    '## Evidence',
    ...(screenshots.length
      ? screenshots.slice(0, 8).map((s) => `- ${s.url}`)
      : ['(sin screenshots)']),
  ].join('\n');

  return {
    summary,
    description,
    runId: run.id,
    ticketId,
    failedScenarios: failedScenarios.length,
    screenshots,
    jiraCreateEnabled: getCreateInJira(),
    hint: getCreateInJira()
      ? 'Mostrá el draft al usuario. Si confirma, usá create_jira_bug.'
      : 'Mostrá el draft para copiar. createInJira está off en Skills.',
  };
}

async function createJiraBug(
  projectId: number,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!isSkillInstalled('bug-writer')) {
    return { error: 'Skill Bug writer no está activa (Configuración → Skills)' };
  }
  if (!getCreateInJira()) {
    return {
      error:
        'createInJira está desactivado. Activá “Permitir crear bugs en Jira” en Configuración → Skills → Bug writer.',
    };
  }

  const project = getProject(projectId);
  if (!project?.jira_project_key) {
    return {
      error:
        'El proyecto no tiene jira_project_key. Configuralo en Proyectos.',
    };
  }

  let summary =
    typeof args.summary === 'string' ? args.summary.trim() : '';
  let description =
    typeof args.description === 'string' ? args.description.trim() : '';

  let attachments: Array<{ name: string; buffer: Buffer }> | undefined;

  if ((!summary || !description) && typeof args.run_id === 'number') {
    const draft = draftBug(projectId, { run_id: args.run_id }) as any;
    if (draft.error) return draft;
    summary = summary || draft.summary;
    description = description || draft.description;
    if (args.attach_screenshots !== false && Array.isArray(draft.screenshots)) {
      attachments = [];
      for (const s of draft.screenshots.slice(0, 5)) {
        try {
          if (s.path && fs.existsSync(s.path)) {
            attachments.push({
              name: s.name,
              buffer: fs.readFileSync(s.path),
            });
          }
        } catch {
          // skip
        }
      }
    }
  }

  if (!summary) {
    return { error: 'Falta summary (o run_id para armarlo)' };
  }

  const client = new DirectJiraClient();
  const created = await client.createIssue({
    projectKey: project.jira_project_key,
    summary,
    description: description || summary,
    issueType: 'Bug',
    labels: ['qatin', 'automated-qa'],
    attachments,
  });

  const base = (project.jira_url || '').replace(/\/$/, '');
  return {
    ok: true,
    key: created.key,
    id: created.id,
    url: base ? `${base}/browse/${created.key}` : created.self,
  };
}

async function suggestSelectors(
  projectId: number,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!isSkillInstalled('selector-coach')) {
    return { error: 'Skill Selector coach no está activa (Configuración → Skills)' };
  }

  const project = getProject(projectId);
  const urlRaw = typeof args.url === 'string' ? args.url.trim() : '';
  const hint = typeof args.hint === 'string' ? args.hint.trim() : '';
  const base = project?.base_url || '';
  const allowed = resolveProjectUrl(urlRaw || base, base);
  if ('error' in allowed) return allowed;
  const url = allowed.url;

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const candidates = await page.evaluate((hintText: string) => {
      // Runs in browser; avoid DOM lib types in Node compile.
      const doc = (globalThis as any).document as any;
      const out: Array<{
        selector: string;
        rank: number;
        tag: string;
        text: string;
      }> = [];
      const seen = new Set<string>();
      const push = (selector: string, rank: number, el: any) => {
        if (!selector || seen.has(selector)) return;
        seen.add(selector);
        out.push({
          selector,
          rank,
          tag: String(el.tagName || '').toLowerCase(),
          text: String(el.textContent || '')
            .trim()
            .slice(0, 60),
        });
      };

      const nodes: any[] = Array.from(
        doc.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [data-testid], [name], [id]'
        )
      ).slice(0, 200);

      const hintLower = hintText.toLowerCase();

      for (const el of nodes) {
        const testId = el.getAttribute('data-testid');
        const name = el.getAttribute('name');
        const id = el.getAttribute('id');
        const role = el.getAttribute('role');
        const aria = el.getAttribute('aria-label');
        const type = el.getAttribute('type');
        const text = String(el.textContent || '').trim();
        const hay =
          `${testId || ''} ${name || ''} ${id || ''} ${aria || ''} ${text} ${type || ''}`.toLowerCase();
        if (
          hintLower &&
          !hay.includes(hintLower) &&
          !hintLower
            .split(/\s+/)
            .some((w) => w.length > 2 && hay.includes(w))
        ) {
          continue;
        }

        if (testId) push(`[data-testid="${testId}"]`, 1, el);
        if (role && aria) push(`[role="${role}"][aria-label="${aria}"]`, 2, el);
        if (aria) push(`[aria-label="${aria}"]`, 3, el);
        if (name) push(`[name="${name}"]`, 4, el);
        if (id && /^[A-Za-z][\w-]*$/.test(id)) push(`#${id}`, 5, el);
        if (el.tagName === 'BUTTON' && text && text.length < 40) {
          push(`button:has-text("${text.replace(/"/g, '\\"')}")`, 6, el);
        }
        if (type) push(`${String(el.tagName).toLowerCase()}[type="${type}"]`, 8, el);
      }

      out.sort((a, b) => a.rank - b.rank);
      return out.slice(0, 25);
    }, hint);

    await context.close();

    return {
      url,
      hint: hint || null,
      recommendations: candidates.map((c) => ({
        selector: c.selector,
        stability:
          c.rank <= 2 ? 'high' : c.rank <= 5 ? 'medium' : 'low',
        tag: c.tag,
        text: c.text,
      })),
      tip: 'Preferí data-testid / role+name. Evitá CSS profundo y nth-child.',
    };
  } catch (error: any) {
    logger.warn('suggest_selectors failed', error);
    return { error: error?.message || String(error), url };
  } finally {
    await browser.close();
  }
}

async function exploreApp(
  projectId: number,
  args: Record<string, unknown>
): Promise<unknown> {
  if (!isSkillInstalled('exploratory')) {
    return { error: 'Skill Exploratory no está activa (Configuración → Skills)' };
  }

  const project = getProject(projectId);
  const base = project?.base_url || '';
  const urlRaw = typeof args.url === 'string' ? args.url.trim() : '';
  const allowed = resolveProjectUrl(urlRaw || base, base);
  if ('error' in allowed) return allowed;
  const startUrl = allowed.url;

  const maxPages = Math.min(
    15,
    Math.max(
      1,
      typeof args.max_pages === 'number'
        ? Math.floor(args.max_pages)
        : getExploratoryMaxPages()
    )
  );

  const ticketKey =
    typeof args.ticket_key === 'string'
      ? args.ticket_key.trim().toUpperCase()
      : '';
  const cases = listTestCases({
    projectId,
    ticketKey: ticketKey || undefined,
  });
  const caseBlob = cases
    .map(
      (c) =>
        `${c.case_key} ${c.description} ${(c.steps || []).join(' ')} ${(c.urls || []).join(' ')}`
    )
    .join('\n')
    .toLowerCase();

  const origin = new URL(startUrl).origin;
  const visited: Array<{
    url: string;
    title: string;
    links: number;
    forms: number;
    buttons: number;
  }> = [];
  const queue = [startUrl];
  const seen = new Set<string>();

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    while (queue.length && visited.length < maxPages) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);

      try {
        await page.goto(next, { waitUntil: 'domcontentloaded' });
        const info = await page.evaluate(() => {
          const doc = (globalThis as any).document as any;
          const links = Array.from(doc.querySelectorAll('a[href]'))
            .map((a: any) => a.href as string)
            .filter(Boolean);
          return {
            title: doc.title || '',
            links,
            forms: doc.querySelectorAll('form').length,
            buttons: doc.querySelectorAll(
              'button, [role="button"], input[type="submit"]'
            ).length,
          };
        });

        visited.push({
          url: next,
          title: info.title,
          links: info.links.length,
          forms: info.forms,
          buttons: info.buttons,
        });

        for (const href of info.links) {
          try {
            const u = new URL(href);
            if (u.origin !== origin) continue;
            u.hash = '';
            const clean = u.toString();
            if (!seen.has(clean) && !queue.includes(clean)) {
              queue.push(clean);
            }
          } catch {
            // skip bad urls
          }
        }
      } catch (err: any) {
        visited.push({
          url: next,
          title: `(error: ${err?.message || 'nav failed'})`,
          links: 0,
          forms: 0,
          buttons: 0,
        });
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const gaps: string[] = [];
  for (const pageInfo of visited) {
    const pathKey = pageInfo.url.replace(origin, '') || '/';
    const covered =
      caseBlob.includes(pathKey.toLowerCase()) ||
      caseBlob.includes(pageInfo.title.toLowerCase().slice(0, 20));
    if (!covered && pageInfo.forms > 0) {
      gaps.push(`Formulario en ${pathKey} (${pageInfo.title || 'sin título'}) sin caso obvio`);
    } else if (!covered && pageInfo.buttons > 2) {
      gaps.push(`Pantalla interactiva ${pathKey} poco referida en casos`);
    }
  }

  if (!cases.length) {
    gaps.unshift(
      'No hay casos guardados: todo lo explorado es gap potencial'
    );
  }

  return {
    startUrl,
    pagesVisited: visited.length,
    maxPages,
    pages: visited,
    gaps: gaps.slice(0, 20),
    tip: 'Podés pedir save_test_cases con los gaps que apruebes.',
  };
}

function resolveUrl(url: string, base: string): string | null {
  if (!url && !base) return null;
  try {
    if (/^https?:\/\//i.test(url)) return url;
    if (base) return new URL(url || '/', base).toString();
    return null;
  } catch {
    return null;
  }
}

/** Resolve URL and require same origin as project base_url (SSRF guard). */
function resolveProjectUrl(
  url: string,
  base: string
): { url: string } | { error: string } {
  if (!base) {
    return {
      error:
        'Configurá base_url del proyecto. Las skills de browser solo pueden abrir URLs de ese origen.',
    };
  }
  const resolved = resolveUrl(url, base);
  if (!resolved) {
    return { error: 'Indicá url o configurá base_url del proyecto' };
  }
  try {
    const baseOrigin = new URL(base).origin;
    const targetOrigin = new URL(resolved).origin;
    if (baseOrigin !== targetOrigin) {
      return {
        error: `URL fuera del origen del proyecto (${baseOrigin}). Usá una ruta relativa o URL del mismo sitio.`,
      };
    }
  } catch {
    return { error: 'URL inválida' };
  }
  return { url: resolved };
}

function resolveFailedRun(
  projectId: number,
  args: Record<string, unknown>
): { id: number; ticket_id: string | null; status: string; result_json: string | null } | { error: string } {
  if (typeof args.run_id === 'number') {
    const run = getTestRun(args.run_id);
    if (!run || run.project_id !== projectId) {
      return { error: 'Run no encontrado en el proyecto activo' };
    }
    return run;
  }

  const ticketKey =
    typeof args.ticket_key === 'string'
      ? args.ticket_key.trim().toUpperCase()
      : '';

  const runs = listTestRuns(40, projectId);
  const failed = runs.find((r) => {
    if (ticketKey && r.ticket_id !== ticketKey) return false;
    if (r.status === 'failed') return true;
    const result = parseRunResult(r.result_json);
    if (!result) return false;
    const summary = result.summary;
    if (summary && summary.passed === false) return true;
    const exec = result.executionResults;
    return Array.isArray(exec) && exec.some((s: any) => s?.success === false);
  });

  if (!failed) {
    return {
      error: ticketKey
        ? `No hay runs fallidos recientes para ${ticketKey}`
        : 'No hay runs fallidos recientes en el proyecto',
    };
  }
  return failed;
}

function parseRunResult(
  raw: string | null
): any | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function listScreenshotsForTicket(ticketKey: string): Array<{
  name: string;
  path: string;
  url: string;
}> {
  const dir = path.join(getScreenshotsDir(), ticketKey);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      return { name, path: full, url: screenshotPublicUrl(full) };
    });
}

export function skillToolLabel(name: string): string | null {
  switch (name) {
    case 'review_test_plan':
      return 'Revisando plan de pruebas';
    case 'draft_bug':
      return 'Redactando bug';
    case 'create_jira_bug':
      return 'Creando bug en Jira';
    case 'suggest_selectors':
      return 'Sugiriendo selectores';
    case 'explore_app':
      return 'Explorando la app';
    default:
      return null;
  }
}
