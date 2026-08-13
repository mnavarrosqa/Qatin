/**
 * Pure prompt helpers for multi-ticket chat (no DB / queue side effects).
 */

/** Human list: A / A y B / A, B y C. */
export function formatTicketList(tickets: string[]): string {
  const keys = tickets.filter(Boolean);
  if (keys.length === 0) return 'el ticket';
  if (keys.length === 1) return keys[0];
  if (keys.length === 2) return `${keys[0]} y ${keys[1]}`;
  return `${keys.slice(0, -1).join(', ')} y ${keys[keys.length - 1]}`;
}

export function buildXrayCsvPrompt(
  tickets: string | string[],
  coverageLabelText: string
): string {
  const keys = (Array.isArray(tickets) ? tickets : [tickets]).filter(Boolean);
  const list = formatTicketList(keys);
  if (keys.length <= 1) {
    return `Armá los casos ${coverageLabelText} de ${list} para importar en Xray. Analizá el ticket con esa cobertura y exportá el CSV con export_xray_csv (pasá la strategy). Mostrá el csv del tool en un bloque \`\`\`csv. No inventes filas a mano. No hace falta guardar en Qatin salvo que te lo pida.`;
  }
  return `Armá los casos ${coverageLabelText} de ${list} para importar en Xray. Para CADA ticket (en orden): analyze_ticket con esa cobertura → export_xray_csv (pasá la strategy). Mostrá un bloque \`\`\`csv por ticket. No inventes filas a mano. No mezcles tickets en el mismo CSV. No hace falta guardar en Qatin salvo que te lo pida.`;
}

export function buildSaveCasesPrompt(
  tickets: string[],
  coverageLabelText: string
): string {
  const list = formatTicketList(tickets);
  if (tickets.length <= 1) {
    return `Creá casos ${coverageLabelText} de ${list} y guardalos.`;
  }
  return `Creá casos ${coverageLabelText} de ${list} y guardalos. Para CADA ticket: analyze_ticket con esa cobertura → save_test_cases.`;
}
