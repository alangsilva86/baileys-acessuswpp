import type {
  BaileysEventMap,
  proto,
  WAMessage,
  WAMessageUpdate,
  WASocket,
} from '@whiskeysockets/baileys';
import type Long from 'long';
import { Buffer } from 'node:buffer';
import { getAggregateVotesInPollMessage, getKeyAuthor } from '@whiskeysockets/baileys';
import {
  extractMessageContent,
  updateMessageWithPollUpdate,
} from '@whiskeysockets/baileys/lib/Utils/messages.js';
import { decryptPollVote as defaultDecryptPollVote } from '@whiskeysockets/baileys/lib/Utils/process-message.js';
import pino from 'pino';
import { buildContactPayload, mapLeadFromMessage } from '../services/leadMapper.js';
import type { ContactPayload } from '../services/leadMapper.js';
import { WebhookClient } from '../services/webhook.js';
import { getSendTimeoutMs } from '../utils.js';
import { PollMessageStore } from './store.js';
import type { MessageService } from './messageService.js';
import type { BrokerEvent, BrokerEventStore } from '../broker/eventStore.js';
import { toIsoDate } from './time.js';
import {
  addObservedPollMetadata,
  buildOptionHashMaps,
  computeOptionHash,
  extractPollMetadataFromMessage,
  getPollMetadata,
  getPollMetadataFromCache,
  normalizeOptionHash,
  normalizeOptionText,
  normalizePollOption,
  normalizeJid,
  recordVoteSelection,
  rememberPollMetadataFromMessage,
} from './pollMetadata.js';
import { fingerprintSecret } from './secretEncryption.js';
import {
  jidNormalizedUser,
  isLidUser,
  jidDecode,
  jidEncode,
} from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';

export interface SendPollOptions {
  selectableCount?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

export interface PollServiceOptions {
  store?: PollMessageStore;
  feedbackTemplate?: string | null;
  messageService?: MessageService;
  eventStore?: BrokerEventStore;
  instanceId?: string;
  aggregateVotesFn?: typeof getAggregateVotesInPollMessage;
  decryptPollVoteFn?: typeof defaultDecryptPollVote;
}

interface PollChoiceEventPayload {
  pollId: string;
  question: string;
  chatId: string | null;
  messageId: string;
  timestamp: string;
  voterJid: string | null;
  selectedOptions: Array<{ id: string | null; text: string | null }>;
  optionsAggregates: Array<{ id: string | null; text: string | null; votes: number }>;
  aggregates: {
    totalVoters: number;
    totalVotes: number;
    optionTotals: Array<{ id: string | null; text: string | null; votes: number }>;
  };
  contact: ContactPayload;
}

type PollUpdateWithCreationKey = proto.IPollUpdate & {
  pollCreationMessageKey?: proto.IMessageKey | null;
};

const DEFAULT_SELECTABLE_COUNT = 1;

interface PollVoteMetadata {
  key?: WAMessage['key'];
  timestampCandidates: Array<number | Long | bigint | null | undefined>;
  update: WAMessageUpdate;
}

interface PollVoteVoterInfo {
  voterKey?: proto.IMessageKey | null;
  voterJid: string | null;
}

function extractPollQuestion(message: WAMessage | undefined): string {
  return (
    message?.message?.pollCreationMessage?.name ||
    message?.message?.pollCreationMessageV2?.name ||
    message?.message?.pollCreationMessageV3?.name ||
    ''
  );
}

function buildSyntheticMessageForVoter(
  update: WAMessageUpdate,
  pollMessage: WAMessage | undefined,
  voterKey: proto.IMessageKey | null | undefined,
  voterJid: string | null,
  meId: string | undefined,
): WAMessage {
  const participant =
    voterJid ??
    voterKey?.participant ??
    update.key?.participant ??
    undefined;

  const fromMe =
    voterKey?.fromMe ??
    (meId && voterJid ? voterJid === meId : undefined) ??
    update.key?.fromMe ??
    false;

  return {
    key: {
      remoteJid: pollMessage?.key?.remoteJid,
      fromMe,
      participant,
    },
    pushName: (update as unknown as { pushName?: string }).pushName,
  } as WAMessage;
}

function isPollVoteMessage(
  value: proto.Message.IPollEncValue | proto.Message.IPollVoteMessage | null | undefined,
): value is proto.Message.IPollVoteMessage {
  return !!value && Array.isArray((value as proto.Message.IPollVoteMessage).selectedOptions);
}

export class PollService {
  private readonly store: PollMessageStore;
  private readonly feedbackTemplate?: string | null;
  private readonly messageService?: MessageService;
  private readonly eventStore?: BrokerEventStore;
  private readonly instanceId: string;
  private readonly aggregateVotes: typeof getAggregateVotesInPollMessage;
  private readonly decryptPollVote: typeof defaultDecryptPollVote;
  private readonly receiptHints = new Map<string, Set<string>>();

  constructor(
    private readonly sock: WASocket,
    private readonly webhook: WebhookClient,
    private readonly logger: pino.Logger,
    options: PollServiceOptions = {},
  ) {
    this.store = options.store ?? new PollMessageStore();
    this.feedbackTemplate = options.feedbackTemplate ?? process.env.POLL_FEEDBACK_TEMPLATE ?? null;
    this.messageService = options.messageService;
    this.eventStore = options.eventStore;
    this.instanceId = options.instanceId ?? 'default';
    this.aggregateVotes = options.aggregateVotesFn ?? getAggregateVotesInPollMessage;
    this.decryptPollVote = options.decryptPollVoteFn ?? defaultDecryptPollVote;

    this.sock.ev.on('message-receipt.update', (updates) => {
      for (const update of updates) {
        const messageId = update?.key?.id ?? null;
        if (!messageId) continue;
        const bucket = this.ensureReceiptBucket(messageId);

        const rawReceipt = update.receipt as Partial<{
          userJid?: string | null;
          jid?: string | null;
          participant?: string | null;
          lid?: string | null;
          senderLid?: string | null;
          device?: number | null;
        }>;

        const hintSources: Array<{ label: string; value: string | null | undefined }> = [
          { label: 'receipt.userJid', value: rawReceipt?.userJid },
          { label: 'receipt.jid', value: rawReceipt?.jid },
          { label: 'receipt.participant', value: rawReceipt?.participant },
          { label: 'receipt.lid', value: rawReceipt?.lid },
          { label: 'receipt.specific.senderLid', value: rawReceipt?.senderLid },
          { label: 'receipt.key.remote', value: update.key?.remoteJid ?? null },
          { label: 'receipt.key.participant', value: update.key?.participant ?? null },
        ];

        for (const source of hintSources) {
          this.noteReceiptHint(bucket, messageId, source.label, source.value);
        }
      }
    });
  }

