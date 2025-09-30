import axios, { type AxiosInstance } from 'axios';
import pino from 'pino';
import { buildSignature } from '../utils.js';

export interface WebhookEventPayload<T> {
  event: string;
  instanceId?: string;
  timestamp: string;
  payload: T;
}

export interface WebhookClientOptions {
  url?: string | null;
  apiKey?: string | null;
  hmacSecret?: string | null;
  logger?: pino.Logger;
  instanceId?: string;
  httpClient?: AxiosInstance;
}

export class WebhookClient {
  private readonly url?: string | null;
  private readonly apiKey?: string | null;
  private readonly hmacSecret?: string | null;
  private readonly logger: pino.Logger;
  private readonly http: AxiosInstance;
  private readonly instanceId?: string;

  constructor(options: WebhookClientOptions = {}) {
    this.url = options.url ?? process.env.WEBHOOK_URL ?? null;
    this.apiKey = options.apiKey ?? process.env.WEBHOOK_API_KEY ?? null;
    this.hmacSecret = options.hmacSecret ?? process.env.WEBHOOK_HMAC_SECRET ?? null;
    this.logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
    this.instanceId = options.instanceId;
    this.http = options.httpClient ?? axios.create({ timeout: 5000 });
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    if (!this.url) return;

    const body: WebhookEventPayload<T> = {
      event,
      instanceId: this.instanceId ?? undefined,
      timestamp: new Date().toISOString(),
      payload,
    };

    try {
      const serialized = JSON.stringify(body);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      if (this.hmacSecret) {
        headers['x-signature-256'] = buildSignature(serialized, this.hmacSecret);
      }
      await this.http.post(this.url, serialized, { headers });
    } catch (err) {
      this.logger.warn({ err, event, url: this.url }, 'webhook.emit.failed');
    }
  }
}
