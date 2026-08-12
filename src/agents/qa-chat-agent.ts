import {
  createLlmClient,
  resolveLlmConfig,
  AgentMessage,
  AgentChatResponse,
  LlmProvider,
  PromptTier,
  getPromptTier,
  addUsage,
  emptyUsage,
  toTurnUsage,
  type LlmTurnUsage,
} from '../llm';
import {
  getChatSession,
  getProject,
  getSetting,
  listChatMessages,
  listProjects,
  createChatMessage,
  updateChatSession,
} from '../db';
import { QaChatToolRunner, ToolEventEmitter, getActiveChatTools, getInstalledSkillPlaybooks } from './qa-chat-tools';
import { logger } from '../utils/logger';

const MAX_ITERATIONS = 8;

export type ChatAgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: string; detail?: string; data?: unknown }
  | { type: 'tool_end'; tool: string; detail?: string; data?: unknown }
  | { type: 'progress'; tool?: string; detail?: string; data?: unknown }
  | {
      type: 'done';
      message: string;
      session: { id: number; project_id: number | null; title: string };
      usage?: LlmTurnUsage;
    }
  | { type: 'error'; error: string };

function formatProjectDirectory(
  projects: ReturnType<typeof listProjects>
): string {
  if (!projects.length) return '(ninguno)';
  return projects
    .map(
      (p) =>
        `- id=${p.id} · ${p.name}` +
        (p.jira_project_key ? ` · Jira ${p.jira_project_key}` : '') +
        (p.base_url ? ` · ${p.base_url}` : '')
    )
    .join('\n');
}

const DEFAULT_CHAT_INSTRUCTIONS_FULL = `Workflow:
1. User gives a ticket (Jira key or pasted text) → use fetch_ticket to get info → explain what the ticket asks, what to test, what risks you see.
2. Use analyze_ticket to generate test cases (happy path + negative + edge cases). Show summary to user before proceeding.
3. User approves → use save_test_cases to persist them.
4. Use enqueue_run to queue execution. Then get_run_status (use wait_ms up to 45000) to check progress.
5. Report results: what passed, what failed, screenshot URLs (/screenshots/...), and suggested next step.

Rules:
- Never invent ticket content. Always use fetch_ticket or analyze_ticket.
- Never invent runId, jobId, status, progress, or screenshots. Those exist only after enqueue_run / get_run_status / list_recent_runs return them in THIS turn. If you did not call the tool, say you still need to queue/check — do not fake a JSON result.
- If the user asks to launch/run/enqueue tests ("lanzá", "ejecutá", "nueva ejecución", etc.), you MUST call enqueue_run before saying it is queued.
- If config is missing (no project, no base_url, no LLM, no Jira creds): say exactly what is missing and where to configure it (Settings or Projects page).
- Respond in human-readable text, not raw JSON (unless user asks for technical detail).
- Never mention tool names (enqueue_run, get_run_status, etc.) to the user.
- After enqueue_run: tell the user the run is queued and they can follow it step by step in Ejecuciones. Always include the followPath (e.g. /runs?id=3). If still running after get_run_status, point them there instead of asking them to poll.
- Always include screenshot URLs (/screenshots/...) when available.
- If a run fails: analyze whether it is an app bug, a broken test case (bad selector, ambiguous step), or a config issue.
- If user pastes free text (not a ticket key): treat it as a feature description using fetch_ticket with pasted_summary + pasted_description.
- Use list_recent_runs to give context on what was already tested.
- Use lists, keep responses short. If the ticket is ambiguous, ask before generating cases.
- Format scenarios as \`### Short title\` or \`1. **Title**\` plus bullets of what will be tested. Do not repeat “En este escenario, se probará:”. Keep numbered lists contiguous (1, 2, 3…); never restart at 1. Put detail in the bullets, not in long paragraphs.
- If user asks for Xray export/import: put the full CSV in a \`\`\`csv fenced block (columns: Summary, Description, Test Type, Step, Data, Expected Result), ready to download/import. A short intro is ok; never dump CSV as plain chat text. Do not invent ticket facts — use fetch_ticket / analyze_ticket / list_test_cases first.`;

