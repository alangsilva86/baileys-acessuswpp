import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pino from 'pino';
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

import { MessageService } from '../src/baileys/messageService.js';
import { recordVoteSelection } from '../src/baileys/pollMetadata.js';
import { BrokerEventStore } from '../src/broker/eventStore.js';
import type { WebhookClient } from '../src/services/webhook.js';
import { LidMappingStore } from '../src/lidMappingStore.js';

class FakeWebhook {
  public readonly events: Array<{ event: string; payload: unknown }> = [];

  async emit(event: string, payload: unknown, _opts?: unknown): Promise<void> {
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

function createService(options: { eventStore?: BrokerEventStore; mappingStore?: LidMappingStore | null }) {
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
      mappingStore: options.mappingStore ?? null,
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
  createMessage('drop-history', { message: { historySyncNotification: {} as any } as any }),
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
    payloads.map((payload: any) => payload.message.id),
    ['keep-text', 'keep-media'],
  );

  const stored = eventStore.list({ limit: 10 });
  assert.equal(stored.length, 2);
  assert.deepStrictEqual(
    stored.map((event) => (event.payload as any).message.id),
    ['keep-text', 'keep-media'],
  );
});

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
    async emit(event: string, payload: unknown, _opts?: unknown) {
      webhookEvents.push({ event, payload });
    },
  } as unknown as WebhookClient;

  const service = new MessageService(
    {} as unknown as WASocket,
    webhook,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore: null },
  );

  const inboundMessage = buildInboundMessage();
  await service.onInbound([inboundMessage]);

  assert.equal(webhookEvents.length, 1);
  assert.equal(webhookEvents[0].event, 'MESSAGE_INBOUND');

  const payload = webhookEvents[0].payload;
  assert.deepStrictEqual(payload.contact, {
    owner: 'user',
    remoteJid: '5511987654321@s.whatsapp.net',
    participant: null,
    phone: '+5511987654321',
    displayName: 'Maria da Silva',
    isGroup: false,
  });

  assert.deepStrictEqual(payload.message, {
    id: 'ABC123',
    chatId: '5511987654321@s.whatsapp.net',
    type: 'text',
    text: 'Olá! Tudo bem?',
  });

  const expectedTimestamp = new Date(1700000000 * 1000).toISOString();
  assert.deepStrictEqual(payload.metadata, {
    timestamp: expectedTimestamp,
    broker: {
      direction: 'inbound',
      type: 'baileys',
    },
    source: 'baileys-acessus',
    pollChoice: null,
  });

  const [event] = eventStore.list();
  assert.equal(event?.type, 'MESSAGE_INBOUND');
  assert.equal(event?.direction, 'inbound');
  assert.deepStrictEqual(event?.payload, payload);
});

test('MessageService resolves inbound contact when Baileys provides LID identifiers', async () => {
  const eventStore = new BrokerEventStore();
  const webhookEvents: Array<{ event: string; payload: any }> = [];
  const mappingStore = new LidMappingStore();

  const webhook = {
    async emit(event: string, payload: unknown) {
      webhookEvents.push({ event, payload });
    },
  } as unknown as WebhookClient;

  const service = new MessageService(
    {} as unknown as WASocket,
    webhook,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore },
  );

  const inboundMessage = buildInboundMessage();
  inboundMessage.key = {
    id: inboundMessage.key?.id ?? 'ABC123',
    remoteJid: '5511987654321@lid',
    fromMe: false,
  } as any;
  (inboundMessage.key as any).remoteJidAlt = '5511987654321@s.whatsapp.net';

  await service.onInbound([inboundMessage]);

  assert.equal(webhookEvents.length, 1);
  const payload = webhookEvents[0].payload;
  assert.equal(payload.contact.remoteJid, '5511987654321@s.whatsapp.net');
  assert.equal(payload.message.chatId, '5511987654321@s.whatsapp.net');
  assert.equal(payload.contact.phone, '+5511987654321');
  assert.equal(mappingStore.getPnForLid('5511987654321@lid'), '5511987654321@s.whatsapp.net');
});

test('MessageService inclui pollChoice nos metadados quando voto decifrado está disponível', async () => {
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
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore: null },
  );

  const messageId = 'POLL-VOTE-1';
  recordVoteSelection(messageId, {
    pollId: 'poll-123',
    question: 'Qual seu lanche favorito?',
    selectedOptions: [
      { id: 'option-1', text: 'Coxinha' },
      { id: null, text: 'Pastel' },
    ],
  });

  const pollVoteMessage = createMessage(messageId, {
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: 'poll-123', remoteJid: '5511987654321@s.whatsapp.net' },
        pollUpdateMessageKey: { id: 'POLL-UPD-1' },
        vote: { encPayload: new Uint8Array([1, 2, 3]), encIv: new Uint8Array([4, 5, 6]) },
      },
    } as any,
  });

  await service.onInbound([pollVoteMessage]);

  assert.equal(webhookEvents.length, 1);
  assert.equal(webhookEvents[0].event, 'MESSAGE_INBOUND');

  const payload = webhookEvents[0].payload;
  assert.equal(payload.message.text, 'Coxinha, Pastel');
  assert.deepStrictEqual(payload.metadata.pollChoice, {
    pollId: 'poll-123',
    question: 'Qual seu lanche favorito?',
    selectedOptions: [
      { id: 'option-1', text: 'Coxinha' },
      { id: null, text: 'Pastel' },
    ],
    optionIds: ['option-1'],
  });

  recordVoteSelection(messageId, null);
});

