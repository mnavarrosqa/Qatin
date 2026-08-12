import {
  SKILL_CATALOG,
  SkillDefinition,
  SkillId,
  getSkillDefinition,
  isSkillId,
} from './catalog';
import {
  getSkillsState,
  isSkillInstalled,
  setSkillInstalled,
  updateSkillConfig,
  getAutoBeforeEnqueue,
  getCreateInJira,
  getExploratoryMaxPages,
  SkillsState,
  SkillUpdateBody,
} from './store';

export type {
  SkillId,
  SkillDefinition,
  SkillsState,
  SkillUpdateBody,
};

export interface SkillPublic extends SkillDefinition {
  installed: boolean;
  autoBeforeEnqueue?: boolean;
  createInJira?: boolean;
  maxPages?: number;
}

/** Tool names gated by each skill. */
export const SKILL_TOOL_NAMES: Record<SkillId, string[]> = {
  'test-plan-reviewer': ['review_test_plan'],
  'bug-writer': ['draft_bug', 'create_jira_bug'],
  'selector-coach': ['suggest_selectors'],
  exploratory: ['explore_app'],
};

export function listSkills(): SkillPublic[] {
  const state = getSkillsState();
  return SKILL_CATALOG.map((def) => {
    const entry = state[def.id];
    const base: SkillPublic = {
      ...def,
      installed: Boolean(entry?.installed),
    };
    if (def.id === 'test-plan-reviewer') {
      const reviewer = entry as { autoBeforeEnqueue?: boolean } | undefined;
      base.autoBeforeEnqueue = reviewer?.autoBeforeEnqueue !== false;
    }
    if (def.id === 'bug-writer') {
      base.createInJira = Boolean(
        (entry as { createInJira?: boolean } | undefined)?.createInJira
      );
    }
    if (def.id === 'exploratory') {
      base.maxPages = entry?.installed
        ? getExploratoryMaxPages()
        : 8;
    }
    return base;
  });
}

export function getAllowedSkillToolNames(): Set<string> {
  const allowed = new Set<string>();
  for (const id of Object.keys(SKILL_TOOL_NAMES) as SkillId[]) {
    if (!isSkillInstalled(id)) continue;
    for (const name of SKILL_TOOL_NAMES[id]) {
      if (name === 'create_jira_bug' && !getCreateInJira()) continue;
      allowed.add(name);
    }
  }
  return allowed;
}

export function getInstalledSkillPlaybooks(): string {
  const lines: string[] = [];

  if (isSkillInstalled('test-plan-reviewer')) {
    const auto = getAutoBeforeEnqueue();
    lines.push(
      auto
        ? 'Skill Test plan reviewer (activo, auto): before enqueue_run, call review_test_plan unless the user explicitly asks to launch/run now (lanzá, ejecutá, encolá, nueva ejecución, encolá igual).'
        : 'Skill Test plan reviewer (activo): when the user asks to review the plan, call review_test_plan. Do not block enqueue unless they ask for a review.'
    );
  }

  if (isSkillInstalled('bug-writer')) {
    const create = getCreateInJira();
    lines.push(
      create
        ? 'Skill Bug writer (activo, createInJira on): after a failed run, offer to draft a bug with draft_bug. Only call create_jira_bug when the user confirms they want it created in Jira.'
        : 'Skill Bug writer (activo, createInJira off): after a failed run, offer to draft a bug with draft_bug for copy/paste. Do not create Jira issues (createInJira is off in Settings → Skills).'
    );
  }

  if (isSkillInstalled('selector-coach')) {
    lines.push(
      'Skill Selector coach (activo): when the user asks for stable selectors or a step failed due to a bad selector, call suggest_selectors with a url and optional hint.'
    );
  }

  if (isSkillInstalled('exploratory')) {
    lines.push(
      `Skill Exploratory (activo, maxPages=${getExploratoryMaxPages()}): when the user asks to explore the app or find coverage gaps, call explore_app. Confirm cost/time briefly if the crawl may be large.`
    );
  }

  if (!lines.length) return '';
  return `\nInstalled chat skills:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

export {
  SKILL_CATALOG,
  getSkillDefinition,
  isSkillId,
  getSkillsState,
  isSkillInstalled,
  setSkillInstalled,
  updateSkillConfig,
  getAutoBeforeEnqueue,
  getCreateInJira,
  getExploratoryMaxPages,
};
