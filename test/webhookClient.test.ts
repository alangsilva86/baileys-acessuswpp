import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookClient } from '../src/services/webhook.js';
import type { AxiosInstance } from 'axios';
import type pino from 'pino';

test('WebhookClient logs only sanitized data when a request fails', async () => {
  const warnings: Array<{ obj: any; msg?: string }> = [];
  const logger: Pick<pino.Logger, 'warn'> = {
    warn: (obj: unknown, msg?: string) => {
      warnings.push({ obj, msg });
    },
  };

  const axiosError = Object.assign(new Error('Request failed with status code 401'), {
    isAxiosError: true as const,
    response: {
      status: 401,
      statusText: 'Unauthorized',
    },
    config: {
      url: 'https://hooks.example.com/webhook',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    },
    request: {
      headers: {
        'x-secret': 'value',
      },
    },
  });

  const httpClient: Pick<AxiosInstance, 'post'> = {
    async post() {
      throw axiosError;
    },
  };

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

  const sensitiveKeys = ['config', 'request', 'headers'];
  for (const key of sensitiveKeys) {
    assert.ok(!Object.prototype.hasOwnProperty.call(entry.obj.error, key));
  }
});
