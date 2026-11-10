/**
 * HTTP device API (fallback transport). The ESP32 firmware uses the Socket.IO /device namespace instead;
 * this stays for the simulator, curl/PowerShell tests and firmware that can't keep a socket open.
 */
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { sha256 } from '../lib/crypto.js';
import { validate } from '../lib/validate.js';
import { requireDevice } from '../middleware/auth.js';
import * as dev from '../services/deviceService.js';
import { eventsBody, heartbeatBody, configQuery, ackBody } from '../lib/deviceSchemas.js';
import { config } from '../config.js';

export const deviceRouter = Router();
deviceRouter.use(rateLimit({
  windowMs: 60000, limit: config.isTest ? 100000 : 240, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => (req.headers.authorization ? sha256(req.headers.authorization) : ipKeyGenerator(req.ip)),
  message: { error: { code: 'rate_limited', message: 'Too many device requests.' } },
}));
deviceRouter.use(requireDevice);
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

deviceRouter.post('/heartbeat', validate(heartbeatBody), h(async (req, res) => res.json(await dev.recordHeartbeat(req.box, req.body))));
deviceRouter.post('/events', validate(eventsBody), h(async (req, res) => res.json({ results: await dev.ingestEvents(req.box, req.body.events, new Date(), 'http') })));
deviceRouter.get('/config', validate(configQuery, 'query'), h(async (req, res) => res.json(await dev.getDeviceConfig(req.box, req.query.since))));
deviceRouter.post('/config/ack', validate(ackBody), h(async (req, res) => res.json(await dev.ackConfig(req.box, req.body))));
deviceRouter.get('/status', h(async (req, res) => res.json(await dev.deviceStatus(req.box))));
