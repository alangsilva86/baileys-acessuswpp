import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolvePipedriveDataDir } from './dataDir.js';
import {
  PIPEDRIVE_MAX_CONVERSATIONS,
  PIPEDRIVE_MAX_MESSAGES,
} from './config.js';
import type {
  PipedriveConversation,
  PipedriveMessage,
  PipedriveParticipant,
} from './types.js';

const DATA_DIR = resolvePipedriveDataDir();
const TOKENS_FILE = path.join(DATA_DIR, 'pipedrive-oauth.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'pipedrive-channels.json');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'pipedrive-conversations.json');

const SAVE_DEBOUNCE_MS = 500;

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return fallback;
    return fallback;
  }
}

async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIso(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function hashId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function getSourceUserId(providerChannelId: string): string {
  return `source:${providerChannelId}`;
}

export interface PipedriveOAuthToken {
  id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  api_domain: string | null;
  company_id: number | null;
  user_id: number | null;
  scope: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenStoreData {
  version: number;
  tokens: PipedriveOAuthToken[];
}

const defaultTokenStore: TokenStoreData = { version: 1, tokens: [] };
let tokenStoreCache: TokenStoreData | null = null;

async function loadTokenStore(): Promise<TokenStoreData> {
  if (tokenStoreCache) return tokenStoreCache;
  tokenStoreCache = await readJson<TokenStoreData>(TOKENS_FILE, defaultTokenStore);
  if (!tokenStoreCache.tokens) tokenStoreCache.tokens = [];
  return tokenStoreCache;
}

async function saveTokenStore(): Promise<void> {
  if (!tokenStoreCache) return;
  await writeJson(TOKENS_FILE, tokenStoreCache);
}

function buildTokenId(token: Partial<PipedriveOAuthToken>): string {
  if (typeof token.company_id === 'number') return `company:${token.company_id}`;
  if (token.api_domain) return `domain:${token.api_domain}`;
  if (typeof token.user_id === 'number') return `user:${token.user_id}`;
  if (token.access_token) return `token:${hashId(token.access_token)}`;
  return `token:${hashId(JSON.stringify(token))}`;
}

export async function upsertToken(record: Omit<PipedriveOAuthToken, 'id' | 'created_at' | 'updated_at'> & { id?: string }): Promise<PipedriveOAuthToken> {
  const store = await loadTokenStore();
  const id = record.id ?? buildTokenId(record);
  const now = nowIso();
  const existingIndex = store.tokens.findIndex((token) => token.id === id);
  const normalized: PipedriveOAuthToken = {
    id,
    access_token: record.access_token,
    refresh_token: record.refresh_token ?? null,
    expires_at: record.expires_at ?? null,
    api_domain: record.api_domain ?? null,
    company_id: record.company_id ?? null,
    user_id: record.user_id ?? null,
    scope: record.scope ?? null,
    created_at: existingIndex >= 0 ? store.tokens[existingIndex].created_at : now,
    updated_at: now,
  };

  if (existingIndex >= 0) {
    store.tokens[existingIndex] = normalized;
  } else {
    store.tokens.push(normalized);
  }

  await saveTokenStore();
  return normalized;
}

export async function listTokens(): Promise<PipedriveOAuthToken[]> {
  const store = await loadTokenStore();
  return [...store.tokens];
}

export async function getLatestToken(): Promise<PipedriveOAuthToken | null> {
  const store = await loadTokenStore();
  if (!store.tokens.length) return null;
  const sorted = [...store.tokens].sort((a, b) => {
    const at = new Date(a.updated_at).getTime();
    const bt = new Date(b.updated_at).getTime();
    return bt - at;
  });
  return sorted[0] ?? null;
}

export async function getTokenByCompanyId(companyId: number | null | undefined): Promise<PipedriveOAuthToken | null> {
  if (companyId == null) return null;
  const store = await loadTokenStore();
  return store.tokens.find((token) => token.company_id === companyId) ?? null;
}

export async function getTokenByApiDomain(apiDomain: string | null | undefined): Promise<PipedriveOAuthToken | null> {
  if (!apiDomain) return null;
  const store = await loadTokenStore();
  return store.tokens.find((token) => token.api_domain === apiDomain) ?? null;
}

export async function removeTokenById(id: string): Promise<void> {
  const store = await loadTokenStore();
  store.tokens = store.tokens.filter((token) => token.id !== id);
  await saveTokenStore();
}

export interface PipedriveChannelRecord {
  id: string;
  provider_channel_id: string;
  name: string;
  provider_type: string;
  template_support: boolean;
  avatar_url: string | null;
  company_id: number | null;
  api_domain: string | null;
  created_at: string;
  updated_at: string;
}

interface ChannelStoreData {
  version: number;
  channels: PipedriveChannelRecord[];
}

const defaultChannelStore: ChannelStoreData = { version: 1, channels: [] };
let channelStoreCache: ChannelStoreData | null = null;

async function loadChannelStore(): Promise<ChannelStoreData> {
  if (channelStoreCache) return channelStoreCache;
  channelStoreCache = await readJson<ChannelStoreData>(CHANNELS_FILE, defaultChannelStore);
  if (!channelStoreCache.channels) channelStoreCache.channels = [];
  return channelStoreCache;
}

async function saveChannelStore(): Promise<void> {
  if (!channelStoreCache) return;
  await writeJson(CHANNELS_FILE, channelStoreCache);
}

export async function upsertChannel(record: Omit<PipedriveChannelRecord, 'created_at' | 'updated_at'>): Promise<PipedriveChannelRecord> {
  const store = await loadChannelStore();
  const now = nowIso();
  const existingIndex = store.channels.findIndex(
    (channel) => channel.provider_channel_id === record.provider_channel_id,
  );
  const normalized: PipedriveChannelRecord = {
    ...record,
    created_at: existingIndex >= 0 ? store.channels[existingIndex].created_at : now,
    updated_at: now,
  };
  if (existingIndex >= 0) {
    store.channels[existingIndex] = normalized;
  } else {
    store.channels.push(normalized);
  }
  await saveChannelStore();
  return normalized;
}

export async function listChannels(): Promise<PipedriveChannelRecord[]> {
  const store = await loadChannelStore();
  return [...store.channels];
}

export async function getChannelByProviderId(providerChannelId: string): Promise<PipedriveChannelRecord | null> {
  const store = await loadChannelStore();
  return store.channels.find((channel) => channel.provider_channel_id === providerChannelId) ?? null;
}

export async function getChannelById(channelId: string): Promise<PipedriveChannelRecord | null> {
  const store = await loadChannelStore();
  return store.channels.find((channel) => channel.id === channelId) ?? null;
}

export async function removeChannelByProviderId(providerChannelId: string): Promise<void> {
  const store = await loadChannelStore();
  store.channels = store.channels.filter((channel) => channel.provider_channel_id !== providerChannelId);
  await saveChannelStore();
}

export async function removeConversationsByProviderId(providerChannelId: string): Promise<void> {
  const data = await loadConversationStore();
  if (data.channels[providerChannelId]) {
    delete data.channels[providerChannelId];
    scheduleConversationSave();
  }
}

interface StoredMessage extends PipedriveMessage {
  direction?: 'inbound' | 'outbound';
}

interface StoredConversation {
  id: string;
  link: string | null;
  status: 'open' | 'closed';
  seen: boolean;
  participants: PipedriveParticipant[];
  messages: StoredMessage[];
  created_at: string;
  updated_at: string;
}

interface ConversationStoreData {
  version: number;
  channels: Record<string, Record<string, StoredConversation>>;
}

const defaultConversationStore: ConversationStoreData = { version: 1, channels: {} };
let conversationStoreCache: ConversationStoreData | null = null;
let conversationSaveTimer: NodeJS.Timeout | null = null;

async function loadConversationStore(): Promise<ConversationStoreData> {
  if (conversationStoreCache) return conversationStoreCache;
  conversationStoreCache = await readJson<ConversationStoreData>(CONVERSATIONS_FILE, defaultConversationStore);
  if (!conversationStoreCache.channels) conversationStoreCache.channels = {};
  return conversationStoreCache;
}

function scheduleConversationSave(): void {
  if (conversationSaveTimer) return;
  conversationSaveTimer = setTimeout(() => {
    conversationSaveTimer = null;
    void saveConversationStore();
  }, SAVE_DEBOUNCE_MS);
}

async function saveConversationStore(): Promise<void> {
  if (!conversationStoreCache) return;
  await writeJson(CONVERSATIONS_FILE, conversationStoreCache);
}

function getChannelBucket(data: ConversationStoreData, providerChannelId: string): Record<string, StoredConversation> {
  if (!data.channels[providerChannelId]) {
    data.channels[providerChannelId] = {};
  }
  return data.channels[providerChannelId];
}

function normalizeMessageText(message: PipedriveMessage): string {
  if (typeof message.message === 'string' && message.message.trim()) return message.message;
  return 'Mensagem sem texto';
}

function mergeParticipants(
  existing: PipedriveParticipant[],
  updates: PipedriveParticipant[],
): PipedriveParticipant[] {
  const map = new Map<string, PipedriveParticipant>();
  for (const participant of existing) {
    map.set(participant.id, { ...participant });
  }
  for (const update of updates) {
    if (!update?.id) continue;
    const current = map.get(update.id);
    if (!current) {
      map.set(update.id, { ...update });
      continue;
    }
    map.set(update.id, {
      ...current,
      ...update,
      name: update.name || current.name,
      role: update.role || current.role,
      avatar_url: update.avatar_url ?? current.avatar_url,
      avatar_expires: update.avatar_expires ?? current.avatar_expires,
      fetch_avatar: update.fetch_avatar ?? current.fetch_avatar,
    });
  }
  return Array.from(map.values());
}

function trimMessages(messages: StoredMessage[]): StoredMessage[] {
  if (messages.length <= PIPEDRIVE_MAX_MESSAGES) return messages;
  const sorted = [...messages].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    return at - bt;
  });
  return sorted.slice(-PIPEDRIVE_MAX_MESSAGES);
}

