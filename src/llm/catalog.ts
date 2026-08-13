import type { LlmProvider } from './types';

/** Curated chat models, ordered expensive → cheap within each provider. */
export type ModelSuggestion = {
  id: string;
  /** Short human label */
  name: string;
  /** Relative cost within the provider list */
  priceLabel: 'más caro' | 'caro' | 'medio' | 'barato' | 'más barato';
  /** Approximate list price hint (input/output per 1M tokens) */
  priceHint?: string;
};

export type BaseUrlSuggestion = {
  url: string;
  label: string;
};

export type ProviderCatalog = {
  models: ModelSuggestion[];
  baseUrls: BaseUrlSuggestion[];
};

/**
 * Suggestions for Settings / Projects autocomplete.
 * Prices are approximate public list rates — only for relative guidance.
 */
export const PROVIDER_CATALOG: Record<LlmProvider, ProviderCatalog> = {
  openai: {
    models: [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        priceLabel: 'más caro',
        priceHint: '~$5 / $30',
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        priceLabel: 'caro',
        priceHint: '~$2.50 / $10',
      },
      {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        priceLabel: 'medio',
        priceHint: '~$2 / $12',
      },
      {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        priceLabel: 'barato',
        priceHint: '~$0.20 / $1.20',
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        priceLabel: 'más barato',
        priceHint: '~$0.15 / $0.60',
      },
    ],
    baseUrls: [
      {
        url: 'https://api.openai.com/v1',
        label: 'API oficial de OpenAI',
      },
    ],
  },
  deepseek: {
    models: [
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        priceLabel: 'caro',
        priceHint: 'razonamiento',
      },
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        priceLabel: 'barato',
        priceHint: 'uso general',
      },
    ],
    baseUrls: [
      {
        url: 'https://api.deepseek.com',
        label: 'API oficial de DeepSeek',
      },
      {
        url: 'https://api.deepseek.com/v1',
        label: 'DeepSeek (ruta /v1)',
      },
    ],
  },
  claude: {
    models: [
      {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        priceLabel: 'más caro',
        priceHint: '~$10 / $50',
      },
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        priceLabel: 'caro',
        priceHint: '~$5 / $25',
      },
      {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        priceLabel: 'caro',
        priceHint: '~$5 / $25',
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        priceLabel: 'medio',
        priceHint: '~$2 / $10',
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        priceLabel: 'medio',
        priceHint: '~$3 / $15',
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        priceLabel: 'más barato',
        priceHint: '~$1 / $5',
      },
    ],
    baseUrls: [
      {
        url: 'https://api.anthropic.com',
        label: 'API oficial de Anthropic',
      },
    ],
  },
  'openai-compatible': {
    models: [
      {
        id: 'gpt-4o',
        name: 'gpt-4o (ejemplo)',
        priceLabel: 'medio',
      },
      {
        id: 'gpt-4o-mini',
        name: 'gpt-4o-mini (ejemplo)',
        priceLabel: 'barato',
      },
    ],
    baseUrls: [
      {
        url: 'https://api.openai.com/v1',
        label: 'OpenAI',
      },
      {
        url: 'https://api.deepseek.com',
        label: 'DeepSeek',
      },
      {
        url: 'http://localhost:11434/v1',
        label: 'Ollama local',
      },
      {
        url: 'https://openrouter.ai/api/v1',
        label: 'OpenRouter',
      },
    ],
  },
  ollama: {
    models: [
      {
        id: 'llama3.2',
        name: 'Llama 3.2',
        priceLabel: 'más barato',
        priceHint: 'local / gratis',
      },
      {
        id: 'llama3.1',
        name: 'Llama 3.1',
        priceLabel: 'más barato',
        priceHint: 'local / gratis',
      },
      {
        id: 'qwen2.5',
        name: 'Qwen 2.5',
        priceLabel: 'más barato',
        priceHint: 'local / gratis',
      },
      {
        id: 'mistral',
        name: 'Mistral',
        priceLabel: 'más barato',
        priceHint: 'local / gratis',
      },
      {
        id: 'hermes3:latest',
        name: 'Hermes 3',
        priceLabel: 'más barato',
        priceHint: 'local / gratis',
      },
    ],
    baseUrls: [
      {
        url: 'http://localhost:11434/v1',
        label: 'Ollama en esta máquina',
      },
      {
        url: 'http://127.0.0.1:11434/v1',
        label: 'Ollama (loopback)',
      },
      {
        url: 'http://192.168.1.10:11434/v1',
        label: 'Ollama en LAN (ejemplo)',
      },
    ],
  },
};

export function modelOptionLabel(model: ModelSuggestion): string {
  const bits = [model.id, model.priceLabel];
  if (model.priceHint) bits.push(model.priceHint);
  return bits.join(' · ');
}
