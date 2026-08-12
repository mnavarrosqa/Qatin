import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  type ProviderInfo,
  type PluginInfo,
  type PluginId,
  type LlmProvider,
} from '../api';
import { Icon, type IconName } from '../components/Icon';

type SettingsTab = 'model' | 'keys' | 'jira' | 'agents' | 'plugins';
type PluginBusyAction = 'install' | 'uninstall' | 'config';

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: 'model', label: 'Modelo', icon: 'cpu' },
  { id: 'keys', label: 'Claves API', icon: 'key' },
  { id: 'jira', label: 'Jira', icon: 'ticket' },
  { id: 'agents', label: 'Agentes', icon: 'bot' },
  { id: 'plugins', label: 'Plugins', icon: 'plugin' },
];

function apiKeyFieldForProvider(provider: string): string | null {
  switch (provider) {
    case 'openai':
      return 'openai_api_key';
    case 'deepseek':
      return 'deepseek_api_key';
    case 'claude':
      return 'anthropic_api_key';
    case 'openai-compatible':
    case 'ollama':
      return 'llm_api_key';
    default:
      return null;
  }
}

function pluginBadge(
  plugin: PluginInfo,
  busy: { id: PluginId; action: PluginBusyAction } | null
): { className: string; label: string } {
  if (busy?.id === plugin.id) {
    if (busy.action === 'install') {
      return { className: 'badge busy', label: 'instalando…' };
    }
    if (busy.action === 'uninstall') {
      return { className: 'badge busy', label: 'desinstalando…' };
    }
    return { className: 'badge busy', label: 'guardando…' };
  }
  if (plugin.installed) {
    return { className: 'badge ok', label: 'activo' };
  }
  return { className: 'badge warn', label: 'inactivo' };
}

