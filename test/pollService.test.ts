import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type {
  BaileysEventMap,
  proto,
  WAMessage,
  WAMessageUpdate,
  WASocket,
} from '@whiskeysockets/baileys';
import type pino from 'pino';

import { PollService } from '../src/baileys/pollService.js';
import { PollMessageStore } from '../src/baileys/store.js';
import { BrokerEventStore } from '../src/broker/eventStore.js';

const POLL_REMOTE_JID = '556299999999@g.us';
const VOTER_JID = '556288888888@s.whatsapp.net';

function buildPollMessage(): WAMessage {
  return {
    key: {
      id: 'poll-123',
      remoteJid: POLL_REMOTE_JID,
      participant: '556277777777@s.whatsapp.net',
    },
    messageTimestamp: 1_700_000_000,
    message: {
      pollCreationMessage: {
        name: 'Qual produto?',
        options: [
          { optionName: 'Produto A' },
          { optionName: 'Produto B' },
        ],
        encKey: new Uint8Array(Buffer.alloc(32, 5)),
      },
    },
  } as unknown as WAMessage;
}

function buildPollUpdate(
  optionName = 'Produto A',
  selectedHash?: Uint8Array,
): WAMessageUpdate {
  const hash = selectedHash ?? createHash('sha256').update(optionName).digest();

  const pollUpdate: proto.Message.IPollUpdateMessage = {
    pollCreationMessageKey: {
      id: 'poll-123',
    },
    pollUpdateMessageKey: {
      id: 'vote-123',
      remoteJid: POLL_REMOTE_JID,
      participant: VOTER_JID,
      fromMe: false,
    },
    vote: {
      pollOptionId: optionName,
      selectedOptions: [hash],
    },
  };

  return {
    key: {
      id: 'poll-123',
      remoteJid: POLL_REMOTE_JID,
      participant: VOTER_JID,
    },
    messageTimestamp: 1_700_000_100,
    update: {
      pollUpdates: [pollUpdate],
    },
  } as unknown as WAMessageUpdate;
}

function buildPollUpdateMessage(
  optionName = 'Produto A',
  selectedHash?: Uint8Array,
): WAMessage {
  const update = buildPollUpdate(optionName, selectedHash);
  const pollUpdate = update.update?.pollUpdates?.[0];
  if (!pollUpdate) {
    throw new Error('expected poll update payload');
  }

  const pollUpdateMessage = {
    pollCreationMessageKey: pollUpdate.pollCreationMessageKey,
    pollUpdateMessageKey: pollUpdate.pollUpdateMessageKey,
    pollUpdates: update.update?.pollUpdates,
  } as unknown as proto.Message.IPollUpdateMessage & { pollUpdates: proto.IPollUpdate[] };

  return {
    key: update.key,
    messageTimestamp: update.messageTimestamp,
    message: {
      pollUpdateMessage,
      pollUpdateMessage: pollUpdate,
    },
    pushName: (update as unknown as { pushName?: string }).pushName,
  } as unknown as WAMessage;
}

class FakeWebhook {
  public readonly events: Array<{ event: string; payload: unknown; options: unknown }> = [];

  async emit(event: string, payload: unknown, options?: unknown): Promise<void> {
    this.events.push({ event, payload, options });
  }
}

const aggregateResult = [
  {
    name: 'Produto A',
    voters: [
      '556288888888@s.whatsapp.net',
      '556277777777@s.whatsapp.net',
    ],
  },
  {
    name: 'Produto B',
    voters: ['556299999999@s.whatsapp.net'],
  },
];

test('onMessageUpdate enqueues metadata with messageId and ISO timestamp', async () => {
  const store = new PollMessageStore();
  const pollMessage = buildPollMessage();
  store.remember(pollMessage, 60_000);

  const eventStore = new BrokerEventStore();
  const webhookEvents: Array<{ event: string; payload: any }> = [];

  const webhook = {
    async emit(event: string, payload: unknown): Promise<void> {
      webhookEvents.push({ event, payload });
    },
  } as unknown as import('../src/services/webhook.js').WebhookClient;

  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: '556277777777@s.whatsapp.net' } } as unknown as WASocket;

  const service = new PollService(sock, webhook, logger, {
    store,
    eventStore,
    instanceId: 'instance-1',
    feedbackTemplate: null,
  });

  const update = buildPollUpdate();
  await service.onMessageUpdate([update]);

  const [queued] = eventStore.recent({ limit: 1, type: 'POLL_CHOICE' });
  assert.ok(queued, 'expected event to be queued');
  assert.equal(queued.payload.messageId, 'poll-123');
  assert.equal(
    queued.payload.timestamp,
    new Date(1_700_000_100 * 1000).toISOString(),
    'expected ISO timestamp from update',
  );

  assert.equal(webhookEvents.length, 1, 'expected webhook to be emitted once');
  const [{ event, payload }] = webhookEvents;
  assert.equal(event, 'POLL_CHOICE');
  assert.equal(payload.messageId, 'poll-123');
  assert.equal(payload.timestamp, new Date(1_700_000_100 * 1000).toISOString());
  assert.deepStrictEqual(payload.selectedOptions, [{ id: 'Produto A', text: 'Produto A' }]);
  assert.equal(payload.voterJid, VOTER_JID);
  assert.equal(payload.contact.participant, VOTER_JID);
  assert.equal(payload.contact.remoteJid, POLL_REMOTE_JID);
});

