import OpenAI from 'openai';
import { LlmProviderClient } from './provider';
import {
  AgentChatRequest,
  AgentChatResponse,
  AgentMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolCall,
} from './types';
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

  constructor(opts: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Some servers (e.g. older Ollama) reject response_format */
    supportsJsonFormat?: boolean;
    /** Request timeout in ms (OpenAI SDK default is long; tests need a short one) */
    timeoutMs?: number;
  }) {
    this.model = opts.model;
    this.supportsJsonFormat = opts.supportsJsonFormat !== false;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    logger.info('OpenAI-compatible LLM client ready', {
      model: opts.model,
      baseUrl: opts.baseUrl || 'default',
    });
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
    });

    const content = response.choices[0]?.message?.content;
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

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiMessages(request.messages),
      temperature: request.temperature ?? 0.3,
      ...(tools?.length ? { tools } : {}),
    });

    const message = response.choices[0]?.message;
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

    return {
      content: message.content ?? null,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    };
  }
}
