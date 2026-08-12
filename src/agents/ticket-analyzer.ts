import { logger } from '../utils/logger';
import { JiraIssue } from '../clients/jira-client';
import { createLlmClient, resolveLlmConfig, LlmConfig, getPromptTier, PromptTier } from '../llm';
import { getSetting } from '../db';

const DEFAULT_ANALYZER_INSTRUCTIONS_FULL = `Quality rules:
- description: what behavior is validated and why it matters.
- steps: concrete ordered actions. Use verbs the executor understands: "Navegar a", "Hacer click en", "Completar el campo", "Esperar", "Verificar que", "Seleccionar", "Hacer scroll", "Hover sobre". Include the selector or text in single quotes: "Hacer click en 'Guardar'".
- expectedResults: verifiable assertions (visible text, URL, UI state, error message, redirect). Prefer 1 assertion per key step.
- Use realistic test data (emails, IDs, amounts, dates) coherent with the ticket domain.
- Selector priority: [data-testid] > [role] with name > [name] > [id] > tag by type. Avoid fragile selectors like div:nth-child or generated CSS classes.
- URLs: use {{BASE_URL}} with realistic paths from the ticket.

Coverage (unless the ticket is trivial):
1. Happy path: complete main flow.
2. Negative case: invalid data, empty field, missing permission, cancel.
3. Edge case: boundary values, unexpected prior state, special characters.
4. If multiple acceptance criteria exist, cover each one.

Generate 4-8 scenarios. Each must be independently executable.

Ticket type focus:
- New feature: full flow + input validations + empty states.
- Bug fix: TC-01 reproduces the bug, TC-02 verifies the fix, add regression.
- UI improvement: visual change + interaction + do not break existing flows.
- Refactor: regression only — affected flows must still work.

Auth: if login is needed, first step navigates to login and enters test credentials. Use standard selectors: input[type="email"], input[type="password"], button[type="submit"]. Write "Iniciar sesión con el usuario QA del proyecto" — the executor injects configured credentials.

Do NOT:
- Generate generic "Verify page loads" cases without tying them to the ticket.
- Repeat cases with slightly different data unless justified (e.g. different roles).
- Assume magic navigation: every case starts from a concrete URL.
- Leave ambiguous steps like "Complete the form" without specifying fields and data.`;

const DEFAULT_ANALYZER_INSTRUCTIONS_COMPACT = `Rules:
- steps: use action verbs: "Navegar a", "Hacer click en", "Completar el campo", "Esperar", "Verificar que".
- expectedResults: verifiable assertions (visible text, URL, UI state, error).
- Selectors: prefer [data-testid], [role], [name], [id]. Avoid div:nth-child.
- URLs: use {{BASE_URL}} with paths from the ticket.
- Coverage: happy path + negative case + edge case. Generate 3-6 scenarios.
- Each scenario must be independently executable.
- If login is needed, first step: "Iniciar sesión con el usuario QA del proyecto".
- No generic smoke tests. Every case must trace to the ticket.`;

export function getDefaultAnalyzerInstructions(tier: PromptTier): string {
  return tier === 'compact'
    ? DEFAULT_ANALYZER_INSTRUCTIONS_COMPACT
    : DEFAULT_ANALYZER_INSTRUCTIONS_FULL;
}

export interface TestStrategy {
  testType: 'ui' | 'api' | 'manual' | 'mixed';
  scenarios: TestScenario[];
  summary: string;
  estimatedDuration: number;
  priority: 'high' | 'medium' | 'low';
}

export interface AnalyzeOptions {
  memoryContext?: string;
  signal?: AbortSignal;
  onProgress?: (tokens: number) => void;
}

