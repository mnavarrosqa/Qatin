/**
 * Discover real API contracts via Playwright Network + QA login (no inventing).
 *
 * Flow: POST /api/v2/login → decode JWT for catalog IDs → inject SPA auth →
 * visit paths / click labels → capture /api/* calls.
 */
import { chromium, type Page, request as playwrightRequest } from 'playwright';
import { resolveApiBaseUrl } from './api-case-steps';
import { logger } from '../utils/logger';

export type DiscoveredApiCall = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responsePreview: string | null;
  resourceIds: Record<string, string>;
};

export type ApiContractDiscoveryInput = {
  baseUrl: string;
  email: string;
  password: string;
  startPaths?: string[];
  clickLabels?: string[];
  urlIncludes?: string[];
  /** Prefer calls matching this path fragment (e.g. cuenta/client/acopio). */
  matchPath?: string | null;
  navTimeoutMs?: number;
  headless?: boolean;
};

export type ApiContractDiscoveryResult = {
  ok: boolean;
  apiBase: string;
  origin: string;
  visited: string[];
  calls: DiscoveredApiCall[];
  matches: DiscoveredApiCall[];
  suggestedEnv: Record<string, string>;
  jwtClaims?: Record<string, unknown>;
  notes: string[];
  error?: string;
};

type LoginTokens = {
  token?: string;
  tokenMasterLogin?: string;
  refreshTokenMasterLogin?: string;
};

function originOf(url: string): string {
  return new URL(url).origin;
}

