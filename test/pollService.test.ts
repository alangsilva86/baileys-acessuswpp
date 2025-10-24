import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PollService } from '../src/baileys/pollService.js';
import { PollMessageStore } from '../src/baileys/store.js';
import { BrokerEventStore } from '../src/broker/eventStore.js';

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
