import {
  createLlmClient,
  resolveLlmConfig,
  AgentMessage,
  AgentChatResponse,
  LlmProvider,
  PromptTier,
  getPromptTier,
  resolveAgentInstructions,
  addUsage,
  emptyUsage,
  toTurnUsage,
  type LlmTurnUsage,
} from '../llm';
import {
  getChatSession,
  getProject,
  getProjectCredentials,
  getSetting,
  getTestRun,
  listChatMessages,
  listProjects,
  listTestRuns,
  createChatMessage,
  updateChatSession,
} from '../db';
import { QaChatToolRunner, ToolEventEmitter, getActiveChatTools, getInstalledSkillPlaybooks } from './qa-chat-tools';
import { parseTestCoverage } from './ticket-analyzer';
import { logger } from '../utils/logger';
import {
  extractJiraTicketKey,
  extractJiraTicketKeyFromUserTurns,
  extractJiraTicketKeysFromUserTurns,
  extractRequestedJiraTicketKeys,
} from '../utils/ticket-key';
import {
  buildSaveCasesPrompt,
  buildXrayCsvPrompt,
} from './qa-chat-prompts';

export { buildXrayCsvPrompt, formatTicketList } from './qa-chat-prompts';

const MAX_ITERATIONS = 8;

export type ChatAgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: string; detail?: string; data?: unknown }
  | { type: 'tool_end'; tool: string; detail?: string; data?: unknown }
  | { type: 'progress'; tool?: string; detail?: string; data?: unknown }
  | {
      type: 'done';
      message: string;
      session: { id: number; project_id: number | null; title: string };
      usage?: LlmTurnUsage;
    }
  | { type: 'error'; error: string };

function formatProjectDirectory(
  projects: ReturnType<typeof listProjects>
): string {
  if (!projects.length) return '(ninguno)';
  return projects
    .map(
      (p) =>
        `- id=${p.id} · ${p.name}` +
        (p.jira_project_key ? ` · Jira ${p.jira_project_key}` : '') +
        (p.base_url ? ` · ${p.base_url}` : '') +
        (p.has_password || p.test_user_email
          ? ' · qa_creds=sí'
          : ' · qa_creds=no')
    )
    .join('\n');
}

const DEFAULT_CHAT_INSTRUCTIONS_FULL = `Workflow (strict order — never skip):
1. User gives a ticket (Jira key or pasted text) → use fetch_ticket → explain using understanding.text from the tool (keep its sections: superficie, contraste, endpoint, modos, estado, persistencia, validaciones, entidades, cardinalidad, cálculos, payload, and any "Notas de comentarios"). Expand briefly if needed but do not invent facts absent from the ticket/comments/understanding. Jira comments often include how-to-test notes from the developer (endpoints, IDs, payloads, env) — treat those as authoritative. Do NOT ask for coverage after a pure analysis / "what do you understand" question.
   **Sparse ticket enrichment** — if the ticket has a very short description (< 3 sentences), no acceptance criteria, and few or no comments, DO NOT just generate vague cases from a one-liner. Instead, proactively enrich your understanding BEFORE analyzing:
   a) jira_search: find related tickets in the same project — the parent epic, sibling stories, or recent bugs in the same area (e.g. "project = XX AND type = Epic AND summary ~ keyword" or "project = XX AND status changed to Done AND summary ~ feature ORDER BY updated DESC"). Read the most relevant 1–2 hits with fetch_ticket to absorb their descriptions and comments.
   b) explore_app / suggest_selectors: if the ticket mentions a page or feature, open it in headless Chrome. Observe the real UI — fields, buttons, labels, navigation paths. This gives you the concrete data the ticket is missing.
   c) discover_api_contract: if the ticket is BE/API or the page makes API calls, capture real network traffic to understand the actual endpoints, params, and payloads.
   d) jira_get_comments: check comments on related tickets too (sibling stories often have dev notes about the same module).
   Use all discovered info (real selectors, real endpoints, real field labels, context from related tickets) to generate precise cases — never leave vague placeholders when you can look it up. Tell the user what extra context you found and from where.
2. If they ask to create test cases and have NOT chosen coverage yet: do NOT call analyze_ticket. Ask briefly for coverage (one short line). Do NOT list options as text to type — the UI shows buttons (Happy path / Unhappy path / Corner / Todos). Short replies like "happy", "unhappy", "corner", "todos" still count. Wait. If analyze_ticket returns coverage_required, ask the same way.
3. Once coverage is known (this message or a previous turn): use analyze_ticket with coverage=happy|unhappy|corner|all. Show the full plan (tag, description, preconditions, steps, expected results).
4. User approves or already asked to save → use save_test_cases to persist them. Without saved cases, Playwright cannot run or export scripts.
5. Playwright has TWO deliverables (do not confuse with Xray):
   a) Scripts: call generate_playwright_specs after cases are saved. Put the returned files[0].content in a \`\`\`typescript fenced block (do not rewrite or invent code). Short intro ok.
   b) Execution with evidences: call enqueue_run (also generates .spec.ts if missing). Then get_run_status (wait_ms up to 45000).
   If the user asks to "probar / ejecutar con Playwright", call generate_playwright_specs (show the script) AND enqueue_run.
   If they only ask for "scripts Playwright" / ".spec.ts", call generate_playwright_specs only (no enqueue unless they also ask to run).
6. Report results: what passed, what failed, screenshot URLs (/screenshots/...), and suggested next step. Never ask for coverage after enqueue_run or get_run_status.
7. For Jira tickets: after reporting results, ask if they want to publish to Jira. Only call publish_results_to_jira with confirmed=true after an explicit yes. Never auto-publish.
8. Jira comments: use jira_get_comments to read dev notes from a ticket without re-fetching the whole issue (useful mid-conversation to check how-to-test guidance). Use jira_post_comment to leave a comment on a ticket — ONLY after the user explicitly confirms. Never auto-post comments.

Rules:
- TC-01, TC-02, etc. are test CASE ids, never Jira ticket keys. Prefer the real ticket key from the conversation (e.g. AGDCF-4790).
- Never invent ticket content. Always use fetch_ticket or analyze_ticket. Prefer concrete how-to-test guidance from Jira comments when present.
- Never invent runId, jobId, status, progress, or screenshots. Those exist only after enqueue_run / get_run_status / list_recent_runs return them in THIS turn. If you did not call the tool, say you still need to queue/check — do not fake a JSON result.
- Never invent Playwright script source. Only paste content returned by generate_playwright_specs.
- Never invent Xray CSV rows. Only paste csv returned by export_xray_csv in a \`\`\`csv fence.
- Xray/CSV = test-management export via export_xray_csv. Playwright scripts = .spec.ts from saved cases. Creating NL cases is shared by both.
- If the user asks to launch/run Playwright before cases exist: call list_test_cases first. If empty, explain they must create and save cases first — do NOT call enqueue_run or generate_playwright_specs yet. Offer to analyze + save, and ask coverage if missing.
- If the user asks to launch/run and cases already exist, you MUST call enqueue_run before saying it is queued. Prefer also calling generate_playwright_specs so they get the script artifact.
- If enqueue_run or generate_playwright_specs returns code cases_required: tell the user to create/save cases first; do not claim a run was queued or scripts were generated.
- If the user asks how a run is going / its status / results, call get_run_status (prefer the latest live run via list_recent_runs if unsure). NEVER call enqueue_run for a status question.
- Never publish results to Jira unless the user explicitly confirms. ask first; then publish_results_to_jira with confirmed=true.
- Never post a Jira comment (jira_post_comment) unless the user explicitly confirms. Ask first.
- If config is missing (no project, no base_url, no LLM, no Jira creds): say exactly what is missing and where to configure it (Settings or Projects page).
- QA credentials (email/password) live on the project. enqueue_run and Playwright execution read them automatically. NEVER ask the user for TEST_USER_EMAIL, TEST_USER_PASSWORD, API_TOKEN, or login credentials when the active project shows qa_creds=sí (or tools return hasQaCredentials/has_password true). If qa_creds=no, tell them to set the test user in Proyectos — do not ask them to paste secrets in chat.
- Respond in human-readable text, not raw JSON (unless user asks for technical detail).
- Never mention tool names (enqueue_run, get_run_status, generate_playwright_specs, export_xray_csv, etc.) to the user.
- After enqueue_run: tell the user the run is queued and they can follow it step by step in Ejecuciones. Always include the followPath (e.g. /runs?id=3). If still running after get_run_status, point them there instead of asking them to poll. Do NOT ask coverage. Mention if scripts were written under generated/playwright when the tool says so.
- Screenshot URLs only if get_run_status returned screenshots for THIS run in THIS turn. If the array is empty or phase is queued/fetching/analyzing, say there are no captures yet — never reuse or invent old /screenshots/ paths.
- Always include screenshot URLs (/screenshots/...) when available for this run.
- If a run fails: analyze whether it is an app bug, a broken test case (bad selector, ambiguous step), or a config issue. Prefer fixing vague/invented navigation next.
- If save_test_cases returns cases_lint_failed: show the blocking findings briefly and fix/regenerate — do not claim cases were saved.
- BE/API cases run with Playwright request (API). API host is derived from project base_url (login suffix stripped). Auth uses the project QA user when running via Qatin; do not ask the user to set API_TOKEN in chat. Xray export remains available when the user asks for import CSV.

Proactive discovery — NEVER leave gaps, NEVER invent:
- You have headless Chrome (Playwright) at your disposal via discover_api_contract, suggest_selectors, and explore_app. USE THEM to fill any missing information before generating or saving cases. Do not leave placeholders like "pendiente confirmar" or generic selectors when you can look it up.
- Missing API endpoints, IDs, query params, or payload structure → call discover_api_contract with start_paths relevant to the ticket. It logs into the app with QA creds, navigates, and captures real network calls. Rewrite cases from matches/suggestedEnv only.
- Missing selectors, field labels, button text, or navigation paths → call suggest_selectors with the relevant page URL (and optional hint like "botón guardar" or "formulario de alta"). It opens the page and returns real data-testid, role, name, and id selectors. Many apps keep a hamburger/sidenav even on desktop — the executor opens it when a click target is not on screen; cases can still say "Hacer click en 'F12'".
- Unsure which pages exist, what the app looks like, or what's already covered → call explore_app to crawl the app and compare against saved cases.
- After a run fails due to bad selectors or missing elements → call suggest_selectors on the failing page, fix the cases with real selectors, save, and re-run. Do not guess different selectors.
- Chain these tools: e.g. fetch_ticket → analyze_ticket → discover_api_contract (to get real IDs) → suggest_selectors (to get real selectors) → fix cases with discovered data → save_test_cases. The goal is cases built entirely from real observed data, not from assumptions.
- If discovery tools return no useful data (page did not load, no matching network calls), tell the user what you tried and what's still missing — do not silently fall back to placeholders.
- If user pastes free text (not a ticket key): treat it as a feature description using fetch_ticket with pasted_summary + pasted_description.
- Use list_recent_runs to give context on what was already tested.
- Use lists. If the ticket is ambiguous, ask before generating cases.
- When showing generated cases, for each one include: [Happy]/[Unhappy]/[Corner], a 2–3 sentence description, numbered steps, and expected results. Do not collapse to titles-only. Keep numbered lists contiguous (1, 2, 3…); never restart at 1.
- If user asks for Xray export/import without coverage chosen: ASK coverage first (UI buttons). Do not call analyze_ticket or invent coverage=all. Once coverage is known: analyze_ticket(coverage) → export_xray_csv(strategy from analyze, including summary) → put the returned csv in a \`\`\`csv fence. One Xray Test per ticket (all TC-xx as steps). Do not invent CSV. Saving in Qatin is optional unless they ask. Never dump CSV as plain chat text.
- If the user names multiple Jira tickets in one request: process EVERY ticket (fetch/analyze/export as asked). Do not collapse to the last key. Shared coverage applies to all. For Xray: one CSV fence per ticket (never merge Issue Ids).
- Never ask for coverage AFTER already delivering cases, a CSV, or Playwright scripts.`;

