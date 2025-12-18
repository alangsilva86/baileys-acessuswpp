import 'dotenv/config';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import pino from 'pino';
import { getAllInstances, loadInstances, startAllInstances } from './instanceManager.js';
import instanceRoutes from './routes/instances.js';
import { brokerEventEmitter, brokerEventStore, type BrokerEvent } from './broker/eventStore.js';
import { initSendQueue, startSendWorker } from './queue/sendQueue.js';
import { getProxyValidationMetrics } from './network/proxyValidator.js';

const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SERVICE_NAME = process.env.SERVICE_NAME || 'baileys-api';

const logger = pino({ level: LOG_LEVEL, base: { service: SERVICE_NAME } });

interface RequestWithId extends Request {
  id?: string;
}

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const STREAM_PING_INTERVAL_MS = 15000;
const STREAM_BACKLOG_LIMIT = 200;

const app = express();
app.disable('x-powered-by');

const defaultCsp = helmet.contentSecurityPolicy.getDefaultDirectives();
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...defaultCsp,
        'script-src': [
          ...(defaultCsp['script-src'] ?? []),
          'https://cdn.jsdelivr.net',
        ],
        'connect-src': Array.from(
          new Set([
            ...(defaultCsp['connect-src'] ?? ["'self'"]),
            "'self'",
            'https://cdn.jsdelivr.net',
          ]),
        ),
        'img-src': [
          ...(defaultCsp['img-src'] ?? []),
          'blob:',
        ],
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.use((req, res, next) => {
  const request = req as RequestWithId;
  request.id = crypto.randomUUID();
  const start = Date.now();
  logger.info({ reqId: request.id, method: req.method, url: req.url }, 'request.start');
  res.on('finish', () => {
    logger.info(
      {
        reqId: request.id,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        ms: Date.now() - start,
      },
      'request.end',
    );
  });
  next();
});

app.use('/instances', instanceRoutes);

app.get('/health', (_req, res) => {
  const instances = getAllInstances().map((inst) => ({
    id: inst.id,
    connected: inst.connectionState === 'open',
    connectionState: inst.connectionState,
    connectionUpdatedAt: inst.connectionUpdatedAt ? new Date(inst.connectionUpdatedAt).toISOString() : null,
  }));
  const queue = brokerEventStore.metrics();
  const proxyMetrics = getProxyValidationMetrics();
  res.json({ status: 'ok', uptime: process.uptime(), instances, queue, proxyMetrics });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const streamClients = new Map<Response, { id: string }>();

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof req.socket?.setKeepAlive === 'function') {
    req.socket.setKeepAlive(true);
  }
  const serverResponse = res as Response & { flushHeaders?: () => void };
  if (typeof serverResponse.flushHeaders === 'function') {
    serverResponse.flushHeaders();
  }

  const clientId = crypto.randomUUID();
  streamClients.set(res, { id: clientId });
  logger.info({ clientId, ip: req.ip, connections: streamClients.size }, 'stream.client.connected');

  const sendEvent = (event: BrokerEvent) => {
    try {
      res.write(`id: ${event.id}\n`);
      res.write('event: broker:event\n');
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.warn({ clientId, err }, 'stream.client.write_failed');
    }
  };

  const lastEventId = req.get('last-event-id') || req.get('Last-Event-ID');
  const recent = brokerEventStore.recent({ limit: STREAM_BACKLOG_LIMIT });
  const cutoffSequence = lastEventId
    ? recent.find((item) => item.id === lastEventId)?.sequence ?? 0
    : 0;
  recent
    .filter((item) => item.sequence > cutoffSequence)
    .sort((a, b) => a.sequence - b.sequence)
    .forEach((item) => sendEvent(item));

  const onEvent = (event: BrokerEvent) => {
    sendEvent(event);
  };

  brokerEventEmitter.on('broker:event', onEvent);

  res.write(': stream ready\n\n');

  const pingTimer = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    } catch (err) {
      logger.warn({ clientId, err }, 'stream.client.ping_failed');
    }
  }, STREAM_PING_INTERVAL_MS);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    brokerEventEmitter.off('broker:event', onEvent);
    streamClients.delete(res);
    logger.info({ clientId, connections: streamClients.size }, 'stream.client.disconnected');
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const request = req as RequestWithId;
  logger.error({ reqId: request.id, err }, 'request.error');
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

async function main(): Promise<void> {
  await loadInstances();
  await initSendQueue();
  await startAllInstances();
  await startSendWorker();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'server.listening');
  });
}

main().catch((err) => logger.fatal({ err }, 'server.startup.failed'));
