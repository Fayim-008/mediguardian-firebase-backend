import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config, allowedOrigins } from './config.js';
import { isDBUp } from './db/mongo.js';
import { firebaseStatus } from './lib/firebaseAdmin.js';
import { authRouter } from './routes/auth.js';
import { apiRouter, adminRouter } from './routes/api.js';
import { deviceRouter } from './routes/device.js';
import { devRouter } from './routes/dev.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';

/**
 * API-only server. The React app is hosted separately (Vite dev server, Netlify, Vercel, Nginx, ...),
 * so CORS allows exactly FRONTEND_URL (+ EXTRA_CORS_ORIGINS). Auth uses Bearer tokens, not cookies.
 */
export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: allowedOrigins(), credentials: false, maxAge: 600, exposedHeaders: ['X-Request-Id'] }));
  // Every request gets an id; it is returned in the X-Request-Id header and in error bodies so a user's
  // "something went wrong" can be matched to the exact server log line.
  app.use((req, res, next) => {
    req.id = String(req.headers['x-request-id'] || '').slice(0, 64) || crypto.randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  app.use((req, _res, next) => { if (!config.isTest) logger.info({ id: req.id, method: req.method, url: req.url.split('?')[0] }, 'req'); next(); });

  app.get('/', (_req, res) => res.json({ name: 'MediGuardian API', ok: true, docs: '/health' }));
  app.get('/health', (_req, res) => {
    const fb = firebaseStatus();
    const ok = isDBUp() && fb.ok;
    res.status(ok ? 200 : 503).json({ ok, db: isDBUp() ? 'up' : 'down', firebase: fb.ok ? (fb.hasCredentials ? 'ready' : 'ready (project id only)') : `not configured: ${fb.error}`, time: new Date().toISOString() });
  });
  // While MongoDB is reconnecting, answer clearly instead of hanging.
  app.use('/api', (_req, res, next) => (isDBUp() ? next()
    : res.status(503).json({ error: { code: 'db_unavailable', message: 'The server cannot reach its database right now. Please try again in a minute.' } })));

  const general = rateLimit({ windowMs: 60000, limit: config.isTest ? 100000 : 300, standardHeaders: true, legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many requests.' } } });
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/device', deviceRouter);
  app.use('/api/v1/admin', general, adminRouter);
  if (config.enableDevTools) app.use('/api/v1/dev', general, devRouter);
  app.get('/api/v1/meta', (_req, res) => res.json({ devTools: config.enableDevTools, heartbeatIntervalSeconds: config.heartbeatIntervalSec }));
  app.use('/api/v1', general, apiRouter);

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: `There is no API route ${req.method} ${req.path}.`, requestId: req.id } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const send = (status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
    if (err instanceof HttpError) {
      if (err.status >= 500) logger.error({ id: req.id, err: err.message }, 'service unavailable');
      return send(err.status, err.code, err.message, err.details);
    }
    if (err?.type === 'entity.parse.failed') return send(400, 'bad_json', 'The request body is not valid JSON.');
    if (err?.type === 'entity.too.large') return send(413, 'too_large', 'The request is too large.');
    if (err?.name === 'ValidationError') {
      const first = Object.values(err.errors || {})[0];
      return send(400, 'bad_request', first?.message ? `Invalid value for ${first.path}: ${first.message}` : 'Some values are invalid.');
    }
    if (err?.name === 'CastError') return send(400, 'bad_request', `Invalid value for ${err.path}.`);
    if (err?.code === 11000) return send(409, 'duplicate', 'This record already exists.');
    if (/MongoServerSelectionError|MongoNetworkError|MongoNotConnectedError|MongooseServerSelectionError/.test(err?.name || '')) {
      logger.error({ id: req.id, err: err.message }, 'database unreachable');
      return send(503, 'db_unavailable', 'The server cannot reach its database right now. Please try again in a minute.');
    }
    logger.error({ id: req.id, err: err?.message, stack: config.isProd ? undefined : err?.stack }, 'unhandled error');
    send(500, 'internal', `Something went wrong on our side. If it keeps happening, report code ${req.id}.`);
  });
  return app;
}
