/**
 * Smoke checks for ticket-key + follow-up robustness.
 * Run: npx tsx scripts/smoke-chat-robustness.ts
 */
import assert from 'assert';
import {
  extractJiraTicketKey,
  extractJiraTicketKeys,
  extractJiraTicketKeyFromUserTurns,
  extractJiraTicketKeysFromUserTurns,
  extractRequestedJiraTicketKeys,
  isJiraTicketKey,
  isTestCaseKey,
  resolveTicketKey,
} from '../src/utils/ticket-key';
import {
  buildXrayCsvPrompt,
  formatTicketList,
} from '../src/agents/qa-chat-prompts';

assert.strictEqual(isTestCaseKey('TC-01'), true);
assert.strictEqual(isTestCaseKey('TC-02'), true);
assert.strictEqual(isTestCaseKey('AGDCF-4790'), false);
assert.strictEqual(isJiraTicketKey('TC-01'), false);
assert.strictEqual(isJiraTicketKey('AGDCF-4790'), true);

assert.deepStrictEqual(
  extractJiraTicketKeys('Casos TC-01 y TC-02 para AGDCF-4790'),
  ['AGDCF-4790']
);
assert.deepStrictEqual(
  extractJiraTicketKeys('Analizá AGDCF-100 y AGDCF-200 para Xray'),
  ['AGDCF-100', 'AGDCF-200']
);
assert.deepStrictEqual(
  extractRequestedJiraTicketKeys('Xray de AGDCF-100 y AGDCF-200'),
  ['AGDCF-100', 'AGDCF-200']
);
// Long paste: command first, related keys only in body → keep requested keys.
{
  const body = Array.from({ length: 40 }, (_, i) => `See also AGDCF-${900 + i}.`).join(
    ' '
  );
  const paste = `Armá Xray de AGDCF-100\n\n${body}`;
  assert.ok(paste.length > 400);
  assert.deepStrictEqual(extractRequestedJiraTicketKeys(paste), ['AGDCF-100']);
}
assert.strictEqual(
  extractJiraTicketKey('Si ya hay casos guardados de TC-02, ejecutalos'),
  null
);
assert.strictEqual(
  extractJiraTicketKey('Ejecutá casos de AGDCF-4790 (TC-01, TC-02)'),
  'AGDCF-4790'
);
assert.strictEqual(resolveTicketKey('TC-02'), null);
assert.strictEqual(resolveTicketKey('agdcf-4790'), 'AGDCF-4790');
assert.strictEqual(
  resolveTicketKey(undefined, 'https://santex.atlassian.net/browse/AGDCF-4790'),
  'AGDCF-4790'
);

assert.strictEqual(
  extractJiraTicketKeyFromUserTurns([
    { role: 'user', content: 'Mirá AGDCF-4790' },
    {
      role: 'assistant',
      content: 'Related AGDCF-4743 also mentioned in description',
    },
    { role: 'user', content: 'generame de nuevo los casos para xray' },
  ]),
  'AGDCF-4790'
);

assert.deepStrictEqual(
  extractJiraTicketKeysFromUserTurns([
    { role: 'user', content: 'Xray de AGDCF-100 y AGDCF-200' },
    { role: 'assistant', content: '¿Qué cobertura querés?' },
    { role: 'user', content: 'todos' },
  ]),
  ['AGDCF-100', 'AGDCF-200']
);
assert.strictEqual(formatTicketList(['AGDCF-100']), 'AGDCF-100');
assert.strictEqual(
  formatTicketList(['AGDCF-100', 'AGDCF-200']),
  'AGDCF-100 y AGDCF-200'
);
assert.strictEqual(
  formatTicketList(['A-1', 'A-2', 'A-3']),
  'A-1, A-2 y A-3'
);
const multiPrompt = buildXrayCsvPrompt(
  ['AGDCF-100', 'AGDCF-200'],
  '(happy path, unhappy y corner)'
);
assert.ok(multiPrompt.includes('AGDCF-100 y AGDCF-200'));
assert.ok(/Para CADA ticket/i.test(multiPrompt));
assert.ok(/un bloque/.test(multiPrompt));
const singlePrompt = buildXrayCsvPrompt('AGDCF-4790', 'happy path');
assert.ok(singlePrompt.includes('AGDCF-4790'));
assert.ok(!/Para CADA ticket/i.test(singlePrompt));

import {
  buildXrayCsv,
  extractStepData,
  expandManualUrls,
  summaryFromDescription,
} from '../src/utils/xray-csv';
import { buildGroupedXrayManualTest } from '../src/agents/xray-case-builder';

