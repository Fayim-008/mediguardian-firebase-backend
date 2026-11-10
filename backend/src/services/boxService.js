import QRCode from 'qrcode';
import { config } from '../config.js';
import {
  Box, Drawer, DeviceCredential, BoxPairingToken, BoxOwnershipHistory, Patient, Medicine, DoseInstance, DeviceConfigVersion,
} from '../db/models.js';
import { randomCode, randomToken, sha256, normalizeCode } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { assertPatientAccess, assertBoxAccess } from '../middleware/auth.js';
import { emitToBox, isBoxLive } from '../lib/realtime.js';
import { createPatient } from './patientService.js';

const DRAWERS = [[1, 'morning', 'Morning'], [2, 'noon', 'Noon'], [3, 'night', 'Night'], [4, 'extra', 'Extra']];

export function qrPayloadUrl(boxCode, pairingCode) {
  return `${config.frontendUrl}/app/add-box?code=${encodeURIComponent(boxCode)}&token=${encodeURIComponent(pairingCode)}`;
}

async function issuePairingToken(boxId, actorId, ttlHours = config.pairingTokenTtlHours) {
  // Only the newest code works: expire any outstanding unused one.
  await BoxPairingToken.updateMany({ box_id: boxId, used_at: null, expires_at: { $gt: new Date() } }, { $set: { expires_at: new Date() } });
  const code = randomCode(12);
  await BoxPairingToken.create({ box_id: boxId, token_hash: sha256(normalizeCode(code)), expires_at: new Date(Date.now() + ttlHours * 3600000) });
  await BoxOwnershipHistory.create({ box_id: boxId, action: 'pairing_token_issued', actor_id: actorId });
  return code;
}

/** Manufacturing / admin step. Returns secrets ONCE; only hashes are stored. */
export async function registerBox({ simulated = false, label = null, actorId = null, ttlHours } = {}) {
  const boxCode = `MG-${randomCode(12)}`;
  const box = (await Box.create({ box_code: boxCode, label, is_simulated: simulated })).toObject();
  await Drawer.insertMany(DRAWERS.map(([slot, kind, name]) => ({ box_id: box._id, slot, kind, name })));
  const deviceToken = `mgd_${randomToken(32)}`;
  await DeviceCredential.create({ box_id: box._id, token_hash: sha256(deviceToken) });
  const pairingCode = await issuePairingToken(box._id, actorId, ttlHours);
  await BoxOwnershipHistory.create({ box_id: box._id, action: 'registered', actor_id: actorId, note: simulated ? 'simulated' : null });
  await audit({ actorType: actorId ? 'admin' : 'system', actorId, action: 'box.register', entityType: 'box', entityId: box._id, metadata: { simulated } });
  const url = qrPayloadUrl(boxCode, pairingCode);
  return {
    boxId: box._id, boxCode, pairingCode, deviceToken, simulated, qrUrl: url,
    qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 360 }),
    expiresInHours: ttlHours ?? config.pairingTokenTtlHours,
  };
}

export async function reissuePairing(boxCode, actorId) {
  const box = await Box.findOne({ box_code: boxCode }).lean();
  if (!box) throw notFound('Box not found.');
  if (box.status !== 'registered') throw conflict('This box is currently paired; its owner must unpair it first.');
  const code = await issuePairingToken(box._id, actorId);
  await audit({ actorType: 'admin', actorId, action: 'box.reissue_pairing', entityType: 'box', entityId: box._id });
  const url = qrPayloadUrl(box.box_code, code);
  return { boxCode: box.box_code, pairingCode: code, qrUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 360 }) };
}

const INVALID = () => badRequest('This box code or pairing code is invalid, expired, or already used.', { code: 'pairing_invalid' });

/**
 * Pairing: verify box + single-use code, resolve/create the patient, record ownership.
 * Every failure returns the same message so codes cannot be probed. The code is claimed atomically (single use).
 */
