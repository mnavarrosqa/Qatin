import { getSetting, upsertSettings } from '../db';
import { PluginId, isPluginId } from './catalog';

export interface PluginToggleState {
  installed: boolean;
}

export interface FlakyRetryState extends PluginToggleState {
  /** Reintentos extra tras el primer fallo (1–5). Default 2. */
  maxRetries?: number;
}

export type PluginsState = {
  engram?: PluginToggleState;
  'self-heal'?: PluginToggleState;
  'flaky-retry'?: FlakyRetryState;
  'network-guard'?: PluginToggleState;
};

const SETTINGS_KEY = 'plugins';
const DEFAULT_FLAKY_RETRIES = 2;

function parseState(raw: string | null): PluginsState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as PluginsState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getPluginsState(): PluginsState {
  return parseState(getSetting(SETTINGS_KEY));
}

export function savePluginsState(state: PluginsState): PluginsState {
  upsertSettings({ [SETTINGS_KEY]: JSON.stringify(state) });
  return getPluginsState();
}

export function isInstalled(id: PluginId): boolean {
  const state = getPluginsState();
  return Boolean(state[id]?.installed);
}

export function getFlakyMaxRetries(): number {
  const state = getPluginsState()['flaky-retry'];
  const n = state?.maxRetries ?? DEFAULT_FLAKY_RETRIES;
  return Math.min(5, Math.max(1, Math.floor(n)));
}

export function setPluginInstalled(
  id: PluginId,
  installed: boolean,
  opts?: { maxRetries?: number }
): PluginsState {
  const state = getPluginsState();

  if (id === 'flaky-retry') {
    const prev = state['flaky-retry'];
    state['flaky-retry'] = {
      installed,
      maxRetries:
        opts?.maxRetries !== undefined
          ? Math.min(5, Math.max(1, Math.floor(opts.maxRetries)))
          : prev?.maxRetries ?? DEFAULT_FLAKY_RETRIES,
    };
  } else {
    state[id] = { installed };
  }

  return savePluginsState(state);
}

export function updatePluginConfig(
  id: string,
  body: { installed: boolean; maxRetries?: number }
): PluginsState | null {
  if (!isPluginId(id)) return null;
  return setPluginInstalled(id, body.installed, {
    maxRetries: body.maxRetries,
  });
}
