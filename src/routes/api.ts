import { Router } from 'express';
import { z } from 'zod';
import {
  listProjects,
  getProjectPublic,
  createProject,
  updateProject,
  deleteProject,
  getPublicSettings,
  getSettings,
  upsertSettings,
  listTestRuns,
  getTestRun,
  createTestRun,
  updateTestRun,
  getProject,
  getProjectCredentials,
  getRunMemory,
  listTestCases,
  getTestCase,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  replaceProjectTestCases,
  listChatSessions,
  getChatSession,
  createChatSession,
  updateChatSession,
  deleteChatSession,
  listChatMessages,
} from '../db';
import { testQueue } from '../queue';
import { logger } from '../utils/logger';
import {
  PROVIDER_DEFAULTS,
  PROVIDER_CATALOG,
  modelOptionLabel,
  LlmProvider,
  testLlmConnection,
  providerApiKeySetting,
  readProviderProfile,
  resolveLlmConfig,
  getPromptTier,
} from '../llm';
import {
  listPlugins,
  updatePluginConfig,
  isPluginId,
  isInstalled,
} from '../plugins';
import {
  listSkills,
  updateSkillConfig,
  isSkillId,
} from '../skills';
import {
  TicketAnalyzer,
  createSyntheticTicket,
  TestStrategy,
  getDefaultAnalyzerInstructions,
  parseTestCoverage,
  detectTestSurface,
  extractCommentsText,
  mergeTicketText,
} from '../agents/ticket-analyzer';
import {
  formatRunMemoryContext,
  buildFewShotFromProject,
} from '../agents/qa-memory';
import { lintTestCases } from '../agents/test-case-lint';
import { getJiraClient } from '../clients/jira-mcp-client';
import { runQaChatTurn, getDefaultChatInstructions } from '../agents/qa-chat-agent';
import { presentRun, presentRunDetail } from '../runs/progress';
import { cancelTestRun, removeTestRun, rerunTestRun, publishRunToJira } from '../runs/manage';
import {
  buildStrategyFromSavedCases,
  CASES_REQUIRED_ERROR,
} from '../runs/strategy-from-cases';
import {
  generatePlaywrightSpecs,
  hasPlaywrightSpecsOnDisk,
} from '../agents/playwright-spec-generator';
import { resolveTicketKey } from '../utils/ticket-key';

const router = Router();

function extractTicketKey(ticketId?: string, ticketUrl?: string): string | null {
  return resolveTicketKey(ticketId, ticketUrl);
}

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

const llmProviderSchema = z.enum([
  'openai',
  'deepseek',
  'claude',
  'openai-compatible',
  'ollama',
]);

const projectSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().optional().default(''),
  staging_url: z.string().nullable().optional(),
  jira_project_key: z.string().nullable().optional(),
  jira_url: z.string().nullable().optional(),
  test_user_email: z.string().nullable().optional(),
  test_user_password: z.string().nullable().optional(),
  llm_provider: llmProviderSchema.nullable().optional(),
  llm_model: z.string().nullable().optional(),
  llm_base_url: z.string().nullable().optional(),
});

router.get('/providers', (_req, res) => {
  const settings = getSettings();
  const activeProvider = settings.llm_provider as LlmProvider | undefined;

  res.json({
    providers: Object.entries(PROVIDER_DEFAULTS).map(([id, meta]) => {
      const provider = id as LlmProvider;
      const profile = readProviderProfile(provider);
      const catalog = PROVIDER_CATALOG[provider];
      const keyName = providerApiKeySetting(provider);
      const hasKey = keyName ? Boolean(settings[keyName]) : false;
      const hasProfile = Boolean(profile.model || profile.baseUrl);
      const isActive = activeProvider === provider;
      // Ollama needs no key; treat as configured once a profile/URL exists or it's active
      const configured =
        provider === 'ollama'
          ? hasProfile || isActive || Boolean(settings.llm_base_url && isActive)
          : hasKey || hasProfile || isActive;

      return {
        id: provider,
        label: meta.label,
        defaultModel: meta.model,
        defaultBaseUrl: meta.baseUrl || null,
        configured,
        configuredModel: profile.model || null,
        configuredBaseUrl: profile.baseUrl || meta.baseUrl || null,
        requiresBaseUrl: provider === 'openai-compatible' || provider === 'ollama',
        models: catalog.models.map((m) => ({
          id: m.id,
          name: m.name,
          priceLabel: m.priceLabel,
          priceHint: m.priceHint || null,
          optionLabel: modelOptionLabel(m),
        })),
        baseUrls: catalog.baseUrls,
      };
    }),
  });
});

