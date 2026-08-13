import path from 'path';
import {
  listProjects,
  getProject,
  getProjectCredentials,
  getProjectPublic,
  getRunMemory,
  listTestCases,
  replaceProjectTestCases,
  createTestRun,
  updateTestRun,
  getTestRun,
  listTestRuns,
  updateChatSession,
  getChatSession,
  getTestRunByJobId,
  listChatMessages,
} from '../db';
import { getJiraClient } from '../clients/jira-mcp-client';
import {
  TicketAnalyzer,
  createSyntheticTicket,
  TestStrategy,
  type AnalyzeOptions,
  parseTestCoverage,
  detectTestSurface,
  buildTicketUnderstanding,
  extractCommentsText,
  mergeTicketText,
} from './ticket-analyzer';
import { formatJiraCommentsText } from '../clients/jira-client';
import {
  formatRunMemoryContext,
  buildFewShotFromProject,
} from './qa-memory';
import { lintTestCases } from './test-case-lint';
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
import { presentRun, screenshotsForRun } from '../runs/progress';
import { publishRunToJira } from '../runs/manage';
import {
  buildStrategyFromSavedCases,
  CASES_REQUIRED_ERROR,
} from '../runs/strategy-from-cases';
import { buildGroupedXrayManualTest, type XrayScenarioInput } from './xray-case-builder';
import {
  generatePlaywrightSpecs,
  hasPlaywrightSpecsOnDisk,
} from './playwright-spec-generator';
import { discoverApiContract } from './api-contract-discovery';
import {
  extractJiraTicketKey,
  isTestCaseKey,
  resolveTicketKey,
} from '../utils/ticket-key';

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
      'Obtiene un ticket de Jira por key/URL (incluye comentarios: el dev suele dejar cómo testearlo), o arma uno desde texto pegado (summary + description). Devuelve también understanding (superficie BE/UI, modos del CA, checklist de qué testear, notas de comentarios) — usalo al explicar el ticket.',
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
      'Analiza un ticket (Jira o paste) y genera resumen + casos. Pasá coverage cuando el usuario ya eligió: happy, unhappy, corner o all. NO llamar si pidió crear casos y todavía no dijo qué cobertura quiere.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string' },
        ticket_url: { type: 'string' },
        pasted_summary: { type: 'string' },
        pasted_description: { type: 'string' },
        coverage: {
          type: 'string',
          enum: ['happy', 'unhappy', 'corner', 'all'],
          description:
            'happy = solo camino feliz; unhappy = negativos; corner = bordes; all = los tres',
        },
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
              apiEndpoints: { type: 'array', items: { type: 'string' } },
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
                  kind: {
                    type: 'string',
                    enum: ['happy', 'unhappy', 'corner'],
                  },
                  steps: { type: 'array', items: { type: 'string' } },
                  expectedResults: { type: 'array', items: { type: 'string' } },
                  urls: { type: 'array', items: { type: 'string' } },
                  selectors: { type: 'array', items: { type: 'string' } },
                  apiEndpoints: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'description'],
              },
            },
          },
        },
        force: {
          type: 'boolean',
          description:
            'Si true, guarda aunque el lint bloquee (solo si el usuario pide explícitamente guardar igual).',
        },
      },
      required: ['ticket_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_playwright_specs',
    description:
      'Genera scripts Playwright Test (.spec.ts) a partir de los casos GUARDADOS del ticket. No inventa escenarios. Si no hay casos, devuelve cases_required. Devolvés el contenido para mostrarlo en un fence typescript listo para descargar.',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: {
          type: 'string',
          description: 'Clave del ticket (ej. AGDCF-4790) o PASTE-…',
        },
        ticket_id: { type: 'string' },
        ticket_url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'discover_api_contract',
    description:
      'Descubre el contrato API REAL por consola/Network: login con el usuario QA del proyecto, inyecta auth en la SPA, visita pantallas, captura llamadas /api/* y sugiere ACOPIO_ID/CAMPANIA_ID (JWT + URLs). Usalo cuando falten IDs/params o haya pasos "pendiente confirmar en Network". Nunca inventa.',
    parameters: {
      type: 'object',
      properties: {
        start_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Rutas SPA a abrir (ej. /v2/gestionar-plan-comercial). Default: home + pantallas PC/clientes.',
        },
        click_labels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Textos a clickear mientras se captura Network (filtros, menús).',
        },
        match_path: {
          type: 'string',
          description:
            'Fragmento de path a priorizar en matches (ej. cuenta/client/acopio).',
        },
        url_includes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filtro de URLs a capturar (default /api/).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export_xray_csv',
    description:
      'Arma UN solo Test manual de Xray por ticket (CSV Test Case Importer). Agrupa todos los escenarios (TC-01, TC-02…) como Actions del mismo Issue Id. Columnas: Issue Id, Summary, Description, Test Type, Step (=Action), Data, Expected Result (=Result). OBLIGATORIO: pasar strategy COMPLETA de analyze_ticket (cada scenario con steps[] y expectedResults[] — idealmente 1 expected por step). No pases solo id+description. Mostrá el csv del resultado en un fence ```csv.',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: {
          type: 'string',
          description: 'Clave del ticket (ej. AGDCF-4790) o PASTE-…',
        },
        ticket_id: { type: 'string' },
        ticket_url: { type: 'string' },
        ticket_summary: {
          type: 'string',
          description: 'Summary de Jira del ticket (opcional).',
        },
        understanding: {
          type: 'string',
          description:
            'Qué se entendió que hay que probar (strategy.summary). Si falta, se deriva de los escenarios.',
        },
        coverage: {
          type: 'string',
          description: 'happy | unhappy | corner | all (opcional, para la Description).',
        },
        strategy: {
          type: 'object',
          description:
            'Strategy COMPLETA de analyze_ticket: summary + scenarios[]. Cada scenario DEBE traer steps[] y expectedResults[] (uno por step). Si mandás solo id/description el export falla.',
          properties: {
            summary: { type: 'string' },
            scenarios: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  description: { type: 'string' },
                  kind: { type: 'string' },
                  steps: { type: 'array', items: { type: 'string' } },
                  expectedResults: { type: 'array', items: { type: 'string' } },
                },
                required: ['description'],
              },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enqueue_run',
    description:
      'Encola Playwright SOLO si ya hay casos guardados para el ticket (save_test_cases). Si no hay casos, devuelve error cases_required — no inventes ni regeneres al vuelo. Antes de encolar genera .spec.ts si aún no existen (best-effort). No espera el resultado final.',
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
    name: 'publish_results_to_jira',
    description:
      'Publica los resultados de una ejecución terminada en el ticket Jira (comentario, screenshots, label y transición QA). Solo después de que el usuario confirme explícitamente. No se publica solo.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'number' },
        confirmed: {
          type: 'boolean',
          description: 'Debe ser true solo si el usuario confirmó publicar en Jira',
        },
      },
      required: ['run_id', 'confirmed'],
      additionalProperties: false,
    },
  },
  {
    name: 'jira_get_comments',
    description:
      'Lee los comentarios de un ticket Jira. Útil para buscar notas del dev (endpoints, IDs, cómo testear) sin volver a traer todo el ticket.',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: {
          type: 'string',
          description: 'Clave del ticket (ej. AGDCF-4790)',
        },
      },
      required: ['ticket_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'jira_post_comment',
    description:
      'Postea un comentario en un ticket Jira (formato texto plano o ADF). SOLO después de que el usuario confirme explícitamente. Nunca postear automáticamente.',
    parameters: {
      type: 'object',
      properties: {
        ticket_key: {
          type: 'string',
          description: 'Clave del ticket (ej. AGDCF-4790)',
        },
        body: {
          type: 'string',
          description: 'Texto del comentario a postear',
        },
        confirmed: {
          type: 'boolean',
          description: 'Debe ser true solo si el usuario confirmó postear el comentario',
        },
      },
      required: ['ticket_key', 'body', 'confirmed'],
      additionalProperties: false,
    },
  },
  {
    name: 'jira_search',
    description:
      'Busca tickets en Jira por JQL. Útil para encontrar tickets relacionados (épica padre, stories hermanas, bugs previos del mismo módulo) y obtener contexto extra cuando un ticket es escueto.',
    parameters: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description:
            'JQL query (ej. "project = AGDCF AND type = Epic AND summary ~ liquidacion", o "issue in linkedIssues(AGDCF-4790)")',
        },
        max_results: {
          type: 'number',
          description: 'Máximo de resultados (default 10, max 25)',
        },
      },
      required: ['jql'],
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

  /**
   * Prefer an explicit Jira key; if the model passes TC-01 or nothing,
   * fall back to the latest real ticket key in the chat / saved cases.
   */
  private resolveTicketArg(
    ticketId?: string,
    ticketUrl?: string
  ): string | null {
    const direct = resolveTicketKey(ticketId, ticketUrl);
    if (direct) return direct;

    if (ticketId && isTestCaseKey(ticketId)) {
      logger.warn('QaChatToolRunner ignoring test-case id as ticket', {
        sessionId: this.sessionId,
        ticketId,
      });
    }

    const rows = listChatMessages(this.sessionId);
    for (let i = rows.length - 1; i >= 0; i--) {
      const key = extractJiraTicketKey(rows[i].content || '');
      if (key) return key;
    }

    try {
      const projectId = this.requireProjectId();
      const cases = listTestCases({ projectId });
      for (let i = cases.length - 1; i >= 0; i--) {
        const key = (cases[i].ticket_key || '').toUpperCase();
        if (key && !isTestCaseKey(key) && !key.startsWith('PASTE-')) {
          return key;
        }
      }
    } catch {
      // no active project
    }
    return null;
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
            test_user_email: p.test_user_email,
            hasQaCredentials: Boolean(p.test_user_email && p.has_password),
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
            has_password: project.has_password,
            test_user_email: project.test_user_email,
            hasQaCredentials: Boolean(
              project.test_user_email && project.has_password
            ),
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

      case 'generate_playwright_specs':
        return this.generatePlaywrightSpecsTool(args);

      case 'discover_api_contract':
        return this.discoverApiContractTool(args);

      case 'export_xray_csv':
        return this.exportXrayCsvTool(args);

      case 'enqueue_run':
        return this.enqueueRun(args);

      case 'get_run_status':
        return this.getRunStatus(args);

      case 'jira_search':
        return this.jiraSearch(args);

      case 'jira_get_comments':
        return this.jiraGetComments(args);

      case 'jira_post_comment':
        return this.jiraPostComment(args);

      case 'publish_results_to_jira':
        return this.publishResultsToJira(args);

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
            jiraPosted: presented.jiraPosted,
            canPublishToJira: presented.canPublishToJira,
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
      const understanding = buildTicketUnderstanding({
        summary: ticket.fields.summary,
        description: pastedDescription,
        labels: ticket.fields.labels,
        issuetype: ticket.fields.issuetype.name,
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
        understanding: {
          surface: understanding.surface,
          successModes: understanding.successModes,
          acceptanceCriteria: understanding.acceptanceCriteria,
          checklist: understanding.checklist,
          text: understanding.text,
        },
        hint: 'Presentá understanding.text al usuario (superficie, qué es, modos, validaciones, entidades, cardinalidad). No inventes cobertura ni pidas coverage en análisis puro.',
      };
    }

    const ticketId = this.resolveTicketArg(
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
    const description = descriptionToText(issue.fields.description);
    const comments = formatJiraCommentsText(issue.fields.comment);
    const understanding = buildTicketUnderstanding({
      summary: issue.fields.summary,
      description,
      comments,
      labels: issue.fields.labels || [],
      issuetype: issue.fields.issuetype?.name,
    });
    return {
      source: 'jira',
      ticket: {
        key: issue.key,
        summary: issue.fields.summary,
        description,
        comments: comments || undefined,
        type: issue.fields.issuetype?.name || 'Unknown',
        status: issue.fields.status?.name || 'Unknown',
        priority: issue.fields.priority?.name || 'Medium',
        labels: issue.fields.labels || [],
      },
      understanding: {
        surface: understanding.surface,
        successModes: understanding.successModes,
        acceptanceCriteria: understanding.acceptanceCriteria,
        checklist: understanding.checklist,
        text: understanding.text,
      },
      hint: 'Presentá understanding.text al usuario (superficie, qué es, notas de comentarios del dev, modos, validaciones). Priorizá cómo testear / IDs / endpoints citados en comentarios. No inventes cobertura ni pidas coverage en análisis puro.',
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
        comments?: string;
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

    const coverage = parseTestCoverage(args.coverage);
    if (!coverage) {
      return {
        error: 'coverage_required',
        code: 'coverage_required',
        hint: 'Preguntá brevemente por la cobertura (la UI muestra botones; no listes opciones para tipear). Después llamá analyze_ticket con coverage.',
      };
    }

    const analyzeOptions: AnalyzeOptions = {
      signal: this.signal,
      coverage,
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

    // Always inject prior run memory + few-shot from this project.
    const memories = getRunMemory({
      projectId,
      ticketKey: ticket.key,
      limit: 5,
    });
    const ctx = formatRunMemoryContext(memories);
    if (ctx) analyzeOptions.memoryContext = ctx;

    const commentsText =
      ticket.comments ||
      (source === 'jira' ? extractCommentsText(analyzable as any) : '');
    const fewShot = buildFewShotFromProject(projectId, {
      excludeTicketKey: ticket.key,
      limit: 2,
      surface: detectTestSurface({
        summary: ticket.summary,
        description: mergeTicketText(ticket.description, commentsText),
        labels: ticket.labels,
        issuetype: ticket.type,
      }),
    });
    if (fewShot) analyzeOptions.fewShotExamples = fewShot;

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
      coverage: analyzeOptions.coverage,
      understanding: strategy.summary,
      strategy,
      lint: lintTestCases(
        strategy.scenarios.map((s) => ({
          case_key: s.id,
          description: s.description,
          steps: s.steps,
          expectedResults: s.expectedResults,
          urls: s.urls,
          selectors: s.selectors,
          apiEndpoints: s.apiEndpoints,
        })),
        { testType: strategy.testType }
      ),
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
      apiEndpoints?: string[];
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
        apiEndpoints: c.apiEndpoints,
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
        apiEndpoints: s.apiEndpoints,
        source: 'ai' as const,
      }));
    } else {
      return { error: 'Indicá cases o strategy.scenarios' };
    }

    const lint = lintTestCases(cases, { testType: strategy?.testType });
    const force = args.force === true;
    if (!lint.ok && !force) {
      return {
        error: 'cases_lint_failed',
        code: 'cases_lint_failed',
        lint,
        hint: 'Corregí los hallazgos altos (pasos vagos, sin comillas, sin navegación o sin expectedResults) y volvé a guardar. Si el usuario pide guardar igual, llamá con force=true.',
      };
    }

    const saved = replaceProjectTestCases({
      projectId,
      ticketKey,
      cases,
    });

    return {
      ok: true,
      ticket_key: ticketKey,
      cases: saved,
      total: saved.length,
      lint,
      forcedSave: force && !lint.ok,
    };
  }

  private generatePlaywrightSpecsTool(args: Record<string, unknown>) {
    const projectId = this.requireProjectId();
    const project = getProject(projectId);
    if (!project) return { error: 'Proyecto no encontrado' };

    const ticketKey =
      (typeof args.ticket_key === 'string' && args.ticket_key.trim()
        ? args.ticket_key.trim().toUpperCase()
        : null) ||
      this.resolveTicketArg(
        typeof args.ticket_id === 'string' ? args.ticket_id : undefined,
        typeof args.ticket_url === 'string' ? args.ticket_url : undefined
      );

    if (!ticketKey) {
      return {
        error: 'Indicá ticket_key, ticket_id o ticket_url',
      };
    }

    const strategy = buildStrategyFromSavedCases(projectId, ticketKey);
    if (!strategy) {
      return {
        error: CASES_REQUIRED_ERROR,
        code: 'cases_required',
        ticketId: ticketKey,
        hint: 'Usá analyze_ticket → save_test_cases, y recién después generate_playwright_specs.',
      };
    }

    try {
      const credentials = getProjectCredentials(project);
      const hasQaCredentials = Boolean(
        credentials.email && credentials.password
      );
      const generated = generatePlaywrightSpecs({
        strategy,
        ticketKey,
        baseUrl: project.base_url || process.env.APP_BASE_URL,
        write: true,
      });
      return {
        ok: true,
        ticketKey: generated.ticketKey,
        scenarioCount: generated.scenarioCount,
        files: generated.files.map((f) => ({
          path: f.relativePath,
          filename: f.filename,
          content: f.content,
        })),
        hasQaCredentials,
        testUserEmail: credentials.email || null,
        authNote: hasQaCredentials
          ? 'Las credenciales QA del proyecto se usan al ejecutar via Qatin. No pidas email/password/API_TOKEN al usuario.'
          : 'El proyecto no tiene usuario QA. Pedile que lo configure en Proyectos (no en el chat).',
        hint: 'Mostrá el contenido de files[0].content en un fence ```typescript listo para descargar. No reescribas ni inventes el código. No pidas credenciales si hasQaCredentials=true.',
      };
    } catch (err) {
      logger.warn('generate_playwright_specs failed', err);
      return {
        error:
          err instanceof Error
            ? err.message
            : 'No se pudieron generar los scripts Playwright',
      };
    }
  }

  private async discoverApiContractTool(args: Record<string, unknown>) {
    const projectId = this.requireProjectId();
    const project = getProject(projectId);
    if (!project) return { error: 'Proyecto no encontrado' };
    if (!project.base_url) {
      return {
        error:
          'El proyecto no tiene base_url. Configurala en Proyectos para poder abrir la SPA.',
      };
    }

    const credentials = getProjectCredentials(project);
    if (!credentials.email || !credentials.password) {
      return {
        error:
          'Faltan credenciales QA del proyecto (mail/password de test en Proyectos).',
      };
    }

    const startPaths = Array.isArray(args.start_paths)
      ? args.start_paths.filter((x): x is string => typeof x === 'string')
      : undefined;
    const clickLabels = Array.isArray(args.click_labels)
      ? args.click_labels.filter((x): x is string => typeof x === 'string')
      : undefined;
    const urlIncludes = Array.isArray(args.url_includes)
      ? args.url_includes.filter((x): x is string => typeof x === 'string')
      : undefined;
    const matchPath =
      typeof args.match_path === 'string' ? args.match_path.trim() : null;

    this.emit?.({
      type: 'progress',
      detail: 'Descubriendo contrato API (login QA + Network)…',
    });

    const result = await discoverApiContract({
      baseUrl: project.base_url,
      email: credentials.email,
      password: credentials.password,
      startPaths,
      clickLabels,
      urlIncludes,
      matchPath,
    });

    if (!result.ok) {
      return {
        error: result.error || 'No se pudo descubrir el contrato',
        notes: result.notes,
      };
    }

    return {
      ok: true,
      apiBase: result.apiBase,
      visited: result.visited,
      matchCount: result.matches.length,
      callCount: result.calls.length,
      matches: result.matches.slice(0, 15).map((c) => ({
        method: c.method,
        path: c.path,
        query: c.query,
        status: c.status,
        resourceIds: c.resourceIds,
        requestBody: c.requestBody?.slice(0, 300) || null,
        responsePreview: c.responsePreview?.slice(0, 200) || null,
      })),
      suggestedEnv: result.suggestedEnv,
      jwtClaims: result.jwtClaims || null,
      notes: result.notes,
      hint:
        'Usá suggestedEnv (ACOPIO_ID/CAMPANIA_ID) y matches[].method/path/query para reescribir casos. No inventes params que no aparezcan acá. Si falta CAMPANIA_ID, pedí start_paths/click_labels de la pantalla FE o reintentá discovery.',
    };
  }

  private async exportXrayCsvTool(args: Record<string, unknown>) {
    const projectId = this.requireProjectId();
    const project = getProject(projectId);

    const ticketKey =
      (typeof args.ticket_key === 'string' && args.ticket_key.trim()
        ? args.ticket_key.trim().toUpperCase()
        : null) ||
      this.resolveTicketArg(
        typeof args.ticket_id === 'string' ? args.ticket_id : undefined,
        typeof args.ticket_url === 'string' ? args.ticket_url : undefined
      );

    const strategyArg = args.strategy as
      | {
          summary?: string;
          scenarios?: Array<Record<string, unknown>>;
        }
      | undefined;

    const fromStrategy: XrayScenarioInput[] = Array.isArray(
      strategyArg?.scenarios
    )
      ? strategyArg!.scenarios!
          .map((s) => ({
            caseKey:
              typeof s.id === 'string' && s.id.trim() ? s.id.trim() : undefined,
            description:
              typeof s.description === 'string' ? s.description.trim() : '',
            kind: typeof s.kind === 'string' ? s.kind : undefined,
            steps: Array.isArray(s.steps)
              ? s.steps.filter((x): x is string => typeof x === 'string')
              : [],
            expectedResults: Array.isArray(s.expectedResults)
              ? s.expectedResults.filter(
                  (x): x is string => typeof x === 'string'
                )
              : [],
          }))
          .filter((c) => c.description || (c.steps && c.steps.length))
      : [];

    let scenarios: XrayScenarioInput[] = fromStrategy;
    let source: 'strategy' | 'saved' = 'strategy';

    if (!scenarios.length) {
      if (!ticketKey) {
        return {
          error:
            'Pasá strategy (de analyze_ticket) o ticket_key con casos guardados',
        };
      }
      const saved = listTestCases({ projectId, ticketKey });
      scenarios = saved.map((c) => ({
        caseKey: c.case_key,
        description: c.description,
        steps: c.steps,
        expectedResults: c.expectedResults,
      }));
      source = 'saved';
    }

    if (!scenarios.length) {
      return {
        error:
          'No hay escenarios para exportar. Primero analizá el ticket (con cobertura) o guardá casos.',
        code: 'cases_required',
        ticketId: ticketKey || undefined,
        hint: 'analyze_ticket(coverage) → export_xray_csv(strategy) — o save_test_cases y después export_xray_csv(ticket_key).',
      };
    }

    const hasSteps = scenarios.some((s) => (s.steps || []).some((x) => x.trim()));
    if (!hasSteps) {
      return {
        error: 'strategy_incomplete',
        code: 'strategy_incomplete',
        ticketKey,
        hint: 'La strategy vino sin steps/expectedResults. Pasá el strategy completo de analyze_ticket (cada escenario con steps y expectedResults 1:1).',
      };
    }

    if (!ticketKey) {
      return {
        error: 'Indicá ticket_key / ticket_id para titular el Test de Xray',
      };
    }

    const baseUrl =
      (project?.base_url || '').trim() ||
      (process.env.APP_BASE_URL || '').trim() ||
      null;

    const understanding =
      (typeof args.understanding === 'string' && args.understanding.trim()) ||
      (typeof strategyArg?.summary === 'string' && strategyArg.summary.trim()) ||
      scenarios
        .map((s) => s.description)
        .filter(Boolean)
        .join('\n') ||
      null;

    let ticketSummary =
      typeof args.ticket_summary === 'string' && args.ticket_summary.trim()
        ? args.ticket_summary.trim()
        : null;

    // Always prefer the official Jira title for the Xray Summary.
    if (!ticketSummary && !ticketKey.startsWith('PASTE-')) {
      try {
        const fetched = await this.fetchTicket({ ticket_id: ticketKey });
        const t = (fetched as { ticket?: { summary?: string; key?: string } })
          .ticket;
        if (t?.summary?.trim()) {
          ticketSummary = t.summary.trim();
        }
        // Keep export keyed to the requested id even if Jira returns a moved key.
      } catch (err) {
        logger.warn('export_xray_csv: could not fetch Jira summary', {
          ticketKey,
          err,
        });
      }
    }

    const coverage =
      typeof args.coverage === 'string' && args.coverage.trim()
        ? args.coverage.trim()
        : null;

    const built = buildGroupedXrayManualTest({
      ticketKey,
      scenarios,
      understanding,
      ticketSummary,
      coverage,
      baseUrl,
    });

    return {
      ok: true,
      ticketKey,
      ticketSummary: ticketSummary || null,
      source,
      baseUrl: baseUrl || null,
      caseCount: built.caseCount,
      scenarioCount: built.scenarioCount,
      stepCount: built.stepCount,
      filename: built.filename,
      headers: built.headers,
      csv: built.csv,
      hint: 'Mostrá csv TAL CUAL en un fence ```csv. Es UN Test de Xray por ticket; Summary = "{KEY} - {título Jira}". No reescribas filas.',
      ...(baseUrl
        ? {}
        : {
            warning:
              'El proyecto no tiene base_url: los pasos pueden seguir con {{BASE_URL}}. Configurala en Proyectos.',
          }),
    };
  }

  /** Best-effort: write .spec.ts if missing. Never throws. */
  private ensurePlaywrightSpecs(
    projectId: number,
    ticketId: string,
    strategy: TestStrategy,
    baseUrl: string | null | undefined
  ): { generated: boolean; path?: string; error?: string } {
    try {
      if (hasPlaywrightSpecsOnDisk(ticketId)) {
        return { generated: false };
      }
      const result = generatePlaywrightSpecs({
        strategy,
        ticketKey: ticketId,
        baseUrl: baseUrl || process.env.APP_BASE_URL,
        write: true,
      });
      return {
        generated: true,
        path: result.files[0]?.relativePath,
      };
    } catch (err) {
      logger.warn('ensurePlaywrightSpecs failed (non-blocking)', {
        projectId,
        ticketId,
        err,
      });
      return {
        generated: false,
        error: err instanceof Error ? err.message : 'spec write failed',
      };
    }
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
      // Prefer an existing PASTE-* key that already has saved cases.
      const savedPaste = listTestCases({ projectId }).find((c) =>
        (c.ticket_key || '').toUpperCase().startsWith('PASTE-')
      );
      ticketId = savedPaste?.ticket_key || `PASTE-${Date.now()}`;
    } else {
      ticketId =
        this.resolveTicketArg(
          typeof args.ticket_id === 'string' ? args.ticket_id : undefined,
          typeof args.ticket_url === 'string' ? args.ticket_url : undefined
        ) || undefined;
      if (!ticketId) {
        return {
          error: 'Indicá ticket_id/ticket_url o pasted_summary + pasted_description',
        };
      }
    }

    const strategy = buildStrategyFromSavedCases(projectId, ticketId);
    if (!strategy) {
      return {
        error: CASES_REQUIRED_ERROR,
        code: 'cases_required',
        ticketId,
        hint: 'Usá analyze_ticket → save_test_cases, y recién después enqueue_run.',
      };
    }

    const specs = this.ensurePlaywrightSpecs(
      projectId,
      ticketId,
      strategy,
      project.base_url
    );

    const credentials = getProjectCredentials(project);
    const hasQaCredentials = Boolean(
      credentials.email && credentials.password
    );
    const llmProvider = (project.llm_provider as LlmProvider | null) || undefined;

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
      requestedBy: 'chat',
    });

    updateTestRun(run.id, { job_id: String(job.id), status: 'queued' });

    logger.info(
      `Chat enqueued run ${run.id} job ${job.id} with ${strategy.scenarios.length} saved case(s)`
    );

    return {
      ok: true,
      runId: run.id,
      jobId: String(job.id),
      ticketId,
      source,
      casesUsed: strategy.scenarios.length,
      hasQaCredentials,
      testUserEmail: credentials.email || null,
      followPath: `/runs?id=${run.id}`,
      message: 'Ejecución encolada con casos guardados',
      playwrightSpecs: specs.generated
        ? { generated: true, path: specs.path }
        : specs.error
          ? { generated: false, error: specs.error }
          : { generated: false, alreadyExisted: true },
      ...(hasQaCredentials
        ? {}
        : {
            warning:
              'El proyecto no tiene usuario QA (email/password). Configuralo en Proyectos para login/API auth.',
          }),
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
      const presented = presentRun(current);
      const phase = presented.phase;

      // Only evidence for THIS run (result_json or files newer than run start).
      // Never dump the whole ticket folder — that mixes prior runs.
      const evidence = screenshotsForRun(current).map((s) => ({
        name: s.name,
        url: s.url,
        path: ticketKey
          ? path.join(getScreenshotsDir(), ticketKey, s.name)
          : s.url,
      }));

      return {
        runId: current.id,
        jobId: current.job_id,
        ticketId: current.ticket_id,
        status: current.status,
        phase,
        phaseLabel: presented.phaseLabel,
        currentStep: presented.currentStep,
        progressLabel: presented.progressLabel,
        stepIndex: presented.stepIndex,
        stepTotal: presented.stepTotal,
        scenarioIndex: presented.scenarioIndex,
        scenarioTotal: presented.scenarioTotal,
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
        screenshotsFromThisRun: true,
        jiraPosted: presented.jiraPosted,
        canPublishToJira: presented.canPublishToJira,
        updated_at: current.updated_at,
      };
    };

    let status = await pollOnce();
    const isTerminal = (s: { status: string; phase?: string }) =>
      s.status === 'completed' ||
      s.status === 'failed' ||
      s.status === 'cancelled' ||
      s.phase === 'cancelled';

    if (waitMs > 0 && !isTerminal(status)) {
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
        if (isTerminal(status)) break;
      }
    }

    return status;
  }

  private async jiraSearch(args: Record<string, unknown>) {
    const jql = typeof args.jql === 'string' ? args.jql.trim() : '';
    if (!jql) return { error: 'jql es requerido' };

    const maxResults = Math.min(
      typeof args.max_results === 'number' && args.max_results > 0
        ? args.max_results
        : 10,
      25
    );

    const jiraClient = await getJiraClient();
    const data = await jiraClient.searchIssues(jql, maxResults);
    const issues = Array.isArray(data?.issues) ? data.issues : [];

    return {
      total: data?.total ?? issues.length,
      returned: issues.length,
      issues: issues.map((issue: any) => ({
        key: issue.key,
        summary: issue.fields?.summary || '',
        type: issue.fields?.issuetype?.name || '',
        status: issue.fields?.status?.name || '',
        priority: issue.fields?.priority?.name || '',
      })),
    };
  }

  private async jiraGetComments(args: Record<string, unknown>) {
    const ticketKey =
      typeof args.ticket_key === 'string' ? args.ticket_key.trim().toUpperCase() : '';
    if (!ticketKey) return { error: 'ticket_key es requerido' };

    const jiraClient = await getJiraClient();
    const issue = await jiraClient.getIssue(ticketKey);
    const text = formatJiraCommentsText(issue.fields.comment);
    const total = issue.fields.comment?.comments?.length ?? 0;

    return {
      ticket_key: ticketKey,
      comments: text || '(sin comentarios)',
      total,
    };
  }

  private async jiraPostComment(args: Record<string, unknown>) {
    if (args.confirmed !== true) {
      return {
        error:
          'Falta confirmación del usuario. Preguntá si quiere postear el comentario en Jira y solo llamá esta herramienta con confirmed=true cuando diga que sí.',
      };
    }

    const ticketKey =
      typeof args.ticket_key === 'string' ? args.ticket_key.trim().toUpperCase() : '';
    if (!ticketKey) return { error: 'ticket_key es requerido' };

    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!body) return { error: 'body es requerido' };

    const jiraClient = await getJiraClient();
    const adfBody = {
      type: 'doc',
      version: 1,
      content: body.split('\n\n').map((paragraph) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: paragraph }],
      })),
    };
    await jiraClient.addComment(ticketKey, adfBody);

    return {
      ok: true,
      ticket_key: ticketKey,
      hint: 'Confirmá al usuario que el comentario quedó publicado en el ticket.',
    };
  }

  private async publishResultsToJira(args: Record<string, unknown>) {
    if (args.confirmed !== true) {
      return {
        error:
          'Falta confirmación del usuario. Preguntá si quiere publicar en Jira y solo llamá esta herramienta con confirmed=true cuando diga que sí.',
      };
    }
    const runId = typeof args.run_id === 'number' ? args.run_id : null;
    if (!runId) return { error: 'run_id inválido' };

    const run = getTestRun(runId);
    if (!run) return { error: 'Run no encontrado' };

    const projectId = this.requireProjectId();
    if (run.project_id !== projectId) {
      return { error: 'Esa ejecución no pertenece al proyecto activo' };
    }

    const result = await publishRunToJira(runId);
    if (result.error || !result.run) {
      return { error: result.error || 'No se pudo publicar en Jira' };
    }

    const presented = presentRun(result.run);
    return {
      ok: true,
      runId: presented.id,
      ticketId: presented.ticket_id,
      jiraPosted: presented.jiraPosted,
      followPath: presented.followPath,
      userHint:
        'Confirmá al usuario que los resultados quedaron publicados en el ticket. No menciones nombres de herramientas.',
    };
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
    case 'generate_playwright_specs':
      return 'Generando scripts Playwright';
    case 'discover_api_contract':
      return 'Descubriendo contrato API (Network)';
    case 'export_xray_csv':
      return 'Armando CSV para Xray';
    case 'jira_search':
      return 'Buscando en Jira';
    case 'jira_get_comments':
      return 'Leyendo comentarios de Jira';
    case 'jira_post_comment':
      return 'Posteando comentario en Jira';
    case 'enqueue_run':
      return 'Encolando ejecución';
    case 'get_run_status':
      return 'Consultando ejecución';
    case 'publish_results_to_jira':
      return 'Publicando en Jira';
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
      return { ticket: r.ticket?.key || r.ticket?.summary };
    case 'analyze_ticket':
      return {
        ticket: r.ticket?.key || r.ticket?.summary,
        coverage: r.coverage,
        scenarios: r.strategy?.scenarios?.length,
      };
    case 'save_test_cases':
      return { total: r.total, ticket_key: r.ticket_key };
    case 'generate_playwright_specs':
      return {
        ticketKey: r.ticketKey,
        files: r.files?.length ?? 0,
        scenarioCount: r.scenarioCount,
      };
    case 'discover_api_contract':
      return {
        matchCount: r.matchCount,
        callCount: r.callCount,
        suggestedEnv: r.suggestedEnv,
      };
    case 'export_xray_csv':
      return {
        ticketKey: r.ticketKey,
        caseCount: r.caseCount,
        scenarioCount: r.scenarioCount,
        stepCount: r.stepCount,
        filename: r.filename,
        source: r.source,
      };
    case 'enqueue_run':
      return {
        runId: r.runId,
        jobId: r.jobId,
        followPath: r.followPath,
        playwrightSpecs: r.playwrightSpecs,
      };
    case 'get_run_status':
      return {
        status: r.status,
        phase: r.phase,
        screenshots: r.screenshots?.length ?? 0,
        jiraPosted: r.jiraPosted,
        canPublishToJira: r.canPublishToJira,
      };
    case 'jira_search':
      return { total: r.total, returned: r.returned };
    case 'jira_get_comments':
      return { ticket_key: r.ticket_key, total: r.total };
    case 'jira_post_comment':
      return { ticket_key: r.ticket_key, ok: r.ok };
    case 'publish_results_to_jira':
      return { ticketId: r.ticketId, jiraPosted: r.jiraPosted };
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
