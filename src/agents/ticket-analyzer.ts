import { logger } from '../utils/logger';
import {
  JiraIssue,
  formatJiraCommentsText,
} from '../clients/jira-client';
import {
  createLlmClient,
  resolveLlmConfig,
  LlmConfig,
  getPromptTier,
  PromptTier,
  resolveAgentInstructions,
} from '../llm';
import { getSetting } from '../db';
import {
  lintTestCases,
  formatLintForRepair,
} from './test-case-lint';

const DEFAULT_ANALYZER_INSTRUCTIONS_UI_FULL = `Quality rules (UI):
- kind: "happy" | "unhappy" | "corner". Prefix description with [Happy], [Unhappy] or [Corner].
- description: 2–4 sentences in Spanish. Include (1) the business behavior under test, (2) preconditions (user, existing data, screen state), (3) the concrete test data, (4) the observable outcome and why it matters. Never a one-liner like "flujo principal".
- steps: 6–12 ordered actions. Use verbs the executor understands: "Navegar a", "Hacer click en", "Completar el campo", "Esperar", "Verificar que", "Seleccionar", "Hacer scroll", "Hover sobre". Include the selector or text in single quotes: "Hacer click en 'Guardar'".
- Fill/select steps MUST include the concrete value in quotes: "Completar el campo 'Cliente' con 'ACME SA'". Never write "con datos válidos/inválidos" without the actual value.
- Click/confirm steps MUST include the button label in quotes: "Hacer click en 'Crear orden'". Never write bare "Confirmar la acción principal".
- expectedResults: one verifiable assertion per step (1:1 with steps). Visible text, URL, UI state, error message, redirect. Quote the exact message/label when known. Never leave a step without an expected result.
- Use realistic test data coherent with the ticket domain. State them in the description AND in the steps.
- Selector priority: [data-testid] > [role] with name > [name] > [id] > tag by type. Avoid fragile selectors like div:nth-child or generated CSS classes. If you are unsure about the real selector or label, use a reasonable placeholder — the chat agent will call suggest_selectors with headless Chrome to discover real selectors before saving.
- URLs: use {{BASE_URL}} with realistic paths FROM THE TICKET. If the ticket does not name a path, navigate to {{BASE_URL}} and click by visible label — never invent deep links. The chat agent can call explore_app to discover real navigation paths if needed.
- Hamburger / sidenav: many apps keep a hamburger menu even on desktop. The executor opens it if a click target is hidden. Optional step: "Abrir el menú hamburguesa". Click the visible business labels in the nav (e.g. 'Indicadores', 'Tablero'), never Angular module names.
- Angular/code names are NOT UI: F12Module, F12RoutingModule, "módulo f12", bundle/chunk names, Capa A/B/C. If the ticket lists screens (dashboard, radiografía, plan comercial), map them to visible nav labels. Example: módulo f12 dashboard → menú 'Indicadores' → 'Tablero'. NEVER "Hacer click en 'F12'".

Respect the requested coverage (see the user prompt). Each scenario must be independently executable.

Auth: if login is needed, first step navigates to the feature URL (not /login). Second step: "Iniciar sesión con el usuario QA del proyecto si la pantalla lo requiere".

Anti-examples (NEVER):
- BAD: "Completar los campos con datos válidos" → GOOD: "Completar el campo 'Cliente' con 'ACME SA'"
- BAD: "Confirmar la acción principal" → GOOD: "Hacer click en 'Guardar orden'"
- BAD: invent deep links absent from the ticket → GOOD: open {{BASE_URL}} then click the visible entry point.
- BAD: "Hacer click en 'F12'" because the ticket says F12Module → GOOD: click the real nav labels of the screens (e.g. 'Indicadores' then 'Tablero').

Do NOT generate generic smoke tests or vague steps without fields, values, and button labels.`;

const DEFAULT_ANALYZER_INSTRUCTIONS_UI_COMPACT = `Rules (UI):
- kind: happy | unhappy | corner. Prefix description with [Happy]/[Unhappy]/[Corner].
- description: 2–4 sentences — behavior, preconditions, test data, expected outcome.
- steps: 6–12 actions. Verbs: "Navegar a", "Hacer click en", "Completar el campo", "Esperar", "Verificar que".
- Every fill/select MUST quote the value; every click MUST quote the label.
- Forbidden vague steps: "datos válidos", "Confirmar la acción principal", "Completar el formulario".
- expectedResults: one assertion per step. Visible text, URL, UI state, error.
- URLs: {{BASE_URL}} + paths from the ticket only — never invent deep links.
- Desktop hamburger/sidenav: executor opens it when the click target is hidden. Optional step "Abrir el menú hamburguesa". Never click Angular module names (F12Module, "módulo f12"); use visible nav labels.
- Respect requested coverage. Each scenario independently executable.
- No generic smoke tests. Every case must trace to the ticket.`;

const DEFAULT_ANALYZER_INSTRUCTIONS_API_FULL = `Quality rules (API / BE endpoint):
- kind: "happy" | "unhappy" | "corner". Prefix description with [Happy], [Unhappy] or [Corner].
- This ticket is BACKEND/API. Do NOT invent UI navigation, clicks, or Playwright screen flows unless the ticket explicitly requires UI.
- description: 2–4 sentences in Spanish — endpoint/behavior, preconditions/data setup, concrete payload values, observable outcome (status, body, persistence).
- steps: 5–10 actions using verbs: "Preparar payload", "Autenticar con", "Enviar POST/PUT/PATCH/GET/DELETE a", "Verificar status HTTP", "Verificar en el body", "Verificar persistencia de". Quote concrete values, paths, status codes, and field names.
- expectedResults: one assertion per step — HTTP status, response fields, entity state, DB side effects. Quote exact expected status/labels when known.
- Fill apiEndpoints with method + path **exactly as the ticket states** (e.g. "GET /api/cuenta/client/acopio/{id}/campania/{id}"). If path/method unknown, write "pendiente confirmar en Network/Swagger" and do NOT guess.
- summary MUST be a concrete checklist in Spanish: (1) qué es el ticket / superficie BE, (2) qué endpoint y estado resultante, (3) modos de éxito del CA (uno por modo), (4) validaciones/rechazos, (5) entidades a persistir. Not a vague one-liner.
- If the ticket contrasts with a sibling (e.g. provisoria vs completa), say so in the summary.
- Prefer ONE happy scenario per distinct success mode listed in acceptance criteria (e.g. three distribution modes → three happy cases when coverage allows).
- Unhappy: validation failures (suma inconsistente, recurso incompleto, 4xx). Corner: 1 insumo/1 destino, N×N, entity missing-then-created.
- If the CA mentions Margen Total / calculated totals, assert they are computed and persisted with the resource.
- If the CA asks to document the expected payload, include payload field expectations in steps/expectedResults (or a dedicated scenario when coverage=all).

Never invent (critical):
- Do NOT invent HTTP methods. Use the method from the ticket/Swagger/Network only.
- Do NOT invent resource IDs (acopio/1, campania/1, destinoId 99, clientes 'ACME'). If the ticket uses {id}, keep placeholders or {{ACOPIO_ID}}/{{CAMPANIA_ID}} and say IDs reales pendientes de QA/Network.
- Do NOT invent query/body filter params (e.g. ?estado=Preseleccionados) unless the ticket or Network capture documents them. If the CA mentions FE filters but not the wire format: add a case that says "pendiente confirmar en Network" — never fabricate the request.
- Do NOT invent payload fields or booleans mirroring UI button names.

Payload contract (critical — applies to multi-step UI collapsed into one endpoint):
- Model the body as structured JSON the API would accept (e.g. facturacion + insumos[] + distribucion), NOT as UI button flags.
- UI modes like "Liquidar total para Agroinsumos", "Distribuir equitativamente", "Liquidar saldo restante" MUST appear in the scenario title/description, but the Preparar payload step must spell out the resulting rows/quantities (destinoId/cantidad, etc.). Never invent booleans like liquidarTotalParaAgroinsumos=true unless the ticket's documented contract shows those fields.
- Prefer nested or explicit distribution lines whose quantities sum to the line total; treat named entities (e.g. Agroinsumos) as a normal destination id unless the ticket defines a special type field.
- If the real path/payload is unknown, use {{PLACEHOLDER}} notation (e.g. {{ACOPIO_ID}}) and flag it — the chat agent will run discover_api_contract or suggest_selectors with headless Chrome to fill in real values before saving. Do NOT invent a plausible path, method, or IDs.

Do NOT:
- Default to UI/Playwright steps for a BE ticket.
- Collapse multiple CA success modes into a single vague "crear recurso" case when coverage is happy/all.
- Skip persistence or status assertions that the CA requires.
- Mirror wizard button names as API boolean flags.
- Fill gaps with invented IDs, methods, query strings, or sample names.`;