router.post('/llm/test', async (req, res) => {
  try {
    const body = z
      .object({
        provider: llmProviderSchema.optional(),
        model: z.string().optional(),
        base_url: z.string().optional(),
        api_key: z.string().optional(),
      })
      .parse(req.body || {});

    const apiKey =
      body.api_key && body.api_key !== '••••••••' ? body.api_key : undefined;

    const result = await testLlmConnection({
      provider: body.provider,
      model: body.model?.trim() || undefined,
      baseUrl: body.base_url?.trim() || undefined,
      apiKey,
    });

    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.warn('LLM connection test failed:', error);
    res.status(400).json({
      ok: false,
      error: error?.message || 'Falló la prueba de conexión',
    });
  }
});

router.get('/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

router.get('/projects/:id', (req, res) => {
  const project = getProjectPublic(Number(req.params.id));
  if (!project) {
    return res.status(404).json({ error: 'Proyecto no encontrado' });
  }
  res.json({ project });
});

router.get('/projects/:id/tickets', async (req, res) => {
  try {
    const project = getProject(Number(req.params.id));
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const projectKey = project.jira_project_key?.trim();
    if (!projectKey) {
      return res.status(400).json({
        error: 'Este proyecto no tiene clave de Jira configurada',
      });
    }

    const maxResults = Math.min(
      Math.max(Number(req.query.limit) || 100, 1),
      200
    );
    const safeKey = projectKey.replace(/"/g, '\\"');
    const jiraClient = await getJiraClient();

    // Only statuses whose name contains "QA" (e.g. "Ready for QA", "In QA")
    const qaStatuses = await jiraClient.listProjectStatusesContaining(
      projectKey,
      'QA'
    );
    if (qaStatuses.length === 0) {
      return res.json({
        projectKey,
        total: 0,
        tickets: [],
        groups: [],
      });
    }

    const statusClause = qaStatuses
      .map((name) => `"${name.replace(/"/g, '\\"')}"`)
      .join(', ');
    const jql = `project = "${safeKey}" AND status in (${statusClause}) ORDER BY status ASC, updated DESC`;
    const result = await jiraClient.searchIssues(jql, maxResults);
    const issues = Array.isArray(result?.issues) ? result.issues : [];

    const tickets = issues
      .map((issue: any) => ({
        key: issue.key as string,
        summary: (issue.fields?.summary as string) || '',
        status: (issue.fields?.status?.name as string) || 'Sin estado',
        statusCategory:
          (issue.fields?.status?.statusCategory?.key as string) ||
          (issue.fields?.status?.statusCategory?.name as string) ||
          null,
        type: (issue.fields?.issuetype?.name as string) || 'Unknown',
        priority: (issue.fields?.priority?.name as string) || 'Medium',
        updated: (issue.fields?.updated as string) || null,
      }))
      .filter((ticket: { status: string }) => /qa/i.test(ticket.status));

    const byStatus = new Map<string, typeof tickets>();
    for (const ticket of tickets) {
      const list = byStatus.get(ticket.status) || [];
      list.push(ticket);
      byStatus.set(ticket.status, list);
    }

    res.json({
      projectKey,
      total: tickets.length,
      tickets,
      groups: Array.from(byStatus.entries()).map(([status, items]) => ({
        status,
        tickets: items,
      })),
    });
  } catch (error: any) {
    logger.error('Error listing project tickets:', error);
    const jiraMsg =
      error?.response?.data?.errorMessages?.[0] ||
      error?.response?.data?.message ||
      error?.message;
    res.status(500).json({
      error: jiraMsg || 'No se pudieron listar los tickets del proyecto',
    });
  }
});

router.post('/projects', (req, res) => {
  try {
    const input = projectSchema.parse(req.body);
    const project = createProject(input);
    res.status(201).json({ project });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Proyecto inválido', details: error.errors });
    }
    logger.error('Error creating project:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.put('/projects/:id', (req, res) => {
  try {
    const input = projectSchema.partial().parse(req.body);
    const project = updateProject(Number(req.params.id), input);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }
    res.json({ project });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Proyecto inválido', details: error.errors });
    }
    logger.error('Error updating project:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.delete('/projects/:id', (req, res) => {
  const ok = deleteProject(Number(req.params.id));
  if (!ok) {
    return res.status(404).json({ error: 'Proyecto no encontrado' });
  }
  res.json({ success: true });
});

router.get('/settings', (_req, res) => {
  res.json({
    settings: getPublicSettings(),
    providers: PROVIDER_DEFAULTS,
  });
});

router.put('/settings', (req, res) => {
  try {
    const schema = z.record(z.string());
    const updates = schema.parse(req.body);
    const settings = upsertSettings(updates);
    res.json({ settings });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Configuración inválida', details: error.errors });
    }
    logger.error('Error updating settings:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/agent-prompts', (_req, res) => {
  try {
    const config = resolveLlmConfig();
    const tier = getPromptTier(config.provider, config.model);
    res.json({
      tier,
      provider: config.provider,
      model: config.model,
      defaults: {
        agent_chat_instructions: getDefaultChatInstructions(tier),
        agent_analyzer_instructions: getDefaultAnalyzerInstructions(tier),
      },
    });
  } catch {
    res.json({
      tier: 'full',
      provider: null,
      model: null,
      defaults: {
        agent_chat_instructions: getDefaultChatInstructions('full'),
        agent_analyzer_instructions: getDefaultAnalyzerInstructions('full'),
      },
    });
  }
});

router.post('/jira/test', async (req, res) => {
  try {
    const body = z
      .object({
        jira_url: z.string().optional(),
        jira_email: z.string().optional(),
        jira_api_token: z.string().optional(),
      })
      .parse(req.body || {});

    const { testJiraConnection } = await import('../jira/credentials');
    const result = await testJiraConnection({
      url: body.jira_url?.trim() || undefined,
      email: body.jira_email?.trim() || undefined,
      token:
        body.jira_api_token && body.jira_api_token !== '••••••••'
          ? body.jira_api_token
          : undefined,
    });

    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.warn('Jira connection test failed:', error);
    res.status(400).json({
      ok: false,
      error: error?.message || 'Falló la prueba de conexión a Jira',
    });
  }
});

router.post('/xray/test', async (req, res) => {
  try {
    const body = z
      .object({
        xray_client_id: z.string().optional(),
        xray_client_secret: z.string().optional(),
      })
      .parse(req.body || {});

    const { testXrayConnection } = await import('../jira/xray-credentials');
    const result = await testXrayConnection({
      clientId: body.xray_client_id?.trim() || undefined,
      clientSecret:
        body.xray_client_secret && body.xray_client_secret !== '••••••••'
          ? body.xray_client_secret
          : undefined,
    });

    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.warn('Xray connection test failed:', error);
    res.status(400).json({
      ok: false,
      error: error?.message || 'Falló la prueba de conexión a Xray',
    });
  }
});

router.post('/jira/mcp/connect', async (req, res) => {
  try {
    const body = z
      .object({
        jira_url: z.string().optional(),
        jira_email: z.string().optional(),
        jira_api_token: z.string().optional(),
      })
      .parse(req.body || {});

    const updates: Record<string, string> = { use_mcp: 'true' };
    if (body.jira_url != null) updates.jira_url = body.jira_url.trim();
    if (body.jira_email != null) updates.jira_email = body.jira_email.trim();
    if (body.jira_api_token && body.jira_api_token !== '••••••••') {
      updates.jira_api_token = body.jira_api_token;
    }

    upsertSettings(updates);

    const { probeJiraMcp, resetJiraClient } = await import(
      '../clients/jira-mcp-client'
    );
    await resetJiraClient();
    const tools = await probeJiraMcp();

    res.json({
      settings: getPublicSettings(),
      tools,
    });
  } catch (error: any) {
    upsertSettings({ use_mcp: 'false' });
    logger.warn('Jira MCP connect failed:', error);
    res.status(400).json({
      error: error.message || 'No se pudo conectar a Jira MCP',
      settings: getPublicSettings(),
    });
  }
});

router.post('/jira/mcp/disconnect', async (_req, res) => {
  try {
    upsertSettings({ use_mcp: 'false' });
    const { resetJiraClient } = await import('../clients/jira-mcp-client');
    await resetJiraClient();
    res.json({ settings: getPublicSettings() });
  } catch (error) {
    logger.error('Jira MCP disconnect failed:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/runs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const projectId = parseInt(req.query.project_id as string, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.json({ runs: [] });
  }
  res.json({ runs: listTestRuns(limit, projectId).map(presentRun) });
});

router.get('/runs/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Run inválido' });
  }
  const run = getTestRun(id);
  if (!run) {
    return res.status(404).json({ error: 'Run no encontrado' });
  }
  const projectId = parseInt(req.query.project_id as string, 10);
  if (Number.isFinite(projectId) && projectId > 0 && run.project_id !== projectId) {
    return res.status(404).json({ error: 'Run no encontrado' });
  }
  res.json({ run: presentRunDetail(run) });
});

router.post('/runs/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Run inválido' });
  }
  try {
    const result = await cancelTestRun(id);
    if (!result.run) {
      return res.status(404).json({ error: result.error || 'Run no encontrado' });
    }
    if (result.error) {
      return res.status(409).json({ error: result.error, run: presentRun(result.run) });
    }
    res.json({ run: presentRun(result.run) });
  } catch (error: any) {
    logger.error('Error cancelling run:', error);
    res.status(500).json({ error: 'No se pudo cancelar la ejecución' });
  }
});

