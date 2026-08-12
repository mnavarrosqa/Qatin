import { getSetting, upsertSettings } from '../db';
import { SkillId, isSkillId } from './catalog';

export interface SkillToggleState {
  installed: boolean;
}

export interface TestPlanReviewerState extends SkillToggleState {
  /** Si true, el chat debe revisar antes de enqueue_run. Default true. */
  autoBeforeEnqueue?: boolean;
}

export interface BugWriterState extends SkillToggleState {
  /** Si true, permite create_jira_bug. Default false. */
  createInJira?: boolean;
}

export interface ExploratoryState extends SkillToggleState {
  /** Máximo de páginas a visitar (1–15). Default 8. */
  maxPages?: number;
}

export type SkillsState = {
  'test-plan-reviewer'?: TestPlanReviewerState;
  'bug-writer'?: BugWriterState;
  'selector-coach'?: SkillToggleState;
  exploratory?: ExploratoryState;
};

export type SkillUpdateBody = {
  installed: boolean;
  autoBeforeEnqueue?: boolean;
  createInJira?: boolean;
  maxPages?: number;
};

const SETTINGS_KEY = 'skills';
const DEFAULT_MAX_PAGES = 8;

function parseState(raw: string | null): SkillsState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SkillsState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getSkillsState(): SkillsState {
  return parseState(getSetting(SETTINGS_KEY));
}

export function saveSkillsState(state: SkillsState): SkillsState {
  upsertSettings({ [SETTINGS_KEY]: JSON.stringify(state) });
  return getSkillsState();
}

export function isSkillInstalled(id: SkillId): boolean {
  const state = getSkillsState();
  return Boolean(state[id]?.installed);
}

export function getAutoBeforeEnqueue(): boolean {
  const state = getSkillsState()['test-plan-reviewer'];
  if (!state?.installed) return false;
  return state.autoBeforeEnqueue !== false;
}

export function getCreateInJira(): boolean {
  const state = getSkillsState()['bug-writer'];
  return Boolean(state?.installed && state.createInJira);
}

export function getExploratoryMaxPages(): number {
  const state = getSkillsState().exploratory;
  const n = state?.maxPages ?? DEFAULT_MAX_PAGES;
  return Math.min(15, Math.max(1, Math.floor(n)));
}

export function setSkillInstalled(
  id: SkillId,
  installed: boolean,
  opts?: Omit<SkillUpdateBody, 'installed'>
): SkillsState {
  const state = getSkillsState();

  if (id === 'test-plan-reviewer') {
    const prev = state['test-plan-reviewer'];
    state['test-plan-reviewer'] = {
      installed,
      autoBeforeEnqueue:
        opts?.autoBeforeEnqueue !== undefined
          ? Boolean(opts.autoBeforeEnqueue)
          : prev?.autoBeforeEnqueue !== false,
    };
  } else if (id === 'bug-writer') {
    const prev = state['bug-writer'];
    state['bug-writer'] = {
      installed,
      createInJira:
        opts?.createInJira !== undefined
          ? Boolean(opts.createInJira)
          : Boolean(prev?.createInJira),
    };
  } else if (id === 'exploratory') {
    const prev = state.exploratory;
    state.exploratory = {
      installed,
      maxPages:
        opts?.maxPages !== undefined
          ? Math.min(15, Math.max(1, Math.floor(opts.maxPages)))
          : prev?.maxPages ?? DEFAULT_MAX_PAGES,
    };
  } else {
    state[id] = { installed };
  }

  return saveSkillsState(state);
}

export function updateSkillConfig(
  id: string,
  body: SkillUpdateBody
): SkillsState | null {
  if (!isSkillId(id)) return null;
  return setSkillInstalled(id, body.installed, body);
}
