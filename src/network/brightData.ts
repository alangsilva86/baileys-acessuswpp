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
  // Bright Data sessions reject some characters and very long values; keep it simple & short.
  const cleaned = value.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  if (cleaned.length <= 20) return cleaned;
  const hash = crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 10);
  return `${cleaned.slice(0, 12)}${hash}`;
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