router.post('/runs/:id/rerun', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Run inválido' });
  }
  try {
    const result = await rerunTestRun(id);
    if (result.error) {
      const status = result.sourceRun ? 409 : 404;
      return res.status(status).json({
        error: result.error,
        ...(result.sourceRun ? { run: presentRun(result.sourceRun) } : {}),
      });
    }
    if (!result.run) {
      return res.status(404).json({ error: 'Run no encontrado' });
    }
    res.json({ run: presentRun(result.run) });
  } catch (error: any) {
    logger.error('Error re-running:', error);
    res.status(500).json({ error: 'No se pudo re-ejecutar' });
  }
});

router.post('/runs/:id/publish-jira', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Run inválido' });
  }
  try {
    const result = await publishRunToJira(id);
    if (!result.run) {
      return res.status(404).json({ error: result.error || 'Run no encontrado' });
    }
    if (result.error) {
      const status = result.error.includes('ya se publicaron') ? 409 : 400;
      return res.status(status).json({
        error: result.error,
        run: presentRun(result.run),
      });
    }
    res.json({ run: presentRun(result.run) });
  } catch (error: any) {
    logger.error('Error publishing to Jira:', error);
    res.status(500).json({ error: 'No se pudo publicar en Jira' });
  }
});

router.delete('/runs/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Run inválido' });
  }
  try {
    const result = await removeTestRun(id);
    if (!result.ok) {
      return res
        .status(result.error === 'Run no encontrado' ? 404 : 500)
        .json({ error: result.error || 'No se pudo borrar' });
    }
    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting run:', error);
    res.status(500).json({ error: 'No se pudo borrar la ejecución' });
  }
});

