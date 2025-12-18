import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { HttpsProxyAgentOptions } from 'https-proxy-agent';

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
const FALLBACK_BACKOFF_MS = Number(process.env.PROXY_CHECK_BACKOFF_MS || 200);

const cache = new Map<string, ProxyValidationResult>();
const inflight = new Map<string, Promise<ProxyValidationResult>>();
const metrics = {
  total: 0,
  ok: 0,
  blocked: 0,
  failed: 0,
  sumLatencyMs: 0,
  samples: 0,
  lastError: null as string | null,
};

function recordMetrics(result: ProxyValidationResult): void {
  metrics.total += 1;
  if (result.status === 'ok') metrics.ok += 1;
  if (result.status === 'blocked') metrics.blocked += 1;
  if (result.status === 'failed') metrics.failed += 1;
  if (result.latencyMs != null) {
    metrics.sumLatencyMs += result.latencyMs;
    metrics.samples += 1;
  }
  if (result.blockReason) {
    metrics.lastError = result.blockReason;
  }
}

function jitterDelay(baseMs: number): Promise<void> {
  const jitter = Math.floor(Math.random() * Math.max(1, baseMs));
  return new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
}

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

  const existing = inflight.get(proxyUrl);
  if (existing) return existing;

  const promise = (async (): Promise<ProxyValidationResult> => {
    const lastCheckAt = Date.now();
    const insecure = process.env.PROXY_INSECURE === '1';
    let agent: HttpsProxyAgent<string> | undefined;
    try {
      agent = new HttpsProxyAgent(proxyUrl);
      if (agent && insecure) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (agent as any).options.rejectUnauthorized = false;
      }
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
        // axios will respect the agent's rejectUnauthorized; keep proxy off.
        proxy: false,
      });
      const latencyMs = Date.now() - started;
      const data = resp.data || {};
      const ip =
        typeof data.ip === 'string' && data.ip.trim()
          ? data.ip.trim()
          : typeof data.query === 'string'
          ? data.query.trim()
          : null;
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
      const recorded = toCache(proxyUrl, primary);
      recordMetrics(recorded);
      return recorded;
    } catch (err: any) {
      // Map common proxy errors to clearer reasons
      const status = err?.response?.status;
      const errMsg = err?.message || '';
      if (status === 407) {
        const recorded = toCache(proxyUrl, {
          status: 'failed',
          ip: null,
          isp: null,
          asn: null,
          latencyMs: null,
          blockReason: 'proxy_auth_required_407',
          lastCheckAt,
        });
        recordMetrics(recorded);
        return recorded;
      }
      await jitterDelay(FALLBACK_BACKOFF_MS);
      try {
        const fallback = await runCheck(FALLBACK_CHECK_URL);
        const recorded = toCache(proxyUrl, fallback);
        recordMetrics(recorded);
        return recorded;
      } catch (fallbackErr: any) {
        const fbStatus = fallbackErr?.response?.status;
        const fbMsg = fallbackErr?.message || '';
        const reason =
          fbStatus === 407
            ? 'proxy_auth_required_407'
            : `proxy_check_failed: ${fbMsg || errMsg || 'request failed'}`;
        const recorded = toCache(proxyUrl, {
          status: 'failed',
          ip: null,
          isp: null,
          asn: null,
          latencyMs: null,
          blockReason: reason,
          lastCheckAt,
        });
        recordMetrics(recorded);
        return recorded;
      }
    }
  })();

  inflight.set(proxyUrl, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(proxyUrl);
  }
}

export function getProxyValidationMetrics(): {
  total: number;
  ok: number;
  blocked: number;
  failed: number;
  avgLatencyMs: number | null;
  lastError: string | null;
} {
  const avgLatencyMs = metrics.samples ? Math.round(metrics.sumLatencyMs / metrics.samples) : null;
  return {
    total: metrics.total,
    ok: metrics.ok,
    blocked: metrics.blocked,
    failed: metrics.failed,
    avgLatencyMs,
    lastError: metrics.lastError,
  };
}

export function resetProxyValidationState(): void {
  cache.clear();
  inflight.clear();
  metrics.total = 0;
  metrics.ok = 0;
  metrics.blocked = 0;
  metrics.failed = 0;
  metrics.sumLatencyMs = 0;
  metrics.samples = 0;
  metrics.lastError = null;
}
