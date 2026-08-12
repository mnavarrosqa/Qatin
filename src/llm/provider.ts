import {
  AgentChatRequest,
  AgentChatResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from './types';

export interface LlmProviderClient {
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  agentChat(request: AgentChatRequest): Promise<AgentChatResponse>;
}
