export type SkillId =
  | 'test-plan-reviewer'
  | 'bug-writer'
  | 'selector-coach'
  | 'exploratory';

export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  configurable: boolean;
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: 'test-plan-reviewer',
    name: 'Test plan reviewer',
    description:
      'Critica la estrategia y los casos de prueba antes de encolar (AC sin cobertura, selectores frágiles, pasos ambiguos).',
    configurable: true,
  },
  {
    id: 'bug-writer',
    name: 'Bug writer',
    description:
      'Redacta bugs listos a partir de un run fallido (pasos + evidencia). Opcionalmente puede crear el issue en Jira.',
    configurable: true,
  },
  {
    id: 'selector-coach',
    name: 'Selector coach',
    description:
      'Abre una URL con Playwright y sugiere selectores estables a partir del DOM (data-testid, role, name, id).',
    configurable: false,
  },
  {
    id: 'exploratory',
    name: 'Exploratory',
    description:
      'Navega la app de forma acotada y sugiere gaps de cobertura frente a los casos guardados.',
    configurable: true,
  },
];

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}

export function isSkillId(id: string): id is SkillId {
  return SKILL_CATALOG.some((s) => s.id === id);
}