const DEFAULT_CHAT_INSTRUCTIONS_COMPACT = `Tools: fetch_ticket, analyze_ticket, save_test_cases, enqueue_run, get_run_status, list_projects, set_active_project, list_test_cases, list_recent_runs.

Rules:
- Never invent ticket content. Use fetch_ticket or analyze_ticket.
- Never invent runId/jobId/status/screenshots. Only report values returned by enqueue_run / get_run_status / list_recent_runs in THIS turn.
- User asks to launch/run tests → you MUST call enqueue_run before saying it is queued.
- If config is missing: say what and where to fix it.
- Include screenshot URLs (/screenshots/...) when available.
- Never mention tool names to the user. After a run is queued, point them to Ejecuciones with followPath (/runs?id=N).
- Pasted text (not a key): use fetch_ticket with pasted_summary + pasted_description.
- Xray export: full CSV in a \`\`\`csv fence (Summary, Description, Test Type, Step, Data, Expected Result). Never as plain text.
- Keep responses short, use lists.
- Scenarios: \`### Title\` or \`1. **Title**\` + bullets. No repeated “En este escenario…”. Number 1, 2, 3… without restarting.`;

export function getDefaultChatInstructions(tier: PromptTier): string {
  return tier === 'compact'
    ? DEFAULT_CHAT_INSTRUCTIONS_COMPACT
    : DEFAULT_CHAT_INSTRUCTIONS_FULL;
}

function buildSystemPrompt(opts: {
  projectId: number | null;
  projectName?: string | null;
  projectCount: number;
  projectDirectory: string;
  tier: PromptTier;
}): string {
  const projectLine = opts.projectId
    ? `Active project: id=${opts.projectId}${
        opts.projectName ? ` (${opts.projectName})` : ''
      }.`
    : opts.projectCount === 0
      ? 'No projects configured. Ask user to create one in Projects (and set LLM/Jira in Settings).'
      : 'No active project yet. If they only ask which projects exist, answer from the list below without calling tools. Otherwise ask which one or call set_active_project.';

  const custom = (getSetting('agent_chat_instructions') || '').trim();
  const instructions = custom || getDefaultChatInstructions(opts.tier);
  const skillPlaybooks = getInstalledSkillPlaybooks();

  const header = opts.tier === 'compact'
    ? `You are Qatin's QA agent. Answer in Spanish (argentino). Be concise.

Job: understand tickets, create test cases, run Playwright tests, report results.`
    : `You are the QA agent of Qatin. Answer in Spanish (argentino). Be clear and concise.

Your job: understand tickets, design test cases, run them with Playwright, and report results.`;

  return `${header}

Configured projects:
${opts.projectDirectory}

- ${projectLine}
- If the user only asks which projects exist, answer from the list above. Do not call list_projects unless you need fresh fields.

${instructions}${skillPlaybooks}`;
}

function historyToAgentMessages(
  rows: ReturnType<typeof listChatMessages>
): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const row of rows) {
    if (row.role === 'user') {
      messages.push({ role: 'user', content: row.content || '' });
      continue;
    }

    if (row.role === 'assistant') {
      const meta = row.meta as { tool_calls?: AgentMessage['tool_calls'] } | null;
      messages.push({
        role: 'assistant',
        content: row.content,
        ...(meta?.tool_calls?.length ? { tool_calls: meta.tool_calls } : {}),
      });
      continue;
    }

    if (row.role === 'tool') {
      messages.push({
        role: 'tool',
        content: row.content || '',
        tool_call_id: row.tool_call_id || undefined,
        name: row.tool_name || undefined,
      });
    }
  }

  return messages;
}

