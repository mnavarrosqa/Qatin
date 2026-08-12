import {
  api,
  type ChatMessage,
  type ChatSseEvent,
  type ChatSession,
  type ChatUsage,
} from './api';

export type ToolStep = {
  tool: string;
  detail?: string;
  status: 'running' | 'done';
  data?: unknown;
};

export type UiMessage =
  | { kind: 'user'; id: string; content: string }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      tools?: ToolStep[];
      usage?: ChatUsage;
    };

export function usageFromMeta(meta: unknown): ChatUsage | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const u = (meta as { usage?: ChatUsage }).usage;
  if (!u || typeof u.totalTokens !== 'number' || u.totalTokens <= 0) {
    return undefined;
  }
  return u;
}

export function toUiMessages(rows: ChatMessage[]): UiMessage[] {
  return rows
    .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
    .map((m) =>
      m.role === 'user'
        ? { kind: 'user' as const, id: String(m.id), content: m.content || '' }
        : {
            kind: 'assistant' as const,
            id: String(m.id),
            content: m.content || '',
            usage: usageFromMeta(m.meta),
          }
    );
}

type GenerationState = {
  sessionId: number;
  messages: UiMessage[];
  busy: boolean;
  error: string;
  session: ChatSession | null;
};

type Listener = () => void;

let generation: GenerationState | null = null;
let controller: AbortController | null = null;
let version = 0;
const listeners = new Set<Listener>();

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function setGeneration(next: GenerationState | null) {
  generation = next;
  emit();
}

function patchGeneration(partial: Partial<GenerationState>) {
  if (!generation) return;
  generation = { ...generation, ...partial };
  emit();
}

function updateAssistant(
  assistantId: string,
  updater: (msg: Extract<UiMessage, { kind: 'assistant' }>) => UiMessage
) {
  if (!generation) return;
  generation = {
    ...generation,
    messages: generation.messages.map((m) =>
      m.id === assistantId && m.kind === 'assistant' ? updater(m) : m
    ),
  };
  emit();
}

/** Status-only steps (e.g. "Consultando al modelo…") are not real tools. */
function isProgressStep(t: ToolStep) {
  return t.tool === 'progress' || !t.tool;
}

function settleTools(
  tools: ToolStep[] | undefined,
  opts?: { dropProgress?: boolean }
): ToolStep[] {
  let next = (tools || []).map((t) =>
    t.status === 'running' ? { ...t, status: 'done' as const } : t
  );
  if (opts?.dropProgress) {
    next = next.filter((t) => !isProgressStep(t));
  }
  return next;
}

