import type { WAMessage } from '@whiskeysockets/baileys';
import type pino from 'pino';
import type { BrokerEventDirection } from '../broker/eventStore.js';
import type { LidMappingStore } from '../lidMappingStore.js';
import {
  getPollMetadataFromCache,
  getVoteSelection,
  normalizeJid,
} from './pollMetadata.js';

export interface PollChoiceMetadata {
  pollId: string | null;
  question: string | null;
  selectedOptions: Array<{ id: string | null; text: string | null }>;
  optionIds: string[];
}

export interface PollResolution {
  text: string | null;
  pollChoice: PollChoiceMetadata | null;
  shouldClearSelection: boolean;
}

function stringifySelectedOptions(options: Array<{ id: string | null; text: string | null }>): string | null {
  const parts = options
    .map((opt) =>
      (typeof opt.text === 'string' && opt.text.trim()) ||
      (typeof opt.id === 'string' && opt.id.trim()) ||
      '',
    )
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function resolvePollChoice(
  message: WAMessage,
  direction: BrokerEventDirection,
  mappingStore: LidMappingStore | null,
  logger: pino.Logger | null = null,
): PollResolution {
  const messageId = message.key?.id ?? null;
  const voteSelection = getVoteSelection(messageId);
  let pollChoice: PollChoiceMetadata | null = null;
  let normalizedSelectedOptions: Array<{ id: string | null; text: string | null }> = [];

  if (voteSelection) {
    normalizedSelectedOptions = (voteSelection.selectedOptions ?? []).map((opt) => ({
      id: opt?.id ?? null,
      text: opt?.text ?? null,
    }));
    const optionIds = normalizedSelectedOptions
      .map((opt) => (typeof opt.id === 'string' ? opt.id.trim() : ''))
      .filter((id): id is string => Boolean(id));
    pollChoice = {
      pollId: typeof voteSelection.pollId === 'string' ? voteSelection.pollId : null,
      question: typeof voteSelection.question === 'string' ? voteSelection.question : null,
      selectedOptions: normalizedSelectedOptions,
      optionIds,
    };
  }

  let voteText = pollChoice ? stringifySelectedOptions(normalizedSelectedOptions) : null;

  if (!voteText) {
    const pollUpdate = message.message?.pollUpdateMessage;
    if (pollUpdate?.vote?.encPayload && pollUpdate.vote.encIv) {
      const pollId = pollUpdate.pollCreationMessageKey?.id ?? null;
      const pollRemoteRaw = pollUpdate.pollCreationMessageKey?.remoteJid ?? message.key?.remoteJid ?? null;
      const pollRemoteAlt = (pollUpdate.pollCreationMessageKey as any)?.remoteJidAlt ?? (message.key as any)?.remoteJidAlt ?? null;
      const normalizedRemote =
        mappingStore?.resolveRemoteJid(pollRemoteRaw, pollRemoteAlt) ?? normalizeJid(pollRemoteRaw);
      const metadata = (pollId ? getPollMetadataFromCache(pollId, normalizedRemote) : null) ?? null;

      if (!metadata) {
        logger?.info?.(
          {
            messageId,
            pollId,
            pollUpdateMessageId: pollUpdate.pollUpdateMessageKey?.id ?? null,
            remoteJid: pollRemoteRaw ?? null,
            clue: 'sem metadados, estamos sem mapa do tesouro — talvez a criação não tenha sido vista',
          },
          'poll.vote.metadata.missing',
        );
      } else {
        logger?.info?.(
          {
            messageId,
            pollId,
            optionsCount: metadata.options.length,
            hasEncKey: Boolean(metadata.encKeyHex),
            encKeyPreview: metadata.encKeyHex
              ? `${metadata.encKeyHex.slice(0, 8)}…${metadata.encKeyHex.slice(-8)}`
              : null,
            clue: 'metadados recuperados — hora de traduzir o voto',
          },
          'poll.vote.metadata.ready',
        );
      }
    }

    if (!voteText) {
      logger?.warn?.(
        {
          messageId,
          clue: 'voto recebido mas nenhum texto decifrado — confira logs do PollService',
        },
        'poll.vote.text.missing',
      );
    }
  }

  const pickedTextFromVote = !!pollChoice && !!voteText;
  const shouldClearSelection = pickedTextFromVote && direction === 'inbound' && Boolean(messageId);

  return { text: voteText, pollChoice, shouldClearSelection };
}
