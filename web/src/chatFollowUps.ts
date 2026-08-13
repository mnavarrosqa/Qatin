import type { UiMessage } from './chatGeneration';
import {
  extractJiraTicketKeys,
  extractJiraTicketKeyFromUserTurns,
  extractJiraTicketKeysFromUserTurns,
  extractRequestedJiraTicketKeys,
} from './ticketKey';

export type FollowUp = {
  id: string;
  label: string;
  prompt: string;
};

export type CoverageKind = 'happy' | 'unhappy' | 'corner' | 'all';

type Intent = 'understand' | 'cases' | 'xray' | 'scripts' | 'run' | 'other';

/** Human list: A / A y B / A, B y C. */
export function formatTicketList(tickets: string[]): string {
  const keys = tickets.filter(Boolean);
  if (keys.length === 0) return '';
  if (keys.length === 1) return keys[0];
  if (keys.length === 2) return `${keys[0]} y ${keys[1]}`;
  return `${keys.slice(0, -1).join(', ')} y ${keys[keys.length - 1]}`;
}

export function detectCoverage(text: string): CoverageKind | null {
  const t = text.toLowerCase().trim();
  if (
    /^(todos|todas|all)$/.test(t) ||
    (/\b(todos|all)\b/.test(t) && /caso|cobertura|path|happy/.test(t)) ||
    (/happy/.test(t) &&
      /unhappy|negativ/.test(t) &&
      /corner|borde/.test(t))
  ) {
    return 'all';
  }
  if (/unhappy|negativ|camino infeliz|error path/.test(t)) return 'unhappy';
  if (/corner|borde|edge case|l[ií]mite/.test(t)) return 'corner';
  if (/happy\s*path|camino feliz|positivos?/.test(t)) return 'happy';
  return null;
}

export function isXrayExportIntent(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(xray|csv)\b/.test(t) &&
    /caso|export|import|arm[aá]|gener|regen|csv/.test(t)
  );
}

export function isPlaywrightScriptsIntent(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(xray|csv)\b/.test(t)) return false;
  // Explicit script/spec export (not just "run playwright")
  if (
    /\b(scripts?\s+playwright|playwright\s+scripts?|c[oó]digo\s+playwright|\.spec\.ts|generar?\s+specs?)\b/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(script|spec|specs)\b/.test(t) &&
    /\b(playwright|automatiz)\w*/.test(t) &&
    !/\b(ejecut|encol|prob[aá]|corr[eé]|evidenc)\w*/.test(t)
  ) {
    return true;
  }
  return false;
}

function classifyIntent(userText: string): Intent {
  const t = userText.toLowerCase();
  if (isPlaywrightScriptsIntent(userText)) {
    return 'scripts';
  }
  // Run prompts win even if they mention "crear casos" as fallback.
  if (
    /\b(ejecut|playwright|evidenc|prob[aá]|corr[eé]|encol)\w*/.test(t) &&
    !/^(cre[aá]|gener|arm[aá]|regen).{0,40}casos/.test(t.trim())
  ) {
    if (
      /\b(playwright|evidenc|ejecut|encol|correr)\w*/.test(t) ||
      /\bsi ya hay casos/.test(t)
    ) {
      return 'run';
    }
  }
  if (isXrayExportIntent(userText)) {
    return 'xray';
  }
  if (
    /entend|analiz|explic|resum|qu[eé]\s+(es|pide|cubre|incluye)|scope|riesgo/.test(
      t
    )
  ) {
    return 'understand';
  }
  if (
    /caso|export|import|gherkin|cucumber|escenario|test case|regen/.test(t)
  ) {
    return 'cases';
  }
  if (detectCoverage(userText) && t.trim().split(/\s+/).length <= 8) {
    return 'cases';
  }
  if (
    /prob[aá]|ejecut|corr[eé]|playwright|evidenc|run|automatiz/.test(t)
  ) {
    return 'run';
  }
  return 'other';
}

