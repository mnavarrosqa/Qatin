import Anthropic from '@anthropic-ai/sdk';
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

function usageFromClaude(usage?: {
  input_tokens?: number;
  output_tokens?: number;
}): LlmUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens || 0;
  const completionTokens = usage.output_tokens || 0;
  const totalTokens = promptTokens + completionTokens;
  if (totalTokens <= 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}
import { logger } from '../utils/logger';

function splitSystem(messages: AgentMessage[]): {
  system: string;
  rest: AgentMessage[];
} {
  const systemParts: string[] = [];
  const rest: AgentMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
    } else {
      rest.push(msg);
    }
  }
  return { system: systemParts.join('\n\n'), rest };
}

function toClaudeMessages(
  messages: AgentMessage[]
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content || '' });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls || []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      if (blocks.length) {
        out.push({ role: 'assistant', content: blocks });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResult: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: msg.content || '',
      };

      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(toolResult);
      } else {
        out.push({ role: 'user', content: [toolResult] });
      }
    }
  }

  return out;
}

export class ClaudeClient implements LlmProviderClient {
  private client: Anthropic;
  private model: string;

  constructor(opts: { apiKey: string; model: string }) {
    this.model = opts.model;
    this.client = new Anthropic({ apiKey: opts.apiKey });
    logger.info('Claude LLM client ready', { model: opts.model });
  }

  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const system = request.json
      ? `${request.system}\n\nRespond with valid JSON only, no markdown fences.`
      : request.system;

    const createOpts = request.signal ? { signal: request.signal } : undefined;
    const params = {
      model: this.model,
      max_tokens: 4096,
      temperature: request.temperature ?? 0.3,
      system,
      messages: [{ role: 'user' as const, content: request.user }],
    };

    let content: string;
    if (request.onToken) {
      const stream = this.client.messages.stream(params, createOpts);
      stream.on('text', (text) => request.onToken?.(text));
      const response = await stream.finalMessage();
      const block = response.content.find((b) => b.type === 'text');
      content = block && block.type === 'text' ? block.text.trim() : '';
    } else {
      const response = await this.client.messages.create(params, createOpts);
      const block = response.content.find((b) => b.type === 'text');
      content = block && block.type === 'text' ? block.text.trim() : '';
    }

    if (!content) {
      throw new Error('Respuesta vacía de Claude');
    }

    if (request.json) {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) {
        content = fenced[1].trim();
      }
    }

    return { content };
  }

  async agentChat(request: AgentChatRequest): Promise<AgentChatResponse> {
    const { system, rest } = splitSystem(request.messages);
    const tools: Anthropic.Tool[] | undefined = request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    }));

    const params = {
      model: this.model,
      max_tokens: 4096,
      temperature: request.temperature ?? 0.3,
      ...(system ? { system } : {}),
      messages: toClaudeMessages(rest),
      ...(tools?.length ? { tools } : {}),
    };
    const createOpts = request.signal ? { signal: request.signal } : undefined;

    let response: Anthropic.Message;
    if (request.onToken) {
      const stream = this.client.messages.stream(params, createOpts);
      stream.on('text', (text) => request.onToken?.(text));
      response = await stream.finalMessage();
    } else {
      response = await this.client.messages.create(params, createOpts);
    }

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const usage = usageFromClaude(response.usage);
    return {
      content: textParts.length ? textParts.join('\n') : null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