function trimConversations(conversations: Record<string, StoredConversation>): void {
  const entries = Object.entries(conversations);
  if (entries.length <= PIPEDRIVE_MAX_CONVERSATIONS) return;
  const sorted = entries.sort(([, a], [, b]) => {
    const at = new Date(a.updated_at).getTime();
    const bt = new Date(b.updated_at).getTime();
    return bt - at;
  });
  const keep = new Set(sorted.slice(0, PIPEDRIVE_MAX_CONVERSATIONS).map(([id]) => id));
  for (const [id] of entries) {
    if (!keep.has(id)) delete conversations[id];
  }
}

export async function upsertConversationMessage(options: {
  providerChannelId: string;
  conversationId: string;
  message: PipedriveMessage;
  participants: PipedriveParticipant[];
  link?: string | null;
  seen?: boolean;
  direction?: 'inbound' | 'outbound';
}): Promise<void> {
  const data = await loadConversationStore();
  const bucket = getChannelBucket(data, options.providerChannelId);
  const now = nowIso();
  const existing = bucket[options.conversationId];

  const sanitizedMessage: StoredMessage = {
    ...options.message,
    created_at: normalizeIso(options.message.created_at, now),
    message: normalizeMessageText(options.message),
    attachments: options.message.attachments ?? [],
    direction: options.direction,
  };

  const messages = existing ? [...existing.messages] : [];
  const existingIndex = messages.findIndex((message) => message.id === sanitizedMessage.id);
  if (existingIndex >= 0) {
    messages[existingIndex] = { ...messages[existingIndex], ...sanitizedMessage };
  } else {
    messages.push(sanitizedMessage);
  }

  const mergedParticipants = mergeParticipants(existing?.participants ?? [], options.participants);
  const normalizedMessages = trimMessages(messages);

  bucket[options.conversationId] = {
    id: options.conversationId,
    link: options.link ?? existing?.link ?? null,
    status: existing?.status ?? 'open',
    seen: typeof options.seen === 'boolean' ? options.seen : existing?.seen ?? false,
    participants: mergedParticipants,
    messages: normalizedMessages,
    created_at: existing?.created_at ?? now,
    updated_at: sanitizedMessage.created_at || now,
  };

  trimConversations(bucket);
  scheduleConversationSave();
}

