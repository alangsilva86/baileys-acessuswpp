import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

const TEST_API_KEY = 'test-key';

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'baileys-pipedrive-test-'));

process.env.API_KEY = TEST_API_KEY;
process.env.PIPEDRIVE_DATA_DIR = tmpDir;
process.env.PIPEDRIVE_ENABLED = '1';
process.env.PIPEDRIVE_CHANNELS_MODE = 'dual';
process.env.PIPEDRIVE_FALLBACK_NOTES_ENABLED = '1';
process.env.PIPEDRIVE_FALLBACK_CREATE_PERSON = '1';
process.env.PIPEDRIVE_CLIENT_ID = 'client-id';
process.env.PIPEDRIVE_CLIENT_SECRET = 'client-secret';
process.env.PIPEDRIVE_WEBHOOK_USER = 'webhook-user';
process.env.PIPEDRIVE_WEBHOOK_PASS = 'webhook-pass';
process.env.PIPEDRIVE_WEBHOOK_EVENTS = 'deal,activity,person,organization';
process.env.PIPEDRIVE_AUTOMATION_TEMPLATE_DEAL_STAGE = '';
process.env.PIPEDRIVE_AUTOMATION_TEMPLATE_ACTIVITY = '';
process.env.PIPEDRIVE_AUTOMATION_INSTANCE_ID = '';
process.env.LOG_LEVEL = 'silent';

const routerPromise = import('../src/routes/pipedrive.js');

