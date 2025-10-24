import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { proto, WAMessage, WAMessageUpdate, WASocket } from '@whiskeysockets/baileys';
import type pino from 'pino';

import { PollService } from '../src/baileys/pollService.js';
import { PollMessageStore } from '../src/baileys/store.js';
import { BrokerEventStore } from '../src/broker/eventStore.js';

function buildPollMessage(): WAMessage {
  return {
    key: {
      id: 'poll-123',
      remoteJid: '556299999999@g.us',
    },
    messageTimestamp: 1_700_000_000,
    message: {
      pollCreationMessage: {
        name: 'Qual produto?',
        options: [
          { optionName: 'Produto A' },
          { optionName: 'Produto B' },
        ],
      },
    },
  } as unknown as WAMessage;
}

function buildPollUpdate(): WAMessageUpdate {
  const update: proto.IMessage = {
    pollUpdateMessage: {
      pollCreationMessageKey: {
        id: 'poll-123',
      },
      vote: {
        pollOptionId: 'Produto A',
      },
    },
  };

  return {
    key: {
      id: 'poll-123',
      participant: '556288888888@s.whatsapp.net',
    },
    messageTimestamp: 1_700_000_100,
    update: {
      pollUpdates: [update.pollUpdateMessage],
    },
  } as unknown as WAMessageUpdate;
}

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
});

test('onMessageUpdate ignores updates without messageId metadata', async () => {
  const pollMessage: WAMessage = {
    key: {
      remoteJid: '556299999999@g.us',
    },
    messageTimestamp: 1_700_000_000,
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

class FakeWebhook {
  public readonly events: Array<{ event: string; payload: unknown; options: unknown }> = [];

  async emit(event: string, payload: unknown, options?: unknown): Promise<void> {
    this.events.push({ event, payload, options });
  }
}

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
    get() {
      return pollMessage;
    },
    clear() {},
  } as unknown as PollMessageStore;

  let enqueueCalled = false;
  const eventStore = {
    enqueue() {
      enqueueCalled = true;
      throw new Error('should not enqueue');
    },
  } as unknown as BrokerEventStore;

  const webhook = {
    async emit(): Promise<void> {
      throw new Error('should not emit');
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

  assert.equal(enqueueCalled, false, 'expected enqueue not to be called');
  };

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
