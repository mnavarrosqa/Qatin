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
import { logger } from '../utils/logger';

/** Safety cap so a hung Ollama does not block forever. User can still Stop. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * GPT-5.x (Sol/Terra/Luna) and o-series reject custom sampling —
 * only the API default (temperature=1) is allowed. Omit the field.
 */
function modelLocksTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /^gpt-5(\.|-|_)/.test(m) ||
    m.includes('gpt-5.6') ||
    /^o[1-9](-|$)/.test(m)
  );
}

/**
 * gpt-5.6* reasons by default on chat/completions. Function tools require
 * either /v1/responses or reasoning_effort=none on this endpoint.
 */
function modelNeedsNoneReasoningWithTools(model: string): boolean {
  return /gpt-5\.6/i.test(model);
}

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

type ToolAcc = { id: string; name: string; arguments: string };

function applyToolDelta(
  acc: Map<number, ToolAcc>,
  deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta['tool_calls']
) {
  if (!deltas?.length) return;
  for (const tc of deltas) {
    const idx = tc.index ?? 0;
    const cur = acc.get(idx) || { id: '', name: '', arguments: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) cur.arguments += tc.function.arguments;
    acc.set(idx, cur);
  }
}

function toolCallsFromAcc(acc: Map<number, ToolAcc>): ToolCall[] | undefined {
  if (!acc.size) return undefined;
  const toolCalls: ToolCall[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => ({
      id: tc.id || `call_${tc.name}`,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: tc.arguments || '{}',
      },
    }))
    .filter((tc) => tc.function.name);
  return toolCalls.length ? toolCalls : undefined;
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
    /** Request timeout in ms (OpenAI SDK default is 10 min) */
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
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
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

  /** Spread into chat.completions.create — empty when the model locks sampling. */
  private temperatureParam(requested?: number): { temperature?: number } {
    if (modelLocksTemperature(this.model)) return {};
    return { temperature: requested ?? 0.3 };
  }

  /**
   * When tools are present on gpt-5.6*, force reasoning off so chat/completions
   * accepts function tools (otherwise OpenAI 400s with the default effort).
   */
  private reasoningParam(hasTools: boolean): { reasoning_effort?: 'none' } {
    if (hasTools && modelNeedsNoneReasoningWithTools(this.model)) {
      return { reasoning_effort: 'none' };
    }
    return {};
  }

  private reqOpts(signal?: AbortSignal) {
    return signal ? { signal } : undefined;
  }

  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const useJsonFormat = Boolean(request.json && this.supportsJsonFormat);
    const params = {
      model: this.model,
      messages: [
        { role: 'system' as const, content: request.system },
        { role: 'user' as const, content: request.user },
      ],
      ...this.temperatureParam(request.temperature),
      ...(useJsonFormat
        ? { response_format: { type: 'json_object' as const } }
        : {}),
      ...this.ollamaExtras(),
    };

    if (request.onToken) {
      const stream = await this.client.chat.completions.create(
        { ...params, stream: true } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        this.reqOpts(request.signal)
      );
      let content = '';
      let reasoning = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as
          | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
              reasoning?: string;
            })
          | undefined;
        if (delta?.content) {
          content += delta.content;
          request.onToken(delta.content);
        } else if (delta?.reasoning) {
          reasoning += delta.reasoning;
          request.onToken('');
        }
      }
      const text = content.trim() || reasoning.trim();
      if (!text) {
        throw new Error('Respuesta vacía del proveedor compatible con OpenAI');
      }
      return { content: text };
    }

    const response = await this.client.chat.completions.create(
      params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      this.reqOpts(request.signal)
    );

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
    try {
      const streamed = await this.agentChatStream(request);
      if (streamed.content || streamed.tool_calls?.length) return streamed;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      logger.warn('Streaming agentChat failed, retrying without stream', error);
    }
    return this.agentChatOnce(request);
  }

  private async agentChatStream(
    request: AgentChatRequest
  ): Promise<AgentChatResponse> {
    const tools =
      request.tools?.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })) || undefined;

    const hasTools = Boolean(tools?.length);
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAiMessages(request.messages),
        ...this.temperatureParam(request.temperature),
        ...(hasTools ? { tools } : {}),
        ...this.reasoningParam(hasTools),
        ...this.ollamaExtras(),
        stream: true,
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
      this.reqOpts(request.signal)
    );

    let content = '';
    let reasoning = '';
    const toolAcc = new Map<number, ToolAcc>();
    let usage: LlmUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.usage) usage = usageFromOpenAi(chunk.usage);
      const delta = chunk.choices[0]?.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
            reasoning?: string;
          })
        | undefined;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        request.onToken?.(delta.content);
      } else if (delta.reasoning) {
        reasoning += delta.reasoning;
        request.onToken?.('');
      }

      if (delta.tool_calls?.length) {
        applyToolDelta(toolAcc, delta.tool_calls);
        request.onToken?.('');
      }
    }

    const toolCalls = toolCallsFromAcc(toolAcc);
    const text =
      content.trim() ||
      (!toolCalls?.length ? reasoning.trim() || null : null);

    return {
      content: text,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async agentChatOnce(
    request: AgentChatRequest
  ): Promise<AgentChatResponse> {
    const tools =
      request.tools?.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })) || undefined;

    const hasTools = Boolean(tools?.length);
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAiMessages(request.messages),
        ...this.temperatureParam(request.temperature),
        ...(hasTools ? { tools } : {}),
        ...this.reasoningParam(hasTools),
        ...this.ollamaExtras(),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      this.reqOpts(request.signal)
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