function buildMessagePage(
  messages: StoredMessage[],
  limit: number,
  after?: string | null,
): { items: PipedriveMessage[]; nextCursor: string | null } {
  if (!messages.length) return { items: [], nextCursor: null };
  const sorted = [...messages].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    return at - bt;
  });

  let endIndex = sorted.length;
  if (after) {
    const idx = sorted.findIndex((message) => message.id === after);
    if (idx >= 0) endIndex = idx;
  }

  const startIndex = Math.max(0, endIndex - limit);
  const page = sorted.slice(startIndex, endIndex).map((message) => {
    const { direction, ...rest } = message;
    return rest;
  });
  const nextCursor = startIndex > 0 ? sorted[startIndex].id : null;
  return { items: page, nextCursor };
}

export async function listConversations(options: {
  providerChannelId: string;
  limit: number;
  after?: string | null;
  messagesLimit: number;
}): Promise<{ items: PipedriveConversation[]; nextAfter: string | null }>{
  const data = await loadConversationStore();
  const bucket = getChannelBucket(data, options.providerChannelId);
  const entries = Object.values(bucket);
  const sorted = entries.sort((a, b) => {
    const at = new Date(a.updated_at).getTime();
    const bt = new Date(b.updated_at).getTime();
    return bt - at;
  });

  let startIndex = 0;
  if (options.after) {
    const idx = sorted.findIndex((conversation) => conversation.id === options.after);
    if (idx >= 0) startIndex = idx + 1;
  }

  const slice = sorted.slice(startIndex, startIndex + options.limit);
  const items = slice.map((conversation) => {
    const page = buildMessagePage(conversation.messages, options.messagesLimit);
    return {
      id: conversation.id,
      link: conversation.link ?? undefined,
      status: conversation.status,
      seen: conversation.seen,
      next_messages_cursor: page.nextCursor ?? undefined,
      messages: page.items,
      participants: conversation.participants,
    } as PipedriveConversation;
  });

  const nextAfter = startIndex + options.limit < sorted.length
    ? sorted[startIndex + options.limit - 1]?.id ?? null
    : null;

  return { items, nextAfter };
}

