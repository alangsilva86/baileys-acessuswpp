import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pino from 'pino';
import type { WAMessage } from '@whiskeysockets/baileys';
import { MessageService } from '../src/baileys/messageService.js';
import { BrokerEventStore } from '../src/broker/eventStore.js';

class FakeWebhook {
  public readonly events: Array<{ event: string; payload: unknown }> = [];

  async emit(event: string, payload: unknown): Promise<void> {
    this.events.push({ event, payload });
  }
}

function createMessage(
  id: string,
  data: Partial<WAMessage> & { message?: NonNullable<WAMessage['message']> },
): WAMessage {
  return {
    key: {
      id,
      remoteJid: '123@s.whatsapp.net',
      fromMe: false,
    },
    messageTimestamp: 1700000000,
    message: data.message,
    pushName: 'Customer',
    ...data,
  } as unknown as WAMessage;
}

function createService(options: { eventStore?: BrokerEventStore }) {
  const webhook = new FakeWebhook();
  const eventStore = options.eventStore ?? new BrokerEventStore();
  const logger = { warn() {} } as unknown as pino.Logger;
  const service = new MessageService(
    {} as any,
    webhook as any,
    logger,
    {
      eventStore,
      instanceId: 'instance-1',
    },
  );

  return { service, webhook, eventStore };
}

const invalidMessages: WAMessage[] = [
  {
    ...createMessage('drop-from-me', { message: { conversation: 'ignore me' } }),
    key: { id: 'drop-from-me', remoteJid: '123@s.whatsapp.net', fromMe: true },
  } as WAMessage,
  {
    ...createMessage('drop-stub', { message: { conversation: 'stub' } }),
    messageStubType: 1,
  } as unknown as WAMessage,
  createMessage('drop-protocol', { message: { protocolMessage: {} as any } }),
  createMessage('drop-history', { message: { historySyncNotification: {} as any } }),
  createMessage('drop-empty', { message: {} as any }),
];

test('MessageService.onMessagesUpsert forwards only client messages with content', async () => {
  const { service, webhook, eventStore } = createService({ eventStore: new BrokerEventStore() });

  const validText = createMessage('keep-text', {
    message: { conversation: 'hello world' },
  });

  const validMedia = createMessage('keep-media', {
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'photo' } as any },
  });

  await service.onMessagesUpsert({
    type: 'notify',
    messages: [validText, validMedia, ...invalidMessages],
  } as any);

  assert.equal(webhook.events.length, 2);
  assert.deepStrictEqual(
    webhook.events.map((entry) => entry.event),
    ['MESSAGE_INBOUND', 'MESSAGE_INBOUND'],
  );

  const payloads = webhook.events.map((entry) => entry.payload as any);
  assert.deepStrictEqual(
    payloads.map((payload: any) => payload.messageId),
    ['keep-text', 'keep-media'],
  );

  const stored = eventStore.list({ limit: 10 });
  assert.equal(stored.length, 2);
  assert.deepStrictEqual(
    stored.map((event) => event.payload.messageId),
    ['keep-text', 'keep-media'],
  );
});

test('MessageService.onInbound also filters messages defensively', async () => {
  const { service, webhook, eventStore } = createService({ eventStore: new BrokerEventStore() });

  const validListReply = createMessage('keep-list', {
    message: {
      listResponseMessage: {
        title: 'Option 1',
      },
    } as any,
  });

  await service.onInbound([validListReply, ...invalidMessages]);

  assert.equal(webhook.events.length, 1);
  assert.deepStrictEqual(
    webhook.events.map((entry) => entry.event),
    ['MESSAGE_INBOUND'],
  );

  const payload = webhook.events[0].payload as any;
  assert.equal(payload.messageId, 'keep-list');

  const stored = eventStore.list({ limit: 10 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].payload.messageId, 'keep-list');
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import type pino from 'pino';

import { MessageService } from '../src/baileys/messageService.js';
import { BrokerEventStore } from '../src/broker/eventStore.js';
import type { WebhookClient } from '../src/services/webhook.js';

const noopLogger = { warn: () => {} } as unknown as pino.Logger;

function buildInboundMessage(): WAMessage {
  return {
    key: {
      id: 'ABC123',
      remoteJid: '5511987654321@s.whatsapp.net',
      fromMe: false,
    },
    messageTimestamp: 1700000000,
    pushName: 'Maria da Silva',
    message: {
      conversation: 'Olá! Tudo bem?',
    },
  } as unknown as WAMessage;
}

test('MessageService emits structured inbound payload', async () => {
  const eventStore = new BrokerEventStore();
  const webhookEvents: Array<{ event: string; payload: any }> = [];

  const webhook = {
    async emit(event: string, payload: unknown) {
      webhookEvents.push({ event, payload });
    },
  } as unknown as WebhookClient;

  const service = new MessageService(
    {} as unknown as WASocket,
    webhook,
    noopLogger,
    { eventStore, instanceId: 'test-instance' },
  );

  const inboundMessage = buildInboundMessage();
  await service.onInbound([inboundMessage]);

  assert.equal(webhookEvents.length, 1);
  assert.equal(webhookEvents[0].event, 'MESSAGE_INBOUND');

  const payload = webhookEvents[0].payload;
  assert.equal(payload.instanceId, 'test-instance');
  assert.deepStrictEqual(payload.contact, {
    owner: 'customer',
    remoteJid: '5511987654321@s.whatsapp.net',
    participant: null,
    phone: '5511987654321',
    displayName: 'Maria da Silva',
    isGroup: false,
  });

  assert.deepStrictEqual(payload.message, {
    id: 'ABC123',
    messageId: 'ABC123',
    chatId: '5511987654321@s.whatsapp.net',
    type: 'conversation',
    conversation: 'Olá! Tudo bem?',
  });

  const expectedTimestamp = new Date(1700000000 * 1000).toISOString();
  assert.deepStrictEqual(payload.metadata, {
    timestamp: expectedTimestamp,
    broker: {
      direction: 'inbound',
      type: 'MESSAGE_INBOUND',
    },
  });

  const [event] = eventStore.list();
  assert.equal(event?.type, 'MESSAGE_INBOUND');
  assert.equal(event?.direction, 'inbound');
  assert.deepStrictEqual(event?.payload, payload);
});