function coverageChips(
  ticket: string | null,
  mode: 'save' | 'xray' = 'save'
): FollowUp[] {
  const forTicket = ticket ? ` para ${ticket}` : '';
  // Short prompts: the server rewrites coverage replies after an Xray ask.
  // Long prompts that list CSV columns were mis-rendered as CSV in the bubble.
  if (mode === 'xray') {
    return [
      { id: 'cases-happy', label: 'Happy path', prompt: 'happy path' },
      { id: 'cases-unhappy', label: 'Unhappy path', prompt: 'unhappy path' },
      { id: 'cases-corner', label: 'Corner', prompt: 'corner' },
      { id: 'cases-all', label: 'Todos', prompt: 'todos' },
    ];
  }
  return [
    {
      id: 'cases-happy',
      label: 'Happy path',
      prompt: `Creá casos happy path${forTicket} y guardalos.`,
    },
    {
      id: 'cases-unhappy',
      label: 'Unhappy path',
      prompt: `Creá casos unhappy path (negativos)${forTicket} y guardalos.`,
    },
    {
      id: 'cases-corner',
      label: 'Corner',
      prompt: `Creá casos corner / bordes${forTicket} y guardalos.`,
    },
    {
      id: 'cases-all',
      label: 'Todos',
      prompt: `Creá casos${forTicket} (happy path, unhappy y corner) y guardalos.`,
    },
  ];
}

/** Assistant is asking the user to pick coverage (buttons should lead). */
export function isCoverageAsk(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return (
    /que cobertura|cobertura queres|tipo de cobertura|elegi.*botones|botones de abajo|responde? (happy|unhappy|corner|todos)/.test(
      t
    ) ||
    (/camino feliz|happy/.test(t) &&
      /unhappy|negativ/.test(t) &&
      /corner|borde/.test(t) &&
      /todos|all|cobertura/.test(t))
  );
}

function assistantDeliveredCases(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /```csv\b/.test(t) ||
    /```(?:typescript|ts)\b/.test(t) ||
    /summary\s*,\s*description\s*,\s*test type/i.test(text) ||
    (/\btc-\d+/i.test(text) &&
      (/\[happy\]|\[unhappy\]|\[corner\]/i.test(text) ||
        /pasos?:|resultados? esperados?/i.test(t)))
  );
}

function forTicket(
  ticket: string | null,
  intent: Intent,
  coverage: CoverageKind | null,
  assistantAskedCoverage: boolean,
  casesAlreadyDelivered: boolean,
  ticketLabel?: string | null
): FollowUp[] {
  const coverageLabel = ticketLabel || ticket;
  if (assistantAskedCoverage && !coverage) {
    return coverageChips(coverageLabel, intent === 'xray' ? 'xray' : 'save');
  }

  if (!ticket) return [];

  const run: FollowUp = {
    id: 'run-playwright',
    label: 'Probar con Playwright',
    prompt: `Generá los scripts Playwright de ${ticket} a partir de los casos guardados, ejecutálos con evidencias y mostrame el .spec.ts.`,
  };
  const scripts: FollowUp = {
    id: 'playwright-scripts',
    label: 'Scripts Playwright',
    prompt: `Generá los scripts Playwright (.spec.ts) de ${ticket} a partir de los casos guardados y mostrame el código listo para descargar.`,
  };
  const xray: FollowUp = {
    id: 'xray-export',
    label: 'Casos para Xray',
    prompt: `Armá los casos de prueba de ${ticket} para importar en Xray. Exportá el CSV (Issue Id, Summary, Description, Test Type, Step, Data, Expected Result) listo para descargar/importar.`,
  };
  const refine: FollowUp = {
    id: 'refine-failures',
    label: 'Ajustar fallos',
    prompt: `Reanalizá los fallos de ${ticket}: separá bug de app vs caso mal armado, proponé ajustes y volvé a correr lo necesario.`,
  };
  const more: FollowUp = {
    id: 'more-cases',
    label: 'Más casos',
    prompt: `Creá más casos de prueba para ${ticket}.`,
  };

  // After CSV / case plan / scripts was delivered, never re-ask coverage.
  if (casesAlreadyDelivered) {
    return intent === 'xray' || intent === 'cases'
      ? [run, scripts, more, refine]
      : intent === 'scripts'
        ? [run, xray, refine]
        : [run, scripts, xray, refine];
  }

  switch (intent) {
    case 'understand':
      return [
        {
          id: 'create-cases',
          label: 'Crear casos de prueba',
          prompt: `Creá casos de prueba para ${coverageLabel || ticket}.`,
        },
        scripts,
        xray,
        run,
      ];
    case 'xray':
      if (!coverage) return coverageChips(coverageLabel, 'xray');
      return [run, scripts, more];
    case 'cases':
      if (!coverage) return coverageChips(coverageLabel, 'save');
      return [run, scripts, xray];
    case 'scripts':
      return [run, xray, more];
    case 'run':
      return [refine, scripts, xray, more];
    default:
      return [
        {
          id: 'create-cases',
          label: 'Crear casos de prueba',
          prompt: `Creá casos de prueba para ${coverageLabel || ticket}.`,
        },
        scripts,
        run,
        xray,
      ];
  }
}

