#!/usr/bin/env node
/**
 * Hint post-npm-install: invita al setup interactivo en la primera vez.
 * No bloquea CI ni installs no-TTY.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, 'data', '.setup-complete');

if (process.env.CI || process.env.QATIN_SKIP_SETUP_HINT) {
  process.exit(0);
}

if (fs.existsSync(MARKER)) {
  process.exit(0);
}

const cyan = '\x1b[36m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

console.log(`
${bold}Qatin — primera instalación${reset}
${dim}Todavía no corriste el setup interactivo (Playwright, MCP, plugins).${reset}

  ${cyan}npm run setup${reset}

Explica cada dependencia/plugin y por qué se necesita. Para defaults sin preguntas:

  ${cyan}npm run setup -- --yes${reset}
`);
