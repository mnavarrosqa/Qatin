/**
 * Xray manual-test builder: one Xray Test per Jira ticket.
 * Multiple Qatin scenarios (TC-01, TC-02…) become steps inside that single Test,
 * with a description that captures ticket understanding + scenario inventory.
 */

import {
  buildXrayCsv,
  expandManualUrls,
  type XrayCsvBuildResult,
  type XrayCsvCaseInput,
} from '../utils/xray-csv';

export type XrayScenarioInput = XrayCsvCaseInput & {
  kind?: string;
};

export type BuildXrayManualTestInput = {
  ticketKey: string;
  scenarios: XrayScenarioInput[];
  /** strategy.summary — what we understood must be tested */
  understanding?: string | null;
  /** Jira issue summary */
  ticketSummary?: string | null;
  coverage?: string | null;
  baseUrl?: string | null;
};

function stripKindPrefix(description: string): string {
  return description.replace(/^\[(Happy|Unhappy|Corner)\]\s*/i, '').trim();
}

function detectKind(description: string, kind?: string): string | null {
  if (kind && /^(happy|unhappy|corner)$/i.test(kind)) {
    return kind[0].toUpperCase() + kind.slice(1).toLowerCase();
  }
  const m = description.match(/^\[(Happy|Unhappy|Corner)\]/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

/** Title of the single Xray Test: "{KEY} - {original Jira summary}". */
export function buildXrayTestSummary(
  ticketKey: string,
  opts?: { ticketSummary?: string | null }
): string {
  const ticket = ticketKey.trim().toUpperCase();
  const jiraTitle = (opts?.ticketSummary || '').trim().replace(/\s+/g, ' ');
  if (!ticket && !jiraTitle) return 'Pruebas manuales';
  if (!ticket) return jiraTitle;
  if (!jiraTitle) return `${ticket} - Pruebas manuales`;
  // Avoid duplicating the key if Jira summary already starts with it.
  const ticketRe = new RegExp(`^${escapeRegExp(ticket)}\\s*[-–—:]\\s*`, 'i');
  const title = ticketRe.test(jiraTitle)
    ? jiraTitle.replace(ticketRe, '').trim()
    : jiraTitle;
  return `${ticket} - ${title}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Rich Description for the Xray Test (wiki-ish plain text; CSV-escaped later).
 */
export function buildXrayTestDescription(input: {
  ticketKey: string;
  ticketSummary?: string | null;
  understanding?: string | null;
  coverage?: string | null;
  scenarios: XrayScenarioInput[];
  baseUrl?: string | null;
}): string {
  const ticket = input.ticketKey.trim().toUpperCase();
  const jiraSummary = (input.ticketSummary || '').trim();
  const understanding = expandManualUrls(
    (input.understanding || '').trim(),
    input.baseUrl
  );
  const coverage = (input.coverage || '').trim();

  const lines: string[] = [];
  lines.push(`Ticket: ${ticket}${jiraSummary ? ` — ${jiraSummary}` : ''}`);
  lines.push('');
  lines.push('Qué se entendió / qué se tiene que probar:');
  if (understanding) {
    lines.push(understanding);
  } else {
    lines.push(
      'Validar el comportamiento del ticket con los escenarios listados abajo (pasos manuales en orden).'
    );
  }
  if (coverage) {
    lines.push('');
    lines.push(`Cobertura pedida: ${coverage}`);
  }
  lines.push('');
  lines.push(
    `Escenarios incluidos en este Test (${input.scenarios.length}):`
  );
  input.scenarios.forEach((s, i) => {
    const id = (s.caseKey || `TC-${String(i + 1).padStart(2, '0')}`).trim();
    const kind = detectKind(s.description || '', s.kind);
    const body = expandManualUrls(stripKindPrefix(s.description || ''), input.baseUrl);
    const label = kind ? `${id} [${kind}]` : id;
    lines.push(`• ${label}: ${body || '(sin descripción)'}`);
  });
  lines.push('');
  lines.push(
    'Ejecución: seguir las Actions en orden. Cada Action lleva prefijo [TC-xx] del escenario.'
  );
  if (input.baseUrl) {
    lines.push(`Entorno: ${expandManualUrls('{{BASE_URL}}', input.baseUrl)}`);
  }

  return lines.join('\n');
}

/**
 * Flatten scenarios into Xray Actions (CSV "Step" → Action).
 * Only real actions — drop leftover “▶ Inicio …” rows if present in input.
 * Every Action gets an Expected Result (from strategy or a sensible default).
 */
export function flattenScenariosToSteps(
  scenarios: XrayScenarioInput[],
  baseUrl?: string | null
): { steps: string[]; expectedResults: string[] } {
  const steps: string[] = [];
  const expectedResults: string[] = [];

  scenarios.forEach((s, i) => {
    const id = (s.caseKey || `TC-${String(i + 1).padStart(2, '0')}`).trim();
    const scenarioSteps = (s.steps || []).map((x) => x.trim()).filter(Boolean);
    const expected = (s.expectedResults || []).map((x) => x.trim());

    if (!scenarioSteps.length) {
      const fallback = expandManualUrls(
        stripKindPrefix(s.description || '') || id,
        baseUrl
      );
      steps.push(`[${id}] ${fallback}`);
      expectedResults.push(
        expandManualUrls(expected[0] || defaultExpectedForAction(fallback), baseUrl)
      );
      return;
    }

    scenarioSteps.forEach((step, si) => {
      if (isSectionMarkerAction(step)) return;
      const expanded = expandManualUrls(step, baseUrl);
      const prefixed = expanded.startsWith(`[${id}]`)
        ? expanded
        : `[${id}] ${expanded}`;
      steps.push(prefixed);
      expectedResults.push(
        expandManualUrls(expectedForAction(expanded, expected, si), baseUrl)
      );
    });
  });

  return { steps, expectedResults };
}

/** Old builder emitted these as Steps; they are not Xray Actions. */
function isSectionMarkerAction(step: string): boolean {
  const bare = step.replace(/^\[TC-\d+\]\s*/i, '').trim();
  return /^▶?\s*Inicio\b/i.test(bare);
}

function expectedForAction(
  step: string,
  expected: string[],
  index: number
): string {
  const at = (expected[index] || '').trim();
  if (at) return at;
  return defaultExpectedForAction(step);
}

/** Fill missing Expected Result cells so Xray Result is never blank. */
export function defaultExpectedForAction(step: string): string {
  const bare = step.replace(/^\[TC-\d+\]\s*/i, '').trim();
  const valueQuoted =
    bare.match(/\bcon\s+'([^']+)'/i) ||
    bare.match(/\bcon\s+"([^"]+)"/i) ||
    null;
  const anyQuoted = bare.match(/['"]([^'"]+)['"]/);
  const value = valueQuoted?.[1] || null;
  const label = anyQuoted?.[1] || null;

  if (/^(verificar|comprobar|validar|asegurar)\b/i.test(bare)) {
    if (label) return `Se observa '${label}'`;
    return 'Se cumple la condición verificada';
  }
  if (/^(abrir|navegar|ir a)\b/i.test(bare) || /https?:\/\//i.test(bare)) {
    return 'La pantalla carga correctamente';
  }
  if (/iniciar sesi[oó]n|login|autentic/i.test(bare)) {
    return 'El usuario queda autenticado';
  }
  if (/^(completar|ingresar|escribir|cargar|llenar)\b/i.test(bare)) {
    if (value) return `El campo queda con '${value}'`;
    return 'El valor queda cargado en el formulario';
  }
  if (/^(seleccionar|elegir)\b/i.test(bare)) {
    if (label) return `Queda seleccionado '${label}'`;
    return 'La opción queda seleccionada';
  }
  if (/^(hacer click|hacer clic|clic|click|pulsar|presionar)\b/i.test(bare)) {
    if (label) return `La acción '${label}' se ejecuta`;
    return 'La UI responde a la acción';
  }
  if (/^esperar\b/i.test(bare)) {
    return 'La condición de espera se cumple';
  }
  return 'El paso se completa correctamente';
}

/**
 * Build one Xray Manual Test CSV for a ticket (all scenarios grouped).
 */
export function buildGroupedXrayManualTest(
  input: BuildXrayManualTestInput
): XrayCsvBuildResult & { scenarioCount: number } {
  const ticketKey = input.ticketKey.trim().toUpperCase();
  const scenarios = input.scenarios.filter(
    (s) => (s.description || '').trim() || (s.steps || []).length
  );

  const summary = buildXrayTestSummary(ticketKey, {
    ticketSummary: input.ticketSummary,
  });
  const description = buildXrayTestDescription({
    ticketKey,
    ticketSummary: input.ticketSummary,
    understanding: input.understanding,
    coverage: input.coverage,
    scenarios,
    baseUrl: input.baseUrl,
  });
  const { steps, expectedResults } = flattenScenariosToSteps(
    scenarios,
    input.baseUrl
  );

  // Single Xray Test — description/steps already expanded for manual runs.
  const built = buildXrayCsv(
    [
      {
        caseKey: ticketKey || 'TEST',
        summary,
        description,
        steps,
        expectedResults,
      },
    ],
    {
      ticketKey,
      baseUrl: null,
    }
  );

  return {
    ...built,
    caseCount: 1,
    scenarioCount: scenarios.length,
  };
}
