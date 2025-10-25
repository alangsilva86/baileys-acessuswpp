import { createHash } from 'crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { pollMetadataStore, type PollMetadataRecord } from './pollMetadataStore.js';

export interface PollOptionMetadata {
  id: string;
  text: string;
  hash: string;
}

export interface PollMetadata {
  pollId: string;
  question: string;
  options: PollOptionMetadata[];
  remoteJid?: string | null;
  encKeyHex?: string | null;
  selectableCount?: number | null;
}

interface VoteSelection {
  pollId: string;
  question: string;
  selectedOptions: Array<{ id: string | null; text: string | null }>;
}

const pollMetadataCache = new Map<string, PollMetadata>();
const pollIdToCacheKeys = new Map<string, Set<string>>();
const voteSelections = new Map<string, VoteSelection>();

export function normalizeJid(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const [base] = trimmed.split(':');
  return base || null;
}

function buildPollKey(
  pollId: string | null | undefined,
  remoteJid: string | null | undefined,
): string | null {
  if (!pollId) return null;
  const normalizedRemote = normalizeJid(remoteJid);
  const prefix = normalizedRemote ?? '';
  return `${prefix}#${pollId}`;
}

function registerCacheKey(pollId: string, pollKey: string): void {
  let keys = pollIdToCacheKeys.get(pollId);
  if (!keys) {
    keys = new Set();
    pollIdToCacheKeys.set(pollId, keys);
  }
  keys.add(pollKey);
}

function unregisterCacheKey(pollId: string, pollKey: string): void {
  const keys = pollIdToCacheKeys.get(pollId);
  if (!keys) return;
  keys.delete(pollKey);
  if (!keys.size) {
    pollIdToCacheKeys.delete(pollId);
  }
}

export function normalizeOptionText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function computeOptionHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeOptionHash(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return trimmed.toLowerCase();
    }

    const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
    if (base64Pattern.test(trimmed)) {
      try {
        const buffer = Buffer.from(trimmed, 'base64');
        if (buffer.length > 0) {
          return buffer.toString('hex');
        }
      } catch {
        // ignore
      }
    }

    const utf8Buffer = Buffer.from(trimmed, 'utf-8');
    return utf8Buffer.length > 0 ? utf8Buffer.toString('hex') : null;
  }

  if (Buffer.isBuffer(value)) {
    return value.length > 0 ? value.toString('hex') : null;
  }

  if (value instanceof Uint8Array) {
    return value.length > 0 ? Buffer.from(value).toString('hex') : null;
  }

  if (Array.isArray(value)) {
    if (!value.length) return null;
    return Buffer.from(value).toString('hex');
  }

  return null;
}

function normalizeMessageSecret(value: unknown): string | null {
  return normalizeOptionHash(value);
}

function extractOptionText(option: unknown): string | null {
  if (!option || typeof option !== 'object') return null;
  const withName = option as {
    optionName?: unknown;
    name?: unknown;
  };

  const optionName = withName.optionName;
  if (typeof optionName === 'string') {
    const normalized = normalizeOptionText(optionName);
    if (normalized) return normalized;
  } else if (optionName && typeof optionName === 'object') {
    const text = (optionName as { text?: unknown }).text;
    const normalized = normalizeOptionText(typeof text === 'string' ? text : null);
    if (normalized) return normalized;
  }

  const name = withName.name;
  if (typeof name === 'string') {
    const normalized = normalizeOptionText(name);
    if (normalized) return normalized;
  } else if (name && typeof name === 'object') {
    const text = (name as { text?: unknown }).text;
    const normalized = normalizeOptionText(typeof text === 'string' ? text : null);
    if (normalized) return normalized;
  }

  return null;
}

