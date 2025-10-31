import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForAck } from '../src/utils.js';
import type { Instance } from '../src/instanceManager.js';

function createInstanceStub(): Instance {
  return {
    id: 'inst-1',
    name: 'Instance 1',
    dir: '/tmp',
    sock: null,
    socketId: 0,
    lastQR: null,
    qrVersion: 0,
    reconnectDelay: 0,
    stopping: false,
    reconnectTimer: null,
    metadata: { note: '', createdAt: null, updatedAt: null },
    metrics: {
      startedAt: Date.now(),
      sent: 0,
      sent_by_type: { text: 0, image: 0, video: 0, audio: 0, document: 0, group: 0, buttons: 0, lists: 0 },
      status_counts: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      last: { sentId: null, lastStatusId: null, lastStatusCode: null },
      timeline: [],
    },
    statusMap: new Map(),
    statusTimestamps: new Map(),
    statusCleanupTimer: null,
    ackWaiters: new Map(),
    rateWindow: [],
    context: null,
    connectionState: 'open',
    connectionUpdatedAt: null,
    phoneNumber: null,
  } as unknown as Instance;
}

test('waitForAck returns 0 when no status information is available', async () => {
  const inst = createInstanceStub();
  const result = await waitForAck(inst, 'missing-id');
  assert.equal(result, 0);
});

test('waitForAck returns last recorded status when matching metrics entry', async () => {
  const inst = createInstanceStub();
  inst.metrics.last.lastStatusId = 'status-2';
  inst.metrics.last.lastStatusCode = 2;
  const result = await waitForAck(inst, 'status-2');
  assert.equal(result, 2);
});

test('waitForAck returns current status from statusMap when present', async () => {
  const inst = createInstanceStub();
  inst.statusMap.set('delivered', 3);
  const result = await waitForAck(inst, 'delivered');
  assert.equal(result, 3);
});
