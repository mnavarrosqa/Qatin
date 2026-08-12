import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type ChatMessage,
  type ChatSession,
  type ChatSseEvent,
  type Project,
} from '../api';

type ToolStep = {
  tool: string;
  detail?: string;
  status: 'running' | 'done';
};

type UiMessage =
  | { kind: 'user'; id: string; content: string }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      tools?: ToolStep[];
    };

const SUGGESTIONS = [
  {
    label: 'Entender un ticket',
    prompt: '¿Qué entendés del ticket ',
    suffix: '?',
    placeholder: 'ABC-12',
  },
  {
    label: 'Crear casos',
    prompt: 'Creá casos de prueba para ',
    suffix: ' y guardalos',
    placeholder: 'ABC-12',
  },
  {
    label: 'Probar con evidencias',
    prompt: 'Probá ',
    suffix: ' y dame evidencias',
    placeholder: 'ABC-12',
  },
  {
    label: '¿Qué proyectos hay?',
    prompt: '¿Qué proyectos tengo configurados?',
    suffix: '',
    placeholder: '',
  },
];

function toUiMessages(rows: ChatMessage[]): UiMessage[] {
  return rows
    .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
    .map((m) =>
      m.role === 'user'
        ? { kind: 'user' as const, id: String(m.id), content: m.content || '' }
        : {
            kind: 'assistant' as const,
            id: String(m.id),
            content: m.content || '',
          }
    );
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
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

function extractScreenshots(text: string): string[] {
  const matches = text.match(/\/screenshots\/[^\s)]+/g);
  return matches ? [...new Set(matches)] : [];
}

