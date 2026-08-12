import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  api,
  type ChatSession,
  type ChatUsage,
  type LlmProvider,
  type Project,
  type ProviderInfo,
} from '../api';
import {
  getChatGeneration,
  getChatGenerationVersion,
  startChatGeneration,
  stopChatGeneration,
  subscribeChatGeneration,
  toUiMessages,
  type UiMessage,
  type ToolStep,
} from '../chatGeneration';
import { getFollowUps } from '../chatFollowUps';
import { MessageBody } from '../chatMarkdown';
import { Icon, type IconName } from '../components/Icon';
import {
  getActiveProjectId,
  getActiveProjectVersion,
  setActiveProjectId,
  subscribeActiveProject,
} from '../activeProject';

const PROVIDER_SHORT: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  'openai-compatible': 'Compatible',
  ollama: 'Ollama',
};

function toProjectFilter(id: number | ''): number | null {
  return typeof id === 'number' ? id : null;
}

function resolveChatLlm(
  project: Project | undefined,
  providers: ProviderInfo[],
  settings: Record<string, string>
): { providerId: LlmProvider; label: string; model: string; fromProject: boolean } {
  const globalProvider = (settings.llm_provider || 'openai') as LlmProvider;
  const globalMeta = providers.find((p) => p.id === globalProvider);
  const globalModel =
    settings.llm_model ||
    globalMeta?.configuredModel ||
    globalMeta?.defaultModel ||
    '';

  const providerId = (project?.llm_provider || globalProvider) as LlmProvider;
  const meta = providers.find((p) => p.id === providerId);
  const inheritedModel =
    providerId === globalProvider
      ? globalModel
      : meta?.configuredModel || meta?.defaultModel || globalModel;
  const model = project?.llm_model || inheritedModel || '—';

  const fromProject = Boolean(
    (project?.llm_provider && project.llm_provider !== globalProvider) ||
      (project?.llm_model && project.llm_model !== globalModel)
  );

  return {
    providerId,
    label: PROVIDER_SHORT[providerId] || meta?.label || providerId,
    model,
    fromProject,
  };
}

const SUGGESTIONS: {
  label: string;
  prompt: string;
  suffix: string;
  placeholder: string;
  icon: IconName;
}[] = [
  {
    label: 'Entender un ticket',
    prompt: '¿Qué entendés del ticket ',
    suffix: '?',
    placeholder: 'ABC-12',
    icon: 'ticket',
  },
  {
    label: 'Crear casos',
    prompt: 'Creá casos de prueba para ',
    suffix: ' y guardalos',
    placeholder: 'ABC-12',
    icon: 'list',
  },
  {
    label: 'Probar con evidencias',
    prompt: 'Probá ',
    suffix: ' y dame evidencias',
    placeholder: 'ABC-12',
    icon: 'camera',
  },
  {
    label: '¿Qué proyectos hay?',
    prompt: '¿Qué proyectos tengo configurados?',
    suffix: '',
    placeholder: '',
    icon: 'folder',
  },
];

type SessionGroupId = 'hoy' | 'ayer' | 'semana' | 'anteriores';

const GROUP_ORDER: SessionGroupId[] = ['hoy', 'ayer', 'semana', 'anteriores'];
const GROUP_LABELS: Record<SessionGroupId, string> = {
  hoy: 'Hoy',
  ayer: 'Ayer',
  semana: 'Esta semana',
  anteriores: 'Anteriores',
};

function parseSessionTime(iso: string): number {
  return Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
}

function relativeTime(iso: string): string {
  const then = parseSessionTime(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `hace ${days} d`;
  return new Date(then).toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'short',
  });
}