const DEFAULT_ANALYZER_INSTRUCTIONS_API_COMPACT = `Rules (API / BE):
- kind: happy | unhappy | corner. Prefix [Happy]/[Unhappy]/[Corner].
- BACKEND ticket: no UI clicks/navigation unless the ticket requires UI.
- steps: Preparar payload / Enviar METHOD path / Verificar status HTTP / Verificar body / Verificar persistencia. Quote values and statuses.
- NEVER invent method, path, resource IDs, query/body filters, or sample names. Ticket/Network only; else "pendiente confirmar en Network" + placeholders {{ACOPIO_ID}}/{{CAMPANIA_ID}}.
- Payload = JSON contract from ticket (not UI flags). Modes in title; quantities/destinoIds only when known.
- summary: checklist — superficie BE, endpoint+estado, modos de éxito del CA, validaciones, entidades.
- One happy case per distinct CA success mode when coverage is happy/all.
- apiEndpoints: method + path from ticket. expectedResults = status/body/persistence.`;

export type TestSurface = 'ui' | 'api' | 'mixed';

/** Detect whether the ticket is primarily UI, BE/API, or mixed. */
export function detectTestSurface(input: {
  summary?: string | null;
  description?: string | null;
  labels?: string[] | null;
  issuetype?: string | null;
}): TestSurface {
  const labels = (input.labels || []).join(' ');
  const text = `${input.summary || ''} ${input.description || ''} ${labels} ${input.issuetype || ''}`;
  const be =
    (text.match(
      /\b(be|backend|back[\s-]?end|endpoint|api\b|payload|rest\b|graphql|servicio|http\s*[12]\d\d|status\s*code)\b/gi
    ) || []).length;
  const ui =
    (text.match(
      /\b(ui|frontend|front[\s-]?end|pantalla|modal|bot[oó]n|checkbox|playwright|css|responsive)\b/gi
    ) || []).length;
  // Summary prefixes like "BE - …" / "Endpoint …" are strong signals.
  const summary = input.summary || '';
  if (/^\s*(be|backend|api|endpoint)\b/i.test(summary) || /\bendpoint\b/i.test(summary)) {
    return ui > be + 2 ? 'mixed' : 'api';
  }
  if (be > 0 && ui > 0) return 'mixed';
  if (be > 0 && be >= ui) return 'api';
  return 'ui';
}

/** Heuristic: saved case / scenario looks like API/BE (not Playwright UI). */
export function looksLikeApiCase(input: {
  description?: string | null;
  steps?: string[] | null;
  apiEndpoints?: string[] | null;
}): boolean {
  if (Array.isArray(input.apiEndpoints) && input.apiEndpoints.length > 0) {
    return true;
  }
  const text = `${input.description || ''} ${(input.steps || []).join(' ')}`.toLowerCase();
  return (
    /\b(preparar payload|enviar\s+(get|post|put|patch|delete)|status http|verificar persistencia|apiEndpoints)\b/.test(
      text
    ) || /\b(http\s*[12]\d\d|application\/json)\b/.test(text)
  );
}

export function getDefaultAnalyzerInstructions(
  tier: PromptTier,
  surface: TestSurface = 'ui'
): string {
  if (surface === 'api') {
    return tier === 'compact'
      ? DEFAULT_ANALYZER_INSTRUCTIONS_API_COMPACT
      : DEFAULT_ANALYZER_INSTRUCTIONS_API_FULL;
  }
  if (surface === 'mixed') {
    const ui =
      tier === 'compact'
        ? DEFAULT_ANALYZER_INSTRUCTIONS_UI_COMPACT
        : DEFAULT_ANALYZER_INSTRUCTIONS_UI_FULL;
    const api =
      tier === 'compact'
        ? DEFAULT_ANALYZER_INSTRUCTIONS_API_COMPACT
        : DEFAULT_ANALYZER_INSTRUCTIONS_API_FULL;
    return `${ui}

Also apply when the ticket is mixed FE+BE:
${api}
Prefer api/mixed testType. Cover both the contract (status/payload/persistence) and any UI trigger named in the ticket.`;
  }
  return tier === 'compact'
    ? DEFAULT_ANALYZER_INSTRUCTIONS_UI_COMPACT
    : DEFAULT_ANALYZER_INSTRUCTIONS_UI_FULL;
}

export interface TestStrategy {
  testType: 'ui' | 'api' | 'manual' | 'mixed';
  scenarios: TestScenario[];
  summary: string;
  estimatedDuration: number;
  priority: 'high' | 'medium' | 'low';
}

export type TestCoverage = 'happy' | 'unhappy' | 'corner' | 'all';

export function parseTestCoverage(raw: unknown): TestCoverage | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!t) return undefined;
  if (
    /^(all|todos|todas)$/.test(t) ||
    (/\b(all|todos)\b/.test(t) &&
      (t.includes('caso') ||
        t.includes('happy') ||
        t.includes('cobertura') ||
        t.includes('path'))) ||
    (t.includes('happy') &&
      (t.includes('unhappy') || t.includes('negativ')) &&
      (t.includes('corner') || t.includes('borde')))
  ) {
    return 'all';
  }
  if (/\b(unhappy|negative|negativos?|infeliz)\b/.test(t)) return 'unhappy';
  if (/\b(corner|edge|borde|bordes)\b/.test(t)) return 'corner';
  if (/\b(happy|positivo|positivos|camino feliz)\b/.test(t)) return 'happy';
  return undefined;
}

function coverageInstructions(
  coverage: TestCoverage,
  surface: TestSurface
): string {
  const apiHappyExtra =
    surface === 'api' || surface === 'mixed'
      ? `
If acceptance criteria list distinct success modes (e.g. "Liquidar total…", "equitativamente", "saldo restante…"), generate ONE happy scenario per mode (up to 4). Do not merge those modes into a single case.`
      : '';
  switch (coverage) {
    case 'happy':
      return `Coverage = happy only.
Generate 2–4 independent success scenarios covering distinct acceptance criteria or main flows.${apiHappyExtra}
Every case MUST complete the business outcome (persist/create/confirm, or visible success for UI).
No validation errors, no permission denials, no cancel-without-save.`;
    case 'unhappy':
      return surface === 'api' || surface === 'mixed'
        ? `Coverage = unhappy / negative only.
Generate 3–6 failure scenarios for the endpoint: invalid payload, incomplete distribution/resource, unauthorized, missing required fields, inconsistent totals.
Each MUST assert a specific HTTP error/validation and that the business resource is NOT created/updated.
No successful completion.`
        : `Coverage = unhappy / negative only.
Generate 3–6 failure scenarios: invalid data, empty required field, unauthorized, cancel/abort, duplicate, stale state.
Each MUST assert a specific error, validation, or blocked action. Quote the expected message when the ticket has one.
No successful completion of the business action.`;
    case 'corner':
      return surface === 'api' || surface === 'mixed'
        ? `Coverage = corner / edge only.
Generate 3–6 boundary scenarios: 1 resource/1 destination, N×N, entity auto-created if missing, empty arrays, max payload size, idempotent retry.
Each MUST state the boundary and the exact API/persistence reaction.`
        : `Coverage = corner / edge only.
Generate 3–6 boundary scenarios: min/max values, special characters, empty lists, already-existing records, very long text, date boundaries, unexpected prior state.
Each MUST state the boundary being probed and the exact UI reaction.`;
    default:
      return `Coverage = all (happy + unhappy + corner).
Generate 6–10 scenarios: at least 2 happy, 2 unhappy, 1–2 corner.${apiHappyExtra}
If multiple acceptance criteria exist, cover each one with the matching kind.
Prefix every description with [Happy], [Unhappy] or [Corner].`;
  }
}

