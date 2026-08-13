import type { ProviderInfo } from '../api';

type Props = {
  providerId: string | null | undefined;
  providers: ProviderInfo[];
  model: string;
  baseUrl: string;
  onModelChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  /** When true, model/URL can stay empty to inherit globals */
  allowEmpty?: boolean;
  modelPlaceholder?: string;
  baseUrlPlaceholder?: string;
  showBaseUrl?: boolean;
  modelInputId?: string;
  baseUrlInputId?: string;
};

export function LlmModelFields({
  providerId,
  providers,
  model,
  baseUrl,
  onModelChange,
  onBaseUrlChange,
  allowEmpty = false,
  modelPlaceholder,
  baseUrlPlaceholder,
  showBaseUrl = true,
  modelInputId = 'llm_model',
  baseUrlInputId = 'llm_base_url',
}: Props) {
  const meta = providers.find((p) => p.id === providerId);
  const models = meta?.models || [];
  const baseUrls = meta?.baseUrls || [];
  const modelListId = `${modelInputId}-suggestions`;
  const urlListId = `${baseUrlInputId}-suggestions`;

  const resolvedModelPlaceholder =
    modelPlaceholder ||
    meta?.configuredModel ||
    meta?.defaultModel ||
    (allowEmpty ? 'Modelo por defecto de Configuración' : 'elegí un modelo');

  const resolvedUrlPlaceholder =
    baseUrlPlaceholder ||
    meta?.configuredBaseUrl ||
    meta?.defaultBaseUrl ||
    (providerId === 'ollama'
      ? 'http://tu-host-ollama:11434/v1'
      : providerId === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.ejemplo.com/v1');

  const baseUrlLabel =
    providerId === 'ollama'
      ? 'URL base de Ollama'
      : providerId === 'openai'
        ? 'URL de la API de OpenAI'
        : 'URL base compatible / custom';

  return (
    <>
      <div className="field">
        <label htmlFor={modelInputId}>Modelo</label>
        <input
          id={modelInputId}
          list={models.length ? modelListId : undefined}
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          placeholder={resolvedModelPlaceholder}
          autoComplete="off"
        />
        {models.length > 0 && (
          <datalist id={modelListId}>
            {models.map((m) => (
              <option key={m.id} value={m.id} label={m.optionLabel}>
                {m.optionLabel}
              </option>
            ))}
          </datalist>
        )}
        {models.length > 0 && (
          <div className="llm-suggest">
            <p className="hint">
              Recientes (caro → barato). Clickeá uno o escribí otro:
            </p>
            <div className="llm-suggest-chips" role="list">
              {models.map((m) => {
                const active = model === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="listitem"
                    className={`llm-chip${active ? ' is-active' : ''}`}
                    onClick={() => onModelChange(m.id)}
                    title={m.priceHint || m.priceLabel}
                  >
                    <span className="llm-chip-id">{m.id}</span>
                    <span className={`llm-chip-price price-${priceSlug(m.priceLabel)}`}>
                      {m.priceLabel}
                      {m.priceHint ? ` · ${m.priceHint}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showBaseUrl && (
        <div className="field">
          <label htmlFor={baseUrlInputId}>{baseUrlLabel}</label>
          <input
            id={baseUrlInputId}
            list={baseUrls.length ? urlListId : undefined}
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            placeholder={resolvedUrlPlaceholder}
            autoComplete="off"
          />
          {baseUrls.length > 0 && (
            <datalist id={urlListId}>
              {baseUrls.map((u) => (
                <option key={u.url} value={u.url} label={u.label}>
                  {u.label}
                </option>
              ))}
            </datalist>
          )}
          {baseUrls.length > 0 && (
            <div className="llm-suggest">
              <p className="hint">Sugerencias de URL:</p>
              <div className="llm-suggest-chips" role="list">
                {baseUrls.map((u) => {
                  const active = baseUrl === u.url;
                  return (
                    <button
                      key={u.url}
                      type="button"
                      role="listitem"
                      className={`llm-chip${active ? ' is-active' : ''}`}
                      onClick={() => onBaseUrlChange(u.url)}
                      title={u.url}
                    >
                      <span className="llm-chip-id">{u.label}</span>
                      <span className="llm-chip-price">{u.url}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {providerId === 'openai' && (
            <p className="hint">
              Para OpenAI oficial usá <code>https://api.openai.com/v1</code> (o
              dejalo vacío si el backend ya apunta ahí).
            </p>
          )}
          {providerId === 'ollama' && (
            <p className="hint">
              No hace falta API key. Usá la base compatible con OpenAI, por
              ejemplo <code>http://192.168.x.x:11434/v1</code> — no{' '}
              <code>/api/chat</code>. El modelo ya tiene que estar descargado.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function priceSlug(label: string): string {
  if (label.includes('más caro')) return 'highest';
  if (label === 'caro') return 'high';
  if (label === 'medio') return 'mid';
  if (label === 'barato') return 'low';
  if (label.includes('más barato')) return 'lowest';
  return 'mid';
}
