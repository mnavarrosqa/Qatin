import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type ChatMessage,
  type ChatSession,
  type Project,
} from '../api';
import {
  getChatGeneration,
  startChatGeneration,
  stopChatGeneration,
  subscribeChatGeneration,
  type UiMessage,
} from '../chatGeneration';
import { getFollowUps } from '../chatFollowUps';

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

type ContentBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'para'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; text: string };

function parseBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const fenceSplit = text.split(/(```[\s\S]*?```)/g);

  for (const chunk of fenceSplit) {
    if (!chunk) continue;
    if (chunk.startsWith('```') && chunk.endsWith('```')) {
      const inner = chunk.slice(3, -3).replace(/^\w*\n?/, '');
      blocks.push({ type: 'code', text: inner.replace(/\n$/, '') });
      continue;
    }

    const paragraphs = chunk.split(/\n{2,}/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      const lines = trimmed.split('\n');
      const nonEmpty = lines.filter((l) => l.trim());

      if (/^#{2,3}\s+/.test(trimmed) && nonEmpty.length === 1) {
        const level = trimmed.startsWith('###') ? 3 : 2;
        blocks.push({
          type: 'heading',
          level,
          text: trimmed.replace(/^#{2,3}\s+/, ''),
        });
        continue;
      }

      const isUl = nonEmpty.every((l) => /^[-*•]\s+/.test(l.trim()));
      if (isUl && nonEmpty.length) {
        blocks.push({
          type: 'ul',
          items: nonEmpty.map((l) => l.trim().replace(/^[-*•]\s+/, '')),
        });
        continue;
      }

      const isOl = nonEmpty.every((l) => /^\d+[.)]\s+/.test(l.trim()));
      if (isOl && nonEmpty.length) {
        blocks.push({
          type: 'ol',
          items: nonEmpty.map((l) => l.trim().replace(/^\d+[.)]\s+/, '')),
        });
        continue;
      }

      blocks.push({ type: 'para', text: trimmed });
    }
  }

  return blocks;
}

function MessageBody({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const shots = extractScreenshots(text);
  const cleaned = text
    .replace(/\/screenshots\/[^\s)]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const blocks = cleaned ? parseBlocks(cleaned) : [];

  return (
    <div className="chat-content">
      {blocks.map((block, bi) => {
        const key = `b-${bi}`;
        if (block.type === 'heading') {
          const Tag = block.level === 3 ? 'h4' : 'h3';
          return (
            <Tag key={key} className={`chat-heading chat-heading-${block.level}`}>
              {renderInline(block.text, key)}
            </Tag>
          );
        }
        if (block.type === 'code') {
          return (
            <pre key={key} className="chat-code">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'ul') {
          return (
            <ul key={key} className="chat-list">
              {block.items.map((item, li) => (
                <li key={li}>{renderInline(item, `${key}-${li}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ol') {
          return (
            <ol key={key} className="chat-list chat-list-ol">
              {block.items.map((item, li) => (
                <li key={li}>{renderInline(item, `${key}-${li}`)}</li>
              ))}
            </ol>
          );
        }
        const lines = block.text.split('\n');
        return (
          <p key={key} className="chat-para">
            {lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(line, `${key}-${li}`)}
              </span>
            ))}
          </p>
        );
      })}
      {streaming && <span className="chat-stream-caret" aria-hidden />}
      {shots.length > 0 && (
        <div className="chat-shots">
          <p className="chat-shots-label">Evidencias</p>
          <div className="chat-shots-grid">
            {shots.map((url, i) => (
              <a
                key={url}
                className="chat-shot-link"
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Abrir evidencia"
              >
                <img
                  className="chat-shot"
                  src={url}
                  alt={`Evidencia ${i + 1}`}
                  loading="lazy"
                />
                <span className="chat-shot-cap">Ver completa</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatPage({ active = true }: { active?: boolean }) {
  const generation = useSyncExternalStore(
    subscribeChatGeneration,
    getChatGeneration,
    getChatGeneration
  );

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
  const bootstrappedRef = useRef(false);

  const liveForActive =
    generation && (activeId == null || generation.sessionId === activeId)
      ? generation
      : null;
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
    }
  }, [liveForActive, activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [viewMessages, viewBusy]);

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
    const live = getChatGeneration();
    if (live && live.sessionId === id) {
      setActiveId(id);
      setSession(live.session);
      setSelectedProjectId(live.session?.project_id ?? '');
      setMessages(live.messages);
      setBusy(live.busy);
      setError(live.error || '');
      setSessionsOpen(false);
      return;
    }

    const res = await api.getChatSession(id);
    setActiveId(id);
    setSession(res.session);
    setSelectedProjectId(res.session.project_id ?? '');
    setMessages(toUiMessages(res.messages));
    setBusy(false);
    setError('');
    setSessionsOpen(false);
    requestAnimationFrame(() => {
      if (inputRef.current && active) inputRef.current.focus();
    });
  }

  async function bootstrap() {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    setLoading(true);
    setError('');
    let loadError = '';
    try {
      const live = getChatGeneration();
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

      if (live) {
        setActiveId(live.sessionId);
        setSession(live.session);
        setSelectedProjectId(live.session?.project_id ?? '');
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

  // When returning to chat, sync from server if the turn already finished
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!becameActive || !activeId) return;

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
        setSelectedProjectId(res.session.project_id ?? '');
        setMessages(toUiMessages(res.messages));
        setBusy(false);
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
          setBusy(false);
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
    stopChatGeneration();
    setBusy(false);
  }

  async function sendMessage(raw: string) {
    const content = raw.trim();
    if (!content || viewBusy) return;

    setError('');
    setInput('');

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
  const needsProject = projects.length > 0 && selectedProjectId === '';
  const noProjects = projects.length === 0 && !loading;
  const followUps =
    !viewBusy && !noProjects ? getFollowUps(viewMessages) : [];

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
            <h1>{viewSession?.title || 'Agente QA'}</h1>
            <p>Decile qué ticket mirar, qué probar o qué evidencias necesitás.</p>
          </div>

          <div className="chat-project-picker">
            <label htmlFor="chat-project">Proyecto activo</label>
            <select
              id="chat-project"
              value={selectedProjectId === '' ? '' : String(selectedProjectId)}
              disabled={viewBusy || savingProject || projects.length === 0}
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

        {viewError && (
          <div className="chat-banner fail" role="alert">
            <div>
              <strong>Algo falló</strong>
              <p>{viewError}</p>
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
                  {m.kind === 'assistant' && m.tools && m.tools.length > 0 && (
                    <ol className="chat-tools" aria-label="Acciones del agente">
                      {m.tools.map((t, idx) => (
                        <li
                          key={`${t.tool}-${idx}`}
                          className={
                            t.status === 'running' ? 'running' : 'done'
                          }
                        >
                          <span className="chat-tool-mark" aria-hidden>
                            {t.status === 'running' ? (
                              <span className="chat-tool-spin" />
                            ) : (
                              '✓'
                            )}
                          </span>
                          <span className="chat-tool-label">
                            {t.detail || t.tool}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {m.content ? (
                    <MessageBody text={m.content} streaming={isStreaming} />
                  ) : m.kind === 'assistant' && viewBusy ? (
                    <div className="chat-content chat-thinking">
                      <span className="chat-thinking-dots" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>
                        {m.tools?.find((t) => t.status === 'running')?.detail ||
                          'Trabajando…'}
                      </span>
                    </div>
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