export interface TestScenario {
  id: string;
  description: string;
  steps: string[];
  expectedResults: string[];
  urls?: string[];
  selectors?: string[];
  apiEndpoints?: string[];
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
      });

      const description = extractTextFromDescription(ticket.fields.description);

      const acceptanceCriteria = this.extractAcceptanceCriteria(description);
      const prompt = this.buildAnalysisPrompt(
        ticket,
        description,
        acceptanceCriteria,
        options
      );

      const client = createLlmClient(this.llmConfig);
      let tokenEst = 0;
      const response = await client.chatCompletion({
        system: this.buildSystemPrompt(),
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
      strategy = this.normalizeStrategy(strategy, ticket);
      strategy.priority = this.determinePriority(ticket);

      logger.info(
        `Generated ${strategy.scenarios.length} test scenarios for ${ticket.key}`
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

  private buildSystemPrompt(): string {
    const custom = (getSetting('agent_analyzer_instructions') || '').trim();
    const instructions = custom || getDefaultAnalyzerInstructions(this.tier);

    const header = this.tier === 'compact'
      ? `You are a QA lead. Design Playwright test cases for the given ticket.
Write description, steps, expectedResults in Spanish (argentino). JSON keys and selectors in English.
Respond with ONLY valid JSON.`
      : `You are a senior QA lead designing Playwright-automatable test cases.
Write human text (description, steps, expectedResults) in Spanish (argentino). JSON keys and CSS selectors in English.
Do NOT produce generic smoke tests. Every case must trace to the ticket's summary, description, or acceptance criteria.
Respond with ONLY valid JSON, no markdown fences.`;

    return `${header}

${instructions}`;
  }

  private buildAnalysisPrompt(
    ticket: JiraIssue | AnalyzableTicket,
    description: string,
    acceptanceCriteria: string[],
    options?: AnalyzeOptions
  ): string {
    const instructions = `
**Instructions:**
Design a UI test strategy (Playwright) specific to THIS ticket.

Each scenario must include:
1. id (TC-01, TC-02, …)
2. description: behavior-oriented, in Spanish
3. steps: actionable, in Spanish (navigate, interact, fill data)
4. expectedResults: aligned to steps, in Spanish
5. urls with {{BASE_URL}}
6. selectors: CSS/data-testid likely selectors for automation

Required:
- Trace each case to an acceptance criterion or a clear part of the description.
- Include happy path + negative + edge case when relevant.
- If ticket lacks details, assume minimum reasonable defaults and state them explicitly in the step.
- Forbidden as sole case content: "Navigate to app", "Verify page loads", "Take screenshots".`;

    const memoryBlock = options?.memoryContext
      ? `
**Prior QA memory for this project/ticket:**
${options.memoryContext}

Reuse selectors/patterns that worked before; avoid paths that failed.
`
      : '';

    const acBlock =
      acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : 'No structured criteria found. Infer them from the description and summary. Cover the main behavior + obvious risks.';

    return `
Analyze this ticket and generate quality test cases (not generic smoke):

**Ticket info:**
- Key: ${ticket.key}
- Type: ${ticket.fields.issuetype.name}
- Summary: ${ticket.fields.summary}
- Priority: ${ticket.fields.priority?.name || 'Medium'}
- Status: ${ticket.fields.status.name}

**Description:**
${description || 'No description provided. Base cases on the summary; state assumptions explicitly in steps.'}

**Acceptance criteria:**
${acBlock}

**Labels:** ${ticket.fields.labels?.join(', ') || 'None'}
${memoryBlock}
${instructions}

**Response format (JSON only, write description/steps/expectedResults in Spanish):**
{
  "testType": "ui" | "api" | "mixed",
  "summary": "What will be validated and what risks the strategy covers (in Spanish)",
  "estimatedDuration": 45,
  "scenarios": [
    {
      "id": "TC-01",
      "description": "Happy path: completar el flujo principal del ticket hasta el resultado de negocio esperado",
      "steps": [
        "Abrir {{BASE_URL}}/<ruta-del-feature>",
        "Iniciar sesión con el usuario QA del proyecto si la pantalla lo requiere",
        "Completar el campo crítico con un valor válido coherente al ticket",
        "Confirmar la acción principal",
        "Esperar la confirmación visible en UI"
      ],
      "expectedResults": [
        "La pantalla del feature muestra el estado inicial correcto",
        "El formulario acepta el dato válido sin errores",
        "Aparece el mensaje/estado de éxito descripto en el ticket",
        "La URL o vista final corresponde al resultado esperado"
      ],
      "urls": ["{{BASE_URL}}/<ruta-del-feature>"],
      "selectors": [
        "[data-testid='primary-action']",
        "button[type='submit']"
      ]
    },
    {
      "id": "TC-02",
      "description": "Negativo: rechazar dato inválido o acción no permitida según el ticket",
      "steps": [
        "Abrir {{BASE_URL}}/<ruta-del-feature>",
        "Intentar la acción con un valor inválido o sin permiso",
        "Observar la validación o bloqueo"
      ],
      "expectedResults": [
        "Se muestra el error/validación esperada",
        "No se confirma la acción de negocio"
      ],
      "urls": ["{{BASE_URL}}/<ruta-del-feature>"],
      "selectors": [".error-message", "[role='alert']"]
    }
  ]
}

Replace <ruta-del-feature>, test data, and selectors with concrete values inferred from the ticket.
`;
  }

  private normalizeStrategy(
    strategy: TestStrategy,
    ticket: JiraIssue | AnalyzableTicket
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

        return {
          ...s,
          id: (s.id && String(s.id).trim()) || `TC-${String(index + 1).padStart(2, '0')}`,
          description: s.description.trim(),
          steps,
          expectedResults,
          urls: Array.isArray(s.urls)
            ? s.urls.map((u) => String(u).trim()).filter(Boolean)
            : undefined,
          selectors: Array.isArray(s.selectors)
            ? s.selectors.map((sel) => String(sel).trim()).filter(Boolean)
            : undefined,
        };
      })
      .filter((s) => s.description && s.steps.length > 0);

    return {
      testType: strategy.testType || 'ui',
      summary:
        strategy.summary?.trim() ||
        `Estrategia de test para ${ticket.key}: ${ticket.fields.summary}`,
      estimatedDuration:
        typeof strategy.estimatedDuration === 'number' &&
        strategy.estimatedDuration > 0
          ? strategy.estimatedDuration
          : Math.max(15, cleaned.length * 8),
      priority: strategy.priority || 'medium',
      scenarios: cleaned,
    };
  }

  private extractAcceptanceCriteria(description: string): string[] {
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

        const lines = remainingText.split('\n');
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
              trimmed.replace(/^[-*•\d.]\s*/, '').replace(/^\[?AC\d*\]?\s*/i, '')
            );
          } else if (criteria.length > 0 && trimmed === '') {
            break;
          } else if (
            criteria.length > 0 &&
            trimmed &&
            !trimmed.match(/^[-*•\d]/) &&
            trimmed.length < 12
          ) {
            // probable new section heading
            break;
          }
        }

        if (criteria.length > 0) {
          break;
        }
      }
    }

    // Fallback: bullet lines that look like AC anywhere in the description
    if (criteria.length === 0) {
      const bullets = description
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^([-*•]|\d+\.)\s+.{12,}/.test(l))
        .map((l) => l.replace(/^[-*•\d.]\s*/, ''));
      if (bullets.length >= 2 && bullets.length <= 12) {
        return bullets;
      }
    }

    return criteria;
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
    _options?: AnalyzeOptions
  ): Promise<TestStrategy> {
    logger.info('Generating fallback test strategy');

    const summary = ticket.fields.summary || 'el feature del ticket';
    return {
      testType: 'ui',
      summary: `Estrategia de respaldo para ${ticket.key}: validar el flujo principal de "${summary}"`,
      estimatedDuration: 45,
      priority: this.determinePriority(ticket),
      scenarios: [
        {
          id: 'TC-01',
          description: `Happy path: completar el flujo principal de "${summary}"`,
          steps: [
            'Abrir {{BASE_URL}} e iniciar sesión con el usuario QA del proyecto si hace falta',
            `Navegar a la pantalla relacionada con: ${summary}`,
            'Ejecutar la acción principal del ticket con datos válidos',
            'Confirmar el resultado visible en la UI',
          ],
          expectedResults: [
            'La pantalla del feature carga sin errores visibles',
            'La acción principal se completa con el estado/mensaje de éxito esperado',
            'No quedan errores de validación bloqueando el flujo',
          ],
          urls: [`{{BASE_URL}}`],
          selectors: ['main', 'button[type="submit"]', '[role="alert"]'],
        },
        {
          id: 'TC-02',
          description: `Negativo: bloquear o validar un dato inválido en "${summary}"`,
          steps: [
            `Abrir la pantalla del feature "${summary}"`,
            'Intentar la acción principal con un dato vacío o inválido',
            'Observar el mensaje o bloqueo de validación',
          ],
          expectedResults: [
            'Se muestra un error/validación comprensible',
            'La acción de negocio no se confirma',
          ],
          urls: [`{{BASE_URL}}`],
          selectors: ['[role="alert"]', '.error', 'button[type="submit"]'],
        },
      ],
    };
  }
}
