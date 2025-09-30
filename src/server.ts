import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import { createRuntimeContext } from './context';
import { env } from './env';
import { createApiKeyMiddleware } from './middleware/apiKey';
import { createRateLimitMiddleware } from './middleware/rateLimit';
import createHealthRouter from './routes/health';
import createInstancesRouter from './routes/instances';
import createPollsRouter from './routes/polls';

async function bootstrap() {
  const ctx = await createRuntimeContext();
  const app = express();
  const logger = ctx.logger;

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = randomUUID();
    (req as any).id = reqId;
    const start = Date.now();
    logger.info({ reqId, method: req.method, url: req.originalUrl }, 'request.start');
    res.on('finish', () => {
      logger.info(
        {
          reqId,
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
        },
        'request.end',
      );
    });
    next();
  });

  app.use('/health', createHealthRouter(ctx));

  const protectedRouter = express.Router();
  protectedRouter.use(createApiKeyMiddleware(env.apiKeys));
  const rateLimiter = createRateLimitMiddleware(env.rateLimit);
  if (rateLimiter) {
    protectedRouter.use(rateLimiter);
  }
  protectedRouter.use('/instances', createInstancesRouter(ctx));
  protectedRouter.use('/polls', createPollsRouter(ctx));

  app.use(protectedRouter);

  app.use((
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    logger.error({ err, path: req.originalUrl }, 'request.error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  app.listen(env.port, () => {
    logger.info({ port: env.port }, 'server.listening');
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
