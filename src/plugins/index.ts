import {
  PLUGIN_CATALOG,
  PluginDefinition,
  PluginId,
  getPluginDefinition,
  isPluginId,
} from './catalog';
import {
  getPluginsState,
  isInstalled,
  setPluginInstalled,
  updatePluginConfig,
  getFlakyMaxRetries,
  PluginsState,
} from './store';

export type { PluginId, PluginDefinition, PluginsState };

export interface RuntimePlugins {
  selfHeal: boolean;
  flakyRetry: boolean;
  flakyMaxRetries: number;
  networkGuard: boolean;
}

export function getRuntimePlugins(): RuntimePlugins {
  return {
    selfHeal: isInstalled('self-heal'),
    flakyRetry: isInstalled('flaky-retry'),
    flakyMaxRetries: getFlakyMaxRetries(),
    networkGuard: isInstalled('network-guard'),
  };
}

export interface PluginPublic extends PluginDefinition {
  installed: boolean;
  maxRetries?: number;
}

export function listPlugins(): PluginPublic[] {
  const state = getPluginsState();
  return PLUGIN_CATALOG.map((def) => {
    const entry = state[def.id];
    const base: PluginPublic = {
      ...def,
      installed: Boolean(entry?.installed),
    };
    if (def.id === 'flaky-retry') {
      base.maxRetries = getFlakyMaxRetries();
    }
    return base;
  });
}

export {
  PLUGIN_CATALOG,
  getPluginDefinition,
  isPluginId,
  getPluginsState,
  isInstalled,
  setPluginInstalled,
  updatePluginConfig,
  getFlakyMaxRetries,
};
