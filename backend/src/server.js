import http from 'node:http';
import os from 'node:os';
import { createApp } from './app.js';
import { config, allowedOrigins } from './config.js';
import { connectDB } from './db/mongo.js';
import { initRealtime } from './lib/realtime.js';
import { attachDeviceSocket } from './lib/deviceSocket.js';
import { initFirebaseAdmin } from './lib/firebaseAdmin.js';
import { startWorker } from './services/worker.js';
import { logger } from './lib/logger.js';

process.on('unhandledRejection', (e) => logger.error({ err: e?.message || String(e), stack: e?.stack }, 'unhandled promise rejection'));
process.on('uncaughtException', (e) => { logger.fatal({ err: e.message, stack: e.stack }, 'uncaught exception — exiting'); process.exit(1); });

/** Turn the most common startup failures into instructions a person can act on. */
function explainDbError(e) {
  const m = e?.message || String(e);
  if (/ECONNREFUSED/.test(m)) return 'MongoDB is not running at that address. Start the "MongoDB Server" Windows service (or your Atlas cluster), or fix MONGODB_URI in backend/.env.';
  if (/bad auth|Authentication failed/i.test(m)) return 'MongoDB rejected the username/password in MONGODB_URI. Special characters in the password must be URL-encoded.';
  if (/ENOTFOUND|querySrv/i.test(m)) return 'The MongoDB host name in MONGODB_URI could not be found. Check the Atlas connection string and your internet connection.';
  if (/timed out|Server selection/i.test(m)) return 'MongoDB did not answer. For Atlas, add this computer\'s IP under Network Access.';
  return m;
}

try {
  await connectDB(config.mongoUri, { log: (m) => logger.info(m) });
} catch (e) {
  logger.fatal(`Cannot start: database connection failed. ${explainDbError(e)}`);
  process.exit(1);
}

const fb = initFirebaseAdmin();
if (!fb.ok) logger.warn('The API will start, but sign-in returns 503 until Firebase is configured (see README "Firebase setup").');

const server = http.createServer(createApp());
const io = initRealtime(server, allowedOrigins());
attachDeviceSocket(io);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') logger.fatal(`Port ${config.port} is already in use. Stop the other program or set PORT in backend/.env.`);
  else logger.fatal({ err: e.message }, 'server error');
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  logger.info(`MediGuardian API on http://localhost:${config.port} (${config.env}); dev tools ${config.enableDevTools ? 'ON' : 'off'}`);
  logger.info(`Allowed browser origins: ${allowedOrigins().join(', ')}`);
  if (lan.length) logger.info(`ESP32 should use SERVER_HOST = ${lan.join(' or ')}  and  SERVER_PORT = ${config.port}`);
  startWorker();
});

const shutdown = (sig) => { logger.info(`${sig} received, closing`); io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