function friendlyLlmError(error: unknown): string {
  const raw =
    (error as any)?.message ||
    'Falló el agente de chat. Revisá el LLM y reintentá.';
  if (/timed out|timeout|AbortError/i.test(raw)) {
    return 'El modelo tardó demasiado en responder. Detené y reintentá, o probá un modelo más rápido en Configuración.';
  }
  if (/model .* not found|404/i.test(raw)) {
    return `El modelo configurado no está en Ollama (${raw}). En Configuración elegí uno instalado (ej. hermes3:latest) o corré \`ollama pull <modelo>\`.`;
  }
  return raw;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error('Aborted');
  err.name = 'AbortError';
  throw err;
}

const STOPPED_MESSAGE = 'Consulta detenida.';

function isProjectsInventoryQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const asksProjects =
    /\bproyectos?\b/.test(t) ||
    /\bprojects?\b/.test(t);
  const asksList =
    /\b(qué|que|cuales|cuáles|cuantos|cuántos|lista|listá|liste|mostrar|mostrá|tengo|hay|configurad)\b/.test(
      t
    ) || /what projects|list projects|which projects/.test(t);
  const looksLikeTicketWork =
    /\b([a-z][a-z0-9]+-\d+)\b/i.test(t) ||
    /\b(probar|testear|analizar|ejecutar|ticket|caso)\b/.test(t);
  return asksProjects && asksList && !looksLikeTicketWork;
}

/** User wants to queue a Playwright run now. */
function isRunEnqueueIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (
    /\b(estado|status|progreso|cómo va|como va|resultados?)\b/.test(t) &&
    !/\b(lanz|ejecut|encol|correr|corr[eé]|nueva ejecuci)/.test(t)
  ) {
    return false;
  }
  return (
    /\b(lanz[aeá]|ejecut\w*|encol\w*|correr|corr[eé]|re-?ejecut\w*|nueva ejecuci[oó]n|enqueue|run (the )?tests)\b/i.test(
      t
    ) || /\bplaywright\b/.test(t)
  );
}

function claimsFabricatedRun(text: string): boolean {
  return (
    /\brunId\b/i.test(text) &&
    /\b(jobId|encolad|queued|ejecuci[oó]n)\b/i.test(text)
  );
}

function extractTicketKey(text: string): string | null {
  const matches = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/g);
  if (!matches?.length) return null;
  return matches[matches.length - 1];
}

function resolveTicketForEnqueue(
  sessionId: number,
  userMessage: string
): string | null {
  const fromUser = extractTicketKey(userMessage);
  if (fromUser) return fromUser;

  const rows = listChatMessages(sessionId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const key = extractTicketKey(rows[i].content || '');
    if (key) return key;
  }
  return null;
}

function formatEnqueueReply(result: Record<string, unknown>): string {
  if (result.error) {
    return `No pude encolar la ejecución: ${String(result.error)}`;
  }
  const followPath =
    typeof result.followPath === 'string'
      ? result.followPath
      : typeof result.runId === 'number'
        ? `/runs?id=${result.runId}`
        : '/runs';
  const ticket =
    typeof result.ticketId === 'string' ? ` de ${result.ticketId}` : '';
  return `Listo: encolé la ejecución${ticket}. Seguí el progreso paso a paso en [Ejecuciones](${followPath}).`;
}

function answerProjectsInventory(
  projects: ReturnType<typeof listProjects>
): string {
  if (!projects.length) {
    return 'No tenés proyectos configurados todavía. Creá uno en Proyectos y volvé.';
  }
  const lines = projects.map((p) => {
    const bits = [
      `**${p.name}** (id ${p.id})`,
      p.jira_project_key ? `Jira \`${p.jira_project_key}\`` : null,
      p.base_url || null,
    ].filter(Boolean);
    return `- ${bits.join(' · ')}`;
  });
  return `Tenés ${projects.length} proyecto${projects.length === 1 ? '' : 's'} configurado${projects.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nElegí uno en el selector de arriba o decime cuál querés usar.`;
}

