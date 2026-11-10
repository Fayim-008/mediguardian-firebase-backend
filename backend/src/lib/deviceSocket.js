/**
 * Socket.IO namespace "/device" — the real-time channel the ESP32 firmware uses.
 *
 * Connect:  ws(s)://<server>/socket.io/?EIO=4  then join namespace "/device" with auth {"token":"mgd_..."}
 *           (also accepted: header "Authorization: Bearer mgd_..." or query "?token=mgd_...")
 *
 * Box -> server (emit)            Server -> box (reply event)          payload = same JSON as the HTTP device API
 *   "heartbeat"   {...}            "heartbeat:ack" {...}
 *   "events"      {events:[...]}   "events:result" {results:{...}}
 *   "config:get"  {since:7}        "config"        {changed, version, config}
 *   "config:ack"  {version,status} "config:ack:result" {ok}
 *   "status"      {}               "status"        {...}
 * Server -> box (push):
 *   "welcome"        {server_time, paired, config_version, heartbeat_interval_seconds}   right after connecting
 *   "config:changed" {version, reason}     caregiver changed something: box should send "config:get"
 *   "command"        {command:"ring"|"sync_config"|"message"|"stop_alarm", drawer?, text?}
 *   "error:device"   {event, message}      a message was rejected (validation / server error)
 * If the client asks for a Socket.IO acknowledgement (callback), the reply is delivered as the ack instead.
 */
import { findBoxByDeviceToken } from '../middleware/auth.js';
import * as dev from '../services/deviceService.js';
import { check, eventsBody, heartbeatBody, configQuery, ackBody } from './deviceSchemas.js';
import { emitToPatientCaregivers, markBoxSocket } from './realtime.js';
import { deriveConnection } from '../services/boxService.js';
import { Box } from '../db/models.js';
import { logger } from './logger.js';

function tokenFrom(handshake) {
  const auth = handshake.auth?.token;
  if (auth) return String(auth);
  const h = handshake.headers?.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return handshake.query?.token ? String(handshake.query.token) : null;
}

async function announce(boxId) {
  const b = await Box.findById(boxId).lean();
  if (b?.patient_id) emitToPatientCaregivers(b.patient_id, 'device:status', { boxId, connection: deriveConnection(b).state });
}

export function attachDeviceSocket(io) {
  const nsp = io.of('/device');

  nsp.use(async (socket, next) => {
    try {
      const box = await findBoxByDeviceToken(tokenFrom(socket.handshake));
      if (!box) return next(new Error('unauthorized'));
      socket.data.boxId = box._id;
      next();
    } catch (e) {
      logger.warn({ err: e.message }, 'device socket auth failed');
      next(new Error('unauthorized'));
    }
  });

  nsp.on('connection', async (socket) => {
    const boxId = socket.data.boxId;
    socket.join(`box:${boxId}`);
    markBoxSocket(boxId, +1);
    logger.info({ boxId, ip: socket.handshake.address }, 'box connected (socket)');

    // Per-socket queue: messages are processed one at a time, in arrival order.
    let chain = Promise.resolve();
    // Simple rate limit: 240 messages per minute per socket.
    let windowStart = Date.now(); let count = 0;

    const loadBox = async () => { const b = await Box.findById(boxId).lean(); if (b) b.id = b._id; return b; };

    const on = (event, replyEvent, schema, run) => {
      socket.on(event, (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const body = args[0];
        if (Date.now() - windowStart > 60000) { windowStart = Date.now(); count = 0; }
        if (++count > 240) { socket.emit('error:device', { event, message: 'rate limited' }); return; }
        chain = chain.then(async () => {
          try {
            const parsed = schema ? check(schema, body) : { ok: true, data: body || {} };
            if (!parsed.ok) throw Object.assign(new Error(`Invalid input: ${parsed.error}`), { expose: true });
            const box = await loadBox();
            if (!box || box.status === 'retired') { socket.disconnect(true); return; }
            const result = await run(box, parsed.data);
            if (ack) ack(result); else socket.emit(replyEvent, result);
          } catch (e) {
            const message = e.expose || e.status ? e.message : 'server error';
            if (!e.expose && !e.status) logger.error({ err: e.message, event, boxId }, 'device socket handler failed');
            if (ack) ack({ error: { message } }); else socket.emit('error:device', { event, message });
          }
        });
      });
    };

    on('heartbeat', 'heartbeat:ack', heartbeatBody, (box, body) => dev.recordHeartbeat(box, body));
    on('events', 'events:result', eventsBody, async (box, body) => ({ results: await dev.ingestEvents(box, body.events, new Date(), 'socket') }));
    on('config:get', 'config', configQuery, (box, q) => dev.getDeviceConfig(box, q.since));
    on('config:ack', 'config:ack:result', ackBody, (box, body) => dev.ackConfig(box, body));
    on('status', 'status', null, (box) => dev.deviceStatus(box));

    socket.on('disconnect', (reason) => {
      markBoxSocket(boxId, -1);
      logger.info({ boxId, reason }, 'box disconnected (socket)');
      announce(boxId).catch(() => {});
    });

    try {
      await Box.updateOne({ _id: boxId }, { $set: { last_seen_at: new Date() } });
      const status = await dev.deviceStatus({ id: boxId });
      socket.emit('welcome', status);
      await announce(boxId);
    } catch (e) {
      logger.warn({ err: e.message }, 'device welcome failed');
    }
  });

  return nsp;
}
