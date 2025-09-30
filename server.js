require('dotenv').config();

const path = require('path');
const express = require('express');
const crypto = require('crypto');
const pino = require('pino');
const { bootBaileys } = require('./src/whatsapp');
const createInstanceRoutes = require('./src/routes/instances');

// --------------------------- Config ---------------------------
const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SERVICE_NAME = process.env.SERVICE_NAME || 'baileys-api';

// --------------------------- Logger ---------------------------
const logger = pino({ level: LOG_LEVEL, base: { service: SERVICE_NAME } });

// --------------------------- App ------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Log simples por requisição
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  const start = Date.now();
  logger.info({ reqId: req.id, method: req.method, url: req.url }, 'request.start');
  res.on('finish', () => {
    logger.info({
      reqId: req.id, method: req.method, url: req.url,
      statusCode: res.statusCode, ms: Date.now() - start
    }, 'request.end');
  });
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --------------------------- Error Handler ---------------------
app.use((err, req, res, next) => {
  logger.error({ reqId: req.id, err }, 'request.error');
  res.status(500).json({ error: 'internal_server_error', message: err.message });
});

// --------------------------- Start ----------------------------
async function main() {
  const ctx = await bootBaileys();
  app.use('/instances', createInstanceRoutes(ctx));
  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'server.listening');
  });
}

main().catch(err => logger.fatal({ err }, 'server.startup.failed'));