test('onMessageUpdate maps selected options without pollUpdateMessageKey', async () => {
  const store = new PollMessageStore();
  const pollMessage = buildPollMessage();
  store.remember(pollMessage, 60_000);

  const webhook = new FakeWebhook();
  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: '556277777777@s.whatsapp.net' } } as unknown as WASocket;

  const aggregateWithoutVoter = () => [
    { name: 'Produto A', voters: [] as string[] },
    { name: 'Produto B', voters: [] as string[] },
  ];

  const service = new PollService(sock, webhook as any, logger, {
    store,
    feedbackTemplate: null,
    aggregateVotesFn: aggregateWithoutVoter,
  });

  const update = buildPollUpdate();
  if (update.update?.pollUpdates?.[0]) {
    update.update.pollUpdates[0].pollUpdateMessageKey = undefined;
  }

  await service.onMessageUpdate([update]);

  assert.equal(webhook.events.length, 1, 'expected webhook to be emitted');
  const event = webhook.events[0];
  const payload = event.payload as any;
  assert.deepStrictEqual(payload.selectedOptions, [
    { id: 'Produto A', text: 'Produto A' },
  ]);
});

test('onMessageUpdate maps selected options using provided option hash', async () => {
  const store = new PollMessageStore();
  const pollMessage = buildPollMessage();
  const customOptionName = 'Produto Especial';
  const customHash = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

  const pollCreation = pollMessage.message?.pollCreationMessage;
  if (!pollCreation) {
    throw new Error('expected poll creation message');
  }

  pollCreation.options = [
    { optionName: customOptionName, optionHash: customHash },
    { optionName: 'Produto B' },
  ];

  store.remember(pollMessage, 60_000);

  const webhook = new FakeWebhook();
  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: '556277777777@s.whatsapp.net' } } as unknown as WASocket;

  const aggregateWithCustomHash = () => [
    { name: customOptionName, voters: [VOTER_JID] },
    { name: 'Produto B', voters: [] as string[] },
  ];

  const service = new PollService(sock, webhook as any, logger, {
    store,
    feedbackTemplate: null,
    aggregateVotesFn: aggregateWithCustomHash,
  });

  const update = buildPollUpdate(customOptionName, customHash);
  await service.onMessageUpdate([update]);

  assert.equal(webhook.events.length, 1, 'expected webhook to be emitted');
  const payload = webhook.events[0]?.payload as any;
  assert.deepStrictEqual(payload.selectedOptions, [
    { id: customOptionName, text: customOptionName },
  ]);
});

test('onMessageUpsert stores poll creation sent from current device', async () => {
  const store = new PollMessageStore();
  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();
  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: '556277777777@s.whatsapp.net' } } as unknown as WASocket;

  const service = new PollService(sock, webhook as any, logger, {
    store,
    eventStore,
    instanceId: 'instance-1',
    feedbackTemplate: null,
    aggregateVotesFn: () => aggregateResult,
  });

  const pollMessage = buildPollMessage();
  pollMessage.key = {
    ...(pollMessage.key || {}),
    fromMe: true,
  } as WAMessage['key'];

  const upsertEvent: BaileysEventMap['messages.upsert'] = {
    type: 'notify',
    messages: [pollMessage],
  };

  await service.onMessageUpsert(upsertEvent);

  assert.ok(store.get('poll-123'), 'expected poll message to be stored');

  const update = buildPollUpdate();
  await service.onMessageUpdate([update]);

  const [queued] = eventStore.recent({ limit: 1, type: 'POLL_CHOICE' });
  assert.ok(queued, 'expected poll choice event to be queued');
  assert.equal(queued.payload.pollId, 'poll-123');

  assert.equal(webhook.events.length, 1, 'expected webhook event to be emitted');
  const [{ event }] = webhook.events;
  assert.equal(event, 'POLL_CHOICE');
});