export async function getConversation(options: {
  providerChannelId: string;
  conversationId: string;
  messagesLimit: number;
  after?: string | null;
}): Promise<PipedriveConversation | null> {
  const data = await loadConversationStore();
  const bucket = getChannelBucket(data, options.providerChannelId);
  const conversation = bucket[options.conversationId];
  if (!conversation) return null;
  const page = buildMessagePage(conversation.messages, options.messagesLimit, options.after ?? null);
  return {
    id: conversation.id,
    link: conversation.link ?? undefined,
    status: conversation.status,
    seen: conversation.seen,
    next_messages_cursor: page.nextCursor ?? undefined,
    messages: page.items,
    participants: conversation.participants,
  } as PipedriveConversation;
}

export async function findMessage(options: {
  providerChannelId: string;
  conversationId?: string | null;
  messageId: string;
}): Promise<PipedriveMessage | null> {
  const data = await loadConversationStore();
  const bucket = getChannelBucket(data, options.providerChannelId);

  const findInConversation = (conversation: StoredConversation): PipedriveMessage | null => {
    const found = conversation.messages.find((message) => message.id === options.messageId);
    if (!found) return null;
    const { direction, ...rest } = found;
    return rest;
  };

  if (options.conversationId) {
    const conversation = bucket[options.conversationId];
    if (!conversation) return null;
    return findInConversation(conversation);
  }

  for (const conversation of Object.values(bucket)) {
    const found = findInConversation(conversation);
    if (found) return found;
  }

  return null;
}

export async function findParticipant(options: {
  providerChannelId: string;
  participantId: string;
}): Promise<PipedriveParticipant | null> {
  const data = await loadConversationStore();
  const bucket = getChannelBucket(data, options.providerChannelId);
  for (const conversation of Object.values(bucket)) {
    const match = conversation.participants.find((participant) => participant.id === options.participantId);
    if (match) return match;
  }
  return null;
}