export interface AnalyzeOptions {
  memoryContext?: string;
  fewShotExamples?: string;
  signal?: AbortSignal;
  onProgress?: (tokens: number) => void;
  coverage?: TestCoverage;
}

export interface TestScenario {
  id: string;
  description: string;
  kind?: Exclude<TestCoverage, 'all'>;
  steps: string[];
  expectedResults: string[];
  urls?: string[];
  selectors?: string[];
  apiEndpoints?: string[];
}

const KIND_PREFIX: Record<Exclude<TestCoverage, 'all'>, string> = {
  happy: 'Happy',
  unhappy: 'Unhappy',
  corner: 'Corner',
};

function withKindPrefix(
  description: string,
  kind?: Exclude<TestCoverage, 'all'>
): string {
  if (/^\[(Happy|Unhappy|Corner)\]/i.test(description)) return description;
  if (!kind) return description;
  return `[${KIND_PREFIX[kind]}] ${description}`;
}

function inferScenarioKind(
  scenario: { kind?: string; description?: string },
  coverage?: TestCoverage
): Exclude<TestCoverage, 'all'> | undefined {
  const fromField = parseTestCoverage(scenario.kind);
  if (fromField && fromField !== 'all') return fromField;
  const prefix = scenario.description?.match(/^\[(Happy|Unhappy|Corner)\]/i);
  if (prefix) {
    return prefix[1].toLowerCase() as Exclude<TestCoverage, 'all'>;
  }
  if (coverage && coverage !== 'all') return coverage;
  return undefined;
}

/** Minimal ticket shape for paste-mode (no Jira). */
export interface AnalyzableTicket {
  key: string;
  fields: {
    summary: string;
    description?: string | any;
    issuetype: { name: string };
    priority?: { name: string };
    status: { name: string };
    labels?: string[];
    comment?: {
      comments: Array<{
        author?: { displayName?: string; emailAddress?: string };
        body?: unknown;
        created?: string;
      }>;
      total?: number;
    };
  };
}

export function createSyntheticTicket(opts: {
  summary: string;
  description: string;
  key?: string;
}): AnalyzableTicket {
  return {
    key: opts.key || 'PASTE-1',
    fields: {
      summary: opts.summary,
      description: opts.description,
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      status: { name: 'Listo para QA' },
      labels: ['paste'],
    },
  };
}

function extractTextFromDescription(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;

  let text = '';
  const traverse = (node: any) => {
    if (node.type === 'text') {
      text += node.text + ' ';
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
    }
  };
  traverse(content);
  return text.trim();
}

/** Plain text from Jira comments attached on the issue (how-to-test from devs). */
export function extractCommentsText(
  ticket: JiraIssue | AnalyzableTicket
): string {
  return formatJiraCommentsText(
    (ticket.fields as { comment?: unknown }).comment
  );
}

export function mergeTicketText(description: string, comments: string): string {
  const d = (description || '').trim();
  const c = (comments || '').trim();
  if (!c) return d;
  if (!d) return c;
  return `${d}\n\n--- Comentarios del ticket ---\n${c}`;
}

export class TicketAnalyzer {
  private llmConfig: LlmConfig;

  constructor(llmConfig?: Partial<LlmConfig>) {
    this.llmConfig = resolveLlmConfig(llmConfig);
    logger.info('TicketAnalyzer initialized', {
      provider: this.llmConfig.provider,
      model: this.llmConfig.model,
    });
  }

  withLlmConfig(config: Partial<LlmConfig>): TicketAnalyzer {
    return new TicketAnalyzer({ ...this.llmConfig, ...config });
  }

  /**
   * Analyze a Jira ticket or synthetic ticket and generate test strategy
   */
  async analyzeTicket(
    ticket: JiraIssue | AnalyzableTicket,
    options?: AnalyzeOptions
  ): Promise<TestStrategy> {
    try {
      logger.info(`Analyzing ticket: ${ticket.key}`, {
        engram: Boolean(options?.memoryContext),
        coverage: options?.coverage || 'all',
      });

      const description = extractTextFromDescription(ticket.fields.description);
      const comments = extractCommentsText(ticket);
      const ticketText = mergeTicketText(description, comments);
      const surface = detectTestSurface({
        summary: ticket.fields.summary,
        description: ticketText,
        labels: ticket.fields.labels,
        issuetype: ticket.fields.issuetype?.name,
      });

      const acceptanceCriteria = extractAcceptanceCriteria(ticketText);
      const beChecklist =
        surface === 'api' || surface === 'mixed'
          ? extractBeChecklist({
              summary: ticket.fields.summary,
              description: ticketText,
              acceptanceCriteria,
            })
          : null;
      const prompt = this.buildAnalysisPrompt(
        ticket,
        description,
        acceptanceCriteria,
        surface,
        options,
        beChecklist,
        comments
      );

      const client = createLlmClient(this.llmConfig);
      let tokenEst = 0;
      const response = await client.chatCompletion({
        system: this.buildSystemPrompt(surface),
        user: prompt,
        json: true,
        temperature: 0.45,
        signal: options?.signal,
        onToken: options?.onProgress
          ? (delta) => {
              tokenEst += delta
                ? Math.max(1, Math.round(delta.length / 4))
                : 1;
              options.onProgress!(tokenEst);
            }
          : undefined,
      });

      let strategy = JSON.parse(response.content) as TestStrategy;
      strategy = this.normalizeStrategy(
        strategy,
        ticket,
        options?.coverage,
        surface
      );
      strategy = await this.repairIfNeeded(strategy, ticket, surface, options);
      strategy = await this.ensureSuccessModes(
        strategy,
        ticket,
        acceptanceCriteria,
        ticketText,
        surface,
        options
      );
      strategy.priority = this.determinePriority(ticket);

      logger.info(
        `Generated ${strategy.scenarios.length} test scenarios for ${ticket.key}`,
        { surface, testType: strategy.testType }
      );

      return strategy;
    } catch (error: any) {
      logger.error('Error analyzing ticket:', error);
      throw new Error(`No se pudo analizar el ticket: ${error.message}`);
    }
  }

  private get tier(): PromptTier {
    return getPromptTier(this.llmConfig.provider, this.llmConfig.model);
  }

  private buildSystemPrompt(surface: TestSurface): string {
    const custom = (getSetting('agent_analyzer_instructions') || '').trim();
    const instructions = resolveAgentInstructions(
      custom,
      getDefaultAnalyzerInstructions(this.tier, surface),
      this.tier
    );

    const surfaceLabel =
      surface === 'api'
        ? 'API/BE endpoint test cases'
        : surface === 'mixed'
          ? 'mixed UI + API test cases'
          : 'Playwright UI test cases';

    const header =
      this.tier === 'compact'
        ? `You are a QA lead. Design ${surfaceLabel} for the given ticket.
Write description, steps, expectedResults in Spanish (argentino). JSON keys and selectors in English.
Respond with ONLY valid JSON.`
        : `You are a senior QA lead designing ${surfaceLabel}.
Write human text (description, steps, expectedResults) in Spanish (argentino). JSON keys and CSS selectors in English.
Do NOT produce generic smoke tests. Every case must trace to the ticket's summary, description, acceptance criteria, or Jira comments (devs often leave how-to-test / contract notes there).
Detected surface: ${surface}. Respect it when choosing testType and step style.
Respond with ONLY valid JSON, no markdown fences.`;

    return `${header}

${instructions}`;
  }

