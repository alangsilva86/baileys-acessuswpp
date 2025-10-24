import type { proto, WAMessage } from '@whiskeysockets/baileys';

declare module '@whiskeysockets/baileys/lib/Utils/messages.js' {
  export const extractMessageContent: (
    content: proto.IMessage | null | undefined,
  ) => proto.IMessage | undefined;
  export const updateMessageWithPollUpdate: (
    msg: Pick<WAMessage, 'pollUpdates'>,
    update: proto.IPollUpdate,
  ) => void;
}

declare module '@whiskeysockets/baileys/lib/Utils/process-message.js' {
  export function decryptPollVote(
    vote: proto.Message.IPollEncValue,
    ctx: {
      pollCreatorJid: string;
      pollMsgId: string;
      pollEncKey: Uint8Array;
      voterJid: string;
    },
  ): proto.Message.PollVoteMessage;
}