const DEFAULT_CHAT_INSTRUCTIONS_COMPACT = `Tools: fetch_ticket, analyze_ticket, save_test_cases, export_xray_csv, generate_playwright_specs, discover_api_contract, enqueue_run, get_run_status, publish_results_to_jira, jira_get_comments, jira_post_comment, jira_search, list_projects, set_active_project, list_test_cases, list_recent_runs.

Order: fetch → if creating cases / Xray without coverage, ASK briefly (UI has coverage buttons; do not list options to type) → analyze_ticket(coverage) → (Xray: export_xray_csv with strategy) → save_test_cases if asked. Playwright scripts: generate_playwright_specs (fence \`\`\`typescript with returned content). Missing API IDs/params: discover_api_contract then rewrite cases from matches/suggestedEnv (never invent). Playwright run: enqueue_run (also writes .spec.ts if missing) → get_run_status. Xray = export_xray_csv; Playwright scripts = .spec.ts.
Sparse ticket: if description < 3 sentences and no AC → enrich BEFORE analyzing: jira_search for related tickets (epic, siblings), fetch_ticket on best hits, explore_app/suggest_selectors on the real page, discover_api_contract if BE. Use discovered info for precise cases.

Rules:
- TC-01/TC-02 are case ids, not Jira keys. Use the real ticket key from the thread.
- Never invent ticket content. Use fetch_ticket or analyze_ticket. Prefer how-to-test notes from Jira comments when present.
- Never invent runId/jobId/status/screenshots. Only report values returned by enqueue_run / get_run_status / list_recent_runs in THIS turn.
- Never invent Playwright script code — only paste generate_playwright_specs files[].content in a typescript fence.
- Never invent Xray CSV — only paste export_xray_csv.csv in a \`\`\`csv fence.
- Creating cases or Xray CSV without coverage (happy/unhappy/corner/all) → ASK briefly first (no typed option list). Do not call analyze_ticket yet. Do not invent coverage=all. Short answers like "todos" count. If analyze_ticket returns coverage_required, ask the same way.
- Pure analysis / "qué entendés" → fetch_ticket and present understanding.text (BE/API vs UI; modos/validaciones; notas de comentarios del dev); do NOT ask coverage.
- BE/API cases → Playwright request specs/runs; auth from project QA creds when running via Qatin. NEVER ask the user for API_TOKEN / email / password if qa_creds=sí. Xray CSV still via export_xray_csv when asked.
- Proactive discovery — NEVER leave gaps, NEVER invent: use discover_api_contract (missing API IDs/endpoints/params), suggest_selectors (missing selectors/labels/buttons), explore_app (unknown pages/coverage gaps). Chain them before saving cases. After a failed run with bad selectors → suggest_selectors on the failing page, fix, save, re-run. If discovery returns nothing useful, tell the user what you tried — do not silently use placeholders. Desktop hamburger/sidenav: executor opens it when the click target is hidden.
- After delivering cases/CSV/scripts → do NOT ask coverage again.
- After enqueue_run or get_run_status → report queue/status + followPath. Do NOT ask coverage. If screenshots[] is empty, say there are no captures yet (do not invent old ones).
- User asks for Playwright scripts only → generate_playwright_specs (save cases first if needed).
- User asks to run Playwright → generate_playwright_specs + enqueue_run when cases exist.
- User asks to run Playwright with no saved cases → list_test_cases; if empty, create/save first. Do not enqueue yet.
- User asks to launch/run and cases exist → MUST call enqueue_run before saying queued.
- enqueue_run / generate_playwright_specs returns cases_required → tell user to save cases first.
- save_test_cases returns cases_lint_failed → fix findings; do not claim saved.
- User asks how a run is going / status / results → call get_run_status (latest live run). NEVER enqueue_run for that.
- Never publish to Jira without an explicit yes from the user; then publish_results_to_jira with confirmed=true.
- Never post a Jira comment (jira_post_comment) without an explicit yes. Ask first.
- jira_get_comments reads dev notes from a ticket without re-fetching everything.
- If config is missing: say what and where to fix it.
- Include screenshot URLs (/screenshots/...) only when returned for THIS run.
- Never mention tool names to the user. After a run is queued, point them to Ejecuciones with followPath (/runs?id=N).
- Pasted text (not a key): use fetch_ticket with pasted_summary + pasted_description.
- Xray: analyze_ticket → export_xray_csv(strategy with summary) → fence csv. One Xray Test per ticket. Ask coverage first if missing. Never invent coverage=all.
- Multiple Jira keys in one ask → process EACH ticket (shared coverage). Xray: one \`\`\`csv fence per ticket; do not keep only the last key.
- When showing cases: [Happy]/[Unhappy]/[Corner] + description + steps + expected results. Not titles-only.
- Number 1, 2, 3… without restarting.`;

export function getDefaultChatInstructions(tier: PromptTier): string {
  return tier === 'compact'
    ? DEFAULT_CHAT_INSTRUCTIONS_COMPACT
    : DEFAULT_CHAT_INSTRUCTIONS_FULL;
}

function buildSystemPrompt(opts: {
  projectId: number | null;
  projectName?: string | null;
  projectCount: number;
  projectDirectory: string;
  tier: PromptTier;
  hasQaCredentials?: boolean | null;
  qaEmail?: string | null;
}): string {
  const credsBit =
    opts.projectId == null
      ? ''
      : opts.hasQaCredentials
        ? ` QA creds configured${opts.qaEmail ? ` (${opts.qaEmail})` : ''} — use them automatically; never ask the user for passwords/tokens.`
        : ' QA creds missing — point user to Proyectos (mail/password de test), do not ask them to paste secrets in chat.';
  const projectLine = opts.projectId
    ? `Active project: id=${opts.projectId}${
        opts.projectName ? ` (${opts.projectName})` : ''
      }.${credsBit}`
    : opts.projectCount === 0
      ? 'No projects configured. Ask user to create one in Projects (and set LLM/Jira in Settings).'
      : 'No active project yet. If they only ask which projects exist, answer from the list below without calling tools. Otherwise ask which one or call set_active_project.';

  const custom = (getSetting('agent_chat_instructions') || '').trim();
  const instructions = resolveAgentInstructions(
    custom,
    getDefaultChatInstructions(opts.tier),
    opts.tier
  );
  const skillPlaybooks = getInstalledSkillPlaybooks();

  const header = opts.tier === 'compact'
    ? `You are Qatin's QA agent. Answer in Spanish (argentino). Be concise.

Job: understand tickets, create test cases, run Playwright tests, report results.`
    : `You are the QA agent of Qatin. Answer in Spanish (argentino). Be clear and concise.

Your job: understand tickets, design test cases, run them with Playwright, and report results.`;

  return `${header}

Configured projects:
${opts.projectDirectory}

- ${projectLine}
- If the user only asks which projects exist, answer from the list above. Do not call list_projects unless you need fresh fields.

${instructions}${skillPlaybooks}`;
}

function historyToAgentMessages(
  rows: ReturnType<typeof listChatMessages>
): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const row of rows) {
    if (row.role === 'user') {
      const meta = row.meta as { effectiveContent?: string } | null;
      const effective =
        typeof meta?.effectiveContent === 'string' &&
        meta.effectiveContent.trim()
          ? meta.effectiveContent.trim()
          : '';
      messages.push({
        role: 'user',
        content: effective || row.content || '',
      });
      continue;
    }

    if (row.role === 'assistant') {
      const meta = row.meta as { tool_calls?: AgentMessage['tool_calls'] } | null;
      messages.push({
        role: 'assistant',
        content: row.content,
        ...(meta?.tool_calls?.length ? { tool_calls: meta.tool_calls } : {}),
      });
      continue;
    }

    if (row.role === 'tool') {
      messages.push({
        role: 'tool',
        content: row.content || '',
        tool_call_id: row.tool_call_id || undefined,
        name: row.tool_name || undefined,
      });
    }
  }

  return repairToolCallHistory(messages);
}

/**
 * OpenAI-compatible APIs require every assistant tool_call to be followed by a
 * tool message with the same tool_call_id. Aborted/crashed turns can leave
 * orphans in SQLite — synthesize stubs so the next turn does not 400.
 */