test('MessageService maps participant phone for group messages when valid', async () => {
  const eventStore = new BrokerEventStore();
  const webhookEvents: Array<{ event: string; payload: any }> = [];

  const webhook = {
    async emit(event: string, payload: unknown, _opts?: unknown) {
      webhookEvents.push({ event, payload });
    },
  } as unknown as WebhookClient;

  const service = new MessageService(
    {} as unknown as WASocket,
    webhook,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore: null },
  );

  const groupMessage = {
    key: {
      id: 'GROUP-1',
      remoteJid: '5511987654321-123456@g.us',
      participant: '5511987654321@s.whatsapp.net',
      fromMe: false,
    },
    messageTimestamp: 1700000000,
    pushName: 'Maria da Silva',
    message: {
      conversation: 'Mensagem em grupo',
    },
  } as unknown as WAMessage;

  await service.onInbound([groupMessage]);

  assert.equal(webhookEvents.length, 1);
  const payload = webhookEvents[0].payload;
  assert.equal(payload.contact.isGroup, true);
  assert.equal(payload.contact.phone, '+5511987654321');
  assert.equal(payload.contact.participant, '5511987654321@s.whatsapp.net');
});

test('MessageService omits phone for group and broadcast messages without E.164 sender', async () => {
  const eventStore = new BrokerEventStore();
  const webhookEvents: Array<{ event: string; payload: any }> = [];

  const webhook = {
    async emit(event: string, payload: unknown, _opts?: unknown) {
      webhookEvents.push({ event, payload });
    },
  } as unknown as WebhookClient;

  const service = new MessageService(
    {} as unknown as WASocket,
    webhook,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore: null },
  );

  const groupWithoutPhone = {
    key: {
      id: 'GROUP-2',
      remoteJid: '5511987654321-123456@g.us',
      participant: 'status@broadcast',
      fromMe: false,
    },
    messageTimestamp: 1700000000,
    pushName: 'Customer',
    message: {
      conversation: 'Mensagem sem telefone',
    },
  } as unknown as WAMessage;

  const broadcastMessage = {
    key: {
      id: 'BROADCAST-1',
      remoteJid: 'status@broadcast',
      participant: 'status@broadcast',
      fromMe: false,
    },
    messageTimestamp: 1700000000,
    pushName: 'Customer',
    message: {
      conversation: 'Mensagem broadcast',
    },
  } as unknown as WAMessage;

  await service.onInbound([groupWithoutPhone, broadcastMessage]);

  assert.equal(webhookEvents.length, 2);

  const [groupPayload, broadcastPayload] = webhookEvents.map(({ payload }) => payload);

  assert.equal(groupPayload.contact.isGroup, true);
  assert.equal(groupPayload.contact.phone, null);

  assert.equal(broadcastPayload.contact.isGroup, false);
  assert.equal(broadcastPayload.contact.phone, null);
});

test('MessageService emits structured outbound payload for text messages', async () => {
  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();
  const sendCalls: Array<{ jid: string; content: any }> = [];
  const remoteJid = '551199999999@s.whatsapp.net';
  const outboundMessage = {
    key: {
      id: 'OUT-TEXT-1',
      remoteJid,
      fromMe: true,
    },
    messageTimestamp: 1700000100,
    pushName: 'Agente CS',
    message: {
      conversation: 'Olá lead!',
    },
  } as unknown as WAMessage;

  const sock = {
    async sendMessage(jid: string, content: any) {
      sendCalls.push({ jid, content });
      return outboundMessage;
    },
  } as unknown as WASocket;

  const service = new MessageService(
    sock,
    webhook as unknown as WebhookClient,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore: null },
  );

  const response = await service.sendText(remoteJid, 'Olá lead!');

  assert.equal(response, outboundMessage);
  assert.equal(sendCalls.length, 1);
  assert.deepStrictEqual(sendCalls[0], {
    jid: remoteJid,
    content: { text: 'Olá lead!' },
  });

  assert.equal(webhook.events.length, 1);
  const { event, payload } = webhook.events[0] as { event: string; payload: any };
  assert.equal(event, 'MESSAGE_OUTBOUND');
  assert.deepStrictEqual(payload.contact, {
    owner: 'device',
    remoteJid,
    participant: null,
    phone: '+551199999999',
    displayName: 'Agente CS',
    isGroup: false,
  });
  assert.deepStrictEqual(payload.message, {
    id: 'OUT-TEXT-1',
    chatId: remoteJid,
    type: 'text',
    text: 'Olá lead!',
  });
  assert.deepStrictEqual(payload.metadata, {
    timestamp: new Date(1700000100 * 1000).toISOString(),
    broker: {
      direction: 'outbound',
      type: 'baileys',
    },
    source: 'baileys-acessus',
    pollChoice: null,
  });

  const stored = eventStore.list({ limit: 5 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.type, 'MESSAGE_OUTBOUND');
  assert.equal(stored[0]?.direction, 'outbound');
  assert.deepStrictEqual(stored[0]?.payload, payload);
});

