import axios, { type AxiosInstance } from 'axios';
import pino from 'pino';
import { buildSignature } from '../utils.js';

const DEFAULT_WEBHOOK_API_KEY = '57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce';

const RETRY_SCHEDULE_MS = [0, 1000, 3000, 10_000, 30_000, 120_000] as const;

export interface WebhookEventPayload<T> {
  event: string;
  instanceId: string;
  timestamp: number;
  payload: T;
}

type Logger = Pick<pino.Logger, 'warn'>;
type HttpClient = Pick<AxiosInstance, 'post'>;

export interface WebhookClientOptions {
  url?: string | null;
  apiKey?: string | null;
  hmacSecret?: string | null;
  logger?: Logger;
  instanceId?: string;
  httpClient?: HttpClient;
}

export class WebhookClient {
  private readonly url?: string | null;
  private readonly apiKey?: string | null;
  private readonly hmacSecret?: string | null;
  private readonly logger: Logger;
  private readonly http: HttpClient;
  private readonly instanceId?: string;

  constructor(options: WebhookClientOptions = {}) {
    this.url = options.url ?? process.env.WEBHOOK_URL ?? null;
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    } else if (process.env.WEBHOOK_API_KEY !== undefined) {
      this.apiKey = process.env.WEBHOOK_API_KEY;
    } else {
      this.apiKey = DEFAULT_WEBHOOK_API_KEY;
    }
    this.hmacSecret = options.hmacSecret ?? process.env.WEBHOOK_HMAC_SECRET ?? null;
    this.logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
    this.instanceId = options.instanceId;
    this.http = options.httpClient ?? axios.create({ timeout: 5000 });
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    if (!this.url) return;

    const instanceId = this.instanceId ?? 'unknown';
    const body: WebhookEventPayload<T> = {
      event,
      instanceId,
      timestamp: Math.floor(Date.now() / 1000),
      payload,
    };

    const serialized = JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const signatureSecret = this.hmacSecret ?? this.apiKey ?? null;
    if (signatureSecret) {
      headers['x-signature'] = buildSignature(serialized, signatureSecret);
    }

    for (let attempt = 0; attempt < RETRY_SCHEDULE_MS.length; attempt += 1) {
      if (attempt > 0) {
        await delay(RETRY_SCHEDULE_MS[attempt]);
      }

      try {
        await this.http.post(this.url, serialized, { headers });
        return;
      } catch (err) {
        const sanitizedError = this.sanitizeError(err);
        const context = {
          error: sanitizedError,
          event,
          url: this.url,
          attempt: attempt + 1,
          maxAttempts: RETRY_SCHEDULE_MS.length,
        } as const;

        const message = attempt === RETRY_SCHEDULE_MS.length - 1 ? 'webhook.emit.failed' : 'webhook.emit.retry';
        this.logger.warn(context, message);

        if (attempt === RETRY_SCHEDULE_MS.length - 1) break;
      }
    }
  }

  private sanitizeError(error: unknown): Record<string, unknown> {
    if (axios.isAxiosError(error)) {
      const { message, response, config } = error;
      const sanitized: Record<string, unknown> = {
        message,
      };

      if (response?.status !== undefined) sanitized.status = response.status;
      if (response?.statusText !== undefined) sanitized.statusText = response.statusText;
      const requestUrl = config?.url ?? this.url ?? undefined;
      if (requestUrl !== undefined) sanitized.url = requestUrl;

      const responseData = this.extractResponseData(response?.data);
      if (responseData !== undefined) {
        sanitized.responseBody = responseData;
      }

      return sanitized;
    }

    if (error instanceof Error) {
      return { message: error.message };
    }

    return { message: 'Unknown error' };
  }

  private extractResponseData(data: unknown): string | undefined {
    if (data == null) return undefined;
    if (typeof data === 'string') {
      return data.slice(0, 2048);
    }
    try {
      return JSON.stringify(data).slice(0, 2048);
    } catch (_err) {
      return undefined;
    }
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  if (process.env.WEBHOOK_RETRY_FAST === '1') return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
