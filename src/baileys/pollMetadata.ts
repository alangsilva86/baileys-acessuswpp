import { createHash } from 'crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { pollMetadataStore, type PollMetadataRecord } from './pollMetadataStore.js';
import { decryptSecret, encryptSecret } from './secretEncryption.js';

/* =========================================================
 * Tipos públicos
 * ======================================================= */

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

/* =========================================================
 * Estado em memória
 * ======================================================= */

const pollMetadataCache = new Map<string, PollMetadata>();   // chave: <jid-normalizado>#<pollId> ou #<pollId>
const pollIdToCacheKeys = new Map<string, Set<string>>();    // índice: pollId -> chaves compostas
const voteSelections = new Map<string, VoteSelection>();     // messageId -> última seleção legível

/* =========================================================
 * Utilitários de normalização
 * ======================================================= */

export function normalizeJid(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // remove sufixo :device (mantemos isso fora do metadado canônico)
  const [base] = trimmed.split(':');
  return base || null;
}

function buildPollKey(
  pollId: string | null | undefined,
  remoteJid: string | null | undefined,
): string | null {
  if (!pollId) return null;
  const normalizedRemote = normalizeJid(remoteJid) ?? '';
  return `${normalizedRemote}#${pollId}`;
}

function registerCacheKey(pollId: string, pollKey: string): void {
  let set = pollIdToCacheKeys.get(pollId);
  if (!set) {
    set = new Set();
    pollIdToCacheKeys.set(pollId, set);
  }
  set.add(pollKey);
}

function unregisterCacheKey(pollId: string, pollKey: string): void {
  const set = pollIdToCacheKeys.get(pollId);
  if (!set) return;
  set.delete(pollKey);
  if (!set.size) pollIdToCacheKeys.delete(pollId);
}

export function normalizeOptionText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

