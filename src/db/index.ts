import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import {
  LlmProvider,
  PROVIDER_DEFAULTS,
  providerProfileKeys,
} from '../llm/types';
import { getDbPath } from '../paths';

const DB_PATH = getDbPath();

let db: Database.Database | null = null;

function getCredentialsSecret(): string | null {
  return process.env.CREDENTIALS_SECRET || null;
}

export function encryptSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const secret = getCredentialsSecret();
  if (!secret) return plain;

  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('enc:')) return stored;

  const secret = getCredentialsSecret();
  if (!secret) {
    logger.warn('Encrypted credential found but CREDENTIALS_SECRET is missing');
    return null;
  }

  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  logger.info('SQLite initialized', { path: DB_PATH });
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      staging_url TEXT,
      jira_project_key TEXT,
      jira_url TEXT,
      test_user_email TEXT,
      test_user_password TEXT,
      llm_provider TEXT,
      llm_model TEXT,
      llm_base_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      job_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('jira', 'paste')),
      ticket_id TEXT,
      pasted_summary TEXT,
      pasted_description TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      phase TEXT NOT NULL DEFAULT 'queued',
      progress_json TEXT,
      result_json TEXT,
      jira_posted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS run_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      ticket_key TEXT,
      summary TEXT NOT NULL,
      outcome TEXT,
      selectors_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS test_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      ticket_key TEXT,
      case_key TEXT NOT NULL,
      description TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      expected_results_json TEXT NOT NULL DEFAULT '[]',
      urls_json TEXT,
      selectors_json TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_test_cases_project
      ON test_cases(project_id, ticket_key);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL DEFAULT 'Nueva conversación',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_project
      ON chat_sessions(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
      content TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, id);
  `);

  ensureColumn(database, 'test_runs', 'phase', "TEXT NOT NULL DEFAULT 'queued'");
  ensureColumn(database, 'test_runs', 'progress_json', 'TEXT');
  ensureColumn(database, 'test_runs', 'jira_posted_at', 'TEXT');
  ensureColumn(database, 'test_cases', 'api_endpoints_json', 'TEXT');
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export interface ProjectRow {
  id: number;
  name: string;
  base_url: string;
  staging_url: string | null;
  jira_project_key: string | null;
  jira_url: string | null;
  test_user_email: string | null;
  test_user_password: string | null;
  llm_provider: LlmProvider | null;
  llm_model: string | null;
  llm_base_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  name: string;
  base_url?: string;
  staging_url?: string | null;
  jira_project_key?: string | null;
  jira_url?: string | null;
  test_user_email?: string | null;
  test_user_password?: string | null;
  llm_provider?: LlmProvider | null;
  llm_model?: string | null;
  llm_base_url?: string | null;
}

export interface ProjectPublic extends Omit<ProjectRow, 'test_user_password'> {
  has_password: boolean;
}

function toPublic(row: ProjectRow): ProjectPublic {
  const { test_user_password, ...rest } = row;
  return {
    ...rest,
    has_password: Boolean(test_user_password),
  };
}

export function listProjects(): ProjectPublic[] {
  const rows = getDb()
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all() as ProjectRow[];
  return rows.map(toPublic);
}

export function getProject(id: number): ProjectRow | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row || null;
}

export function getProjectPublic(id: number): ProjectPublic | null {
  const row = getProject(id);
  return row ? toPublic(row) : null;
}

export function createProject(input: ProjectInput): ProjectPublic {
  const result = getDb()
    .prepare(
      `INSERT INTO projects (
        name, base_url, staging_url, jira_project_key, jira_url,
        test_user_email, test_user_password, llm_provider, llm_model, llm_base_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.base_url || '',
      input.staging_url || null,
      input.jira_project_key || null,
      input.jira_url || null,
      input.test_user_email || null,
      encryptSecret(input.test_user_password),
      input.llm_provider || null,
      input.llm_model || null,
      input.llm_base_url || null
    );

  return getProjectPublic(Number(result.lastInsertRowid))!;
}

