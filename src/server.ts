import 'dotenv/config';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import pino from 'pino';
import { getAllInstances, loadInstances, startAllInstances } from './instanceManager.js';
import instanceRoutes from './routes/instances.js';

const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SERVICE_NAME = process.env.SERVICE_NAME || 'baileys-api';

const logger = pino({ level: LOG_LEVEL, base: { service: SERVICE_NAME } });

interface RequestWithId extends Request {
  id?: string;
}

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

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
          'https://cdn.tailwindcss.com',
          'https://cdn.jsdelivr.net',
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
    connected: Boolean(inst.sock?.user),
  }));
  res.json({ status: 'ok', uptime: process.uptime(), instances });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const request = req as RequestWithId;
  logger.error({ reqId: request.id, err }, 'request.error');
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

async function main(): Promise<void> {
  await loadInstances();
  await startAllInstances();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'server.listening');
  });
}

main().catch((err) => logger.fatal({ err }, 'server.startup.failed'));