  async sendPoll(
    jid: string,
    question: string,
    values: string[],
    options: SendPollOptions = {},
  ): Promise<WAMessage> {
    const selectableCount = options.selectableCount ?? DEFAULT_SELECTABLE_COUNT;
    const payload = {
      poll: {
        name: question,
        values,
        selectableCount,
      },
    } as const;

    const message = await this.sock.sendMessage(jid, payload, options.messageOptions);
    this.store.remember(message);

    await rememberPollMetadataFromMessage(message, {
      question,
      options: values,
      remoteJid: message.key?.remoteJid ?? null,
      messageSecret: message.message?.messageContextInfo?.messageSecret ?? null,
      selectableCount,
    });

    return message;
  }

  async onMessageUpsert(event: BaileysEventMap['messages.upsert']): Promise<void> {
    if (!event?.messages?.length) return;

    for (const message of event.messages) {
      const content = extractMessageContent(message.message);

      // criação de poll
      if (
        content?.pollCreationMessage ||
        (content as { pollCreationMessageV2?: proto.Message.IPollCreationMessage | null })
          ?.pollCreationMessageV2 ||
        (content as { pollCreationMessageV3?: proto.Message.IPollCreationMessage | null })
          ?.pollCreationMessageV3
      ) {
        this.store.remember(message);
        await rememberPollMetadataFromMessage(message);
        const pollId = message.key?.id ?? 'unknown';
        const secret =
          message.message?.pollCreationMessage?.encKey ??
          (message.message?.pollCreationMessage as { contextInfo?: { messageSecret?: unknown } | null })
            ?.contextInfo?.messageSecret ??
          message.message?.messageContextInfo?.messageSecret ??
          null;
        const options =
          message.message?.pollCreationMessage?.options ??
          (message.message?.pollCreationMessageV2 as { options?: unknown[] } | undefined)?.options ??
          (message.message?.pollCreationMessageV3 as { options?: unknown[] } | undefined)?.options ??
          [];
        const creatorAuthor = getKeyAuthor(message.key, this.sock.user?.id);
        const secretFingerprint =
          typeof secret === 'string'
            ? fingerprintSecret(Buffer.from(secret, secret.includes('/') || secret.includes('+') ? 'base64' : 'utf-8'))
            : fingerprintSecret(secret as Uint8Array | Buffer | null);
        this.logger.info(
          {
            pollId,
            remoteJid: message.key?.remoteJid ?? null,
            hasSecret: Boolean(secret),
            optionsCount: Array.isArray(options) ? options.length : 0,
            note: 'estivemos com a criação da enquete em mãos',
            creatorAuthor,
            secretFingerprint,
          },
          'poll.detected.creation',
        );
      }

      // voto
      const pollUpdateMessage =
        content?.pollUpdateMessage ??
        (content as { pollUpdateMessageV2?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV2 ??
        (content as { pollUpdateMessageV3?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV3 ??
        message.message?.pollUpdateMessage ??
        (message.message as { pollUpdateMessageV2?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV2 ??
      (message.message as { pollUpdateMessageV3?: proto.Message.IPollUpdateMessage | null })
        ?.pollUpdateMessageV3 ??
      null;

    if (!pollUpdateMessage) continue;

    const rawPollKey =
      (pollUpdateMessage as { pollUpdateMessageKey?: proto.IMessageKey | null })
        ?.pollUpdateMessageKey ?? null;
    const keySnapshot = message.key
      ? {
          remoteJid: message.key.remoteJid ?? null,
          participant: message.key.participant ?? null,
          fromMe: message.key.fromMe ?? null,
          id: message.key.id ?? null,
          availableProps: Object.keys(message.key as Record<string, unknown>),
          senderLid:
            ((message.key as unknown as { senderLid?: string | null }).senderLid ??
              (message as unknown as { senderLid?: string | null }).senderLid) ??
            null,
        }
      : null;

    this.logger.info(
      {
        pollId: rawPollKey?.id ?? pollUpdateMessage.pollCreationMessageKey?.id ?? null,
        messageId: message.key?.id ?? null,
        key: keySnapshot,
        pollUpdateKey: rawPollKey
          ? {
              remoteJid: rawPollKey.remoteJid ?? null,
              participant: rawPollKey.participant ?? null,
              id: rawPollKey.id ?? null,
              fromMe: rawPollKey.fromMe ?? null,
            }
          : null,
        clue: 'dossiê do voto em mãos — investigando JIDs presentes',
      },
      'poll.vote.key.snapshot',
    );

    const creationKey = (pollUpdateMessage as PollUpdateWithCreationKey | undefined)
      ?.pollCreationMessageKey;

    let pollMessage = this.store.get(creationKey?.id) ?? this.store.get(message.key?.id);
      if (!pollMessage) {
        pollMessage = await this.rehydratePollMessage(
          creationKey?.id ?? message.key?.id ?? null,
          creationKey?.remoteJid ?? message.key?.remoteJid ?? null,
        );
        if (pollMessage) this.store.remember(pollMessage);
      }
      if (!pollMessage) continue;

      const voterKey =
        (pollUpdateMessage as PollUpdateWithCreationKey | undefined)?.pollUpdateMessageKey ??
        message.key ??
        null;
      const voterJid = this.resolveVoterJid(voterKey, message.key);

      const pollUpdates = this.buildPollUpdatesFromUpsert(
        pollMessage,
        pollUpdateMessage,
        message,
        voterJid,
      );
      if (!pollUpdates.length) continue;

      const updateLike = {
        key: message.key,
        messageTimestamp: message.messageTimestamp,
        update: { pollUpdates },
      } as WAMessageUpdate;
      (updateLike as unknown as { pushName?: string }).pushName =
        (message as unknown as { pushName?: string }).pushName;

      await this.processPollVote(
        pollMessage,
        pollUpdates,
        {
          key: message.key,
          timestampCandidates: [
            (message as Partial<{ messageTimestamp: number | Long | bigint | null }>)
              .messageTimestamp ?? null,
            pollMessage.messageTimestamp ?? null,
          ],
          update: updateLike,
        },
        {
          voterKey,
          voterJid,
        },
      );
    }
  }

  async onMessageUpdate(updates: BaileysEventMap['messages.update']): Promise<void> {
    if (!updates?.length) return;

    for (const update of updates) {
      const pollUpdates = this.normalizePollUpdates(
        update.update?.pollUpdates as proto.IPollUpdate[] | undefined,
      );
      if (!pollUpdates.length) continue;

      const pollUpdate = pollUpdates[0] as PollUpdateWithCreationKey | undefined;
      const creationKey = pollUpdate?.pollCreationMessageKey ?? undefined;
      const voterKey = pollUpdate?.pollUpdateMessageKey ?? null;

      let pollMessage = this.store.get(creationKey?.id) ?? this.store.get(update.key?.id);
      if (!pollMessage) {
        pollMessage = await this.rehydratePollMessage(
          creationKey?.id ?? update.key?.id ?? null,
          creationKey?.remoteJid ?? update.key?.remoteJid ?? null,
        );
        if (pollMessage) this.store.remember(pollMessage);
      }
      if (!pollMessage) continue;

      const narrowedUpdate =
        update.update as Partial<{ messageTimestamp: number | Long | bigint | null }> | undefined;
      const voterJid = this.resolveVoterJid(voterKey, update.key);

      await this.processPollVote(
        pollMessage,
        pollUpdates,
        {
          key: update.key,
          timestampCandidates: [
            narrowedUpdate?.messageTimestamp ?? null,
            (update as Partial<{ messageTimestamp: number | Long | bigint | null }>)
              .messageTimestamp ?? null,
            pollMessage.messageTimestamp ?? null,
          ],
          update,
        },
        {
          voterKey,
          voterJid,
        },
      );
    }
  }

  private resolveVoterJid(
    voterKey: proto.IMessageKey | null | undefined,
    fallbackKey?: WAMessage['key'],
  ): string | null {
    if (voterKey) {
      const author = getKeyAuthor(voterKey, this.sock.user?.id);
      if (author) return author; // mantém :device se houver
    }
    return fallbackKey?.participant ?? fallbackKey?.remoteJid ?? null;
  }

  private async processPollVote(
    pollMessage: WAMessage,
    pollUpdates: proto.IPollUpdate[],
    metadata: PollVoteMetadata,
    voterInfo: PollVoteVoterInfo,
  ): Promise<void> {
    const pollId = pollMessage.key?.id;
    if (!pollId) return;

    const pollRemoteJid = pollMessage.key?.remoteJid ?? null;

    const appliedUpdates = this.applyPollUpdatesToMessage(pollMessage, pollUpdates);
    if (!appliedUpdates.length) return;

    const aggregate = this.aggregateVotes(
      { message: pollMessage.message, pollUpdates: pollMessage.pollUpdates },
      this.sock.user?.id,
    );

    const messageId = metadata.key?.id ?? pollMessage.key?.id ?? undefined;
    if (!messageId) return;

    const timestampSource =
      metadata.timestampCandidates.find((candidate) => candidate != null) ?? undefined;
    const timestamp = toIsoDate(timestampSource);

    const meId = this.sock.user?.id;
    const lead = mapLeadFromMessage(
      buildSyntheticMessageForVoter(
        metadata.update,
        pollMessage,
        voterInfo.voterKey ?? null,
        voterInfo.voterJid,
        meId,
      ),
    );
    const contact = buildContactPayload(lead);

    let pollMetadata = await getPollMetadata(pollId, pollRemoteJid);
    if (!pollMetadata) {
      await rememberPollMetadataFromMessage(pollMessage);
      pollMetadata = await getPollMetadata(pollId, pollRemoteJid);
    }

    const { hashMap: optionHashMap, textToHash } = buildOptionHashMaps(pollMessage);

    if (pollMetadata?.options.length) {
      for (const option of pollMetadata.options) {
        const normalized = normalizePollOption(option);
        if (!normalized) continue;
        if (!optionHashMap.has(normalized.hash)) {
          optionHashMap.set(normalized.hash, { id: normalized.id, text: normalized.text });
        } else {
          const existing = optionHashMap.get(normalized.hash);
          if (existing) {
            existing.id = existing.id ?? normalized.id;
            existing.text = existing.text ?? normalized.text;
          }
        }
        if (!textToHash.has(normalized.text)) {
          textToHash.set(normalized.text, normalized.hash);
        }
      }
    }

    const selectedOptionsMap = new Map<string, { id: string | null; text: string | null }>();
    const observedOptions: Array<{ id: string | null; text: string | null; hash?: string | null }> =
      [];

    const registerSelectedOption = (
      option: { id: string | null; text: string | null } | undefined,
      hash?: string | null,
    ) => {
      if (!option) return;
      const fallbackKey = option.id ?? option.text ?? `index:${selectedOptionsMap.size}`;
      const key = hash ?? fallbackKey;
      if (!selectedOptionsMap.has(key)) {
        selectedOptionsMap.set(key, option);
        observedOptions.push({ ...option, hash: hash ?? null });
      }
    };

    const selectedOptionHashes = new Set<string>();
    for (const pollUpdateEntry of appliedUpdates) {
      const selected = pollUpdateEntry?.vote?.selectedOptions;
      if (!selected) continue;
      for (const optionHash of selected) {
        if (!optionHash) continue;
        const normalized = normalizeOptionHash(optionHash);
        if (normalized) selectedOptionHashes.add(normalized);
      }

      const optionIdCandidate = (pollUpdateEntry.vote as { pollOptionId?: unknown })?.pollOptionId;
      const normalizedId = normalizeOptionText(
        typeof optionIdCandidate === 'string' ? optionIdCandidate : null,
      );
      if (normalizedId) {
        const hashKey = textToHash.get(normalizedId) ?? computeOptionHash(normalizedId);
        registerSelectedOption(
          optionHashMap.get(hashKey) ?? { id: normalizedId, text: normalizedId },
          hashKey,
        );
      }
    }

    const voterJid = normalizeJid(voterInfo.voterJid); // normaliza só para agregação/comparação
    const selectedOptionsByVoter =
      voterJid
        ? aggregate
            .filter(
              (opt) =>
                Array.isArray(opt.voters) &&
                opt.voters.some((candidate) => normalizeJid(candidate) === voterJid),
            )
            .map((opt) => {
              const normalizedName = normalizeOptionText(
                typeof opt.name === 'string' ? opt.name : null,
              );
              if (normalizedName) {
                const optionHash = textToHash.get(normalizedName) ?? computeOptionHash(normalizedName);
                const mapped = optionHashMap.get(optionHash);
                if (mapped) return mapped;
                return { id: normalizedName, text: normalizedName };
              }
              const name = typeof opt.name === 'string' ? opt.name : null;
              return { id: name, text: name };
            })
        : [];

    for (const option of selectedOptionsByVoter) {
      const hashKey =
        option.text && textToHash.has(option.text)
          ? textToHash.get(option.text) ?? null
          : option.text
            ? computeOptionHash(option.text)
            : null;
      registerSelectedOption(option, hashKey);
    }

    for (const hash of selectedOptionHashes) {
      let option = optionHashMap.get(hash) ?? null;

      if (!option || (!option.id && !option.text)) {
        const aggregateMatch = aggregate.find((candidate) => {
          const candidateName = normalizeOptionText(
            typeof candidate.name === 'string' ? candidate.name : null,
          );
          if (!candidateName) return false;
          const candidateHash = textToHash.get(candidateName) ?? computeOptionHash(candidateName);
          return candidateHash === hash;
        });

        if (aggregateMatch) {
          const aggregateName = normalizeOptionText(
            typeof aggregateMatch.name === 'string' ? aggregateMatch.name : null,
          );
          if (aggregateName) {
            option = { id: aggregateName, text: aggregateName };
          }
        }
      }

      if (!option) {
        const fallbackText = hash ? `hash:${hash}` : 'unknown-option';
        option = { id: fallbackText, text: fallbackText };
      }

      registerSelectedOption(option, hash);
    }

    if (selectedOptionHashes.size) {
      for (const aggregateOption of aggregate) {
        const aggregateName = normalizeOptionText(
          typeof aggregateOption.name === 'string' ? aggregateOption.name : null,
        );
        if (!aggregateName) continue;
        const hashKey = textToHash.get(aggregateName) ?? computeOptionHash(aggregateName);
        if (!selectedOptionHashes.has(hashKey)) continue;

        const existing = selectedOptionsMap.get(hashKey);
        if (existing?.text) continue;

        const mapped = optionHashMap.get(hashKey) ?? { id: aggregateName, text: aggregateName };
        selectedOptionsMap.set(hashKey, mapped);
      }
    }

    // ordem canônica
    const messageMetadata = pollMetadata?.options.length
      ? null
      : extractPollMetadataFromMessage(pollMessage);
    const canonicalOptionSources = pollMetadata?.options.length
      ? pollMetadata.options
      : messageMetadata?.options ?? [];
    const canonicalOptionsOrdered: Array<{
      hash: string | null;
      text: string | null;
      id: string | null;
    }> = [];

    for (const option of canonicalOptionSources) {
      const normalized = normalizePollOption(option);
      if (!normalized) continue;
      const mapped =
        optionHashMap.get(normalized.hash) ?? {
          id: normalized.id ?? normalized.text ?? null,
          text: normalized.text ?? normalized.id ?? null,
        };
      canonicalOptionsOrdered.push({
        hash: normalized.hash,
        text: mapped.text ?? normalized.text ?? null,
        id: mapped.id ?? normalized.id ?? null,
      });
    }

    if (!canonicalOptionsOrdered.length) {
      for (const [hash, option] of optionHashMap.entries()) {
        canonicalOptionsOrdered.push({
          hash,
          text: option.text ?? option.id ?? null,
          id: option.id ?? option.text ?? null,
        });
      }
    }

    // selecionadas na ordem canônica
    const remainingSelectedOptions = new Map(selectedOptionsMap);
    const orderedSelectedOptions: Array<{ id: string | null; text: string | null }> = [];

    const takeSelectedOption = (
      hash: string | null | undefined,
      textCandidates: Array<string | null | undefined>,
    ): { id: string | null; text: string | null } | null => {
      if (hash) {
        const value = remainingSelectedOptions.get(hash);
        if (value) {
          remainingSelectedOptions.delete(hash);
          return value;
        }
      }

      for (const candidate of textCandidates) {
        if (typeof candidate !== 'string' || !candidate) continue;
        if (remainingSelectedOptions.has(candidate)) {
          const value = remainingSelectedOptions.get(candidate);
          if (value) {
            remainingSelectedOptions.delete(candidate);
            return value;
          }
        }
      }

      const normalizedTargets = new Set(
        textCandidates
          .map((value) => normalizeOptionText(value))
          .filter((value): value is string => Boolean(value)),
      );
      if (normalizedTargets.size) {
        for (const [key, value] of remainingSelectedOptions) {
          const normalizedValue = normalizeOptionText(value.text ?? value.id ?? null);
          if (normalizedValue && normalizedTargets.has(normalizedValue)) {
            remainingSelectedOptions.delete(key);
            return value;
          }
        }
      }

      return null;
    };

    for (const canonicalOption of canonicalOptionsOrdered) {
      const normalizedText = normalizeOptionText(canonicalOption.text ?? canonicalOption.id ?? null);
      const canonicalHash =
        canonicalOption.hash ??
        (normalizedText ? textToHash.get(normalizedText) ?? computeOptionHash(normalizedText) : null);
      const selection = takeSelectedOption(canonicalHash, [
        canonicalOption.text ?? null,
        canonicalOption.id ?? null,
        normalizedText ?? null,
      ]);
      if (selection) {
        orderedSelectedOptions.push(selection);
      }
    }

    const selectedOptions = [
      ...orderedSelectedOptions,
      ...Array.from(remainingSelectedOptions.values()),
    ];

    const question = extractPollQuestion(pollMessage) || pollMetadata?.question || '';

    if (observedOptions.length || question) {
      await addObservedPollMetadata(pollId, question, observedOptions, pollRemoteJid);
      pollMetadata = (await getPollMetadata(pollId, pollRemoteJid)) ?? pollMetadata;
    }

    // agregados na ordem canônica
    const aggregateEntries: Array<{
      index: number;
      hash: string | null;
      normalizedText: string | null;
      total: { id: string | null; text: string | null; votes: number };
    }> = [];
    const uniqueVoters = new Set<string>();

    aggregate.forEach((opt, index) => {
      const votes = Array.isArray(opt.voters) ? opt.voters.length : 0;
      if (Array.isArray(opt.voters)) {
        for (const voter of opt.voters) {
          if (typeof voter === 'string' && voter) uniqueVoters.add(voter);
        }
      }

      const rawText = typeof opt.name === 'string' ? opt.name : null;
      const normalizedText = normalizeOptionText(rawText);
      const hashKey =
        normalizedText ? textToHash.get(normalizedText) ?? computeOptionHash(normalizedText) : null;

      aggregateEntries.push({
        index,
        hash: hashKey,
        normalizedText,
        total: {
          id: rawText ?? normalizedText ?? null,
          text: rawText ?? normalizedText ?? null,
          votes,
        },
      });
    });

    const usedAggregateIndices = new Set<number>();
    const takeAggregateOption = (
      hash: string | null | undefined,
      textCandidates: Array<string | null | undefined>,
    ): { id: string | null; text: string | null; votes: number } | null => {
      if (hash) {
        for (const entry of aggregateEntries) {
          if (!usedAggregateIndices.has(entry.index) && entry.hash === hash) {
            usedAggregateIndices.add(entry.index);
            return entry.total;
          }
        }
      }

      for (const candidate of textCandidates) {
        if (typeof candidate !== 'string' || !candidate) continue;
        for (const entry of aggregateEntries) {
          if (!usedAggregateIndices.has(entry.index) && entry.total.text === candidate) {
            usedAggregateIndices.add(entry.index);
            return entry.total;
          }
        }
      }

      const normalizedTargets = new Set(
        textCandidates
          .map((value) => normalizeOptionText(value))
          .filter((value): value is string => Boolean(value)),
      );
      if (normalizedTargets.size) {
        for (const entry of aggregateEntries) {
          if (
            !usedAggregateIndices.has(entry.index) &&
            entry.normalizedText &&
            normalizedTargets.has(entry.normalizedText)
          ) {
            usedAggregateIndices.add(entry.index);
            return entry.total;
          }
        }
      }

      return null;
    };

    const orderedOptionTotals: Array<{ id: string | null; text: string | null; votes: number }> =
      [];

    for (const canonicalOption of canonicalOptionsOrdered) {
      const normalizedText = normalizeOptionText(canonicalOption.text ?? canonicalOption.id ?? null);
      const canonicalHash =
        canonicalOption.hash ??
        (normalizedText ? textToHash.get(normalizedText) ?? computeOptionHash(normalizedText) : null);
      const aggregateTotal = takeAggregateOption(canonicalHash, [
        canonicalOption.text ?? null,
        canonicalOption.id ?? null,
        normalizedText ?? null,
      ]);
      let mappedOption: { id: string | null; text: string | null } | null = null;
      if (canonicalHash) {
        const candidate = optionHashMap.get(canonicalHash);
        if (candidate) mappedOption = candidate;
      }
      orderedOptionTotals.push({
        id:
          mappedOption?.id ??
          canonicalOption.id ??
          canonicalOption.text ??
          aggregateTotal?.id ??
          aggregateTotal?.text ??
          null,
        text:
          mappedOption?.text ??
          canonicalOption.text ??
          canonicalOption.id ??
          aggregateTotal?.text ??
          aggregateTotal?.id ??
          null,
        votes: aggregateTotal?.votes ?? 0,
      });
    }

    for (const entry of aggregateEntries) {
      if (!usedAggregateIndices.has(entry.index)) {
        orderedOptionTotals.push(entry.total);
      }
    }

    const optionTotals = orderedOptionTotals;

    const totalVotes = optionTotals.reduce((sum, option) => sum + option.votes, 0);
    const totalVoters = uniqueVoters.size;

    const payload: PollChoiceEventPayload = {
      pollId,
      question,
      chatId: pollMessage.key?.remoteJid ?? null,
      messageId,
      timestamp,
      voterJid,
      selectedOptions,
      optionsAggregates: optionTotals,
      aggregates: {
        totalVoters,
        totalVotes,
        optionTotals,
      },
      contact,
    };

    let queued: BrokerEvent | null = null;
    if (this.eventStore) {
      queued = this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'inbound',
        type: 'POLL_CHOICE',
        payload: { ...payload },
        delivery: {
          state: 'pending',
          attempts: 0,
          lastAttemptAt: null,
        },
      });
    }

    await this.webhook.emit('POLL_CHOICE', payload, { eventId: queued?.id });
    await this.maybeSendFeedback(voterJid, payload);

    if (selectedOptions.length) {
      recordVoteSelection(messageId, { pollId, question, selectedOptions });
      this.logger.info(
        {
          messageId,
          pollId,
          voterJid,
          selected: selectedOptions.map((opt) => opt.text ?? opt.id ?? 'misterioso'),
          clue: 'registramos o voto e avisamos o MessageService — hora do webhook sorrir',
        },
        'poll.vote.selection.recorded',
      );
    } else {
      recordVoteSelection(messageId, null);
      this.logger.warn(
        {
          messageId,
          pollId,
          hint: 'nenhuma opção confirmada — talvez voto em branco ou decrypt falhou antes',
        },
        'poll.vote.selection.empty',
      );
    }
  }

  private async rehydratePollMessage(
    pollId: string | null | undefined,
    remoteJid?: string | null | undefined,
  ): Promise<WAMessage | null> {
    if (!pollId) return null;
    const metadata = await getPollMetadata(pollId, remoteJid ?? null);
    if (!metadata) return null;

    // encKeyHex já vem descriptografado pelos helpers
    const encKeyHex = metadata.encKeyHex ?? null;
    let secretBuffer: Buffer | null = null;
    if (encKeyHex) {
      try {
        const candidate = Buffer.from(encKeyHex, 'hex');
        if (candidate.length > 0) secretBuffer = candidate;
      } catch {
        secretBuffer = null;
      }
    }

    const selectableCount = metadata.selectableCount ?? DEFAULT_SELECTABLE_COUNT;
    const optionsArray = metadata.options.map((option) => ({ optionName: option.text }));

    const pollCreationPayload: Record<string, unknown> = {
      name: metadata.question ?? '',
      selectableOptionsCount: selectableCount,
    };
    if (optionsArray.length) pollCreationPayload.options = optionsArray;

    const messageContent: Record<string, unknown> = {
      pollCreationMessageV3: pollCreationPayload,
    };

    if (secretBuffer) {
      // caminho correto: dentro de message.*
      messageContent.messageContextInfo = { messageSecret: secretBuffer };
    }

    const synthetic: WAMessage = {
      key: {
        id: metadata.pollId,
        remoteJid: (metadata.remoteJid ?? normalizeJid(remoteJid)) ?? undefined,
        fromMe: true,
      },
      messageTimestamp: Date.now(),
      message: messageContent as WAMessage['message'],
    } as unknown as WAMessage;

    return synthetic;
  }

  private async maybeSendFeedback(
    voterJid: string | null | undefined,
    payload: PollChoiceEventPayload,
  ) {
    if (!this.feedbackTemplate || !voterJid || !payload.selectedOptions.length) return;
    if (this.sock.user?.id && this.sock.user.id === voterJid) return;

    const optionText = payload.selectedOptions
      .map((opt) => opt.text || opt.id || '')
      .filter((value) => value)
      .join(', ');

    const text = this.feedbackTemplate
      .replace('{question}', payload.question)
      .replace('{option}', optionText);

    try {
      if (this.messageService) {
        await this.messageService.sendText(voterJid, text, { timeoutMs: getSendTimeoutMs() });
      } else {
        await this.sock.sendMessage(voterJid, { text });
      }
    } catch (err) {
      this.logger.warn({ err, voterJid, pollId: payload.pollId }, 'poll.feedback.send.failed');
    }
  }

  private applyPollUpdatesToMessage(
    pollMessage: WAMessage,
    pollUpdates: proto.IPollUpdate[],
  ): proto.IPollUpdate[] {
    const applied: proto.IPollUpdate[] = [];
    for (const update of pollUpdates) {
      if (!update?.vote?.selectedOptions?.length) continue;
      updateMessageWithPollUpdate(pollMessage as Pick<WAMessage, 'pollUpdates'>, update);
      applied.push(update);
    }
    return applied;
  }

  private buildPollUpdatesFromUpsert(
    pollMessage: WAMessage,
    pollUpdateMessage: proto.Message.IPollUpdateMessage,
    message: WAMessage,
    voterJid: string | null,
  ): proto.IPollUpdate[] {
    const nestedUpdates = (pollUpdateMessage as { pollUpdates?: proto.IPollUpdate[] | null })
      .pollUpdates;
    if (Array.isArray(nestedUpdates) && nestedUpdates.length) {
      return this.normalizePollUpdates(nestedUpdates);
    }

    const selectedOptions = isPollVoteMessage(pollUpdateMessage.vote)
      ? pollUpdateMessage.vote.selectedOptions
      : null;
    if (Array.isArray(selectedOptions) && selectedOptions.length) {
      return this.normalizePollUpdates([pollUpdateMessage as proto.IPollUpdate]);
    }

    const decrypted = this.decryptPollUpdate(pollMessage, pollUpdateMessage, message, voterJid);
    if (!decrypted) return [];

    return this.normalizePollUpdates([decrypted]);
  }

  private normalizePollUpdates(
    pollUpdates: proto.IPollUpdate[] | null | undefined,
  ): proto.IPollUpdate[] {
    if (!Array.isArray(pollUpdates)) return [];
    return pollUpdates.filter((update) => update?.vote?.selectedOptions?.length);
  }

  /** Decriptação: usar JIDs EXATOS (com :device quando houver). */
  private decryptPollUpdate(
    pollMessage: WAMessage,
    pollUpdateMessage: proto.Message.IPollUpdateMessage,
    message: WAMessage,
    voterJidHint: string | null,
  ): proto.IPollUpdate | null {
    const encVote = pollUpdateMessage.vote;
    if (!encVote?.encPayload || !encVote.encIv) return null;

    const creationKey = pollUpdateMessage.pollCreationMessageKey ?? message.key ?? pollMessage.key;
    const pollMsgId = creationKey?.id ?? pollMessage.key?.id;
    if (!pollMsgId) return null;

    const pollEncKey = this.extractPollEncKey(pollMessage);
    const pollEncKeyHash = fingerprintSecret(pollEncKey);
    if (!pollEncKey) {
      this.logger.warn(
        {
          pollId: pollMsgId,
          hint: 'precisamos da criação antes do voto; nenhum segredo encontrado',
        },
        'poll.vote.decrypt.missingKey',
      );
      return null;
    }

    // JIDs exatos (não normalizar aqui)
    const pollCreatorJid =
      this.resolvePollCreatorJid(creationKey, pollMessage) ??
      pollMessage.key?.participant ??
      pollMessage.key?.remoteJid ??
      null;

    const resolvedVoterJid =
      voterJidHint ??
      this.resolveVoterJid(
        (pollUpdateMessage as { pollUpdateMessageKey?: proto.IMessageKey | null })
          ?.pollUpdateMessageKey ?? null,
        message.key,
      ) ??
      null;

    if (!pollCreatorJid || !resolvedVoterJid) {
      const logContext: Record<string, unknown> = { pollId: pollMsgId };
      if (pollEncKeyHash) logContext.pollEncKeyHash = pollEncKeyHash;
      logContext.hint = 'pollCreatorJid ou voterJid ficaram nulos — jids exatos são obrigatórios';
      this.logger.warn(logContext, 'poll.vote.decrypt.missingParticipants');
      return null;
    }

    const pollUpdateKey =
      (pollUpdateMessage as { pollUpdateMessageKey?: proto.IMessageKey | null })
        ?.pollUpdateMessageKey ?? message.key ?? null;

    const rawSenderLid =
      ((message.key as unknown as { senderLid?: string | null }).senderLid ??
        (message as unknown as { senderLid?: string | null }).senderLid ??
        (pollUpdateMessage as unknown as { senderLid?: string | null }).senderLid ??
        null) ?? null;

    const creationKeyParticipant = creationKey?.participant ?? null;
    const creationKeyRemote = creationKey?.remoteJid ?? null;
    const pollMessageKeyParticipant = pollMessage.key?.participant ?? null;
    const pollMessageKeyRemote = pollMessage.key?.remoteJid ?? null;
    const pollUpdateParticipant = pollUpdateKey?.participant ?? null;
    const pollUpdateRemote = pollUpdateKey?.remoteJid ?? null;
    const selfId = this.sock.user?.id ?? null;

    const collectCandidates = (
      items: Array<{ label: string; value: string | null | undefined }>
    ): Array<{ label: string; value: string }> => {
      const result: Array<{ label: string; value: string }> = [];
      const seenValues = new Set<string>();
      for (const item of items) {
        const value = typeof item.value === 'string' ? item.value.trim() : '';
        if (!value) continue;
        if (seenValues.has(value)) continue;
        seenValues.add(value);
        result.push({ label: item.label, value });
      }
      return result;
    };

    const maybeLidVariants = (value: string | null | undefined): Array<{ label: string; value: string }> => {
      if (!value) return [];
      const trimmed = value.trim();
      if (!trimmed) return [];
      const candidates: Array<{ label: string; value: string }> = [{ label: 'raw', value: trimmed }];
      if (isLidUser(trimmed)) {
        const decoded = jidDecode(trimmed);
        if (decoded?.user) {
          candidates.push({
            label: 'lid->user-s.whatsapp',
            value: jidEncode(decoded.user, 's.whatsapp.net', decoded?.device),
          });
        }
      } else if (!trimmed.endsWith('@lid')) {
        // try mapping to lid namespace (heurística)
        const decoded = jidDecode(trimmed);
        if (decoded?.user) {
          candidates.push({
            label: 'user->lid',
            value: jidEncode(decoded.user, 'lid', decoded?.device),
          });
        }
      }
      const seen = new Set<string>();
      return candidates.filter((entry) => {
        if (seen.has(entry.value)) return false;
        seen.add(entry.value);
        return true;
      });
    };

    const addVariants = (
      list: Array<{ label: string; value: string }>,
      label: string,
      value: string | null | undefined,
    ) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed) return;
      list.push({ label, value: trimmed });
      const normalized = jidNormalizedUser(trimmed);
      if (normalized && normalized !== trimmed) {
        list.push({ label: `${label}.jidNormalized`, value: normalized });
      }
      if (trimmed.includes(':')) {
        const decoded = jidDecode(trimmed);
        if (decoded?.user) {
          const noDevice = jidEncode(decoded.user, decoded.server);
          if (noDevice !== trimmed) {
            list.push({ label: `${label}.noDevice`, value: noDevice });
          }
        }
      } else {
        const decoded = jidDecode(trimmed);
        if (decoded?.user && decoded?.device != null) {
          const withDevice = jidEncode(decoded.user, decoded.server, decoded.device);
          if (withDevice !== trimmed) {
            list.push({ label: `${label}.withDevice`, value: withDevice });
          }
        }
      }
    };

    const baseCreatorCandidates: Array<{ label: string; value: string }> = [];
    addVariants(baseCreatorCandidates, 'creator.exact', pollCreatorJid);
    addVariants(baseCreatorCandidates, 'creator.creationKey.participant', creationKeyParticipant);
    addVariants(baseCreatorCandidates, 'creator.creationKey.remote', creationKeyRemote);
    addVariants(baseCreatorCandidates, 'creator.pollMessage.participant', pollMessageKeyParticipant);
    addVariants(baseCreatorCandidates, 'creator.pollMessage.remote', pollMessageKeyRemote);
    addVariants(baseCreatorCandidates, 'creator.self', selfId);

    const creatorCandidates: Array<{ label: string; value: string }> = [];
    for (const candidate of baseCreatorCandidates) {
      creatorCandidates.push(candidate);
      for (const variant of maybeLidVariants(candidate.value)) {
        creatorCandidates.push({
          label: `${candidate.label}->${variant.label}`,
          value: variant.value,
        });
      }
    }

    const baseVoterCandidates: Array<{ label: string; value: string }> = [];
    addVariants(baseVoterCandidates, 'voter.exact', resolvedVoterJid);
    addVariants(baseVoterCandidates, 'voter.key.participant', message.key?.participant ?? null);
    addVariants(baseVoterCandidates, 'voter.key.remote', message.key?.remoteJid ?? null);
    addVariants(baseVoterCandidates, 'voter.pollUpdateKey.participant', pollUpdateParticipant);
    addVariants(baseVoterCandidates, 'voter.pollUpdateKey.remote', pollUpdateRemote);
    addVariants(baseVoterCandidates, 'voter.creationKey.remote', creationKeyRemote);
    addVariants(baseVoterCandidates, 'voter.creationKey.participant', creationKeyParticipant);
    addVariants(baseVoterCandidates, 'voter.pollMessage.participant', pollMessageKeyParticipant);
    addVariants(baseVoterCandidates, 'voter.pollMessage.remote', pollMessageKeyRemote);
    addVariants(baseVoterCandidates, 'voter.hint', voterJidHint);

    const rawSenderLidCandidates = maybeLidVariants(rawSenderLid);
    for (const entry of rawSenderLidCandidates) {
      addVariants(baseVoterCandidates, `voter.senderLid.${entry.label}`, entry.value);
    }

    const receiptHintsForVote = this.receiptHints.get(message.key?.id ?? '') ?? new Set<string>();
    for (const hint of receiptHintsForVote) {
      addVariants(baseVoterCandidates, 'voter.receiptHint', hint);
    }

    const receiptHintsForPoll = this.receiptHints.get(pollMsgId) ?? new Set<string>();
    for (const hint of receiptHintsForPoll) {
      addVariants(baseCreatorCandidates, 'creator.receiptHint', hint);
    }

    const voterCandidates: Array<{ label: string; value: string }> = [];
    for (const candidate of baseVoterCandidates) {
      voterCandidates.push(candidate);
      for (const variant of maybeLidVariants(candidate.value)) {
        voterCandidates.push({
          label: `${candidate.label}->${variant.label}`,
          value: variant.value,
        });
      }
    }

    const creatorMap = collectCandidates(creatorCandidates);
    const voterMap = collectCandidates(voterCandidates);

    this.logger.info(
      {
        pollId: pollMsgId,
        creatorCandidates: creatorMap,
        voterCandidates: voterMap,
        clue: 'lista completa de identidades que vamos testar — JIDs alinhados e prontos',
      },
      'poll.vote.decrypt.candidate_map',
    );

    const attempts: Array<{ creator: string; voter: string; label: string }> = [];
    const seen = new Set<string>();
    const enqueueAttempt = (
      creator: { label: string; value: string },
      voter: { label: string; value: string },
    ) => {
      if (!creator?.value || !voter?.value) return;
      const key = `${creator.value}__${voter.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      attempts.push({
        creator: creator.value,
        voter: voter.value,
        label: `${creator.label}|${voter.label}`,
      });
    };

    for (const creator of creatorMap) {
      for (const voter of voterMap) {
        enqueueAttempt(creator, voter);
      }
    }

    if (!attempts.length) {
      this.logger.warn(
        {
          pollId: pollMsgId,
          pollEncKeyHash,
          clue: 'não conseguimos gerar pares de JID para tentar decifrar — inputs insuficientes',
        },
        'poll.vote.decrypt.no_attempts',
      );
      return null;
    }

    const errors: Array<{ attempt: string; error: string }> = [];

    for (const attempt of attempts) {
      this.logger.info(
        {
          pollId: pollMsgId,
          pollCreatorJid: attempt.creator,
          voterJid: attempt.voter,
          pollEncKeyHash,
          attempt: attempt.label,
          clue: 'tentativa de decifrar o voto — vamos ver se essa chave abre o cofre',
          pollUpdateMessageKey: {
            id: pollUpdateKey?.id ?? null,
            remoteJid: pollUpdateKey?.remoteJid ?? null,
            participant: pollUpdateKey?.participant ?? null,
          },
        },
        'poll.vote.decrypt.attempt',
      );

      try {
        const vote = this.decryptPollVote(encVote, {
          pollCreatorJid: attempt.creator,
          pollMsgId,
          pollEncKey,
          voterJid: attempt.voter,
        });

        if (attempt.label !== 'exact') {
          this.logger.info(
            {
              pollId: pollMsgId,
              attempt: attempt.label,
              note: 'fallback funcionou — chaves harmonizadas com sucesso',
            },
            'poll.vote.decrypt.fallback_success',
          );
        }

        return {
          pollUpdateMessageKey: pollUpdateMessage.pollUpdateMessageKey ?? message.key ?? undefined,
          vote,
          senderTimestampMs: pollUpdateMessage.senderTimestampMs ?? undefined,
          serverTimestampMs: pollUpdateMessage.metadata?.serverTimestampMs ?? undefined,
        } as proto.IPollUpdate;
      } catch (err) {
        errors.push({
          attempt: attempt.label,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }

    this.logger.warn(
      {
        pollId: pollMsgId,
        pollEncKeyHash,
        receiptHintsVote: Array.from(receiptHintsForVote),
        receiptHintsPoll: Array.from(receiptHintsForPoll),
        attempts: errors,
        pollUpdateMessageKey: {
          id: pollUpdateKey?.id ?? null,
          remoteJid: pollUpdateKey?.remoteJid ?? null,
          participant: pollUpdateKey?.participant ?? null,
        },
        tip: 'se continuar falhando, confira se o messageSecret foi salvo ou se o voto veio de outro dispositivo',
      },
      'poll.vote.decrypt.failed',
    );
    return null;
  }

  private ensureReceiptBucket(messageId: string): Set<string> {
    let bucket = this.receiptHints.get(messageId);
    if (!bucket) {
      bucket = new Set();
      this.receiptHints.set(messageId, bucket);
    }
    return bucket;
  }

  private noteReceiptHint(
    bucket: Set<string>,
    messageId: string,
    label: string,
    value: string | null | undefined,
  ): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (bucket.has(trimmed)) return;
    bucket.add(trimmed);
    const normalized = jidNormalizedUser(trimmed);
    if (normalized && normalized !== trimmed && !bucket.has(normalized)) {
      bucket.add(normalized);
    }
    this.logger.info(
      {
        messageId,
        label,
        hint: trimmed,
        normalizedHint: normalized && normalized !== trimmed ? normalized : null,
      },
      'poll.vote.hint.receipt',
    );
  }

  /** Busca encKey: payload → contextInfo → message.messageContextInfo → cache persistido (hex). */
  private extractPollEncKey(pollMessage: WAMessage): Uint8Array | null {
    const pollCreations = [
      pollMessage.message?.pollCreationMessage,
      (pollMessage.message as { pollCreationMessageV2?: proto.Message.IPollCreationMessage | null })
        ?.pollCreationMessageV2 ?? undefined,
      (pollMessage.message as { pollCreationMessageV3?: proto.Message.IPollCreationMessage | null })
        ?.pollCreationMessageV3 ?? undefined,
    ];

    // 1) encKey/contextInfo no payload de criação
    for (const creation of pollCreations) {
      const encKey = this.toUint8Array(
        (creation as { encKey?: Uint8Array | string | null })?.encKey,
      );
      if (encKey) return encKey;

      const secret = this.toUint8Array(
        (
          creation?.contextInfo as
            | { messageSecret?: Uint8Array | string | null }
            | null
            | undefined
        )?.messageSecret,
      );
      if (secret) return secret;
    }

    // 2) message.messageContextInfo (caminho correto dentro do WAMessage)
    const messageContextSecret = this.toUint8Array(
      (pollMessage.message as {
        messageContextInfo?:
          | { messageSecret?: Uint8Array | string | null }
          | null
          | undefined;
      })?.messageContextInfo?.messageSecret,
    );
    if (messageContextSecret) return messageContextSecret;

    // 3) fallback do cache (encKeyHex em hex)
    const pollId = pollMessage.key?.id;
    if (pollId) {
      const cached = getPollMetadataFromCache(pollId, pollMessage.key?.remoteJid ?? null);
      const encKeyHex = cached?.encKeyHex ?? null;
      if (encKeyHex) {
        try {
          const buf = Buffer.from(encKeyHex, 'hex');
          if (buf.length > 0) return new Uint8Array(buf);
        } catch {
          // ignora hex inválido
        }
      }
    }

    return null;
  }

  private toUint8Array(
    value: Uint8Array | Buffer | string | null | undefined,
  ): Uint8Array | null {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;

      // tenta hex primeiro (evita interpretar hex válido como base64)
      if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          const hex = Buffer.from(trimmed, 'hex');
          if (hex.length > 0) return new Uint8Array(hex);
        } catch {
          // ignore
        }
      }

      // tenta base64
      try {
        const base64 = Buffer.from(trimmed, 'base64');
        if (base64.length > 0) return new Uint8Array(base64);
      } catch {
        // ignore
      }
    }
    return null;
  }

  private resolvePollCreatorJid(
    creationKey: proto.IMessageKey | null | undefined,
    pollMessage: WAMessage,
  ): string | null {
    if (creationKey) {
      const author = getKeyAuthor(creationKey, this.sock.user?.id);
      if (author) return author;
    }
    return pollMessage.key?.participant ?? pollMessage.key?.remoteJid ?? null;
  }
}
