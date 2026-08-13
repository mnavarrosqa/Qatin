import axios from 'axios';
import { getSetting } from '../db';

export type JiraCredentials = {
  url: string;
  email: string;
  token: string;
};

/** Settings first, then process env. */
export function getJiraCredentials(): JiraCredentials {
  return {
    url: (getSetting('jira_url') || process.env.JIRA_URL || '').replace(/\/$/, ''),
    email: getSetting('jira_email') || process.env.JIRA_EMAIL || '',
    token: getSetting('jira_api_token') || process.env.JIRA_API_TOKEN || '',
  };
}

export function jiraAuthHeader(creds: JiraCredentials = getJiraCredentials()): string {
  return `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
}

export function assertJiraCredentials(creds: JiraCredentials = getJiraCredentials()): void {
  if (!creds.url || !creds.email || !creds.token) {
    throw new Error(
      'Jira no está configurado. Cargá URL, mail y token de API en Configuración → Jira.'
    );
  }
}

/** Probes REST /myself with the given or stored credentials. */
export async function testJiraConnection(
  override: Partial<JiraCredentials> = {}
): Promise<{ ok: true; displayName: string; latencyMs: number }> {
  const stored = getJiraCredentials();
  const creds: JiraCredentials = {
    url: (override.url ?? stored.url).replace(/\/$/, ''),
    email: override.email ?? stored.email,
    token: override.token ?? stored.token,
  };
  assertJiraCredentials(creds);

  const started = Date.now();
  try {
    const response = await axios.get(`${creds.url}/rest/api/3/myself`, {
      headers: {
        Authorization: jiraAuthHeader(creds),
        Accept: 'application/json',
      },
      timeout: 15_000,
    });
    const me = response.data as { displayName?: string; emailAddress?: string };
    return {
      ok: true,
      displayName: me.displayName || me.emailAddress || creds.email,
      latencyMs: Date.now() - started,
    };
  } catch (error: any) {
    const status = error?.response?.status;
    const detail =
      error?.response?.data?.errorMessages?.[0] ||
      error?.response?.data?.message ||
      error?.message ||
      'Falló la prueba de conexión';
    throw new Error(
      status ? `Jira respondió ${status}: ${detail}` : detail
    );
  }
}