export function buildOptionHashMaps(
  pollMessage: WAMessage | undefined,
): {
  hashMap: Map<string, { id: string | null; text: string | null }>;
  textToHash: Map<string, string>;
} {
  const pollCreation =
    pollMessage?.message?.pollCreationMessage ??
    pollMessage?.message?.pollCreationMessageV2 ??
    pollMessage?.message?.pollCreationMessageV3 ??
    undefined;

  const options = (pollCreation?.options ?? []) as unknown[];
  const hashMap = new Map<string, { id: string | null; text: string | null }>();
  const textToHash = new Map<string, string>();

  for (const option of options) {
    const text = extractOptionText(option);
    if (!text) continue;
    const providedHashValue = (option as { optionHash?: unknown }).optionHash;
    const normalizedProvidedHash =
      providedHashValue !== undefined && providedHashValue !== null
        ? normalizeOptionHash(providedHashValue)
        : null;
    const hash = normalizedProvidedHash ?? computeOptionHash(text);
    if (!hashMap.has(hash)) {
      hashMap.set(hash, { id: text, text });
    }
    if (!textToHash.has(text)) {
      textToHash.set(text, hash);
    }
  }

  return { hashMap, textToHash };
}

export function normalizePollOption(
  option: { id?: string | null; text?: string | null; hash?: string | null },
): PollOptionMetadata | null {
  if (!option) return null;

  const idCandidate = typeof option.id === 'string' ? option.id : null;
  const textCandidate = typeof option.text === 'string' ? option.text : null;
  const normalizedText =
    normalizeOptionText(textCandidate ?? idCandidate) ?? textCandidate ?? idCandidate ?? null;

  let hash = option.hash ? normalizeOptionHash(option.hash) : null;
  if (!hash && normalizedText) {
    hash = computeOptionHash(normalizedText);
  }
  if (!hash && idCandidate) {
    const trimmedId = normalizeOptionText(idCandidate) ?? idCandidate;
    if (trimmedId) {
      hash = computeOptionHash(trimmedId);
      if (!normalizedText) {
        return {
          id: trimmedId,
          text: trimmedId,
          hash,
        };
      }
    }
  }

  if (!hash) return null;

  const text = normalizedText ?? hash;
  const id = idCandidate && idCandidate.trim() ? idCandidate : text;

  return { id, text, hash };
}

export function mergePollMetadata(
  ...sources: Array<PollMetadata | null | undefined>
): PollMetadata | null {
  let pollId: string | null = null;
  let question = '';
  let remoteJid: string | null = null;
  let encKeyHex: string | null = null;
  let selectableCount: number | null = null;
  const optionMap = new Map<string, PollOptionMetadata>();

  for (const source of sources) {
    if (!source) continue;
    if (!pollId) {
      pollId = source.pollId;
    }
    if (!question && source.question) {
      question = source.question;
    }
    const normalizedRemote = normalizeJid(source.remoteJid);
    if (!remoteJid && normalizedRemote) {
      remoteJid = normalizedRemote;
    }
    if (!encKeyHex && source.encKeyHex) {
      encKeyHex = source.encKeyHex;
    }
    if (selectableCount == null && source.selectableCount != null) {
      selectableCount = source.selectableCount;
    }

    for (const option of source.options ?? []) {
      const normalized = normalizePollOption(option);
      if (!normalized) continue;
      if (!optionMap.has(normalized.hash)) {
        optionMap.set(normalized.hash, normalized);
      } else {
        const existing = optionMap.get(normalized.hash);
        if (existing) {
          if (!existing.text && normalized.text) existing.text = normalized.text;
          if (!existing.id && normalized.id) existing.id = normalized.id;
        }
      }
    }
  }

  if (!pollId) return null;

  return {
    pollId,
    question,
    options: Array.from(optionMap.values()),
    remoteJid,
    encKeyHex,
    selectableCount,
  };
}

