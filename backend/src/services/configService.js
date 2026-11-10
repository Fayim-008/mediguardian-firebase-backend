import { DateTime } from 'luxon';
import { config } from '../config.js';
import { Box, Patient, Drawer, Medicine, DoseInstance, DeviceConfigVersion } from '../db/models.js';
import { emitToBox } from '../lib/realtime.js';

/**
 * What a box is told to do. The firmware runs reminders LOCALLY from this snapshot:
 *  - `alarms` are explicit UTC epoch seconds for the next 48 h (so the ESP32 needs no time-zone logic)
 *  - `valid_until` tells the box when to refetch; if it can't, it keeps using what it has
 */
export async function buildSnapshot(boxId, now = new Date()) {
  const box = await Box.findById(boxId).lean();
  if (!box || box.status !== 'paired') return { version: box?.config_version ?? null, unpaired: true, drawers: [], alarms: [] };
  const patient = await Patient.findById(box.patient_id).lean();
  const drawers = await Drawer.find({ box_id: boxId }).sort({ slot: 1 }).lean();
  const meds = await Medicine.find({ drawer_id: { $in: drawers.map((d) => d._id) }, active: true, archived_at: null, schedule: { $ne: null } })
    .sort({ name: 1 }).lean();
  const nameOf = new Map(meds.map((m) => [m._id, m.name]));

  const horizon = new Date(now.getTime() + 48 * 3600000);
  const doses = await DoseInstance.find({
    box_id: boxId, completed_at: null, status: { $ne: 'missed' },
    scheduled_at: { $gt: new Date(now.getTime() - 24 * 3600000), $lte: horizon },
  }, { drawer_slot: 1, scheduled_at: 1, medicine_id: 1 }).sort({ scheduled_at: 1 }).lean();
  const groups = new Map();
  for (const d of doses) {
    const key = `${d.drawer_slot}|${d.scheduled_at.getTime()}`;
    if (!groups.has(key)) groups.set(key, { slot: d.drawer_slot, at: Math.floor(d.scheduled_at.getTime() / 1000), medicines: [] });
    const n = nameOf.get(d.medicine_id);
    if (n) groups.get(key).medicines.push(n);
  }
  const alarms = [...groups.values()].filter((a) => a.medicines.length).map((a) => ({ ...a, medicines: a.medicines.sort() }));

  return {
    version: box.config_version,
    generated_at: now.toISOString(),
    valid_until: new Date(now.getTime() + 24 * 3600000).toISOString(),
    timezone: patient.timezone,
    utc_offset_minutes: DateTime.fromJSDate(now, { zone: patient.timezone }).offset,
    patient_name: patient.full_name,
    policy: {
      alerts_per_dose: 3, alert_interval_minutes: 30, alert_duration_seconds: 20,
      grace_minutes: patient.grace_minutes, missed_after_hours: patient.missed_after_hours,
      heartbeat_interval_seconds: config.heartbeatIntervalSec,
    },
    drawers: drawers.map((d) => ({
      slot: d.slot, kind: d.kind, name: d.name,
      medicines: meds.filter((m) => m.drawer_id === d._id).map((m) => ({
        id: m._id, name: m.name, strength: m.strength, dose: m.dose_label, dose_quantity: m.dose_quantity, unit: m.unit,
        instructions: m.instructions,
        schedule: m.schedule.schedule_type === 'times'
          ? { type: 'times', times_local: m.schedule.times_local }
          : { type: 'interval', every_hours: m.schedule.interval_hours, anchor_local: m.schedule.anchor_local },
      })),
    })),
    alarms,
  };
}

/**
 * Create the next configuration version for a box, mark older unacknowledged ones superseded,
 * and PUSH "config:changed" to the box over Socket.IO so it refetches immediately.
 */
export async function bumpConfig(boxId, reason, userId = null, now = new Date()) {
  const box = await Box.findByIdAndUpdate(boxId, { $inc: { config_version: 1 } }, { new: true }).lean();
  if (!box) return null;
  await DeviceConfigVersion.updateMany({ box_id: boxId, ack_status: 'pending', version: { $lt: box.config_version } }, { $set: { ack_status: 'superseded' } });
  const snapshot = await buildSnapshot(boxId, now);
  await DeviceConfigVersion.create({ box_id: boxId, version: box.config_version, snapshot, reason, created_by: userId });
  emitToBox(boxId, 'config:changed', { version: box.config_version, reason });
  return box.config_version;
}

export async function bumpPatientBoxes(patientId, reason, userId, now = new Date()) {
  const boxes = await Box.find({ patient_id: patientId, status: 'paired' }, { _id: 1 }).lean();
  for (const b of boxes) await bumpConfig(b._id, reason, userId, now);
}