function repairToolCallHistory(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'tool') {
      // Drop orphan tool rows that are not under an open assistant tool_calls.
      i += 1;
      continue;
    }

    if (msg.role !== 'assistant' || !msg.tool_calls?.length) {
      out.push(msg);
      i += 1;
      continue;
    }

    out.push(msg);
    const needed = msg.tool_calls.map((tc) => tc.id).filter(Boolean);
    const responded = new Set<string>();
    i += 1;

    while (i < messages.length && messages[i].role === 'tool') {
      const toolMsg = messages[i];
      out.push(toolMsg);
      if (toolMsg.tool_call_id) responded.add(toolMsg.tool_call_id);
      i += 1;
    }

    for (const tc of msg.tool_calls) {
      if (!tc.id || responded.has(tc.id)) continue;
      out.push({
        role: 'tool',
        content: JSON.stringify({
          error: 'incomplete_tool_call',
          hint: 'La herramienta no llegó a responder (corte o error). Reintentá el pedido.',
        }),
        tool_call_id: tc.id,
        name: tc.function?.name,
      });
    }
  }

  return out;
}

function friendlyLlmError(error: unknown): string {
  const raw =
    (error as any)?.message ||
    'Falló el agente de chat. Revisá el LLM y reintentá.';
  if (/timed out|timeout|AbortError/i.test(raw)) {
    return 'El modelo tardó demasiado en responder. Detené y reintentá, o probá un modelo más rápido en Configuración.';
  }
  if (/model .* not found|404/i.test(raw)) {
    return `El modelo configurado no está en Ollama (${raw}). En Configuración elegí uno instalado (ej. hermes3:latest) o corré \`ollama pull <modelo>\`.`;
  }
  return raw;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error('Aborted');
  err.name = 'AbortError';
  throw err;
}

const STOPPED_MESSAGE = 'Consulta detenida.';

function isProjectsInventoryQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const asksProjects =
    /\bproyectos?\b/.test(t) ||
    /\bprojects?\b/.test(t);
  const asksList =
    /\b(qué|que|cuales|cuáles|cuantos|cuántos|lista|listá|liste|mostrar|mostrá|tengo|hay|configurad)\b/.test(
      t
    ) || /what projects|list projects|which projects/.test(t);
  const looksLikeTicketWork =
    /\b([a-z][a-z0-9]+-\d+)\b/i.test(t) ||
    /\b(probar|testear|analizar|ejecutar|ticket|caso)\b/.test(t);
  return asksProjects && asksList && !looksLikeTicketWork;
}

/** Fold Spanish text so accents do not break \\b / character classes. */
function foldChatIntent(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/** User wants to queue a Playwright run now. */
function isRunEnqueueIntent(text: string): boolean {
  const t = foldChatIntent(text);
  if (!t) return false;
  // Status questions that mention "ejecución" are not enqueue requests.
  if (isRunStatusIntent(text)) return false;

  // Explicit launch / re-queue vocabulary
  if (
    /\b(lanza|lanzar|encol\w*|correr|corre|re-?ejecut\w*|re-?encol\w*|enqueue|run (the )?tests)\b/.test(
      t
    )
  ) {
    return true;
  }

  // "ejecutar" / "ejecucion" / "ejecutalos" — note: ejecucion is ejecuci…, not ejecut…
  if (/\b(ejecut\w*|ejecucion)\b/.test(t)) {
    if (
      /\b(nueva|nuevo|otra|otro)\b/.test(t) ||
      /\b(realizar|hacer|iniciar|empezar|arrancar)\b/.test(t) ||
      /\b(ejecut\w*)\b/.test(t)
    ) {
      return true;
    }
  }

  // "proba/probar/testear … playwright|tests|casos"
  if (
    /\b(proba|probar|testea|testear)\b/.test(t) &&
    /\b(playwright|tests?|casos?)\b/.test(t)
  ) {
    return true;
  }

  // Follow-up style: "si ya hay casos … playwright"
  if (
    /\bsi ya hay casos\b/.test(t) &&
    /\b(playwright|ejecut|evidenc)\w*/.test(t)
  ) {
    return true;
  }

  // User cannot see the new run they just asked for
  if (
    /\bno veo\b/.test(t) &&
    /\b(nueva|nuevo)\b/.test(t) &&
    /\b(ejecuci|corrida|run|encol)/.test(t)
  ) {
    return true;
  }
  if (/\bno veo (la |el )?(nueva|nuevo)\b/.test(t)) {
    return true;
  }

  return false;
}

/** User is asking how a run is going / its result. */
function isRunStatusIntent(text: string): boolean {
  const t = foldChatIntent(text);
  if (!t) return false;
  // Strong enqueue phrases win over status (do not treat "la ejecución" alone as status).
  if (
    /\b(lanza|lanzar|encol\w*|nueva ejecucion|ejecucion nueva|enqueue|run (the )?tests|re-?ejecut\w*)\b/.test(
      t
    ) ||
    /\b(realizar|hacer)\b.{0,40}\bejecucion\b/.test(t) ||
    (/\b(proba|probar|testea|testear)\b/.test(t) &&
      /\b(playwright|tests?|casos?)\b/.test(t)) ||
    (/\b(ejecut\w*)\b/.test(t) && /\b(playwright|casos?|tests?|evidenc)\w*/.test(t)) ||
    /\bsi ya hay casos\b/.test(t) ||
    (/\bno veo\b/.test(t) && /\b(nueva|nuevo)\b/.test(t))
  ) {
    return false;
  }
  return (
    /\b(como va|que tal|estado|status|progreso|andamiento|resultados?)\b/.test(
      t
    ) ||
    /\bva (la )?ejecucion\b/.test(t) ||
    /^\s*get_run_status\b/.test(t)
  );
}

/** User wants an Xray/CSV export of test cases. */
function isXrayExportIntent(text: string): boolean {
  const t = foldChatIntent(text);
  return (
    /\b(xray|csv)\b/.test(t) &&
    /\b(caso|export|import|arma|gener|regen|csv)\w*/.test(t)
  );
}

/** User wants Playwright .spec.ts scripts from saved cases (not NL case creation). */
function isPlaywrightScriptsIntent(text: string): boolean {
  const t = foldChatIntent(text);
  if (!t) return false;
  if (/\b(xray|csv)\b/.test(t)) return false;
  if (
    /\b(scripts?\s+playwright|playwright\s+scripts?|codigo\s+playwright|\.spec\.ts|generar?\s+specs?)\b/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(script|spec|specs)\b/.test(t) &&
    /\b(playwright|automatiz)\w*/.test(t) &&
    !/\b(ejecut|encol|proba|probar|testea|testear|corre|correr|evidenc)\w*/.test(t)
  ) {
    return true;
  }
  return false;
}

/** User wants to create / generate / analyze test cases (incl. Xray CSV). */
function isCreateCasesIntent(text: string): boolean {
  const t = foldChatIntent(text);
  if (!t) return false;
  if (isRunEnqueueIntent(text) || isRunStatusIntent(text)) return false;
  // Scripts from existing cases are not "create cases" — skip coverage gate.
  if (isPlaywrightScriptsIntent(text)) return false;
  // Understand-only questions should not trigger case creation / coverage ask.
  if (
    /\b(entend|explica|explicame|resumi|resume|que pide|que cubre)\w*/.test(t) &&
    !/\b(casos?|plan|estrategia|cobertura)\b/.test(t)
  ) {
    return false;
  }
  if (isXrayExportIntent(text)) return true;
  return (
    /\b(genera|generar|crea|crear|arma|armar|analiza|analizar|disena|disenar|propon\w*|dame)\b/.test(
      t
    ) &&
    /\b(casos?|plan|estrategia|cobertura|tests?|pruebas?)\b/.test(t)
  );
}

function coverageAskMessage(): string {
  return '¿Qué cobertura querés? Elegí con los botones de abajo.';
}

function coverageLabel(
  coverage: NonNullable<ReturnType<typeof parseTestCoverage>>
): string {
  switch (coverage) {
    case 'happy':
      return 'happy path';
    case 'unhappy':
      return 'unhappy path (negativos)';
    case 'corner':
      return 'corner / bordes';
    case 'all':
      return '(happy path, unhappy y corner)';
  }
}

type PendingExport = {
  export: 'xray' | 'save';
  ticketKey: string | null;
  ticketKeys: string[];
};

function normalizeTicketKeys(
  keys: string[] | null | undefined,
  fallbackLast?: string | null
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys || []) {
    const key = (k || '').trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  if (!out.length && fallbackLast) {
    const key = fallbackLast.trim().toUpperCase();
    if (key) out.push(key);
  }
  return out;
}

function resolveWantedTicketKeys(
  text: string,
  pending?: PendingExport | null,
  sessionId?: number
): string[] {
  const fromText = extractRequestedJiraTicketKeys(text);
  if (fromText.length) return fromText;
  if (pending?.ticketKeys?.length) return pending.ticketKeys;
  if (pending?.ticketKey) return [pending.ticketKey];
  if (sessionId != null) {
    const fromTurns = extractJiraTicketKeysFromUserTurns(
      listChatMessages(sessionId)
    );
    if (fromTurns.length) return fromTurns;
  }
  return [];
}

/** If the last assistant turn asked for coverage, recover what the user originally wanted. */
function detectPendingExport(sessionId: number): PendingExport | null {
  const rows = listChatMessages(sessionId);
  let lastAssistant: (typeof rows)[number] | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'assistant' && (rows[i].content || '').trim()) {
      lastAssistant = rows[i];
      break;
    }
  }
  if (!lastAssistant || !looksLikeCoverageAsk(lastAssistant.content || '')) {
    return null;
  }

  const meta = lastAssistant.meta as
    | {
        pendingExport?: string;
        ticketKey?: string | null;
        ticketKeys?: string[] | null;
      }
    | null;

  let priorUser = '';
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') {
      priorUser = rows[i].content || '';
      break;
    }
  }

  const pendingExport =
    meta?.pendingExport === 'xray' || isXrayExportIntent(priorUser)
      ? 'xray'
      : meta?.pendingExport === 'save' || isCreateCasesIntent(priorUser)
        ? 'save'
        : null;
  if (!pendingExport) return null;

  const ticketKeys = normalizeTicketKeys(
    meta?.ticketKeys?.length
      ? meta.ticketKeys
      : extractRequestedJiraTicketKeys(priorUser).length
        ? extractRequestedJiraTicketKeys(priorUser)
        : extractJiraTicketKeysFromUserTurns(rows),
    meta?.ticketKey ||
      extractJiraTicketKey(priorUser) ||
      extractJiraTicketKeyFromUserTurns(rows)
  );

  return {
    export: pendingExport,
    ticketKeys,
    ticketKey: ticketKeys.length ? ticketKeys[ticketKeys.length - 1] : null,
  };
}