async function createServer(): Promise<{ server: Server; baseUrl: string }> {
  const { default: router } = await routerPromise;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/pipedrive', router);

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

test('PipedriveV2Client searchPersons inclui cursor/sort e lê next_cursor', async () => {
  const { PipedriveV2Client } = await import('../src/services/pipedrive/v2Client.js');
  const { pipedriveClient } = await import('../src/services/pipedrive/client.js');

  const calls: Array<{ url: string; headers: any }> = [];
  const httpClient = {
    async get(url: string, config: any) {
      calls.push({ url, headers: config?.headers });
      return { data: { data: [], additional_data: { pagination: { next_cursor: 'next-1' } } } };
    },
  } as any;

  const originalGetAccessToken = pipedriveClient.getAccessToken.bind(pipedriveClient);
  pipedriveClient.getAccessToken = async () =>
    ({ token: { access_token: 'token-123', api_domain: null, company_id: 1 } } as any);

  try {
    const client = new PipedriveV2Client({ httpClient });
    const result = await client.searchPersons({
      term: '+5544999999999',
      fields: 'phone',
      exactMatch: true,
      limit: 10,
      cursor: 'cur-1',
      sortBy: 'id',
      sortDirection: 'desc',
    });

    assert.equal(result.nextCursor, 'next-1');
    assert.equal(calls.length, 1);
    const [{ url, headers }] = calls;
    assert.match(url, /\/persons\/search\?/);
    assert.match(url, /term=%2B5544999999999/);
    assert.match(url, /fields=phone/);
    assert.match(url, /exact_match=true/);
    assert.match(url, /limit=10/);
    assert.match(url, /cursor=cur-1/);
    assert.match(url, /sort_by=id/);
    assert.match(url, /sort_direction=desc/);
    assert.equal(headers?.Authorization, 'Bearer token-123');
  } finally {
    pipedriveClient.getAccessToken = originalGetAccessToken;
  }
});

test('fallback Notes cria Person (v2) e Note (v1) com idempotência', async () => {
  const { createFallbackNote } = await import('../src/services/pipedrive/fallbackNotes.js');
  const { buildFallbackMessageKey, getFallbackNoteId } = await import('../src/services/pipedrive/fallbackStore.js');

  const v2Calls: any[] = [];
  const v1Calls: any[] = [];

  const v2Client = {
    async findPersonByPhone(input: any) {
      v2Calls.push({ fn: 'findPersonByPhone', input });
      return null;
    },
    async createPerson(input: any) {
      v2Calls.push({ fn: 'createPerson', input });
      return { id: 10, name: input.name, phone: [{ value: input.phone, primary: true }] };
    },
  };

  const v1Client = {
    async createNote(input: any) {
      v1Calls.push({ fn: 'createNote', input });
      return { id: 99 };
    },
  };

  const first = await createFallbackNote(
    {
      instanceId: 'inst-1',
      direction: 'inbound',
      messageId: 'msg-1',
      conversationId: '554499999999@s.whatsapp.net',
      messageText: 'Olá',
      contactPhone: '+55 44 99999-9999',
      contactName: 'João',
      createdAt: '2026-02-05T12:00:00.000Z',
    },
    { v1Client: v1Client as any, v2Client: v2Client as any },
  );

  assert.equal(first.noteId, 99);
  assert.equal(first.reused, false);
  assert.equal(first.personId, 10);
  assert.equal(v2Calls.some((c) => c.fn === 'createPerson'), true);
  assert.equal(v1Calls.length, 1);

  const key = buildFallbackMessageKey({ instanceId: 'inst-1', messageId: 'msg-1' });
  const stored = await getFallbackNoteId(key);
  assert.equal(stored, 99);

  const second = await createFallbackNote(
    {
      instanceId: 'inst-1',
      direction: 'inbound',
      messageId: 'msg-1',
      conversationId: '554499999999@s.whatsapp.net',
      messageText: 'Olá',
    },
    { v1Client: v1Client as any, v2Client: v2Client as any },
  );
  assert.equal(second.noteId, 99);
  assert.equal(second.reused, true);
  assert.equal(v1Calls.length, 1, 'expected note to be created only once');
});

test('fallback Notes ignora sufixo :device no JID ao extrair telefone', async () => {
  const { createFallbackNote } = await import('../src/services/pipedrive/fallbackNotes.js');

  const v2Calls: any[] = [];
  const v1Calls: any[] = [];

  const v2Client = {
    async findPersonByPhone(input: any) {
      v2Calls.push({ fn: 'findPersonByPhone', input });
      return null;
    },
    async createPerson(input: any) {
      v2Calls.push({ fn: 'createPerson', input });
      return { id: 11, name: input.name, phone: [{ value: input.phone, primary: true }] };
    },
  };

  const v1Client = {
    async createNote(input: any) {
      v1Calls.push({ fn: 'createNote', input });
      return { id: 100 };
    },
  };

  const note = await createFallbackNote(
    {
      instanceId: 'inst-2',
      direction: 'inbound',
      messageId: 'msg-2',
      conversationId: '554498539056:1@s.whatsapp.net',
      messageText: 'Oi',
    },
    { v1Client: v1Client as any, v2Client: v2Client as any },
  );

  assert.equal(note.noteId, 100);
  assert.equal(note.reused, false);
  assert.equal(v1Calls.length, 1);

  const createCall = v2Calls.find((c) => c.fn === 'createPerson');
  assert.ok(createCall, 'expected createPerson to be called');
  assert.equal(createCall.input.phone, '+554498539056');
});

test('admin/register-channel retorna warning com erro upstream (dual + fallback)', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  );

  const { pipedriveClient } = await import('../src/services/pipedrive/client.js');

  const originalGetAccessToken = pipedriveClient.getAccessToken.bind(pipedriveClient);
  const originalRegisterChannel = pipedriveClient.registerChannel.bind(pipedriveClient);

  pipedriveClient.getAccessToken = async () =>
    ({
      token: { access_token: 't', api_domain: null, company_id: 123 },
      apiBase: 'https://api.pipedrive.com/v1',
    } as any);

  const axiosError = Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true as const,
    response: { status: 404, data: { error: 'deprecated' } },
    config: { url: 'https://api.pipedrive.com/v1/channels' },
  });

  pipedriveClient.registerChannel = async () => {
    throw axiosError;
  };

  try {
    const response = await fetch(`${baseUrl}/pipedrive/admin/register-channel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': TEST_API_KEY,
      },
      body: JSON.stringify({ providerChannelId: 'inst-err', name: 'Test' }),
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.success, true);
    assert.ok(json.warning, 'expected warning in response');
    assert.equal(json.warning.message, 'channels_register_failed_using_fallback_notes');
    assert.equal(json.warning.upstream.status, 404);
    assert.match(json.warning.upstream.responseBody, /deprecated/);
  } finally {
    pipedriveClient.getAccessToken = originalGetAccessToken;
    pipedriveClient.registerChannel = originalRegisterChannel;
  }
});

test('admin/unregister-channel remove canal e tenta delete remoto quando possível', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  );

  const { upsertChannel } = await import('../src/services/pipedrive/store.js');
  await upsertChannel({
    id: '111',
    provider_channel_id: 'inst-unreg',
    name: 'Test',
    provider_type: 'whatsapp',
    template_support: false,
    avatar_url: null,
    company_id: 123,
    api_domain: null,
  } as any);

  const { pipedriveClient } = await import('../src/services/pipedrive/client.js');
  const originalDeleteChannel = pipedriveClient.deleteChannel.bind(pipedriveClient);
  const deleted: string[] = [];
  pipedriveClient.deleteChannel = async (channel: any) => {
    deleted.push(String(channel?.id ?? ''));
  };

  try {
    const response = await fetch(`${baseUrl}/pipedrive/admin/unregister-channel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': TEST_API_KEY,
      },
      body: JSON.stringify({ providerChannelId: 'inst-unreg', deleteRemote: true }),
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.success, true);
    assert.equal(json.data.removed, true);
    assert.equal(json.data.remote_deleted, true);
    assert.deepStrictEqual(deleted, ['111']);

    const listRes = await fetch(`${baseUrl}/pipedrive/admin/channels`, {
      headers: { 'x-api-key': TEST_API_KEY },
    });
    const listJson = await listRes.json();
    assert.equal(Array.isArray(listJson.data), true);
    assert.equal(listJson.data.some((item: any) => item.provider_channel_id === 'inst-unreg'), false);
  } finally {
    pipedriveClient.deleteChannel = originalDeleteChannel;
  }
});