assert.strictEqual(extractStepData("Completar el campo 'Cliente' con 'ACME SA'"), 'ACME SA');
assert.strictEqual(
  expandManualUrls('Abrir {{BASE_URL}}/ordenes', 'https://app.example.com/'),
  'Abrir https://app.example.com/ordenes'
);
assert.strictEqual(
  expandManualUrls(
    'Abrir {{BASE_URL}}/ordenes-de-compra',
    'https://colabqa.agd.com.ar/v2/login'
  ),
  'Abrir https://colabqa.agd.com.ar/v2/ordenes-de-compra'
);
assert.strictEqual(
  expandManualUrls('Abrir {{BASE_URL}}', 'https://colabqa.agd.com.ar/v2/login'),
  'Abrir https://colabqa.agd.com.ar/v2/login'
);
assert.strictEqual(
  summaryFromDescription('TC-01', '[Happy] Crear orden.', 'AGDCF-4790'),
  'AGDCF-4790 — TC-01: Crear orden.'
);
const xray = buildXrayCsv(
  [
    {
      caseKey: 'TC-01',
      description: '[Happy] Alta feliz.',
      steps: [
        "Abrir {{BASE_URL}}/ordenes",
        "Completar 'X' con '1'",
        'Guardar',
      ],
      expectedResults: ['Ok', 'Guardado', 'Listo'],
    },
  ],
  { ticketKey: 'AGDCF-4790', baseUrl: 'https://qa.agros.com' }
);
assert.strictEqual(xray.filename, 'AGDCF-4790-xray.csv');
assert.strictEqual(xray.caseCount, 1);
assert.strictEqual(xray.stepCount, 3);
assert.ok(xray.csv.startsWith('Issue Id,Summary,Description,Test Type,Step,Data,Expected Result'));
assert.strictEqual(xray.rows[0][0], '1');
assert.ok(xray.rows[0][1].startsWith('AGDCF-4790 —'));
assert.strictEqual(xray.rows[0][4], 'Abrir https://qa.agros.com/ordenes');
assert.strictEqual(xray.rows[1][0], '1');
assert.strictEqual(xray.rows[1][1], ''); // summary only on first step
assert.ok(!xray.csv.includes('{{BASE_URL}}'));

const grouped = buildGroupedXrayManualTest({
  ticketKey: 'AGDCF-4790',
  understanding:
    'Validar alta de orden de compra con distribución de insumos y liquidación.',
  ticketSummary: 'Distribución de insumos en OC',
  coverage: 'happy',
  baseUrl: 'https://colabqa.agd.com.ar/v2/login',
  scenarios: [
    {
      caseKey: 'TC-01',
      description: '[Happy] Crear orden completa.',
      steps: [
        'Abrir {{BASE_URL}}/ordenes-de-compra',
        "Completar el campo 'Cliente' con 'ACME SA'",
      ],
      expectedResults: ['Formulario visible', 'Cliente aceptado'],
    },
    {
      caseKey: 'TC-02',
      description: '[Happy] Liquidar total.',
      steps: ['Abrir {{BASE_URL}}/ordenes-de-compra', "Hacer click en 'Liquidar'"],
      expectedResults: ['Formulario visible', 'Liquidación OK'],
    },
  ],
});
assert.strictEqual(grouped.caseCount, 1);
assert.strictEqual(grouped.scenarioCount, 2);
assert.strictEqual(grouped.stepCount, 4); // only real Actions, no ▶ Inicio rows
assert.ok(grouped.rows[0][1].startsWith('AGDCF-4790 - '));
assert.ok(!grouped.rows[0][1].includes('Validar alta')); // Summary = Jira title, not understanding
assert.strictEqual(
  grouped.rows[0][1],
  'AGDCF-4790 - Distribución de insumos en OC'
);
assert.ok(grouped.rows[0][2].includes('Qué se entendió'));
assert.ok(grouped.rows[0][2].includes('TC-01'));
assert.ok(grouped.rows[0][2].includes('TC-02'));
assert.ok(grouped.rows.every((r) => r[0] === '1')); // single Xray issue
assert.strictEqual(
  grouped.rows[0][4],
  '[TC-01] Abrir https://colabqa.agd.com.ar/v2/ordenes-de-compra'
);
assert.ok(!grouped.csv.includes('▶ Inicio'));
assert.ok(grouped.csv.includes('https://colabqa.agd.com.ar/v2/ordenes-de-compra'));
assert.ok(!grouped.csv.includes('{{BASE_URL}}'));

