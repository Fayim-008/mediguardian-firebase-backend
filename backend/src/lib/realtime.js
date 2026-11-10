/**
 * Socket.IO server. Two namespaces on the same port:
 *   "/"        browsers (React app). Auth: the user's short-lived access token. Room per user.
 *   "/device"  ESP32 boxes. Auth: the box's device token (mgd_...). Room per box. Handlers live in lib/deviceSocket.js.
 * Browser payloads carry ids/summary only; the app re-fetches details through the authorised REST API.
 */
import { Server } from 'socket.io';
import { verifyAccessToken } from '../middleware/auth.js';
import { CaregiverPatient } from '../db/models.js';
import { logger } from './logger.js';

let io = null;
const liveBoxes = new Map(); // boxId -> number of open device sockets

export function initRealtime(httpServer, corsOrigins) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: corsOrigins, credentials: false },
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 256 * 1024,
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      socket.data.userId = verifyAccessToken(token).sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.emit('ready', { userId: socket.data.userId });
  });
  logger.info('Socket.IO ready: "/" for the web app, "/device" for ESP32 boxes');
  return io;
}

export const getIO = () => io;

export async function emitToPatientCaregivers(patientId, event, payload = {}) {
  if (!io || !patientId) return;
  try {
    const links = await CaregiverPatient.find({ patient_id: patientId }, { user_id: 1 }).lean();
    for (const l of links) io.to(`user:${l.user_id}`).emit(event, { patientId, ...payload });
  } catch (e) { logger.warn({ err: e.message }, 'emitToPatientCaregivers failed'); }
}

export function emitToUser(userId, event, payload = {}) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

/* ---------- device presence + server -> box push ---------- */
export function markBoxSocket(boxId, delta) {
  const n = Math.max(0, (liveBoxes.get(boxId) || 0) + delta);
  if (n) liveBoxes.set(boxId, n); else liveBoxes.delete(boxId);
  return n;
}
export const isBoxLive = (boxId) => (liveBoxes.get(boxId) || 0) > 0;

/** Push an event to a box over its live socket. Returns true when at least one socket of that box is connected. */
export function emitToBox(boxId, event, payload = {}) {
  if (!io || !boxId) return false;
  io.of('/device').to(`box:${boxId}`).emit(event, payload);
  return isBoxLive(boxId);
}
