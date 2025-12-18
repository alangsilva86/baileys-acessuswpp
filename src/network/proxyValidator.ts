import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export type ProxyValidationStatus = 'ok' | 'blocked' | 'failed';

export interface ProxyValidationResult {
  status: ProxyValidationStatus;
  ip: string | null;
  isp: string | null;
  asn: string | null;
  latencyMs: number | null;
  blockReason: string | null;
  lastCheckAt: number;
}

const DEFAULT_CHECK_URL = process.env.PROXY_ASN_CHECK_URL || 'https://ipinfo.io/json';
const FALLBACK_CHECK_URL = process.env.PROXY_ASN_CHECK_FALLBACK || 'http://ip-api.com/json';
const DEFAULT_BLOCKLIST = String(process.env.PROXY_ASN_BLOCKLIST || 'amazon,google,digitalocean,azure,ovh,oracle')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const CACHE_TTL_MS = Number(process.env.PROXY_CACHE_MS || 5 * 60_000);

const cache = new Map<string, ProxyValidationResult>();

function fromCache(proxyUrl: string): ProxyValidationResult | null {
  const entry = cache.get(proxyUrl);
  if (!entry) return null;
  if (Date.now() - entry.lastCheckAt > CACHE_TTL_MS) {
    cache.delete(proxyUrl);
    return null;
  }
  return entry;
}

function toCache(proxyUrl: string, result: ProxyValidationResult): ProxyValidationResult {
  cache.set(proxyUrl, result);
  return result;
}

export async function validateProxyUrl(proxyUrl: string): Promise<ProxyValidationResult> {
  const cached = fromCache(proxyUrl);
  if (cached) return cached;

  const lastCheckAt = Date.now();
  let agent: HttpsProxyAgent<string> | undefined;
  try {
    agent = new HttpsProxyAgent(proxyUrl);
  } catch (err: any) {
    return toCache(proxyUrl, {
      status: 'failed',
      ip: null,
      isp: null,
      asn: null,
      latencyMs: null,
      blockReason: `proxy_invalid: ${err?.message || 'invalid url'}`,
      lastCheckAt,
    });
  }

  const runCheck = async (url: string) => {
    const started = Date.now();
    const resp = await axios.get(url, {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10_000,
    });
    const latencyMs = Date.now() - started;
    const data = resp.data || {};
    const ip = typeof data.ip === 'string' && data.ip.trim() ? data.ip.trim() : typeof data.query === 'string' ? data.query.trim() : null;
    const orgRaw = typeof data.org === 'string' ? data.org.trim() : typeof data.as === 'string' ? data.as.trim() : '';
    const asn =
      typeof data.asn === 'string'
        ? data.asn.trim()
        : orgRaw.startsWith('AS')
        ? orgRaw.split(' ')[0].trim()
        : null;
    const isp =
      typeof data.org === 'string' && data.org.trim()
        ? data.org.trim()
        : typeof data.hostname === 'string' && data.hostname.trim()
        ? data.hostname.trim()
        : typeof data.isp === 'string' && data.isp.trim()
        ? data.isp.trim()
        : typeof data.as === 'string' && data.as.trim()
        ? data.as.trim()
        : null;

    const blocklist = DEFAULT_BLOCKLIST;
    const haystack = `${orgRaw} ${asn ?? ''} ${isp ?? ''}`.toLowerCase();
    const blocked = blocklist.some((word) => word && haystack.includes(word));

    return {
      status: blocked ? 'blocked' : 'ok',
      ip,
      isp,
      asn,
      latencyMs,
      blockReason: blocked ? `proxy_blocked_datacenter (${haystack})` : null,
      lastCheckAt,
    } as ProxyValidationResult;
  };

  try {
    const primary = await runCheck(DEFAULT_CHECK_URL);
    return toCache(proxyUrl, primary);
  } catch {
    try {
      const fallback = await runCheck(FALLBACK_CHECK_URL);
      return toCache(proxyUrl, fallback);
    } catch (err: any) {
      return toCache(proxyUrl, {
        status: 'failed',
        ip: null,
        isp: null,
        asn: null,
        latencyMs: null,
        blockReason: `proxy_check_failed: ${err?.message || 'request failed'}`,
        lastCheckAt,
      });
    }
  }
}
