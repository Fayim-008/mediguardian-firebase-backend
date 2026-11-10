/**
 * Device pipeline, shared by BOTH transports:
 *   - HTTP   /api/v1/device/*      (routes/device.js)    — fallback, simulator, curl tests
 *   - Socket /device namespace     (lib/deviceSocket.js) — the ESP32 firmware (real time, server push)
 */
import {
  Box, Patient, Medicine, DoseInstance, DeviceEvent, RefillSession, DeviceConfigVersion, StockLedger, isDuplicateKey,
} from '../db/models.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { classifyDose, generateDoses, refreshStatuses } from './doseService.js';
import { applyStock } from './stockService.js';
import { buildSnapshot } from './configService.js';
import { notifyPatientCaregivers, pushNotificationSignal } from './notificationService.js';
import { emitToPatientCaregivers } from '../lib/realtime.js';
import { deriveConnection } from './boxService.js';
import { config } from '../config.js';

/** Sensor rule from the hardware spec: qualifying = drawer open AND (IR A OR IR B). */
export const isQualifying = (s) => !!(s && s.reed_open === true && (s.ir_a === true || s.ir_b === true));

const freshBox = async (boxId) => { const b = await Box.findById(boxId).lean(); if (b) b.id = b._id; return b; };

/** Liveness + the device-REPORTED state. Older reports never overwrite newer ones. */
export async function recordHeartbeat(box, body = {}, now = new Date()) {
  const reportedAt = body.sent_at ? new Date(body.sent_at) : now;
  const set = { last_seen_at: now };
  if (body.firmware_version != null) set.firmware_version = body.firmware_version;
  if (body.config_version != null) set.config_version_reported = body.config_version;
  if (body.wifi_rssi != null) set.wifi_rssi = body.wifi_rssi;
  await Box.updateOne({ _id: box.id }, { $set: set });
  if (body.power_state != null) {
    await Box.updateOne({ _id: box.id, $or: [{ power_reported_at: null }, { power_reported_at: { $lte: reportedAt } }] },
      { $set: { power_state: body.power_state, power_reported_at: reportedAt } });
  }
  if (body.refill_mode != null) {
    await Box.updateOne({ _id: box.id, $or: [{ refill_reported_at: null }, { refill_reported_at: { $lte: reportedAt } }] },
      { $set: { refill_mode: body.refill_mode, refill_reported_at: reportedAt } });
  }
  const b = await freshBox(box.id);
  if (b.patient_id) emitToPatientCaregivers(b.patient_id, 'device:status', { boxId: b._id, connection: deriveConnection(b, now).state });
  const latest = await DeviceConfigVersion.findOne({ box_id: box.id, ack_status: { $ne: 'superseded' } }, { version: 1 }).sort({ version: -1 }).lean();
  return {
    server_time: now.toISOString(),
    config_version: b.config_version,
    config_changed: (latest?.version ?? b.config_version) !== (body.config_version ?? -1),
    heartbeat_interval_seconds: config.heartbeatIntervalSec,
    paired: b.status === 'paired',
  };
}

const inRefillSession = (boxId, at) => RefillSession.exists({ box_id: boxId, started_at: { $lte: at }, $or: [{ ended_at: null }, { ended_at: { $gte: at } }] });

