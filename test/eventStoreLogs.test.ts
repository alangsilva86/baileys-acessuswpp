import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BrokerEventStore } from '../src/broker/eventStore.js';

test('BrokerEventStore.recent returns latest events including acked ones', () => {
  const store = new BrokerEventStore();

  const first = store.enqueue({
    instanceId: 'inst-1',
    direction: 'inbound',
    type: 'MESSAGE_INBOUND',
    payload: { message: { text: 'Olá' } },
  });

  const second = store.enqueue({
    instanceId: 'inst-1',
    direction: 'outbound',
    type: 'MESSAGE_OUTBOUND',
    payload: { message: { text: 'Resposta' } },
  });

  const third = store.enqueue({
    instanceId: 'inst-1',
    direction: 'outbound',
    type: 'MESSAGE_OUTBOUND',
    payload: { message: { text: 'Seguimos à disposição' } },
  });

  // Reconhece apenas o primeiro evento para garantir que eventos acked também aparecem
  store.ack([first.id]);

  const recent = store.recent({ instanceId: 'inst-1', limit: 3 });
  assert.equal(recent.length, 3);

  // Deve retornar do mais recente para o mais antigo
  assert.deepStrictEqual(
    recent.map((event) => event.id),
    [third.id, second.id, first.id],
  );

  const ackedEntry = recent.find((event) => event.id === first.id);
  assert.ok(ackedEntry, 'acked entry should be present in recent list');
  assert.equal(ackedEntry.acknowledged, true);
});