const strippedMarkers = buildGroupedXrayManualTest({
  ticketKey: 'AGDCF-4790',
  ticketSummary: 'Distribución de insumos en OC',
  scenarios: [
    {
      caseKey: 'TC-01',
      description: '[Happy] Crear orden.',
      steps: [
        '▶ Inicio TC-01 [Happy]: Crear una orden cortada…',
        "Hacer click en 'Guardar'",
      ],
      expectedResults: ['Listo para ejecutar el escenario TC-01', 'Guardado'],
    },
  ],
});
assert.strictEqual(strippedMarkers.stepCount, 1);
assert.strictEqual(strippedMarkers.rows[0][4], "[TC-01] Hacer click en 'Guardar'");
assert.ok(!strippedMarkers.csv.includes('…'));
assert.ok(strippedMarkers.rows[0][6].trim()); // Expected Result filled

const withDefaults = buildGroupedXrayManualTest({
  ticketKey: 'AGDCF-4790',
  ticketSummary: 'Distribución de insumos en OC',
  scenarios: [
    {
      caseKey: 'TC-01',
      description: '[Happy] Crear orden.',
      steps: [
        'Abrir {{BASE_URL}}/ordenes',
        "Completar el campo 'Cliente' con 'ACME SA'",
        "Verificar que aparece el texto 'Orden creada'",
      ],
      expectedResults: ['Formulario visible'], // shorter than steps → pad rest
    },
  ],
  baseUrl: 'https://colabqa.agd.com.ar/v2/login',
});
assert.strictEqual(withDefaults.stepCount, 3);
assert.strictEqual(withDefaults.rows[0][6], 'Formulario visible');
assert.ok(withDefaults.rows[1][6].includes('ACME SA'));
assert.ok(withDefaults.rows[2][6].includes('Orden creada'));
assert.ok(withDefaults.rows.every((r) => r[6].trim()));

import { buildXrayTestSummary } from '../src/agents/xray-case-builder';
assert.strictEqual(
  buildXrayTestSummary('AGDCF-4610', {
    ticketSummary: '[FE] f12 Standalone Capa D — Regresión módulo Indicadores',
  }),
  'AGDCF-4610 - [FE] f12 Standalone Capa D — Regresión módulo Indicadores'
);
assert.strictEqual(
  buildXrayTestSummary('AGDCF-4790', {
    ticketSummary: 'AGDCF-4790 - BE - OC Insumos V2',
  }),
  'AGDCF-4790 - BE - OC Insumos V2'
);

import {
  detectTestSurface,
  extractAcceptanceCriteria,
  extractDistinctSuccessModes,
  buildTicketUnderstanding,
  looksLikeApiCase,
  successModeCovered,
} from '../src/agents/ticket-analyzer';
import { lintTestCases } from '../src/agents/test-case-lint';
import { inferTestTypeFromCases } from '../src/runs/strategy-from-cases';

assert.strictEqual(
  detectTestSurface({
    summary: 'BE - OC Insumos V2 Alta OC Completa: Endpoint Creacion OC Completa',
    description: 'Desarrollar el endpoint de backend que permita crear una Orden de Compra completa',
  }),
  'api'
);
assert.strictEqual(
  detectTestSurface({
    summary: 'FE - Modal distribución de insumos',
    description: 'Mejorar el modal y el checkbox en pantalla',
  }),
  'ui'
);