export function subscribeChatGeneration(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic version — use with useSyncExternalStore so React always sees updates. */
export function getChatGenerationVersion(): number {
  return version;
}

export function getChatGeneration(): GenerationState | null {
  return generation;
}

export function stopChatGeneration() {
  const active = controller;
  if (active) {
    (active as AbortController & { qatinStopped?: boolean }).qatinStopped = true;
    active.abort();
  }
  controller = null;
  if (!generation?.busy) return;

  const messages = generation.messages.map((m) => {
    if (m.kind !== 'assistant') return m;
    const tools = settleTools(m.tools, { dropProgress: true });
    return {
      ...m,
      content: m.content.trim() ? m.content : 'Consulta detenida.',
      tools,
    };
  });

  setGeneration({
    ...generation,
    messages,
    busy: false,
    error: '',
  });
}

export async function startChatGeneration(opts: {
  sessionId: number;
  content: string;
  baseMessages: UiMessage[];
  session: ChatSession | null;
}): Promise<void> {
  const { sessionId, content, baseMessages, session } = opts;

  controller?.abort();
  const nextController = new AbortController();
  (nextController as any).qatinStopped = false;
  controller = nextController;

  const assistantId = `a-${Date.now()}`;
  const userMsg: UiMessage = {
    kind: 'user',
    id: `u-${Date.now()}`,
    content,
  };

  setGeneration({
    sessionId,
    session,
    busy: true,
    error: '',
    messages: [
      ...baseMessages,
      userMsg,
      { kind: 'assistant', id: assistantId, content: '', tools: [] },
    ],
  });

  let stoppedByUser = false;

  try {
    await api.sendChatMessage(
      sessionId,
      content,
      (ev: ChatSseEvent) => {
        if (ev.type === 'token') {
          updateAssistant(assistantId, (m) => ({
            ...m,
            content: ev.text,
          }));
        } else if (ev.type === 'tool_start') {
          updateAssistant(assistantId, (m) => ({
            ...m,
            tools: [
              ...settleTools(m.tools, { dropProgress: true }),
              {
                tool: ev.tool,
                detail: ev.detail,
                status: 'running' as const,
              },
            ],
          }));
        } else if (ev.type === 'tool_end') {
          updateAssistant(assistantId, (m) => {
            const tools = [...(m.tools || [])];
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].tool === ev.tool && tools[i].status === 'running') {
                tools[i] = {
                  ...tools[i],
                  detail: ev.detail || tools[i].detail,
                  status: 'done',
                  data: ev.data ?? tools[i].data,
                };
                break;
              }
            }
            return { ...m, tools };
          });
        } else if (ev.type === 'progress') {
          updateAssistant(assistantId, (m) => {
            const tools = [...(m.tools || [])];
            const last = tools[tools.length - 1];
            if (last && last.status === 'running') {
              tools[tools.length - 1] = {
                ...last,
                detail: ev.detail || last.detail,
              };
              return { ...m, tools };
            }
            if (ev.detail) {
              return {
                ...m,
                tools: [
                  ...tools,
                  {
                    tool: ev.tool || 'progress',
                    detail: ev.detail,
                    status: 'running' as const,
                  },
                ],
              };
            }
            return m;
          });
        } else if (ev.type === 'done') {
          updateAssistant(assistantId, (m) => ({
            ...m,
            content: ev.message?.trim() ? ev.message : m.content || ev.message,
            tools: settleTools(m.tools, { dropProgress: true }),
            usage: ev.usage || m.usage,
          }));
          const current = getChatGeneration();
          if (current?.session) {
            patchGeneration({
              session: {
                ...current.session,
                project_id: ev.session.project_id,
                title: ev.session.title,
              },
            });
          }
        } else if (ev.type === 'error') {
          patchGeneration({ error: ev.error });
          updateAssistant(assistantId, (m) => ({
            ...m,
            content: m.content || ev.error,
          }));
        }
      },
      nextController.signal
    );
  } catch (err: any) {
    stoppedByUser =
      err?.name === 'AbortError' || Boolean((nextController as any).qatinStopped);
    if (!stoppedByUser) {
      patchGeneration({
        error: err.message || 'Falló el envío',
      });
    }
  } finally {
    if (controller === nextController) {
      controller = null;
    }
    stoppedByUser =
      stoppedByUser || Boolean((nextController as any).qatinStopped);

    // Give the server a beat to persist "Consulta detenida." after abort.
    if (stoppedByUser) {
      await new Promise((r) => setTimeout(r, 350));
    }

    // Always reconcile with DB so the UI shows the saved answer even if SSE
    // events were dropped or buffered.
    try {
      const res = await api.getChatSession(sessionId);
      const fromDb = toUiMessages(res.messages);
      const current = getChatGeneration();
      if (current && current.sessionId === sessionId) {
        const liveAssistant = [...current.messages]
          .reverse()
          .find((m): m is Extract<UiMessage, { kind: 'assistant' }> =>
            m.kind === 'assistant'
          );
        const liveTools = settleTools(liveAssistant?.tools, {
          dropProgress: true,
        });
        const merged = fromDb.length ? [...fromDb] : [...current.messages];
        let last = merged[merged.length - 1];

        if (last?.kind === 'assistant') {
          const next = {
            ...last,
            tools:
              liveTools.length && !(last.tools && last.tools.length)
                ? liveTools
                : last.tools,
            usage: last.usage || liveAssistant?.usage,
          };
          merged[merged.length - 1] = next;
          last = next;
        }

        if (stoppedByUser) {
          if (last?.kind === 'assistant') {
            if (!last.content.trim()) {
              merged[merged.length - 1] = {
                ...last,
                content: 'Consulta detenida.',
                tools: last.tools || liveTools,
              };
            }
          } else if (liveAssistant) {
            merged.push({
              ...liveAssistant,
              content: liveAssistant.content.trim() || 'Consulta detenida.',
              tools: liveTools,
            });
          }
        }

        setGeneration({
          ...current,
          session: res.session,
          messages: merged,
          busy: false,
        });
      } else {
        patchGeneration({ busy: false });
      }
    } catch {
      patchGeneration({ busy: false });
    }
  }
}
