import crypto from 'node:crypto';

interface BrightDataConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  country?: string;
  sessionSalt?: string;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || crypto.randomUUID().replace(/-/g, '');
}

export function createBrightDataProxyUrl(instanceId: string, config?: Partial<BrightDataConfig>): string | null {
  const host = config?.host || process.env.BRIGHTDATA_HOST;
  const portRaw = config?.port ?? Number(process.env.BRIGHTDATA_PORT);
  const port = Number.isFinite(portRaw) ? Number(portRaw) : Number(process.env.BRIGHTDATA_PORT);
  const user = config?.user || process.env.BRIGHTDATA_USER;
  const password = config?.password || process.env.BRIGHTDATA_PASSWORD;
  const country = config?.country || process.env.BRIGHTDATA_COUNTRY || 'br';
  const sessionSalt = config?.sessionSalt || process.env.BRIGHTDATA_SESSION_SALT || '';

  if (!host || !port || !user || !password) return null;

  const sessionId = sanitizeId(`${instanceId}-${sessionSalt || 'bd'}`);
  const username = `${user}-country-${country}-session-${sessionId}`;
  return `http://${username}:${password}@${host}:${port}`;
}
