import crypto from 'node:crypto';
import type IORedis from 'ioredis';
import {
  PIPEDRIVE_LOCAL_MESSAGES_TTL_DAYS,
  PIPEDRIVE_MESSAGE_DEDUPE_TTL_DAYS,
} from './config.js';
import { pdKeys } from './redisKeys.js';

export type PipedriveUiMessageDirection = 'inbound' | 'outbound';

export interface PipedriveCompanyConfig {
  enabled: boolean;
  default_instance_id: string | null;
  api_domain: string | null;
  updated_at_iso: string | null;
  person_field_keys?: Record<string, string>;
  deal_field_keys?: Record<string, string>;
}

export interface PipedriveUiConversationSummary {
  key: string;
  person_id: number | null;
  deal_id: number | null;
  last_message_at_iso: string | null;
  last_direction: PipedriveUiMessageDirection | null;
  last_preview: string | null;
  unread_count: number;
}

export interface PipedriveUiMessage {
  id: string;
  ts_ms: number;
  created_at_iso: string;
  direction: PipedriveUiMessageDirection;
  text: string;
  instance_id?: string | null;
}

const TTL_MESSAGES_SECONDS = Math.max(1, Math.floor(PIPEDRIVE_LOCAL_MESSAGES_TTL_DAYS * 86_400));
const TTL_DEDUPE_SECONDS = Math.max(1, Math.floor(PIPEDRIVE_MESSAGE_DEDUPE_TTL_DAYS * 86_400));
const MAX_MESSAGES_PER_CONVERSATION = 500;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIso(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function normalizePreview(text: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'Mensagem sem texto';
  if (trimmed.length <= 160) return trimmed;
  return `${trimmed.slice(0, 157)}…`;
}

const LUA_COMPARE_AND_DEL = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const LUA_DEDUPE_ENQUEUE = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "EX", ARGV[2]) then
  redis.call("RPUSH", KEYS[2], ARGV[3])
  return 1
