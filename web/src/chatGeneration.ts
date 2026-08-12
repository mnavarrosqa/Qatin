import {
  api,
  type ChatSseEvent,
  type ChatSession,
} from './api';

export type ToolStep = {
  tool: string;
  detail?: string;
  status: 'running' | 'done';
};

export type UiMessage =
  | { kind: 'user'; id: string; content: string }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      tools?: ToolStep[];
    };

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
const listeners = new Set<Listener>();

function emit() {
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

export function subscribeChatGeneration(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatGeneration(): GenerationState | null {
  return generation;
}

export function stopChatGeneration() {
  controller?.abort();
  controller = null;
  if (generation?.busy) {
    patchGeneration({ busy: false });
  }
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

  try {
    await api.sendChatMessage(
      sessionId,
      content,
      (ev: ChatSseEvent) => {
        if (ev.type === 'token') {
          updateAssistant(assistantId, (m) => ({ ...m, content: ev.text }));
        } else if (ev.type === 'tool_start') {
          updateAssistant(assistantId, (m) => ({
            ...m,
            tools: [
              ...(m.tools || []),
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
          updateAssistant(assistantId, (m) =>
            m.content ? m : { ...m, content: ev.message || m.content }
          );
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
    if (err?.name !== 'AbortError') {
      patchGeneration({
        error: err.message || 'Falló el envío',
      });
    }
  } finally {
    if (controller === nextController) {
      controller = null;
    }
    patchGeneration({ busy: false });
  }
}