/** Process ONE event. Idempotent on (box_id, event_uid): the unique index rejects a resend. */
async function processEvent(box, ev, now, via) {
  const occurred = new Date(ev.occurred_at);
  let stored;
  try {
    stored = await DeviceEvent.create({
      box_id: box.id, event_uid: ev.event_id, event_type: ev.type, drawer_slot: ev.drawer ?? null, occurred_at: occurred, received_at: now,
      config_version: ev.config_version ?? null, sensors: ev.sensors ?? null, refill_mode: ev.refill_mode ?? null,
      firmware_version: ev.firmware_version ?? null, payload: ev.extra ?? null, is_simulated: box.is_simulated, via,
    });
  } catch (e) {
    if (isDuplicateKey(e)) return { status: 'duplicate' };
    throw e;
  }
  const eventId = stored._id;
  let outcome = 'recorded';
  const touched = { patientId: box.patient_id, notify: [] };

  switch (ev.type) {
    case 'boot':
    case 'power_off': {
      await Box.updateOne({ _id: box.id, $or: [{ power_reported_at: null }, { power_reported_at: { $lte: occurred } }] },
        { $set: { power_state: ev.type === 'boot' ? 'on' : 'off', power_reported_at: occurred, ...(ev.firmware_version ? { firmware_version: ev.firmware_version } : {}) } });
      break;
    }
    case 'refill_start': {
      try { await RefillSession.create({ box_id: box.id, started_at: occurred, start_event_uid: ev.event_id, is_simulated: box.is_simulated }); }
      catch (e) { if (!isDuplicateKey(e)) throw e; }
      await Box.updateOne({ _id: box.id, $or: [{ refill_reported_at: null }, { refill_reported_at: { $lte: occurred } }] },
        { $set: { refill_mode: true, refill_reported_at: occurred } });
      break;
    }
    case 'refill_end': {
      const open = await RefillSession.findOne({ box_id: box.id, ended_at: null, started_at: { $lte: occurred } }).sort({ started_at: -1 }).lean();
      if (open) await RefillSession.updateOne({ _id: open._id }, { $set: { ended_at: occurred, end_event_uid: ev.event_id } });
      await Box.updateOne({ _id: box.id, $or: [{ refill_reported_at: null }, { refill_reported_at: { $lte: occurred } }] },
        { $set: { refill_mode: false, refill_reported_at: occurred } });
      break;
    }
    case 'removal_detected':
      outcome = await handleRemoval(box, { ...ev, occurred, eventId }, now, touched);
      break;
    case 'interaction_rejected':
      outcome = 'rejected_sensors';
      break;
    default:
      break; // drawer_open / drawer_close / reminder_alert are stored as activity only
  }
  await DeviceEvent.updateOne({ _id: eventId }, { $set: { outcome } });
  await Box.updateOne({ _id: box.id, $or: [{ last_seen_at: null }, { last_seen_at: { $lt: now } }] }, { $set: { last_seen_at: now } });
  return { status: 'accepted', outcome, patientId: touched.patientId, notify: touched.notify };
}

async function handleRemoval(box, ev, now, touched) {
  if (box.status !== 'paired') return 'unmatched';
  if (!isQualifying(ev.sensors)) return 'rejected_sensors';
  if (ev.refill_mode === true || await inRefillSession(box.id, ev.occurred)) return 'ignored_refill'; // refill never consumes stock
  const patient = await Patient.findById(box.patient_id).lean();
  if (!patient) return 'unmatched';
  // Make sure the doses around the occurrence exist (a delayed event may precede the worker's generation).
  await generateDoses(patient._id, { from: new Date(ev.occurred.getTime() - patient.missed_after_hours * 3600000), to: ev.occurred, now });
  // Latest still-open scheduled time for this drawer whose window contains the occurrence time.
  const target = await DoseInstance.findOne({
    box_id: box.id, drawer_slot: ev.drawer, hardware_detected_at: null, completed_at: null,
    scheduled_at: { $lte: ev.occurred, $gt: new Date(ev.occurred.getTime() - patient.missed_after_hours * 3600000) },
  }, { scheduled_at: 1 }).sort({ scheduled_at: -1 }).lean();
  if (!target) return 'unmatched';

  // Every medicine of that drawer due at that moment is completed by one removal.
  const doses = await DoseInstance.find({ box_id: box.id, drawer_slot: ev.drawer, scheduled_at: target.scheduled_at, hardware_detected_at: null }).lean();
  for (const d of doses) {
    const status = classifyDose({ scheduledAt: d.scheduled_at, evidenceAt: ev.occurred, graceMinutes: patient.grace_minutes, missedAfterHours: patient.missed_after_hours, now });
    const earliest = d.completed_at && new Date(d.completed_at) < ev.occurred ? d.completed_at : ev.occurred;
    const claimed = await DoseInstance.updateOne({ _id: d._id, hardware_detected_at: null },
      { $set: { status, completed_at: earliest, hardware_event_id: ev.eventId, hardware_detected_at: ev.occurred, updated_at: new Date() } });
    if (!claimed.modifiedCount) continue; // another event got there first
    const m = await Medicine.findById(d.medicine_id, { dose_quantity: 1, low_stock_threshold: 1, name: 1 }).lean();
    if (!m) continue;
    const r = await applyStock(d.medicine_id, -m.dose_quantity, { reason: 'consumption', source: 'device', doseInstanceId: d._id, note: 'validated hardware removal' });
    if (r.applied && r.balance <= m.low_stock_threshold) {
      const cycle = await StockLedger.countDocuments({ medicine_id: d.medicine_id, reason: { $in: ['initial', 'refill'] } });
      touched.notify.push(...await notifyPatientCaregivers(patient._id, {
        type: 'low_stock', severity: 'warning', title: `${m.name} is running low`, body: `About ${r.balance} left (estimate).`,
        dedupeKey: `lowstock:${d.medicine_id}:${cycle}` }));
    }
  }
  return 'matched';
}

