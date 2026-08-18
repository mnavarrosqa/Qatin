import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type Project,
  type ProjectInput,
  type ProviderInfo,
  type LlmProvider,
} from '../api';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LlmModelFields } from '../components/LlmModelFields';

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
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [llmOpen, setLlmOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

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
    setSaved(false);
    setLlmOpen(Boolean(project.llm_provider));
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
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function resetForm() {
    setEditingId(null);
    setTestMsg(null);
    setSaved(false);
    setLlmOpen(false);
    setForm(emptyForm);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setTestMsg(null);
    setSaved(false);
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
      setSaved(true);
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
    try {
      await api.deleteProject(id);
      if (editingId === id) resetForm();
      setPendingDelete(null);
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
          El entorno al que apunta el chat: URL de test, Jira y usuario de
          prueba.
        </p>
      </header>

      <section className="panel">
        <h2>{editingId ? `Editando ${form.name || 'proyecto'}` : 'Nuevo proyecto'}</h2>
        <form ref={formRef} onSubmit={onSubmit}>
          <fieldset className="form-section">
            <legend>Identidad</legend>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="name">Nombre</label>
                <input
                  id="name"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Checkout staging"
                />
              </div>
              <div className="field">
                <label htmlFor="jira_project_key">Clave de Jira</label>
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
          </fieldset>

          <fieldset className="form-section">
            <legend>Entorno</legend>
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
              <label htmlFor="jira_url">URL de Jira (si no es la global)</label>
              <input
                id="jira_url"
                value={form.jira_url || ''}
                onChange={(e) => setForm({ ...form, jira_url: e.target.value })}
                placeholder="https://company.atlassian.net"
              />
            </div>
          </fieldset>

          <fieldset className="form-section">
            <legend>Usuario de prueba</legend>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="test_user_email">Mail</label>
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
                  Contraseña
                  {editingId ? ' (vacía = no cambiar)' : ''}
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
          </fieldset>

          <details
            className="form-disclose"
            open={llmOpen}
            onToggle={(e) => setLlmOpen(e.currentTarget.open)}
          >
            <summary>Modelo LLM (opcional)</summary>
            <p className="hint hint-block">
              Si no lo tocás, el chat usa el modelo de Configuración.
            </p>
            <div className="field">
              <label htmlFor="llm_provider">Proveedor</label>
              <select
                id="llm_provider"
                value={form.llm_provider || ''}
                onChange={(e) => {
                  const value = (e.target.value || null) as LlmProvider | null;
                  setTestMsg(null);
                  setForm({
                    ...form,
                    llm_provider: value,
                    llm_model: '',
                    llm_base_url: '',
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
            </div>

            {selectedProvider && (
              <LlmModelFields
                providerId={selectedProvider}
                providers={providers}
                model={form.llm_model || ''}
                baseUrl={form.llm_base_url || ''}
                onModelChange={(value) =>
                  setForm({ ...form, llm_model: value })
                }
                onBaseUrlChange={(value) =>
                  setForm({ ...form, llm_base_url: value })
                }
                allowEmpty
                showBaseUrl={
                  selectedProvider === 'openai-compatible' ||
                  selectedProvider === 'deepseek' ||
                  selectedProvider === 'ollama' ||
                  selectedProvider === 'openai'
                }
              />
            )}
          </details>

          {error && <p className="error">{error}</p>}
          {testMsg && (
            <p className={testMsg.ok ? 'saved-msg' : 'error'}>{testMsg.text}</p>
          )}
          {saved && !editingId && (
            <p className="saved-msg">Proyecto guardado.</p>
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
        <h2>Guardados</h2>
        {loading ? (
          <p className="empty">Cargando…</p>
        ) : projects.length === 0 ? (
          <p className="empty">Todavía no hay ninguno. Completá el de arriba.</p>
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
                      : ' · Sin clave Jira'}
                  </p>
                </div>
                <div className="actions">
                  <Link className="btn btn-ghost btn-compact" to="/">
                    <Icon name="chat" size={14} />
                    Chat
                  </Link>
                  <button
                    className="btn btn-ghost btn-compact"
                    type="button"
                    onClick={() => startEdit(project)}
                  >
                    <Icon name="pencil" size={14} />
                    Editar
                  </button>
                  <button
                    className="btn btn-danger btn-compact"
                    type="button"
                    onClick={() => setPendingDelete(project)}
                  >
                    <Icon name="trash" size={14} />
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="¿Eliminar este proyecto?"
        body={
          pendingDelete
            ? `Se borra “${pendingDelete.name}” y deja de estar disponible en el chat.`
            : ''
        }
        confirmLabel="Eliminar"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete.id);
        }}
      />
    </>
  );
}
