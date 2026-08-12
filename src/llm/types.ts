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
  signal?: AbortSignal;
  /** Content deltas while streaming. Empty string = activity without visible text. */
  onToken?: (delta: string) => void;
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
  /** Cancel in-flight provider call when the client disconnects / user stops. */
  signal?: AbortSignal;
  /** Content deltas while streaming. Empty string = activity without visible text. */
  onToken?: (delta: string) => void;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmTurnUsage extends LlmUsage {
  llmMs: number;
  tokensPerSecond: number | null;
}

export function emptyUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(acc: LlmUsage, extra?: LlmUsage | null): LlmUsage {
  if (!extra) return acc;
  const promptTokens = acc.promptTokens + (extra.promptTokens || 0);
  const completionTokens = acc.completionTokens + (extra.completionTokens || 0);
  const totalTokens =
    acc.totalTokens +
    (extra.totalTokens || extra.promptTokens + extra.completionTokens || 0);
  return { promptTokens, completionTokens, totalTokens };
}

export function toTurnUsage(acc: LlmUsage, llmMs: number): LlmTurnUsage | undefined {
  if (acc.totalTokens <= 0) return undefined;
  const sec = llmMs / 1000;
  return {
    ...acc,
    llmMs,
    tokensPerSecond:
      sec > 0 && acc.completionTokens > 0
        ? Math.round((acc.completionTokens / sec) * 10) / 10
        : null,
  };
}

export interface AgentChatResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: LlmUsage;
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
    model: 'hermes3:latest',
    baseUrl: 'http://localhost:11434/v1',
    label: 'Ollama (servidor local o remoto)',
  },
};

export type PromptTier = 'full' | 'compact';

/**
 * Classify a provider+model pair into a prompt tier.
 * "full"    → large-context models that handle detailed instructions well.
 * "compact" → smaller / local models that need shorter, simpler prompts.
 */
export function getPromptTier(provider: LlmProvider, model?: string): PromptTier {
  if (provider === 'ollama') return 'compact';

  const m = (model || '').toLowerCase();

  // OpenAI-compatible could be anything — assume compact unless it looks like a big model
  if (provider === 'openai-compatible') {
    const bigPatterns = [
      'gpt-4', 'gpt-5', 'claude', 'sonnet', 'opus', 'haiku',
      'deepseek', 'command-r', 'qwen-72b', 'qwen-plus', 'qwen-max',
      'llama-3.1-405b', 'llama-3.3-70b', 'mixtral-8x22b',
    ];
    return bigPatterns.some((p) => m.includes(p)) ? 'full' : 'compact';
  }

  // Known cloud providers are always full-tier
  return 'full';
}

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