/** Batch intake. Events are applied in device-time order; each is independent and idempotent. */
export async function ingestEvents(box, events, now = new Date(), via = 'http') {
  const b0 = await freshBox(box.id);
  const sorted = [...events].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const results = {};
  const patientsTouched = new Set();
  const matchedSlots = [];
  for (const ev of sorted) {
    try {
      const r = await processEvent(b0, ev, now, via);
      results[ev.event_id] = { status: r.status, outcome: r.outcome };
      if (r.status === 'accepted') patientsTouched.add(r.patientId);
      if (r.outcome === 'matched') matchedSlots.push(ev.drawer);
      if (r.notify?.length) pushNotificationSignal(r.notify);
    } catch (e) {
      results[ev.event_id] = { status: 'rejected', error: e.message };
    }
  }
  if (b0.patient_id) await refreshStatuses(now, b0.patient_id);
  for (const pid of patientsTouched) if (pid) emitToPatientCaregivers(pid, 'device:event', { boxId: box.id, matchedSlots });
  return results;
}

export async function getDeviceConfig(box, sinceVersion) {
  const b = await freshBox(box.id);
  if (sinceVersion != null && Number(sinceVersion) === b.config_version) return { changed: false, version: b.config_version };
  const v = await DeviceConfigVersion.findOne({ box_id: box.id, ack_status: { $ne: 'superseded' } }, { ack_status: 1 }).sort({ version: -1 }).lean();
  // Always serve a fresh snapshot (alarms roll forward) tagged with the current version.
  const snapshot = await buildSnapshot(box.id, new Date());
  return { changed: true, version: b.config_version, config: snapshot, ack_status: v?.ack_status ?? 'pending' };
}

export async function ackConfig(box, { version, status, error }) {
  const v = await DeviceConfigVersion.findOne({ box_id: box.id, version }).lean();
  if (!v) {
    // The box may be on the current version without a stored row (e.g. a brand-new box at version 1).
    const b = await freshBox(box.id);
    if (b.config_version !== version) throw badRequest('Unknown configuration version.');
    await DeviceConfigVersion.create({ box_id: box.id, version, snapshot: await buildSnapshot(box.id), reason: 'initial', ack_status: status,
      ack_at: new Date(), ack_error: status === 'failed' ? (error || 'device reported failure').slice(0, 300) : null });
  } else {
    if (v.ack_status === 'superseded') return { ok: true, superseded: true };
    await DeviceConfigVersion.updateOne({ _id: v._id }, { $set: { ack_status: status, ack_at: new Date(), ack_error: status === 'failed' ? (error || 'device reported failure').slice(0, 300) : null } });
  }
  await Box.updateOne({ _id: box.id }, { $set: { config_version_reported: version, last_seen_at: new Date() } });
  if (status === 'failed' && box.patient_id) {
    pushNotificationSignal(await notifyPatientCaregivers(box.patient_id, {
      type: 'config_failed', severity: 'danger', title: 'Box could not apply its new settings',
      body: 'The medicine box reported an error applying configuration. It keeps using its previous settings.', dedupeKey: `cfg:${box.id}:${version}` }));
  }
  await audit({ actorType: 'device', actorId: box.id, action: `device.config_${status}`, entityType: 'box', entityId: box.id, metadata: { version } });
  if (box.patient_id) emitToPatientCaregivers(box.patient_id, 'device:config', { boxId: box.id, version, status });
  return { ok: true };
}

export async function deviceStatus(box) {
  const b = await freshBox(box.id);
  return { server_time: new Date().toISOString(), paired: b.status === 'paired', config_version: b.config_version, heartbeat_interval_seconds: config.heartbeatIntervalSec };
}
