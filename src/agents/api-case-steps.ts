/**
 * Shared parsing for API/BE scenarios (Playwright request specs + TestExecutor).
 * Heuristic over Spanish NL steps + apiEndpoints — good enough for MVP.
 */

export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiStepKind =
  | 'auth'
  | 'prepare_payload'
  | 'send'
  | 'assert_status'
  | 'assert_body'
  | 'pending_discovery'
  | 'other';

export function classifyApiStep(step: string): ApiStepKind {
  const t = step.toLowerCase();
  if (
    /\bpendiente confirmar\b|\bcapturar en network\b|\bno inventar\b|\bbloqueado hasta\b|\bswagger\b.*\bpendiente\b/.test(
      t
    )
  ) {
    return 'pending_discovery';
  }
  if (
    /\bautenticar\b|\biniciar\s+sesi[oó]n\b|\blog\s*in\b|\bauth(enticat(e|ion))?\b/.test(
      t
    ) ||
    /\bcredenciales?\s+(de\s+)?qa\b/.test(t)
  ) {
    return 'auth';
  }
  if (/\bpreparar\s+payload\b|\barmar\s+payload\b|\bbuild\s+payload\b/.test(t)) {
    return 'prepare_payload';
  }
  if (
    /\benviar\s+(get|post|put|patch|delete)\b/.test(t) ||
    /\b(send|call|invoke)\s+(get|post|put|patch|delete)\b/.test(t) ||
    /\brequest\s+(get|post|put|patch|delete)\b/.test(t)
  ) {
    return 'send';
  }
  if (/\bstatus\s*http\b|\bhttp\s*[12]\d\d\b|\bstatus\s*code\b/.test(t)) {
    return 'assert_status';
  }
  if (
    /\bverificar\b|\bvalidar\b|\bcomprobar\b|\bassert\b|\bbody\b|\bpersistencia\b/.test(
      t
    )
  ) {
    return 'assert_body';
  }
  return 'other';
}

