import {
  createLlmClient,
  resolveLlmConfig,
  AgentMessage,
  LlmProvider,
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
import { QA_CHAT_TOOLS, QaChatToolRunner, ToolEventEmitter } from './qa-chat-tools';
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
    }
  | { type: 'error'; error: string };

function buildSystemPrompt(opts: {
  projectId: number | null;
  projectName?: string | null;
  projectCount: number;
}): string {
  const projectLine = opts.projectId
    ? `Proyecto activo: id=${opts.projectId}${
        opts.projectName ? ` (${opts.projectName})` : ''
      }.`
    : opts.projectCount === 0
      ? 'No hay proyectos configurados. Pedile al usuario que cree uno en Proyectos (y LLM/Jira en Configuración) antes de analizar o probar.'
      : 'Todavía no hay proyecto activo. Usá list_projects y preguntá cuál quieren, o set_active_project si lo nombran.';

  const custom = (getSetting('agent_chat_instructions') || '').trim();
  const customBlock = custom
    ? `

## Custom user instructions
Follow these with priority (without violating the rules above):
${custom}`
    : '';

  return `You are the QA agent of Qatin. Answer in Spanish (argentino). Be clear and concise.

Your job: understand tickets, design test cases, run them with Playwright, and report results.

Workflow:
1. User gives a ticket (Jira key or pasted text) → use fetch_ticket to get info → explain what the ticket asks, what to test, what risks you see.
2. Use analyze_ticket to generate test cases (happy path + negative + edge cases). Show summary to user before proceeding.
3. User approves → use save_test_cases to persist them.
4. Use enqueue_run to queue execution. Then get_run_status (use wait_ms up to 45000) to check progress.
5. Report results: what passed, what failed, screenshot URLs (/screenshots/...), and suggested next step.

Rules:
- Never invent ticket content. Always use fetch_ticket or analyze_ticket.
- ${projectLine}
- If no active project: use list_projects and ask which one.
- If config is missing (no project, no base_url, no LLM, no Jira creds): say exactly what is missing and where to configure it (Settings or Projects page).
- Respond in human-readable text, not raw JSON (unless user asks for technical detail).
- Always include screenshot URLs (/screenshots/...) when available.
- If a run fails: analyze whether it is an app bug, a broken test case (bad selector, ambiguous step), or a config issue.
- If user pastes free text (not a ticket key): treat it as a feature description using fetch_ticket with pasted_summary + pasted_description.
- Use list_recent_runs to give context on what was already tested.
- Use lists, keep responses short. If the ticket is ambiguous, ask before generating cases.${customBlock}`;
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

export async function runQaChatTurn(opts: {
  sessionId: number;
  userMessage: string;
  onEvent: (event: ChatAgentEvent) => void;
}): Promise<void> {
  const { sessionId, userMessage, onEvent } = opts;

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
  try {
    const config = resolveLlmConfig(llmPartial);
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
    onEvent({
      type: 'done',
      message: msg,
      session: {
        id: sessionId,
        project_id: getChatSession(sessionId)?.project_id ?? null,
        title: getChatSession(sessionId)?.title || 'Nueva conversación',
      },
    });
    return;
  }

  const emitTools: ToolEventEmitter = (ev) => {
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

  const tools = new QaChatToolRunner(sessionId, emitTools);
  const refreshed = getChatSession(sessionId)!;

  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        projectId: refreshed.project_id,
        projectName,
        projectCount: projects.length,
      }),
    },
    ...historyToAgentMessages(listChatMessages(sessionId)),
  ];

  let finalText = '';

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client.agentChat({
        messages,
        tools: QA_CHAT_TOOLS,
        temperature: 0.3,
      });

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

        for (const call of response.tool_calls) {
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

        // Refresh system project line after set_active_project
        const latest = getChatSession(sessionId)!;
        if (latest.project_id !== refreshed.project_id) {
          const p = latest.project_id ? getProject(latest.project_id) : null;
          messages[0] = {
            role: 'system',
            content: buildSystemPrompt({
              projectId: latest.project_id,
              projectName: p?.name || null,
              projectCount: projects.length,
            }),
          };
        }

        continue;
      }

      finalText =
        response.content?.trim() ||
        'Listo. ¿Querés que analice otro ticket o que ejecute tests?';

      createChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: finalText,
      });
      onEvent({ type: 'token', text: finalText });
      break;
    }

    if (!finalText) {
      finalText =
        'Alcancé el límite de pasos del agente. Probá reformular el pedido o pedime el estado del run.';
      createChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: finalText,
      });
      onEvent({ type: 'token', text: finalText });
    }

    const endSession = getChatSession(sessionId)!;
    onEvent({
      type: 'done',
      message: finalText,
      session: {
        id: endSession.id,
        project_id: endSession.project_id,
        title: endSession.title,
      },
    });
  } catch (error: any) {
    logger.error('QaChatAgent turn failed', error);
    const msg =
      error?.message || 'Falló el agente de chat. Revisá el LLM y reintentá.';
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
    });
    onEvent({ type: 'error', error: msg });
  }
}