test('admin/unregister-channel ignora delete remoto para canal fallback', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  );

  const { upsertChannel } = await import('../src/services/pipedrive/store.js');
  await upsertChannel({
    id: 'fallback:inst-fb',
    provider_channel_id: 'inst-fb',
    name: 'Fallback',
    provider_type: 'whatsapp',
    template_support: false,
    avatar_url: null,
    company_id: 123,
    api_domain: null,
  } as any);

  const { pipedriveClient } = await import('../src/services/pipedrive/client.js');
  const originalDeleteChannel = pipedriveClient.deleteChannel.bind(pipedriveClient);
  pipedriveClient.deleteChannel = async () => {
    throw new Error('should_not_call_delete_channel');
  };

  try {
    const response = await fetch(`${baseUrl}/pipedrive/admin/unregister-channel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': TEST_API_KEY,
      },
      body: JSON.stringify({ providerChannelId: 'inst-fb', deleteRemote: true }),
    });

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.success, true);
    assert.equal(json.data.removed, true);
    assert.equal(json.data.remote_deleted, false);
  } finally {
    pipedriveClient.deleteChannel = originalDeleteChannel;
  }
});

test('webhook receiver exige Basic Auth', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  );

  const payload = { event: 'updated.deal', current: { id: 1, person_id: 1 } };

  const resNoAuth = await fetch(`${baseUrl}/pipedrive/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(resNoAuth.status, 401);

  const resBadAuth = await fetch(`${baseUrl}/pipedrive/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('wrong:creds').toString('base64')}`,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(resBadAuth.status, 401);

  const resOk = await fetch(`${baseUrl}/pipedrive/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${process.env.PIPEDRIVE_WEBHOOK_USER}:${process.env.PIPEDRIVE_WEBHOOK_PASS}`).toString('base64')}`,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(resOk.status, 200);
  const json = await resOk.json();
  assert.equal(json.success, true);
  assert.equal(json.data.object, 'deal');
});

test('automação só envia em deal/activity e quando template/instância existem', async () => {
  const { maybeRunPipedriveAutomation } = await import('../src/services/pipedrive/automation.js');

  const sent: Array<{ jid: string; text: string }> = [];
  const deps = {
    instanceId: 'inst-auto',
    templates: { deal: 'Olá {{person.name}} ({{object}} {{action}})', activity: 'Atividade {{action}}' },
    getPerson: async () => ({ id: 1, name: 'Ana', phone: [{ value: '+55 44 99999-9999', primary: true }] }),
    sendText: async ({ jid, text }: any) => {
      sent.push({ jid, text });
      return { messageId: 'm1' };
    },
  };

  const dealPayload = { event_object: 'deal', event_action: 'updated', current: { person_id: 1 } };
  const deal = await maybeRunPipedriveAutomation(dealPayload, deps as any);
  assert.equal(deal.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.jid, '5544999999999@s.whatsapp.net');

  const personPayload = { event_object: 'person', event_action: 'updated', current: { person_id: 1 } };
  const person = await maybeRunPipedriveAutomation(personPayload, deps as any);
  assert.equal(person.sent, false);
  assert.equal(sent.length, 1, 'expected no additional sends for non-deal/activity');
});

test('métricas acumulam eventos de webhook + automação', async (t) => {
  const { server, baseUrl } = await createServer();
  t.after(() =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  );

  const beforeRes = await fetch(`${baseUrl}/pipedrive/admin/metrics`, {
    headers: { 'x-api-key': TEST_API_KEY },
  });
  assert.equal(beforeRes.status, 200);
  const before = await beforeRes.json();

  const payload = { event: 'updated.deal', current: { id: 2, person_id: 1 }, meta: { timestamp: 123 } };
  const resOk = await fetch(`${baseUrl}/pipedrive/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${process.env.PIPEDRIVE_WEBHOOK_USER}:${process.env.PIPEDRIVE_WEBHOOK_PASS}`).toString('base64')}`,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(resOk.status, 200);

  const afterRes = await fetch(`${baseUrl}/pipedrive/admin/metrics`, {
    headers: { 'x-api-key': TEST_API_KEY },
  });
  const after = await afterRes.json();

  assert.equal(
    after.data.counters.webhook_events_total,
    before.data.counters.webhook_events_total + 1,
  );
  assert.equal(
    after.data.counters.webhook_events_by_object.deal,
    (before.data.counters.webhook_events_by_object.deal ?? 0) + 1,
  );
  assert.equal(
    after.data.counters.automations_skipped,
    before.data.counters.automations_skipped + 1,
  );
});