function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\/screenshots\/[^\s)]+|[A-Z][A-Z0-9]+-\d+)/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('/screenshots/')) {
      return null;
    }
    if (/^[A-Z][A-Z0-9]+-\d+$/.test(part)) {
      return (
        <span key={key} className="chat-ticket">
          {part}
        </span>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function MessageBody({ text }: { text: string }) {
  const shots = extractScreenshots(text);
  const cleaned = text
    .replace(/\/screenshots\/[^\s)]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const paragraphs = cleaned ? cleaned.split(/\n{2,}/) : [];

  return (
    <div className="chat-content">
      {paragraphs.map((para, pi) => {
        const lines = para.split('\n');
        const isList = lines.every((l) => /^[-*•]\s+/.test(l.trim()) || !l.trim());
        if (isList && lines.some((l) => l.trim())) {
          return (
            <ul key={pi} className="chat-list">
              {lines
                .filter((l) => l.trim())
                .map((l, li) => (
                  <li key={li}>{renderInline(l.replace(/^[-*•]\s+/, ''), `${pi}-${li}`)}</li>
                ))}
            </ul>
          );
        }
        return (
          <p key={pi} className="chat-para">
            {lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(line, `${pi}-${li}`)}
              </span>
            ))}
          </p>
        );
      })}
      {shots.length > 0 && (
        <div className="chat-shots">
          {shots.map((url) => (
            <a
              key={url}
              className="chat-shot-link"
              href={url}
              target="_blank"
              rel="noreferrer"
              title="Abrir evidencia"
            >
              <img className="chat-shot" src={url} alt="Evidencia de test" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | ''>('');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingProject, setSavingProject] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function refreshSessions() {
    const res = await api.listChatSessions();
    setSessions(res.sessions);
    return res.sessions;
  }

  async function openSession(id: number) {
    const res = await api.getChatSession(id);
    setActiveId(id);
    setSession(res.session);
    setSelectedProjectId(res.session.project_id ?? '');
    setMessages(toUiMessages(res.messages));
    setError('');
    setSessionsOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function bootstrap() {
    setLoading(true);
    setError('');
    let loadError = '';
    try {
      const projResult = await api.listProjects().catch((e: Error) => {
        loadError = e.message;
        return { projects: [] as Project[] };
      });
      setProjects(projResult.projects);

      const sessResult = await api.listChatSessions().catch((e: Error) => {
        loadError = loadError || e.message;
        return { sessions: [] as ChatSession[] };
      });
      setSessions(sessResult.sessions);
      if (sessResult.sessions.length) {
        await openSession(sessResult.sessions[0].id);
      }
      if (loadError) setError(loadError);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    bootstrap();
    return () => abortRef.current?.abort();
  }, []);

  async function ensureSession(preferredProjectId?: number | null) {
    if (activeId) return activeId;
    const projectId =
      preferredProjectId != null && preferredProjectId > 0
        ? preferredProjectId
        : projects.length === 1
          ? projects[0].id
          : null;
    const { session: created } = await api.createChatSession({
      project_id: projectId,
    });
    setActiveId(created.id);
    setSession(created);
    setSelectedProjectId(created.project_id ?? '');
    await refreshSessions();
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
      const { session: created } = await api.createChatSession({
        project_id: projectId,
      });
      await refreshSessions();
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
        else {
          setActiveId(null);
          setSession(null);
          setSelectedProjectId('');
          setMessages([]);
        }
      }
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function onSelectProject(raw: string) {
    const nextId = raw ? Number(raw) : null;
    const previous = selectedProjectId;
    setSelectedProjectId(nextId ?? '');
    setSavingProject(true);
    setError('');
    try {
      const id = await ensureSession(nextId);
      const { session: updated } = await api.updateChatSession(id, {
        project_id: nextId,
      });
      setSession(updated);
      setSelectedProjectId(updated.project_id ?? '');
      setActiveId(updated.id);
      await refreshSessions();
    } catch (e: any) {
      setSelectedProjectId(previous);
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
    abortRef.current?.abort();
    setBusy(false);
  }

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || busy) return;

    setError('');
    setInput('');

    try {
      const sessionId = await ensureSession();
      const userMsg: UiMessage = {
        kind: 'user',
        id: `u-${Date.now()}`,
        content,
      };
      const assistantId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { kind: 'assistant', id: assistantId, content: '', tools: [] },
      ]);
      setBusy(true);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      await api.sendChatMessage(
        sessionId,
        content,
        (ev: ChatSseEvent) => {
          if (ev.type === 'token') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId && m.kind === 'assistant'
                  ? { ...m, content: ev.text }
                  : m
              )
            );
          } else if (ev.type === 'tool_start') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId || m.kind !== 'assistant') return m;
                return {
                  ...m,
                  tools: [
                    ...(m.tools || []),
                    {
                      tool: ev.tool,
                      detail: ev.detail,
                      status: 'running' as const,
                    },
                  ],
                };
              })
            );
          } else if (ev.type === 'tool_end') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId || m.kind !== 'assistant') return m;
                const tools = [...(m.tools || [])];
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i].tool === ev.tool && tools[i].status === 'running') {
                    tools[i] = {
                      ...tools[i],
                      detail: ev.detail || tools[i].detail,
                      status: 'done',
                    };
                    break;
                  }
                }
                return { ...m, tools };
              })
            );
          } else if (ev.type === 'progress') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantId || m.kind !== 'assistant') return m;
                const tools = [...(m.tools || [])];
                const last = tools[tools.length - 1];
                if (last) {
                  tools[tools.length - 1] = {
                    ...last,
                    detail: ev.detail || last.detail,
                  };
                }
                return { ...m, tools };
              })
            );
          } else if (ev.type === 'done') {
            setSession((s) =>
              s
                ? {
                    ...s,
                    project_id: ev.session.project_id,
                    title: ev.session.title,
                  }
                : s
            );
            refreshSessions().catch(() => undefined);
          } else if (ev.type === 'error') {
            setError(ev.error);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId && m.kind === 'assistant'
                  ? { ...m, content: m.content || ev.error }
                  : m
              )
            );
          }
        },
        controller.signal
      );
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError(err.message || 'Falló el envío');
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
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
  const needsProject = projects.length > 0 && selectedProjectId === '';
  const noProjects = projects.length === 0 && !loading;

  return (
    <div className={`chat-page${sessionsOpen ? ' sessions-open' : ''}`}>
      <aside className="chat-sessions" aria-label="Conversaciones">
        <div className="chat-sessions-head">
          <h2>Chats</h2>
          <button
            type="button"
            className="btn btn-compact"
            onClick={newChat}
          >
            Nuevo
          </button>
        </div>

        {loading ? (
          <div className="chat-skel-list" aria-hidden>
            <div className="chat-skel" />
            <div className="chat-skel" />
            <div className="chat-skel" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="chat-sessions-empty">
            Todavía no hay conversaciones. Empezá abajo.
          </p>
        ) : (
          <ul className="chat-session-list">
            {sessions.map((s) => (
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
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <div className="chat-head-copy">
            <button
              type="button"
              className="chat-sessions-toggle"
              onClick={() => setSessionsOpen((v) => !v)}
              aria-expanded={sessionsOpen}
            >
              Chats
            </button>
            <h1>{session?.title || 'Agente QA'}</h1>
            <p>Decile qué ticket mirar, qué probar o qué evidencias necesitás.</p>
          </div>

          <div className="chat-project-picker">
            <label htmlFor="chat-project">Proyecto activo</label>
            <select
              id="chat-project"
              value={selectedProjectId === '' ? '' : String(selectedProjectId)}
              disabled={busy || savingProject || projects.length === 0}
              onChange={(e) => onSelectProject(e.target.value)}
            >
              <option value="">Elegí un proyecto…</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
            </select>
            {savingProject && <p className="hint">Guardando…</p>}
            {activeProject && !savingProject && (
              <p className="hint chat-project-meta">
                <span className="chat-dot ok" />
                {activeProject.base_url || 'sin URL base'}
                {activeProject.jira_project_key
                  ? ` · ${activeProject.jira_project_key}`
                  : ''}
              </p>
            )}
          </div>
        </header>

        {noProjects && (
          <div className="chat-banner warn" role="status">
            <div>
              <strong>Falta configurar un proyecto</strong>
              <p>
                Sin proyecto no puedo apuntar a una app ni a Jira. Creá uno y
                volvé.
              </p>
            </div>
            <Link className="btn btn-compact" to="/projects">
              Ir a Proyectos
            </Link>
          </div>
        )}

        {needsProject && (
          <div className="chat-banner" role="status">
            <div>
              <strong>Elegí un proyecto</strong>
              <p>
                Así sé a qué entorno y tickets apuntar. También podés nombrarlo
                en el chat.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="chat-banner fail" role="alert">
            <div>
              <strong>Algo falló</strong>
              <p>{error}</p>
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

        <div className="chat-thread">
          {messages.length === 0 && !busy && (
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
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <article
              key={m.id}
              className={
                m.kind === 'user' ? 'chat-bubble user' : 'chat-bubble assistant'
              }
            >
              <div className="chat-role">
                {m.kind === 'user' ? 'Vos' : 'Qatin'}
              </div>
              {m.kind === 'assistant' && m.tools && m.tools.length > 0 && (
                <ol className="chat-tools">
                  {m.tools.map((t, idx) => (
                    <li
                      key={`${t.tool}-${idx}`}
                      className={t.status === 'running' ? 'running' : 'done'}
                    >
                      <span className="chat-tool-mark" aria-hidden>
                        {t.status === 'running' ? '…' : '✓'}
                      </span>
                      <span>{t.detail || t.tool}</span>
                    </li>
                  ))}
                </ol>
              )}
              {m.content ? (
                <MessageBody text={m.content} />
              ) : m.kind === 'assistant' && busy ? (
                <div className="chat-content chat-thinking">
                  <span className="chat-thinking-dots" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                  Trabajando…
                </div>
              ) : null}
            </article>
          ))}
          <div ref={bottomRef} />
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
              disabled={busy}
              onKeyDown={onComposerKey}
              aria-label="Mensaje"
            />
            <div className="chat-composer-bar">
              <span className="chat-composer-hint">
                Enter envía · Shift+Enter nueva línea
              </span>
              <div className="chat-composer-actions">
                {busy ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={stopGeneration}
                  >
                    Detener
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="btn btn-compact"
                    disabled={!input.trim() || noProjects}
                  >
                    Enviar
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </section>

      {sessionsOpen && (
        <button
          type="button"
          className="chat-sessions-backdrop"
          aria-label="Cerrar lista de chats"
          onClick={() => setSessionsOpen(false)}
        />
      )}
    </div>
  );
}
