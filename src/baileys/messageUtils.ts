import type { WAMessage } from '@whiskeysockets/baileys';

type MessageContent = NonNullable<NonNullable<WAMessage['message']>>;

function unwrapContent(content: MessageContent | null | undefined): MessageContent | null {
  if (!content) return null;

  if (content.ephemeralMessage?.message) {
    return unwrapContent(content.ephemeralMessage.message as MessageContent);
  }

  if (content.viewOnceMessage?.message) {
    return unwrapContent(content.viewOnceMessage.message as MessageContent);
  }

  if (content.viewOnceMessageV2?.message) {
    return unwrapContent(content.viewOnceMessageV2.message as MessageContent);
  }

  if (content.viewOnceMessageV2Extension?.message) {
    return unwrapContent(content.viewOnceMessageV2Extension.message as MessageContent);
  }

  if (content.documentWithCaptionMessage?.message) {
    return unwrapContent(content.documentWithCaptionMessage.message as MessageContent);
  }

  return content;
}

function sanitize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasMediaContent(content: MessageContent): boolean {
  const candidates = [
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

  return candidates.some((key) => Boolean((content as Record<string, unknown>)[key]));
}

function hasInteractiveContent(content: MessageContent): boolean {
  const interactiveKeys = [
    'buttonsResponseMessage',
    'templateButtonReplyMessage',
    'listResponseMessage',
    'interactiveResponseMessage',
  ];

  return interactiveKeys.some((key) => Boolean((content as Record<string, unknown>)[key]));
}

function extractTextFromContent(content: MessageContent): string | null {
  const candidates = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.pollCreationMessage?.name,
    content.pollCreationMessageV2?.name,
    content.pollCreationMessageV3?.name,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
  ];

  for (const candidate of candidates) {
    const sanitized = sanitize(candidate);
    if (sanitized) return sanitized;
  }

  const buttonReplyText =
    sanitize(content.buttonsResponseMessage?.selectedDisplayText) ||
    sanitize(content.buttonsResponseMessage?.selectedButtonId);
  if (buttonReplyText) return buttonReplyText;

  const templateReplyText =
    sanitize(content.templateButtonReplyMessage?.selectedDisplayText) ||
    sanitize(content.templateButtonReplyMessage?.selectedId);
  if (templateReplyText) return templateReplyText;

  const listReplyText =
    sanitize(content.listResponseMessage?.title) ||
    sanitize(content.listResponseMessage?.description) ||
    sanitize(content.listResponseMessage?.singleSelectReply?.selectedRowId);
  if (listReplyText) return listReplyText;

  const interactiveJson = sanitize(
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
  );
  if (interactiveJson) return interactiveJson;

  return null;
}

function hasUsefulContent(content: MessageContent): boolean {
  if (content.protocolMessage) return false;

  const historySync = (content as { historySyncNotification?: unknown }).historySyncNotification;
  if (historySync) return false;

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

export function getNormalizedMessageContent(message: WAMessage): MessageContent | null {
  return unwrapContent(message.message as MessageContent | null | undefined);
}

export function extractMessageType(message: WAMessage): string | null {
  const content = getNormalizedMessageContent(message);
  if (!content) return null;

  const ignoredKeys = new Set(['messageContextInfo']);

  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (ignoredKeys.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0) {
      continue;
    }
    return key;
  }

  return null;
}

export function extractMessageText(message: WAMessage): string | null {
  const content = getNormalizedMessageContent(message);
  if (!content) return null;
  return extractTextFromContent(content);
}

export function hasClientMessageContent(message: WAMessage): boolean {
  if (!message || message.key?.fromMe) return false;

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
  return messages.filter((message) => hasClientMessageContent(message));
}