export async function pairBox(userId, { boxCode, pairingCode, patientId, newPatient, label }, ctx = {}) {
  const box = await Box.findOne({ box_code: String(boxCode || '').trim().toUpperCase() }).lean();
  if (!box || box.status !== 'registered') throw INVALID();
  const tokenFilter = { box_id: box._id, token_hash: sha256(normalizeCode(pairingCode)), used_at: null, expires_at: { $gt: new Date() } };
  if (!(await BoxPairingToken.exists(tokenFilter))) {
    await audit({ actorId: userId, action: 'box.pair_failed', entityType: 'box', entityId: box._id, ip: ctx.ip });
    throw INVALID();
  }
  if (patientId) await assertPatientAccess(userId, patientId);
  else if (!newPatient) throw badRequest('Choose an existing patient or provide details for a new one.');

  const tok = await BoxPairingToken.findOneAndUpdate(tokenFilter, { $set: { used_at: new Date(), used_by: userId } }).lean();
  if (!tok) throw INVALID(); // someone else used it a moment ago
  const releaseToken = () => BoxPairingToken.updateOne({ _id: tok._id }, { $set: { used_at: null, used_by: null } });
  let pid = patientId;
  if (!pid) {
    try { pid = (await createPatient(userId, newPatient)).id; } catch (e) { await releaseToken(); throw e; }
  }

  const paired = await Box.findOneAndUpdate(
    { _id: box._id, status: 'registered' },
    { $set: { status: 'paired', owner_user_id: userId, patient_id: pid, paired_at: new Date(), ...(label ? { label } : {}) } },
    { new: true }).lean();
  if (!paired) { await releaseToken(); throw INVALID(); }
  await BoxOwnershipHistory.create({ box_id: box._id, action: 'paired', user_id: userId, patient_id: pid, actor_id: userId });
  await audit({ actorId: userId, action: 'box.pair', entityType: 'box', entityId: box._id, metadata: { patientId: pid }, ip: ctx.ip });
  const { bumpConfig } = await import('./configService.js');
  await bumpConfig(box._id, 'box paired', userId);
  return { boxId: box._id, patientId: pid };
}

/** Unpair without permission checks (callers check). Returns the box as it was before, or null if it wasn't paired. */
export async function unpairBoxCore(boxId, actorId, note = 'unpaired by owner') {
  const before = await Box.findOneAndUpdate(
    { _id: boxId, status: 'paired' },
    { $set: { status: 'registered', owner_user_id: null, patient_id: null, paired_at: null, label: null }, $inc: { config_version: 1 } },
    { new: false }).lean();
  if (!before) return null;
  const version = before.config_version + 1;
  const drawerIds = (await Drawer.find({ box_id: boxId }, { _id: 1 }).lean()).map((d) => d._id);
  await Medicine.updateMany({ drawer_id: { $in: drawerIds } }, { $set: { drawer_id: null, updated_at: new Date() } });
  // Future, unevidenced doses were tied to this physical box; detach them (past doses keep their box reference).
  await DoseInstance.updateMany(
    { box_id: boxId, completed_at: null, status: { $in: ['upcoming', 'awaiting_confirmation'] } },
    { $set: { box_id: null, drawer_id: null, drawer_slot: null, updated_at: new Date() } });
  await DeviceConfigVersion.updateMany({ box_id: boxId, ack_status: 'pending' }, { $set: { ack_status: 'superseded' } });
  await DeviceConfigVersion.create({ box_id: boxId, version, snapshot: { version, unpaired: true, drawers: [], alarms: [] }, reason: 'box unpaired', created_by: actorId });
  await BoxOwnershipHistory.create({ box_id: boxId, action: 'unpaired', user_id: before.owner_user_id, patient_id: before.patient_id, actor_id: actorId, note });
  await audit({ actorId, action: 'box.unpair', entityType: 'box', entityId: boxId, metadata: { note } });
  emitToBox(boxId, 'config:changed', { version, reason: 'unpaired' });
  return before;
}

/** Owner unpairs; a fresh single-use code is returned so the box can be handed to another account. */
export async function unpairBox(userId, boxId) {
  const box = await assertBoxAccess(userId, boxId);
  await unpairBoxCore(boxId, userId);
  const code = await issuePairingToken(boxId, userId, 72);
  return { boxCode: box.box_code, transferPairingCode: code, expiresInHours: 72 };
}

/** Connection state derived ONLY from what the device has reported. */
export function deriveConnection(box, now = new Date()) {
  if (box.status !== 'paired') return { state: 'unpaired', label: 'Not paired' };
  if (!box.last_seen_at) return { state: 'awaiting_first_connection', label: 'Awaiting first connection' };
  const age = (now - new Date(box.last_seen_at)) / 1000;
  if (box.power_state === 'off') return { state: 'powered_off', label: 'Switched off', lastSeenAt: box.last_seen_at };
  if (age > config.offlineAfterSec && !isBoxLive(String(box._id || box.id))) {
    return { state: 'offline', label: 'Offline', lastSeenAt: box.last_seen_at, staleSeconds: Math.round(age) };
  }
  return { state: 'online', label: 'Online', lastSeenAt: box.last_seen_at };
}