/**
 * If the user just picked coverage after an Xray/save ask, rewrite short
 * replies (or wrong "guardalos" chips) into an explicit multi-ticket request.
 */
function resolveEffectiveUserMessage(
  sessionId: number,
  userMessage: string
): { effective: string; rewritten: boolean; pending: PendingExport | null } {
  const pending = detectPendingExport(sessionId);
  const coverage = parseTestCoverage(userMessage);
  if (!pending || !coverage) {
    return { effective: userMessage, rewritten: false, pending };
  }

  const keys = resolveWantedTicketKeys(userMessage, pending, sessionId);
  const label = coverageLabel(coverage);

  if (pending.export === 'xray' && !isXrayExportIntent(userMessage)) {
    return {
      effective: buildXrayCsvPrompt(keys.length ? keys : ['el ticket'], label),
      rewritten: true,
      pending,
    };
  }

  if (
    pending.export === 'save' &&
    extractRequestedJiraTicketKeys(userMessage).length === 0
  ) {
    return {
      effective: buildSaveCasesPrompt(keys.length ? keys : [], label),
      rewritten: true,
      pending,
    };
  }

  return { effective: userMessage, rewritten: false, pending };
}

function looksLikeCoverageAsk(text: string): boolean {
  const t = foldChatIntent(text);
  if (!t) return false;
  return (
    /que cobertura|cobertura queres|tipo de cobertura|elegi.*botones|responde? (happy|unhappy|corner|todos)/.test(
      t
    ) ||
    (/camino feliz|\[happy\]|\bhappy\b/.test(t) &&
      (/unhappy|negativ|\[unhappy\]/.test(t) &&
        /corner|borde|\[corner\]/.test(t)))
  );
}

/** Drop a trailing coverage question when this turn should not ask for it. */
function stripTrailingCoverageAsk(text: string): string {
  const parts = text.split(/\n{2,}/);
  while (parts.length > 1 && looksLikeCoverageAsk(parts[parts.length - 1])) {
    parts.pop();
  }
  if (parts.length === 1 && looksLikeCoverageAsk(parts[0])) {
    return '';
  }
  return parts.join('\n\n').trim();
}

function claimsFabricatedRun(text: string): boolean {
  return (
    /\brunId\b/i.test(text) &&
    /\b(jobId|encolad|queued|ejecuci[oó]n)\b/i.test(text)
  );
}

function extractTicketKey(text: string): string | null {
  return extractJiraTicketKey(text);
}

function extractRunId(text: string): number | null {
  const m = text.match(/\brun(?:Id|_id)?["'\s:=]+(\d+)\b/i);
  if (m) return Number(m[1]);
  return null;
}

function resolveTicketForEnqueue(
  sessionId: number,
  userMessage: string
): string | null {
  const fromUser = extractTicketKey(userMessage);
  if (fromUser) return fromUser;

  const rows = listChatMessages(sessionId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const key = extractTicketKey(rows[i].content || '');
    if (key) return key;
  }
  return null;
}

function isLiveRunPhase(phase: string | null | undefined): boolean {
  return (
    phase !== 'completed' && phase !== 'failed' && phase !== 'cancelled'
  );
}

function resolveRunIdForStatus(
  projectId: number | null,
  userMessage: string
): number | null {
  const fromUser = extractRunId(userMessage);
  if (fromUser) {
    const run = getTestRun(fromUser);
    if (run && (projectId == null || run.project_id === projectId)) {
      return run.id;
    }
  }

  if (projectId == null) return null;
  const runs = listTestRuns(20, projectId);
  const live = runs.find((r) => isLiveRunPhase(r.phase));
  if (live) return live.id;
  return runs[0]?.id ?? null;
}

function formatEnqueueReply(result: Record<string, unknown>): string {
  if (result.error) {
    if (result.code === 'cases_required') {
      const ticket =
        typeof result.ticketId === 'string' ? ` de ${result.ticketId}` : '';
      return `Todavía no puedo ejecutar Playwright${ticket}: faltan casos de prueba guardados. Primero generá y guardá los casos; después pedime que los corra.`;
    }
    return `No pude encolar la ejecución: ${String(result.error)}`;
  }
  const followPath =
    typeof result.followPath === 'string'
      ? result.followPath
      : typeof result.runId === 'number'
        ? `/runs?id=${result.runId}`
        : '/runs';
  const ticket =
    typeof result.ticketId === 'string' ? ` de ${result.ticketId}` : '';
  const cases =
    typeof result.casesUsed === 'number'
      ? ` con ${result.casesUsed} caso(s) guardado(s)`
      : '';
  const specsInfo = result.playwrightSpecs as
    | { generated?: boolean; path?: string; alreadyExisted?: boolean }
    | undefined;
  const specsNote = specsInfo?.generated
    ? ` También dejé el script Playwright en \`${specsInfo.path || 'generated/playwright/'}\`.`
    : '';
  return `Listo: encolé la ejecución${ticket}${cases}. Seguí el progreso paso a paso en [Ejecuciones](${followPath}).${specsNote}`;
}

function formatPlaywrightSpecsReply(result: Record<string, unknown>): string {
  if (result.error) {
    if (result.code === 'cases_required') {
      const ticket =
        typeof result.ticketId === 'string' ? ` de ${result.ticketId}` : '';
      return `Todavía no puedo armar scripts Playwright${ticket}: faltan casos guardados. Primero generá y guardá los casos; después pedime los scripts.`;
    }
    return `No pude generar los scripts Playwright: ${String(result.error)}`;
  }
  const files = Array.isArray(result.files) ? result.files : [];
  const first = files[0] as { content?: string; path?: string; filename?: string } | undefined;
  const content = typeof first?.content === 'string' ? first.content : '';
  const pathHint =
    typeof first?.path === 'string'
      ? first.path
      : typeof result.ticketKey === 'string'
        ? `generated/playwright/${result.ticketKey}/`
        : 'generated/playwright/';
  const count =
    typeof result.scenarioCount === 'number'
      ? ` (${result.scenarioCount} escenario(s))`
      : '';
  if (!content.trim()) {
    return `Generé los scripts Playwright${count} en \`${pathHint}\`, pero no vino el contenido para mostrar. Pedime de nuevo los scripts.`;
  }
  return `Acá tenés el script Playwright${count}. También quedó en \`${pathHint}\`.\n\n\`\`\`typescript\n${content.trim()}\n\`\`\``;
}

function formatXrayCsvReply(result: Record<string, unknown>): string {
  if (result.error) {
    if (result.code === 'cases_required') {
      const ticket =
        typeof result.ticketId === 'string' ? ` de ${result.ticketId}` : '';
      return `Todavía no puedo armar el CSV de Xray${ticket}: faltan escenarios. Primero elegí cobertura y generá los casos; después te doy el archivo para importar.`;
    }
    return `No pude armar el CSV para Xray: ${String(result.error)}`;
  }
  const csv = typeof result.csv === 'string' ? result.csv.trim() : '';
  const scenarios =
    typeof result.scenarioCount === 'number' ? result.scenarioCount : null;
  const steps =
    typeof result.stepCount === 'number' ? result.stepCount : null;
  const ticket =
    typeof result.ticketKey === 'string' && result.ticketKey
      ? ` de ${result.ticketKey}`
      : '';
  const statsParts: string[] = ['1 caso Xray'];
  if (scenarios != null) {
    statsParts.push(
      `${scenarios} escenario${scenarios === 1 ? '' : 's'}`
    );
  }
  if (steps != null) {
    statsParts.push(`${steps} paso${steps === 1 ? '' : 's'}`);
  }
  const stats = ` (${statsParts.join(', ')})`;
  if (!csv) {
    return `Armé el export${ticket}${stats}, pero no vino el CSV. Pedime de nuevo los casos para Xray.`;
  }
  return `Listo: CSV${ticket}${stats} para importar en Xray (Test Case Importer). Todos los escenarios del ticket van en el mismo Test; la Description trae el entendimiento del ticket. Descargá el archivo y mapeá Issue Id, Summary, Step → Action, Data y Expected Result → Result.\n\n\`\`\`csv\n${csv}\n\`\`\``;
}

function formatXrayCsvReplies(results: Record<string, unknown>[]): string {
  if (!results.length) {
    return 'No pude armar el CSV para Xray.';
  }
  if (results.length === 1) return formatXrayCsvReply(results[0]);
  return results
    .map((r, i) => {
      const key =
        typeof r.ticketKey === 'string' && r.ticketKey
          ? r.ticketKey
          : `Ticket ${i + 1}`;
      return `### ${key}\n\n${formatXrayCsvReply(r)}`;
    })
    .join('\n\n');
}

function xrayResultOk(result: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    result &&
      !result.error &&
      typeof result.csv === 'string' &&
      result.csv.trim()
  );
}

/** True if strategy.scenarios include at least one real step list. */
function strategyHasExecutableSteps(strategy: unknown): boolean {
  if (!strategy || typeof strategy !== 'object') return false;
  const scenarios = (strategy as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios) || !scenarios.length) return false;
  return scenarios.some((s) => {
    if (!s || typeof s !== 'object') return false;
    const steps = (s as { steps?: unknown }).steps;
    return Array.isArray(steps) && steps.some((x) => typeof x === 'string' && x.trim());
  });
}

/**
 * LLMs often pass strategy with only id+description (no steps/expectedResults).
 * Prefer the full analyze_ticket cache when the payload is hollow.
 */