export async function runQaChatTurn(opts: {
  sessionId: number;
  userMessage: string;
  onEvent: (event: ChatAgentEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { sessionId, userMessage, onEvent, signal } = opts;

  const session = getChatSession(sessionId);
  if (!session) {
    onEvent({ type: 'error', error: 'Sesión no encontrada' });
    return;
  }

  createChatMessage({
    session_id: sessionId,
    role: 'user',
    content: userMessage,
  });

  if (session.title === 'Nueva conversación' && userMessage.trim()) {
    const title =
      userMessage.trim().length > 60
        ? `${userMessage.trim().slice(0, 57)}...`
        : userMessage.trim();
    updateChatSession(sessionId, { title });
  }

  const projects = listProjects();
  const projectDirectory = formatProjectDirectory(projects);

  const emitDone = (message: string, usage?: LlmTurnUsage) => {
    const endSession = getChatSession(sessionId)!;
    onEvent({
      type: 'done',
      message,
      session: {
        id: endSession.id,
        project_id: endSession.project_id,
        title: endSession.title,
      },
      ...(usage ? { usage } : {}),
    });
  };

  // Fast path: listing projects does not need the LLM (avoids Ollama tool stalls).
  if (isProjectsInventoryQuestion(userMessage)) {
    const msg = answerProjectsInventory(projects);
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg);
    return;
  }

  let projectName: string | null = null;
  let llmPartial: { provider?: LlmProvider; model?: string; baseUrl?: string } =
    {};

  if (session.project_id) {
    const project = getProject(session.project_id);
    if (project) {
      projectName = project.name;
      llmPartial = {
        provider: (project.llm_provider as LlmProvider | null) || undefined,
        model: project.llm_model || undefined,
        baseUrl: project.llm_base_url || undefined,
      };
    }
  }

  let client;
  let tier: PromptTier = 'full';
  try {
    const config = resolveLlmConfig(llmPartial);
    tier = getPromptTier(config.provider, config.model);
    client = createLlmClient(config);
  } catch (error: any) {
    const msg =
      error?.message ||
      'No hay LLM configurado. Andá a Configuración y cargá un proveedor.';
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg);
    return;
  }

  const emitTools: ToolEventEmitter = (ev) => {
    if (signal?.aborted) return;
    if (ev.type === 'tool_start') {
      onEvent({
        type: 'tool_start',
        tool: ev.tool || '',
        detail: ev.detail,
        data: ev.data,
      });
    } else if (ev.type === 'tool_end') {
      onEvent({
        type: 'tool_end',
        tool: ev.tool || '',
        detail: ev.detail,
        data: ev.data,
      });
    } else {
      onEvent({
        type: 'progress',
        tool: ev.tool,
        detail: ev.detail,
        data: ev.data,
      });
    }
  };

  const tools = new QaChatToolRunner(sessionId, emitTools, signal);
  const refreshed = getChatSession(sessionId)!;

  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        projectId: refreshed.project_id,
        projectName,
        projectCount: projects.length,
        projectDirectory,
        tier,
      }),
    },
    ...historyToAgentMessages(listChatMessages(sessionId)),
  ];

  let finalText = '';
  let usageAcc = emptyUsage();
  let llmMs = 0;
  onEvent({ type: 'progress', detail: 'Consultando al modelo…' });

  const emitStopped = () => {
    const msg = STOPPED_MESSAGE;
    const usage = toTurnUsage(usageAcc, llmMs);
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
      ...(usage ? { meta: { usage } } : {}),
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg, usage);
  };

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      throwIfAborted(signal);

      const started = Date.now();
      let streamed = '';
      let tokenEst = 0;
      let lastProgress = 0;
      const emitGenerating = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgress < 200) return;
        lastProgress = now;
        const sec = Math.max(1, Math.round((now - started) / 1000));
        const detail =
          tokenEst > 0
            ? `Generando… ${tokenEst} tokens · ${sec}s`
            : `Consultando al modelo… ${sec}s`;
        onEvent({ type: 'progress', detail });
      };
      emitGenerating(true);
      const waitTick = setInterval(() => emitGenerating(), 1000);

      let response: AgentChatResponse;
      try {
        response = await client.agentChat({
          messages,
          tools: getActiveChatTools(),
          temperature: 0.3,
          signal,
          onToken: (delta) => {
            tokenEst += delta
              ? Math.max(1, Math.round(delta.length / 4))
              : 1;
            if (delta) {
              streamed += delta;
              onEvent({ type: 'token', text: streamed });
            }
            emitGenerating();
          },
        });
      } finally {
        clearInterval(waitTick);
      }
      llmMs += Date.now() - started;
      usageAcc = addUsage(usageAcc, response.usage);

      throwIfAborted(signal);

      if (response.tool_calls?.length) {
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: response.content,
          meta: { tool_calls: response.tool_calls },
        });

        messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        });

        for (let ti = 0; ti < response.tool_calls.length; ti++) {
          if (signal?.aborted) {
            for (let rj = ti; rj < response.tool_calls.length; rj++) {
              const rem = response.tool_calls[rj];
              const content = JSON.stringify({ error: 'aborted' });
              createChatMessage({
                session_id: sessionId,
                role: 'tool',
                content,
                tool_name: rem.function.name,
                tool_call_id: rem.id,
                meta: { result: { error: 'aborted' } },
              });
              messages.push({
                role: 'tool',
                content,
                tool_call_id: rem.id,
                name: rem.function.name,
              });
            }
            throwIfAborted(signal);
          }

          const call = response.tool_calls[ti];
          const result = await tools.run(
            call.function.name,
            call.function.arguments || '{}'
          );
          const content = JSON.stringify(result);
          createChatMessage({
            session_id: sessionId,
            role: 'tool',
            content,
            tool_name: call.function.name,
            tool_call_id: call.id,
            meta: { result },
          });
          messages.push({
            role: 'tool',
            content,
            tool_call_id: call.id,
            name: call.function.name,
          });
        }

        const latest = getChatSession(sessionId)!;
        if (latest.project_id !== refreshed.project_id) {
          const p = latest.project_id ? getProject(latest.project_id) : null;
          messages[0] = {
            role: 'system',
            content: buildSystemPrompt({
              projectId: latest.project_id,
              projectName: p?.name || null,
              projectCount: projects.length,
              projectDirectory,
              tier,
            }),
          };
        }

        onEvent({ type: 'progress', detail: 'Procesando herramientas…' });
        continue;
      }

      finalText =
        response.content?.trim() ||
        'Listo. ¿Querés que analice otro ticket o que ejecute tests?';

      const usage = toTurnUsage(usageAcc, llmMs);
      createChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: finalText,
        ...(usage ? { meta: { usage } } : {}),
      });
      onEvent({ type: 'token', text: finalText });
      break;
    }

    if (!finalText) {
      throwIfAborted(signal);
      finalText =
        'Alcancé el límite de pasos del agente. Probá reformular el pedido o pedime el estado del run.';
      const usage = toTurnUsage(usageAcc, llmMs);
      createChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: finalText,
        ...(usage ? { meta: { usage } } : {}),
      });
      onEvent({ type: 'token', text: finalText });
    }

    emitDone(finalText, toTurnUsage(usageAcc, llmMs));
  } catch (error: any) {
    if (signal?.aborted) {
      logger.info('QaChatAgent turn aborted', { sessionId });
      emitStopped();
      return;
    }
    logger.error('QaChatAgent turn failed', error);
    const msg = friendlyLlmError(error);
    const usage = toTurnUsage(usageAcc, llmMs);
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
      ...(usage ? { meta: { usage } } : {}),
    });
    onEvent({ type: 'token', text: msg });
    onEvent({ type: 'error', error: msg });
    emitDone(msg, usage);
  }
}