router.get('/plugins', (_req, res) => {
  res.json({ plugins: listPlugins() });
});

router.put('/plugins/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!isPluginId(id)) {
      return res.status(404).json({ error: 'Plugin no encontrado' });
    }

    const schema = z.object({
      installed: z.boolean(),
      maxRetries: z.number().int().min(1).max(5).optional(),
    });
    const body = schema.parse(req.body);
    const state = updatePluginConfig(id, body);
    if (!state) {
      return res.status(400).json({ error: 'Configuración de plugin inválida' });
    }

    res.json({ plugins: listPlugins() });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error updating plugin:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/skills', (_req, res) => {
  res.json({ skills: listSkills() });
});

router.put('/skills/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!isSkillId(id)) {
      return res.status(404).json({ error: 'Skill no encontrada' });
    }

    const schema = z.object({
      installed: z.boolean(),
      autoBeforeEnqueue: z.boolean().optional(),
      createInJira: z.boolean().optional(),
      maxPages: z.number().int().min(1).max(15).optional(),
    });
    const body = schema.parse(req.body);
    const state = updateSkillConfig(id, body);
    if (!state) {
      return res.status(400).json({ error: 'Configuración de skill inválida' });
    }

    res.json({ skills: listSkills() });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error updating skill:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const scenarioSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['happy', 'unhappy', 'corner']).optional(),
  steps: z.array(z.string()).default([]),
  expectedResults: z.array(z.string()).default([]),
  urls: z.array(z.string()).optional(),
  selectors: z.array(z.string()).optional(),
  apiEndpoints: z.array(z.string()).optional(),
});