function pluginActionLabel(
  plugin: PluginInfo,
  busy: { id: PluginId; action: PluginBusyAction } | null
): string {
  if (busy?.id === plugin.id) {
    if (busy.action === 'install') return 'Instalando…';
    if (busy.action === 'uninstall') return 'Desinstalando…';
    return 'Guardando…';
  }
  return plugin.installed ? 'Desactivar' : 'Activar';
}

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('model');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [error, setError] = useState('');
  const [pluginError, setPluginError] = useState('');
  const [saved, setSaved] = useState(false);
  const [pluginBusy, setPluginBusy] = useState<{
    id: PluginId;
    action: PluginBusyAction;
  } | null>(null);
  const [pluginFlash, setPluginFlash] = useState<{
    id: PluginId;
    ok: boolean;
    text: string;
  } | null>(null);
  const pluginFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [promptDefaults, setPromptDefaults] = useState<{
    agent_chat_instructions: string;
    agent_analyzer_instructions: string;
  } | null>(null);
  const [promptTier, setPromptTier] = useState<'full' | 'compact'>('full');

  const mcpConnected = settings.use_mcp === 'true';

  useEffect(() => {
    Promise.all([api.getSettings(), api.getProviders(), api.getPlugins(), api.getAgentPrompts()])
      .then(([s, p, pl, ap]) => {
        setSettings(s.settings);
        setProviders(p.providers);
        setPlugins(pl.plugins);
        setPromptDefaults(ap.defaults);
        setPromptTier(ap.tier);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    return () => {
      if (pluginFlashTimer.current) clearTimeout(pluginFlashTimer.current);
    };
  }, []);

  function flashPlugin(id: PluginId, ok: boolean, text: string) {
    if (pluginFlashTimer.current) clearTimeout(pluginFlashTimer.current);
    setPluginFlash({ id, ok, text });
    pluginFlashTimer.current = setTimeout(() => {
      setPluginFlash((prev) => (prev?.id === id ? null : prev));
      pluginFlashTimer.current = null;
    }, 3500);
  }

  function set(key: string, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setTestMsg(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const payload: Record<string, string> = {
        llm_provider: settings.llm_provider || 'openai',
        llm_model: settings.llm_model || '',
        llm_base_url: settings.llm_base_url || '',
        openai_api_key: settings.openai_api_key || '',
        deepseek_api_key: settings.deepseek_api_key || '',
        anthropic_api_key: settings.anthropic_api_key || '',
        llm_api_key: settings.llm_api_key || '',
      };
      const res = await api.updateSettings(payload);
      setSettings(res.settings);
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function testConnection() {
    setError('');
    setTestMsg(null);
    setTesting(true);
    try {
      const provider = settings.llm_provider || 'openai';
      const keyField = apiKeyFieldForProvider(provider);
      const rawKey = keyField ? settings[keyField] : '';
      const apiKey =
        rawKey && rawKey !== '••••••••' ? rawKey : undefined;

      const result = await api.testLlmConnection({
        provider: provider as LlmProvider,
        model: settings.llm_model || undefined,
        base_url: settings.llm_base_url || undefined,
        api_key: apiKey,
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

  async function saveJira(e: FormEvent) {
    e.preventDefault();
    setMcpError('');
    setMcpBusy(true);
    try {
      const payload: Record<string, string> = {
        jira_url: settings.jira_url || '',
        jira_email: settings.jira_email || '',
      };
      if (settings.jira_api_token && settings.jira_api_token !== '••••••••') {
        payload.jira_api_token = settings.jira_api_token;
      }
      const res = await api.updateSettings(payload);
      setSettings(res.settings);
      setSaved(true);
    } catch (err: any) {
      setMcpError(err.message);
    } finally {
      setMcpBusy(false);
    }
  }

  async function saveAgents(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.updateSettings({
        agent_chat_instructions: settings.agent_chat_instructions || '',
        agent_analyzer_instructions: settings.agent_analyzer_instructions || '',
      });
      setSettings(res.settings);
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function toggleMcp() {
    setMcpError('');
    setMcpBusy(true);
    setSaved(false);
    try {
      if (mcpConnected) {
        const res = await api.disconnectJiraMcp();
        setSettings(res.settings);
      } else {
        const res = await api.connectJiraMcp({
          jira_url: settings.jira_url || '',
          jira_email: settings.jira_email || '',
          jira_api_token:
            settings.jira_api_token && settings.jira_api_token !== '••••••••'
              ? settings.jira_api_token
              : undefined,
        });
        setSettings(res.settings);
      }
    } catch (e: any) {
      setMcpError(e.message);
      try {
        const s = await api.getSettings();
        setSettings(s.settings);
      } catch {
        // ignore refresh errors
      }
    } finally {
      setMcpBusy(false);
    }
  }

  async function toggleInstall(plugin: PluginInfo) {
    const nextInstalled = !plugin.installed;
    setPluginError('');
    setPluginFlash(null);
    setPluginBusy({
      id: plugin.id,
      action: nextInstalled ? 'install' : 'uninstall',
    });
    try {
      const res = await api.updatePlugin(plugin.id, {
        installed: nextInstalled,
        maxRetries: plugin.maxRetries,
      });
      setPlugins(res.plugins);
      flashPlugin(
        plugin.id,
        true,
        nextInstalled
          ? 'Activado. Se usa en la próxima ejecución.'
          : 'Desactivado. Ya no se usa en nuevas ejecuciones.'
      );
    } catch (e: any) {
      const msg = e.message || 'No se pudo actualizar el plugin';
      setPluginError(msg);
      flashPlugin(plugin.id, false, msg);
    } finally {
      setPluginBusy(null);
    }
  }

  async function setFlakyRetries(plugin: PluginInfo, maxRetries: number) {
    setPluginError('');
    setPluginFlash(null);
    setPluginBusy({ id: plugin.id, action: 'config' });
    try {
      const res = await api.updatePlugin(plugin.id, {
        installed: plugin.installed,
        maxRetries,
      });
      setPlugins(res.plugins);
      flashPlugin(plugin.id, true, `Reintentos extra: ${maxRetries}`);
    } catch (e: any) {
      const msg = e.message || 'No se pudo guardar la configuración';
      setPluginError(msg);
      flashPlugin(plugin.id, false, msg);
    } finally {
      setPluginBusy(null);
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>Configuración</h1>
        <p>
          Defaults globales de LLM, claves API, Jira MCP, instrucciones de
          agentes y plugins. La config del proyecto pisa los defaults de LLM
          cuando está seteada.
        </p>
      </header>

      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Secciones de configuración"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            className={`settings-tab${tab === item.id ? ' is-active' : ''}`}
            onClick={() => {
              setTab(item.id);
              setSaved(false);
              setMcpError('');
              setError('');
              setPluginError('');
              setPluginFlash(null);
              setTestMsg(null);
            }}
          >
            <Icon name={item.icon} size={14} />
            {item.label}
          </button>
        ))}
      </div>

      <section className="panel">
        {tab === 'model' && (
          <div role="tabpanel" id="panel-model" aria-labelledby="tab-model">
            <p className="panel-lead">
              Proveedor y modelo por defecto cuando un proyecto no los
              sobreescribe.
            </p>
            <form onSubmit={onSubmit}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="llm_provider">Proveedor por defecto</label>
                  <select
                    id="llm_provider"
                    value={settings.llm_provider || 'openai'}
                    onChange={(e) => {
                      const id = e.target.value;
                      const meta = providers.find((p) => p.id === id);
                      set('llm_provider', id);
                      set(
                        'llm_model',
                        meta?.configuredModel || meta?.defaultModel || ''
                      );
                      set(
                        'llm_base_url',
                        meta?.configuredBaseUrl || meta?.defaultBaseUrl || ''
                      );
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="llm_model">Modelo por defecto</label>
                  <input
                    id="llm_model"
                    value={settings.llm_model || ''}
                    onChange={(e) => set('llm_model', e.target.value)}
                    placeholder="gpt-4-turbo-preview"
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="llm_base_url">
                  {settings.llm_provider === 'ollama'
                    ? 'URL base de Ollama'
                    : 'URL base compatible / custom'}
                </label>
                <input
                  id="llm_base_url"
                  value={settings.llm_base_url || ''}
                  onChange={(e) => set('llm_base_url', e.target.value)}
                  placeholder={
                    settings.llm_provider === 'ollama'
                      ? 'http://tu-host-ollama:11434/v1'
                      : 'https://api.deepseek.com o endpoint custom /v1'
                  }
                />
                {settings.llm_provider === 'ollama' && (
                  <p className="hint">
                    No hace falta API key. Usá la base compatible con OpenAI,
                    por ejemplo <code>http://192.168.x.x:11434/v1</code> — no{' '}
                    <code>/api/chat</code>. El modelo ya tiene que estar
                    descargado (ej. <code>llama3.2</code>).
                  </p>
                )}
              </div>

              {error && <p className="error">{error}</p>}
              {testMsg && (
                <p className={testMsg.ok ? 'saved-msg' : 'error'}>{testMsg.text}</p>
              )}
              {saved && <p className="saved-msg">Guardado.</p>}

              <div className="actions">
                <button className="btn" type="submit">
                  Guardar configuración
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={testing}
                  onClick={() => void testConnection()}
                >
                  {testing ? 'Probando…' : 'Probar conexión'}
                </button>
              </div>
            </form>
          </div>
        )}

        {tab === 'keys' && (
          <div role="tabpanel" id="panel-keys" aria-labelledby="tab-keys">
            <p className="panel-lead">
              Credenciales de cada proveedor. Dejalas vacías para mantener la
              clave actual.
            </p>
            <form onSubmit={onSubmit}>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="openai_api_key">
                    Clave API de OpenAI
                    {settings.openai_api_key_set === 'true' ? ' (seteada)' : ''}
                  </label>
                  <input
                    id="openai_api_key"
                    type="password"
                    value={settings.openai_api_key || ''}
                    onChange={(e) => set('openai_api_key', e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="deepseek_api_key">
                    Clave API de DeepSeek
                    {settings.deepseek_api_key_set === 'true' ? ' (seteada)' : ''}
                  </label>
                  <input
                    id="deepseek_api_key"
                    type="password"
                    value={settings.deepseek_api_key || ''}
                    onChange={(e) => set('deepseek_api_key', e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </div>
              </div>

              <div className="grid-2">
                <div className="field">
                  <label htmlFor="anthropic_api_key">
                    Clave API de Anthropic (Claude)
                    {settings.anthropic_api_key_set === 'true'
                      ? ' (seteada)'
                      : ''}
                  </label>
                  <input
                    id="anthropic_api_key"
                    type="password"
                    value={settings.anthropic_api_key || ''}
                    onChange={(e) => set('anthropic_api_key', e.target.value)}
                    placeholder="sk-ant-…"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="llm_api_key">
                    Clave API compatible con OpenAI
                    {settings.llm_api_key_set === 'true' ? ' (seteada)' : ''}
                  </label>
                  <input
                    id="llm_api_key"
                    type="password"
                    value={settings.llm_api_key || ''}
                    onChange={(e) => set('llm_api_key', e.target.value)}
                    placeholder="Para Cursor / endpoints custom"
                    autoComplete="off"
                  />
                </div>
              </div>

              {error && <p className="error">{error}</p>}
              {saved && <p className="saved-msg">Guardado.</p>}

              <div className="actions">
                <button className="btn" type="submit">
                  Guardar configuración
                </button>
              </div>
            </form>
          </div>
        )}

        {tab === 'jira' && (
          <div role="tabpanel" id="panel-jira" aria-labelledby="tab-jira">
            <p className="panel-lead">
              Cargá tus credenciales de Jira Cloud y después conectá MCP. Se
              usan las mismas para traer y actualizar tickets.
            </p>
            <form onSubmit={saveJira}>
              <div className="field">
                <label htmlFor="jira_url">URL de Jira</label>
                <input
                  id="jira_url"
                  value={settings.jira_url || ''}
                  onChange={(e) => set('jira_url', e.target.value)}
                  placeholder="https://tu-dominio.atlassian.net"
                  autoComplete="off"
                />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="jira_email">Mail</label>
                  <input
                    id="jira_email"
                    type="email"
                    value={settings.jira_email || ''}
                    onChange={(e) => set('jira_email', e.target.value)}
                    placeholder="vos@empresa.com"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="jira_api_token">
                    Token de API
                    {settings.jira_api_token_set === 'true' ? ' (seteado)' : ''}
                  </label>
                  <input
                    id="jira_api_token"
                    type="password"
                    value={settings.jira_api_token || ''}
                    onChange={(e) => set('jira_api_token', e.target.value)}
                    placeholder="Desde id.atlassian.com"
                    autoComplete="off"
                  />
                </div>
              </div>
              {mcpError && <p className="error">{mcpError}</p>}
              {saved && tab === 'jira' && (
                <p className="saved-msg">Guardado.</p>
              )}
              <div className="actions">
                <button className="btn btn-ghost" type="submit" disabled={mcpBusy}>
                  Guardar credenciales
                </button>
                <button
                  className={mcpConnected ? 'btn btn-ghost' : 'btn'}
                  type="button"
                  disabled={mcpBusy}
                  onClick={() => void toggleMcp()}
                >
                  {mcpConnected ? 'Desconectar MCP' : 'Conectar a Jira MCP'}
                </button>
                <span className={`badge ${mcpConnected ? 'ok' : 'warn'}`}>
                  {mcpConnected ? 'conectado' : 'apagado'}
                </span>
              </div>
            </form>
          </div>
        )}

        {tab === 'agents' && (
          <div role="tabpanel" id="panel-agents" aria-labelledby="tab-agents">
            <p className="panel-lead">
              Instrucciones que usan los agentes. Podés editarlas para cambiar
              el comportamiento. Si las borrás completamente, vuelven al default.
            </p>
            <p className="hint" style={{ marginBottom: '1rem' }}>
              Tier activo: <strong>{promptTier}</strong>{' '}
              {promptTier === 'compact'
                ? '(modelo chico — prompts cortos)'
                : '(modelo potente — prompts completos)'}
            </p>
            <form onSubmit={saveAgents}>
              <div className="field">
                <label htmlFor="agent_chat_instructions">
                  Agente de chat (QA)
                </label>
                <textarea
                  id="agent_chat_instructions"
                  className="agent-instructions"
                  value={
                    settings.agent_chat_instructions ||
                    promptDefaults?.agent_chat_instructions ||
                    ''
                  }
                  onChange={(e) =>
                    set('agent_chat_instructions', e.target.value)
                  }
                  rows={14}
                />
                <p className="hint">
                  Define workflow, reglas y tono del agente de chat. Editá
                  libremente; se usa tal cual como instrucciones del agente.
                </p>
              </div>

              <div className="field">
                <label htmlFor="agent_analyzer_instructions">
                  Agente analizador de tickets
                </label>
                <textarea
                  id="agent_analyzer_instructions"
                  className="agent-instructions"
                  value={
                    settings.agent_analyzer_instructions ||
                    promptDefaults?.agent_analyzer_instructions ||
                    ''
                  }
                  onChange={(e) =>
                    set('agent_analyzer_instructions', e.target.value)
                  }
                  rows={18}
                />
                <p className="hint">
                  Define reglas de calidad, cobertura y formato de los casos de
                  prueba generados.
                </p>
              </div>

              {error && <p className="error">{error}</p>}
              {saved && <p className="saved-msg">Guardado.</p>}

              <div className="actions">
                <button className="btn" type="submit">
                  Guardar instrucciones
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    if (promptDefaults) {
                      set(
                        'agent_chat_instructions',
                        promptDefaults.agent_chat_instructions
                      );
                      set(
                        'agent_analyzer_instructions',
                        promptDefaults.agent_analyzer_instructions
                      );
                    }
                  }}
                >
                  Restaurar defaults
                </button>
              </div>
            </form>
          </div>
        )}

        {tab === 'plugins' && (
          <div
            role="tabpanel"
            id="panel-plugins"
            aria-labelledby="tab-plugins"
          >
            <p className="panel-lead">
              Plugins de runtime: memoria entre runs, recuperación de
              selectores, reintentos flaky y falla ante errores de red. Activo
              = se aplica en la próxima ejecución; inactivo = no se usa.
            </p>
            {pluginError && <p className="error">{pluginError}</p>}
            {plugins.length === 0 && !pluginError ? (
              <p className="empty">Cargando plugins…</p>
            ) : (
              <div className="list">
                {plugins.map((plugin) => {
                  const badge = pluginBadge(plugin, pluginBusy);
                  const busy = pluginBusy?.id === plugin.id;
                  const flash =
                    pluginFlash?.id === plugin.id ? pluginFlash : null;
                  return (
                    <div
                      className={`list-item${busy ? ' is-busy' : ''}`}
                      key={plugin.id}
                    >
                      <div>
                        <h3>{plugin.name}</h3>
                        <p>{plugin.description}</p>
                        {plugin.id === 'flaky-retry' && plugin.installed && (
                          <div className="field plugin-config">
                            <label htmlFor={`retries-${plugin.id}`}>
                              Reintentos extra
                            </label>
                            <select
                              id={`retries-${plugin.id}`}
                              value={plugin.maxRetries ?? 2}
                              disabled={busy}
                              onChange={(e) =>
                                setFlakyRetries(
                                  plugin,
                                  Number(e.target.value)
                                )
                              }
                            >
                              <option value={1}>1</option>
                              <option value={2}>2</option>
                              <option value={3}>3</option>
                              <option value={4}>4</option>
                              <option value={5}>5</option>
                            </select>
                          </div>
                        )}
                        {flash && (
                          <p
                            className={
                              flash.ok
                                ? 'plugin-feedback ok'
                                : 'plugin-feedback fail'
                            }
                            role="status"
                            aria-live="polite"
                          >
                            {flash.text}
                          </p>
                        )}
                      </div>
                      <div className="actions">
                        <span className={badge.className} aria-live="polite">
                          {busy && <span className="badge-spinner" aria-hidden />}
                          {badge.label}
                        </span>
                        <button
                          className={
                            plugin.installed && !busy
                              ? 'btn btn-ghost btn-compact'
                              : 'btn btn-compact'
                          }
                          type="button"
                          disabled={busy}
                          aria-busy={busy}
                          onClick={() => void toggleInstall(plugin)}
                        >
                          {pluginActionLabel(plugin, pluginBusy)}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
