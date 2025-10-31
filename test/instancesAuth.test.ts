import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TEST_API_KEY = 'test-key';
process.env.API_KEY = TEST_API_KEY;

const routerPromise = import('../src/routes/instances.js');

async function createServer(): Promise<{ server: Server; baseUrl: string }> {
  const { default: router } = await routerPromise;
  const app = express();
  app.use('/instances', router);

  return await new Promise<{ server: Server; baseUrl: string }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address && typeof address.port === 'number') {
        resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
      } else {
        reject(new Error('failed to determine server address'));
      }
    });

    server.once('error', reject);
  });
}

test('instances events accepts apiKey query parameter', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  );

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/instances/events?apiKey=${TEST_API_KEY}`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  controller.abort();
  await response.body?.cancel().catch(() => {});
});

test('instances events accepts x-api-key header', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  );

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/instances/events`, {
    headers: { accept: 'text/event-stream', 'x-api-key': TEST_API_KEY },
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  controller.abort();
  await response.body?.cancel().catch(() => {});
});