export function computeOptionHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toHexFromAny(value: Uint8Array | Buffer | string | number[] | null | undefined): string | null {
  if (!value) return null;

  if (value instanceof Uint8Array) {
    return value.length ? Buffer.from(value).toString('hex') : null;
  }
  if (Buffer.isBuffer(value)) {
    return value.length ? value.toString('hex') : null;
  }

  if (Array.isArray(value)) {
    if (!value.length) return null;
    try {
      return Buffer.from(value).toString('hex') || null;
    } catch {
      return null;
    }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // hex puro
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) return trimmed.toLowerCase();

    // base64
    const base64Pattern =
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
    if (base64Pattern.test(trimmed)) {
      try {
        const b = Buffer.from(trimmed, 'base64');
        return b.length ? b.toString('hex') : null;
      } catch {
        // ignora, tenta fallback
      }
    }

    // fallback: utf-8 para hex
    try {
      const utf8 = Buffer.from(trimmed, 'utf-8');
      return utf8.length ? utf8.toString('hex') : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function normalizeOptionHash(value: unknown): string | null {
  return toHexFromAny(value as any);
}

function normalizeMessageSecret(value: unknown): string | null {
  return toHexFromAny(value as any);
}

/* =========================================================
 * Extração de opções do WAMessage
 * ======================================================= */

function extractOptionText(option: unknown): string | null {
  if (!option || typeof option !== 'object') return null;

  // Variações: { optionName: string | { text } } | { name: string | { text } }
  const withName = option as { optionName?: unknown; name?: unknown };

  const tryRead = (v: unknown): string | null => {
    if (typeof v === 'string') return normalizeOptionText(v);
    if (v && typeof v === 'object') {
      const txt = (v as { text?: unknown }).text;
      return normalizeOptionText(typeof txt === 'string' ? txt : null);
    }
    return null;
  };

  return tryRead(withName.optionName) ?? tryRead(withName.name);
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

    const provided = (option as { optionHash?: unknown }).optionHash;
    const normalized = provided != null ? normalizeOptionHash(provided) : null;
    const hash = normalized ?? computeOptionHash(text);

    if (!hashMap.has(hash)) hashMap.set(hash, { id: text, text });
    if (!textToHash.has(text)) textToHash.set(text, hash);
  }

  return { hashMap, textToHash };
}

/* =========================================================
 * Normalização e merge de metadados
 * ======================================================= */

export function normalizePollOption(
  option: { id?: string | null; text?: string | null; hash?: string | null },
): PollOptionMetadata | null {
  if (!option) return null;

  const idCandidate = typeof option.id === 'string' ? option.id : null;
  const textCandidate = typeof option.text === 'string' ? option.text : null;

  const normalizedText = normalizeOptionText(textCandidate ?? idCandidate) ?? null;

  let hash = option.hash ? normalizeOptionHash(option.hash) : null;
  if (!hash && normalizedText) hash = computeOptionHash(normalizedText);
  if (!hash && idCandidate) {
    const trimmedId = normalizeOptionText(idCandidate) ?? idCandidate;
    if (trimmedId) {
      hash = computeOptionHash(trimmedId);
      if (!normalizedText) {
        return { id: trimmedId, text: trimmedId, hash };
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

  for (const src of sources) {
    if (!src) continue;

    pollId ??= src.pollId;
    if (!question && src.question) question = src.question;

    const r = normalizeJid(src.remoteJid);
    if (!remoteJid && r) remoteJid = r;

    encKeyHex ??= src.encKeyHex ?? null;

    if (selectableCount == null && src.selectableCount != null) {
      selectableCount = src.selectableCount;
    }

    for (const o of src.options ?? []) {
      const n = normalizePollOption(o);
      if (!n) continue;

      if (!optionMap.has(n.hash)) {
        optionMap.set(n.hash, n);
      } else {
        const curr = optionMap.get(n.hash)!;
        if (!curr.text && n.text) curr.text = n.text;
        if (!curr.id && n.id) curr.id = n.id;
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

/* =========================================================
 * Extração do WAMessage
 * ======================================================= */

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
    if (normalized) options.push(normalized);
  }

  const selectableCount =
    (pollCreation as { selectableOptionsCount?: number | null } | undefined)
      ?.selectableOptionsCount ?? null;

  const remoteJid = normalizeJid(message.key?.remoteJid);

  // fontes possíveis do segredo
  const secretCandidates: unknown[] = [];
  if (pollCreation) {
    secretCandidates.push((pollCreation as { encKey?: unknown })?.encKey ?? null);
    secretCandidates.push(
      (pollCreation as { contextInfo?: { messageSecret?: unknown } | null })?.contextInfo
        ?.messageSecret ?? null,
    );
  }
  // caminho correto do secret no topo do message
  secretCandidates.push(message.message?.messageContextInfo?.messageSecret ?? null);

  let encKeyHex: string | null = null;
  for (const c of secretCandidates) {
    const n = normalizeMessageSecret(c);
    if (n) {
      encKeyHex = n;
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

/* =========================================================
 * Persistência + cache
 * ======================================================= */

export async function rememberPollMetadata(
  metadata: PollMetadata | null | undefined,
  options: { persist?: boolean } = {},
): Promise<void> {
  if (!metadata?.pollId) return;

  const { persist = true } = options;

  const normalized: PollMetadata = {
    ...metadata,
    remoteJid: normalizeJid(metadata.remoteJid),
  };

  const existing = getPollMetadataFromCache(normalized.pollId, normalized.remoteJid);
  const merged = mergePollMetadata(existing, normalized);
  if (!merged) return;

  const normalizedMerged: PollMetadata = {
    ...merged,
    remoteJid: normalizeJid(merged.remoteJid),
  };

  const pollKey = buildPollKey(normalizedMerged.pollId, normalizedMerged.remoteJid);
  if (!pollKey) return;

  pollMetadataCache.set(pollKey, normalizedMerged);
  registerCacheKey(normalizedMerged.pollId, pollKey);

  // se agora temos JID, limpe o fallback sem JID
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
      encKeyHex: encryptSecret(normalizedMerged.encKeyHex ?? null) ?? null,
      question: normalizedMerged.question ?? null,
      options: normalizedMerged.options.map(o => o.text),
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
    const options = (fallback.options ?? [])
      .map(v => normalizePollOption({ id: v, text: v }))
      .filter((o): o is PollOptionMetadata => Boolean(o));
    const encKeyHex = normalizeMessageSecret(fallback.messageSecret ?? null);
    const remoteJid = normalizeJid(fallback.remoteJid ?? messageRemoteJid);
    const selectableCount =
      typeof fallback.selectableCount === 'number' ? fallback.selectableCount : null;

    if (question || options.length || encKeyHex || remoteJid || selectableCount != null) {
      fallbackMetadata = {
        pollId,
        question,
        options,
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
    .map(o => normalizePollOption({ id: o.id ?? null, text: o.text ?? null, hash: o.hash ?? null }))
    .filter((e): e is PollOptionMetadata => Boolean(e));

  const metadata: PollMetadata = {
    pollId,
    question,
    options,
    remoteJid: normalizeJid(remoteJid),
  };

  await rememberPollMetadata(metadata);
}

/* =========================================================
 * Cache getters
 * ======================================================= */

export function getPollMetadataFromCache(
  pollId: string | null | undefined,
  remoteJid?: string | null | undefined,
): PollMetadata | null {
  if (!pollId) return null;

  const normalizedRemote = normalizeJid(remoteJid);

  if (normalizedRemote != null) {
    const key = buildPollKey(pollId, normalizedRemote);
    if (key) {
      const direct = pollMetadataCache.get(key);
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
        const v = pollMetadataCache.get(key);
        if (v) return v;
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
    const indexed = pollIdToCacheKeys.get(pollId);
    if (indexed) for (const k of indexed) candidateKeys.add(k);
  }

  for (const key of candidateKeys) {
    const stored = await pollMetadataStore.get(key);
    if (!stored) continue;

    const normalized = pollMetadataRecordToMetadata(stored);
    await rememberPollMetadata(normalized, { persist: false });

    const refreshed = getPollMetadataFromCache(pollId, normalizedRemote ?? normalized.remoteJid);
    if (refreshed) return refreshed;
  }

  return null;
}

/* =========================================================
 * Seleção legível por messageId
 * ======================================================= */

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

export function getVoteSelection(messageId: string | null | undefined): VoteSelection | null {
  if (!messageId) return null;
  return voteSelections.get(messageId) ?? null;
}

/* =========================================================
 * Conversão record -> metadata
 * ======================================================= */

function pollMetadataRecordToMetadata(record: PollMetadataRecord): PollMetadata {
  const options = (record.options ?? [])
    .map(text => normalizePollOption({ id: text, text }))
    .filter((o): o is PollOptionMetadata => Boolean(o));

  return {
    pollId: record.pollId,
    question: record.question ?? '',
    options,
    remoteJid: normalizeJid(record.remoteJid),
    encKeyHex: decryptSecret(record.encKeyHex ?? null),
    selectableCount: record.selectableCount ?? null,
  };
}