const strategySchema = z.object({
  testType: z.enum(['ui', 'api', 'manual', 'mixed']),
  scenarios: z.array(scenarioSchema).min(1),
  summary: z.string().min(1),
  estimatedDuration: z.number().nonnegative(),
  priority: z.enum(['high', 'medium', 'low']),
});

const runSchema = z
  .object({
    ticketId: z.string().optional(),
    ticketUrl: z.string().url().optional(),
    pastedTicket: z
      .object({
        summary: z.string().min(1),
        description: z.string().min(1),
      })
      .optional(),
    strategy: strategySchema.optional(),
    coverage: z.enum(['happy', 'unhappy', 'corner', 'all']).optional(),
  })
  .refine(
    (data) => data.ticketId || data.ticketUrl || data.pastedTicket,
    { message: 'Indicá ticketId, ticketUrl o pastedTicket' }
  );

const testCaseBodySchema = z.object({
  ticket_key: z.string().nullable().optional(),
  case_key: z.string().min(1).optional(),
  description: z.string().min(1),
  steps: z.array(z.string()).default([]),
  expectedResults: z.array(z.string()).default([]),
  urls: z.array(z.string()).optional(),
  selectors: z.array(z.string()).optional(),
  source: z.enum(['manual', 'ai']).optional(),
});

const replaceTestCasesSchema = z
  .object({
    ticket_key: z.string().nullable().optional(),
    force: z.boolean().optional(),
    cases: z
      .array(
        z.object({
          case_key: z.string().min(1).optional(),
          description: z.string().min(1),
          steps: z.array(z.string()).default([]),
          expectedResults: z.array(z.string()).default([]),
          urls: z.array(z.string()).optional(),
          selectors: z.array(z.string()).optional(),
          source: z.enum(['manual', 'ai']).optional(),
        })
      )
      .optional(),
    strategy: strategySchema.optional(),
  })
  .refine((data) => Boolean(data.strategy?.scenarios?.length || data.cases?.length), {
    message: 'Indicá cases o strategy con escenarios',
  });

