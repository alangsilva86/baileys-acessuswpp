import makeWASocket, {
  DEFAULT_CONNECTION_CONFIG,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { MessageService } from './message.service';
import { PollService } from './poll.service';
import { WebhookClient, type WebhookClientOptions } from '../services/webhook';

export interface BootOptions {
  authDir?: string;
  logger?: pino.Logger;
  instanceId?: string;
  printQRInTerminal?: boolean;
  webhookOptions?: WebhookClientOptions;
}

export interface WaContext {
  sock: WASocket;
  pollService: PollService;
  messageService: MessageService;
  webhook: WebhookClient;
}

export async function bootBaileys(options: BootOptions = {}): Promise<WaContext> {
  const authDir = options.authDir ?? process.env.AUTH_DIR ?? './auth';
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = DEFAULT_CONNECTION_CONFIG.version;

  logger.info({ authDir, version }, 'baileys.boot');

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: options.printQRInTerminal ?? false,
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  const webhook = new WebhookClient({
    ...(options.webhookOptions || {}),
    logger,
    instanceId: options.instanceId,
  });

  const pollService = new PollService(sock, webhook, logger);
  const messageService = new MessageService(sock, webhook, logger);

  sock.ev.on('messages.upsert', async (event) => {
    try {
      await pollService.onMessageUpsert(event);
    } catch (err) {
      logger.warn({ err }, 'poll.service.messages.upsert.failed');
    }

    try {
      await messageService.onMessagesUpsert(event);
    } catch (err) {
      logger.warn({ err }, 'message.service.messages.upsert.failed');
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    try {
      await pollService.onMessageUpdate(updates);
    } catch (err) {
      logger.warn({ err }, 'poll.service.messages.update.failed');
    }
  });

  return {
    sock,
    pollService,
    messageService,
    webhook,
  };
}