export function configSyncStatus(latest) {
  if (!latest) return 'none';
  if (latest.ack_status === 'applied') return 'synced';
  if (latest.ack_status === 'failed') return 'failed';
  return 'pending';
}

export async function describeBoxes(filter, now = new Date()) {
  const boxes = await Box.find(filter).sort({ created_at: 1 }).lean();
  if (!boxes.length) return [];
  const ids = boxes.map((b) => b._id);
  const [drawers, patients] = await Promise.all([
    Drawer.find({ box_id: { $in: ids } }).sort({ slot: 1 }).lean(),
    Patient.find({ _id: { $in: boxes.map((b) => b.patient_id).filter(Boolean) } }, { full_name: 1 }).lean(),
  ]);
  const out = [];
  for (const b of boxes) {
    const [latest, lastApplied] = await Promise.all([
      DeviceConfigVersion.findOne({ box_id: b._id, ack_status: { $ne: 'superseded' } }, { snapshot: 0 }).sort({ version: -1 }).lean(),
      DeviceConfigVersion.findOne({ box_id: b._id, ack_status: 'applied' }, { snapshot: 0 }).sort({ version: -1 }).lean(),
    ]);
    const conn = deriveConnection(b, now);
    out.push({
      id: b._id, boxCode: b.box_code, label: b.label, status: b.status, simulated: b.is_simulated,
      patientId: b.patient_id, patientName: patients.find((p) => p._id === b.patient_id)?.full_name || null, pairedAt: b.paired_at,
      connection: conn, live: isBoxLive(b._id),
      refillMode: b.refill_mode === true && conn.state === 'online' ? true : (b.refill_mode === null ? null : false),
      powerState: b.power_state, firmwareVersion: b.firmware_version, lastSeenAt: b.last_seen_at, wifiRssi: b.wifi_rssi,
      config: {
        serverVersion: b.config_version, deviceReportedVersion: b.config_version_reported, sync: configSyncStatus(latest),
        lastSyncedAt: lastApplied?.ack_at || null, error: latest?.ack_error || null,
      },
      drawers: drawers.filter((d) => d.box_id === b._id).map((d) => ({ id: d._id, slot: d.slot, kind: d.kind, name: d.name })),
    });
  }
  return out;
}

export const listBoxesForUser = (userId) => describeBoxes({ owner_user_id: userId });
export const listBoxesForPatient = (patientId) => describeBoxes({ patient_id: patientId });

export async function renameDrawer(userId, boxId, slot, name) {
  await assertBoxAccess(userId, boxId);
  const r = await Drawer.updateOne({ box_id: boxId, slot }, { $set: { name } });
  if (!r.matchedCount) throw notFound('Drawer not found.');
  const { bumpConfig } = await import('./configService.js');
  await bumpConfig(boxId, 'drawer renamed', userId);
}

export async function boxHistory(userId, boxId) {
  await assertBoxAccess(userId, boxId);
  return BoxOwnershipHistory.find({ box_id: boxId }, { _id: 0, action: 1, patient_id: 1, note: 1, created_at: 1 })
    .sort({ created_at: -1 }).limit(100).lean();
}

export async function configHistory(userId, boxId) {
  await assertBoxAccess(userId, boxId);
  return DeviceConfigVersion.find({ box_id: boxId }, { _id: 0, version: 1, reason: 1, ack_status: 1, ack_at: 1, ack_error: 1, created_at: 1 })
    .sort({ version: -1 }).limit(50).lean();
}

/** Real-time command to a box over its Socket.IO connection (ring buzzer, force a config refresh, show a message). */
export async function sendBoxCommand(userId, boxId, { command, drawer, text }) {
  const box = await assertBoxAccess(userId, boxId);
  if (box.status !== 'paired') throw conflict('Pair the box first.');
  const payload = { command, ...(drawer ? { drawer } : {}), ...(text ? { text: String(text).slice(0, 32) } : {}), sent_at: new Date().toISOString() };
  const delivered = emitToBox(boxId, 'command', payload);
  await audit({ actorId: userId, action: `box.command.${command}`, entityType: 'box', entityId: boxId, metadata: { delivered } });
  return { delivered, message: delivered ? 'Sent to the box.' : 'The box is not connected right now (no live Socket.IO connection).' };
}