router.post('/projects/:id/analyze', async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const body = runSchema.parse(req.body);
    const llmProvider = (project.llm_provider as LlmProvider | null) || undefined;

    let source: 'jira' | 'paste' = 'jira';
    let ticket;

    if (body.pastedTicket) {
      source = 'paste';
      ticket = createSyntheticTicket({
        key: `PASTE-${Date.now()}`,
        summary: body.pastedTicket.summary,
        description: body.pastedTicket.description,
      });
    } else {
      const ticketId = extractTicketKey(body.ticketId, body.ticketUrl);
      if (!ticketId) {
        return res.status(400).json({
          error: body.ticketUrl
            ? 'Formato de URL de Jira inválido'
            : 'No se pudo determinar el ID del ticket',
        });
      }
      const jiraClient = await getJiraClient();
      ticket = await jiraClient.getIssue(ticketId);
    }

    const analyzeOptions = {
      memoryContext: undefined as string | undefined,
      fewShotExamples: undefined as string | undefined,
      coverage: parseTestCoverage(body.coverage) || undefined,
    };

    const memories = getRunMemory({
      projectId,
      ticketKey: ticket.key,
      limit: 5,
    });
    const ctx = formatRunMemoryContext(memories);
    if (ctx) analyzeOptions.memoryContext = ctx;

    const description = descriptionToText(ticket.fields.description);
    const comments = extractCommentsText(ticket);
    const fewShot = buildFewShotFromProject(projectId, {
      excludeTicketKey: ticket.key,
      limit: 2,
      surface: detectTestSurface({
        summary: ticket.fields.summary,
        description: mergeTicketText(description, comments),
        labels: ticket.fields.labels,
        issuetype: ticket.fields.issuetype?.name,
      }),
    });
    if (fewShot) analyzeOptions.fewShotExamples = fewShot;

    const analyzer = new TicketAnalyzer({
      provider: llmProvider,
      model: project.llm_model || undefined,
      baseUrl: project.llm_base_url || undefined,
    });

    let strategy;
    let usedFallback = false;
    try {
      strategy = await analyzer.analyzeTicket(ticket, analyzeOptions);
    } catch (error) {
      logger.warn('Analyze endpoint: AI failed, using fallback', error);
      strategy = await analyzer.generateFallbackStrategy(ticket, analyzeOptions);
      usedFallback = true;
    }

    const lint = lintTestCases(
      strategy.scenarios.map((s: { id: string; description: string; steps: string[]; expectedResults: string[]; urls?: string[]; selectors?: string[]; apiEndpoints?: string[] }) => ({
        case_key: s.id,
        description: s.description,
        steps: s.steps,
        expectedResults: s.expectedResults,
        urls: s.urls,
        selectors: s.selectors,
        apiEndpoints: s.apiEndpoints,
      })),
      { testType: strategy.testType }
    );

    res.json({
      success: true,
      source,
      usedFallback,
      ticket: {
        key: ticket.key,
        summary: ticket.fields.summary,
        type: ticket.fields.issuetype?.name || 'Unknown',
        status: ticket.fields.status?.name || 'Unknown',
        priority: ticket.fields.priority?.name || 'Medium',
        labels: ticket.fields.labels || [],
        description,
        comments: comments || undefined,
      },
      understanding: strategy.summary,
      strategy,
      lint,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error analyzing ticket:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Error interno del servidor',
    });
  }
});

