import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

/**
 * Repo root whether running from `src/` (tsx) or `dist/` (node/pm2).
 * Override with APP_ROOT when the process cwd is not the install dir.
 */
const inferredRoot = path.resolve(__dirname, '..');

// Load .env before reading APP_ROOT / path overrides
dotenv.config({
  path: path.join(process.env.APP_ROOT || inferredRoot, '.env'),
});

export const APP_ROOT = process.env.APP_ROOT || inferredRoot;

export const DATA_DIR = path.join(APP_ROOT, 'data');
export const LOGS_DIR = path.join(APP_ROOT, 'logs');
export const DEFAULT_DB_PATH = path.join(DATA_DIR, 'qatin.db');
export const DEFAULT_SCREENSHOTS_DIR = path.join(APP_ROOT, 'screenshots');
export const ENV_PATH = path.join(APP_ROOT, '.env');

/** Resolve a path relative to APP_ROOT (absolute paths unchanged). */
export function resolveAppPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(APP_ROOT, p);
}

export function getScreenshotsDir(): string {
  return resolveAppPath(
    process.env.SCREENSHOTS_DIR || DEFAULT_SCREENSHOTS_DIR
  );
}

/** True when `target` is `root` or a file/dir under it (sep-safe). */
export function isPathInside(root: string, target: string): boolean {
  const absRoot = path.resolve(root);
  const abs = path.resolve(target);
  return abs === absRoot || abs.startsWith(absRoot + path.sep);
}

export function getDbPath(): string {
  return resolveAppPath(process.env.SQLITE_PATH || DEFAULT_DB_PATH);
}

export function ensureAppDirs(): void {
  for (const dir of [DATA_DIR, LOGS_DIR, getScreenshotsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