{
  const ac = extractAcceptanceCriteria(`
Pedido Desarrollar el endpoint.
CRITERIOS DE ACEPTACIÓN Debe existir (crearse si no existe) la entidad "Agroinsumos" en la base de datos. El endpoint debe persistir los Datos de Facturación y los Insumos. Debe soportar el caso "Liquidar total para Agroinsumos". Debe soportar el caso "Distribuir insumos equitativamente". Debe soportar el caso "Liquidar saldo restante para Agroinsumos". Debe validar que la suma de las cantidades distribuidas sea consistente. La OC creada debe quedar en un estado distinto al de "Pendiente".
Referencia: AGDCF-4742
Adjuntos: screenshots
`);
  assert.ok(ac.length >= 4, `expected prose AC split, got ${ac.length}: ${JSON.stringify(ac)}`);
  assert.ok(ac.some((c) => /Agroinsumos/i.test(c)));
  assert.ok(ac.some((c) => /Liquidar total/i.test(c)));
  assert.ok(ac.some((c) => /equitativamente/i.test(c)));

  const modes = extractDistinctSuccessModes(ac, '');
  assert.ok(modes.length >= 3, `expected 3 distribution modes, got ${JSON.stringify(modes)}`);
  assert.ok(modes.some((m) => /Liquidar total/i.test(m)));
  assert.ok(modes.some((m) => /equitativ/i.test(m)));
  assert.ok(modes.some((m) => /saldo restante/i.test(m)));

  assert.strictEqual(
    successModeCovered('Liquidar total para Agroinsumos', [
      {
        description: '[Happy] Liquidar total para Agroinsumos con Urea 100',
        steps: ["Preparar payload liquidando total a 'Agroinsumos'"],
      },
    ]),
    true
  );
  assert.strictEqual(
    successModeCovered('Distribuir insumos equitativamente', [
      {
        description: '[Happy] Solo saldo restante',
        steps: ['Liquidar saldo restante para Agroinsumos'],
      },
    ]),
    false
  );

  const understanding = buildTicketUnderstanding({
    summary: 'BE - Endpoint Creacion OC Completa',
    description: `A diferencia de la OC Pendiente/Provisoria (ver AGDCF-4786). Pedido Desarrollar el endpoint.
CRITERIOS DE ACEPTACIÓN Debe existir (crearse si no existe) la entidad "Agroinsumos" en la base de datos. El endpoint debe persistir los Datos de Facturación y los Insumos. Debe soportar el caso "Liquidar total para Agroinsumos". Debe soportar el caso "Distribuir insumos equitativamente". Debe soportar el caso "Liquidar saldo restante para Agroinsumos". Debe validar que la suma de las cantidades distribuidas sea consistente. Debe validar que todos los insumos de la OC tengan su distribución completa. La OC creada por este endpoint debe quedar en un estado distinto al de "Pendiente". El Margen Total debe calcularse y persistirse. Validar el correcto funcionamiento con distintos escenarios: 1 insumo/1 destino, múltiples insumos/múltiples destinos, con y sin Agroinsumos incluido. Documentar la estructura de datos (payload) esperada por el endpoint.
Referencia: AGDCF-4742`,
  });
  assert.strictEqual(understanding.surface, 'api');
  assert.ok(understanding.text.includes('BE'));
  assert.ok(understanding.successModes.length >= 2);
  assert.ok(understanding.checklist.validations.length >= 1, JSON.stringify(understanding.checklist));
  assert.ok(understanding.checklist.entities.length >= 1);
  assert.ok(understanding.checklist.cardinality.length >= 1);
  assert.ok(understanding.checklist.resultStates.length >= 1);
  assert.ok(/Validaciones/i.test(understanding.text));
  assert.ok(/Entidades/i.test(understanding.text));
  assert.ok(/4786/.test(understanding.text));
  assert.ok(/Margen Total|Cálculos/i.test(understanding.text));
  assert.ok(/payload/i.test(understanding.text));
}

{
  const lint = lintTestCases(
    [
      {
        case_key: 'TC-01',
        description:
          '[Happy] Crear OC completa liquidando total a Agroinsumos con payload válido y verificar persistencia.',
        steps: [
          "Preparar payload con insumo 'Urea' cantidad '100' y liquidar total a 'Agroinsumos'",
          'Enviar POST al endpoint de creación de OC completa',
          "Verificar status HTTP '201'",
          "Verificar en el body estado 'Completa'",
        ],
        expectedResults: [
          'Payload listo',
          'Request enviado',
          "Status '201'",
          "Estado 'Completa'",
        ],
        apiEndpoints: ['POST /api/ordenes-compra/completa'],
      },
    ],
    { testType: 'api' }
  );
  assert.strictEqual(lint.ok, true, lint.summary);
}

assert.strictEqual(
  looksLikeApiCase({
    description: 'API create',
    steps: ['Preparar payload', 'Enviar POST al endpoint', "Verificar status HTTP '201'"],
  }),
  true
);
assert.strictEqual(
  looksLikeApiCase({
    description: 'UI flow',
    steps: ["Abrir {{BASE_URL}}", "Hacer click en 'Guardar'"],
  }),
  false
);
assert.strictEqual(
  inferTestTypeFromCases([
    {
      id: 1,
      project_id: 1,
      ticket_key: 'T-1',
      case_key: 'TC-01',
      description: 'API',
      steps: ['Preparar payload', 'Enviar POST al endpoint'],
      expectedResults: ['ok'],
      apiEndpoints: ['POST /api/recurso'],
      source: 'manual',
      created_at: '',
      updated_at: '',
    },
  ] as any),
  'api'
);

