#!/usr/bin/env node
/**
 * Primera instalación interactiva de Qatin.
 * Ofrece dependencias (Playwright, MCP, web) y plugins con explicación.
 *
 * Uso:
 *   npm run setup
 *   npm run setup -- --yes     # acepta defaults sin preguntar
 *   npm run setup -- --force   # vuelve a ofrecer aunque ya se haya corrido
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MARKER = path.join(ROOT, 'data', '.setup-complete');
const args = new Set(process.argv.slice(2));
const YES = args.has('--yes') || args.has('-y');
const FORCE = args.has('--force');
const CI = Boolean(process.env.CI);

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(msg = '') {
  console.log(msg);
}

function heading(title) {
  log(`\n${c.bold}${c.cyan}── ${title}${c.reset}`);
}

function info(msg) {
  log(`${c.dim}${msg}${c.reset}`);
}

function ok(msg) {
  log(`${c.green}✓${c.reset} ${msg}`);
}

function warn(msg) {
  log(`${c.yellow}!${c.reset} ${msg}`);
}

function fail(msg) {
  log(`${c.red}✗${c.reset} ${msg}`);
}

function run(command, opts = {}) {
  const result = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    env: process.env,
    ...opts,
  });
  return result.status === 0;
}

function ask(rl, question, defaultYes = true) {
  if (YES) return Promise.resolve(defaultYes);
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`${question} [${hint}] `, (answer) => {
      const a = String(answer || '').trim().toLowerCase();
      if (!a) {
        resolve(defaultYes);
        return;
      }
      resolve(a === 'y' || a === 'yes' || a === 's' || a === 'si' || a === 'sí');
    });
  });
}

function ensureEnvExample() {
  const envPath = path.join(ROOT, '.env');
  const example = path.join(ROOT, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    ok('Creé .env desde .env.example (completalo después en la UI o a mano)');
    return true;
  }
  return false;
}

function playwrightInstalled() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const { chromium } = require('playwright');
    const execPath = chromium.executablePath();
    return Boolean(execPath && fs.existsSync(execPath));
  } catch {
    return false;
  }
}

function savePlugins(state) {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const Database = require('better-sqlite3');
  const dbPath =
    process.env.SQLITE_PATH || path.join(ROOT, 'data', 'qatin.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run('plugins', JSON.stringify(state));
  db.close();
}

function saveSkills(state) {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const Database = require('better-sqlite3');
  const dbPath =
    process.env.SQLITE_PATH || path.join(ROOT, 'data', 'qatin.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run('skills', JSON.stringify(state));
  db.close();
}

function markComplete(summary) {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(
    MARKER,
    JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2)
  );
}

async function main() {
  if (CI && !FORCE) {
    info('CI detectado: salteo setup interactivo (usá npm run setup -- --force si hace falta).');
    return;
  }

  if (fs.existsSync(MARKER) && !FORCE && !YES) {
    log(`\n${c.bold}Qatin ya tiene un setup previo.${c.reset}`);
    info(`Marcador: ${path.relative(ROOT, MARKER)}`);
    info('Para repetirlo: npm run setup -- --force');
    return;
  }

  if (!process.stdin.isTTY && !YES) {
    warn('No hay TTY interactivo.');
    info('Corré en una terminal: npm run setup');
    info('O sin preguntas: npm run setup -- --yes');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    log(`\n${c.bold}Bienvenido a Qatin — setup inicial${c.reset}`);
    info(
      'Vamos a instalar lo necesario para analizar tickets, correr tests en el browser'
    );
    info('y (opcional) activar plugins de runtime. Podés cambiar todo después en la UI.');

    ensureEnvExample();

    heading('1. Dependencias de Node');
    info('Instala paquetes del API, worker, UI y el servidor MCP de Jira.');
    info('Sin esto no arranca el server ni se puede buildear la interfaz.');
    if (await ask(rl, '¿Instalar / actualizar dependencias npm (root + web + mcp)?', true)) {
      const okRoot = run('npm install');
      const okWeb = run('npm install --prefix web');
      const okMcp = run('npm install --prefix mcp-server-jira');
      if (okRoot && okWeb && okMcp) ok('Dependencias npm listas');
      else fail('Alguna instalación npm falló; revisá el log de arriba');
    } else {
      warn('Saltaste npm install');
    }

    heading('2. Playwright (Chromium)');
    info('Playwright abre un browser real (Chromium) para ejecutar los tests de UI,');
    info('hacer login, navegar flujos y sacar screenshots que después se pueden');
    info('adjuntar al ticket. Sin el binario de Chromium, al testear vas a ver el');
    info('error "Executable doesn\'t exist".');
    const hasBrowser = playwrightInstalled();
    if (hasBrowser) ok('Chromium de Playwright ya está instalado');
    const wantPw = await ask(
      rl,
      hasBrowser
        ? '¿Reinstalar / verificar browsers de Playwright igual?'
        : '¿Descargar Chromium para Playwright ahora?',
      !hasBrowser
    );
    if (wantPw) {
      // --with-deps solo aplica en Linux; en macOS se ignora sin romper
      if (run('npx playwright install chromium')) {
        ok('Playwright Chromium instalado');
      } else {
        fail('No se pudo instalar Playwright. Probá: npx playwright install chromium');
      }
    } else if (!hasBrowser) {
      warn('Sin Chromium no vas a poder correr tests UI hasta instalarlo');
    }

    heading('3. Servidor MCP de Jira (opcional)');
    info('Compila el bridge MCP que permite a Qatin hablar con Jira vía herramientas');
    info('estándar (get issue, search, comments). Las credenciales se cargan después');
    info('en Configuración → Jira. Si no lo buildeás, Qatin igual puede usar la API');
    info('directa de Jira.');
    if (await ask(rl, '¿Buildear el servidor MCP de Jira?', true)) {
      if (run('npm run build:mcp')) ok('MCP de Jira buildeado');
      else fail('Falló el build de MCP');
    } else {
      warn('Saltaste el build de MCP');
    }

    heading('4. Build de Qatin (API + UI)');
    info('Compila TypeScript del server/worker y genera la UI estática en public/.');
    info('Hace falta para `npm start` / `npm run worker` en modo producción.');
    if (await ask(rl, '¿Buildear server + web ahora?', true)) {
      if (run('npm run build:server') && run('npm run build:web')) {
        ok('Build de Qatin listo');
      } else {
        fail('Falló el build; podés reintentar con npm run build');
      }
    } else {
      warn('Saltaste el build');
    }

    heading('5. Plugins de runtime');
    info('Los plugins cambian cómo Qatin analiza y ejecuta tests. Se guardan en SQLite');
    info('y se pueden activar/desactivar después en Configuración → Plugins.');

    log(`\n${c.bold}Engram${c.reset}`);
    info('Recuerda resultados y selectores entre ejecuciones del mismo proyecto/ticket.');
    const engram = await ask(rl, '¿Activar Engram?', true);

    log(`\n${c.bold}Self-heal${c.reset}`);
    info('Si un selector falla, prueba alternativas (otros CSS, texto, data-testid)');
    info('antes de marcar el paso como fallido.');
    const selfHeal = await ask(rl, '¿Activar Self-heal?', true);

    log(`\n${c.bold}Flaky retry${c.reset}`);
    info('Reintenta pasos que fallan con una pausa breve (default 2 reintentos extra).');
    const flakyRetry = await ask(rl, '¿Activar Flaky retry?', true);

    log(`\n${c.bold}Network guard${c.reset}`);
    info('Falla el escenario si hay respuestas HTTP 4xx/5xx durante la ejecución.');
    const networkGuard = await ask(rl, '¿Activar Network guard?', false);

    try {
      savePlugins({
        engram: { installed: engram },
        'self-heal': { installed: selfHeal },
        'flaky-retry': { installed: flakyRetry, maxRetries: 2 },
        'network-guard': { installed: networkGuard },
      });
      ok(
        `Plugins → Engram: ${engram ? 'on' : 'off'}, Self-heal: ${
          selfHeal ? 'on' : 'off'
        }, Flaky: ${flakyRetry ? 'on' : 'off'}, Network: ${
          networkGuard ? 'on' : 'off'
        }`
      );
    } catch (err) {
      fail(`No pude guardar plugins: ${err?.message || err}`);
      info('Podés activarlos después en Configuración → Plugins');
    }

    heading('6. Skills de chat');
    info('Las skills cambian qué puede hacer el agente de chat (no el worker).');
    info('Se pueden activar/desactivar en Configuración → Skills.');

    log(`\n${c.bold}Test plan reviewer${c.reset}`);
    info('Critica la estrategia antes de encolar.');
    const reviewer = await ask(rl, '¿Activar Test plan reviewer?', true);

    log(`\n${c.bold}Bug writer${c.reset}`);
    info('Redacta bugs desde runs fallidos (crear en Jira queda off por default).');
    const bugWriter = await ask(rl, '¿Activar Bug writer?', true);

    log(`\n${c.bold}Selector coach${c.reset}`);
    info('Sugiere selectores estables abriendo la URL con Playwright.');
    const selectorCoach = await ask(rl, '¿Activar Selector coach?', false);

    log(`\n${c.bold}Exploratory${c.reset}`);
    info('Explora la app y sugiere gaps de cobertura (crawl acotado).');
    const exploratory = await ask(rl, '¿Activar Exploratory?', false);

    try {
      saveSkills({
        'test-plan-reviewer': {
          installed: reviewer,
          autoBeforeEnqueue: true,
        },
        'bug-writer': { installed: bugWriter, createInJira: false },
        'selector-coach': { installed: selectorCoach },
        exploratory: { installed: exploratory, maxPages: 8 },
      });
      ok(
        `Skills → Reviewer: ${reviewer ? 'on' : 'off'}, Bug: ${
          bugWriter ? 'on' : 'off'
        }, Coach: ${selectorCoach ? 'on' : 'off'}, Explore: ${
          exploratory ? 'on' : 'off'
        }`
      );
    } catch (err) {
      fail(`No pude guardar skills: ${err?.message || err}`);
      info('Podés activarlas después en Configuración → Skills');
    }

    heading('7. Redis (cola de jobs)');
    info('Redis encola los tests para que el worker los procese en background.');
    info('Sin Redis, `npm start` puede fallar al conectar la queue.');
    const redis = spawnSync('redis-cli ping', {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
    });
    if (String(redis.stdout || '').trim() === 'PONG') {
      ok('Redis responde PONG');
    } else {
      warn('Redis no responde. En macOS: brew services start redis');
      warn('En Ubuntu: sudo systemctl start redis-server');
    }

    markComplete({
      engram,
      selfHeal,
      flakyRetry,
      networkGuard,
      reviewer,
      bugWriter,
      selectorCoach,
      exploratory,
      playwright: playwrightInstalled(),
    });

    log(`\n${c.bold}${c.green}Setup listo.${c.reset}`);
    log('Siguiente:');
    log(`  1. Completá credenciales en ${c.cyan}.env${c.reset} o en la UI → Configuración`);
    log(`     En producción seteá ${c.cyan}CREDENTIALS_SECRET${c.reset} (o usá sudo ./deploy.sh)`);
    log(`  2. ${c.cyan}npm start${c.reset}          # API + UI`);
    log(`  3. ${c.cyan}npm run worker${c.reset}     # ejecutor de tests`);
    log(`     o ${c.cyan}npm run pm2:start${c.reset}  # server + workers`);
    log(`  4. Abrí http://localhost:${process.env.PORT || 8545}`);
    log(`  Guía server: ${c.cyan}DEPLOY_INSTRUCTIONS.md${c.reset}`);
    log();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  fail(err?.message || String(err));
  process.exit(1);
});
