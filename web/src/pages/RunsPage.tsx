import { useEffect, useState } from 'react';
import { api, type TestRun } from '../api';
import { Icon, type IconName } from '../components/Icon';

function badgeIcon(status: string): IconName {
  if (status === 'completed') return 'check';
  if (status === 'failed') return 'error';
  return 'warning';
}

function badgeClass(status: string) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'fail';
  return 'warn';
}

function statusLabel(status: string) {
  switch (status) {
    case 'completed':
      return 'completada';
    case 'failed':
      return 'fallida';
    case 'queued':
      return 'en cola';
    case 'active':
    case 'running':
      return 'en curso';
    case 'waiting':
      return 'esperando';
    default:
      return status;
  }
}

function sourceLabel(source: string) {
  if (source === 'jira') return 'Jira';
  if (source === 'paste') return 'pegado';
  return source;
}

export function RunsPage() {
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<TestRun | null>(null);

  useEffect(() => {
    api
      .listRuns()
      .then((res) => setRuns(res.runs))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <header className="page-head">
        <h1>Ejecuciones</h1>
        <p>Historial de jobs en cola y terminados, guardados en SQLite.</p>
      </header>

      <section className="panel">
        {error && <p className="error">{error}</p>}
        {runs.length === 0 ? (
          <p className="empty">Todavía no hay ejecuciones.</p>
        ) : (
          <div className="list">
            {runs.map((run) => (
              <div className="list-item" key={run.id}>
                <div>
                  <h3>
                    #{run.id} · {run.ticket_id || 'sin título'}
                  </h3>
                  <p>
                    {sourceLabel(run.source)} · job {run.job_id || '—'} ·{' '}
                    {run.created_at}
                    {run.pasted_summary ? ` · ${run.pasted_summary}` : ''}
                  </p>
                </div>
                <div className="actions">
                  <span className={`badge ${badgeClass(run.status)}`}>
                    <Icon name={badgeIcon(run.status)} size={12} />
                    {statusLabel(run.status)}
                  </span>
                  <button
                    className="btn btn-ghost btn-compact"
                    type="button"
                    onClick={() => setSelected(run)}
                  >
                    Detalle
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <pre className="status-box">
            {selected.result_json
              ? JSON.stringify(JSON.parse(selected.result_json), null, 2)
              : JSON.stringify(selected, null, 2)}
          </pre>
        )}
      </section>
    </>
  );
}
