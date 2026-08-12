const STORAGE_KEY = 'qatin.activeProjectId';

export type ActiveProjectId = number | '';

let current: ActiveProjectId = readStored();
let version = 0;
const listeners = new Set<() => void>();

function readStored(): ActiveProjectId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isFinite(id) && id > 0 ? id : '';
  } catch {
    return '';
  }
}

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function getActiveProjectId(): ActiveProjectId {
  return current;
}

export function getActiveProjectVersion(): number {
  return version;
}

export function setActiveProjectId(id: ActiveProjectId) {
  if (id === current) return;
  current = id;
  try {
    if (id === '') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // ignore quota / private mode
  }
  emit();
}

export function subscribeActiveProject(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