export function extractPollMetadataFromMessage(message: WAMessage): PollMetadata | null {
  const pollId = message.key?.id;
  if (!pollId) return null;

  const question =
    message.message?.pollCreationMessage?.name ??
    message.message?.pollCreationMessageV2?.name ??
    message.message?.pollCreationMessageV3?.name ??
    '';

  const pollCreation =
    message.message?.pollCreationMessage ??
    message.message?.pollCreationMessageV2 ??
    message.message?.pollCreationMessageV3 ??
    undefined;

  const { hashMap } = buildOptionHashMaps(message);
  const options: PollOptionMetadata[] = [];
  for (const [hash, option] of hashMap.entries()) {
    const normalized = normalizePollOption({ id: option.id, text: option.text, hash });
    if (!normalized) continue;
    options.push(normalized);
  }

  const selectableCount =
    (pollCreation as { selectableOptionsCount?: number | null } | undefined)
      ?.selectableOptionsCount ?? null;

  const remoteJid = normalizeJid(message.key?.remoteJid);

  const secretCandidates: unknown[] = [];
  if (pollCreation) {
    secretCandidates.push((pollCreation as { encKey?: unknown })?.encKey ?? null);
    secretCandidates.push((pollCreation as { contextInfo?: { messageSecret?: unknown } | null })?.contextInfo?.messageSecret ?? null);
  }
  secretCandidates.push(message.message?.messageContextInfo?.messageSecret ?? null);

  let encKeyHex: string | null = null;
  for (const candidate of secretCandidates) {
    const normalized = normalizeMessageSecret(candidate);
    if (normalized) {
      encKeyHex = normalized;
      break;
    }
  }

  return {
    pollId,
    question,
    options,
    remoteJid,
    encKeyHex,
    selectableCount,
  };
}

export async function rememberPollMetadata(
  metadata: PollMetadata | null | undefined,
  options: { persist?: boolean } = {},
): Promise<void> {
  if (!metadata?.pollId) return;

  const { persist = true } = options;

  const normalizedMetadata: PollMetadata = {
    ...metadata,
    remoteJid: normalizeJid(metadata.remoteJid),
  };

  const existing = getPollMetadataFromCache(
    normalizedMetadata.pollId,
    normalizedMetadata.remoteJid,
  );

  const merged = mergePollMetadata(existing, normalizedMetadata);
  if (!merged) return;

  const normalizedMerged: PollMetadata = {
    ...merged,
    remoteJid: normalizeJid(merged.remoteJid),
  };

  const pollKey = buildPollKey(normalizedMerged.pollId, normalizedMerged.remoteJid);
  if (!pollKey) return;

  pollMetadataCache.set(pollKey, normalizedMerged);
  registerCacheKey(normalizedMerged.pollId, pollKey);

  if (normalizedMerged.remoteJid) {
    const fallbackKey = buildPollKey(normalizedMerged.pollId, null);
    if (fallbackKey && fallbackKey !== pollKey) {
      pollMetadataCache.delete(fallbackKey);
      unregisterCacheKey(normalizedMerged.pollId, fallbackKey);
    }
  }

  if (persist) {
    await pollMetadataStore.put({
      pollKey,
      pollId: normalizedMerged.pollId,
      remoteJid: normalizedMerged.remoteJid ?? null,
      encKeyHex: normalizedMerged.encKeyHex ?? null,
      question: normalizedMerged.question ?? null,
      options: normalizedMerged.options.map((option) => option.text),
      selectableCount: normalizedMerged.selectableCount ?? null,
      updatedAt: Date.now(),
    });
  }
}

export async function rememberPollMetadataFromMessage(
  message: WAMessage,
  fallback?: {
    question?: string;
    options?: string[];
    remoteJid?: string | null;
    messageSecret?: Uint8Array | Buffer | string | null;
    selectableCount?: number | null;
  },
): Promise<void> {
  const pollId = message.key?.id;
  if (!pollId) return;

  const extracted = extractPollMetadataFromMessage(message);

  let fallbackMetadata: PollMetadata | null = null;
  if (fallback) {
    const messageRemoteJid = normalizeJid(message.key?.remoteJid);
    const question = typeof fallback.question === 'string' ? fallback.question.trim() : '';
    const options =
      fallback.options?.map((value) => normalizePollOption({ id: value, text: value })) ?? [];
    const normalizedOptions = options.filter(
      (option): option is PollOptionMetadata => Boolean(option),
    );
    const encKeyHex = normalizeMessageSecret(fallback.messageSecret ?? null);
    const remoteJid = normalizeJid(fallback.remoteJid ?? messageRemoteJid);
    const selectableCount =
      typeof fallback.selectableCount === 'number' ? fallback.selectableCount : null;
    if (question || normalizedOptions.length || encKeyHex || remoteJid || selectableCount != null) {
      fallbackMetadata = {
        pollId,
        question,
        options: normalizedOptions,
        remoteJid,
        encKeyHex,
        selectableCount,
      };
    }
  }

  await rememberPollMetadata(mergePollMetadata(extracted, fallbackMetadata));
}

