import { PIPEDRIVE_REDIS_PREFIX } from './config.js';

const PREFIX = (PIPEDRIVE_REDIS_PREFIX || 'pd').trim() || 'pd';

function join(parts: Array<string | number>): string {
  return parts.map((part) => String(part)).join(':');
}

export function pdKey(...parts: Array<string | number>): string {
  return `${PREFIX}:${join(parts)}`;
}

export const pdKeys = {
  companyConfig: (companyId: number) => pdKey('company', companyId, 'config'),
  companyInstances: (companyId: number) => pdKey('company', companyId, 'instances'),
  instanceCompany: (instanceId: string) => pdKey('instance', instanceId, 'company'),

  convIndex: (companyId: number) => pdKey('conv', 'index', companyId),
  convMeta: (companyId: number, conversationKey: string) => pdKey('conv', companyId, conversationKey),
  convMessages: (companyId: number, conversationKey: string) => pdKey('conv', companyId, conversationKey, 'messages'),
  convMessagePayload: (companyId: number, conversationKey: string, messageId: string) =>
    pdKey('msg', companyId, conversationKey, messageId),

  msgDedupe: (companyId: number, messageId: string) => pdKey('msg', 'dedupe', companyId, messageId),

  noteBlock: (companyId: number, conversationKey: string) => pdKey('note', 'block', companyId, conversationKey),
  noteContent: (companyId: number, noteId: number) => pdKey('note', 'content', companyId, noteId),
  notePending: (companyId: number, conversationKey: string) => pdKey('note', 'pending', companyId, conversationKey),
  noteProcessing: (companyId: number, conversationKey: string) => pdKey('note', 'processing', companyId, conversationKey),
  noteFlushScheduled: (companyId: number, conversationKey: string) =>
    pdKey('note', 'flush', 'scheduled', companyId, conversationKey),

  lock: (companyId: number, conversationKey: string) => pdKey('lock', companyId, conversationKey),

  metricsHash: (companyId: number | 'global') => pdKey('metrics', companyId),
} as const;