end
return 0
`;

export class PipedriveRedisStore {
  constructor(private readonly redis: IORedis) {}

  async setConversationMeta(companyId: number, conversationKey: string, patch: Record<string, string | number | null>): Promise<void> {
    const key = pdKeys.convMeta(companyId, conversationKey);
    const normalized: Record<string, string> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (value == null) {
        normalized[field] = '';
      } else if (typeof value === 'number') {
        normalized[field] = Number.isFinite(value) ? String(value) : '';
      } else {
        normalized[field] = String(value);
      }
    }
    if (Object.keys(normalized).length) {
      const multi = this.redis.multi();
      multi.hset(key, normalized);
      multi.expire(key, TTL_MESSAGES_SECONDS);
      await multi.exec();
    }
  }

  async getPendingLength(companyId: number, conversationKey: string): Promise<number> {
    return await this.redis.llen(pdKeys.notePending(companyId, conversationKey));
  }

  async listProcessingPayloads(companyId: number, conversationKey: string): Promise<string[]> {
    return await this.redis.lrange(pdKeys.noteProcessing(companyId, conversationKey), 0, -1);
  }

  async getCompanyConfig(companyId: number): Promise<PipedriveCompanyConfig> {
    const key = pdKeys.companyConfig(companyId);
    const raw = await this.redis.hgetall(key);
    const enabled = raw.enabled ? raw.enabled === '1' || raw.enabled.toLowerCase() === 'true' : true;
    const default_instance_id = raw.default_instance_id?.trim() ? raw.default_instance_id.trim() : null;
    const api_domain = raw.api_domain?.trim() ? raw.api_domain.trim() : null;
    const updated_at_iso = toIso(raw.updated_at_iso) ?? null;
    let person_field_keys: Record<string, string> | undefined;
    let deal_field_keys: Record<string, string> | undefined;
    try {
      if (raw.person_field_keys) {
        const parsed = JSON.parse(raw.person_field_keys);
        if (parsed && typeof parsed === 'object') person_field_keys = parsed as any;
      }
    } catch {
      person_field_keys = undefined;
    }
    try {
      if (raw.deal_field_keys) {
        const parsed = JSON.parse(raw.deal_field_keys);
        if (parsed && typeof parsed === 'object') deal_field_keys = parsed as any;
      }
    } catch {
      deal_field_keys = undefined;
    }
    return { enabled, default_instance_id, api_domain, updated_at_iso, person_field_keys, deal_field_keys };
  }

  async setCompanyConfig(companyId: number, patch: Partial<PipedriveCompanyConfig>): Promise<PipedriveCompanyConfig> {
    const key = pdKeys.companyConfig(companyId);
    const next: Record<string, string> = {};
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled ? '1' : '0';
    if (patch.default_instance_id !== undefined) next.default_instance_id = patch.default_instance_id ?? '';
    if (patch.api_domain !== undefined) next.api_domain = patch.api_domain ?? '';
    if (patch.updated_at_iso !== undefined) next.updated_at_iso = patch.updated_at_iso ?? '';
    if (patch.person_field_keys !== undefined) next.person_field_keys = JSON.stringify(patch.person_field_keys ?? {});
    if (patch.deal_field_keys !== undefined) next.deal_field_keys = JSON.stringify(patch.deal_field_keys ?? {});
    if (Object.keys(next).length) {
      await this.redis.hset(key, next);
    }
    return this.getCompanyConfig(companyId);
  }

  async listCompanyInstances(companyId: number): Promise<string[]> {
    const key = pdKeys.companyInstances(companyId);
    const members = await this.redis.smembers(key);
    return members.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
  }

  async getInstanceCompany(instanceId: string): Promise<number | null> {
    const key = pdKeys.instanceCompany(instanceId);
    const raw = await this.redis.get(key);
    const id = toNumber(raw);
    return id && id > 0 ? id : null;
  }

  async linkInstanceToCompany(options: {
    companyId: number;
    instanceId: string;
    apiDomain?: string | null;
    makeDefault?: boolean;
  }): Promise<PipedriveCompanyConfig> {
    const { companyId, instanceId } = options;
    const existingCompany = await this.getInstanceCompany(instanceId);
    if (existingCompany && existingCompany !== companyId) {
      throw new Error('instance_already_linked_to_another_company');
    }
    const now = new Date().toISOString();
    const multi = this.redis.multi();
    multi.set(pdKeys.instanceCompany(instanceId), String(companyId));
    multi.sadd(pdKeys.companyInstances(companyId), instanceId);
    const patch: Record<string, string> = { enabled: '1', updated_at_iso: now };
    if (options.apiDomain) patch.api_domain = options.apiDomain;
    if (options.makeDefault) patch.default_instance_id = instanceId;
    multi.hset(pdKeys.companyConfig(companyId), patch);
    await multi.exec();
    return this.getCompanyConfig(companyId);
  }

  async upsertConversationMessage(options: {
    companyId: number;
    conversationKey: string;
    message: PipedriveUiMessage;
    personId?: number | null;
    dealId?: number | null;
    incrementUnread?: boolean;
  }): Promise<void> {
    const { companyId, conversationKey } = options;
    const metaKey = pdKeys.convMeta(companyId, conversationKey);
    const indexKey = pdKeys.convIndex(companyId);
    const messagesKey = pdKeys.convMessages(companyId, conversationKey);
    const msgKey = pdKeys.convMessagePayload(companyId, conversationKey, options.message.id);

    const preview = normalizePreview(options.message.text);
    const nowIso = new Date().toISOString();

    const pipeline = this.redis.multi();
    pipeline.zadd(indexKey, options.message.ts_ms, conversationKey);
    pipeline.zadd(messagesKey, options.message.ts_ms, options.message.id);
    pipeline.set(msgKey, JSON.stringify(options.message), 'EX', TTL_MESSAGES_SECONDS);
    pipeline.expire(messagesKey, TTL_MESSAGES_SECONDS);
    pipeline.expire(metaKey, TTL_MESSAGES_SECONDS);

    const metaPatch: Record<string, string> = {
      last_message_at_iso: options.message.created_at_iso,
      last_direction: options.message.direction,
      last_preview: preview,
      updated_at_iso: nowIso,
    };
    if (typeof options.personId === 'number') metaPatch.person_id = String(options.personId);
    if (typeof options.dealId === 'number') metaPatch.deal_id = String(options.dealId);
    if (options.incrementUnread) {
      pipeline.hincrby(metaKey, 'unread_count', 1);
    }
    pipeline.hset(metaKey, metaPatch);

    // Trim messages
    pipeline.zremrangebyrank(messagesKey, 0, -(MAX_MESSAGES_PER_CONVERSATION + 1));

    await pipeline.exec();
  }

  async listConversations(options: {
    companyId: number;
    limit: number;
    cursor?: string | null;
  }): Promise<{ items: PipedriveUiConversationSummary[]; nextCursor: string | null }> {
    const { companyId } = options;
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit)));
    const offset = options.cursor ? Math.max(0, Math.floor(Number(options.cursor) || 0)) : 0;
    const indexKey = pdKeys.convIndex(companyId);

    const total = await this.redis.zcard(indexKey);
    if (!total) return { items: [], nextCursor: null };

    const keys = await this.redis.zrevrange(indexKey, offset, offset + limit - 1);
    if (!keys.length) return { items: [], nextCursor: null };

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.hgetall(pdKeys.convMeta(companyId, key));
    }
    const raw = await pipeline.exec();

    const items: PipedriveUiConversationSummary[] = [];
    keys.forEach((key, idx) => {
      const entry = raw?.[idx]?.[1] as Record<string, string> | undefined;
      if (!entry || !Object.keys(entry).length) return;
      items.push({
        key,
        person_id: toNumber(entry.person_id),
        deal_id: toNumber(entry.deal_id),
        last_message_at_iso: toIso(entry.last_message_at_iso),
        last_direction: entry.last_direction === 'inbound' || entry.last_direction === 'outbound' ? (entry.last_direction as any) : null,
        last_preview: entry.last_preview?.trim() ? entry.last_preview.trim() : null,
        unread_count: Math.max(0, Math.floor(toNumber(entry.unread_count) ?? 0)),
      });
    });

    const nextCursor = offset + limit < total ? String(offset + limit) : null;
    return { items, nextCursor };
  }

  async listConversationMessages(options: {
    companyId: number;
    conversationKey: string;
    limit: number;
    beforeTsMs?: number | null;
  }): Promise<{ items: PipedriveUiMessage[]; nextBeforeTsMs: number | null }> {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit)));
    const messagesKey = pdKeys.convMessages(options.companyId, options.conversationKey);

    const max = options.beforeTsMs != null && Number.isFinite(options.beforeTsMs)
      ? Math.floor(options.beforeTsMs) - 1
      : '+inf';

    const ids = await this.redis.zrevrangebyscore(messagesKey, max as any, '-inf', 'LIMIT', 0, limit);
    if (!ids.length) return { items: [], nextBeforeTsMs: null };

    const pipeline = this.redis.pipeline();
    ids.forEach((id) => {
      pipeline.get(pdKeys.convMessagePayload(options.companyId, options.conversationKey, id));
    });
    const raw = await pipeline.exec();
    const items = raw
      .map((row) => row?.[1])
      .filter(Boolean)
      .map((value) => {
        try {
          return JSON.parse(String(value)) as PipedriveUiMessage;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as PipedriveUiMessage[];

    const sorted = items.sort((a, b) => a.ts_ms - b.ts_ms);
    const nextBeforeTsMs = sorted.length ? sorted[0]!.ts_ms : null;
    return { items: sorted, nextBeforeTsMs };
  }

  async tryEnqueueNoteEvent(options: {
    companyId: number;
    conversationKey: string;
    messageId: string;
    payloadJson: string;
  }): Promise<boolean> {
    const dedupeKey = pdKeys.msgDedupe(options.companyId, options.messageId);
    const pendingKey = pdKeys.notePending(options.companyId, options.conversationKey);
    const value = '1';
    const enqueued = await this.redis.eval(
      LUA_DEDUPE_ENQUEUE,
      2,
      dedupeKey,
      pendingKey,
      value,
      String(TTL_DEDUPE_SECONDS),
      options.payloadJson,
    );
    return Number(enqueued) === 1;
  }

  async scheduleNoteFlush(options: { companyId: number; conversationKey: string; ttlSeconds: number }): Promise<boolean> {
    const key = pdKeys.noteFlushScheduled(options.companyId, options.conversationKey);
    const res = await this.redis.set(
      key,
      '1',
      'EX',
      Math.max(1, Math.floor(options.ttlSeconds)),
      'NX',
    );
    return Boolean(res);
  }

  async clearNoteFlushSchedule(companyId: number, conversationKey: string): Promise<void> {
    await this.redis.del(pdKeys.noteFlushScheduled(companyId, conversationKey));
  }

  async acquireLock(options: { companyId: number; conversationKey: string; ttlSeconds?: number }): Promise<string | null> {
    const key = pdKeys.lock(options.companyId, options.conversationKey);
    const token = crypto.randomUUID();
    const ttl = Math.max(1, Math.floor(options.ttlSeconds ?? 30));
    const res = await this.redis.set(key, token, 'EX', ttl, 'NX');
    return res ? token : null;
  }

  async releaseLock(options: { companyId: number; conversationKey: string; token: string }): Promise<void> {
    const key = pdKeys.lock(options.companyId, options.conversationKey);
    try {
      await this.redis.eval(LUA_COMPARE_AND_DEL, 1, key, options.token);
    } catch {
      // ignore
    }
  }

  async movePendingToProcessing(options: { companyId: number; conversationKey: string; max?: number }): Promise<string[]> {
    const pendingKey = pdKeys.notePending(options.companyId, options.conversationKey);
    const processingKey = pdKeys.noteProcessing(options.companyId, options.conversationKey);
    const batch: string[] = [];
    const max = Math.max(1, Math.floor(options.max ?? 200));
    for (let i = 0; i < max; i += 1) {
      const item = await this.redis.rpoplpush(pendingKey, processingKey);
      if (!item) break;
      batch.push(item);
    }
    if (batch.length) {
      await this.redis.expire(processingKey, 600);
    }
    return batch;
  }

  async requeueProcessing(options: { companyId: number; conversationKey: string; payloads: string[] }): Promise<void> {
    if (!options.payloads.length) return;
    const pendingKey = pdKeys.notePending(options.companyId, options.conversationKey);
    const processingKey = pdKeys.noteProcessing(options.companyId, options.conversationKey);
    const multi = this.redis.multi();
    multi.rpush(pendingKey, ...options.payloads);
    multi.del(processingKey);
    await multi.exec();
  }

  async clearProcessing(companyId: number, conversationKey: string): Promise<void> {
    await this.redis.del(pdKeys.noteProcessing(companyId, conversationKey));
  }

  async getNoteBlock(companyId: number, conversationKey: string): Promise<Record<string, string>> {
    return await this.redis.hgetall(pdKeys.noteBlock(companyId, conversationKey));
  }

  async setNoteBlock(companyId: number, conversationKey: string, patch: Record<string, string>): Promise<void> {
    const key = pdKeys.noteBlock(companyId, conversationKey);
    const multi = this.redis.multi();
    multi.hset(key, patch);
    multi.expire(key, TTL_MESSAGES_SECONDS);
    await multi.exec();
  }

  async getNoteContent(companyId: number, noteId: number): Promise<string | null> {
    const raw = await this.redis.get(pdKeys.noteContent(companyId, noteId));
    return raw && raw.trim() ? raw : null;
  }

  async setNoteContent(companyId: number, noteId: number, html: string): Promise<void> {
    const key = pdKeys.noteContent(companyId, noteId);
    await this.redis.set(key, html, 'EX', TTL_MESSAGES_SECONDS);
  }

  async incrMetric(companyId: number | 'global', metric: string, by = 1): Promise<void> {
    const key = pdKeys.metricsHash(companyId);
    await this.redis.hincrby(key, metric, Math.floor(by));
  }

  async setMetricFields(companyId: number | 'global', fields: Record<string, string>): Promise<void> {
    const key = pdKeys.metricsHash(companyId);
    await this.redis.hset(key, fields);
  }

  async getMetricFields(companyId: number | 'global'): Promise<Record<string, string>> {
    const key = pdKeys.metricsHash(companyId);
    return await this.redis.hgetall(key);
  }
}