function toAbs(origin: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${origin}${path}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(
      part.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstCsvId(raw: unknown): string | null {
  if (raw == null) return null;
  const parts = String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== '0');
  return parts[0] || null;
}

function parseCall(
  method: string,
  rawUrl: string,
  requestBody: string | null,
  status: number | null,
  responsePreview: string | null
): DiscoveredApiCall {
  const u = new URL(rawUrl);
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  const resourceIds: Record<string, string> = {};
  const acopio = u.pathname.match(/\/acopio\/([^/]+)/i);
  const campania = u.pathname.match(/\/campania\/([^/]+)/i);
  if (acopio?.[1] && !/^\{/.test(acopio[1])) {
    resourceIds.ACOPIO_ID = decodeURIComponent(acopio[1]);
  }
  if (campania?.[1] && !/^\{/.test(campania[1])) {
    resourceIds.CAMPANIA_ID = decodeURIComponent(campania[1]);
  }
  return {
    method: method.toUpperCase(),
    url: rawUrl,
    path: u.pathname,
    query,
    requestBody,
    status,
    responsePreview,
    resourceIds,
  };
}

async function loginTokens(
  apiBase: string,
  email: string,
  password: string
): Promise<LoginTokens> {
  const ctx = await playwrightRequest.newContext({
    baseURL: apiBase,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  try {
    const res = await ctx.post('/api/v2/login', {
      data: { email, password },
    });
    if (!res.ok()) {
      throw new Error(
        `Login API ${res.status()}: ${(await res.text()).slice(0, 200)}`
      );
    }
    return (await res.json()) as LoginTokens;
  } finally {
    await ctx.dispose();
  }
}

async function injectAuth(
  page: Page,
  tokens: LoginTokens,
  claims: Record<string, unknown> | null
) {
  await page.evaluate(
    (data) => {
      const g = globalThis as unknown as {
        localStorage: {
          setItem: (k: string, v: string) => void;
        };
      };
      const ls = g.localStorage;
      const { tokens: t, claims: c } = data;
      if (t.token) ls.setItem('token', t.token);
      if (t.tokenMasterLogin) {
        ls.setItem('tokenMasterLogin', t.tokenMasterLogin);
      }
      if (t.refreshTokenMasterLogin) {
        ls.setItem('refreshTokenMasterLogin', t.refreshTokenMasterLogin);
      }
      if (c) {
        if (c.userId != null) ls.setItem('userId', String(c.userId));
        if (c.unique_name != null) {
          ls.setItem('username', String(c.unique_name));
        }
        if (c.userFullName != null) {
          ls.setItem('userFullName', String(c.userFullName));
        }
        if (c.acopiosNetwork != null) {
          ls.setItem('acopiosNetwork', String(c.acopiosNetwork));
        }
        if (c.acopiosSeePlanComercial != null) {
          ls.setItem(
            'acopiosSeePlanComercial',
            String(c.acopiosSeePlanComercial)
          );
        }
        if (c.accionesId != null) {
          ls.setItem('accionesId', String(c.accionesId));
        }
      }
    },
    { tokens, claims }
  );
}

const DEFAULT_PATHS = [
  '/v2/home/inicio',
  '/v2/gestionar-plan-comercial',
  '/v2/indicadores/gestionar-plan-comercial',
  '/v2/clientes',
  '/v2/indicadores/clientes',
];

/**
 * Capture real /api calls from the SPA after QA login.
 */
export async function discoverApiContract(
  input: ApiContractDiscoveryInput
): Promise<ApiContractDiscoveryResult> {
  const apiBase = resolveApiBaseUrl(input.baseUrl);
  const origin = originOf(
    input.baseUrl.startsWith('http') ? input.baseUrl : apiBase
  );
  const visited: string[] = [];
  const notes: string[] = [];
  const byKey = new Map<string, DiscoveredApiCall>();
  const urlIncludes = (
    input.urlIncludes?.length ? input.urlIncludes : ['/api/']
  ).map((s) => s.toLowerCase());
  const navTimeout = input.navTimeoutMs ?? 45_000;
  const matchPath = (input.matchPath || '').toLowerCase();

  const keep = (url: string) => {
    const l = url.toLowerCase();
    if (/recaptcha|google-analytics|gstatic|firebase|googletag|\/public\//.test(l)) {
      return false;
    }
    return urlIncludes.some((inc) => l.includes(inc));
  };

  let tokens: LoginTokens;
  let claims: Record<string, unknown> | null = null;
  const suggestedEnv: Record<string, string> = {};

  try {
    tokens = await loginTokens(apiBase, input.email, input.password);
    claims = tokens.token ? decodeJwtPayload(tokens.token) : null;
    if (claims) {
      const acopio =
        firstCsvId(claims.acopiosSeePlanComercial) ||
        firstCsvId(claims.acopiosNetwork);
      if (acopio) {
        suggestedEnv.ACOPIO_ID = acopio;
        notes.push(
          `ACOPIO_ID sugerido desde JWT acopiosSeePlanComercial/acopiosNetwork: ${acopio}`
        );
      }
    }
  } catch (err) {
    return {
      ok: false,
      apiBase,
      origin,
      visited,
      calls: [],
      matches: [],
      suggestedEnv: {},
      notes,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const browser = await chromium.launch({
    headless: input.headless !== false,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('request', (req) => {
      const url = req.url();
      if (!keep(url)) return;
      const call = parseCall(
        req.method(),
        url,
        req.postData() || null,
        null,
        null
      );
      const key = `${call.method} ${call.path}?${new URL(url).search}`;
      if (!byKey.has(key)) byKey.set(key, call);
    });

    page.on('response', async (res) => {
      const url = res.url();
      if (!keep(url)) return;
      const req = res.request();
      let preview: string | null = null;
      try {
        preview = (await res.text()).slice(0, 400);
      } catch {
        preview = null;
      }
      const call = parseCall(
        req.method(),
        url,
        req.postData() || null,
        res.status(),
        preview
      );
      const key = `${call.method} ${call.path}?${new URL(url).search}`;
      byKey.set(key, call);
      Object.assign(suggestedEnv, call.resourceIds);
    });

    await page.goto(toAbs(origin, '/v2/login'), {
      waitUntil: 'domcontentloaded',
      timeout: navTimeout,
    });
    await injectAuth(page, tokens, claims);

    const paths = (
      input.startPaths?.length ? input.startPaths : DEFAULT_PATHS
    ).map((p) => toAbs(origin, p));

    for (const url of paths) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout,
        });
        await page.waitForTimeout(2500);
        visited.push(page.url());
      } catch (err) {
        logger.warn('discoverApiContract nav failed', {
          url,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const labels = input.clickLabels?.length
      ? input.clickLabels
      : [
          'menu',
          'Clientes',
          'Planes Comerciales',
          'Plan Comercial',
          'Gestionar',
          'Gestión',
          'Preseleccionados',
          'Completos',
          'Todos',
        ];

    for (const label of labels) {
      try {
        const loc = page.getByText(label, { exact: false }).first();
        if (
          (await loc.count()) > 0 &&
          (await loc.isVisible().catch(() => false))
        ) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
          visited.push(page.url());
        }
      } catch {
        // ignore missing labels
      }
    }

    await page.waitForTimeout(1500);

    const calls = [...byKey.values()];
    const matches = calls.filter((c) => {
      if (matchPath) return c.path.toLowerCase().includes(matchPath);
      return /\/api\/.*(?:cuenta|client|acopio|campania|plan)/i.test(c.path);
    });

    for (const c of matches) Object.assign(suggestedEnv, c.resourceIds);

    if (!matches.length) {
      notes.push(
        'No se capturó el endpoint del ticket en Network. Revisá start_paths/click_labels o abrí la pantalla a mano y reintentá.'
      );
    }
    if (suggestedEnv.ACOPIO_ID && !suggestedEnv.CAMPANIA_ID) {
      notes.push(
        'Hay ACOPIO_ID (JWT/Network) pero falta CAMPANIA_ID: hay que capturarlo eligiendo una campaña en el FE o desde catálogo.'
      );
    }

    return {
      ok: true,
      apiBase,
      origin,
      visited: [...new Set(visited)],
      calls: calls.slice(0, 80),
      matches: matches.slice(0, 40),
      suggestedEnv,
      jwtClaims: claims
        ? {
            userId: claims.userId,
            acopiosSeePlanComercial: claims.acopiosSeePlanComercial,
          }
        : undefined,
      notes,
    };
  } catch (err) {
    return {
      ok: false,
      apiBase,
      origin,
      visited,
      calls: [],
      matches: [],
      suggestedEnv,
      jwtClaims: claims || undefined,
      notes,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser.close();
  }
}
