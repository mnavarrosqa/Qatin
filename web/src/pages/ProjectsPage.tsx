import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type Project,
  type ProjectInput,
  type ProviderInfo,
  type LlmProvider,
} from '../api';

const emptyForm: ProjectInput = {
  name: '',
  base_url: '',
  staging_url: '',
  jira_project_key: '',
  jira_url: '',
  test_user_email: '',
  test_user_password: '',
  llm_provider: null,
  llm_model: '',
  llm_base_url: '',
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [form, setForm] = useState<ProjectInput>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  async function load() {
    setLoading(true);
    try {
      const [p, prov] = await Promise.all([
        api.listProjects(),
        api.getProviders(),
      ]);
      setProjects(p.projects);
      setProviders(prov.providers);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(project: Project) {
    setEditingId(project.id);
    setTestMsg(null);
    setForm({
      name: project.name,
      base_url: project.base_url || '',
      staging_url: project.staging_url || '',
      jira_project_key: project.jira_project_key || '',
      jira_url: project.jira_url || '',
      test_user_email: project.test_user_email || '',
      test_user_password: '',
      llm_provider: project.llm_provider,
      llm_model: project.llm_model || '',
      llm_base_url: project.llm_base_url || '',
    });
  }

  function resetForm() {
    setEditingId(null);
    setTestMsg(null);
    setForm(emptyForm);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setTestMsg(null);
    try {
      const payload: ProjectInput = {
        ...form,
        staging_url: form.staging_url || null,
        jira_project_key: form.jira_project_key || null,
        jira_url: form.jira_url || null,
        test_user_email: form.test_user_email || null,
        llm_provider: form.llm_provider || null,
        llm_model: form.llm_model || null,
        llm_base_url: form.llm_base_url || null,
      };

      if (editingId) {
        if (!payload.test_user_password) {
          delete payload.test_user_password;
        }
        await api.updateProject(editingId, payload);
      } else {
        await api.createProject(payload);
      }
      resetForm();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function testConnection() {
    setError('');
    setTestMsg(null);
    setTesting(true);
    try {
      const result = await api.testLlmConnection({
        provider: form.llm_provider || undefined,
        model: form.llm_model || undefined,
        base_url: form.llm_base_url || undefined,
      });
      setTestMsg({
        ok: true,
        text: `Conectado a ${result.provider} / ${result.model} (${result.latencyMs}ms)`,
      });
    } catch (err: any) {
      setTestMsg({
        ok: false,
        text: err.message || 'Falló la prueba de conexión',
      });
    } finally {
      setTesting(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('¿Eliminar este proyecto?')) return;
    try {
      await api.deleteProject(id);
      if (editingId === id) resetForm();
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const selectedProvider = form.llm_provider;

  return (
    <>
      <header className="page-head">
        <h1>Proyectos</h1>
        <p>
          Configurá URLs base, claves de Jira, credenciales y el proveedor de LLM
          de cada proyecto.
        </p>
      </header>

      <section className="panel">
        <form onSubmit={onSubmit}>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="name">Nombre del proyecto</label>
              <input
                id="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Checkout staging"
              />
            </div>
            <div className="field">
              <label htmlFor="jira_project_key">Clave de proyecto Jira</label>
              <input
                id="jira_project_key"
                value={form.jira_project_key || ''}
                onChange={(e) =>
                  setForm({ ...form, jira_project_key: e.target.value })
                }
                placeholder="PROJ"
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="base_url">URL base de test</label>
              <input
                id="base_url"
                value={form.base_url || ''}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://staging.example.com"
              />
            </div>
            <div className="field">
              <label htmlFor="staging_url">URL secundaria</label>
              <input
                id="staging_url"
                value={form.staging_url || ''}
                onChange={(e) =>
                  setForm({ ...form, staging_url: e.target.value })
                }
                placeholder="https://preview.example.com"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="jira_url">URL de Jira (override)</label>
            <input
              id="jira_url"
              value={form.jira_url || ''}
              onChange={(e) => setForm({ ...form, jira_url: e.target.value })}
              placeholder="https://company.atlassian.net"
            />
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="test_user_email">Mail del usuario de test</label>
              <input
                id="test_user_email"
                value={form.test_user_email || ''}
                onChange={(e) =>
                  setForm({ ...form, test_user_email: e.target.value })
                }
                placeholder="qa@example.com"
              />
            </div>
            <div className="field">
              <label htmlFor="test_user_password">
                Contraseña de test
                {editingId ? ' (dejala vacía para mantenerla)' : ''}
              </label>
              <input
                id="test_user_password"
                type="password"
                value={form.test_user_password || ''}
                onChange={(e) =>
                  setForm({ ...form, test_user_password: e.target.value })
                }
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="llm_provider">Proveedor de LLM</label>
              <select
                id="llm_provider"
                value={form.llm_provider || ''}
                onChange={(e) => {
                  const value = (e.target.value || null) as LlmProvider | null;
                  const meta = providers.find((p) => p.id === value);
                  setTestMsg(null);
                  if (!value) {
                    setForm({
                      ...form,
                      llm_provider: null,
                      llm_model: '',
                      llm_base_url: '',
                    });
                    return;
                  }
                  // Prefer the saved Settings profile for this provider when it exists
                  const model =
                    (meta?.configured && meta.configuredModel) ||
                    meta?.defaultModel ||
                    '';
                  const baseUrl =
                    (meta?.configured && meta.configuredBaseUrl) ||
                    meta?.defaultBaseUrl ||
                    '';
                  setForm({
                    ...form,
                    llm_provider: value,
                    llm_model: model,
                    llm_base_url: baseUrl,
                  });
                }}
              >
                <option value="">Usar el default global</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.configured ? ' (configurado)' : ''}
                  </option>
                ))}
              </select>
              {selectedProvider &&
                providers.find((p) => p.id === selectedProvider)?.configured && (
                  <p className="hint">
                    Este proveedor ya está configurado en Settings; se usan esas
                    credenciales y su modelo/URL guardados.
                  </p>
                )}
            </div>
            <div className="field">
              <label htmlFor="llm_model">Modelo</label>
              <input
                id="llm_model"
                value={form.llm_model || ''}
                onChange={(e) => setForm({ ...form, llm_model: e.target.value })}
                placeholder={
                  selectedProvider === 'ollama' ? 'llama3.2' : 'gpt-4-turbo-preview'
                }
              />
            </div>
          </div>

          {(selectedProvider === 'openai-compatible' ||
            selectedProvider === 'deepseek' ||
            selectedProvider === 'ollama') && (
            <div className="field">
              <label htmlFor="llm_base_url">
                {selectedProvider === 'ollama'
                  ? 'URL base de Ollama'
                  : 'URL base del LLM'}
              </label>
              <input
                id="llm_base_url"
                value={form.llm_base_url || ''}
                onChange={(e) =>
                  setForm({ ...form, llm_base_url: e.target.value })
                }
                placeholder={
                  selectedProvider === 'deepseek'
                    ? 'https://api.deepseek.com'
                    : selectedProvider === 'ollama'
                      ? 'http://tu-host-ollama:11434/v1'
                      : 'https://tu-endpoint-compatible/v1'
                }
              />
            </div>
          )}

          {error && <p className="error">{error}</p>}
          {testMsg && (
            <p className={testMsg.ok ? 'saved-msg' : 'error'}>{testMsg.text}</p>
          )}

          <div className="actions">
            <button className="btn" type="submit">
              {editingId ? 'Guardar proyecto' : 'Crear proyecto'}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={testing}
              onClick={() => void testConnection()}
            >
              {testing ? 'Probando…' : 'Probar conexión'}
            </button>
            {editingId && (
              <button className="btn btn-ghost" type="button" onClick={resetForm}>
                Cancelar
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Proyectos guardados</h2>
        {loading ? (
          <p className="empty">Cargando…</p>
        ) : projects.length === 0 ? (
          <p className="empty">Todavía no hay proyectos. Creá uno arriba.</p>
        ) : (
          <div className="list">
            {projects.map((project) => (
              <div className="list-item" key={project.id}>
                <div>
                  <h3>{project.name}</h3>
                  <p>
                    {project.base_url || 'Sin URL base'} ·{' '}
                    {project.llm_provider || 'LLM por defecto'}
                    {project.jira_project_key
                      ? ` · Jira ${project.jira_project_key}`
                      : ' · Sin Jira (configurá la clave para iniciar)'}
                  </p>
                </div>
                <div className="actions">
                  <Link className="btn btn-ghost" to="/">
                    Chat
                  </Link>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => startEdit(project)}
                  >
                    Editar
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => remove(project.id)}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