router.post('/projects/:id/run', async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const body = runSchema.parse(req.body);
    let source: 'jira' | 'paste' = 'jira';
    let ticketId: string | undefined;
    let pastedSummary: string | undefined;
    let pastedDescription: string | undefined;

    if (body.pastedTicket) {
      source = 'paste';
      pastedSummary = body.pastedTicket.summary;
      pastedDescription = body.pastedTicket.description;
      ticketId = `PASTE-${Date.now()}`;
    } else {
      ticketId = extractTicketKey(body.ticketId, body.ticketUrl) || undefined;
      if (body.ticketUrl && !ticketId) {
        return res.status(400).json({ error: 'Formato de URL de Jira inválido' });
      }
      if (!ticketId) {
        return res.status(400).json({ error: 'No se pudo determinar el ID del ticket' });
      }
    }

    const credentials = getProjectCredentials(project);

    const llmProvider = (project.llm_provider as LlmProvider | null) || undefined;

    const strategy =
      (body.strategy as TestStrategy | undefined)?.scenarios?.length
        ? (body.strategy as TestStrategy)
        : ticketId
          ? buildStrategyFromSavedCases(projectId, ticketId)
          : null;

    if (!strategy?.scenarios?.length) {
      return res.status(400).json({
        error: CASES_REQUIRED_ERROR,
        code: 'cases_required',
      });
    }

    let playwrightSpecs: {
      generated: boolean;
      path?: string;
      alreadyExisted?: boolean;
      error?: string;
    } = { generated: false };
    if (ticketId && !hasPlaywrightSpecsOnDisk(ticketId)) {
      try {
        const generated = generatePlaywrightSpecs({
          strategy,
          ticketKey: ticketId,
          baseUrl: project.base_url || process.env.APP_BASE_URL,
          write: true,
        });
        playwrightSpecs = {
          generated: true,
          path: generated.files[0]?.relativePath,
        };
      } catch (err) {
        logger.warn('API run: playwright spec generation failed (non-blocking)', err);
        playwrightSpecs = {
          generated: false,
          error: err instanceof Error ? err.message : 'spec write failed',
        };
      }
    } else if (ticketId) {
      playwrightSpecs = { generated: false, alreadyExisted: true };
    }

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
      requestedBy: req.ip || 'ui',
    });

    updateTestRun(run.id, { job_id: String(job.id), status: 'queued' });

    logger.info(`Queued run ${run.id} job ${job.id} for project ${projectId}`);

    res.json({
      success: true,
      runId: run.id,
      jobId: job.id,
      ticketId,
      source,
      casesUsed: strategy.scenarios.length,
      playwrightSpecs,
      message: 'Job de test encolado correctamente',
      status: `Check job status at /api/job-status/${job.id}`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error starting project run:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/projects/:id/test-cases', (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const ticketKey =
      typeof req.query.ticketKey === 'string' && req.query.ticketKey.trim()
        ? req.query.ticketKey.trim().toUpperCase()
        : null;

    const cases = listTestCases({ projectId, ticketKey });
    res.json({ cases, total: cases.length });
  } catch (error) {
    logger.error('Error listing test cases:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.post('/projects/:id/test-cases', (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const body = testCaseBodySchema.parse(req.body);
    const caseKey =
      body.case_key?.trim() ||
      `TC-${Date.now().toString(36).toUpperCase()}`;

    const created = createTestCase({
      project_id: projectId,
      ticket_key: body.ticket_key?.trim()
        ? body.ticket_key.trim().toUpperCase()
        : null,
      case_key: caseKey,
      description: body.description,
      steps: body.steps,
      expectedResults: body.expectedResults,
      urls: body.urls,
      selectors: body.selectors,
      source: body.source || 'manual',
    });

    res.status(201).json({ case: created });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error creating test case:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.put('/projects/:id/test-cases', (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const project = getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const body = replaceTestCasesSchema.parse(req.body);
    const ticketKey = body.ticket_key?.trim()
      ? body.ticket_key.trim().toUpperCase()
      : null;

    if (!ticketKey) {
      return res.status(400).json({
        error: 'Indicá ticket_key para crear o reemplazar los casos',
      });
    }

    const fromStrategy = body.strategy?.scenarios.map((scenario, index) => ({
      case_key: scenario.id || `TC-${index + 1}`,
      description: scenario.description,
      steps: scenario.steps,
      expectedResults: scenario.expectedResults,
      urls: scenario.urls,
      selectors: scenario.selectors,
      source: 'ai' as const,
      ticket_key: ticketKey,
    }));

    const casesInput = (fromStrategy || body.cases || []).map((c, index) => ({
      case_key: c.case_key?.trim() || `TC-${index + 1}`,
      description: c.description,
      steps: c.steps || [],
      expectedResults: c.expectedResults || [],
      urls: c.urls,
      selectors: c.selectors,
      source: c.source || (fromStrategy ? 'ai' : 'manual'),
      ticket_key: ticketKey,
    }));

    const lint = lintTestCases(casesInput);
    if (!lint.ok && !body.force) {
      return res.status(400).json({
        error: 'Los casos no pasan la validación de calidad',
        code: 'cases_lint_failed',
        lint,
      });
    }

    const cases = replaceProjectTestCases({
      projectId,
      ticketKey,
      cases: casesInput,
    });

    res.json({
      cases,
      total: cases.length,
      ticket_key: ticketKey,
      lint,
      forcedSave: Boolean(body.force && !lint.ok),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error replacing test cases:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.put('/test-cases/:caseId', (req, res) => {
  try {
    const caseId = Number(req.params.caseId);
    const existing = getTestCase(caseId);
    if (!existing) {
      return res.status(404).json({ error: 'Caso de prueba no encontrado' });
    }

    const body = testCaseBodySchema.partial().parse(req.body);
    const updated = updateTestCase(caseId, {
      ticket_key:
        body.ticket_key === undefined
          ? undefined
          : body.ticket_key?.trim()
            ? body.ticket_key.trim().toUpperCase()
            : null,
      case_key: body.case_key,
      description: body.description,
      steps: body.steps,
      expectedResults: body.expectedResults,
      urls: body.urls,
      selectors: body.selectors,
      source: body.source,
    });

    res.json({ case: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error updating test case:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.delete('/test-cases/:caseId', (req, res) => {
  try {
    const caseId = Number(req.params.caseId);
    const existing = getTestCase(caseId);
    if (!existing) {
      return res.status(404).json({ error: 'Caso de prueba no encontrado' });
    }

    deleteTestCase(caseId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting test case:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- Chat agent ---

router.get('/chat/sessions', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const raw = req.query.project_id;
  let projectId: number | null | undefined;
  if (raw === undefined) {
    projectId = undefined;
  } else if (raw === '' || raw === 'null') {
    projectId = null;
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return res.status(400).json({ error: 'project_id inválido' });
    }
    projectId = n;
  }
  res.json({ sessions: listChatSessions(limit, projectId) });
});

router.post('/chat/sessions', (req, res) => {
  try {
    const body = z
      .object({
        project_id: z.number().nullable().optional(),
        title: z.string().optional(),
      })
      .parse(req.body || {});

    if (body.project_id != null) {
      const project = getProject(body.project_id);
      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }
    }

    const session = createChatSession({
      projectId: body.project_id,
      title: body.title,
    });
    res.status(201).json({ session });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error creating chat session:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/chat/sessions/:id', (req, res) => {
  const id = Number(req.params.id);
  const session = getChatSession(id);
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  res.json({
    session,
    messages: listChatMessages(id).filter(
      (m) =>
        (m.role === 'user' && Boolean(m.content)) ||
        (m.role === 'assistant' && Boolean(m.content))
    ),
  });
});

async function updateChatSessionHandler(req: any, res: any) {
  try {
    const id = Number(req.params.id);
    const session = getChatSession(id);
    if (!session) {
      return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    const body = z
      .object({
        project_id: z.number().int().positive().nullable().optional(),
        title: z.string().optional(),
      })
      .parse(req.body || {});

    if (body.project_id != null) {
      const project = getProject(body.project_id);
      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }
    }

    const updated = updateChatSession(id, body);
    res.json({ session: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    logger.error('Error updating chat session:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

router.put('/chat/sessions/:id', updateChatSessionHandler);
router.patch('/chat/sessions/:id', updateChatSessionHandler);

router.delete('/chat/sessions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getChatSession(id)) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  deleteChatSession(id);
  res.json({ success: true });
});

router.post('/chat/sessions/:id/messages', async (req, res) => {
  const id = Number(req.params.id);
  const session = getChatSession(id);
  if (!session) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  let body: { content: string };
  try {
    body = z
      .object({ content: z.string().min(1) })
      .parse(req.body || {});
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Pedido inválido', details: error.errors });
    }
    return res.status(400).json({ error: 'Pedido inválido' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const flush = () => {
    (res as any).flush?.();
  };

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    flush();
  };

  let closed = false;
  const turnAbort = new AbortController();
  // Use the response, not the request: req 'close' fires when the POST body
  // finishes reading, which would drop every SSE event after that.
  // Abort the agent only on premature disconnect (client stop / network drop).
  const markClosed = () => {
    closed = true;
  };
  res.on('close', () => {
    markClosed();
    if (!res.writableEnded) turnAbort.abort();
  });
  res.on('finish', markClosed);

  // Keep proxies/browsers from buffering the stream during long LLM waits
  res.write(': connected\n\n');
  flush();
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    res.write(`: ping ${Date.now()}\n\n`);
    flush();
  }, 2000);

  try {
    await runQaChatTurn({
      sessionId: id,
      userMessage: body.content,
      signal: turnAbort.signal,
      onEvent: (ev) => {
        if (closed || res.writableEnded) return;
        if (ev.type === 'token') send('token', { text: ev.text });
        else if (ev.type === 'tool_start')
          send('tool_start', {
            tool: ev.tool,
            detail: ev.detail,
            data: ev.data,
          });
        else if (ev.type === 'tool_end')
          send('tool_end', {
            tool: ev.tool,
            detail: ev.detail,
            data: ev.data,
          });
        else if (ev.type === 'progress')
          send('progress', {
            tool: ev.tool,
            detail: ev.detail,
            data: ev.data,
          });
        else if (ev.type === 'done') send('done', ev);
        else if (ev.type === 'error') send('error', { error: ev.error });
      },
    });
  } catch (error: any) {
    if (error?.name === 'AbortError' || turnAbort.signal.aborted) {
      logger.info('Chat SSE aborted by client', { sessionId: id });
    } else {
      logger.error('Chat SSE failed:', error);
      if (!closed && !res.writableEnded) {
        send('error', { error: error?.message || 'Error del agente' });
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

export default router;