export async function addObservedPollMetadata(
  pollId: string,
  question: string,
  observed: Array<{ id: string | null; text: string | null; hash?: string | null }>,
  remoteJid?: string | null | undefined,
): Promise<void> {
  const options = observed
    .map((option) =>
      normalizePollOption({
        id: option.id,
        text: option.text,
        hash: option.hash ?? null,
      }),
    )
    .filter((entry): entry is PollOptionMetadata => Boolean(entry));

  const metadata: PollMetadata = {
    pollId,
    question,
    options,
    remoteJid: normalizeJid(remoteJid),
  };

  await rememberPollMetadata(metadata);
}

export function getPollMetadataFromCache(
  pollId: string | null | undefined,
  remoteJid?: string | null | undefined,
): PollMetadata | null {
  if (!pollId) return null;

  const normalizedRemote = normalizeJid(remoteJid);

  if (normalizedRemote != null) {
    const pollKey = buildPollKey(pollId, normalizedRemote);
    if (pollKey) {
      const direct = pollMetadataCache.get(pollKey);
      if (direct) return direct;
    }
  }

  const fallbackKey = buildPollKey(pollId, null);
  if (fallbackKey) {
    const fallback = pollMetadataCache.get(fallbackKey);
    if (fallback) return fallback;
  }

  if (normalizedRemote == null) {
    const keys = pollIdToCacheKeys.get(pollId);
    if (keys) {
      for (const key of keys) {
        const value = pollMetadataCache.get(key);
        if (value) return value;
      }
    }
  }

  return null;
}

export async function getPollMetadata(
  pollId: string | null | undefined,
  remoteJid?: string | null | undefined,
): Promise<PollMetadata | null> {
  if (!pollId) return null;

  const normalizedRemote = normalizeJid(remoteJid);
  const cached = getPollMetadataFromCache(pollId, normalizedRemote);
  if (cached) return cached;

  const candidateKeys = new Set<string>();
  if (normalizedRemote != null) {
    const directKey = buildPollKey(pollId, normalizedRemote);
    if (directKey) candidateKeys.add(directKey);
  }

  const fallbackKey = buildPollKey(pollId, null);
  if (fallbackKey) candidateKeys.add(fallbackKey);

  if (normalizedRemote == null) {
    const indexedKeys = pollIdToCacheKeys.get(pollId);
    if (indexedKeys) {
      for (const key of indexedKeys) {
        candidateKeys.add(key);
      }
    }
  }

  for (const key of candidateKeys) {
    const stored = await pollMetadataStore.get(key);
    if (!stored) continue;

    const normalized = pollMetadataRecordToMetadata(stored);
    await rememberPollMetadata(normalized, { persist: false });

    const refreshed = getPollMetadataFromCache(
      pollId,
      normalizedRemote ?? normalized.remoteJid,
    );
    if (refreshed) return refreshed;
  }

  return null;
}

export function recordVoteSelection(
  messageId: string | null | undefined,
  data: VoteSelection | null,
): void {
  if (!messageId) return;
  if (!data) {
    voteSelections.delete(messageId);
    return;
  }
  voteSelections.set(messageId, data);
}

export function getVoteSelection(
  messageId: string | null | undefined,
): VoteSelection | null {
  if (!messageId) return null;
  return voteSelections.get(messageId) ?? null;
}

function pollMetadataRecordToMetadata(record: PollMetadataRecord): PollMetadata {
  const options = record.options
    .map((text) => normalizePollOption({ id: text, text }))
    .filter((value): value is PollOptionMetadata => Boolean(value));

  return {
    pollId: record.pollId,
    question: record.question ?? '',
    options,
    remoteJid: normalizeJid(record.remoteJid),
    encKeyHex: record.encKeyHex ?? null,
    selectableCount: record.selectableCount ?? null,
  };
}
