import { LlmProviderClient } from './provider';
import { OpenAICompatibleClient } from './openai-compatible';
import { ClaudeClient } from './claude';
import {
  LlmConfig,
  LlmProvider,
  PROVIDER_DEFAULTS,
  providerApiKeySetting,
  providerProfileKeys,
} from './types';
import { logger } from '../utils/logger';

function settingKey(provider: LlmProvider): string | null {
  return providerApiKeySetting(provider);
}

function readSetting(key: string): string | undefined {
  try {
    // Lazy require to avoid circular init with db
    const { getSetting } = require('../db') as typeof import('../db');
    return getSetting(key) || undefined;
  } catch {
    return undefined;
  }
}

function resolveApiKey(provider: LlmProvider, override?: string): string {
  if (override) return override;

  const keyName = settingKey(provider);
  const fromSettings = keyName ? readSetting(keyName) : undefined;
  const fromEnv: Record<LlmProvider, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
    'openai-compatible':
      process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_API_KEY,
    // OpenAI SDK requires a non-empty key; Ollama does not validate it
    ollama: process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || 'ollama',
  };

  const key = fromSettings || fromEnv[provider];
  if (!key) {
    throw new Error(
      `No hay API key configurada para el proveedor "${provider}". Seteala en Configuración o en el .env.`
    );
  }
  return key;
}

/** Coerce pasted Ollama/native URLs into OpenAI-compatible base (.../v1). */
export function normalizeLlmBaseUrl(
  provider: LlmProvider,
  url?: string | null
): string | undefined {
  if (!url?.trim()) return undefined;
  let u = url.trim().replace(/\/+$/, '');

  if (provider === 'ollama' || provider === 'openai-compatible') {
    u = u.replace(/\/api\/(chat|generate|tags|show|pull|push|embeddings)(\/.*)?$/i, '');
    u = u.replace(/\/v1\/(chat\/completions|completions|models|embeddings)$/i, '/v1');
    if (provider === 'ollama' && !/\/v1$/i.test(u)) {
      u = `${u}/v1`;
    }
  }

  return u;
}

function resolveBaseUrl(provider: LlmProvider, override?: string): string | undefined {
  if (override) {
    return normalizeLlmBaseUrl(provider, override) || override;
  }
  if (provider === 'deepseek') {
    return PROVIDER_DEFAULTS.deepseek.baseUrl;
  }
  if (provider === 'ollama') {
    return normalizeLlmBaseUrl(
      provider,
      process.env.OLLAMA_BASE_URL ||
        process.env.LLM_BASE_URL ||
        PROVIDER_DEFAULTS.ollama.baseUrl
    );
  }
  if (provider === 'openai-compatible') {
    return normalizeLlmBaseUrl(provider, process.env.LLM_BASE_URL);
  }
  return undefined;
}

export function createLlmClient(
  config: LlmConfig,
  opts?: { timeoutMs?: number }
): LlmProviderClient {
  const provider = config.provider;
  const defaults = PROVIDER_DEFAULTS[provider];
  const model = config.model || defaults.model;
  const apiKey = resolveApiKey(provider, config.apiKey);
  const baseUrl = resolveBaseUrl(provider, config.baseUrl);

  logger.info('Creating LLM client', { provider, model, baseUrl: baseUrl || 'default' });

  if (provider === 'claude') {
    return new ClaudeClient({ apiKey, model });
  }

  return new OpenAICompatibleClient({
    apiKey,
    model,
    baseUrl,
    // Ollama's OpenAI shim varies by version; prompts already request JSON
    supportsJsonFormat: provider !== 'ollama',
    // qwen3.x thinking mode stalls / empties tool calls via the OpenAI shim
    disableThinking: provider === 'ollama',
    timeoutMs: opts?.timeoutMs,
  });
}

/** Model / base URL saved for a specific provider (Settings profile). */
export function readProviderProfile(provider: LlmProvider): {
  model?: string;
  baseUrl?: string;
} {
  const keys = providerProfileKeys(provider);
  const profileModel = readSetting(keys.model);
  const profileBaseUrl = readSetting(keys.baseUrl);
  const activeProvider = readSetting('llm_provider');

  // Fall back to the active global pair when it belongs to this provider
  const activeModel =
    activeProvider === provider ? readSetting('llm_model') : undefined;
  const activeBaseUrl =
    activeProvider === provider ? readSetting('llm_base_url') : undefined;

  return {
    model: profileModel || activeModel,
    baseUrl: profileBaseUrl || activeBaseUrl,
  };
}

export function resolveLlmConfig(partial?: Partial<LlmConfig> | null): LlmConfig {
  const fromSettingsProvider = readSetting('llm_provider');

  const provider = (partial?.provider ||
    fromSettingsProvider ||
    process.env.LLM_PROVIDER ||
    'openai') as LlmProvider;

  if (!PROVIDER_DEFAULTS[provider]) {
    throw new Error(`Proveedor de LLM desconocido: ${provider}`);
  }

  const profile = readProviderProfile(provider);

  const rawBaseUrl =
    partial?.baseUrl ||
    profile.baseUrl ||
    (provider === 'ollama'
      ? process.env.OLLAMA_BASE_URL ||
        process.env.LLM_BASE_URL ||
        PROVIDER_DEFAULTS.ollama.baseUrl
      : process.env.LLM_BASE_URL);

  return {
    provider,
    model:
      partial?.model ||
      profile.model ||
      process.env.LLM_MODEL ||
      PROVIDER_DEFAULTS[provider].model,
    apiKey: partial?.apiKey,
    baseUrl: normalizeLlmBaseUrl(provider, rawBaseUrl) || rawBaseUrl,
  };
}

export interface LlmConnectionTestResult {
  ok: true;
  provider: LlmProvider;
  model: string;
  latencyMs: number;
  reply: string;
}

const TEST_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Minimal chat call to verify provider credentials / reachability. */
export async function testLlmConnection(
  partial?: Partial<LlmConfig> | null
): Promise<LlmConnectionTestResult> {
  const config = resolveLlmConfig(partial);
  const client = createLlmClient(config, { timeoutMs: TEST_TIMEOUT_MS });
  const started = Date.now();

  const response = await withTimeout(
    client.chatCompletion({
      system: 'You are a connection probe. Reply with exactly: OK',
      user: 'ping',
      temperature: 0,
    }),
    TEST_TIMEOUT_MS,
    `Connection timed out after ${TEST_TIMEOUT_MS / 1000}s. Check that the host is reachable and the base URL uses the OpenAI-compatible /v1 path (e.g. http://host:11434/v1), not /api/chat.`
  );

  return {
    ok: true,
    provider: config.provider,
    model: config.model,
    latencyMs: Date.now() - started,
    reply: response.content.trim().slice(0, 200),
  };
}
