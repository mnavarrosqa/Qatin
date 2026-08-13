import axios from 'axios';
import { getSetting } from '../db';

export type XrayCredentials = {
  clientId: string;
  clientSecret: string;
};

const XRAY_AUTH_URL = 'https://xray.cloud.getxray.app/api/v2/authenticate';

/** Settings first, then process env. */
export function getXrayCredentials(): XrayCredentials {
  return {
    clientId: getSetting('xray_client_id') || process.env.XRAY_CLIENT_ID || '',
    clientSecret:
      getSetting('xray_client_secret') || process.env.XRAY_CLIENT_SECRET || '',
  };
}

export function assertXrayCredentials(
  creds: XrayCredentials = getXrayCredentials()
): void {
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error(
      'Xray no está configurado. Cargá Client ID y Client Secret en Configuración → Jira.'
    );
  }
}

/** Authenticates against Xray Cloud with the given or stored API keys. */
export async function testXrayConnection(
  override: Partial<XrayCredentials> = {}
): Promise<{ ok: true; latencyMs: number }> {
  const stored = getXrayCredentials();
  const creds: XrayCredentials = {
    clientId: override.clientId ?? stored.clientId,
    clientSecret: override.clientSecret ?? stored.clientSecret,
  };
  assertXrayCredentials(creds);

  const started = Date.now();
  try {
    const response = await axios.post(
      XRAY_AUTH_URL,
      {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 15_000,
      }
    );

    const token =
      typeof response.data === 'string'
        ? response.data.replace(/^"|"$/g, '')
        : '';
    if (!token || token.length < 20) {
      throw new Error('Xray no devolvió un token válido');
    }

    return { ok: true, latencyMs: Date.now() - started };
  } catch (error: any) {
    if (error?.message && !error?.response) throw error;
    const status = error?.response?.status;
    const detail =
      (typeof error?.response?.data === 'string'
        ? error.response.data
        : error?.response?.data?.error || error?.response?.data?.message) ||
      error?.message ||
      'Falló la prueba de conexión';
    throw new Error(
      status ? `Xray respondió ${status}: ${detail}` : String(detail)
    );
  }
}