test('onMessageUpsert processes poll updates and emits poll choice webhook', async () => {
  const store = new PollMessageStore();
  const pollMessage = buildPollMessage();
  store.remember(pollMessage, 60_000);

  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();
  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: '556277777777@s.whatsapp.net' } } as unknown as WASocket;

  const service = new PollService(sock, webhook as any, logger, {
    store,
    eventStore,
    instanceId: 'instance-1',
    feedbackTemplate: null,
    aggregateVotesFn: () => aggregateResult,
  });

  const updateMessage = buildPollUpdateMessage();
  const upsertEvent: BaileysEventMap['messages.upsert'] = {
    type: 'notify',
    messages: [updateMessage],
  };

  await service.onMessageUpsert(upsertEvent);

  const [queued] = eventStore.recent({ limit: 1, type: 'POLL_CHOICE' });
  assert.ok(queued, 'expected poll choice event to be queued');
  assert.equal(queued.payload.pollId, 'poll-123');

  assert.equal(webhook.events.length, 1, 'expected webhook to be emitted');
  const [{ event, payload }] = webhook.events as Array<{ event: string; payload: any }>;
  assert.equal(event, 'POLL_CHOICE');
  assert.equal(payload.voterJid, VOTER_JID);
  assert.deepStrictEqual(payload.selectedOptions, [{ id: 'Produto A', text: 'Produto A' }]);
});

test('onMessageUpsert decrypts encrypted poll votes before aggregating', async () => {
  const store = new PollMessageStore();
  const pollMessage = buildPollMessage();
  store.remember(pollMessage, 60_000);

  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();
  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: '556277777777@s.whatsapp.net' } } as unknown as WASocket;

  const decryptCalls: Array<{ ctx: { pollCreatorJid: string; pollMsgId: string; voterJid: string } }> = [];

  const decryptStub: typeof import('@whiskeysockets/baileys/lib/Utils/process-message.js').decryptPollVote = (
    _vote,
    ctx,
  ) => {
    decryptCalls.push({ ctx });
    return {
      selectedOptions: [createHash('sha256').update('Produto B').digest()],
    } as proto.Message.IPollVoteMessage;
  };

  const aggregateWithVoterOnB = () => [
    { name: 'Produto A', voters: [] as string[] },
    { name: 'Produto B', voters: [VOTER_JID] },
  ];

  const service = new PollService(sock, webhook as any, logger, {
    store,
    eventStore,
    instanceId: 'instance-1',
    feedbackTemplate: null,
    aggregateVotesFn: aggregateWithVoterOnB,
    decryptPollVoteFn: decryptStub,
  });

  const encryptedUpdate: proto.Message.IPollUpdateMessage = {
    pollCreationMessageKey: {
      id: 'poll-123',
      remoteJid: POLL_REMOTE_JID,
      participant: '556277777777@s.whatsapp.net',
    },
    pollUpdateMessageKey: {
      id: 'vote-999',
      remoteJid: POLL_REMOTE_JID,
      participant: VOTER_JID,
      fromMe: false,
    },
    vote: {
      encPayload: Buffer.alloc(48, 9),
      encIv: Buffer.alloc(16, 7),
    },
  };

  const upsertEvent: BaileysEventMap['messages.upsert'] = {
    type: 'append',
    messages: [
      {
        key: {
          id: 'poll-123',
          remoteJid: POLL_REMOTE_JID,
          participant: VOTER_JID,
        },
        messageTimestamp: 1_700_000_200,
        message: {
          pollUpdateMessage: encryptedUpdate,
        },
        pushName: 'Votante',
      } as unknown as WAMessage,
    ],
  };

  await service.onMessageUpsert(upsertEvent);

  assert.equal(decryptCalls.length, 1, 'expected decrypt to be called once');
  assert.equal(decryptCalls[0]?.ctx.pollMsgId, 'poll-123');
  assert.equal(decryptCalls[0]?.ctx.voterJid, VOTER_JID);

  const [{ payload }] = webhook.events as Array<{ event: string; payload: any }>;
  assert.deepStrictEqual(payload.selectedOptions, [{ id: 'Produto B', text: 'Produto B' }]);
  assert.equal(payload.voterJid, VOTER_JID);
});

