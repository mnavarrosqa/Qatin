import OpenAI from 'openai';
import { LlmProviderClient } from './provider';
import {
  AgentChatRequest,
  AgentChatResponse,
  AgentMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmUsage,
  ToolCall,
} from './types';

function usageFromOpenAi(
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null
): LlmUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens =
    usage.total_tokens || promptTokens + completionTokens;
  if (totalTokens <= 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}
import { logger } from '../utils/logger';

function toOpenAiMessages(
  messages: AgentMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: msg.tool_call_id || '',
        content: msg.content || '',
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      return {
        role: 'assistant' as const,
        content: msg.content,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
    }
    if (msg.role === 'system') {
      return { role: 'system' as const, content: msg.content || '' };
    }
    if (msg.role === 'assistant') {
      return { role: 'assistant' as const, content: msg.content || '' };
    }
    return { role: 'user' as const, content: msg.content || '' };
  });
}

export class OpenAICompatibleClient implements LlmProviderClient {
  private client: OpenAI;
  private model: string;
  private supportsJsonFormat: boolean;
  /** Ollama qwen3.x “thinking” stalls tool calls; disable when talking to Ollama. */
  private disableThinking: boolean;

  constructor(opts: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Some servers (e.g. older Ollama) reject response_format */
    supportsJsonFormat?: boolean;
    /** Request timeout in ms (OpenAI SDK default is long; tests need a short one) */
    timeoutMs?: number;
    /** Pass `think: false` for Ollama reasoning models (qwen3, etc.) */
    disableThinking?: boolean;
  }) {
    this.model = opts.model;
    this.supportsJsonFormat = opts.supportsJsonFormat !== false;
    this.disableThinking = Boolean(opts.disableThinking);
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    logger.info('OpenAI-compatible LLM client ready', {
      model: opts.model,
      baseUrl: opts.baseUrl || 'default',
      disableThinking: this.disableThinking,
    });
  }

  private ollamaExtras(): Record<string, unknown> {
    return this.disableThinking ? { think: false } : {};
  }

  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const useJsonFormat = Boolean(request.json && this.supportsJsonFormat);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature ?? 0.3,
      ...(useJsonFormat
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      ...this.ollamaExtras(),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const message = response.choices[0]?.message as
      | (OpenAI.Chat.ChatCompletionMessage & { reasoning?: string })
      | undefined;
    const content =
      message?.content?.trim() ||
      message?.reasoning?.trim() ||
      '';
    if (!content) {
      throw new Error('Respuesta vacía del proveedor compatible con OpenAI');
    }

    return { content };
  }

  async agentChat(request: AgentChatRequest): Promise<AgentChatResponse> {
    const tools =
      request.tools?.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })) || undefined;

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAiMessages(request.messages),
        temperature: request.temperature ?? 0.3,
        ...(tools?.length ? { tools } : {}),
        ...this.ollamaExtras(),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      request.signal ? { signal: request.signal } : undefined
    );

    const message = response.choices[0]?.message as
      | (OpenAI.Chat.ChatCompletionMessage & { reasoning?: string })
      | undefined;
    if (!message) {
      throw new Error('Respuesta vacía del proveedor compatible con OpenAI');
    }

    const toolCalls: ToolCall[] | undefined = message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments || '{}',
      },
    }));

    const content =
      message.content?.trim() ||
      (!toolCalls?.length ? message.reasoning?.trim() || null : null);

    const usage = usageFromOpenAi(response.usage);
    return {
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