/** Parse "POST /api/foo" from apiEndpoints or from an "Enviar POST…" step. */
export function parseApiEndpoint(
  scenario: { apiEndpoints?: string[] | null; steps?: string[] | null },
  step?: string
): { method: ApiHttpMethod; path: string } {
  // Prefer the current step (concrete ids) over apiEndpoints placeholders like {id}.
  const candidates = [
    step || '',
    ...(scenario.steps || []),
    ...(scenario.apiEndpoints || []),
  ];
  let fallback: { method: ApiHttpMethod; path: string } | null = null;
  for (const raw of candidates) {
    const m = String(raw).match(
      /\b(GET|POST|PUT|PATCH|DELETE)\b\s+(?:a\s+)?['"]?(\/[^\s"'`,;]*)/i
    );
    if (m) {
      const parsed = {
        method: m[1].toUpperCase() as ApiHttpMethod,
        // Do not strip `}` — breaks placeholder paths like /foo/{id}
        path: m[2].replace(/[.,;:]+$/, ''),
      };
      // Keep placeholder paths only as fallback if a concrete path appears later.
      if (/\{[^}]+\}/.test(parsed.path)) {
        if (!fallback) fallback = parsed;
        continue;
      }
      return parsed;
    }
    const methodOnly = String(raw).match(
      /\b(?:enviar|send|call)\s+(GET|POST|PUT|PATCH|DELETE)\b/i
    );
    if (methodOnly && !fallback) {
      fallback = {
        method: methodOnly[1].toUpperCase() as ApiHttpMethod,
        path: '/',
      };
    }
  }
  if (fallback) return fallback;
  return { method: 'POST', path: '/' };
}

/** Pull 'key'='value' / "key"="value" pairs into a JSON object. */
export function payloadFromSteps(steps: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const skipKey = /^(con|with|campo|field|clave|key|modo|mode|payload|y|and|en|el|la|los|las|un|una|de|del|al|para|validar|verificar)$/i;

  const put = (key: string, val: string) => {
    const k = key.trim();
    if (!k || skipKey.test(k) || k in payload) return;
    if (/^\d+$/.test(val)) payload[k] = Number(val);
    else if (/^(true|false)$/i.test(val)) payload[k] = /^true$/i.test(val);
    else payload[k] = val;
  };

  for (const step of steps) {
    if (classifyApiStep(step) !== 'prepare_payload' && !/payload/i.test(step)) {
      continue;
    }
    for (const m of step.matchAll(/['"]([^'"]+)['"]\s*=\s*['"]([^'"]*)['"]/g)) {
      put(m[1], m[2]);
    }
    for (const m of step.matchAll(
      /(?:campo|field|clave|key)?\s*['"]([^'"]+)['"]\s*(?:=|con|with|:)\s*['"]([^'"]*)['"]/gi
    )) {
      put(m[1], m[2]);
    }
    // cantidad '50' / nombre "Demo"
    for (const m of step.matchAll(
      /\b([A-Za-z_][\w]*)\s+['"]([^'"]*)['"]/g
    )) {
      put(m[1], m[2]);
    }
  }
  return payload;
}

export function expectedStatusFromScenario(scenario: {
  steps?: string[] | null;
  expectedResults?: string[] | null;
}): number {
  const texts = [
    ...(scenario.steps || []),
    ...(scenario.expectedResults || []),
  ];
  for (const t of texts) {
    const m = String(t).match(
      /\b(?:status\s*http|http|status(?:\s*code)?)\s*['"]?([12]\d\d)['"]?/i
    );
    if (m) return Number(m[1]);
    const bare = String(t).match(/\b([12]\d\d)\b/);
    if (bare && /status|http|c[oó]digo/i.test(t)) return Number(bare[1]);
  }
  return 200;
}

export function resolveApiBaseUrl(baseUrl?: string | null): string {
  const raw =
    process.env.API_BASE_URL ||
    baseUrl ||
    process.env.APP_BASE_URL ||
    'http://localhost:3000';
  // ponytail: strip common UI login suffix when project.base_url is the SPA entry
  return raw.replace(/\/$/, '').replace(/\/v2\/login\/?$/i, '') ||
    'http://localhost:3000';
}

/** Expand a single {{ENV_KEY}} from process.env — never invent values. */
export function resolveEnvTemplate(
  value: string,
  opts?: { required?: boolean }
): string {
  const missing: string[] = [];
  const out = value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = process.env[key];
    if (!v?.trim()) {
      missing.push(key);
      return `{{${key}}}`;
    }
    return v.trim();
  });
  if (missing.length && opts?.required !== false) {
    throw new Error(
      `Faltan valores reales en env (${[...new Set(missing)].join(', ')}). No inventar; setear variables o capturar en Network.`
    );
  }
  return out;
}

/** Expand {{ACOPIO_ID}} / {acopioId} from env — never invent numeric IDs. */
export function resolvePathTemplates(path: string): string {
  const missing: string[] = [];
  const out = resolveEnvTemplate(path, { required: false })
    .replace(/\{([A-Za-z_][\w]*)\}/g, (full, key: string) => {
      if (/^id$/i.test(key)) {
        // Ambiguous {id} — require explicit env vars instead of inventing.
        missing.push('ACOPIO_ID|CAMPANIA_ID (reemplazar {id})');
        return full;
      }
      const envKey = key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/-/g, '_')
        .toUpperCase();
      const v = process.env[envKey] || process.env[key];
      if (!v?.trim()) {
        missing.push(envKey);
        return full;
      }
      return v.trim();
    });
  if (/\{\{\w+\}\}/.test(out)) {
    const still = [...out.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    missing.push(...still);
  }
  if (missing.length) {
    throw new Error(
      `Faltan IDs reales en env (${[...new Set(missing)].join(', ')}). No inventar; setear variables o capturar en Network.`
    );
  }
  return out;
}

/** Expand {{ENV}} placeholders inside a prepared JSON payload. */
export function resolvePayloadTemplates(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string') {
      if (v === 'null') {
        out[k] = null;
        continue;
      }
      out[k] = resolveEnvTemplate(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function apiAuthHeaders(
  tokenOverride?: string | null
): Record<string, string> {
  const token =
    (tokenOverride && tokenOverride.trim()) ||
    process.env.API_TOKEN ||
    process.env.TEST_API_TOKEN ||
    process.env.API_BEARER_TOKEN ||
    '';
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/** Best-effort login with project QA user to obtain a Bearer token for API cases. */
export async function resolveApiBearerToken(opts: {
  apiBase: string;
  email?: string | null;
  password?: string | null;
  request: typeof import('playwright').request;
}): Promise<string | null> {
  const existing =
    process.env.API_TOKEN ||
    process.env.TEST_API_TOKEN ||
    process.env.API_BEARER_TOKEN ||
    '';
  if (existing.trim()) return existing.trim();
  if (!opts.email || !opts.password) return null;

  const paths = [
    process.env.API_LOGIN_PATH,
    '/api/v2/login',
    '/api/auth/login',
    '/api/login',
    '/auth/login',
    '/v2/api/auth/login',
  ].filter((p): p is string => Boolean(p && p.trim()));

  const bodies = [
    { email: opts.email, password: opts.password },
    { username: opts.email, password: opts.password },
    { user: opts.email, password: opts.password },
  ];

  const ctx = await opts.request.newContext({
    baseURL: opts.apiBase,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  try {
    for (const pathName of paths) {
      for (const data of bodies) {
        try {
          const res = await ctx.post(pathName, { data });
          if (!res.ok()) continue;
          const json = (await res.json().catch(() => null)) as Record<
            string,
            unknown
          > | null;
          if (!json) continue;
          const nested =
            json.data && typeof json.data === 'object'
              ? (json.data as Record<string, unknown>)
              : null;
          const token =
            (typeof json.token === 'string' && json.token) ||
            (typeof json.tokenMasterLogin === 'string' &&
              json.tokenMasterLogin) ||
            (typeof json.access_token === 'string' && json.access_token) ||
            (typeof json.accessToken === 'string' && json.accessToken) ||
            (typeof nested?.token === 'string' && nested.token) ||
            (typeof nested?.access_token === 'string' && nested.access_token) ||
            null;
          if (token) return token;
        } catch {
          // try next body/path
        }
      }
    }
  } finally {
    await ctx.dispose();
  }
  return null;
}