import {
  classifyApiStep,
  expectedStatusFromScenario,
  parseApiEndpoint,
  payloadFromSteps,
} from '../src/agents/api-case-steps';
import { generatePlaywrightSpecs } from '../src/agents/playwright-spec-generator';
import {
  isHamburgerStep,
  selectorsMatchingQuotedLabel,
} from '../src/agents/hamburger-nav';

assert.strictEqual(classifyApiStep('Preparar payload con nombre'), 'prepare_payload');
assert.strictEqual(classifyApiStep('Enviar POST al endpoint'), 'send');
assert.strictEqual(classifyApiStep("Verificar status HTTP '201'"), 'assert_status');
assert.strictEqual(
  classifyApiStep('Autenticar con credenciales de QA'),
  'auth'
);
assert.strictEqual(
  classifyApiStep(
    "Pendiente confirmar en Network el METHOD/path del FE para el filtro 'Preseleccionados'. No inventar parámetros."
  ),
  'pending_discovery'
);
assert.deepStrictEqual(parseApiEndpoint({ apiEndpoints: ['POST /api/ordenes'] }), {
  method: 'POST',
  path: '/api/ordenes',
});
assert.deepStrictEqual(
  parseApiEndpoint(
    {
      apiEndpoints: ['GET /api/cuenta/client/acopio/{id}/campania/{id}'],
      steps: ["Enviar GET a '/api/cuenta/client/acopio/1/campania/1'"],
    },
    "Enviar GET a '/api/cuenta/client/acopio/1/campania/1'"
  ),
  { method: 'GET', path: '/api/cuenta/client/acopio/1/campania/1' }
);
assert.deepStrictEqual(
  payloadFromSteps([
    "Preparar payload válido con 'nombre'='Demo' y cantidad '50' en el modo A",
  ]),
  { nombre: 'Demo', cantidad: 50 }
);
assert.strictEqual(
  expectedStatusFromScenario({
    steps: ["Verificar status HTTP '201'"],
    expectedResults: [],
  }),
  201
);

{
  const generated = generatePlaywrightSpecs({
    strategy: {
      testType: 'api',
      summary: 'API smoke',
      estimatedDuration: 10,
      priority: 'medium',
      scenarios: [
        {
          id: 'TC-01',
          description: '[Happy] Crear recurso',
          steps: [
            "Preparar payload con 'nombre'='Demo'",
            'Enviar POST al endpoint',
            "Verificar status HTTP '201'",
          ],
          expectedResults: ['ok', 'ok', '201'],
          apiEndpoints: ['POST /api/recurso'],
        },
      ],
    },
    ticketKey: 'API-SMOKE',
    baseUrl: 'http://localhost:3000/v2/login',
    write: false,
  });
  const content = generated.files[0]?.content || '';
  assert.ok(content.includes('async ({ request })'), 'API spec uses request fixture');
  assert.ok(content.includes('request.post'), 'API spec posts');
  assert.ok(content.includes('/api/recurso'), 'API spec includes endpoint path');
  assert.ok(!content.includes('Playwright UI no aplica'), 'API no longer blocked');
}

assert.ok(isHamburgerStep('Abrir el menú hamburguesa'));
assert.ok(isHamburgerStep('Hacer click en el menú hamburguesa'));
assert.ok(!isHamburgerStep("Hacer click en 'F12'"));
assert.deepStrictEqual(
  selectorsMatchingQuotedLabel("Hacer click en 'F12'", [
    "a:has-text('F12')",
    "a:has-text('Dashboard')",
    "button:has-text('F12')",
  ]),
  ["a:has-text('F12')", "button:has-text('F12')"]
);

{
  const generated = generatePlaywrightSpecs({
    strategy: {
      testType: 'ui',
      summary: 'UI hamburger',
      estimatedDuration: 10,
      priority: 'medium',
      scenarios: [
        {
          id: 'TC-01',
          description: '[Happy] Entrar a F12 por el menú',
          steps: [
            'Navegar a {{BASE_URL}}',
            "Hacer click en 'F12'",
            "Verificar que se muestra 'Dashboard'",
          ],
          expectedResults: ['ok', 'abre F12', 'Dashboard visible'],
        },
      ],
    },
    ticketKey: 'UI-HAMBURGER',
    baseUrl: 'http://localhost:3000',
    write: false,
  });
  const content = generated.files[0]?.content || '';
  assert.ok(content.includes('clickViaNav'), 'UI spec clicks via hamburger helper');
  assert.ok(content.includes('openHamburgerMenu'), 'UI spec can open hamburger');
  assert.ok(content.includes('revealViaNav'), 'UI spec reveals via nav before assert');
}

console.log('smoke-chat-robustness: ok');