  private buildAnalysisPrompt(
    ticket: JiraIssue | AnalyzableTicket,
    description: string,
    acceptanceCriteria: string[],
    surface: TestSurface,
    options?: AnalyzeOptions,
    beChecklist?: ReturnType<typeof extractBeChecklist> | null,
    comments = ''
  ): string {
    const coverage = options?.coverage || 'all';
    const checklistBlock = beChecklist
      ? `
**BE checklist (extraído del ticket — cubrir según coverage):**
${formatBeChecklistForPrompt(beChecklist)}
`
      : '';
    const commentsBlock = comments.trim()
      ? `
**Jira comments (often contain how-to-test / endpoints / IDs / payload notes from the developer — treat as authoritative when present):**
${comments.trim()}
`
      : '';
    const instructions =
      surface === 'api' || surface === 'mixed'
        ? `
**Instructions:**
Design an ${surface === 'mixed' ? 'API-first mixed' : 'API/BE'} test strategy specific to THIS ticket (not a UI Playwright walkthrough).

${coverageInstructions(coverage, surface)}

Each scenario must include:
1. id (TC-01, TC-02, …)
2. kind: "happy" | "unhappy" | "corner"
3. description: 2–4 sentences in Spanish (endpoint + preconditions + payload data + outcome). Prefix with [Happy], [Unhappy] or [Corner].
4. steps: 5–10 actionable API steps in Spanish (prepare payload, send METHOD, assert status/body/persistence)
5. expectedResults: one assertion per step (same length as steps), in Spanish
6. apiEndpoints: method + path strings
7. urls/selectors: omit unless mixed UI is required

Required:
- Trace each case to an acceptance criterion, description, or Jira comment (prefer concrete how-to-test notes from comments).
- Cover distinct success modes from the CA as separate happy cases when coverage is happy/all.
- When coverage is unhappy/all: cover Validaciones from the BE checklist (reject inconsistent totals, incomplete resources, etc.).
- When coverage is corner/all: cover Cardinalidad and Entidades from the BE checklist if present.
- summary must be a concrete checklist (superficie, endpoint/estado, modos, validaciones, entidades, cardinalidad).
- Forbidden: inventing UI clicks/navigation for a pure BE ticket.
- Forbidden: inventing HTTP method, path, resource IDs, query/body filters, or sample names absent from the ticket/comments/Network. If unknown → "pendiente confirmar en Network" + placeholders like {{ACOPIO_ID}}.`
        : `
**Instructions:**
Design a UI test strategy (Playwright) specific to THIS ticket.

${coverageInstructions(coverage, surface)}

Each scenario must include:
1. id (TC-01, TC-02, …)
2. kind: "happy" | "unhappy" | "corner"
3. description: 2–4 sentences in Spanish (behavior + preconditions + test data + outcome). Prefix with [Happy], [Unhappy] or [Corner].
4. steps: 6–12 actionable steps in Spanish (navigate, interact, fill data, verify)
5. expectedResults: one assertion per step (same length as steps), in Spanish
6. urls with {{BASE_URL}}
7. selectors: CSS/data-testid likely selectors for automation

Required:
- Trace each case to an acceptance criterion, description, or Jira comment (prefer concrete how-to-test notes from comments).
- Only quote labels/values that appear in the ticket or comments (or clearly marked TBD). Do NOT invent deep links, IDs, or sample company names.
- Forbidden as sole case content: "Navigate to app", "Verify page loads", "Take screenshots".
- Forbidden vague steps: "Completar los campos con datos válidos", "Confirmar la acción principal", "Seleccionar un insumo" without quoted labels/values.`;

    const memoryBlock = options?.memoryContext
      ? `
**Prior QA memory for this project/ticket (learn from failures and working selectors):**
${options.memoryContext}

Reuse selectors/labels that worked. Avoid steps/paths that failed — especially if a prior run landed on home/INICIO or missed a control.
`
      : '';

    const fewShotBlock = options?.fewShotExamples
      ? `
**Few-shot quality examples from this project:**
${options.fewShotExamples}
`
      : '';

    const acBlock =
      acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : 'No structured criteria found. Infer them from the description, summary, and comments. Cover the main behavior + obvious risks.';

    const jsonExample =
      surface === 'api' || surface === 'mixed'
        ? `{
  "testType": "${surface === 'mixed' ? 'mixed' : 'api'}",
  "summary": "BE — endpoint de alta completa. Cubrir: modo A, modo B, modo C del CA; validar rechazos por inconsistencia; persistir entidad X; estado resultante distinto de borrador.",
  "estimatedDuration": 40,
  "scenarios": [
    {
      "id": "TC-01",
      "kind": "happy",
      "description": "[Happy] Crear el recurso completo con el modo de éxito A del CA (ej. liquidar total a un destino general). Precondición: auth QA y catálogo base con IDs reales (no inventar). Payload: facturacion + 1 insumo con distribución 100% al destino del CA. Se valida HTTP 201, estado final y persistencia.",
      "steps": [
        "Preparar payload con campos del contrato del ticket (IDs reales desde QA/Network; no inventar). Incluir 'insumos[0].cantidad'='50' solo si el CA/contrato lo documenta",
        "Enviar POST a '/api/recurso-completa'",
        "Verificar status HTTP '201'",
        "Verificar en el body que el estado es el de completa/confirmada (no borrador/pendiente)",
        "Verificar persistencia del recurso y de la distribución según el modo A del CA"
      ],
      "expectedResults": [
        "El payload queda listo con suma de distribución = cantidad del insumo",
        "El endpoint responde sin error de red",
        "Status HTTP es '201' o '200'",
        "El body refleja el estado completo/confirmado",
        "La persistencia coincide con el modo A del CA"
      ],
      "apiEndpoints": ["POST /api/recurso-completa"]
    }
  ]
}`
        : `{
  "testType": "ui",
  "summary": "Validar el flujo UI del ticket: resultado de negocio, datos citados en el CA y riesgos de validación cubiertos por la cobertura pedida.",
  "estimatedDuration": 45,
  "scenarios": [
    {
      "id": "TC-01",
      "kind": "happy",
      "description": "[Happy] Completar el flujo principal del ticket con datos válidos y verificar el resultado de negocio. Precondición: usuario QA con permiso. Datos: campo 'Nombre'='Demo', valor '10'.",
      "steps": [
        "Abrir {{BASE_URL}}",
        "Iniciar sesión con el usuario QA del proyecto si la pantalla lo requiere",
        "Hacer click en el control de entrada visible del feature (usar el label del ticket)",
        "Completar el campo 'Nombre' con 'Demo'",
        "Completar el campo 'Cantidad' con '10'",
        "Hacer click en el botón de confirmación del ticket (label entre comillas)",
        "Verificar que aparece el texto de éxito citado en el ticket o un estado equivalente"
      ],
      "expectedResults": [
        "La app carga sin error",
        "El login completa o no es necesario",
        "Se entra al feature del ticket",
        "El campo Nombre acepta 'Demo'",
        "El campo Cantidad acepta '10'",
        "La acción principal se dispara",
        "Se observa el resultado de negocio esperado"
      ],
      "urls": ["{{BASE_URL}}"],
      "selectors": ["[data-testid='nombre']", "button[type='submit']"]
    }
  ]
}`;

    return `
Analyze this ticket and generate quality test cases (not generic smoke):

**Ticket info:**
- Key: ${ticket.key}
- Type: ${ticket.fields.issuetype.name}
- Summary: ${ticket.fields.summary}
- Priority: ${ticket.fields.priority?.name || 'Medium'}
- Status: ${ticket.fields.status.name}
- Detected surface: ${surface}

**Description:**
${description || 'No description provided. Base cases on the summary and comments; state assumptions explicitly in steps.'}
${commentsBlock}
**Acceptance criteria:**
${acBlock}
${checklistBlock}
**Labels:** ${ticket.fields.labels?.join(', ') || 'None'}
${memoryBlock}${fewShotBlock}
${instructions}

**Response format (JSON only, write description/steps/expectedResults in Spanish):**
${jsonExample}

Replace the example paths/fields/values with concrete ones inferred from THIS ticket (description + comments). Keep values in single quotes. Generate as many scenarios as the coverage block requires — the example shows shape only.
`;
  }

