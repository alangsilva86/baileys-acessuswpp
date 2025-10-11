import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';
import type pino from 'pino';

import { WebhookClient } from '../src/services/webhook.js';
import { buildSignature } from '../src/utils.js';

const DEFAULT_API_KEY = '57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce';

process.env.WEBHOOK_RETRY_FAST = '1';

test('WebhookClient retries with sanitized logs and response body', async () => {
  const warnings: Array<{ obj: any; msg?: string }> = [];
  const logger: Pick<pino.Logger, 'warn'> = {
    warn: (obj: unknown, msg?: string) => {
      warnings.push({ obj, msg });
    },
  };

  const axiosError = Object.assign(new Error('Request failed with status code 422'), {
    isAxiosError: true as const,
    response: {
      status: 422,
      statusText: 'Unprocessable Entity',
      data: { error: 'signature mismatch' },
    },
    config: {
      url: 'https://hooks.example.com/webhook',
      headers: { Authorization: 'Bearer secret-token' },
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

  assert.equal(warnings.length, 6, 'expected 6 log entries for retries + failure');

  warnings.slice(0, 5).forEach((entry, index) => {
    assert.equal(entry.msg, 'webhook.emit.retry');
    assert.equal(entry.obj.attempt, index + 1);
    assert.equal(entry.obj.maxAttempts, 6);
    assert.deepEqual(entry.obj.error, {
      message: 'Request failed with status code 422',
      status: 422,
      statusText: 'Unprocessable Entity',
      url: 'https://hooks.example.com/webhook',
      responseBody: '{"error":"signature mismatch"}',
    });
  });

  const final = warnings[5];
  assert.equal(final.msg, 'webhook.emit.failed');
  assert.equal(final.obj.attempt, 6);
  assert.equal(final.obj.maxAttempts, 6);
  assert.deepEqual(final.obj.error, {
    message: 'Request failed with status code 422',
    status: 422,
    statusText: 'Unprocessable Entity',
    url: 'https://hooks.example.com/webhook',
    responseBody: '{"error":"signature mismatch"}',
  });
  assert.equal(final.obj.event, 'test.event');
  assert.equal(final.obj.url, 'https://hooks.example.com/webhook');
});

test('WebhookClient envia headers padronizados e assina o corpo', async () => {
  const requests: Array<{ data: any; headers: Record<string, string> | undefined }> = [];
  const httpClient: Pick<AxiosInstance, 'post'> = {
    async post(_url, data, config) {
      requests.push({ data: JSON.parse(data), headers: config?.headers as Record<string, string> | undefined });
    },
  };

  const client = new WebhookClient({
    url: 'https://hooks.example.com/webhook',
    httpClient,
  });

  await client.emit('test.event', { foo: 'bar' });

  assert.equal(requests.length, 1, 'expected one request to be sent');
  const [{ data, headers }] = requests;
  assert.ok(headers, 'expected headers to be defined');

  assert.equal(data.event, 'test.event');
  assert.equal(data.instanceId, 'unknown');
  assert.equal(typeof data.timestamp, 'number');
  assert.deepStrictEqual(data.payload, { foo: 'bar' });

  assert.equal(headers?.['content-type'], 'application/json');
  assert.equal(headers?.['x-api-key'], DEFAULT_API_KEY);
  assert.ok(headers?.['x-signature'], 'expected HMAC signature header');

  const expectedSignature = buildSignature(JSON.stringify(data), DEFAULT_API_KEY);
  assert.equal(headers?.['x-signature'], expectedSignature);
});
