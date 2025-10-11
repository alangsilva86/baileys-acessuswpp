import 'dotenv/config';
import crypto from 'node:crypto';
import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response,
} from 'express';
import pino from 'pino';

interface RequestWithRawBody extends ExpressRequest {
  rawBody?: Buffer;
}

const PORT = Number(process.env.WEBHOOK_PORT ?? process.env.PORT ?? 3001);
const EXPECTED_API_KEY = process.env.WEBHOOK_API_KEY;
const HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? EXPECTED_API_KEY ?? null;
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const SERVICE_NAME = process.env.WEBHOOK_SERVICE_NAME ?? 'poll-webhook-example';

const logger = pino({ level: LOG_LEVEL, base: { service: SERVICE_NAME } });

function timingSafeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function buildSignature(rawBody: Buffer, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  return hmac.digest('hex');
}

function validateSignature(req: RequestWithRawBody): boolean {
  if (!HMAC_SECRET) return true;
  const rawBody = req.rawBody;
  const received = req.header('x-signature');
  if (!rawBody || !received) return false;
  const expected = buildSignature(rawBody, HMAC_SECRET);
  return timingSafeEqual(received, expected);
}

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = Buffer.from(buf);
    },
  }),
);

app.use((req: ExpressRequest, _res: Response, next: NextFunction) => {
  (req as RequestWithRawBody).rawBody ??= Buffer.from('');
  next();
});

app.post('/webhooks/baileys', (req: RequestWithRawBody, res: Response) => {
  if (EXPECTED_API_KEY) {
    const provided = req.header('x-api-key');
    if (provided !== EXPECTED_API_KEY) {
      logger.warn({ ip: req.ip }, 'webhook.invalid_api_key');
      return res.status(401).json({ error: 'invalid_api_key' });
    }
  }

  if (!validateSignature(req)) {
    const rawBody = req.rawBody ?? Buffer.from('');
    const expected = HMAC_SECRET ? buildSignature(rawBody, HMAC_SECRET) : null;
    const received = req.header('x-signature');
    logger.warn({ ip: req.ip, expected, received }, 'webhook.signature.mismatch');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const { event, payload, timestamp } = req.body ?? {};

  if (event === 'POLL_CHOICE') {
    logger.info({ event, timestamp, payload }, 'webhook.poll_choice');
  } else {
    logger.info({ event, timestamp }, 'webhook.event.received');
  }

  return res.sendStatus(204);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'webhook.server.listening');
});