  private async repairIfNeeded(
    strategy: TestStrategy,
    ticket: JiraIssue | AnalyzableTicket,
    surface: TestSurface,
    options?: AnalyzeOptions
  ): Promise<TestStrategy> {
    const lint = lintTestCases(
      strategy.scenarios.map((s) => ({
        case_key: s.id,
        description: s.description,
        steps: s.steps,
        expectedResults: s.expectedResults,
        urls: s.urls,
        selectors: s.selectors,
        apiEndpoints: s.apiEndpoints,
      })),
      { testType: strategy.testType || surface }
    );
    if (lint.ok) return strategy;

    logger.info(
      `Analyzer lint failed for ${ticket.key} (${lint.blocking.length} blocking) — attempting repair`
    );

    try {
      const client = createLlmClient(this.llmConfig);
      const repairPrompt =
        strategy.testType === 'api' || surface === 'api'
          ? `Fix this API/BE test strategy JSON so it passes quality lint.
Return ONLY valid JSON with the same schema (testType, summary, estimatedDuration, scenarios).
Ticket: ${ticket.key} — ${ticket.fields.summary}
Coverage: ${options?.coverage || 'all'}
Surface: ${surface}

Lint problems to fix:
${formatLintForRepair(lint)}

Current strategy JSON:
${JSON.stringify(strategy)}

Rules: keep API steps (payload/METHOD/status/persistence); quote concrete values and statuses; do not convert to UI Playwright clicks; keep Spanish (argentino) in description/steps/expectedResults.`
          : `Fix this Playwright test strategy JSON so it passes quality lint.
Return ONLY valid JSON with the same schema (testType, summary, estimatedDuration, scenarios).
Ticket: ${ticket.key} — ${ticket.fields.summary}
Coverage: ${options?.coverage || 'all'}

Lint problems to fix:
${formatLintForRepair(lint)}

Current strategy JSON:
${JSON.stringify(strategy)}

Rules: quote every fill value and click label; start each case with a concrete URL ({{BASE_URL}}…); never use vague steps; keep Spanish (argentino) in description/steps/expectedResults; do not invent deep links absent from the ticket.`;

      const response = await client.chatCompletion({
        system:
          'You repair QA test strategies. Respond with ONLY valid JSON. No markdown.',
        user: repairPrompt,
        json: true,
        temperature: 0.2,
        signal: options?.signal,
      });

      const repaired = JSON.parse(response.content) as TestStrategy;
      const normalized = this.normalizeStrategy(
        repaired,
        ticket,
        options?.coverage,
        surface
      );
      const lint2 = lintTestCases(
        normalized.scenarios.map((s) => ({
          case_key: s.id,
          description: s.description,
          steps: s.steps,
          expectedResults: s.expectedResults,
          urls: s.urls,
          selectors: s.selectors,
          apiEndpoints: s.apiEndpoints,
        })),
        { testType: normalized.testType || surface }
      );
      logger.info(
        `Analyzer repair for ${ticket.key}: lint ${lint2.ok ? 'ok' : `still ${lint2.blocking.length} blocking`}`
      );
      return normalized;
    } catch (error) {
      logger.warn(`Analyzer repair failed for ${ticket.key}:`, error);
      return strategy;
    }
  }

  private normalizeStrategy(
    strategy: TestStrategy,
    ticket: JiraIssue | AnalyzableTicket,
    coverage?: TestCoverage,
    surface: TestSurface = 'ui'
  ): TestStrategy {
    const scenarios = Array.isArray(strategy.scenarios)
      ? strategy.scenarios
      : [];

    const cleaned = scenarios
      .filter((s) => s && typeof s.description === 'string')
      .map((s, index) => {
        const steps = Array.isArray(s.steps)
          ? s.steps.map((step) => String(step).trim()).filter(Boolean)
          : [];
        const expectedResults = Array.isArray(s.expectedResults)
          ? s.expectedResults.map((r) => String(r).trim()).filter(Boolean)
          : [];
        const kind = inferScenarioKind(s, coverage);

        return {
          ...s,
          id:
            (s.id && String(s.id).trim()) ||
            `TC-${String(index + 1).padStart(2, '0')}`,
          kind,
          description: withKindPrefix(s.description.trim(), kind),
          steps,
          expectedResults,
          urls: Array.isArray(s.urls)
            ? s.urls.map((u) => String(u).trim()).filter(Boolean)
            : undefined,
          selectors: Array.isArray(s.selectors)
            ? s.selectors.map((sel) => String(sel).trim()).filter(Boolean)
            : undefined,
          apiEndpoints: Array.isArray(s.apiEndpoints)
            ? s.apiEndpoints.map((e) => String(e).trim()).filter(Boolean)
            : undefined,
        };
      })
      .filter((s) => s.description && s.steps.length > 0);

    const filtered =
      coverage && coverage !== 'all'
        ? cleaned.filter((s) => !s.kind || s.kind === coverage)
        : cleaned;
    const finalScenarios = filtered.length > 0 ? filtered : cleaned;

    const allowedTypes = new Set(['ui', 'api', 'manual', 'mixed']);
    const rawType = String(strategy.testType || '').toLowerCase();
    const defaultType = surface === 'api' ? 'api' : surface === 'mixed' ? 'mixed' : 'ui';
    const testType = (
      allowedTypes.has(rawType) ? rawType : defaultType
    ) as TestStrategy['testType'];

    return {
      testType,
      summary:
        strategy.summary?.trim() ||
        `Estrategia de test para ${ticket.key}: ${ticket.fields.summary}`,
      estimatedDuration:
        typeof strategy.estimatedDuration === 'number' &&
        strategy.estimatedDuration > 0
          ? strategy.estimatedDuration
          : Math.max(15, finalScenarios.length * 8),
      priority: strategy.priority || 'medium',
      scenarios: finalScenarios,
    };
  }

  private async ensureSuccessModes(
    strategy: TestStrategy,
    ticket: JiraIssue | AnalyzableTicket,
    acceptanceCriteria: string[],
    description: string,
    surface: TestSurface,
    options?: AnalyzeOptions
  ): Promise<TestStrategy> {
    const coverage = options?.coverage || 'all';
    if (coverage !== 'happy' && coverage !== 'all') return strategy;

    const modes = extractDistinctSuccessModes(acceptanceCriteria, description);
    if (modes.length < 2) return strategy;

    const missing = modes.filter(
      (mode) => !successModeCovered(mode, strategy.scenarios)
    );
    if (!missing.length) return strategy;

    logger.info(
      `Analyzer missing success modes for ${ticket.key}: ${missing.join(' | ')} — attempting repair`
    );

    try {
      const client = createLlmClient(this.llmConfig);
      const repairPrompt = `The strategy is missing distinct success modes from the acceptance criteria.
Return ONLY valid JSON with the same schema (testType, summary, estimatedDuration, scenarios).
Ticket: ${ticket.key} — ${ticket.fields.summary}
Coverage: ${coverage}
Surface: ${surface}
testType must stay "${strategy.testType || surface}".

Missing modes (add ONE happy scenario per mode; keep existing scenarios that already cover other modes):
${missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}

All distinct modes to cover:
${modes.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Current strategy JSON:
${JSON.stringify(strategy)}

Rules: do not merge modes into one case; quote concrete values; ${
        surface === 'api' || strategy.testType === 'api'
          ? 'use API steps (payload/METHOD/status/persistence), not UI clicks'
          : 'keep UI steps with quoted labels'
      }; Spanish (argentino) in description/steps/expectedResults; update summary to list the modes.`;

      const response = await client.chatCompletion({
        system:
          'You repair QA test strategies to cover missing acceptance-criteria success modes. Respond with ONLY valid JSON.',
        user: repairPrompt,
        json: true,
        temperature: 0.25,
        signal: options?.signal,
      });

      const repaired = JSON.parse(response.content) as TestStrategy;
      return this.normalizeStrategy(
        repaired,
        ticket,
        options?.coverage,
        surface
      );
    } catch (error) {
      logger.warn(`Success-mode repair failed for ${ticket.key}:`, error);
      return strategy;
    }
  }

