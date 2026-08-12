import path from 'path';
import fs from 'fs';
import {
  listProjects,
  getProject,
  getProjectCredentials,
  getProjectPublic,
  getRunMemory,
  formatRunMemoryContext,
  listTestCases,
  replaceProjectTestCases,
  createTestRun,
  updateTestRun,
  getTestRun,
  listTestRuns,
  updateChatSession,
  getChatSession,
  getTestRunByJobId,
} from '../db';
import { getJiraClient } from '../clients/jira-mcp-client';
import {
  TicketAnalyzer,
  createSyntheticTicket,
  TestStrategy,
  type AnalyzeOptions,
} from './ticket-analyzer';
import { isInstalled } from '../plugins';
import {
  getAllowedSkillToolNames,
  getInstalledSkillPlaybooks,
} from '../skills';
import {
  SKILL_CHAT_TOOLS,
  runSkillTool,
  skillToolLabel,
} from './qa-chat-skill-tools';
import { LlmProvider, ToolDefinition } from '../llm';
import { testQueue } from '../queue';
import { logger } from '../utils/logger';
import { getScreenshotsDir } from '../paths';
import { presentRun } from '../runs/progress';

export { SKILL_CHAT_TOOLS };

export function getActiveChatTools(): ToolDefinition[] {
  const allowed = getAllowedSkillToolNames();
  const skillTools = SKILL_CHAT_TOOLS.filter((t) => allowed.has(t.name));
  return [...QA_CHAT_TOOLS, ...skillTools];
}

export { getInstalledSkillPlaybooks };

function descriptionToText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  let text = '';
  const traverse = (node: any) => {
    if (node?.type === 'text') text += `${node.text} `;
    if (Array.isArray(node?.content)) node.content.forEach(traverse);
  };
  traverse(content);
  return text.trim();
}

function extractTicketKey(ticketId?: string, ticketUrl?: string): string | null {
  if (ticketId?.trim()) return ticketId.trim().toUpperCase();
  if (!ticketUrl) return null;
  const match = ticketUrl.match(/[A-Z][A-Z0-9]+-\d+/i);
  return match ? match[0].toUpperCase() : null;
}

function screenshotPublicUrl(filePath: string): string {
  const screenshotsRoot = getScreenshotsDir();
  const abs = path.resolve(filePath);
  if (abs.startsWith(screenshotsRoot)) {
    const rel = path.relative(screenshotsRoot, abs).split(path.sep).join('/');
    return `/screenshots/${rel}`;
  }
  return filePath;
}

