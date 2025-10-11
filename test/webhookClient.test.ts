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

test('WebhookClient envia x-api-key padrão quando não há override', async () => {
  const requests: Array<{ headers: Record<string, string> | undefined }> = [];
  const httpClient: Pick<AxiosInstance, 'post'> = {
    async post(_url, _data, config) {
      requests.push({ headers: config?.headers as Record<string, string> | undefined });
    },
  };

  const client = new WebhookClient({
    url: 'https://hooks.example.com/webhook',
    httpClient,
  });

  await client.emit('test.event', { foo: 'bar' });

  assert.equal(requests.length, 1, 'expected one request to be sent');
  const [{ headers }] = requests;
  assert.ok(headers, 'expected headers to be defined');
  assert.equal(
    headers?.['x-api-key'],
    '57c1acd47dc2524ab06dc4640443d755072565ebed06e1a7cc6d27ab4986e0ce',
    'should send default API key when none is provided',
  );
});
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
