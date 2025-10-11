import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import { filterClientMessages } from '../src/baileys/messageUtils.js';

function createMessage(
  id: string,
  overrides: Partial<WAMessage> & { message?: NonNullable<WAMessage['message']> },
): WAMessage {
  return {
    key: {
      id,
      remoteJid: '123@s.whatsapp.net',
      fromMe: false,
    },
    messageTimestamp: 1,
    message: overrides.message,
    ...overrides,
  } as unknown as WAMessage;
}

test('filterClientMessages removes messages without useful client content', () => {
  const validText = createMessage('msg-1', {
    message: { conversation: 'hello world' },
  });

  const validMedia = createMessage('msg-2', {
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'photo' } as any },
  });

  const invalidFromMe = {
    ...validText,
    key: { ...validText.key, id: 'msg-3', fromMe: true },
  } as WAMessage;

  const invalidStub = {
    ...createMessage('msg-4', { message: { conversation: 'stub' } }),
    messageStubType: 1,
  } as unknown as WAMessage;

  const invalidProtocol = createMessage('msg-5', {
    message: { protocolMessage: {} as any },
  });

  const invalidHistory = createMessage('msg-6', {
    message: { historySyncNotification: {} as any },
  });

  const invalidEmpty = createMessage('msg-7', {
    message: {} as any,
  });

  const filtered = filterClientMessages([
    validText,
    validMedia,
    invalidFromMe,
    invalidStub,
    invalidProtocol,
    invalidHistory,
    invalidEmpty,
  ]);

  assert.deepStrictEqual(
    filtered.map((message) => message.key?.id),
    ['msg-1', 'msg-2'],
  );
});
