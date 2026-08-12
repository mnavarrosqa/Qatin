import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type Project,
  type RunPipelineStep,
  type RunScenarioView,
  type TestRun,
  type TestRunDetail,
} from '../api';
import {
  getActiveProjectId,
  getActiveProjectVersion,
  setActiveProjectId,
  subscribeActiveProject,
} from '../activeProject';
import { Icon, type IconName } from '../components/Icon';
import { ConfirmDialog } from '../components/ConfirmDialog';

function isLive(run: TestRun) {
  return (
    run.phase !== 'completed' &&
    run.phase !== 'failed' &&
    run.phase !== 'cancelled'
  );
}

function badgeIcon(run: TestRun): IconName {
  if (run.phase === 'completed') return 'check';
  if (run.phase === 'cancelled') return 'stop';
  if (run.phase === 'failed') return 'error';
  return 'warning';
}

function badgeClass(run: TestRun) {
  if (run.phase === 'completed') return 'ok';
  if (run.phase === 'failed' || run.phase === 'cancelled') return 'fail';
  return 'busy';
}

function sourceLabel(source: string) {
  if (source === 'jira') return 'Jira';
  if (source === 'paste') return 'pegado';
  return source;
}

function parseWhen(iso: string): number {
  return Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
}

function formatWhen(iso: string) {
  const then = parseWhen(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  return new Date(then).toLocaleString('es-AR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms?: number) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function scenarioIcon(status: RunScenarioView['status']): IconName | null {
  if (status === 'passed') return 'check';
  if (status === 'failed') return 'error';
  if (status === 'running') return null;
  return null;
}

type ConfirmAction =
  | { kind: 'cancel'; run: TestRun }
  | { kind: 'delete'; run: TestRun };

export function RunsPage() {
  useSyncExternalStore(
    subscribeActiveProject,
    getActiveProjectVersion,
    getActiveProjectVersion
  );
  const projectId = getActiveProjectId();
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [detail, setDetail] = useState<TestRunDetail | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedId = Number(params.get('id')) || null;
  const activeProject = projects.find((p) => p.id === projectId);

  const selected = useMemo(
    () => runs.find((r) => r.id === selectedId) || null,
    [runs, selectedId]
  );
  const view = detail && detail.id === selected?.id ? detail : selected;

  useEffect(() => {
    api
      .listProjects()
      .then((res) => setProjects(res.projects))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!runsLoaded) return;
    if (runs.length === 0) {
      if (selectedId) setParams({}, { replace: true });
      return;
    }
    if (selectedId && runs.some((r) => r.id === selectedId)) return;
    const live = runs.find(isLive) || runs[0];
    setParams({ id: String(live.id) }, { replace: true });
  }, [runs, runsLoaded, selectedId, setParams]);

  useEffect(() => {
    if (typeof projectId !== 'number') {
      setRuns([]);
      setRunsLoaded(false);
      setDetail(null);
      return;
    }

    let cancelled = false;
    let timer = 0;
    setRunsLoaded(false);

    async function tick() {
      try {
        const res = await api.listRuns(50, projectId as number);
        if (cancelled) return;
        setRuns(res.runs);
        setRunsLoaded(true);
        setError('');
        const live = res.runs.some(isLive);
        timer = window.setTimeout(tick, live ? 2000 : 15000);
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message);
        setRunsLoaded(true);
        timer = window.setTimeout(tick, 8000);
      }
    }

    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (
      !selected ||
      (selected.phase !== 'completed' &&
        selected.phase !== 'failed' &&
        selected.phase !== 'cancelled')
    ) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .getRun(selected.id, typeof projectId === 'number' ? projectId : null)
      .then((res) => {
        if (!cancelled) setDetail(res.run);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.phase, selected?.updated_at, projectId]);

  function selectRun(id: number) {
    setParams({ id: String(id) }, { replace: true });
  }

  async function applyConfirm() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      if (confirm.kind === 'cancel') {
        const res = await api.cancelRun(confirm.run.id);
        setRuns((prev) =>
          prev.map((r) => (r.id === res.run.id ? { ...r, ...res.run } : r))
        );
        setDetail(null);
      } else {
        const id = confirm.run.id;
        await api.deleteRun(id);
        setRuns((prev) => prev.filter((r) => r.id !== id));
        setDetail(null);
        if (selectedId === id) {
          setParams({}, { replace: true });
        }
      }
      setConfirm(null);
    } catch (e: any) {
      setError(e.message || 'No se pudo completar la acción');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-head page-head-row">
        <div>
          <h1>Ejecuciones</h1>
          <p>
            Corridas de Playwright de{' '}
            {activeProject ? activeProject.name : 'este proyecto'}, paso a paso.
          </p>
        </div>
        <label className="chat-project-picker">
          <span>Proyecto</span>
          <select
            value={projectId === '' ? '' : String(projectId)}
            disabled={projects.length === 0}
            onChange={(e) =>
              setActiveProjectId(e.target.value ? Number(e.target.value) : '')
            }
          >
            <option value="">Elegí un proyecto…</option>
            {projects.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <p className="error">{error}</p>}

      {typeof projectId !== 'number' ? (
        <section className="panel">
          <p className="empty">
            {projects.length === 0 ? (
              <>
                No hay proyectos.{' '}
                <Link to="/projects">Creá uno</Link> para correr tests.
              </>
            ) : (
              'Elegí un proyecto para ver sus ejecuciones.'
            )}
          </p>
        </section>
      ) : runs.length === 0 && !error ? (
        <section className="panel">
          <p className="empty">
            Todavía no hay ejecuciones en{' '}
            {activeProject?.name || 'este proyecto'}.{' '}
            <Link to="/">Pedile al chat</Link> que pruebe un ticket con
            Playwright.
          </p>
        </section>
      ) : (
        <div className="runs-layout">
          <section className="runs-list" aria-label="Historial">
            {runs.map((run) => {
              const active = run.id === selectedId;
              return (
                <button
                  key={run.id}
                  type="button"
                  className={`runs-item${active ? ' is-selected' : ''}${
                    isLive(run) ? ' is-live' : ''
                  }`}
                  onClick={() => selectRun(run.id)}
                  aria-current={active ? 'true' : undefined}
                >
                  <div className="runs-item-copy">
                    <h3>
                      {run.ticket_id || run.pasted_summary || `Run #${run.id}`}
                    </h3>
                    <p>
                      {sourceLabel(run.source)} · {formatWhen(run.created_at)}
                    </p>
                  </div>
                  <span className={`badge ${badgeClass(run)}`}>
                    {isLive(run) ? (
                      <span className="badge-spinner" aria-hidden />
                    ) : (
                      <Icon name={badgeIcon(run)} size={12} />
                    )}
                    {run.phaseLabel}
                  </span>
                </button>
              );
            })}
          </section>

          <section className="runs-detail" aria-live="polite">
            {view ? (
              <RunDetail
                view={view}
                onCancel={() => setConfirm({ kind: 'cancel', run: view })}
                onDelete={() => setConfirm({ kind: 'delete', run: view })}
              />
            ) : (
              <p className="empty">Elegí una ejecución para ver cómo va.</p>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={
          confirm?.kind === 'cancel'
            ? '¿Frenar esta ejecución?'
            : '¿Borrar esta ejecución?'
        }
        body={
          confirm?.kind === 'cancel'
            ? 'Se detendrá lo antes posible y quedará marcada como cancelada.'
            : 'Se eliminará la corrida y sus evidencias. No se puede deshacer.'
        }
        confirmLabel={confirm?.kind === 'cancel' ? 'Frenar' : 'Borrar'}
        danger={confirm?.kind === 'delete'}
        busy={busy}
        onCancel={() => {
          if (!busy) setConfirm(null);
        }}
        onConfirm={applyConfirm}
      />
    </>
  );
}

function RunDetail({
  view,
  onCancel,
  onDelete,
}: {
  view: TestRun | TestRunDetail;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const live = isLive(view);
  const screenshots = 'screenshots' in view ? view.screenshots : [];
  const duration = formatDuration(view.summary?.totalDuration);

  return (
    <>
      <header className="runs-detail-head">
        <p className="runs-kicker">
          #{view.id} · {sourceLabel(view.source)}
        </p>
        <h2>{view.ticket_id || view.pasted_summary || `Run #${view.id}`}</h2>
        <p className="runs-detail-meta">
          {live
            ? view.currentStep || view.phaseLabel
            : view.summary
              ? `${view.summary.successful}/${view.summary.total} casos ok${
                  duration ? ` · ${duration}` : ''
                }`
              : view.phaseLabel}
        </p>
        <div className="runs-detail-actions">
          {live && (
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={onCancel}
            >
              <Icon name="stop" size={14} />
              Frenar
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger btn-compact"
            onClick={onDelete}
          >
            <Icon name="trash" size={14} />
            Borrar
          </button>
        </div>
      </header>

      <ol className="run-steps" aria-label="Progreso de la ejecución">
        {view.steps.map((step) => (
          <PipelineRow key={step.id} step={step} />
        ))}
      </ol>

      {view.scenarios.length > 0 && (
        <div className="run-scenarios">
          <h3>Casos</h3>
          <ol>
            {view.scenarios.map((scenario) => (
              <li
                key={scenario.id || scenario.description}
                className={`run-scenario is-${scenario.status}`}
              >
                <span className="run-scenario-mark" aria-hidden>
                  {scenario.status === 'running' ? (
                    <span className="badge-spinner" />
                  ) : scenarioIcon(scenario.status) ? (
                    <Icon name={scenarioIcon(scenario.status)!} size={12} />
                  ) : (
                    <span className="run-scenario-dot" />
                  )}
                </span>
                <div>
                  <p>{scenario.description || scenario.id}</p>
                  {scenario.status === 'running' && view.currentStep ? (
                    <p className="run-scenario-step">{view.currentStep}</p>
                  ) : scenario.error ? (
                    <p className="run-scenario-step">{scenario.error}</p>
                  ) : formatDuration(scenario.duration) ? (
                    <p className="run-scenario-step">
                      {formatDuration(scenario.duration)}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {view.error && (
        <p className="run-error">{view.error}</p>
      )}

      {screenshots.length > 0 && (
        <div className="run-shots">
          <h3>Evidencias</h3>
          <div className="run-shots-grid">
            {screenshots.map((shot) => (
              <a
                key={shot.url}
                className="chat-shot-link"
                href={shot.url}
                target="_blank"
                rel="noreferrer"
                title={shot.name}
              >
                <img
                  className="chat-shot"
                  src={shot.url}
                  alt={shot.name}
                  loading="lazy"
                />
                <span className="chat-shot-cap">{shot.name}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function PipelineRow({ step }: { step: RunPipelineStep }) {
  return (
    <li className={`run-step is-${step.state}`}>
      <span className="run-step-mark" aria-hidden>
        {step.state === 'current' ? (
          <span className="badge-spinner" />
        ) : step.state === 'done' ? (
          <Icon name="check" size={12} />
        ) : step.state === 'failed' ? (
          <Icon name="error" size={12} />
        ) : (
          <span className="run-step-dot" />
        )}
      </span>
      <span>{step.label}</span>
    </li>
  );
}
