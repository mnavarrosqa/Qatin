/**
 * Deterministic test-case quality checks shared by analyzer, save paths,
 * and the review_test_plan skill.
 */

export type LintSeverity = 'high' | 'medium' | 'low';

export interface LintFinding {
  severity: LintSeverity;
  type: string;
  case_key?: string;
  message: string;
}

export interface LintableCase {
  case_key?: string;
  id?: string;
  description?: string;
  steps?: string[];
  expectedResults?: string[];
  urls?: string[];
  selectors?: string[];
  apiEndpoints?: string[];
}

export type LintOptions = {
  /** When api/mixed, navigation to {{BASE_URL}} is not required. */
  testType?: 'ui' | 'api' | 'manual' | 'mixed' | string;
};

export interface LintResult {
  ok: boolean;
  findings: LintFinding[];
  blocking: LintFinding[];
  stats: {
    emptySteps: number;
    vagueSteps: number;
    missingQuotes: number;
    fragileSelectors: number;
    missingExpected: number;
    missingNavigate: number;
  };
  summary: string;
}

export const FRAGILE_SELECTOR =
  /nth-child|nth-of-type|>\s*div\s*>|\/html|body\s*>/i;

const VAGUE_STEP =
  /datos v[aá]lidos|datos inv[aá]lidos|completar (el |los )?formularios?|confirmar la acci[oó]n principal|seleccionar un insumo(?!\s+['"`])|complete the form|fill (in )?the form|confirm the (main )?action/i;

const FILL_OR_SELECT =
  /\b(completar|rellenar|llenar|ingresar|escribir|seleccionar|elegir|fill|type|select)\b/i;

const CLICK_STEP =
  /\b(hacer click|hac[eé] click|click(?:ear)?|pulsar|presionar|tap)\b/i;

const NAVIGATE_STEP =
  /\b(navegar|abrir|ir a|goto|navigate|open)\b/i;

const API_STEP =
  /\b(preparar payload|enviar\s+(get|post|put|patch|delete)|verificar status http|apiEndpoints|http\s*[12]\d\d)\b/i;

/** Invented numeric resource ids in API paths (acopio/1) — require ticket/Network/env. */
const INVENTED_PATH_ID =
  /\/(?:acopio|campania|destino|cliente|client|insumo|proveedor|orden)\/(\d+)(?:\/|$|\?)/i;

/** Invented filter query strings not proven by ticket/Network. */
const INVENTED_FILTER_QUERY =
  /\?(?:[^'"\s]*&)?(?:estado|nombre|filtro|status|name)=/i;

const HAS_ENV_OR_PLACEHOLDER_ID =
  /\{\{[A-Z0-9_]+\}\}|\{[A-Za-z_][\w]*\}|ACOPIO_ID|CAMPANIA_ID/i;

const VERIFY_STEP =
  /^(check|verify|assert|validar|verificar|comprobar)\b/i;

const HAS_QUOTED = /['"`¡«].+['"`»]/;

function caseKey(c: LintableCase, index: number): string {
  return String(c.case_key || c.id || `TC-${index + 1}`);
}

export function lintTestCases(
  cases: LintableCase[],
  opts?: LintOptions
): LintResult {
  const findings: LintFinding[] = [];
  let emptySteps = 0;
  let vagueSteps = 0;
  let missingQuotes = 0;
  let fragileSelectors = 0;
  let missingExpected = 0;
  let missingNavigate = 0;
  const isApi =
    opts?.testType === 'api' ||
    opts?.testType === 'mixed' ||
    cases.some(
      (c) =>
        Array.isArray(c.apiEndpoints) && c.apiEndpoints.length > 0
    );

  if (!cases.length) {
    findings.push({
      severity: 'high',
      type: 'coverage',
      message: 'No hay casos para validar',
    });
  }

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const key = caseKey(c, i);
    const steps = Array.isArray(c.steps)
      ? c.steps.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const expected = Array.isArray(c.expectedResults)
      ? c.expectedResults.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const selectors = Array.isArray(c.selectors) ? c.selectors : [];
    const desc = (c.description || '').trim();
    const caseIsApi =
      isApi ||
      (Array.isArray(c.apiEndpoints) && c.apiEndpoints.length > 0) ||
      steps.some((s) => API_STEP.test(s));

    if (!desc || desc.length < 20) {
      findings.push({
        severity: 'medium',
        type: 'description',
        case_key: key,
        message:
          'Descripción demasiado corta — debe incluir comportamiento, precondiciones y datos',
      });
    }

    if (!steps.length) {
      emptySteps++;
      findings.push({
        severity: 'high',
        type: 'steps',
        case_key: key,
        message: 'Caso sin pasos',
      });
      continue;
    }

    const first = steps[0];
    const hasNav =
      NAVIGATE_STEP.test(first) ||
      /\{\{BASE_URL\}\}/.test(first) ||
      /^https?:\/\//i.test(first) ||
      (Array.isArray(c.urls) && c.urls.length > 0);
    if (!hasNav && !caseIsApi) {
      missingNavigate++;
      findings.push({
        severity: 'high',
        type: 'navigate',
        case_key: key,
        message:
          'El caso debe empezar con navegación a una URL concreta (o declarar urls[])',
      });
    }

    if (!expected.length) {
      missingExpected++;
      findings.push({
        severity: 'high',
        type: 'expected',
        case_key: key,
        message: 'Faltan expectedResults verificables',
      });
    }

    for (const step of steps) {
      if (VAGUE_STEP.test(step)) {
        vagueSteps++;
        findings.push({
          severity: 'high',
          type: 'vague_step',
          case_key: key,
          message: `Paso vago (sin valor/label concreto): "${step.slice(0, 100)}"`,
        });
      }

      if (caseIsApi && /\benviar\s+(get|post|put|patch|delete)\b/i.test(step)) {
        if (INVENTED_PATH_ID.test(step) && !HAS_ENV_OR_PLACEHOLDER_ID.test(step)) {
          findings.push({
            severity: 'high',
            type: 'invented_api_id',
            case_key: key,
            message: `ID de recurso inventado en el path (usar {{ACOPIO_ID}}/{{CAMPANIA_ID}} o ID real de Network): "${step.slice(0, 120)}"`,
          });
        }
        if (INVENTED_FILTER_QUERY.test(step)) {
          findings.push({
            severity: 'high',
            type: 'invented_filter_param',
            case_key: key,
            message: `Parámetro de filtro en query inventado (confirmar en Network/ticket): "${step.slice(0, 120)}"`,
          });
        }
      }

      const needsQuote =
        (FILL_OR_SELECT.test(step) || CLICK_STEP.test(step)) &&
        !HAS_QUOTED.test(step) &&
        !/iniciar sesi[oó]n con el usuario qa/i.test(step) &&
        !/hamburguesa|\bhamburger\b|men[uú]\s+(lateral|principal)|abrir\s+(el\s+)?men[uú]/i.test(
          step
        );
      if (needsQuote) {
        missingQuotes++;
        findings.push({
          severity: 'high',
          type: 'missing_quotes',
          case_key: key,
          message: `Fill/click sin valor o label entre comillas: "${step.slice(0, 100)}"`,
        });
      }

      if (VERIFY_STEP.test(step) && !HAS_QUOTED.test(step) && step.length < 40) {
        findings.push({
          severity: 'medium',
          type: 'ambiguous_step',
          case_key: key,
          message: `Aserción ambigua: "${step.slice(0, 80)}"`,
        });
      }
    }

    for (const sel of selectors) {
      if (FRAGILE_SELECTOR.test(sel)) {
        fragileSelectors++;
        findings.push({
          severity: 'medium',
          type: 'fragile_selector',
          case_key: key,
          message: `Selector frágil: ${sel}`,
        });
      }
    }
  }

  const blocking = findings.filter((f) => f.severity === 'high');
  const ok = blocking.length === 0;

  return {
    ok,
    findings: findings.slice(0, 50),
    blocking: blocking.slice(0, 30),
    stats: {
      emptySteps,
      vagueSteps,
      missingQuotes,
      fragileSelectors,
      missingExpected,
      missingNavigate,
    },
    summary: ok
      ? `Lint OK (${cases.length} casos, ${findings.length} observaciones).`
      : `Lint bloqueante: ${blocking.length} hallazgo(s) alto(s) en ${cases.length} caso(s).`,
  };
}

/** Format findings for an LLM repair prompt. */
export function formatLintForRepair(result: LintResult): string {
  if (result.ok) return '';
  return result.blocking
    .map(
      (f) =>
        `- [${f.severity}] ${f.case_key || 'plan'}: ${f.message}`
    )
    .join('\n');
}