test('onMessageUpdate ignores updates without messageId metadata', async () => {
  const pollMessage: WAMessage = {
    key: {
      remoteJid: POLL_REMOTE_JID,
    },
    messageTimestamp: 1_700_000_000,
  } as unknown as WAMessage;

  const store = new PollMessageStore();
  store.remember(pollMessage, 60_000);

  const eventStore = new BrokerEventStore();
  const webhookEvents: Array<{ event: string; payload: unknown }> = [];

  const webhook = {
    async emit(event: string, payload: unknown): Promise<void> {
      webhookEvents.push({ event, payload });
    },
  } as unknown as import('../src/services/webhook.js').WebhookClient;

  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: 'device@s.whatsapp.net' } } as unknown as WASocket;

  const service = new PollService(sock, webhook, logger, {
    store,
    eventStore,
    feedbackTemplate: null,
  });

  const update = {
    key: {},
    messageTimestamp: undefined,
    update: {
      pollUpdates: [
        {
          pollCreationMessageKey: {
            id: 'poll-123',
          },
        },
      ],
    },
  } as unknown as WAMessageUpdate;

  await service.onMessageUpdate([update]);

  const recent = eventStore.recent({ limit: 1, type: 'POLL_CHOICE' });
  assert.equal(recent.length, 0, 'expected no events to be queued');
  assert.equal(webhookEvents.length, 0, 'expected webhook not to be emitted');
});

test('PollService emits aggregated totals for poll updates', async () => {
  const pollStore = new PollMessageStore();
  const eventStore = new BrokerEventStore();
  const webhook = new FakeWebhook();

  const service = new PollService(
    { user: { id: 'my-instance@s.whatsapp.net' } } as any,
    webhook as any,
    { warn() {} } as any,
    {
      store: pollStore,
      eventStore,
      instanceId: 'instance-1',
      aggregateVotesFn: () => aggregateResult,
    },
  );

  const pollMessage = {
    key: {
      id: 'poll-message-id',
      remoteJid: '556200000000@g.us',
    },
    message: {
      pollCreationMessage: {
        name: 'Qual produto?',
      },
    },
  } as unknown as WAMessage;

  const store = {
    remember() {},
    get(id?: string | null) {
      if (id === 'poll-message-id') return pollMessage;
      return undefined;
    },
    clear() {},
  } as unknown as PollMessageStore;

  let enqueueCalled = false;
  const blockingEventStore = {
    enqueue() {
      enqueueCalled = true;
      throw new Error('should not enqueue');
    },
  } as unknown as BrokerEventStore;

  const blockingWebhook = {
    async emit(): Promise<void> {
      throw new Error('should not emit');
    },
  } as unknown as import('../src/services/webhook.js').WebhookClient;

  const logger = { warn: () => {} } as unknown as pino.Logger;
  const sock = { user: { id: 'device@s.whatsapp.net' } } as unknown as WASocket;

  const blockingService = new PollService(sock, blockingWebhook, logger, {
    store,
    eventStore: blockingEventStore,
    feedbackTemplate: null,
  });

  const update = {
    key: {},
    messageTimestamp: undefined,
    update: {
      pollUpdates: [
        {
          pollCreationMessageKey: {
            id: 'poll-123',
          },
        },
      ],
    },
  } as unknown as WAMessageUpdate;

  await blockingService.onMessageUpdate([update]);
  assert.equal(enqueueCalled, false, 'expected enqueue not to be called');

  pollStore.remember(pollMessage as any);

  await service.onMessageUpdate([
    {
      key: {
        id: 'update-1',
        remoteJid: '556200000000@g.us',
        participant: '556288888888@s.whatsapp.net',
      },
      update: {
        pollUpdates: [
          {
            pollCreationMessageKey: {
              id: 'poll-message-id',
            },
            pollUpdateMessageKey: {
              id: 'vote-agg-1',
              remoteJid: '556200000000@g.us',
              participant: '556288888888@s.whatsapp.net',
            },
            vote: {
              selectedOptions: [createHash('sha256').update('Produto A').digest()],
            },
          },
        ],
      },
    } as any,
  ]);

  assert.equal(webhook.events.length, 1);
  const event = webhook.events[0];
  assert.equal(event.event, 'POLL_CHOICE');

  const payload = event.payload as any;
  assert.deepStrictEqual(payload.selectedOptions, [
    { id: 'Produto A', text: 'Produto A' },
  ]);
  assert.deepStrictEqual(payload.optionsAggregates, [
    { id: 'Produto A', text: 'Produto A', votes: 2 },
    { id: 'Produto B', text: 'Produto B', votes: 1 },
  ]);
  assert.deepStrictEqual(payload.aggregates, {
    totalVoters: 3,
    totalVotes: 3,
    optionTotals: [
      { id: 'Produto A', text: 'Produto A', votes: 2 },
      { id: 'Produto B', text: 'Produto B', votes: 1 },
    ],
  });

  const [stored] = eventStore.list({ limit: 1, type: 'POLL_CHOICE' });
  assert.ok(stored, 'event should be stored');
  assert.deepStrictEqual((stored.payload as any).aggregates, payload.aggregates);
});
