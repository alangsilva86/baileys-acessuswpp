export type PipedriveMessageStatus = 'sent' | 'delivered' | 'read' | 'failed';
export type PipedriveParticipantRole = 'end_user' | 'source_user';

export interface PipedriveAttachment {
  id: string;
  type: string;
  name?: string | null;
  url: string;
}

export interface PipedriveMessage {
  id: string;
  status: PipedriveMessageStatus;
  created_at: string;
  message: string;
  sender_id: string;
  reply_by?: string | null;
  attachments?: PipedriveAttachment[];
}

export interface PipedriveParticipant {
  id: string;
  name: string;
  role: PipedriveParticipantRole;
  avatar_url?: string | null;
  avatar_expires?: string | null;
  fetch_avatar?: boolean;
}

export interface PipedriveConversation {
  id: string;
  link?: string | null;
  status: 'open' | 'closed';
  seen: boolean;
  next_messages_cursor?: string | null;
  messages: PipedriveMessage[];
  participants: PipedriveParticipant[];
}
