/**
 * Jira client with optional MCP transport.
 * Credentials + toggle live in Settings; spawns mcp-server-jira over stdio when on.
 */

import path from 'path';
import fs from 'fs';
import { JiraClient as DirectJiraClient, JiraIssue, TestResult } from './jira-client';
import { logger } from '../utils/logger';
import {
  assertJiraCredentials,
  getJiraCredentials,
  jiraAuthHeader,
} from '../jira/credentials';

type McpClient = {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  close(): Promise<void>;
};

export function isJiraMcpEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSetting } = require('../db') as typeof import('../db');
    const fromDb = getSetting('use_mcp');
    if (fromDb != null && fromDb !== '') return fromDb === 'true';
  } catch {
    // db not ready
  }
  return process.env.USE_MCP === 'true';
}

export function resolveMcpServerPath(): string {
  if (process.env.MCP_JIRA_SERVER_PATH) {
    return path.resolve(process.env.MCP_JIRA_SERVER_PATH);
  }
  return path.resolve(process.cwd(), 'mcp-server-jira/dist/index.js');
}

function mcpChildEnv(): Record<string, string> {
  const creds = getJiraCredentials();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) env[key] = value;
  }
  env.JIRA_URL = creds.url;
  env.JIRA_EMAIL = creds.email;
  env.JIRA_API_TOKEN = creds.token;
  return env;
}

function parseToolResult(result: any): any {
  if (result?.isError) {
    const text = result.content?.[0]?.text ?? 'MCP tool error';
    throw new Error(typeof text === 'string' ? text : JSON.stringify(text));
  }

  const text = result?.content?.find((c: any) => c.type === 'text')?.text;
  if (text == null) return result;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function openMcpSession(): Promise<{
  client: McpClient;
  transport: { close(): Promise<void> };
}> {
  assertJiraCredentials();
  const serverPath = resolveMcpServerPath();
  if (!fs.existsSync(serverPath)) {
    throw new Error(
      'El servidor MCP de Jira no está buildeado. Corré npm run build:mcp en el server.'
    );
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: mcpChildEnv(),
    stderr: 'inherit',
  });

  const client = new Client({ name: 'qatin', version: '1.1.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Quick connect + listTools; used by Settings Connect. */
export async function probeJiraMcp(): Promise<string[]> {
  const { client, transport } = await openMcpSession();
  try {
    const listed = await client.listTools();
    return listed.tools.map((t) => t.name);
  } finally {
    try {
      await client.close();
      await transport.close();
    } catch {
      // ignore
    }
  }
}

export class JiraMcpClient {
  private direct = new DirectJiraClient();
  private mcp: McpClient | null = null;
  private transport: { close(): Promise<void> } | null = null;
  private initPromise: Promise<void> | null = null;
  private enabledAtInit = false;

  wasEnabled(): boolean {
    return this.enabledAtInit;
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.connectMcp();
    return this.initPromise;
  }

  private async connectMcp(): Promise<void> {
    this.enabledAtInit = isJiraMcpEnabled();
    if (!this.enabledAtInit) {
      logger.info('Jira MCP off, using direct API');
      return;
    }

    try {
      const session = await openMcpSession();
      this.transport = session.transport;
      this.mcp = session.client;
      logger.info(`MCP Jira connected via ${resolveMcpServerPath()}`);
    } catch (error) {
      logger.warn('MCP init failed, falling back to direct API:', error);
      this.mcp = null;
      this.transport = null;
    }
  }

  private async callMcp<T>(
    toolName: string,
    args: Record<string, unknown>,
    fallback: () => Promise<T>
  ): Promise<T> {
    await this.init();

    if (!this.mcp) return fallback();

    try {
      logger.debug(`MCP tool: ${toolName}`);
      const raw = await this.mcp.callTool({ name: toolName, arguments: args });
      return parseToolResult(raw) as T;
    } catch (error) {
      logger.warn(`MCP ${toolName} failed, using direct API:`, error);
      return fallback();
    }
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.callMcp('jira_get_issue', { issueKey }, () =>
      this.direct.getIssue(issueKey)
    );
  }

  async searchIssues(jql: string, maxResults = 50): Promise<any> {
    return this.callMcp('jira_search_issues', { jql, maxResults }, async () => {
      const axios = (await import('axios')).default;
      const creds = getJiraCredentials();
      assertJiraCredentials(creds);
      const { data } = await axios.post(
        `${creds.url}/rest/api/3/search/jql`,
        {
          jql,
          maxResults,
          fields: ['summary', 'status', 'issuetype', 'priority', 'updated'],
        },
        {
          headers: {
            Authorization: jiraAuthHeader(creds),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        }
      );
      return data;
    });
  }

  /** Status names in a project whose name contains `needle` (case-insensitive). */
  async listProjectStatusesContaining(
    projectKey: string,
    needle: string
  ): Promise<string[]> {
    const axios = (await import('axios')).default;
    const creds = getJiraCredentials();
    assertJiraCredentials(creds);
    const { data } = await axios.get(
      `${creds.url}/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
      {
        headers: {
          Authorization: jiraAuthHeader(creds),
          Accept: 'application/json',
        },
      }
    );

    const match = needle.toLowerCase();
    const names = new Set<string>();
    for (const issueType of Array.isArray(data) ? data : []) {
      for (const status of issueType?.statuses || []) {
        const name = String(status?.name || '');
        if (name && name.toLowerCase().includes(match)) {
          names.add(name);
        }
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  // ponytail: multi-step ADF + screenshots stay on direct client
  async postTestResults(issueKey: string, testResult: TestResult): Promise<void> {
    return this.direct.postTestResults(issueKey, testResult);
  }

  async addComment(issueKey: string, comment: unknown): Promise<void> {
    await this.callMcp('jira_add_comment', { issueKey, comment }, async () => {
      const axios = (await import('axios')).default;
      const creds = getJiraCredentials();
      await axios.post(
        `${creds.url}/rest/api/3/issue/${issueKey}/comment`,
        { body: comment },
        {
          headers: {
            Authorization: jiraAuthHeader(creds),
            'Content-Type': 'application/json',
          },
        }
      );
    });
  }

  async addLabel(issueKey: string, label: string): Promise<void> {
    return this.callMcp('jira_add_label', { issueKey, label }, () =>
      this.direct.addLabel(issueKey, label)
    );
  }

  async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
    return this.callMcp(
      'jira_transition_issue',
      { issueKey, transitionName },
      () => this.direct.transitionIssue(issueKey, transitionName)
    );
  }

  extractTextFromADF(adfContent: unknown): string {
    return this.direct.extractTextFromADF(adfContent);
  }

  isMcpAvailable(): boolean {
    return this.mcp !== null;
  }

  async close(): Promise<void> {
    try {
      await this.mcp?.close();
      await this.transport?.close();
    } catch {
      // ignore
    }
    this.mcp = null;
    this.transport = null;
    this.initPromise = null;
  }
}

let shared: JiraMcpClient | null = null;

export async function resetJiraClient(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = null;
  }
}

/** One MCP child process per worker; reconnects if Settings toggle changes. */
export async function getJiraClient(): Promise<JiraMcpClient> {
  const want = isJiraMcpEnabled();
  if (!shared || shared.wasEnabled() !== want) {
    if (shared) await shared.close();
    shared = new JiraMcpClient();
    await shared.init();
  }
  return shared;
}

export { DirectJiraClient };