function enrichExportXrayArgs(
  rawArgs: Record<string, unknown>,
  opts: {
    analyzeByTicket: Map<
      string,
      { strategy: Record<string, unknown>; summary: string | null }
    >;
    lastAnalyzeStrategy: Record<string, unknown> | null;
    lastAnalyzeTicketId: string | null;
    lastAnalyzeTicketSummary: string | null;
  }
): Record<string, unknown> {
  const args = { ...rawArgs };
  const ticketKey = (
    (typeof args.ticket_key === 'string' && args.ticket_key) ||
    (typeof args.ticket_id === 'string' && args.ticket_id) ||
    opts.lastAnalyzeTicketId ||
    ''
  )
    .trim()
    .toUpperCase();

  const cached = ticketKey ? opts.analyzeByTicket.get(ticketKey) : null;
  const cachedStrategy =
    cached?.strategy ||
    (opts.lastAnalyzeTicketId &&
    ticketKey &&
    opts.lastAnalyzeTicketId.toUpperCase() === ticketKey
      ? opts.lastAnalyzeStrategy
      : null) ||
    opts.lastAnalyzeStrategy;

  if (
    !strategyHasExecutableSteps(args.strategy) &&
    strategyHasExecutableSteps(cachedStrategy)
  ) {
    args.strategy = cachedStrategy;
  }

  if (
    !(typeof args.ticket_summary === 'string' && args.ticket_summary.trim()) &&
    (cached?.summary || opts.lastAnalyzeTicketSummary)
  ) {
    args.ticket_summary = cached?.summary || opts.lastAnalyzeTicketSummary;
  }

  if (ticketKey && !(typeof args.ticket_key === 'string' && args.ticket_key.trim())) {
    args.ticket_key = ticketKey;
  }

  return args;
}

function formatStatusReply(result: Record<string, unknown>): string {
  if (result.error) {
    return `No pude consultar la ejecución: ${String(result.error)}`;
  }
  const followPath =
    typeof result.followPath === 'string'
      ? result.followPath
      : typeof result.runId === 'number'
        ? `/runs?id=${result.runId}`
        : '/runs';
  const phase =
    typeof result.phaseLabel === 'string'
      ? result.phaseLabel
      : typeof result.phase === 'string'
        ? result.phase
        : typeof result.status === 'string'
          ? result.status
          : 'desconocido';
  const ticket =
    typeof result.ticketId === 'string' ? ` (${result.ticketId})` : '';
  const progress =
    typeof result.progress === 'number' ? ` · ${result.progress}%` : '';
  const step =
    typeof result.currentStep === 'string' && result.currentStep.trim()
      ? `\nPaso actual: ${result.currentStep.trim()}`
      : '';
  const shots = Array.isArray(result.screenshots)
    ? result.screenshots.length
    : 0;
  const shotLine =
    shots > 0
      ? `\nEvidencias de esta corrida: ${shots} captura(s).`
      : '\nTodavía no hay capturas de esta corrida.';
  return `La ejecución${ticket} está en **${phase}**${progress}.${step}${shotLine}\nDetalle en [Ejecuciones](${followPath}).`;
}

function isEarlyRunPhase(phase: unknown): boolean {
  return (
    phase === 'queued' ||
    phase === 'fetching' ||
    phase === 'analyzing'
  );
}

function statusMentionsStaleScreenshots(
  text: string,
  status: Record<string, unknown> | null
): boolean {
  if (!status) return /\/screenshots\//i.test(text);
  const shots = Array.isArray(status.screenshots) ? status.screenshots.length : 0;
  if (shots > 0) return false;
  return /\/screenshots\/|capturas? de pantalla|evidencias? disponibles/i.test(
    text
  );
}

function answerProjectsInventory(
  projects: ReturnType<typeof listProjects>
): string {
  if (!projects.length) {
    return 'No tenés proyectos configurados todavía. Creá uno en Proyectos y volvé.';
  }
  const lines = projects.map((p) => {
    const bits = [
      `**${p.name}** (id ${p.id})`,
      p.jira_project_key ? `Jira \`${p.jira_project_key}\`` : null,
      p.base_url || null,
      p.has_password || p.test_user_email
        ? 'credenciales QA OK'
        : 'sin credenciales QA',
    ].filter(Boolean);
    return `- ${bits.join(' · ')}`;
  });
  return `Tenés ${projects.length} proyecto${projects.length === 1 ? '' : 's'} configurado${projects.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nElegí uno en el selector de arriba o decime cuál querés usar.`;
}

