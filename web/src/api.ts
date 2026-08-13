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

export interface ProviderModelSuggestion {
  id: string;
  name: string;
  priceLabel: string;
  priceHint: string | null;
  optionLabel: string;
}

export interface ProviderBaseUrlSuggestion {
  url: string;
  label: string;
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
  models: ProviderModelSuggestion[];
  baseUrls: ProviderBaseUrlSuggestion[];
}

export interface TestRun {
  id: number;
  project_id: number | null;
  job_id: string | null;
  source: 'jira' | 'paste';
  ticket_id: string | null;
  pasted_summary: string | null;
  status: string;
  phase: string;
  phaseLabel: string;
  currentStep: string | null;
  stepIndex: number | null;
  stepTotal: number | null;
  scenarioIndex: number | null;
  scenarioTotal: number | null;
  progressLabel: string | null;
  created_at: string;
  updated_at: string;
  steps: RunPipelineStep[];
  scenarios: RunScenarioView[];
  summary: {
    total: number;
    successful: number;
    failed: number;
    passed: boolean;
    totalDuration?: number;
  } | null;
  error: string | null;
  jiraPosted: boolean;
  canPublishToJira: boolean;
  followPath: string;
}

export type RunPipelineStep = {
  id: string;
  label: string;
  state: 'done' | 'current' | 'pending' | 'failed';
};

export type RunScenarioView = {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  duration?: number;
  error?: string;
  stepIndex?: number;
  stepTotal?: number;
  currentStep?: string;
};

export interface TestRunDetail extends TestRun {
  screenshots: Array<{ name: string; url: string }>;
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

export type SkillId =
  | 'test-plan-reviewer'
  | 'bug-writer'
  | 'selector-coach'
  | 'exploratory';

export interface SkillInfo {
  id: SkillId;
  name: string;
  description: string;
  configurable: boolean;
  installed: boolean;
  autoBeforeEnqueue?: boolean;
  createInJira?: boolean;
  maxPages?: number;
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

export type ChatUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmMs: number;
  tokensPerSecond: number | null;
};

export type ChatSseEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: string; detail?: string; data?: unknown }
  | { type: 'tool_end'; tool: string; detail?: string; data?: unknown }
  | { type: 'progress'; tool?: string; detail?: string; data?: unknown }
  | {
      type: 'done';
      message: string;
      session: { id: number; project_id: number | null; title: string };
      usage?: ChatUsage;
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

  const consume = (chunk: string, flushTail = false) => {
    buffer += chunk;
    const parts = buffer.split('\n\n');
    if (flushTail) {
      buffer = '';
    } else {
      buffer = parts.pop() || '';
    }

    for (const part of parts) {
      if (!part.trim()) continue;
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
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      consume(decoder.decode(), true);
      break;
    }
    consume(decoder.decode(value, { stream: true }));
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
  testJiraConnection: (body: {
    jira_url?: string;
    jira_email?: string;
    jira_api_token?: string;
  }) =>
    request<{ ok: true; displayName: string; latencyMs: number }>(
      '/api/jira/test',
      {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      }
    ),
  testXrayConnection: (body: {
    xray_client_id?: string;
    xray_client_secret?: string;
  }) =>
    request<{ ok: true; latencyMs: number }>('/api/xray/test', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }),
  listRuns: (limit = 50, projectId?: number | null) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (projectId != null) params.set('project_id', String(projectId));
    return request<{ runs: TestRun[] }>(`/api/runs?${params}`);
  },
  getRun: (id: number, projectId?: number | null) => {
    const params = new URLSearchParams();
    if (projectId != null) params.set('project_id', String(projectId));
    const qs = params.toString();
    return request<{ run: TestRunDetail }>(
      `/api/runs/${id}${qs ? `?${qs}` : ''}`
    );
  },
  cancelRun: (id: number) =>
    request<{ run: TestRun }>(`/api/runs/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  rerunRun: (id: number) =>
    request<{ run: TestRun }>(`/api/runs/${id}/rerun`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  publishRunToJira: (id: number) =>
    request<{ run: TestRun }>(`/api/runs/${id}/publish-jira`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  deleteRun: (id: number) =>
    request<{ success: boolean }>(`/api/runs/${id}`, {
      method: 'DELETE',
    }),
  getPlugins: () => request<{ plugins: PluginInfo[] }>('/api/plugins'),
  updatePlugin: (
    id: PluginId,
    body: { installed: boolean; maxRetries?: number }
  ) =>
    request<{ plugins: PluginInfo[] }>(`/api/plugins/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  getSkills: () => request<{ skills: SkillInfo[] }>('/api/skills'),
  updateSkill: (
    id: SkillId,
    body: {
      installed: boolean;
      autoBeforeEnqueue?: boolean;
      createInJira?: boolean;
      maxPages?: number;
    }
  ) =>
    request<{ skills: SkillInfo[] }>(`/api/skills/${id}`, {
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
  listChatSessions: (limit = 50, projectId?: number | null) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (projectId === null) params.set('project_id', 'null');
    else if (projectId != null) params.set('project_id', String(projectId));
    return request<{ sessions: ChatSession[] }>(
      `/api/chat/sessions?${params}`
    );
  },
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
