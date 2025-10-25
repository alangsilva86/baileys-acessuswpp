import type { WAMessage } from '@whiskeysockets/baileys';

/* ============================================================================
 * Tipos
 * ========================================================================== */
type MessageContent = NonNullable<NonNullable<WAMessage['message']>>;

/* ============================================================================
 * Constantes e helpers puros (sem alocação por chamada)
 * ========================================================================== */
const MEDIA_KEYS: readonly (keyof MessageContent)[] = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'locationMessage',
  'liveLocationMessage',
  'contactMessage',
  'contactsArrayMessage',
  'documentWithCaptionMessage',
  'productMessage',
  'orderMessage',
];

const INTERACTIVE_KEYS: readonly (keyof MessageContent)[] = [
  'buttonsResponseMessage',
  'templateButtonReplyMessage',
  'listResponseMessage',
  'interactiveResponseMessage',
];

const IGNORED_TYPE_KEYS = new Set<string>(['messageContextInfo']);

/** Trim seguro que não explode com tipos esquisitos. */
function sanitize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Retorna true se obj é não nulo e tem chaves úteis. */
function isNonEmptyObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const _ in value as Record<string, unknown>) return true;
  return false;
}

/* ============================================================================
 * Unwrap: remove wrappers sem recursão (barato e previsível)
 * ========================================================================== */
function unwrapContent(initial: MessageContent | null | undefined): MessageContent | null {
  let content: MessageContent | null = (initial ?? null) as MessageContent | null;

  while (content) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message as MessageContent;
      continue;
    }
    if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message as MessageContent;
      continue;
    }
    if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message as MessageContent;
      continue;
    }
    if (content.viewOnceMessageV2Extension?.message) {
      content = content.viewOnceMessageV2Extension.message as MessageContent;
      continue;
    }
    if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message as MessageContent;
      continue;
    }
    break;
  }

  return content;
}

/* ============================================================================
 * Predicados de conteúdo
 * ========================================================================== */
function hasMediaContent(content: MessageContent): boolean {
  for (const key of MEDIA_KEYS) {
    if ((content as Record<string, unknown>)[key as string] != null) return true;
  }
  return false;
}

function hasInteractiveContent(content: MessageContent): boolean {
  for (const key of INTERACTIVE_KEYS) {
    if ((content as Record<string, unknown>)[key as string] != null) return true;
  }
  return false;
}

/* ============================================================================
 * Extração de texto
 * ========================================================================== */
function extractTextFromContent(content: MessageContent): string | null {
  // Candidatos diretos/caption
  const direct = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.pollCreationMessage?.name,
    content.pollCreationMessageV2?.name,
    content.pollCreationMessageV3?.name,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
  ];

  for (const c of direct) {
    const s = sanitize(c);
    if (s) return s;
  }

  // Resposta de botões
  const btn =
    sanitize(content.buttonsResponseMessage?.selectedDisplayText) ||
    sanitize(content.buttonsResponseMessage?.selectedButtonId);
  if (btn) return btn;

  // Resposta de template button
  const tpl =
    sanitize(content.templateButtonReplyMessage?.selectedDisplayText) ||
    sanitize(content.templateButtonReplyMessage?.selectedId);
  if (tpl) return tpl;

  // Resposta de lista
  const list =
    sanitize(content.listResponseMessage?.title) ||
    sanitize(content.listResponseMessage?.description) ||
    sanitize(content.listResponseMessage?.singleSelectReply?.selectedRowId);
  if (list) return list;

  // Resposta interativa native flow (passa paramsJson em string)
  const interactiveJson = sanitize(
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
  );
  if (interactiveJson) return interactiveJson;

  return null;
}

/* ============================================================================
 * Heurística: vale a pena processar?
 * ========================================================================== */
function hasUsefulContent(content: MessageContent): boolean {
  if ((content as { protocolMessage?: unknown }).protocolMessage) return false;
  if ((content as { historySyncNotification?: unknown }).historySyncNotification) return false;

  // Voto de enquete deve chegar ao PollService
  const pollUpdate =
    (content as { pollUpdateMessage?: unknown }).pollUpdateMessage ??
    (content as { pollUpdateMessageV2?: unknown }).pollUpdateMessageV2 ??
    (content as { pollUpdateMessageV3?: unknown }).pollUpdateMessageV3;
  if (pollUpdate) return true;

  if (extractTextFromContent(content)) return true;
  if (hasMediaContent(content)) return true;
  if (hasInteractiveContent(content)) return true;

  return false;
}

/* ============================================================================
 * API pública
 * ========================================================================== */
export function getNormalizedMessageContent(message: WAMessage): MessageContent | null {
  return unwrapContent(message?.message as MessageContent | null | undefined);
}

export function extractMessageType(message: WAMessage): string | null {
  const content = getNormalizedMessageContent(message);
  if (!content) return null;

  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (IGNORED_TYPE_KEYS.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'object' && !isNonEmptyObject(value)) continue;
    return key;
  }

  return null;
}

export function extractMessageText(message: WAMessage): string | null {
  const content = getNormalizedMessageContent(message);
  return content ? extractTextFromContent(content) : null;
}

export function hasClientMessageContent(message: WAMessage): boolean {
  if (!message || message.key?.fromMe) return false;

  // Ignora stubs (eventos do WhatsApp que não são conversas do usuário)
  const stubType = (message as unknown as Record<string, unknown>).messageStubType;
  if (stubType !== undefined && stubType !== null) return false;

  const content = getNormalizedMessageContent(message);
  if (!content) return false;

  return hasUsefulContent(content);
}

export function filterClientMessages(
  messages: readonly WAMessage[] | null | undefined,
): WAMessage[] {
  if (!messages?.length) return [];
  const out: WAMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (hasClientMessageContent(m)) out.push(m);
  }
  return out;
}