export function updateProject(id: number, input: Partial<ProjectInput>): ProjectPublic | null {
  const existing = getProject(id);
  if (!existing) return null;

  const password =
    input.test_user_password === undefined
      ? existing.test_user_password
      : input.test_user_password === '' || input.test_user_password === null
        ? null
        : encryptSecret(input.test_user_password);

  getDb()
    .prepare(
      `UPDATE projects SET
        name = ?,
        base_url = ?,
        staging_url = ?,
        jira_project_key = ?,
        jira_url = ?,
        test_user_email = ?,
        test_user_password = ?,
        llm_provider = ?,
        llm_model = ?,
        llm_base_url = ?,
        updated_at = datetime('now')
      WHERE id = ?`
    )
    .run(
      input.name ?? existing.name,
      input.base_url ?? existing.base_url,
      input.staging_url !== undefined ? input.staging_url : existing.staging_url,
      input.jira_project_key !== undefined
        ? input.jira_project_key
        : existing.jira_project_key,
      input.jira_url !== undefined ? input.jira_url : existing.jira_url,
      input.test_user_email !== undefined
        ? input.test_user_email
        : existing.test_user_email,
      password,
      input.llm_provider !== undefined ? input.llm_provider : existing.llm_provider,
      input.llm_model !== undefined ? input.llm_model : existing.llm_model,
      input.llm_base_url !== undefined ? input.llm_base_url : existing.llm_base_url,
      id
    );

  return getProjectPublic(id);
}

export function deleteProject(id: number): boolean {
  const result = getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getProjectCredentials(project: ProjectRow): {
  email: string | null;
  password: string | null;
} {
  return {
    email: project.test_user_email,
    password: decryptSecret(project.test_user_password),
  };
}

const SENSITIVE_SETTINGS = new Set([
  'openai_api_key',
  'deepseek_api_key',
  'anthropic_api_key',
  'llm_api_key',
  'jira_api_token',
  'xray_client_secret',
]);

export type SettingsMap = Record<string, string>;

export function getSettings(): SettingsMap {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const map: SettingsMap = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export function getPublicSettings(): SettingsMap {
  const settings = getSettings();
  const publicMap: SettingsMap = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SENSITIVE_SETTINGS.has(key)) {
      publicMap[key] = value ? '••••••••' : '';
      publicMap[`${key}_set`] = value ? 'true' : 'false';
    } else {
      publicMap[key] = value;
    }
  }
  return publicMap;
}