function listTicketScreenshotFiles(ticketKey: string): Array<{
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

export const QA_CHAT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_projects',
    description:
      'Lista los proyectos configurados en Qatin (id, nombre, base_url, jira key).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'set_active_project',
    description:
      'Fija el proyecto activo de esta conversación por id o por nombre (parcial).',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'ID numérico del proyecto' },
        name: {
          type: 'string',
          description: 'Nombre o fragmento del nombre del proyecto',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_ticket',
    description:
      'Obtiene un ticket de Jira por key/URL, o arma uno desde texto pegado (summary + description).',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        ticket_url: { type: 'string' },
        pasted_summary: { type: 'string' },
        pasted_description: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_ticket',
    description:
      'Analiza un ticket (Jira o paste) y genera resumen de entendimiento + estrategia/casos sugeridos.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        ticket_url: { type: 'string' },
        pasted_summary: { type: 'string' },
        pasted_description: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_test_cases',
    description: 'Lista casos de prueba guardados del proyecto activo (opcionalmente filtrados por ticket).',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'save_test_cases',
    description:
      'Guarda o reemplaza casos de prueba para un ticket. Podés pasar cases explícitos o una strategy con scenarios.',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: { type: 'string' },
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              case_key: { type: 'string' },
              description: { type: 'string' },
              steps: { type: 'array', items: { type: 'string' } },
              expectedResults: { type: 'array', items: { type: 'string' } },
              urls: { type: 'array', items: { type: 'string' } },
              selectors: { type: 'array', items: { type: 'string' } },
              source: { type: 'string', enum: ['manual', 'ai'] },
            },
            required: ['description'],
          },
        },
        strategy: {
          type: 'object',
          properties: {
            testType: {
              type: 'string',
              enum: ['ui', 'api', 'manual', 'mixed'],
            },
            summary: { type: 'string' },
            estimatedDuration: { type: 'number' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            scenarios: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  steps: { type: 'array', items: { type: 'string' } },
                  expectedResults: { type: 'array', items: { type: 'string' } },
                  urls: { type: 'array', items: { type: 'string' } },
                  selectors: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'description'],
              },
            },
          },
        },
      },
      required: ['ticket_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'enqueue_run',
    description:
      'Encola una ejecución de tests (Playwright) para un ticket Jira o descripción pegada. No espera el resultado final.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        ticket_url: { type: 'string' },
        pasted_summary: { type: 'string' },
        pasted_description: { type: 'string' },
        strategy: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_run_status',
    description:
      'Consulta el estado de un run (por run_id o job_id) e incluye resumen y evidencias/screenshots si hay.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'number' },
        job_id: { type: 'string' },
        wait_ms: {
          type: 'number',
          description:
            'Si se indica, espera hasta ese tiempo (máx 45000) polleando hasta completed/failed',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_recent_runs',
    description: 'Lista ejecuciones recientes del proyecto activo.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
];

export type ToolEventEmitter = (event: {
  type: 'tool_start' | 'tool_end' | 'progress';
  tool?: string;
  detail?: string;
  data?: unknown;
}) => void;

export class QaChatToolRunner {
  constructor(
    private sessionId: number,
    private emit?: ToolEventEmitter,
    private signal?: AbortSignal
  ) {}

  private requireProjectId(): number {
    const session = getChatSession(this.sessionId);
    if (!session?.project_id) {
      throw new Error(
        'No hay proyecto activo en esta conversación. Usá list_projects y set_active_project.'
      );
    }
    return session.project_id;
  }

  async run(name: string, argsJson: string): Promise<unknown> {
    if (this.signal?.aborted) {
      return { error: 'aborted' };
    }

    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      args = {};
    }

    this.emit?.({ type: 'tool_start', tool: name, detail: toolLabel(name), data: args });

    try {
      const result = await this.dispatch(name, args);
      this.emit?.({
        type: 'tool_end',
        tool: name,
        detail: toolLabel(name),
        data: summarizeToolResult(name, result),
      });
      return result;
    } catch (error: any) {
      if (error?.name === 'AbortError' || this.signal?.aborted) {
        this.emit?.({
          type: 'tool_end',
          tool: name,
          detail: 'Detenido',
          data: { error: 'aborted' },
        });
        return { error: 'aborted' };
      }
      const message = error?.message || String(error);
      this.emit?.({
        type: 'tool_end',
        tool: name,
        detail: `Error: ${message}`,
        data: { error: message },
      });
      return { error: message };
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const skillNames = new Set(SKILL_CHAT_TOOLS.map((t) => t.name));
    if (skillNames.has(name)) {
      const projectId = this.requireProjectId();
      return runSkillTool(name, args, projectId);
    }

    switch (name) {
      case 'list_projects':
        return {
          projects: listProjects().map((p) => ({
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            jira_project_key: p.jira_project_key,
            has_password: p.has_password,
          })),
        };

      case 'set_active_project': {
        let projectId =
          typeof args.project_id === 'number' ? args.project_id : null;
        const nameHint =
          typeof args.name === 'string' ? args.name.trim().toLowerCase() : '';

        if (!projectId && nameHint) {
          const matches = listProjects().filter((p) =>
            p.name.toLowerCase().includes(nameHint)
          );
          if (matches.length === 1) projectId = matches[0].id;
          else if (matches.length > 1) {
            return {
              error: 'Varios proyectos coinciden; pedí el id exacto',
              matches: matches.map((p) => ({ id: p.id, name: p.name })),
            };
          }
        }

        if (!projectId) {
          return { error: 'Indicá project_id o name' };
        }

        const project = getProjectPublic(projectId);
        if (!project) return { error: 'Proyecto no encontrado' };

        updateChatSession(this.sessionId, {
          project_id: projectId,
          title: `QA · ${project.name}`,
        });

        return {
          ok: true,
          project: {
            id: project.id,
            name: project.name,
            base_url: project.base_url,
            jira_project_key: project.jira_project_key,
          },
        };
      }

      case 'fetch_ticket':
        return this.fetchTicket(args);

      case 'analyze_ticket':
        return this.analyzeTicket(args);

      case 'list_test_cases': {
        const projectId = this.requireProjectId();
        const ticketKey =
          typeof args.ticket_key === 'string'
            ? args.ticket_key.trim().toUpperCase()
            : null;
        const cases = listTestCases({ projectId, ticketKey });
        return { cases, total: cases.length };
      }

      case 'save_test_cases':
        return this.saveTestCases(args);

      case 'enqueue_run':
        return this.enqueueRun(args);

      case 'get_run_status':
        return this.getRunStatus(args);

      case 'list_recent_runs': {
        const projectId = this.requireProjectId();
        const limit =
          typeof args.limit === 'number' && args.limit > 0
            ? Math.min(args.limit, 50)
            : 10;
        const runs = listTestRuns(limit, projectId).map((r) => {
          const presented = presentRun(r);
          return {
            id: presented.id,
            ticket_id: presented.ticket_id,
            status: presented.status,
            phase: presented.phase,
            phaseLabel: presented.phaseLabel,
            followPath: presented.followPath,
            job_id: presented.job_id,
            source: presented.source,
            created_at: presented.created_at,
          };
        });
        return { runs };
      }

      default:
        return { error: `Tool desconocida: ${name}` };
    }
  }

  private async fetchTicket(args: Record<string, unknown>) {
    const pastedSummary =
      typeof args.pasted_summary === 'string' ? args.pasted_summary : null;
    const pastedDescription =
      typeof args.pasted_description === 'string'
        ? args.pasted_description
        : null;

    if (pastedSummary && pastedDescription) {
      const ticket = createSyntheticTicket({
        summary: pastedSummary,
        description: pastedDescription,
      });
      return {
        source: 'paste',
        ticket: {
          key: ticket.key,
          summary: ticket.fields.summary,
          description: pastedDescription,
          type: ticket.fields.issuetype.name,
          status: ticket.fields.status.name,
          priority: ticket.fields.priority?.name || 'Medium',
        },
      };
    }

    const ticketId = extractTicketKey(
      typeof args.ticket_id === 'string' ? args.ticket_id : undefined,
      typeof args.ticket_url === 'string' ? args.ticket_url : undefined
    );
    if (!ticketId) {
      return {
        error: 'Indicá ticket_id, ticket_url, o pasted_summary + pasted_description',
      };
    }

    const jiraClient = await getJiraClient();
    const issue = await jiraClient.getIssue(ticketId);
    return {
      source: 'jira',
      ticket: {
        key: issue.key,
        summary: issue.fields.summary,
        description: descriptionToText(issue.fields.description),
        type: issue.fields.issuetype?.name || 'Unknown',
        status: issue.fields.status?.name || 'Unknown',
        priority: issue.fields.priority?.name || 'Medium',
        labels: issue.fields.labels || [],
      },
    };
  }

  private async analyzeTicket(args: Record<string, unknown>) {
    const projectId = this.requireProjectId();
    const project = getProject(projectId);
    if (!project) return { error: 'Proyecto no encontrado' };

    const fetched = await this.fetchTicket(args);
    if ((fetched as any).error) return fetched;

    const { source, ticket } = fetched as {
      source: 'jira' | 'paste';
      ticket: {
        key: string;
        summary: string;
        description: string;
        type: string;
        status: string;
        priority: string;
        labels?: string[];
      };
    };

    const analyzable =
      source === 'paste'
        ? createSyntheticTicket({
            key: ticket.key,
            summary: ticket.summary,
            description: ticket.description,
          })
        : await (await getJiraClient()).getIssue(ticket.key);

    const analyzeOptions: AnalyzeOptions = {
      signal: this.signal,
    };

    const started = Date.now();
    let lastTokens = 0;
    let lastProg = 0;
    const emitAnalyzeProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProg < 200) return;
      lastProg = now;
      const sec = Math.max(1, Math.round((now - started) / 1000));
      const detail =
        lastTokens > 0
          ? `Analizando ticket · ${lastTokens} tokens · ${sec}s`
          : `Analizando ticket · ${sec}s`;
      this.emit?.({
        type: 'progress',
        tool: 'analyze_ticket',
        detail,
      });
    };
    analyzeOptions.onProgress = (tokens) => {
      lastTokens = tokens;
      emitAnalyzeProgress();
    };

    if (isInstalled('engram')) {
      const memories = getRunMemory({
        projectId,
        ticketKey: ticket.key,
        limit: 5,
      });
      const ctx = formatRunMemoryContext(memories);
      if (ctx) analyzeOptions.memoryContext = ctx;
    }

    const analyzer = new TicketAnalyzer({
      provider: (project.llm_provider as LlmProvider | null) || undefined,
      model: project.llm_model || undefined,
      baseUrl: project.llm_base_url || undefined,
    });

    let strategy: TestStrategy;
    let usedFallback = false;
    const tick = setInterval(() => emitAnalyzeProgress(true), 1000);
    try {
      strategy = await analyzer.analyzeTicket(analyzable as any, analyzeOptions);
    } catch (error) {
      logger.warn('Chat analyze: AI failed, using fallback', error);
      strategy = await analyzer.generateFallbackStrategy(
        analyzable as any,
        analyzeOptions
      );
      usedFallback = true;
    } finally {
      clearInterval(tick);
    }

    return {
      success: true,
      source,
      usedFallback,
      ticket,
      understanding: strategy.summary,
      strategy,
    };
  }

  private saveTestCases(args: Record<string, unknown>) {
    const projectId = this.requireProjectId();
    const ticketKey =
      typeof args.ticket_key === 'string'
        ? args.ticket_key.trim().toUpperCase()
        : '';
    if (!ticketKey) return { error: 'ticket_key es requerido' };

    const strategy = args.strategy as TestStrategy | undefined;
    const casesInput = Array.isArray(args.cases) ? args.cases : null;

    let cases: Array<{
      case_key: string;
      description: string;
      steps?: string[];
      expectedResults?: string[];
      urls?: string[];
      selectors?: string[];
      source?: 'manual' | 'ai';
    }> = [];

    if (casesInput?.length) {
      cases = casesInput.map((c: any, i: number) => ({
        case_key: String(c.case_key || `TC-${i + 1}`),
        description: c.description,
        steps: c.steps || [],
        expectedResults: c.expectedResults || [],
        urls: c.urls,
        selectors: c.selectors,
        source: c.source || 'ai',
      }));
    } else if (strategy?.scenarios?.length) {
      cases = strategy.scenarios.map((s, i) => ({
        case_key: s.id || `TC-${i + 1}`,
        description: s.description,
        steps: s.steps || [],
        expectedResults: s.expectedResults || [],
        urls: s.urls,
        selectors: s.selectors,
        source: 'ai' as const,
      }));
    } else {
      return { error: 'Indicá cases o strategy.scenarios' };
    }

    const saved = replaceProjectTestCases({
      projectId,
      ticketKey,
      cases,
    });

    return { ok: true, ticket_key: ticketKey, cases: saved, total: saved.length };
  }

  private async enqueueRun(args: Record<string, unknown>) {
    const projectId = this.requireProjectId();
    const project = getProject(projectId);
    if (!project) return { error: 'Proyecto no encontrado' };

    let source: 'jira' | 'paste' = 'jira';
    let ticketId: string | undefined;
    let pastedSummary: string | undefined;
    let pastedDescription: string | undefined;

    const pastedS =
      typeof args.pasted_summary === 'string' ? args.pasted_summary : null;
    const pastedD =
      typeof args.pasted_description === 'string'
        ? args.pasted_description
        : null;

    if (pastedS && pastedD) {
      source = 'paste';
      pastedSummary = pastedS;
      pastedDescription = pastedD;
      ticketId = `PASTE-${Date.now()}`;
    } else {
      ticketId =
        extractTicketKey(
          typeof args.ticket_id === 'string' ? args.ticket_id : undefined,
          typeof args.ticket_url === 'string' ? args.ticket_url : undefined
        ) || undefined;
      if (!ticketId) {
        return {
          error: 'Indicá ticket_id/ticket_url o pasted_summary + pasted_description',
        };
      }
    }

    const credentials = getProjectCredentials(project);
    const llmProvider = (project.llm_provider as LlmProvider | null) || undefined;
    const strategy = args.strategy as TestStrategy | undefined;

    const run = createTestRun({
      project_id: projectId,
      source,
      ticket_id: ticketId,
      pasted_summary: pastedSummary || null,
      pasted_description: pastedDescription || null,
      status: 'queued',
    });

    const job = await testQueue.add('test-ticket', {
      ticketId,
      projectId,
      runId: run.id,
      source,
      pastedTicket:
        source === 'paste'
          ? { summary: pastedSummary, description: pastedDescription }
          : undefined,
      strategy,
      projectConfig: {
        baseUrl: project.base_url || process.env.APP_BASE_URL,
        stagingUrl: project.staging_url || process.env.APP_STAGING_URL,
        testUserEmail: credentials.email || process.env.TEST_USER_EMAIL,
        testUserPassword: credentials.password || process.env.TEST_USER_PASSWORD,
        llmProvider,
        llmModel: project.llm_model || undefined,
        llmBaseUrl: project.llm_base_url || undefined,
        jiraUrl: project.jira_url || undefined,
        jiraProjectKey: project.jira_project_key || undefined,
      },
      timestamp: Date.now(),
      requestedBy: 'chat-agent',
    });

    updateTestRun(run.id, { job_id: String(job.id), status: 'queued' });

    return {
      ok: true,
      runId: run.id,
      jobId: String(job.id),
      ticketId,
      source,
      followPath: `/runs?id=${run.id}`,
      userHint:
        'Decile al usuario que la corrida quedó en cola y que puede seguir el progreso paso a paso en Ejecuciones. Incluí el enlace followPath. Nunca menciones nombres de herramientas.',
    };
  }

  private async getRunStatus(args: Record<string, unknown>) {
    let run =
      typeof args.run_id === 'number' ? getTestRun(args.run_id) : null;

    if (!run && typeof args.job_id === 'string') {
      run = getTestRunByJobId(args.job_id);
    }

    if (!run) return { error: 'Run no encontrado' };

    const waitMs = Math.min(
      typeof args.wait_ms === 'number' && args.wait_ms > 0 ? args.wait_ms : 0,
      45_000
    );

    const pollOnce = async () => {
      const current = getTestRun(run!.id)!;
      let jobState: string | null = null;
      let progress: number | null = null;
      let failedReason: string | null = null;

      if (current.job_id) {
        try {
          const job = await testQueue.getJob(current.job_id);
          if (job) {
            jobState = await job.getState();
            progress =
              typeof job.progress() === 'number'
                ? (job.progress() as number)
                : null;
            failedReason = job.failedReason || null;
          }
        } catch (err) {
          logger.warn('get_run_status job lookup failed', err);
        }
      }

      let result: unknown = null;
      if (current.result_json) {
        try {
          result = JSON.parse(current.result_json);
        } catch {
          result = null;
        }
      }

      const ticketKey = current.ticket_id || '';
      const screenshots = ticketKey
        ? listTicketScreenshotFiles(ticketKey)
        : [];

      const fromResult =
        result &&
        typeof result === 'object' &&
        Array.isArray((result as any).screenshots)
          ? ((result as any).screenshots as Array<{ name: string; path: string }>).map(
              (s) => ({
                name: s.name,
                path: s.path,
                url: screenshotPublicUrl(s.path),
              })
            )
          : [];

      const evidence = fromResult.length ? fromResult : screenshots;
      const presented = presentRun(current);
      const phase = presented.phase;

      return {
        runId: current.id,
        jobId: current.job_id,
        ticketId: current.ticket_id,
        status: current.status,
        phase,
        phaseLabel: presented.phaseLabel,
        currentStep: presented.currentStep,
        followPath: presented.followPath,
        jobState,
        progress,
        failedReason,
        summary:
          result && typeof result === 'object'
            ? (result as any).summary || null
            : null,
        details:
          result && typeof result === 'object'
            ? (result as any).details || null
            : null,
        executionResults:
          result && typeof result === 'object'
            ? (result as any).executionResults || null
            : null,
        screenshots: evidence,
        updated_at: current.updated_at,
      };
    };

    let status = await pollOnce();
    if (
      waitMs > 0 &&
      status.status !== 'completed' &&
      status.status !== 'failed'
    ) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (this.signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        this.emit?.({
          type: 'progress',
          tool: 'get_run_status',
          detail: status.currentStep
            ? status.currentStep
            : `Esperando run #${run.id} · ${status.phaseLabel}${
                status.progress != null ? ` · ${status.progress}%` : ''
              }`,
        });
        await sleep(2000, this.signal);
        status = await pollOnce();
        if (status.status === 'completed' || status.status === 'failed') break;
      }
    }

    return status;
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toolLabel(name: string): string {
  const skill = skillToolLabel(name);
  if (skill) return skill;
  switch (name) {
    case 'list_projects':
      return 'Listando proyectos';
    case 'set_active_project':
      return 'Eligiendo proyecto';
    case 'fetch_ticket':
      return 'Leyendo ticket';
    case 'analyze_ticket':
      return 'Analizando ticket';
    case 'list_test_cases':
      return 'Listando casos';
    case 'save_test_cases':
      return 'Guardando casos';
    case 'enqueue_run':
      return 'Encolando ejecución';
    case 'get_run_status':
      return 'Consultando ejecución';
    case 'list_recent_runs':
      return 'Listando ejecuciones';
    default:
      return name;
  }
}