/** Prefer real Jira keys from the whole thread, not only the last turn. */
function resolveTicketFromThread(messages: UiMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text =
      m.kind === 'user' || m.kind === 'assistant' ? m.content : '';
    const keys = extractJiraTicketKeys(text);
    if (keys.length) return keys[keys.length - 1];
  }
  return null;
}

function resolveTicketKeysForFollowUps(
  lastUserContent: string,
  prevUserContent: string,
  messages: UiMessage[]
): string[] {
  const fromLast = extractRequestedJiraTicketKeys(lastUserContent);
  if (fromLast.length) return fromLast;
  const fromPrev = extractRequestedJiraTicketKeys(prevUserContent);
  if (fromPrev.length) return fromPrev;
  return extractJiraTicketKeysFromUserTurns(messages);
}

/** Contextual follow-ups for the latest completed assistant turn. */
export function getFollowUps(messages: UiMessage[]): FollowUp[] {
  if (messages.length < 2) return [];

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return [];

  const assistant = messages[lastAssistantIdx];
  if (assistant.kind !== 'assistant' || !assistant.content.trim()) return [];

  // Only for the latest turn
  if (lastAssistantIdx !== messages.length - 1) return [];

  let lastUserContent = '';
  let prevUserContent = '';
  for (let i = lastAssistantIdx - 1; i >= 0; i--) {
    if (messages[i].kind === 'user') {
      if (!lastUserContent) lastUserContent = messages[i].content;
      else {
        prevUserContent = messages[i].content;
        break;
      }
    }
  }

  const ticketKeys = resolveTicketKeysForFollowUps(
    lastUserContent,
    prevUserContent,
    messages
  );
  const ticketLabel = formatTicketList(ticketKeys) || null;
  // Post-delivery follow-ups stay on the latest ticket (simple UX).
  const ticket =
    ticketKeys.slice(-1)[0] ||
    extractJiraTicketKeyFromUserTurns(messages) ||
    extractJiraTicketKeys(assistant.content).slice(-1)[0] ||
    resolveTicketFromThread(messages);
  const intent = classifyIntent(lastUserContent);
  // If assistant is asking coverage, prefer xray mode from this or the prior user turn.
  const effectiveIntent: Intent =
    isCoverageAsk(assistant.content) &&
    (isXrayExportIntent(lastUserContent) || isXrayExportIntent(prevUserContent))
      ? 'xray'
      : intent === 'xray' || isXrayExportIntent(lastUserContent)
        ? 'xray'
        : intent === 'scripts' || isPlaywrightScriptsIntent(lastUserContent)
          ? 'scripts'
          : intent;
  const coverage = detectCoverage(lastUserContent);
  const assistantAskedCoverage = isCoverageAsk(assistant.content);
  const casesAlreadyDelivered = assistantDeliveredCases(assistant.content);

  // Coverage ask always wins — even if intent classification is fuzzy ("regenerame…").
  if (assistantAskedCoverage && !coverage) {
    const xrayMode =
      effectiveIntent === 'xray' ||
      isXrayExportIntent(lastUserContent) ||
      isXrayExportIntent(prevUserContent) ||
      /xray|csv/i.test(lastUserContent);
    return coverageChips(ticketLabel || ticket, xrayMode ? 'xray' : 'save');
  }

  return forTicket(
    ticket,
    effectiveIntent,
    coverage,
    assistantAskedCoverage,
    casesAlreadyDelivered,
    ticketLabel
  );
}

export function followUpsLabel(items: FollowUp[]): string {
  if (items.length > 0 && items.every((i) => i.id.startsWith('cases-'))) {
    return '¿Qué cobertura?';
  }
  return 'Seguir con';
}
