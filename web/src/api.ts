export type LlmProvider =
  | 'openai'
  | 'deepseek'
  | 'claude'
  | 'openai-compatible'
  | 'ollama';

export interface Project {
  id: number;
  name: string;
  base_url: string;
  staging_url: string | null;
  jira_project_key: string | null;
  jira_url: string | null;
  test_user_email: string | null;
  has_password: boolean;
  llm_provider: LlmProvider | null;
  llm_model: string | null;
  llm_base_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  name: string;
  base_url?: string;
  staging_url?: string | null;
  jira_project_key?: string | null;
  jira_url?: string | null;
  test_user_email?: string | null;
  test_user_password?: string | null;
  llm_provider?: LlmProvider | null;
  llm_model?: string | null;
  llm_base_url?: string | null;
}

export interface ProviderInfo {
  id: LlmProvider;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string | null;
  configured: boolean;
  configuredModel: string | null;
  configuredBaseUrl: string | null;
  requiresBaseUrl: boolean;
}

export interface TestRun {
  id: number;
  project_id: number | null;
  job_id: string | null;
  source: 'jira' | 'paste';
  ticket_id: string | null;
  pasted_summary: string | null;
  pasted_description: string | null;
  status: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export type PluginId =
  | 'engram'
  | 'self-heal'
  | 'flaky-retry'
  | 'network-guard';

export interface PluginInfo {
  id: PluginId;
  name: string;
  description: string;
  configurable: boolean;
  installed: boolean;
  maxRetries?: number;
}

export interface ChatSession {
  id: number;
  project_id: number | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  meta: unknown | null;
  created_at: string;
}

export type ChatSseEvent =
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

async function readChatSse(
  res: Response,
  onEvent: (event: ChatSseEvent) => void
): Promise<void> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      (data as any).error || `Falló el pedido (${res.status})`
    );
  }
  if (!res.body) {
    throw new Error('Respuesta SSE vacía');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const lines = part.split('\n');
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try {
        const data = JSON.parse(dataLines.join('\n'));
        onEvent({ type: eventName, ...data } as ChatSseEvent);
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `Falló el pedido (${res.status})`);
  }
  return data as T;
}

export const api = {
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (body: ProjectInput) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProject: (id: number, body: Partial<ProjectInput>) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteProject: (id: number) =>
    request<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  getProviders: () => request<{ providers: ProviderInfo[] }>('/api/providers'),
  testLlmConnection: (body: {
    provider?: LlmProvider;
    model?: string;
    base_url?: string;
    api_key?: string;
  }) =>
    request<{
      ok: true;
      provider: LlmProvider;
      model: string;
      latencyMs: number;
      reply: string;
    }>('/api/llm/test', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    }),
  getSettings: () =>
    request<{ settings: Record<string, string> }>('/api/settings'),
  updateSettings: (body: Record<string, string>) =>
    request<{ settings: Record<string, string> }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  connectJiraMcp: (body: {
    jira_url?: string;
    jira_email?: string;
    jira_api_token?: string;
  }) =>
    request<{ settings: Record<string, string>; tools: string[] }>(
      '/api/jira/mcp/connect',
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  disconnectJiraMcp: () =>
    request<{ settings: Record<string, string> }>('/api/jira/mcp/disconnect', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listRuns: (limit = 50) =>
    request<{ runs: TestRun[] }>(`/api/runs?limit=${limit}`),
  getPlugins: () => request<{ plugins: PluginInfo[] }>('/api/plugins'),
  updatePlugin: (
    id: PluginId,
    body: { installed: boolean; maxRetries?: number }
  ) =>
    request<{ plugins: PluginInfo[] }>(`/api/plugins/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  getAgentPrompts: () =>
    request<{
      tier: 'full' | 'compact';
      provider: string | null;
      model: string | null;
      defaults: {
        agent_chat_instructions: string;
        agent_analyzer_instructions: string;
      };
    }>('/api/agent-prompts'),
  listChatSessions: (limit = 50) =>
    request<{ sessions: ChatSession[] }>(`/api/chat/sessions?limit=${limit}`),
  createChatSession: (body?: { project_id?: number | null; title?: string }) =>
    request<{ session: ChatSession }>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  getChatSession: (id: number) =>
    request<{ session: ChatSession; messages: ChatMessage[] }>(
      `/api/chat/sessions/${id}`
    ),
  updateChatSession: (
    id: number,
    body: { project_id?: number | null; title?: string }
  ) =>
    request<{ session: ChatSession }>(`/api/chat/sessions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteChatSession: (id: number) =>
    request<{ success: boolean }>(`/api/chat/sessions/${id}`, {
      method: 'DELETE',
    }),
  sendChatMessage: (
    id: number,
    content: string,
    onEvent: (event: ChatSseEvent) => void,
    signal?: AbortSignal
  ) =>
    fetch(`/api/chat/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    }).then((res) => readChatSse(res, onEvent)),
};