test('MessageService resolves outbound payload identities using cached PN/LID mapping', async () => {
  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();
  const mappingStore = new LidMappingStore();
  mappingStore.rememberMapping('551199999999@s.whatsapp.net', '551199999999@lid');

  const sendCalls: Array<{ jid: string; content: any }> = [];
  const outboundMessage = {
    key: {
      id: 'OUT-LID-1',
      remoteJid: '551199999999@lid',
      fromMe: true,
    },
    messageTimestamp: 1700000200,
    pushName: 'Agente CS',
    message: { conversation: 'Mensagem LID' },
  } as unknown as WAMessage;

  const sock = {
    async sendMessage(jid: string, content: any) {
      sendCalls.push({ jid, content });
      return outboundMessage;
    },
  } as unknown as WASocket;

  const service = new MessageService(
    sock,
    webhook as unknown as WebhookClient,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore },
  );

  await service.sendText('551199999999@lid', 'Mensagem LID');

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]?.jid, '551199999999@lid');
  const payload = webhook.events[0]?.payload as any;
  assert.equal(payload.contact.remoteJid, '551199999999@s.whatsapp.net');
  assert.equal(payload.message.chatId, '551199999999@s.whatsapp.net');
  assert.equal(payload.contact.phone, '+551199999999');
});

test('MessageService inclui metadados de mídia ao enviar para o LeadEngine', async () => {
  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();
  const sendCalls: Array<{ jid: string; content: any }> = [];
  const remoteJid = '551199999999@s.whatsapp.net';
  const base64Data = Buffer.from('fake image data');
  const outboundMessage = {
    key: {
      id: 'OUT-MEDIA-1',
      remoteJid,
      fromMe: true,
    },
    messageTimestamp: 1700000200,
    pushName: 'Agente CS',
    message: {
      imageMessage: {
        caption: 'Legenda original',
      },
    },
  } as unknown as WAMessage;

  const sock = {
    async sendMessage(jid: string, content: any) {
      sendCalls.push({ jid, content });
      return outboundMessage;
    },
  } as unknown as WASocket;

  const service = new MessageService(
    sock,
    webhook as unknown as WebhookClient,
    { warn: () => {} } as unknown as pino.Logger,
    { eventStore, instanceId: 'test-instance', mappingStore: null },
  );

  await service.sendMedia(
    remoteJid,
    'image',
    {
      base64: `data:image/png;base64,${base64Data.toString('base64')}`,
      fileName: 'catalogo.png',
    },
    {
      caption: 'Segue o catálogo',
      mimetype: 'image/png',
    },
  );

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]?.jid, remoteJid);
  assert.ok(sendCalls[0]?.content?.image, 'expected image payload to be sent');

  assert.equal(webhook.events.length, 1);
  const { event, payload } = webhook.events[0] as { event: string; payload: any };
  assert.equal(event, 'MESSAGE_OUTBOUND');

  assert.deepStrictEqual(payload.contact, {
    owner: 'device',
    remoteJid,
    participant: null,
    phone: '+551199999999',
    displayName: 'Agente CS',
    isGroup: false,
  });

  assert.deepStrictEqual(payload.message, {
    id: 'OUT-MEDIA-1',
    chatId: remoteJid,
    type: 'media',
    text: 'Segue o catálogo',
    media: {
      mediaType: 'image',
      mimetype: 'image/png',
      fileName: 'catalogo.png',
      size: base64Data.length,
      caption: 'Segue o catálogo',
    },
  });

  assert.deepStrictEqual(payload.metadata, {
    timestamp: new Date(1700000200 * 1000).toISOString(),
    broker: {
      direction: 'outbound',
      type: 'baileys',
    },
    source: 'baileys-acessus',
    pollChoice: null,
  });

  const stored = eventStore.list({ limit: 5 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.type, 'MESSAGE_OUTBOUND');
  assert.equal(stored[0]?.direction, 'outbound');
  assert.deepStrictEqual(stored[0]?.payload, payload);
});
