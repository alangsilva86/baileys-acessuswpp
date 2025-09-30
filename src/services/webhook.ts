import axios, { AxiosInstance } from 'axios';
import pino from 'pino';

type WebhookEventPayload<T> = {
  event: string;
  instanceId?: string;
  timestamp: string;
  payload: T;
};

export interface WebhookClientOptions {
  url?: string | null;
  apiKey?: string | null;
  logger?: pino.Logger;
  instanceId?: string;
  httpClient?: AxiosInstance;
}

export class WebhookClient {
  private readonly url?: string | null;

  private readonly apiKey?: string | null;

  private readonly logger: pino.Logger;

  private readonly http: AxiosInstance;

  private readonly instanceId?: string;

  constructor(options: WebhookClientOptions = {}) {
    this.url = options.url ?? process.env.WEBHOOK_URL ?? null;
    this.apiKey = options.apiKey ?? process.env.WEBHOOK_API_KEY ?? null;
    this.logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
    this.instanceId = options.instanceId ?? undefined;
    this.http = options.httpClient ?? axios.create({ timeout: 5000 });
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    if (!this.url) {
      return;
    }

    const body: WebhookEventPayload<T> = {
      event,
      instanceId: this.instanceId ?? undefined,
      timestamp: new Date().toISOString(),
      payload,
    };

    try {
      await this.http.post(this.url, body, {
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        },
      });
    } catch (err) {
      this.logger.warn({ err, event, url: this.url }, 'webhook.emit.failed');
    }
  }
}

