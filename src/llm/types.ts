export type LlmProvider =
  | 'openai'
  | 'deepseek'
  | 'claude'
  | 'openai-compatible'
  | 'ollama';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ChatCompletionRequest {
  system: string;
  user: string;
  json?: boolean;
  temperature?: number;
}

export interface ChatCompletionResponse {
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: AgentMessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentChatRequest {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface AgentChatResponse {
  content: string | null;
  tool_calls?: ToolCall[];
}

export const PROVIDER_DEFAULTS: Record<
  LlmProvider,
  { model: string; baseUrl?: string; label: string }
> = {
  openai: {
    model: 'gpt-4-turbo-preview',
    label: 'OpenAI',
  },
  deepseek: {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    label: 'DeepSeek',
  },
  claude: {
    model: 'claude-sonnet-4-20250514',
    label: 'Claude (Anthropic)',
  },
  'openai-compatible': {
    model: 'gpt-4o',
    label: 'Compatible con OpenAI (Cursor / custom)',
  },
  ollama: {
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434/v1',
    label: 'Ollama (servidor local o remoto)',
  },
};

/** Settings keys for a saved per-provider model/base URL profile. */
export function providerProfileKeys(provider: LlmProvider): {
  model: string;
  baseUrl: string;
} {
  const slug = provider.replace(/[^a-z0-9]+/gi, '_');
  return {
    model: `llm_cfg_${slug}_model`,
    baseUrl: `llm_cfg_${slug}_base_url`,
  };
}

export function providerApiKeySetting(provider: LlmProvider): string | null {
  switch (provider) {
    case 'openai':
      return 'openai_api_key';
    case 'deepseek':
      return 'deepseek_api_key';
    case 'claude':
      return 'anthropic_api_key';
    case 'openai-compatible':
    case 'ollama':
      return 'llm_api_key';
    default:
      return null;
  }
}
