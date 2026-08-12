export type PluginId =
  | 'engram'
  | 'self-heal'
  | 'flaky-retry'
  | 'network-guard';

export interface PluginDefinition {
  id: PluginId;
  name: string;
  description: string;
  configurable: boolean;
}

export const PLUGIN_CATALOG: PluginDefinition[] = [
  {
    id: 'engram',
    name: 'Engram',
    description:
      'Recuerda resultados y selectores entre ejecuciones del mismo proyecto o ticket.',
    configurable: false,
  },
  {
    id: 'self-heal',
    name: 'Self-heal',
    description:
      'Si un selector falla, prueba alternativas del escenario (otros CSS, texto, data-testid) antes de marcar el paso como fallido.',
    configurable: false,
  },
  {
    id: 'flaky-retry',
    name: 'Flaky retry',
    description:
      'Reintenta pasos que fallan con una pausa breve para reducir falsos negativos flaky.',
    configurable: true,
  },
  {
    id: 'network-guard',
    name: 'Network guard',
    description:
      'Falla el escenario si hay respuestas HTTP 4xx/5xx durante la ejecución (además de errores de consola).',
    configurable: false,
  },
];

export function getPluginDefinition(id: string): PluginDefinition | undefined {
  return PLUGIN_CATALOG.find((p) => p.id === id);
}

export function isPluginId(id: string): id is PluginId {
  return PLUGIN_CATALOG.some((p) => p.id === id);
}