function sessionGroup(iso: string): SessionGroupId {
  const then = parseSessionTime(iso);
  if (Number.isNaN(then)) return 'anteriores';
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const sessionDate = new Date(then);
  const sessionStart = new Date(
    sessionDate.getFullYear(),
    sessionDate.getMonth(),
    sessionDate.getDate()
  ).getTime();
  if (sessionStart >= todayStart) return 'hoy';
  if (sessionStart >= todayStart - 86_400_000) return 'ayer';
  const dow = now.getDay();
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const weekStart = todayStart - mondayOffset * 86_400_000;
  if (sessionStart >= weekStart) return 'semana';
  return 'anteriores';
}

function groupSessions(items: ChatSession[]) {
  const buckets: Record<SessionGroupId, ChatSession[]> = {
    hoy: [],
    ayer: [],
    semana: [],
    anteriores: [],
  };
  for (const s of items) {
    buckets[sessionGroup(s.updated_at)].push(s);
  }
  return GROUP_ORDER.filter((id) => buckets[id].length > 0).map((id) => ({
    id,
    label: GROUP_LABELS[id],
    items: buckets[id],
  }));
}

function formatCount(n: number): string {
  return n.toLocaleString('es-AR');
}

function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toLocaleString('es-AR', { maximumFractionDigits: 1 })} s`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function formatUsageLine(u: ChatUsage): string {
  const parts = [`${formatCount(u.totalTokens)} tokens`];
  if (u.llmMs > 0) parts.push(formatDuration(u.llmMs));
  if (u.tokensPerSecond != null) {
    const speed = u.tokensPerSecond.toLocaleString('es-AR', {
      maximumFractionDigits: 1,
    });
    parts.push(`${speed} tok/s`);
  }
  return parts.join(' · ');
}

function usageTitle(u: ChatUsage): string {
  const parts = [
    `Entrada ${formatCount(u.promptTokens)}`,
    `salida ${formatCount(u.completionTokens)}`,
  ];
  if (u.llmMs > 0) {
    const sec = u.llmMs / 1000;
    parts.push(
      `${sec.toLocaleString('es-AR', { maximumFractionDigits: 1 })} s de modelo`
    );
  }
  return parts.join(' · ');
}

const NEAR_BOTTOM_PX = 80;

function threadIsNearBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function enqueueRunId(tools?: ToolStep[]): number | null {
  if (!tools) return null;
  for (let i = tools.length - 1; i >= 0; i--) {
    const step = tools[i];
    if (step.tool !== 'enqueue_run' || step.status !== 'done') continue;
    const data = step.data;
    if (data && typeof data === 'object' && typeof (data as { runId?: unknown }).runId === 'number') {
      return (data as { runId: number }).runId;
    }
  }
  return null;
}

function runIdFromContent(text: string): number | null {
  const match = text.match(/\/runs\?id=(\d+)/);
  return match ? Number(match[1]) : null;
}

export function ChatPage({ active = true }: { active?: boolean }) {
  // Subscribe to a primitive version so React always re-renders on store updates
  useSyncExternalStore(
    subscribeChatGeneration,
    getChatGenerationVersion,
    getChatGenerationVersion
  );
  useSyncExternalStore(
    subscribeActiveProject,
    getActiveProjectVersion,
    getActiveProjectVersion
  );
  const generation = getChatGeneration();
  const selectedProjectId = getActiveProjectId();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingProject, setSavingProject] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const threadRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const jumpingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bootstrappedRef = useRef(false);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const [sessionsSlot, setSessionsSlot] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [showJump, setShowJump] = useState(false);

  const liveForActive =
    generation && generation.sessionId === activeId ? generation : null;
  const viewMessages = liveForActive ? liveForActive.messages : messages;
  const viewBusy = liveForActive ? liveForActive.busy : busy;
  const viewSession = liveForActive?.session || session;
  const viewError = error;

  // Keep local mirrors in sync so session switches / reloads stay consistent
  useEffect(() => {
    if (!liveForActive) return;
    setMessages(liveForActive.messages);
    setBusy(liveForActive.busy);
    if (liveForActive.error) setError(liveForActive.error);
    if (liveForActive.session) {
      setSession(liveForActive.session);
      if (activeId == null) setActiveId(liveForActive.sessionId);
      const pid = liveForActive.session.project_id ?? '';
      if (pid !== selectedProjectIdRef.current) {
        setActiveProjectId(pid);
        refreshSessions(toProjectFilter(pid)).catch(() => undefined);
      }
    }
  }, [liveForActive, activeId]);

  function pinToBottom() {
    pinnedRef.current = true;
    setShowJump(false);
  }

  function scrollThreadToBottom(behavior: ScrollBehavior) {
    const el = threadRef.current;
    if (!el) return;
    pinToBottom();
    jumpingRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    if (behavior === 'auto') {
      requestAnimationFrame(() => {
        jumpingRef.current = false;
      });
    }
  }

  function jumpToBottom() {
    scrollThreadToBottom(prefersReducedMotion() ? 'auto' : 'smooth');
  }

  function onThreadScroll() {
    const el = threadRef.current;
    if (!el) return;
    const near = threadIsNearBottom(el);
    if (jumpingRef.current) {
      if (!near) return;
      jumpingRef.current = false;
    }
    pinnedRef.current = near;
    setShowJump((prev) => {
      const next = !near;
      return prev === next ? prev : next;
    });
  }

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
  }, [viewMessages, viewBusy]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function refreshSessions(projectId?: number | null) {
    const filter =
      projectId !== undefined
        ? projectId
        : toProjectFilter(selectedProjectIdRef.current);
    const res = await api.listChatSessions(50, filter);
    setSessions(res.sessions);
    return res.sessions;
  }

  function clearThread() {
    pinToBottom();
    setActiveId(null);
    setSession(null);
    setMessages([]);
    setBusy(false);
  }

  async function openSession(id: number) {
    pinToBottom();
    const live = getChatGeneration();
    if (live && live.sessionId === id) {
      setActiveId(id);
      setSession(live.session);
      setMessages(live.messages);
      setBusy(live.busy);
      setError(live.error || '');
      return;
    }

    const res = await api.getChatSession(id);
    setActiveId(id);
    setSession(res.session);
    setMessages(toUiMessages(res.messages));
    setBusy(false);
    setError('');
    requestAnimationFrame(() => {
      if (inputRef.current && active) inputRef.current.focus();
    });
  }

  async function refreshLlmInfo() {
    try {
      const [p, s] = await Promise.all([api.getProviders(), api.getSettings()]);
      setProviders(p.providers);
      setSettings(s.settings);
    } catch {
      // Non-blocking: header meta can stay empty
    }
  }

  async function bootstrap() {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    setLoading(true);
    setError('');
    let loadError = '';
    try {
      const live = getChatGeneration();
      const [projResult, ,] = await Promise.all([
        api.listProjects().catch((e: Error) => {
          loadError = e.message;
          return { projects: [] as Project[] };
        }),
        refreshLlmInfo(),
      ]);
      setProjects(projResult.projects);

      let projectId: number | '' = getActiveProjectId();
      const storedOk =
        typeof projectId === 'number' &&
        projResult.projects.some((p) => p.id === projectId);

      if (live?.session) {
        projectId = live.session.project_id ?? '';
      } else if (!storedOk) {
        const recent = await api.listChatSessions(1).catch((e: Error) => {
          loadError = loadError || e.message;
          return { sessions: [] as ChatSession[] };
        });
        if (recent.sessions[0]?.project_id != null) {
          projectId = recent.sessions[0].project_id;
        } else if (projResult.projects.length === 1) {
          projectId = projResult.projects[0].id;
        } else if (!recent.sessions[0] && projResult.projects.length) {
          projectId = projResult.projects[0].id;
        } else {
          projectId = '';
        }
      }
      setActiveProjectId(projectId);

      const sessResult = await api
        .listChatSessions(50, toProjectFilter(projectId))
        .catch((e: Error) => {
          loadError = loadError || e.message;
          return { sessions: [] as ChatSession[] };
        });
      setSessions(sessResult.sessions);

      if (live) {
        setActiveId(live.sessionId);
        setSession(live.session);
        setMessages(live.messages);
        setBusy(live.busy);
        if (live.error) setError(live.error);
      } else if (sessResult.sessions.length) {
        await openSession(sessResult.sessions[0].id);
      }
      if (loadError) setError(loadError);
    } catch (e: any) {
      setError(e.message);
      bootstrappedRef.current = false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    setSessionsSlot(document.getElementById('chat-sessions-root'));
  }, [active]);

  // When returning to chat, sync from server if the turn already finished
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!becameActive) return;

    refreshLlmInfo();
    if (!activeId) return;

    const live = getChatGeneration();
    if (live?.busy && live.sessionId === activeId) return;

    let cancelled = false;
    api
      .getChatSession(activeId)
      .then((res) => {
        if (cancelled) return;
        const stillLive = getChatGeneration();
        if (stillLive?.busy && stillLive.sessionId === activeId) return;
        setSession(res.session);
        setMessages(toUiMessages(res.messages));
        setBusy(false);
        const pid = res.session.project_id ?? '';
        if (pid !== selectedProjectIdRef.current) {
          setActiveProjectId(pid);
          refreshSessions(toProjectFilter(pid)).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, activeId]);

  async function ensureSession(preferredProjectId?: number | null) {
    if (activeId) return activeId;
    const projectId =
      preferredProjectId != null && preferredProjectId > 0
        ? preferredProjectId
        : typeof selectedProjectId === 'number'
          ? selectedProjectId
          : projects.length === 1
            ? projects[0].id
            : null;
    const { session: created } = await api.createChatSession({
      project_id: projectId,
    });
    setActiveId(created.id);
    setSession(created);
    if (created.project_id != null) setActiveProjectId(created.project_id);
    await refreshSessions(created.project_id);
    return created.id;
  }

  async function newChat() {
    setError('');
    try {
      const projectId =
        typeof selectedProjectId === 'number'
          ? selectedProjectId
          : projects.length === 1
            ? projects[0].id
            : null;
      if (projectId != null && selectedProjectId !== projectId) {
        setActiveProjectId(projectId);
      }
      const { session: created } = await api.createChatSession({
        project_id: projectId,
      });
      await refreshSessions(created.project_id);
      await openSession(created.id);
      setMessages([]);
      setInput('');
      inputRef.current?.focus();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function deleteSession(id: number) {
    try {
      await api.deleteChatSession(id);
      const next = await refreshSessions();
      if (activeId === id) {
        if (next.length) await openSession(next[0].id);
        else clearThread();
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function onSelectProject(raw: string) {
    const nextId = raw ? Number(raw) : null;
    const nextSelected: number | '' = nextId ?? '';
    const previous = selectedProjectId;
    const belongs =
      viewSession != null && (viewSession.project_id ?? '') === nextSelected;

    setActiveProjectId(nextSelected);
    setSavingProject(true);
    setError('');
    if (!belongs) clearThread();
    try {
      const next = await refreshSessions(nextId);
      if (!belongs && next.length) await openSession(next[0].id);
    } catch (e: any) {
      setActiveProjectId(previous);
      setError(e.message || 'No se pudo cambiar el proyecto');
    } finally {
      setSavingProject(false);
    }
  }

  function applySuggestion(s: (typeof SUGGESTIONS)[number]) {
    if (s.placeholder) {
      setInput(`${s.prompt}${s.placeholder}${s.suffix}`);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const start = s.prompt.length;
        const end = start + s.placeholder.length;
        el.setSelectionRange(start, end);
      });
      return;
    }
    setInput(s.prompt);
    inputRef.current?.focus();
  }

  function stopGeneration() {
    stopChatGeneration();
    setBusy(false);
  }

  async function sendMessage(raw: string) {
    const content = raw.trim();
    if (!content || viewBusy) return;

    setError('');
    setInput('');
    pinToBottom();

    try {
      const sessionId = await ensureSession();
      await startChatGeneration({
        sessionId,
        content,
        baseMessages: viewMessages,
        session: viewSession,
      });
      refreshSessions().catch(() => undefined);
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError(err.message || 'Falló el envío');
      }
    } finally {
      requestAnimationFrame(() => {
        if (
          inputRef.current &&
          active &&
          !inputRef.current.closest('.chat-route-hidden')
        ) {
          inputRef.current.focus();
        }
      });
    }
  }

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    await sendMessage(input);
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  const activeProject = projects.find(
    (p) => p.id === (typeof selectedProjectId === 'number' ? selectedProjectId : -1)
  );
  const chatLlm = resolveChatLlm(activeProject, providers, settings);
  const needsProject = projects.length > 0 && selectedProjectId === '';
  const noProjects = projects.length === 0 && !loading;
  const followUps =
    !viewBusy && !noProjects ? getFollowUps(viewMessages) : [];

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);
  const groupedSessions = useMemo(
    () => groupSessions(filteredSessions),
    [filteredSessions]
  );

  const sessionsPanel = (
    <aside className="chat-sessions" aria-label="Conversaciones">
      <div className="chat-sessions-head">
        <h2>Chats</h2>
        <button
          type="button"
          className="btn btn-icon"
          onClick={newChat}
          aria-label="Nuevo chat"
          title="Nuevo"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      {sessions.length > 0 ? (
        <label className="chat-sessions-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar"
            aria-label="Buscar chats"
          />
        </label>
      ) : null}

      {loading ? (
        <div className="chat-skel-list" aria-hidden>
          <div className="chat-skel" />
          <div className="chat-skel" />
          <div className="chat-skel" />
        </div>
      ) : sessions.length === 0 ? (
        <p className="chat-sessions-empty">
          {selectedProjectId === ''
            ? 'Todavía no hay conversaciones. Elegí un proyecto o empezá abajo.'
            : 'Todavía no hay conversaciones en este proyecto.'}
        </p>
      ) : filteredSessions.length === 0 ? (
        <p className="chat-sessions-empty">Ningún chat coincide.</p>
      ) : (
        <div className="chat-session-groups">
          {groupedSessions.map((g) => (
            <section key={g.id} className="chat-session-group">
              <h3>{g.label}</h3>
              <ul className="chat-session-list">
                {g.items.map((s) => (
                  <li key={s.id} className="chat-session-row">
                    <button
                      type="button"
                      className={
                        s.id === activeId
                          ? 'chat-session-item active'
                          : 'chat-session-item'
                      }
                      onClick={() => openSession(s.id)}
                    >
                      <span className="chat-session-title">{s.title}</span>
                      <span className="chat-session-meta">
                        {relativeTime(s.updated_at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="chat-session-delete"
                      aria-label={`Eliminar ${s.title}`}
                      title="Eliminar"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        deleteSession(s.id);
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );

  return (
    <div className="chat-page">
      {sessionsSlot && active ? createPortal(sessionsPanel, sessionsSlot) : null}

      <section className="chat-main">
        <header className="chat-head">
          <div className="chat-head-copy">
            <h1>{viewSession?.title || 'Agente QA'}</h1>
            {(providers.length > 0 || settings.llm_provider) && (
              <p
                className="chat-llm-meta"
                title={
                  chatLlm.fromProject
                    ? 'Modelo del proyecto activo (pisa el default global)'
                    : 'Modelo por defecto de Configuración'
                }
              >
                <span className="chat-llm-provider">{chatLlm.label}</span>
                <span aria-hidden="true"> · </span>
                <span className="chat-llm-model">{chatLlm.model}</span>
                {chatLlm.fromProject ? (
                  <span className="chat-llm-source"> proyecto</span>
                ) : null}
              </p>
            )}
          </div>

          <div className="chat-project-picker">
            <label htmlFor="chat-project">Proyecto</label>
            <select
              id="chat-project"
              value={selectedProjectId === '' ? '' : String(selectedProjectId)}
              disabled={savingProject || projects.length === 0}
              title={
                activeProject
                  ? [
                      activeProject.base_url || 'sin URL base',
                      activeProject.jira_project_key,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : undefined
              }
              onChange={(e) => onSelectProject(e.target.value)}
            >
              <option value="">Elegí un proyecto…</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        {noProjects && (
          <div className="chat-banner warn" role="status">
            <div className="chat-banner-body">
              <Icon name="warning" />
              <div>
                <strong>Falta configurar un proyecto</strong>
                <p>
                  Sin proyecto no puedo apuntar a una app ni a Jira. Creá uno y
                  volvé.
                </p>
              </div>
            </div>
            <Link className="btn btn-compact" to="/projects">
              <Icon name="folder" size={14} />
              Ir a Proyectos
            </Link>
          </div>
        )}

        {needsProject && (
          <div className="chat-banner" role="status">
            <div className="chat-banner-body">
              <Icon name="folder" />
              <div>
                <strong>Elegí un proyecto</strong>
                <p>
                  Así sé a qué entorno y tickets apuntar. También podés nombrarlo
                  en el chat.
                </p>
              </div>
            </div>
          </div>
        )}

        {viewError && (
          <div className="chat-banner fail" role="alert">
            <div className="chat-banner-body">
              <Icon name="error" />
              <div>
                <strong>Algo falló</strong>
                <p>{viewError}</p>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => setError('')}
            >
              Cerrar
            </button>
          </div>
        )}

        <div className="chat-thread-wrap">
          <div
            className="chat-thread"
            ref={threadRef}
            onScroll={onThreadScroll}
          >
          {viewMessages.length === 0 && !viewBusy && (
            <div className="chat-empty">
              <p className="chat-empty-kicker">Empezá por acá</p>
              <h2 className="chat-empty-title">¿Qué querés hacer?</h2>
              <p className="chat-empty-lead">
                Pedilo en español natural. Yo leo el ticket, armo casos, corro
                tests y te muestro evidencias.
              </p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="chat-suggestion"
                    onClick={() => applySuggestion(s)}
                    disabled={noProjects && s.label !== '¿Qué proyectos hay?'}
                  >
                    <Icon name={s.icon} size={14} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {viewMessages.map((m, mi) => {
            const prev = viewMessages[mi - 1];
            const sameAsPrev = prev?.kind === m.kind;
            const isStreaming =
              m.kind === 'assistant' &&
              viewBusy &&
              mi === viewMessages.length - 1 &&
              Boolean(m.content);
            const showFollowUps =
              m.kind === 'assistant' &&
              mi === viewMessages.length - 1 &&
              followUps.length > 0;
            const visibleTools =
              m.kind === 'assistant'
                ? (m.tools || []).filter((t) => t.tool && t.tool !== 'progress')
                : [];
            const runId =
              m.kind === 'assistant'
                ? enqueueRunId(visibleTools) || runIdFromContent(m.content)
                : null;
            const runningVisible = visibleTools.filter(
              (t) => t.status === 'running'
            );
            const progressDetail = (m.kind === 'assistant' ? m.tools : undefined)
              ?.find(
                (t) =>
                  t.status === 'running' &&
                  (!t.tool || t.tool === 'progress')
              )?.detail;
            const showThinking =
              m.kind === 'assistant' &&
              viewBusy &&
              !m.content &&
              runningVisible.length === 0;

            return (
              <article
                key={m.id}
                className={[
                  'chat-msg',
                  m.kind === 'user' ? 'chat-msg-user' : 'chat-msg-assistant',
                  sameAsPrev ? 'chat-msg-continued' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {m.kind === 'assistant' && (
                  <div className="chat-msg-avatar" aria-hidden>
                    <span>Q</span>
                  </div>
                )}
                <div className="chat-msg-stack">
                  {!sameAsPrev && (
                    <div className="chat-msg-meta">
                      <span className="chat-role">
                        {m.kind === 'user' ? 'Vos' : 'Qatin'}
                      </span>
                    </div>
                  )}
                  {visibleTools.length > 0 && (
                    <ol className="chat-tools" aria-label="Acciones del agente">
                      {visibleTools.map((t, idx) => {
                        const running = t.status === 'running' && viewBusy;
                        return (
                          <li
                            key={`${t.tool}-${idx}`}
                            className={running ? 'running' : 'done'}
                          >
                            <span className="chat-tool-mark" aria-hidden>
                              {running ? (
                                <span className="chat-tool-spin" />
                              ) : (
                                <Icon name="check" size={12} />
                              )}
                            </span>
                            <span className="chat-tool-label">
                              {t.detail || t.tool}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {runId ? (
                    <Link
                      className="chat-run-link"
                      to={`/runs?id=${runId}`}
                    >
                      <Icon name="runs" size={14} />
                      Ver progreso en Ejecuciones
                    </Link>
                  ) : null}
                  {m.content ? (
                    <MessageBody text={m.content} streaming={isStreaming} />
                  ) : showThinking ? (
                    <div className="chat-content chat-thinking">
                      <span className="chat-thinking-dots" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>{progressDetail || 'Trabajando…'}</span>
                    </div>
                  ) : null}
                  {m.kind === 'assistant' &&
                  viewBusy &&
                  m.content &&
                  runningVisible.length === 0 ? (
                    <p className="chat-usage">
                      {progressDetail || 'Generando…'}
                    </p>
                  ) : m.kind === 'assistant' && m.usage && m.content ? (
                    <p className="chat-usage" title={usageTitle(m.usage)}>
                      {formatUsageLine(m.usage)}
                    </p>
                  ) : null}
                  {showFollowUps && (
                    <div
                      className="chat-followups"
                      aria-label="Sugerencias para continuar"
                    >
                      <p className="chat-followups-label">Seguir con</p>
                      <div className="chat-suggestions">
                        {followUps.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            className="chat-suggestion chat-followup"
                            onClick={() => sendMessage(f.prompt)}
                            disabled={viewBusy || noProjects}
                            title={f.prompt}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          </div>
          {showJump ? (
            <button
              type="button"
              className="chat-jump-bottom"
              onClick={jumpToBottom}
              aria-label="Ir al final"
            >
              <Icon name="chevronDown" size={18} />
            </button>
          ) : null}
        </div>

        <form className="chat-composer" onSubmit={onSubmit}>
          <div className="chat-composer-box">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                noProjects
                  ? 'Configurá un proyecto para empezar…'
                  : needsProject
                    ? 'Elegí un proyecto o escribí su nombre…'
                    : 'Ej: ¿Qué entendés del ticket ABC-12?'
              }
              rows={1}
              disabled={viewBusy}
              onKeyDown={onComposerKey}
              aria-label="Mensaje"
            />
            <div className="chat-composer-bar">
              <span className="chat-composer-hint">
                Enter envía · Shift+Enter nueva línea
              </span>
              <div className="chat-composer-actions">
                {viewBusy ? (
                  <button
                    type="button"
                    className="btn btn-danger btn-compact"
                    onClick={stopGeneration}
                    aria-label="Detener consulta"
                  >
                    <Icon name="stop" size={14} />
                    Detener
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="btn btn-compact"
                    disabled={!input.trim() || noProjects}
                  >
                    <Icon name="send" size={14} />
                    Enviar
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