function summarizeToolResult(name: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as any;
  if (r.error) return { error: r.error };
  switch (name) {
    case 'list_projects':
      return { count: r.projects?.length ?? 0 };
    case 'set_active_project':
      return { project: r.project?.name };
    case 'fetch_ticket':
    case 'analyze_ticket':
      return { ticket: r.ticket?.key || r.ticket?.summary };
    case 'save_test_cases':
      return { total: r.total, ticket_key: r.ticket_key };
    case 'enqueue_run':
      return { runId: r.runId, jobId: r.jobId, followPath: r.followPath };
    case 'get_run_status':
      return {
        status: r.status,
        phase: r.phase,
        screenshots: r.screenshots?.length ?? 0,
      };
    case 'list_recent_runs':
      return { count: r.runs?.length ?? 0 };
    case 'review_test_plan':
      return {
        readyToEnqueue: r.readyToEnqueue,
        findings: r.findings?.length ?? 0,
      };
    case 'draft_bug':
      return { summary: r.summary, runId: r.runId };
    case 'create_jira_bug':
      return { key: r.key, url: r.url };
    case 'suggest_selectors':
      return { count: r.recommendations?.length ?? 0, url: r.url };
    case 'explore_app':
      return { pages: r.pagesVisited, gaps: r.gaps?.length ?? 0 };
    default:
      return {};
  }
}