export async function runQaChatTurn(opts: {
  sessionId: number;
  userMessage: string;
  onEvent: (event: ChatAgentEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { sessionId, onEvent, signal } = opts;

  const session = getChatSession(sessionId);
  if (!session) {
    onEvent({ type: 'error', error: 'Sesión no encontrada' });
    return;
  }

  // Resolve before saving: coverage chip after an Xray ask must stay on Xray CSV.
  const {
    effective: userMessage,
    rewritten,
    pending: pendingExportMeta,
  } = resolveEffectiveUserMessage(sessionId, opts.userMessage);
  if (rewritten) {
    logger.warn('QaChatAgent rewrote coverage reply to Xray CSV intent', {
      sessionId,
      from: opts.userMessage.slice(0, 120),
      to: userMessage.slice(0, 160),
      ticketKeys: pendingExportMeta?.ticketKeys,
    });
  }

  createChatMessage({
    session_id: sessionId,
    role: 'user',
    content: opts.userMessage,
    ...(rewritten
      ? {
          meta: {
            effectiveContent: userMessage,
            pendingExport: pendingExportMeta?.export || 'xray',
            ticketKeys: pendingExportMeta?.ticketKeys,
            ticketKey: pendingExportMeta?.ticketKey,
          },
        }
      : {}),
  });

  if (session.title === 'Nueva conversación' && opts.userMessage.trim()) {
    const title =
      opts.userMessage.trim().length > 60
        ? `${opts.userMessage.trim().slice(0, 57)}...`
        : opts.userMessage.trim();
    updateChatSession(sessionId, { title });
  }

  const projects = listProjects();
  const projectDirectory = formatProjectDirectory(projects);

  const emitDone = (message: string, usage?: LlmTurnUsage) => {
    const endSession = getChatSession(sessionId)!;
    onEvent({
      type: 'done',
      message,
      session: {
        id: endSession.id,
        project_id: endSession.project_id,
        title: endSession.title,
      },
      ...(usage ? { usage } : {}),
    });
  };

  // Fast path: listing projects does not need the LLM (avoids Ollama tool stalls).
  if (isProjectsInventoryQuestion(userMessage)) {
    const msg = answerProjectsInventory(projects);
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg);
    return;
  }

  // Fast path: creating cases / Xray without coverage → ask before any LLM/tool work.
  // Prevents models from inventing coverage=all and delivering CSV first.
  // Playwright script export uses saved cases — do not gate on coverage.
  if (
    isCreateCasesIntent(userMessage) &&
    !isPlaywrightScriptsIntent(userMessage) &&
    !parseTestCoverage(userMessage) &&
    !isRunEnqueueIntent(userMessage)
  ) {
    const msg = coverageAskMessage();
    const pendingExport = isXrayExportIntent(userMessage) ? 'xray' : 'save';
    const ticketKeys = resolveWantedTicketKeys(userMessage, null, sessionId);
    logger.warn('QaChatAgent early coverage ask (before LLM)', {
      sessionId,
      pendingExport,
      ticketKeys,
    });
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
      meta: {
        forcedCoverageAsk: true,
        early: true,
        pendingExport,
        ticketKeys,
        ticketKey: ticketKeys.length
          ? ticketKeys[ticketKeys.length - 1]
          : null,
      },
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg);
    return;
  }

  let projectName: string | null = null;
  let hasQaCredentials: boolean | null = null;
  let qaEmail: string | null = null;
  let llmPartial: { provider?: LlmProvider; model?: string; baseUrl?: string } =
    {};

  if (session.project_id) {
    const project = getProject(session.project_id);
    if (project) {
      projectName = project.name;
      const creds = getProjectCredentials(project);
      hasQaCredentials = Boolean(creds.email && creds.password);
      qaEmail = creds.email;
      llmPartial = {
        provider: (project.llm_provider as LlmProvider | null) || undefined,
        model: project.llm_model || undefined,
        baseUrl: project.llm_base_url || undefined,
      };
    }
  }

  let client;
  let tier: PromptTier = 'full';
  try {
    const config = resolveLlmConfig(llmPartial);
    tier = getPromptTier(config.provider, config.model);
    client = createLlmClient(config);
  } catch (error: any) {
    const msg =
      error?.message ||
      'No hay LLM configurado. Andá a Configuración y cargá un proveedor.';
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg);
    return;
  }

  const emitTools: ToolEventEmitter = (ev) => {
    if (signal?.aborted) return;
    if (ev.type === 'tool_start') {
      onEvent({
        type: 'tool_start',
        tool: ev.tool || '',
        detail: ev.detail,
        data: ev.data,
      });
    } else if (ev.type === 'tool_end') {
      onEvent({
        type: 'tool_end',
        tool: ev.tool || '',
        detail: ev.detail,
        data: ev.data,
      });
    } else {
      onEvent({
        type: 'progress',
        tool: ev.tool,
        detail: ev.detail,
        data: ev.data,
      });
    }
  };

  const tools = new QaChatToolRunner(sessionId, emitTools, signal);
  const refreshed = getChatSession(sessionId)!;

  const messages: AgentMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        projectId: refreshed.project_id,
        projectName,
        projectCount: projects.length,
        projectDirectory,
        tier,
        hasQaCredentials,
        qaEmail,
      }),
    },
    ...historyToAgentMessages(listChatMessages(sessionId)),
  ];

  // LLM must see the effective Xray intent even if the UI chip said "guardalos".
  if (rewritten) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        messages[i] = { ...messages[i], content: userMessage };
        break;
      }
    }
  }

  let finalText = '';
  let usageAcc = emptyUsage();
  let llmMs = 0;
  let calledEnqueueRun = false;
  let calledGetRunStatus = false;
  let calledAnalyzeTicket = false;
  let calledFetchTicket = false;
  let calledGeneratePlaywrightSpecs = false;
  let calledExportXrayCsv = false;
  let lastSpecsResult: Record<string, unknown> | null = null;
  let lastXrayResult: Record<string, unknown> | null = null;
  const xrayByTicket = new Map<string, Record<string, unknown>>();
  const savedByTicket = new Set<string>();
  const analyzeByTicket = new Map<
    string,
    { strategy: Record<string, unknown>; summary: string | null }
  >();
  let lastAnalyzeStrategy: Record<string, unknown> | null = null;
  let lastAnalyzeTicketSummary: string | null = null;
  let statusLookupOk = false;
  let analyzeCoverageRequired = false;
  let saveLintFailed = false;
  let lastAnalyzeTicketId: string | null = null;
  let lastEnqueueResult: Record<string, unknown> | null = null;
  let lastStatusResult: Record<string, unknown> | null = null;
  let toolFallbackUsed = false;
  const wantsXray = isXrayExportIntent(userMessage);
  const wantedTickets = resolveWantedTicketKeys(
    userMessage,
    pendingExportMeta,
    sessionId
  );
  onEvent({ type: 'progress', detail: 'Consultando al modelo…' });

  const emitStopped = () => {
    const msg = STOPPED_MESSAGE;
    const usage = toTurnUsage(usageAcc, llmMs);
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
      ...(usage ? { meta: { usage } } : {}),
    });
    onEvent({ type: 'token', text: msg });
    emitDone(msg, usage);
  };

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      throwIfAborted(signal);

      const started = Date.now();
      let streamed = '';
      let tokenEst = 0;
      let lastProgress = 0;
      const emitGenerating = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgress < 200) return;
        lastProgress = now;
        const sec = Math.max(1, Math.round((now - started) / 1000));
        const detail =
          tokenEst > 0
            ? `Generando… ${tokenEst} tokens · ${sec}s`
            : `Consultando al modelo… ${sec}s`;
        onEvent({ type: 'progress', detail });
      };
      emitGenerating(true);
      const waitTick = setInterval(() => emitGenerating(), 1000);

      let response: AgentChatResponse;
      try {
        response = await client.agentChat({
          messages,
          tools: getActiveChatTools(),
          temperature: 0.3,
          signal,
          onToken: (delta) => {
            tokenEst += delta
              ? Math.max(1, Math.round(delta.length / 4))
              : 1;
            if (delta) {
              streamed += delta;
              onEvent({ type: 'token', text: streamed });
            }
            emitGenerating();
          },
        });
      } finally {
        clearInterval(waitTick);
      }
      llmMs += Date.now() - started;
      usageAcc = addUsage(usageAcc, response.usage);

      throwIfAborted(signal);

      if (response.tool_calls?.length) {
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: response.content,
          meta: { tool_calls: response.tool_calls },
        });

        messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        });

        for (let ti = 0; ti < response.tool_calls.length; ti++) {
          if (signal?.aborted) {
            for (let rj = ti; rj < response.tool_calls.length; rj++) {
              const rem = response.tool_calls[rj];
              const content = JSON.stringify({ error: 'aborted' });
              createChatMessage({
                session_id: sessionId,
                role: 'tool',
                content,
                tool_name: rem.function.name,
                tool_call_id: rem.id,
                meta: { result: { error: 'aborted' } },
              });
              messages.push({
                role: 'tool',
                content,
                tool_call_id: rem.id,
                name: rem.function.name,
              });
            }
            throwIfAborted(signal);
          }

          const call = response.tool_calls[ti];
          if (call.function.name === 'enqueue_run') {
            calledEnqueueRun = true;
          }
          if (call.function.name === 'get_run_status') {
            calledGetRunStatus = true;
          }
          if (call.function.name === 'analyze_ticket') {
            calledAnalyzeTicket = true;
          }
          if (call.function.name === 'fetch_ticket') {
            calledFetchTicket = true;
          }
          if (call.function.name === 'generate_playwright_specs') {
            calledGeneratePlaywrightSpecs = true;
          }
          if (call.function.name === 'export_xray_csv') {
            calledExportXrayCsv = true;
          }

          let result: unknown;
          try {
            let toolArgs = call.function.arguments || '{}';
            if (call.function.name === 'export_xray_csv') {
              try {
                const parsed = JSON.parse(toolArgs) as Record<string, unknown>;
                toolArgs = JSON.stringify(
                  enrichExportXrayArgs(parsed, {
                    analyzeByTicket,
                    lastAnalyzeStrategy,
                    lastAnalyzeTicketId,
                    lastAnalyzeTicketSummary,
                  })
                );
              } catch {
                // keep original args
              }
            }
            result = await tools.run(call.function.name, toolArgs);
          } catch (toolErr) {
            logger.warn('QaChatAgent tool threw; recording error result', {
              sessionId,
              tool: call.function.name,
              toolErr,
            });
            result = {
              error:
                toolErr instanceof Error
                  ? toolErr.message
                  : 'Error ejecutando herramienta',
            };
          }
          if (
            call.function.name === 'enqueue_run' &&
            result &&
            typeof result === 'object'
          ) {
            lastEnqueueResult = result as Record<string, unknown>;
          }
          if (
            call.function.name === 'generate_playwright_specs' &&
            result &&
            typeof result === 'object'
          ) {
            lastSpecsResult = result as Record<string, unknown>;
          }
          if (
            call.function.name === 'export_xray_csv' &&
            result &&
            typeof result === 'object'
          ) {
            lastXrayResult = result as Record<string, unknown>;
            const tk =
              typeof (result as { ticketKey?: string }).ticketKey === 'string'
                ? (result as { ticketKey: string }).ticketKey.toUpperCase()
                : null;
            if (tk) xrayByTicket.set(tk, lastXrayResult);
          }
          if (
            call.function.name === 'get_run_status' &&
            result &&
            typeof result === 'object' &&
            !(result as { error?: unknown }).error
          ) {
            statusLookupOk = true;
            lastStatusResult = result as Record<string, unknown>;
          }
          if (
            call.function.name === 'analyze_ticket' &&
            result &&
            typeof result === 'object'
          ) {
            const r = result as {
              error?: string;
              code?: string;
              ticket?: { key?: string; summary?: string };
              strategy?: Record<string, unknown>;
            };
            if (r.code === 'coverage_required' || r.error === 'coverage_required') {
              analyzeCoverageRequired = true;
            } else if (!r.error && r.ticket?.key) {
              analyzeCoverageRequired = false;
              lastAnalyzeTicketId = r.ticket.key;
              if (typeof r.ticket.summary === 'string' && r.ticket.summary.trim()) {
                lastAnalyzeTicketSummary = r.ticket.summary.trim();
              }
              if (r.strategy) {
                lastAnalyzeStrategy = r.strategy;
                analyzeByTicket.set(r.ticket.key.toUpperCase(), {
                  strategy: r.strategy,
                  summary: lastAnalyzeTicketSummary,
                });
              }
            }
          }
          if (
            call.function.name === 'save_test_cases' &&
            result &&
            typeof result === 'object'
          ) {
            const r = result as {
              code?: string;
              ok?: boolean;
              ticket_key?: string;
            };
            saveLintFailed = r.code === 'cases_lint_failed';
            if (r.ok) {
              saveLintFailed = false;
              if (typeof r.ticket_key === 'string' && r.ticket_key.trim()) {
                savedByTicket.add(r.ticket_key.trim().toUpperCase());
              }
            }
          }
          const content = JSON.stringify(result);
          createChatMessage({
            session_id: sessionId,
            role: 'tool',
            content,
            tool_name: call.function.name,
            tool_call_id: call.id,
            meta: { result },
          });
          messages.push({
            role: 'tool',
            content,
            tool_call_id: call.id,
            name: call.function.name,
          });
        }

        const latest = getChatSession(sessionId)!;
        if (latest.project_id !== refreshed.project_id) {
          const p = latest.project_id ? getProject(latest.project_id) : null;
          const creds = p ? getProjectCredentials(p) : null;
          messages[0] = {
            role: 'system',
            content: buildSystemPrompt({
              projectId: latest.project_id,
              projectName: p?.name || null,
              projectCount: projects.length,
              projectDirectory,
              tier,
              hasQaCredentials: Boolean(creds?.email && creds?.password),
              qaEmail: creds?.email || null,
            }),
          };
        }

        onEvent({ type: 'progress', detail: 'Procesando herramientas…' });
        continue;
      }

      finalText =
        response.content?.trim() ||
        'Listo. ¿Querés que analice otro ticket o que ejecute tests?';

      const wantsEnqueue = isRunEnqueueIntent(userMessage);
      const wantsStatus = isRunStatusIntent(userMessage);
      const wantsScripts = isPlaywrightScriptsIntent(userMessage);
      const wantsCases = isCreateCasesIntent(userMessage);
      const coverageFromMsg = parseTestCoverage(userMessage);
      const fabricated =
        !calledEnqueueRun && claimsFabricatedRun(finalText);
      const allowCoverageAsk =
        (wantsCases || analyzeCoverageRequired) &&
        !wantsEnqueue &&
        !wantsStatus &&
        !wantsScripts &&
        !wantsXray &&
        !calledEnqueueRun &&
        !calledGetRunStatus &&
        !calledGeneratePlaywrightSpecs &&
        !calledExportXrayCsv;

      // After a successful enqueue/status, never leave a coverage question as the answer.
      if (
        (calledEnqueueRun || (calledGetRunStatus && statusLookupOk)) &&
        looksLikeCoverageAsk(finalText)
      ) {
        if (calledEnqueueRun && lastEnqueueResult) {
          finalText = formatEnqueueReply(lastEnqueueResult);
          if (lastStatusResult && !lastEnqueueResult.error) {
            finalText += `\n\n${formatStatusReply(lastStatusResult)}`;
          }
        } else if (lastStatusResult) {
          finalText = formatStatusReply(lastStatusResult);
        } else {
          finalText = stripTrailingCoverageAsk(finalText) ||
            'Listo. Seguí el progreso en Ejecuciones.';
        }
        logger.warn('QaChatAgent replaced misplaced coverage ask after run tools', {
          sessionId,
          calledEnqueueRun,
          calledGetRunStatus,
        });
      } else if (!allowCoverageAsk && looksLikeCoverageAsk(finalText)) {
        const stripped = stripTrailingCoverageAsk(finalText);
        if (stripped) {
          finalText = stripped;
          logger.warn('QaChatAgent stripped trailing coverage ask', {
            sessionId,
            wantsCases,
            calledFetchTicket,
            calledAnalyzeTicket,
          });
        } else if (analyzeCoverageRequired) {
          finalText = coverageAskMessage();
        }
      }

      // After enqueue / early status: never let the model paste old screenshots or invent progress.
      if (
        (calledEnqueueRun || calledGetRunStatus) &&
        lastStatusResult &&
        (isEarlyRunPhase(lastStatusResult.phase) ||
          statusMentionsStaleScreenshots(finalText, lastStatusResult))
      ) {
        const parts: string[] = [];
        if (calledEnqueueRun && lastEnqueueResult) {
          parts.push(formatEnqueueReply(lastEnqueueResult));
        }
        parts.push(formatStatusReply(lastStatusResult));
        finalText = parts.join('\n\n');
        logger.warn('QaChatAgent replaced stale/early run status reply', {
          sessionId,
          phase: lastStatusResult.phase,
          screenshots: Array.isArray(lastStatusResult.screenshots)
            ? lastStatusResult.screenshots.length
            : 0,
        });
      }

      // Coverage was missing from analyze — if the user already said it, retry.
      // For Xray (esp. multi-ticket), let the Xray force block analyze each key.
      if (
        !toolFallbackUsed &&
        analyzeCoverageRequired &&
        coverageFromMsg &&
        !wantsXray
      ) {
        toolFallbackUsed = true;
        const ticketId =
          lastAnalyzeTicketId ||
          resolveTicketForEnqueue(sessionId, userMessage) ||
          extractTicketKey(userMessage);
        if (ticketId) {
          logger.warn('QaChatAgent forcing analyze_ticket with coverage', {
            sessionId,
            ticketId,
            coverage: coverageFromMsg,
          });
          const result = (await tools.run(
            'analyze_ticket',
            JSON.stringify({
              ticket_id: ticketId,
              coverage: coverageFromMsg,
            })
          )) as Record<string, unknown>;
          calledAnalyzeTicket = true;
          analyzeCoverageRequired = false;
          if (result.strategy) {
            finalText =
              typeof response.content === 'string' && response.content.trim()
                ? response.content.trim()
                : `Listo: armé el plan con cobertura ${coverageFromMsg}. Revisalo y si te cierra te lo guardo.`;
            // Put tool result in history for a follow-up turn; still answer now.
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'forced_analyze',
                  type: 'function',
                  function: {
                    name: 'analyze_ticket',
                    arguments: JSON.stringify({
                      ticket_id: ticketId,
                      coverage: coverageFromMsg,
                    }),
                  },
                },
              ],
            });
            messages.push({
              role: 'tool',
              content: JSON.stringify(result),
              tool_call_id: 'forced_analyze',
              name: 'analyze_ticket',
            });
            // Continue the agent loop so it can present the strategy.
            toolFallbackUsed = false;
            continue;
          }
          finalText =
            (result.error as string) ||
            'No pude regenerar los casos. Probá de nuevo con la cobertura.';
        } else {
          finalText = coverageAskMessage();
        }

        const usage = toTurnUsage(usageAcc, llmMs);
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: finalText,
          ...(usage
            ? { meta: { usage, forcedAnalyze: true } }
            : { meta: { forcedAnalyze: true } }),
        });
        onEvent({ type: 'token', text: finalText });
        break;
      }

      // Creating cases without coverage → ask (don't invent).
      if (
        !toolFallbackUsed &&
        wantsCases &&
        !coverageFromMsg &&
        !calledAnalyzeTicket &&
        !analyzeCoverageRequired &&
        !calledEnqueueRun &&
        !calledGetRunStatus &&
        allowCoverageAsk
      ) {
        toolFallbackUsed = true;
        finalText = coverageAskMessage();
        logger.warn('QaChatAgent forcing coverage question', { sessionId });
        const usage = toTurnUsage(usageAcc, llmMs);
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: finalText,
          ...(usage
            ? { meta: { usage, forcedCoverageAsk: true } }
            : { meta: { forcedCoverageAsk: true } }),
        });
        onEvent({ type: 'token', text: finalText });
        break;
      }

      // Creating cases with coverage known but model skipped analyze.
      // Xray and multi-ticket save are handled by deterministic blocks below.
      if (
        !toolFallbackUsed &&
        wantsCases &&
        coverageFromMsg &&
        !calledAnalyzeTicket &&
        !wantsXray &&
        wantedTickets.length <= 1
      ) {
        toolFallbackUsed = true;
        const ticketId =
          resolveTicketForEnqueue(sessionId, userMessage) ||
          extractTicketKey(userMessage);
        if (!ticketId) {
          finalText =
            'Para armar los casos necesito el ticket (clave Jira o texto pegado).';
        } else {
          logger.warn('QaChatAgent forcing analyze_ticket', {
            sessionId,
            ticketId,
            coverage: coverageFromMsg,
          });
          const result = (await tools.run(
            'analyze_ticket',
            JSON.stringify({
              ticket_id: ticketId,
              coverage: coverageFromMsg,
            })
          )) as Record<string, unknown>;
          calledAnalyzeTicket = true;
          const analyzed = result as {
            error?: string;
            ticket?: { key?: string; summary?: string };
            strategy?: Record<string, unknown>;
          };
          if (!analyzed.error && analyzed.strategy) {
            const summary =
              typeof analyzed.ticket?.summary === 'string'
                ? analyzed.ticket.summary.trim()
                : null;
            analyzeByTicket.set(ticketId.toUpperCase(), {
              strategy: analyzed.strategy,
              summary,
            });
            lastAnalyzeStrategy = analyzed.strategy;
            lastAnalyzeTicketId = ticketId;
            if (summary) lastAnalyzeTicketSummary = summary;
          }
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'forced_analyze',
                type: 'function',
                function: {
                  name: 'analyze_ticket',
                  arguments: JSON.stringify({
                    ticket_id: ticketId,
                    coverage: coverageFromMsg,
                  }),
                },
              },
            ],
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: 'forced_analyze',
            name: 'analyze_ticket',
          });
          toolFallbackUsed = false;
          continue;
        }

        const usage = toTurnUsage(usageAcc, llmMs);
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: finalText,
          ...(usage
            ? { meta: { usage, forcedAnalyze: true } }
            : { meta: { forcedAnalyze: true } }),
        });
        onEvent({ type: 'token', text: finalText });
        break;
      }

      // Soft hint if save failed lint and model claimed success.
      if (saveLintFailed && /guardad|saved|listos?/i.test(finalText)) {
        finalText =
          'No pude guardar los casos: falló la validación de calidad (pasos vagos, sin comillas, sin navegación o sin resultados esperados). Corregilos y pedime que los guarde de nuevo.';
      }

      // Never invent a new run when the user only asked for status.
      if (
        !toolFallbackUsed &&
        wantsStatus &&
        !statusLookupOk &&
        !calledEnqueueRun
      ) {
        toolFallbackUsed = true;
        const latest = getChatSession(sessionId)!;
        const runId = resolveRunIdForStatus(latest.project_id, userMessage);
        if (!runId) {
          finalText =
            'No hay ejecuciones en este proyecto todavía. Cuando encolés una, vas a poder seguirla acá o en Ejecuciones.';
          logger.warn('QaChatAgent status fallback: no runs', { sessionId });
        } else {
          logger.warn('QaChatAgent forcing get_run_status', {
            sessionId,
            runId,
            calledGetRunStatus,
            fabricated,
          });
          const result = (await tools.run(
            'get_run_status',
            JSON.stringify({ run_id: runId, wait_ms: 0 })
          )) as Record<string, unknown>;
          calledGetRunStatus = true;
          statusLookupOk = !result.error;
          finalText = formatStatusReply(result);
        }

        const usage = toTurnUsage(usageAcc, llmMs);
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: finalText,
          ...(usage
            ? { meta: { usage, forcedStatus: true } }
            : { meta: { forcedStatus: true } }),
        });
        onEvent({ type: 'token', text: finalText });
        break;
      }

      // Prefer deterministic Xray CSV(s) from tools; fill any missing tickets.
      // Allow coverage_required from a prior single analyze when the user already
      // chose coverage (esp. multi-ticket Xray).
      if (wantsXray && (!analyzeCoverageRequired || coverageFromMsg)) {
        const tickets =
          wantedTickets.length > 0
            ? wantedTickets
            : lastAnalyzeTicketId
              ? [lastAnalyzeTicketId.toUpperCase()]
              : [];

        const ensureAnalyzed = async (
          ticketId: string
        ): Promise<{
          strategy: Record<string, unknown>;
          summary: string | null;
        } | null> => {
          const existing = analyzeByTicket.get(ticketId);
          if (existing?.strategy) return existing;
          if (!coverageFromMsg) {
            if (tickets.length === 1 && lastAnalyzeStrategy) {
              const cached = {
                strategy: lastAnalyzeStrategy,
                summary: lastAnalyzeTicketSummary,
              };
              analyzeByTicket.set(ticketId, cached);
              return cached;
            }
            return null;
          }
          throwIfAborted(signal);
          const analyzed = (await tools.run(
            'analyze_ticket',
            JSON.stringify({
              ticket_id: ticketId,
              coverage: coverageFromMsg,
            })
          )) as {
            error?: string;
            code?: string;
            ticket?: { key?: string; summary?: string };
            strategy?: Record<string, unknown>;
          };
          calledAnalyzeTicket = true;
          if (
            analyzed.code === 'coverage_required' ||
            analyzed.error === 'coverage_required'
          ) {
            analyzeCoverageRequired = true;
            return null;
          }
          if (analyzed.error || !analyzed.strategy) return null;
          const summary =
            typeof analyzed.ticket?.summary === 'string'
              ? analyzed.ticket.summary.trim()
              : null;
          const cached = { strategy: analyzed.strategy, summary };
          analyzeByTicket.set(ticketId, cached);
          lastAnalyzeStrategy = analyzed.strategy;
          lastAnalyzeTicketId = ticketId;
          if (summary) lastAnalyzeTicketSummary = summary;
          return cached;
        };

        // Wrong-key export → re-analyze + export the wanted ticket (never reuse
        // the wrong ticket's strategy).
        if (
          tickets.length === 1 &&
          lastXrayResult &&
          xrayResultOk(lastXrayResult) &&
          !toolFallbackUsed
        ) {
          const exportedTicket =
            typeof lastXrayResult.ticketKey === 'string'
              ? lastXrayResult.ticketKey.toUpperCase()
              : null;
          if (exportedTicket && exportedTicket !== tickets[0]) {
            toolFallbackUsed = true;
            logger.warn('QaChatAgent re-exporting Xray CSV with user ticket key', {
              sessionId,
              wantedTicket: tickets[0],
              exportedTicket,
            });
            const cached = await ensureAnalyzed(tickets[0]);
            const payload: Record<string, unknown> = {
              ticket_key: tickets[0],
            };
            if (cached?.strategy) payload.strategy = cached.strategy;
            if (cached?.summary) payload.ticket_summary = cached.summary;
            if (coverageFromMsg) payload.coverage = coverageFromMsg;
            throwIfAborted(signal);
            const result = (await tools.run(
              'export_xray_csv',
              JSON.stringify(payload)
            )) as Record<string, unknown>;
            calledExportXrayCsv = true;
            lastXrayResult = result;
            xrayByTicket.set(tickets[0], result);
          }
        }

        const missing = tickets.filter((t) => !xrayResultOk(xrayByTicket.get(t)));
        if (
          tickets.length > 0 &&
          missing.length > 0 &&
          !toolFallbackUsed &&
          (coverageFromMsg ||
            lastAnalyzeStrategy ||
            calledAnalyzeTicket ||
            analyzeByTicket.size > 0 ||
            calledExportXrayCsv)
        ) {
          toolFallbackUsed = true;
          analyzeCoverageRequired = false;
          logger.warn('QaChatAgent forcing Xray export for missing tickets', {
            sessionId,
            tickets,
            missing,
          });

          for (const ticketId of missing) {
            throwIfAborted(signal);
            const cached = await ensureAnalyzed(ticketId);
            if (analyzeCoverageRequired) break;

            const payload: Record<string, unknown> = { ticket_key: ticketId };
            if (cached?.strategy) payload.strategy = cached.strategy;
            if (cached?.summary) payload.ticket_summary = cached.summary;
            if (coverageFromMsg) payload.coverage = coverageFromMsg;

            const result = (await tools.run(
              'export_xray_csv',
              JSON.stringify(payload)
            )) as Record<string, unknown>;
            calledExportXrayCsv = true;
            lastXrayResult = result;
            xrayByTicket.set(ticketId, result);
          }
        }

        if (tickets.length > 0) {
          const ordered = tickets.map(
            (t) =>
              xrayByTicket.get(t) || {
                error: `Sin CSV para ${t}`,
                ticketKey: t,
              }
          );
          if (ordered.some((r) => xrayResultOk(r)) || toolFallbackUsed) {
            finalText = formatXrayCsvReplies(ordered);
            logger.warn('QaChatAgent using export_xray_csv payload for reply', {
              sessionId,
              tickets,
              exported: ordered.filter((r) => xrayResultOk(r)).length,
            });
          }
        } else if (xrayResultOk(lastXrayResult)) {
          finalText = formatXrayCsvReply(lastXrayResult!);
        }

        if (toolFallbackUsed && wantsXray && finalText) {
          const usage = toTurnUsage(usageAcc, llmMs);
          createChatMessage({
            session_id: sessionId,
            role: 'assistant',
            content: finalText,
            ...(usage
              ? { meta: { usage, forcedXray: true } }
              : { meta: { forcedXray: true } }),
          });
          onEvent({ type: 'token', text: finalText });
          break;
        }
      }

      // Multi-ticket save: analyze + save_test_cases for each missing key.
      if (
        !wantsXray &&
        wantsCases &&
        coverageFromMsg &&
        wantedTickets.length > 1 &&
        !toolFallbackUsed &&
        !analyzeCoverageRequired
      ) {
        const missingSave = wantedTickets.filter((t) => !savedByTicket.has(t));
        if (missingSave.length > 0) {
          toolFallbackUsed = true;
          logger.warn('QaChatAgent forcing save for missing tickets', {
            sessionId,
            tickets: wantedTickets,
            missingSave,
          });
          const parts: string[] = [];
          for (const ticketId of missingSave) {
            throwIfAborted(signal);
            let cached = analyzeByTicket.get(ticketId);
            if (!cached?.strategy) {
              const analyzed = (await tools.run(
                'analyze_ticket',
                JSON.stringify({
                  ticket_id: ticketId,
                  coverage: coverageFromMsg,
                })
              )) as {
                error?: string;
                code?: string;
                ticket?: { key?: string; summary?: string };
                strategy?: Record<string, unknown>;
              };
              calledAnalyzeTicket = true;
              if (
                analyzed.code === 'coverage_required' ||
                analyzed.error === 'coverage_required'
              ) {
                analyzeCoverageRequired = true;
                parts.push(`### ${ticketId}\n\nFalta elegir cobertura.`);
                break;
              }
              if (analyzed.error || !analyzed.strategy) {
                parts.push(
                  `### ${ticketId}\n\nNo pude analizar: ${String(analyzed.error || 'sin strategy')}`
                );
                continue;
              }
              const summary =
                typeof analyzed.ticket?.summary === 'string'
                  ? analyzed.ticket.summary.trim()
                  : null;
              cached = { strategy: analyzed.strategy, summary };
              analyzeByTicket.set(ticketId, cached);
            }
            const saved = (await tools.run(
              'save_test_cases',
              JSON.stringify({
                ticket_key: ticketId,
                strategy: cached.strategy,
              })
            )) as { ok?: boolean; error?: string; code?: string; total?: number };
            if (saved.ok) {
              savedByTicket.add(ticketId);
              parts.push(
                `### ${ticketId}\n\nGuardé ${typeof saved.total === 'number' ? saved.total : 'los'} caso(s).`
              );
            } else if (saved.code === 'cases_lint_failed') {
              saveLintFailed = true;
              parts.push(
                `### ${ticketId}\n\nNo pude guardar: falló la validación de calidad.`
              );
            } else {
              parts.push(
                `### ${ticketId}\n\nNo pude guardar: ${String(saved.error || 'error')}`
              );
            }
          }
          if (parts.length) {
            finalText = parts.join('\n\n');
          }
          const usage = toTurnUsage(usageAcc, llmMs);
          createChatMessage({
            session_id: sessionId,
            role: 'assistant',
            content: finalText,
            ...(usage
              ? { meta: { usage, forcedMultiSave: true } }
              : { meta: { forcedMultiSave: true } }),
          });
          onEvent({ type: 'token', text: finalText });
          break;
        }
      }

      // Force Playwright script generation when the user asked for specs only.
      if (
        !calledGeneratePlaywrightSpecs &&
        !toolFallbackUsed &&
        wantsScripts &&
        !wantsEnqueue
      ) {
        toolFallbackUsed = true;
        const ticketId = resolveTicketForEnqueue(sessionId, userMessage);
        if (!ticketId) {
          finalText =
            'Para generar los scripts Playwright necesito el ticket (por ejemplo AGDCF-4790).';
        } else {
          logger.warn(
            'QaChatAgent forcing generate_playwright_specs after model skipped tool',
            { sessionId, ticketId }
          );
          const result = (await tools.run(
            'generate_playwright_specs',
            JSON.stringify({ ticket_key: ticketId })
          )) as Record<string, unknown>;
          calledGeneratePlaywrightSpecs = true;
          lastSpecsResult = result;
          finalText = formatPlaywrightSpecsReply(result);
        }

        const usage = toTurnUsage(usageAcc, llmMs);
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: finalText,
          ...(usage
            ? { meta: { usage, forcedSpecs: true } }
            : { meta: { forcedSpecs: true } }),
        });
        onEvent({ type: 'token', text: finalText });
        break;
      }

      // Only force enqueue when the user explicitly asked to launch.
      if (!calledEnqueueRun && !toolFallbackUsed && wantsEnqueue) {
        toolFallbackUsed = true;
        const ticketId = resolveTicketForEnqueue(sessionId, userMessage);
        if (!ticketId) {
          finalText =
            'Para encolar la ejecución necesito el ticket (por ejemplo AGDCF-4790). Decime la clave o pegá el link de Jira.';
          logger.warn('QaChatAgent enqueue fallback: missing ticket', {
            sessionId,
            fabricated,
          });
        } else {
          logger.warn('QaChatAgent forcing enqueue_run after model skipped tool', {
            sessionId,
            ticketId,
            fabricated,
          });
          const result = (await tools.run(
            'enqueue_run',
            JSON.stringify({ ticket_id: ticketId })
          )) as Record<string, unknown>;
          calledEnqueueRun = true;
          finalText = formatEnqueueReply(result);
        }

        const usage = toTurnUsage(usageAcc, llmMs);
        createChatMessage({
          session_id: sessionId,
          role: 'assistant',
          content: finalText,
          ...(usage
            ? { meta: { usage, forcedEnqueue: true } }
            : { meta: { forcedEnqueue: true } }),
        });
        onEvent({ type: 'token', text: finalText });
        break;
      }

      // Fabricated runIds without an enqueue request: do not create a run.
      if (fabricated && !calledEnqueueRun) {
        finalText =
          'No encolé una ejecución nueva. Si querés el estado de la corrida actual, preguntame cómo va; si querés otra corrida, pedime explícitamente que la lance.';
        logger.warn('QaChatAgent dropped fabricated run claim', { sessionId });
      }

      const usage = toTurnUsage(usageAcc, llmMs);
      createChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: finalText,
        ...(usage ? { meta: { usage } } : {}),
      });
      onEvent({ type: 'token', text: finalText });
      break;
    }

    if (!finalText) {
      throwIfAborted(signal);
      finalText =
        'Alcancé el límite de pasos del agente. Probá reformular el pedido o pedime el estado del run.';
      const usage = toTurnUsage(usageAcc, llmMs);
      createChatMessage({
        session_id: sessionId,
        role: 'assistant',
        content: finalText,
        ...(usage ? { meta: { usage } } : {}),
      });
      onEvent({ type: 'token', text: finalText });
    }

    emitDone(finalText, toTurnUsage(usageAcc, llmMs));
  } catch (error: any) {
    if (signal?.aborted) {
      logger.info('QaChatAgent turn aborted', { sessionId });
      emitStopped();
      return;
    }
    logger.error('QaChatAgent turn failed', error);
    const msg = friendlyLlmError(error);
    const usage = toTurnUsage(usageAcc, llmMs);
    createChatMessage({
      session_id: sessionId,
      role: 'assistant',
      content: msg,
      meta: { error: true, ...(usage ? { usage } : {}) },
    });
    onEvent({ type: 'token', text: msg });
    onEvent({ type: 'error', error: msg });
    emitDone(msg, usage);
  }
}