export function upsertSettings(updates: SettingsMap): SettingsMap {
  const stmt = getDb().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );

  const enriched: SettingsMap = { ...updates };
  const provider = updates.llm_provider;
  if (provider && PROVIDER_DEFAULTS[provider as LlmProvider]) {
    const keys = providerProfileKeys(provider as LlmProvider);
    if (updates.llm_model !== undefined) {
      enriched[keys.model] = updates.llm_model;
    }
    if (updates.llm_base_url !== undefined) {
      enriched[keys.baseUrl] = updates.llm_base_url;
    }
  }

  const tx = getDb().transaction((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) {
      if (SENSITIVE_SETTINGS.has(key) && (value === '••••••••' || value === '')) {
        continue;
      }
      stmt.run(key, value);
    }
  });

  tx(Object.entries(enriched));
  return getPublicSettings();
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export interface TestRunRow {
  id: number;
  project_id: number | null;
  job_id: string | null;
  source: 'jira' | 'paste';
  ticket_id: string | null;
  pasted_summary: string | null;
  pasted_description: string | null;
  status: string;
  phase: string;
  progress_json: string | null;
  result_json: string | null;
  jira_posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestRunInput {
  project_id?: number | null;
  job_id?: string | null;
  source: 'jira' | 'paste';
  ticket_id?: string | null;
  pasted_summary?: string | null;
  pasted_description?: string | null;
  status?: string;
}

export function createTestRun(input: TestRunInput): TestRunRow {
  const result = getDb()
    .prepare(
      `INSERT INTO test_runs (
        project_id, job_id, source, ticket_id, pasted_summary, pasted_description, status, phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.project_id ?? null,
      input.job_id ?? null,
      input.source,
      input.ticket_id ?? null,
      input.pasted_summary ?? null,
      input.pasted_description ?? null,
      input.status || 'queued',
      'queued'
    );

  return getTestRun(Number(result.lastInsertRowid))!;
}

export function getTestRun(id: number): TestRunRow | null {
  const row = getDb().prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as
    | TestRunRow
    | undefined;
  return row || null;
}

export function getTestRunByJobId(jobId: string): TestRunRow | null {
  const row = getDb()
    .prepare('SELECT * FROM test_runs WHERE job_id = ?')
    .get(jobId) as TestRunRow | undefined;
  return row || null;
}

export function updateTestRun(
  id: number,
  updates: Partial<{
    job_id: string;
    status: string;
    phase: string;
    progress_json: string | null;
    result_json: string;
    ticket_id: string;
    jira_posted_at: string | null;
  }>
): TestRunRow | null {
  const existing = getTestRun(id);
  if (!existing) return null;

  getDb()
    .prepare(
      `UPDATE test_runs SET
        job_id = ?,
        status = ?,
        phase = ?,
        progress_json = ?,
        result_json = ?,
        ticket_id = ?,
        jira_posted_at = ?,
        updated_at = datetime('now')
      WHERE id = ?`
    )
    .run(
      updates.job_id ?? existing.job_id,
      updates.status ?? existing.status,
      updates.phase ?? existing.phase,
      updates.progress_json !== undefined
        ? updates.progress_json
        : existing.progress_json,
      updates.result_json ?? existing.result_json,
      updates.ticket_id ?? existing.ticket_id,
      updates.jira_posted_at !== undefined
        ? updates.jira_posted_at
        : existing.jira_posted_at,
      id
    );

  return getTestRun(id);
}

export function listTestRuns(limit = 50, projectId?: number | null): TestRunRow[] {
  if (projectId != null) {
    return getDb()
      .prepare(
        `SELECT * FROM test_runs WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(projectId, limit) as TestRunRow[];
  }
  return getDb()
    .prepare('SELECT * FROM test_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as TestRunRow[];
}

export function deleteTestRun(id: number): boolean {
  const result = getDb().prepare('DELETE FROM test_runs WHERE id = ?').run(id);
  return result.changes > 0;
}

export interface RunMemoryRow {
  id: number;
  project_id: number | null;
  ticket_key: string | null;
  summary: string;
  outcome: string | null;
  selectors_json: string | null;
  created_at: string;
}

export interface RunMemoryInput {
  project_id?: number | null;
  ticket_key?: string | null;
  summary: string;
  outcome?: string | null;
  selectors_json?: string | null;
}

export function saveRunMemory(input: RunMemoryInput): RunMemoryRow {
  const result = getDb()
    .prepare(
      `INSERT INTO run_memory (project_id, ticket_key, summary, outcome, selectors_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.project_id ?? null,
      input.ticket_key ?? null,
      input.summary,
      input.outcome ?? null,
      input.selectors_json ?? null
    );

  return getDb()
    .prepare('SELECT * FROM run_memory WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as RunMemoryRow;
}

export function getRunMemory(opts: {
  projectId?: number | null;
  ticketKey?: string | null;
  limit?: number;
}): RunMemoryRow[] {
  const limit = opts.limit ?? 5;
  const projectId = opts.projectId ?? null;
  const ticketKey = opts.ticketKey ?? null;

  if (projectId != null && ticketKey) {
    return getDb()
      .prepare(
        `SELECT * FROM run_memory
         WHERE (project_id = ? OR ticket_key = ?)
         ORDER BY
           CASE WHEN ticket_key = ? THEN 0 ELSE 1 END,
           created_at DESC
         LIMIT ?`
      )
      .all(projectId, ticketKey, ticketKey, limit) as RunMemoryRow[];
  }

  if (projectId != null) {
    return getDb()
      .prepare(
        `SELECT * FROM run_memory WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(projectId, limit) as RunMemoryRow[];
  }

  if (ticketKey) {
    return getDb()
      .prepare(
        `SELECT * FROM run_memory WHERE ticket_key = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(ticketKey, limit) as RunMemoryRow[];
  }

  return getDb()
    .prepare(`SELECT * FROM run_memory ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as RunMemoryRow[];
}

export function formatRunMemoryContext(rows: RunMemoryRow[]): string {
  if (rows.length === 0) return '';

  return rows
    .map((row, i) => {
      const notes = row.selectors_json
        ? `\n  Notes: ${row.selectors_json}`
        : '';
      return `${i + 1}. [${row.outcome || 'unknown'}] ${row.ticket_key || 'n/a'}: ${row.summary}${notes}`;
    })
    .join('\n');
}

export interface TestCaseRow {
  id: number;
  project_id: number;
  ticket_key: string | null;
  case_key: string;
  description: string;
  steps_json: string;
  expected_results_json: string;
  urls_json: string | null;
  selectors_json: string | null;
  api_endpoints_json: string | null;
  source: 'manual' | 'ai';
  created_at: string;
  updated_at: string;
}

export interface TestCasePublic {
  id: number;
  project_id: number;
  ticket_key: string | null;
  case_key: string;
  description: string;
  steps: string[];
  expectedResults: string[];
  urls?: string[];
  selectors?: string[];
  apiEndpoints?: string[];
  source: 'manual' | 'ai';
  created_at: string;
  updated_at: string;
}

export interface TestCaseInput {
  project_id: number;
  ticket_key?: string | null;
  case_key: string;
  description: string;
  steps?: string[];
  expectedResults?: string[];
  urls?: string[];
  selectors?: string[];
  apiEndpoints?: string[];
  source?: 'manual' | 'ai';
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toTestCasePublic(row: TestCaseRow): TestCasePublic {
  const urls = parseJsonArray(row.urls_json);
  const selectors = parseJsonArray(row.selectors_json);
  const apiEndpoints = parseJsonArray(row.api_endpoints_json);
  return {
    id: row.id,
    project_id: row.project_id,
    ticket_key: row.ticket_key,
    case_key: row.case_key,
    description: row.description,
    steps: parseJsonArray(row.steps_json),
    expectedResults: parseJsonArray(row.expected_results_json),
    ...(urls.length ? { urls } : {}),
    ...(selectors.length ? { selectors } : {}),
    ...(apiEndpoints.length ? { apiEndpoints } : {}),
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTestCases(opts: {
  projectId: number;
  ticketKey?: string | null;
}): TestCasePublic[] {
  const { projectId, ticketKey } = opts;
  if (ticketKey) {
    return (
      getDb()
        .prepare(
          `SELECT * FROM test_cases
           WHERE project_id = ? AND ticket_key = ?
           ORDER BY id ASC`
        )
        .all(projectId, ticketKey) as TestCaseRow[]
    ).map(toTestCasePublic);
  }

  return (
    getDb()
      .prepare(
        `SELECT * FROM test_cases WHERE project_id = ? ORDER BY updated_at DESC, id ASC`
      )
      .all(projectId) as TestCaseRow[]
  ).map(toTestCasePublic);
}

export function getTestCase(id: number): TestCasePublic | null {
  const row = getDb().prepare('SELECT * FROM test_cases WHERE id = ?').get(id) as
    | TestCaseRow
    | undefined;
  return row ? toTestCasePublic(row) : null;
}

export function createTestCase(input: TestCaseInput): TestCasePublic {
  const result = getDb()
    .prepare(
      `INSERT INTO test_cases (
        project_id, ticket_key, case_key, description,
        steps_json, expected_results_json, urls_json, selectors_json,
        api_endpoints_json, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.project_id,
      input.ticket_key ?? null,
      input.case_key,
      input.description,
      JSON.stringify(input.steps || []),
      JSON.stringify(input.expectedResults || []),
      input.urls?.length ? JSON.stringify(input.urls) : null,
      input.selectors?.length ? JSON.stringify(input.selectors) : null,
      input.apiEndpoints?.length ? JSON.stringify(input.apiEndpoints) : null,
      input.source || 'manual'
    );

  return getTestCase(Number(result.lastInsertRowid))!;
}

export function createTestCases(inputs: TestCaseInput[]): TestCasePublic[] {
  const tx = getDb().transaction((rows: TestCaseInput[]) =>
    rows.map((row) => createTestCase(row))
  );
  return tx(inputs);
}

export function updateTestCase(
  id: number,
  input: Partial<Omit<TestCaseInput, 'project_id'>>
): TestCasePublic | null {
  const existing = getDb().prepare('SELECT * FROM test_cases WHERE id = ?').get(id) as
    | TestCaseRow
    | undefined;
  if (!existing) return null;

  getDb()
    .prepare(
      `UPDATE test_cases SET
        ticket_key = ?,
        case_key = ?,
        description = ?,
        steps_json = ?,
        expected_results_json = ?,
        urls_json = ?,
        selectors_json = ?,
        api_endpoints_json = ?,
        source = ?,
        updated_at = datetime('now')
      WHERE id = ?`
    )
    .run(
      input.ticket_key !== undefined ? input.ticket_key : existing.ticket_key,
      input.case_key ?? existing.case_key,
      input.description ?? existing.description,
      input.steps !== undefined
        ? JSON.stringify(input.steps)
        : existing.steps_json,
      input.expectedResults !== undefined
        ? JSON.stringify(input.expectedResults)
        : existing.expected_results_json,
      input.urls !== undefined
        ? input.urls.length
          ? JSON.stringify(input.urls)
          : null
        : existing.urls_json,
      input.selectors !== undefined
        ? input.selectors.length
          ? JSON.stringify(input.selectors)
          : null
        : existing.selectors_json,
      input.apiEndpoints !== undefined
        ? input.apiEndpoints.length
          ? JSON.stringify(input.apiEndpoints)
          : null
        : existing.api_endpoints_json,
      input.source ?? existing.source,
      id
    );

  return getTestCase(id);
}

export function deleteTestCase(id: number): boolean {
  const result = getDb().prepare('DELETE FROM test_cases WHERE id = ?').run(id);
  return result.changes > 0;
}

export function replaceProjectTestCases(opts: {
  projectId: number;
  ticketKey: string | null;
  cases: Array<Omit<TestCaseInput, 'project_id'>>;
}): TestCasePublic[] {
  const { projectId, ticketKey, cases } = opts;
  const tx = getDb().transaction(() => {
    if (ticketKey) {
      getDb()
        .prepare('DELETE FROM test_cases WHERE project_id = ? AND ticket_key = ?')
        .run(projectId, ticketKey);
    }
    return cases.map((c) =>
      createTestCase({
        ...c,
        project_id: projectId,
        ticket_key: c.ticket_key ?? ticketKey,
      })
    );
  });
  return tx();
}

export interface ChatSessionRow {
  id: number;
  project_id: number | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  meta_json: string | null;
  created_at: string;
}

export interface ChatMessagePublic extends Omit<ChatMessageRow, 'meta_json'> {
  meta: unknown | null;
}

function toChatMessagePublic(row: ChatMessageRow): ChatMessagePublic {
  let meta: unknown | null = null;
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json);
    } catch {
      meta = null;
    }
  }
  const { meta_json: _meta, ...rest } = row;
  return { ...rest, meta };
}

export function listChatSessions(
  limit = 50,
  projectId?: number | null
): ChatSessionRow[] {
  const db = getDb();
  if (projectId === undefined) {
    return db
      .prepare(
        `SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as ChatSessionRow[];
  }
  if (projectId === null) {
    return db
      .prepare(
        `SELECT * FROM chat_sessions WHERE project_id IS NULL
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as ChatSessionRow[];
  }
  return db
    .prepare(
      `SELECT * FROM chat_sessions WHERE project_id = ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(projectId, limit) as ChatSessionRow[];
}

export function getChatSession(id: number): ChatSessionRow | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_sessions WHERE id = ?')
    .get(id) as ChatSessionRow | undefined;
  return row || null;
}

export function createChatSession(opts?: {
  projectId?: number | null;
  title?: string;
}): ChatSessionRow {
  const result = getDb()
    .prepare(
      `INSERT INTO chat_sessions (project_id, title) VALUES (?, ?)`
    )
    .run(opts?.projectId ?? null, opts?.title || 'Nueva conversación');
  return getChatSession(Number(result.lastInsertRowid))!;
}

export function updateChatSession(
  id: number,
  updates: Partial<{ project_id: number | null; title: string }>
): ChatSessionRow | null {
  const existing = getChatSession(id);
  if (!existing) return null;

  getDb()
    .prepare(
      `UPDATE chat_sessions SET
        project_id = ?,
        title = ?,
        updated_at = datetime('now')
      WHERE id = ?`
    )
    .run(
      updates.project_id !== undefined ? updates.project_id : existing.project_id,
      updates.title ?? existing.title,
      id
    );

  return getChatSession(id);
}

export function touchChatSession(id: number): void {
  getDb()
    .prepare(
      `UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
}

export function deleteChatSession(id: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM chat_sessions WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function listChatMessages(sessionId: number): ChatMessagePublic[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC`
    )
    .all(sessionId) as ChatMessageRow[];
  return rows.map(toChatMessagePublic);
}

export function createChatMessage(input: {
  session_id: number;
  role: ChatMessageRow['role'];
  content?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  meta?: unknown;
}): ChatMessagePublic {
  const result = getDb()
    .prepare(
      `INSERT INTO chat_messages (
        session_id, role, content, tool_name, tool_call_id, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.session_id,
      input.role,
      input.content ?? null,
      input.tool_name ?? null,
      input.tool_call_id ?? null,
      input.meta !== undefined ? JSON.stringify(input.meta) : null
    );

  touchChatSession(input.session_id);

  const row = getDb()
    .prepare('SELECT * FROM chat_messages WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as ChatMessageRow;
  return toChatMessagePublic(row);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
