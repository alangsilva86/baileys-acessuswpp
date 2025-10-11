import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';
import { WebhookClient } from '../src/services/webhook.js';

const warnings: Array<{ obj: any; msg?: string }> = [];
const logger = {
  warn: (obj: unknown, msg?: string) => {
    warnings.push({ obj, msg });
  },
} as any;

const axiosError = {
  isAxiosError: true,
  message: 'Request failed with status code 401',
  response: {
    status: 401,
    statusText: 'Unauthorized',
  },
  config: {
    url: 'https://hooks.example.com/webhook',
  },
};

const httpClient = {
  post: async () => {
    throw axiosError;
  },
} as unknown as AxiosInstance;

const client = new WebhookClient({
  url: 'https://hooks.example.com/webhook',
  logger,
  httpClient,
});

await client.emit('test.event', { foo: 'bar' });

assert.equal(warnings.length, 1, 'expected one warning log entry');

const [entry] = warnings;

assert.equal(entry.msg, 'webhook.emit.failed');
assert.deepStrictEqual(entry.obj, {
  error: {
    message: 'Request failed with status code 401',
    status: 401,
    statusText: 'Unauthorized',
    url: 'https://hooks.example.com/webhook',
  },
  event: 'test.event',
  url: 'https://hooks.example.com/webhook',
});

assert.ok(!('config' in entry.obj.error));
assert.ok(!('request' in entry.obj.error));