  private determinePriority(
    ticket: JiraIssue | AnalyzableTicket
  ): 'high' | 'medium' | 'low' {
    const priorityName = ticket.fields.priority?.name.toLowerCase() || 'medium';

    if (priorityName.includes('highest') || priorityName.includes('critical')) {
      return 'high';
    } else if (priorityName.includes('high')) {
      return 'high';
    } else if (priorityName.includes('low') || priorityName.includes('lowest')) {
      return 'low';
    }

    return 'medium';
  }

  async generateFallbackStrategy(
    ticket: JiraIssue | AnalyzableTicket,
    options?: AnalyzeOptions
  ): Promise<TestStrategy> {
    logger.info('Generating fallback test strategy');

    const summary = ticket.fields.summary || 'el feature del ticket';
    const description = extractTextFromDescription(ticket.fields.description);
    const comments = extractCommentsText(ticket);
    const ticketText = mergeTicketText(description, comments);
    const surface = detectTestSurface({
      summary: ticket.fields.summary,
      description: ticketText,
      labels: ticket.fields.labels,
      issuetype: ticket.fields.issuetype?.name,
    });
    const coverage = options?.coverage || 'all';
    const scenarios = fallbackScenarios(summary, coverage, surface);

    return this.normalizeStrategy(
      {
        testType: surface === 'api' ? 'api' : surface === 'mixed' ? 'mixed' : 'ui',
        summary: `Estrategia de respaldo para ${ticket.key} (${coverage}/${surface}): validar "${summary}"`,
        estimatedDuration: Math.max(20, scenarios.length * 10),
        priority: this.determinePriority(ticket),
        scenarios,
      },
      ticket,
      coverage,
      surface
    );
  }
}

/** Extract acceptance criteria from ticket description (bullets or prose CA blocks). */
export function extractAcceptanceCriteria(description: string): string[] {
  const criteria: string[] = [];

  const markers = [
    /criterios?\s+de\s+aceptaci[oó]n[:\s]*/i,
    /acceptance criteria[:\s]*/i,
    /criterios?\s+de\s+aceptaci[oó]n\s*\(AC\)[:\s]*/i,
    /AC[:\s]*/i,
    /given.*when.*then/gi,
    /dado.*cuando.*entonces/gi,
    /requirements[:\s]*/i,
    /requisitos[:\s]*/i,
    /condiciones?\s+de\s+aceptaci[oó]n[:\s]*/i,
    /definition of done[:\s]*/i,
    /definici[oó]n\s+de\s+terminado[:\s]*/i,
  ];

  for (const marker of markers) {
    const match = description.match(marker);
    if (match) {
      const startIndex = match.index! + match[0].length;
      const remainingText = description.substring(startIndex);
      const section = remainingText.split(
        /\n(?=\s*(Referencia|Adjuntos|Notas|Contexto|Pedido)\b)/i
      )[0];

      const lines = section.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.match(/^[-*•]\s/) ||
          trimmed.match(/^\d+\.\s/) ||
          trimmed.match(/^given|when|then/i) ||
          trimmed.match(/^dado|cuando|entonces/i) ||
          trimmed.match(/^\[?AC\d*\]?/i)
        ) {
          criteria.push(
            trimmed
              .replace(/^[-*•\d.]\s*/, '')
              .replace(/^\[?AC\d*\]?\s*/i, '')
          );
        } else if (criteria.length > 0 && trimmed === '') {
          break;
        } else if (
          criteria.length > 0 &&
          trimmed &&
          !trimmed.match(/^[-*•\d]/) &&
          trimmed.length < 12
        ) {
          break;
        }
      }

      if (criteria.length > 0) {
        return criteria;
      }

      const prose = extractProseAcceptanceCriteria(section);
      if (prose.length > 0) return prose;
    }
  }

  // Fallback: bullet lines that look like AC anywhere in the description
  const bullets = description
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^([-*•]|\d+\.)\s+.{12,}/.test(l))
    .map((l) => l.replace(/^[-*•\d.]\s*/, ''));
  if (bullets.length >= 2 && bullets.length <= 12) {
    return bullets;
  }

  return criteria;
}

function extractProseAcceptanceCriteria(section: string): string[] {
  const cleaned = section.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 40) return [];

  const parts = cleaned
    .split(/(?<=\.)\s+(?=(?:Debe|El endpoint|La OC|Validar|Documentar|[A-ZÁÉÍÓÚ]))/)
    .map((p) => p.trim())
    .filter((p) => p.length > 35);

  if (parts.length >= 2) return parts.slice(0, 15);

  // Single blob — still useful as one AC if long enough
  return cleaned.length > 80 ? [cleaned.slice(0, 500)] : [];
}

/**
 * Distinct success modes named in CA / description (quoted options, "debe soportar el caso …").
 * Generic across BE tickets — not domain-specific.
 */
