import type { proto, WAMessage } from '@whiskeysockets/baileys';
import type Long from 'long';

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

declare module '@whiskeysockets/baileys' {
  namespace proto {
    namespace Message {
      interface IPollUpdateMessage {
        pollUpdateMessageKey?: proto.IMessageKey | null;
        pollCreationMessageKey?: proto.IMessageKey | null;
        metadata?: proto.Message.PollUpdateMessage.IMetadata | null;
      }

      interface IPollUpdateMessageMetadata {
        serverTimestampMs?: number | Long | bigint | null;
      }

      namespace PollUpdateMessage {
        interface IMetadata {
          serverTimestampMs?: number | Long | bigint | null;
        }
      }
    }

    interface IContextInfo {
      messageSecret?: Uint8Array | null;
    }
  }
}
