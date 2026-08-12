import type { UiMessage } from './chatGeneration';

export type FollowUp = {
  id: string;
  label: string;
  prompt: string;
};

const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

type Intent = 'understand' | 'cases' | 'run' | 'other';

function extractTickets(...texts: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(TICKET_RE)) {
      const key = match[1];
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

function classifyIntent(userText: string): Intent {
  const t = userText.toLowerCase();
  if (
    /entend|analiz|explic|resum|qu[eé]\s+(es|pide|cubre|incluye)|scope|riesgo/.test(
      t
    )
  ) {
    return 'understand';
  }
  if (
    /caso|xray|export|import|csv|gherkin|cucumber|escenario|test case/.test(t)
  ) {
    return 'cases';
  }
  if (
    /prob[aá]|ejecut|corr[eé]|playwright|evidenc|run|automatiz/.test(t)
  ) {
    return 'run';
  }
  return 'other';
}

function forTicket(ticket: string, intent: Intent): FollowUp[] {
  const run: FollowUp = {
    id: 'run-playwright',
    label: 'Probar con Playwright',
    prompt: `Probá ${ticket} con Playwright y dame evidencias (screenshots de lo que pase y falle).`,
  };
  const cases: FollowUp = {
    id: 'create-cases',
    label: 'Crear casos de prueba',
    prompt: `Creá casos de prueba para ${ticket} (happy path, negativos y bordes) y guardalos.`,
  };
  const xray: FollowUp = {
    id: 'xray-export',
    label: 'Casos para Xray',
    prompt: `Armá los casos de prueba de ${ticket} en formato CSV importable a Xray (columnas: Summary, Description, Test Type, Step, Data, Expected Result). Incluí el CSV completo listo para exportar/importar.`,
  };
  const refine: FollowUp = {
    id: 'refine-failures',
    label: 'Ajustar fallos',
    prompt: `Reanalizá los fallos de ${ticket}: separá bug de app vs caso mal armado, proponé ajustes y volvé a correr lo necesario.`,
  };

  switch (intent) {
    case 'understand':
      return [run, cases, xray];
    case 'cases':
      return [run, xray];
    case 'run':
      return [refine, xray, cases];
    default:
      return [cases, run, xray];
  }
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
  for (let i = lastAssistantIdx - 1; i >= 0; i--) {
    if (messages[i].kind === 'user') {
      lastUserContent = messages[i].content;
      break;
    }
  }

  const tickets = extractTickets(lastUserContent, assistant.content);
  if (!tickets.length) return [];

  const ticket = tickets[tickets.length - 1];
  const intent = classifyIntent(lastUserContent);
  return forTicket(ticket, intent).slice(0, 3);
}