export function extractDistinctSuccessModes(
  criteria: string[],
  description = ''
): string[] {
  const blob = [...criteria, description].join('\n');
  const found: string[] = [];

  const add = (raw: string) => {
    const t = raw.trim().replace(/^[\s«"']+|[\s»"']+$/g, '');
    if (t.length < 8 || t.length > 120) return;
    const lower = t.toLowerCase();
    if (/^(ver|ver\s+agdcf|referencia|adjuntos|http)/i.test(t)) return;
    if (found.some((f) => f.toLowerCase() === lower)) return;
    if (
      found.some(
        (f) =>
          f.toLowerCase().includes(lower) || lower.includes(f.toLowerCase())
      )
    ) {
      return;
    }
    found.push(t);
  };

  for (const m of blob.matchAll(
    /debe soportar(?:\s+el)?\s+caso\s+[«"']?([^«"'.\n]+)[»"']?/gi
  )) {
    add(m[1]);
  }

  for (const m of blob.matchAll(
    /(?:opci[oó]n|checkbox|modo|escenario)\s+[«"']([^«"'\n]{6,100})[»"']/gi
  )) {
    add(m[1]);
  }

  // Quoted labels that look like product options (not random UI chrome).
  for (const m of blob.matchAll(/[«"']([^«"'\n]{8,100})[»"']/g)) {
    const q = m[1];
    const ctx = blob.slice(Math.max(0, (m.index || 0) - 40), (m.index || 0) + q.length + 40);
    if (
      /soportar|caso|opci[oó]n|checkbox|modo|escenario|liquidar|distribuir|equitativ/i.test(
        ctx
      )
    ) {
      add(q);
    }
  }

  return found.slice(0, 8);
}

/**
 * Generic BE checklist mined from CA/description (validations, entities, cardinality, etc.).
 */
export function extractBeChecklist(input: {
  summary?: string | null;
  description?: string | null;
  acceptanceCriteria?: string[];
}): {
  siblings: string[];
  endpointHints: string[];
  resultStates: string[];
  validations: string[];
  entities: string[];
  cardinality: string[];
  calculations: string[];
  payloadDocs: string[];
  persistence: string[];
} {
  const ac = input.acceptanceCriteria || [];
  const blob = `${input.summary || ''}\n${input.description || ''}\n${ac.join('\n')}`;
  const siblings: string[] = [];
  const endpointHints: string[] = [];
  const resultStates: string[] = [];
  const validations: string[] = [];
  const entities: string[] = [];
  const cardinality: string[] = [];
  const calculations: string[] = [];
  const payloadDocs: string[] = [];
  const persistence: string[] = [];

  const pushUnique = (arr: string[], raw: string, max = 160) => {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t.length < 12 || t.length > max) return;
    if (arr.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    arr.push(t);
  };

  for (const m of blob.matchAll(
    /(?:a diferencia de|a diferencia del|ver|versus|vs\.?|comparar con|hermano)\s+(AGDCF-\d+|ADGCF-\d+|[A-Z][A-Z0-9]+-\d+)/gi
  )) {
    pushUnique(siblings, `Contraste / referencia: ${m[1].toUpperCase()}`);
  }
  for (const m of blob.matchAll(/\b([A-Z]{2,10}-\d+)\b/g)) {
    // only keep if nearby "provisoria|pendiente|diferencia|ver "
    const idx = m.index || 0;
    const ctx = blob.slice(Math.max(0, idx - 50), idx + 20);
    if (/provisoria|pendiente|diferencia|a diferencia|ver\s/i.test(ctx)) {
      pushUnique(siblings, `Contraste / referencia: ${m[1]}`);
    }
  }

  if (/\b(endpoint|api|POST|PUT|PATCH|GET|DELETE)\b/i.test(blob)) {
    const method = blob.match(/\b(POST|PUT|PATCH|GET|DELETE)\b/i)?.[1]?.toUpperCase();
    pushUnique(
      endpointHints,
      method
        ? `Estructura del endpoint: ${method} (o el método que defina el ticket) y respuesta de éxito (200/201) con el recurso creado/actualizado`
        : 'Estructura del endpoint: método HTTP + path del ticket; respuesta de éxito (200/201) con el recurso creado/actualizado'
    );
  }

  for (const c of ac) {
    if (
      /\bestado\b|pendiente|confirmad|borrador|\bstatus\b/i.test(c) &&
      !/distribuci[oó]n completa/i.test(c)
    ) {
      pushUnique(resultStates, c);
    }
    if (
      /debe validar|rechaz|inconsist|no permitir|debe fallar|4\d\d|error de validaci/i.test(
        c
      )
    ) {
      pushUnique(validations, c);
    }
    if (
      /entidad|crearse si no existe|si a[uú]n no existe|crear(?:se)?.*si no|dep[oó]sito general|como un\w* m[aá]s/i.test(
        c
      )
    ) {
      pushUnique(entities, c);
    }
    if (
      /1\s*\w+\s*\/\s*1|m[uú]ltiple|varios|distintos escenarios|con y sin|N\s*[x×]\s*N|uno y muchos/i.test(
        c
      )
    ) {
      pushUnique(cardinality, c);
    }
    if (/margen|calcular|c[aá]lculo|persistirse junto/i.test(c)) {
      pushUnique(calculations, c);
    }
    if (/payload|estructura de datos|documentar/i.test(c)) {
      pushUnique(payloadDocs, c);
    }
    if (/persistir|persista|guardar en (la )?base|registrar en/i.test(c)) {
      pushUnique(persistence, c);
    }
  }

  // Description-level fallbacks when AC prose split missed nuances
  if (!resultStates.length && /estado distinto|no.*pendiente|queda en.*completa|confirmad/i.test(blob)) {
    pushUnique(
      resultStates,
      'La OC/recurso creado debe quedar en estado distinto de "Pendiente" (ej. Completa/Confirmada)'
    );
  }
  if (
    !validations.length &&
    /debe validar|cantidad restante|suma de las cantidades|todos los .* tengan/i.test(blob)
  ) {
    for (const m of blob.matchAll(
      /((?:Debe validar|debe validar)[^.]+(?:\.|$))/gi
    )) {
      pushUnique(validations, m[1]);
    }
  }
  if (
    !entities.length &&
    /crearse si no existe|si a[uú]n no existe|entidad\s+[«"']/i.test(blob)
  ) {
    for (const m of blob.matchAll(
      /((?:Debe existir|debe existir|crearse si no existe)[^.]+(?:\.|$))/gi
    )) {
      pushUnique(entities, m[1]);
    }
  }
  if (
    !cardinality.length &&
    /1\s*insumo\s*\/\s*1|m[uú]ltiples?\s+insumos|con y sin/i.test(blob)
  ) {
    pushUnique(
      cardinality,
      'Cubrir cardinalidad: 1/1, múltiples×múltiples, con y sin destinos especiales del CA'
    );
  }
  if (!calculations.length && /margen\s*total/i.test(blob)) {
    pushUnique(
      calculations,
      'Validar cálculo y persistencia del Margen Total (u otros totales del CA)'
    );
  }
  if (
    !payloadDocs.length &&
    /documentar.*(?:payload|estructura)|estructura de datos\s*\(payload\)/i.test(blob)
  ) {
    pushUnique(
      payloadDocs,
      'Documentar/verificar la estructura de datos (payload) esperada por el endpoint'
    );
  }

  return {
    siblings: siblings.slice(0, 4),
    endpointHints: endpointHints.slice(0, 3),
    resultStates: resultStates.slice(0, 4),
    validations: validations.slice(0, 6),
    entities: entities.slice(0, 4),
    cardinality: cardinality.slice(0, 3),
    calculations: calculations.slice(0, 3),
    payloadDocs: payloadDocs.slice(0, 2),
    persistence: persistence.slice(0, 5),
  };
}

function formatBeChecklistForPrompt(
  checklist: ReturnType<typeof extractBeChecklist>
): string {
  const parts: string[] = [];
  const add = (label: string, items: string[]) => {
    if (!items.length) return;
    parts.push(`${label}:`);
    for (const i of items) parts.push(`- ${i}`);
  };
  add('Siblings', checklist.siblings);
  add('Endpoint', checklist.endpointHints);
  add('Result states', checklist.resultStates);
  add('Persistence', checklist.persistence);
  add('Validations', checklist.validations);
  add('Entities', checklist.entities);
  add('Cardinality', checklist.cardinality);
  add('Calculations', checklist.calculations);
  add('Payload docs', checklist.payloadDocs);
  return parts.length ? parts.join('\n') : '(vacío)';
}

export function successModeCovered(
  mode: string,
  scenarios: Array<{
    description?: string;
    steps?: string[];
    expectedResults?: string[];
  }>
): boolean {
  const tokens = mode
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .filter(
      (t) => !['para', 'entre', 'como', 'debe', 'caso', 'con', 'los', 'las'].includes(t)
    );
  const needle = mode.toLowerCase().slice(0, 28);
  return scenarios.some((s) => {
    const hay =
      `${s.description || ''} ${(s.steps || []).join(' ')} ${(s.expectedResults || []).join(' ')}`.toLowerCase();
    if (hay.includes(needle)) return true;
    if (!tokens.length) return false;
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return hits >= Math.min(2, tokens.length);
  });
}

function appendChecklistSection(
  lines: string[],
  title: string,
  items: string[]
): void {
  if (!items.length) return;
  lines.push(title);
  for (const item of items) lines.push(`- ${item}`);
}

/** Structured understanding for chat “qué es / qué testear” (no LLM). */
export function buildTicketUnderstanding(input: {
  summary?: string | null;
  description?: string | null;
  comments?: string | null;
  labels?: string[] | null;
  issuetype?: string | null;
}): {
  surface: TestSurface;
  acceptanceCriteria: string[];
  successModes: string[];
  checklist: ReturnType<typeof extractBeChecklist>;
  text: string;
} {
  const summary = (input.summary || '').trim();
  const description = (input.description || '').trim();
  const comments = (input.comments || '').trim();
  const ticketText = mergeTicketText(description, comments);
  const surface = detectTestSurface({
    summary,
    description: ticketText,
    labels: input.labels,
    issuetype: input.issuetype,
  });
  const acceptanceCriteria = extractAcceptanceCriteria(ticketText);
  const successModes = extractDistinctSuccessModes(
    acceptanceCriteria,
    ticketText
  );
  const checklist = extractBeChecklist({
    summary,
    description: ticketText,
    acceptanceCriteria,
  });

  const surfaceLabel =
    surface === 'api'
      ? 'BE / API (endpoint)'
      : surface === 'mixed'
        ? 'Mixto UI + API'
        : 'UI / frontend';

  const lines: string[] = [];
  lines.push(`Superficie: ${surfaceLabel}`);
  lines.push(`Qué es: ${summary || '(sin summary)'}`);

  if (surface === 'api' || surface === 'mixed') {
    lines.push(
      'Enfoque de prueba: endpoint/payload, status HTTP y de negocio, persistencia y validaciones — no un recorrido Playwright salvo que el ticket lo pida.'
    );
  }

  if (comments) {
    lines.push(
      'Notas de comentarios (cómo testear / contrato del dev — priorizar frente a supuestos):'
    );
    for (const chunk of comments.split(/\n\n+/).slice(0, 8)) {
      const oneLine = chunk.replace(/\s+/g, ' ').trim();
      if (oneLine) lines.push(`- ${oneLine.slice(0, 280)}`);
    }
  }

  appendChecklistSection(lines, 'Contraste con tickets hermanos:', checklist.siblings);
  appendChecklistSection(lines, 'Endpoint / contrato:', checklist.endpointHints);
  appendChecklistSection(lines, 'Modos de éxito del CA:', successModes);
  appendChecklistSection(
    lines,
    'Estado / resultado de negocio:',
    checklist.resultStates
  );
  appendChecklistSection(lines, 'Persistencia:', checklist.persistence);
  appendChecklistSection(lines, 'Validaciones (unhappy):', checklist.validations);
  appendChecklistSection(
    lines,
    'Entidades (crear si no existe / destinos):',
    checklist.entities
  );
  appendChecklistSection(lines, 'Cardinalidad / matrices:', checklist.cardinality);
  appendChecklistSection(lines, 'Cálculos:', checklist.calculations);
  appendChecklistSection(lines, 'Payload / documentación:', checklist.payloadDocs);

  if (
    acceptanceCriteria.length &&
    !successModes.length &&
    !checklist.validations.length &&
    !checklist.persistence.length
  ) {
    appendChecklistSection(lines, 'Qué hay que testear (criterios):', acceptanceCriteria.slice(0, 12));
  } else if (
    !acceptanceCriteria.length &&
    !successModes.length &&
    ticketText
  ) {
    lines.push(
      'Qué hay que testear: (sin CA estructurados) inferir del summary/description/comentarios — comportamiento principal, validaciones obvias y persistencia si aplica.'
    );
  }

  return {
    surface,
    acceptanceCriteria,
    successModes,
    checklist,
    text: lines.join('\n'),
  };
}

function fallbackScenarios(
  summary: string,
  coverage: TestCoverage,
  surface: TestSurface = 'ui'
): TestScenario[] {
  if (surface === 'api' || surface === 'mixed') {
    const happy: TestScenario = {
      id: 'TC-01',
      kind: 'happy',
      description: `[Happy] Crear/confirmar el recurso de "${summary}" con payload válido y verificar persistencia. Precondición: auth QA. Datos: valores representativos entre comillas en cada paso.`,
      steps: [
        "Preparar payload válido con los campos obligatorios del ticket (valores entre comillas)",
        'Enviar POST al endpoint de creación/confirmación del ticket',
        "Verificar status HTTP '201' o '200'",
        'Verificar en el body el estado final de negocio esperado',
        'Verificar persistencia de las entidades/destinos citados en el CA',
      ],
      expectedResults: [
        'El payload está completo',
        'El request se envía al endpoint correcto',
        "Status HTTP es '201' o '200'",
        'El body refleja el estado de éxito',
        'La persistencia coincide con el CA',
      ],
      apiEndpoints: ['POST /api/recurso'],
    };
    const unhappy: TestScenario = {
      id: 'TC-02',
      kind: 'unhappy',
      description: `[Unhappy] Rechazar "${summary}" con payload inconsistente o incompleto. Se espera 4xx y que no se persista el recurso.`,
      steps: [
        "Preparar payload inválido (campo obligatorio vacío o suma inconsistente)",
        'Enviar POST al endpoint del ticket',
        "Verificar status HTTP '400' o '422'",
        'Verificar que el recurso no quedó persistido',
      ],
      expectedResults: [
        'El payload es inválido a propósito',
        'El endpoint responde error de validación',
        "Status HTTP es '400' o '422'",
        'No hay alta/confirmación del recurso',
      ],
      apiEndpoints: ['POST /api/recurso'],
    };
    const corner: TestScenario = {
      id: 'TC-03',
      kind: 'corner',
      description: `[Corner] Probar borde de "${summary}" (1 ítem/1 destino o N×N / entidad ausente que debe crearse).`,
      steps: [
        "Preparar payload de borde según el CA (valores entre comillas)",
        'Enviar POST al endpoint del ticket',
        "Verificar status HTTP '201' o el error de borde esperado",
        'Verificar la reacción de persistencia para ese borde',
      ],
      expectedResults: [
        'El payload de borde queda armado',
        'El endpoint responde de forma controlada',
        'Status HTTP coherente con el borde',
        'Persistencia o rechazo explícito según el CA',
      ],
      apiEndpoints: ['POST /api/recurso'],
    };
    if (coverage === 'happy') return [happy];
    if (coverage === 'unhappy') return [{ ...unhappy, id: 'TC-01' }];
    if (coverage === 'corner') return [{ ...corner, id: 'TC-01' }];
    return [happy, unhappy, corner];
  }

  const happy: TestScenario = {
    id: 'TC-01',
    kind: 'happy',
    description: `[Happy] Completar el flujo principal de "${summary}" con datos válidos y verificar el resultado de negocio. Precondición: usuario QA autenticado. Datos: valores representativos del dominio del ticket, escritos entre comillas en cada paso.`,
    steps: [
      'Abrir {{BASE_URL}} en la pantalla del feature',
      'Iniciar sesión con el usuario QA del proyecto si la pantalla lo requiere',
      `Ubicar el formulario o acción principal relacionada con: ${summary}`,
      "Completar el campo principal con un valor válido (reemplazar por el dato real del ticket, entre comillas)",
      "Hacer click en el botón de confirmación (usar el label real entre comillas)",
      'Esperar a que desaparezca el indicador de carga si aparece',
      'Verificar el mensaje o estado de éxito en la UI',
    ],
    expectedResults: [
      'La pantalla del feature carga sin errores visibles',
      'Los campos aceptan los valores ingresados sin validación en rojo',
      'La acción principal se completa con el estado o mensaje de éxito esperado',
      'La vista final corresponde al resultado de negocio del ticket',
    ],
    urls: ['{{BASE_URL}}'],
    selectors: ['main', 'button[type="submit"]', '[role="alert"]'],
  };

  const unhappy: TestScenario = {
    id: 'TC-02',
    kind: 'unhappy',
    description: `[Unhappy] Bloquear la acción principal de "${summary}" con un dato inválido o vacío. Precondición: misma pantalla que el happy path. Se espera un error de validación y que el negocio no se confirme.`,
    steps: [
      `Abrir {{BASE_URL}} en la pantalla del feature "${summary}"`,
      'Iniciar sesión con el usuario QA del proyecto si la pantalla lo requiere',
      "Dejar vacío un campo obligatorio o completar un campo con un valor inválido (escribir el valor entre comillas)",
      "Hacer click en el botón de confirmación (usar el label real entre comillas)",
      'Verificar el mensaje de error o el bloqueo de la acción',
    ],
    expectedResults: [
      'Se muestra un error o validación comprensible junto al campo o en un alert',
      'La acción de negocio no se confirma',
      'El usuario permanece en el formulario para corregir el dato',
    ],
    urls: ['{{BASE_URL}}'],
    selectors: ['[role="alert"]', '.error', 'button[type="submit"]'],
  };

  const corner: TestScenario = {
    id: 'TC-03',
    kind: 'corner',
    description: `[Corner] Probar un valor límite o estado previo inesperado en "${summary}" (máximo de caracteres, cantidad 0, registro ya existente o listado vacío). Precondición: el dato de borde debe poder ingresarse en la UI.`,
    steps: [
      `Abrir {{BASE_URL}} en la pantalla del feature "${summary}"`,
      'Iniciar sesión con el usuario QA del proyecto si la pantalla lo requiere',
      'Ingresar un valor de borde en el campo crítico (máximo, mínimo, caracteres especiales o estado vacío), entre comillas',
      "Hacer click en el botón de confirmación (usar el label real entre comillas)",
      'Verificar si la UI acepta, trunca, o muestra un error específico para ese borde',
    ],
    expectedResults: [
      'La UI reacciona de forma explícita al valor de borde (acepta, trunca o muestra error)',
      'No aparece un error genérico no controlado ni una pantalla en blanco',
    ],
    urls: ['{{BASE_URL}}'],
    selectors: ['main', '[role="alert"]', 'button[type="submit"]'],
  };

  if (coverage === 'happy') return [happy];
  if (coverage === 'unhappy') return [{ ...unhappy, id: 'TC-01' }];
  if (coverage === 'corner') return [{ ...corner, id: 'TC-01' }];
  return [happy, unhappy, corner];
}
