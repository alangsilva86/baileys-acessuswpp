import { test } from 'node:test';
import assert from 'node:assert/strict';
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
