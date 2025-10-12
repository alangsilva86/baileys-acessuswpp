import crypto from 'node:crypto';

export type BrokerEventDirection = 'inbound' | 'outbound' | 'system';

export interface BrokerEventPayload {
  [key: string]: unknown;
}

export interface BrokerEvent {
  id: string;
  sequence: number;
  instanceId: string;
  direction: BrokerEventDirection;
  type: string;
  payload: BrokerEventPayload;
  createdAt: number;
  acknowledged: boolean;
}

export interface BrokerEventListOptions {
  limit?: number;
  after?: string | null;
  instanceId?: string | null;
  type?: string | null;
  direction?: BrokerEventDirection | null;
}

export interface BrokerEventAckResult {
  acknowledged: string[];
  missing: string[];
}

interface EventRecord extends BrokerEvent {}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RETAINED_ACKED_EVENTS = 500;

export class BrokerEventStore {
  private sequence = 0;
  private readonly events: EventRecord[] = [];
  private readonly index = new Map<string, EventRecord>();
  private lastAckAt: number | null = null;

  enqueue(
    event: Omit<BrokerEvent, 'id' | 'sequence' | 'createdAt' | 'acknowledged'> & {
      createdAt?: number;
    },
  ): BrokerEvent {
    const id = crypto.randomUUID();
    const createdAt = event.createdAt ?? Date.now();
    const record: EventRecord = {
      ...event,
      id,
      createdAt,
      sequence: ++this.sequence,
      acknowledged: false,
    };
    this.events.push(record);
    this.index.set(record.id, record);
    this.pruneAcked();
    return { ...record };
  }

  list(options: BrokerEventListOptions = {}): BrokerEvent[] {
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT))
      : DEFAULT_LIMIT;

    let afterSeq = 0;
    if (options.after) {
      const cursor = this.index.get(options.after);
      if (cursor) afterSeq = cursor.sequence;
    }

    const filtered = this.events.filter((event) => {
      if (event.acknowledged) return false;
      if (event.sequence <= afterSeq) return false;
      if (options.instanceId && event.instanceId !== options.instanceId) return false;
      if (options.type && event.type !== options.type) return false;
      if (options.direction && event.direction !== options.direction) return false;
      return true;
    });

    return filtered.slice(0, limit).map((event) => ({ ...event }));
  }

  recent(options: BrokerEventListOptions = {}): BrokerEvent[] {
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(Math.floor(limitRaw), MAX_LIMIT))
      : DEFAULT_LIMIT;

    const results: BrokerEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && results.length < limit; i -= 1) {
      const event = this.events[i];
      if (options.instanceId && event.instanceId !== options.instanceId) continue;
      if (options.type && event.type !== options.type) continue;
      if (options.direction && event.direction !== options.direction) continue;
      results.push({ ...event });
    }

    return results;
  }

  ack(ids: string[]): BrokerEventAckResult {
    const acknowledged: string[] = [];
    const missing: string[] = [];
    const now = Date.now();

    for (const id of ids) {
      const record = this.index.get(id);
      if (!record) {
        missing.push(id);
        continue;
      }
      if (!record.acknowledged) {
        record.acknowledged = true;
        acknowledged.push(id);
      }
    }

    if (acknowledged.length) {
      this.lastAckAt = now;
    }

    this.pruneAcked();

    return { acknowledged, missing };
  }

  metrics(): { pending: number; total: number; lastEventAt: number | null; lastAckAt: number | null } {
    const total = this.events.length;
    const pending = this.events.reduce((acc, event) => (event.acknowledged ? acc : acc + 1), 0);
    const lastEventAt = total ? this.events[this.events.length - 1].createdAt : null;
    return { pending, total, lastEventAt, lastAckAt: this.lastAckAt };
  }

  private pruneAcked(): void {
    const acked = this.events.filter((event) => event.acknowledged);
    if (acked.length <= RETAINED_ACKED_EVENTS) return;
    const toRemove = acked.length - RETAINED_ACKED_EVENTS;
    let removed = 0;
    for (let i = 0; i < this.events.length && removed < toRemove; i += 1) {
      const event = this.events[i];
      if (!event.acknowledged) continue;
      this.index.delete(event.id);
      this.events.splice(i, 1);
      removed += 1;
      i -= 1;
    }
  }
}

export const brokerEventStore = new BrokerEventStore();

export default brokerEventStore;
