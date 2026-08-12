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
