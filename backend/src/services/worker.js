import { config } from '../config.js';
import { Patient, Medicine, DoseInstance, Box } from '../db/models.js';
import { logger } from '../lib/logger.js';
import { generateDoses, defaultRange, refreshStatuses } from './doseService.js';
import { notifyPatientCaregivers, pushNotificationSignal } from './notificationService.js';
import { emitToPatientCaregivers } from '../lib/realtime.js';
import { deriveConnection } from './boxService.js';
import { bumpConfig } from './configService.js';

/**
 * Periodic housekeeping (every minute):
 *  1. materialise upcoming doses  2. advance statuses (missed)  3. late / missed / offline notifications
 *  4. roll every box's alarm list forward once its snapshot gets old (boxes only hold the next 48 h)
 */
export async function runSweep(now = new Date()) {
  const notified = new Set(); const touchedPatients = new Set();

  const medPatients = await Medicine.distinct('patient_id', { active: true, archived_at: null });
  const active = await Patient.find({ _id: { $in: medPatients }, status: 'active' }, { grace_minutes: 1 }).lean();
  for (const p of active) await generateDoses(p._id, { ...defaultRange(now), now });
  await refreshStatuses(now);

  // late: due, past the grace period, still no evidence
  const grace = new Map(active.map((p) => [p._id, p.grace_minutes]));
  const awaiting = await DoseInstance.find({ status: 'awaiting_confirmation', patient_id: { $in: [...grace.keys()] } }, { patient_id: 1, medicine_id: 1, scheduled_at: 1 }).lean();
  const names = new Map((await Medicine.find({ _id: { $in: [...new Set(awaiting.map((d) => d.medicine_id))] } }, { name: 1 }).lean()).map((m) => [m._id, m.name]));
  for (const d of awaiting) {
    if (d.scheduled_at.getTime() + (grace.get(d.patient_id) ?? 60) * 60000 > now.getTime()) continue;
    (await notifyPatientCaregivers(d.patient_id, { type: 'dose_late', severity: 'warning', title: `${names.get(d.medicine_id) || 'Medicine'} is overdue`,
      body: 'No medicine removal has been detected yet for the scheduled dose.', dedupeKey: `late:${d._id}` })).forEach((u) => notified.add(u));
    touchedPatients.add(d.patient_id);
  }

  const missed = await DoseInstance.find({ status: 'missed', scheduled_at: { $gt: new Date(now.getTime() - 3 * 86400000) } }, { patient_id: 1, medicine_id: 1 }).lean();
  const missedNames = new Map((await Medicine.find({ _id: { $in: [...new Set(missed.map((d) => d.medicine_id))] } }, { name: 1 }).lean()).map((m) => [m._id, m.name]));
  for (const d of missed) {
    (await notifyPatientCaregivers(d.patient_id, { type: 'dose_missed', severity: 'danger', title: `${missedNames.get(d.medicine_id) || 'Medicine'} dose was missed`,
      body: 'The dose was not completed within the missed-dose threshold.', dedupeKey: `missed:${d._id}` })).forEach((u) => notified.add(u));
    touchedPatients.add(d.patient_id);
  }

  // offline boxes (never "online" without contact, never "offline" if the box said it was switched off)
  const boxes = await Box.find({ status: 'paired', last_seen_at: { $ne: null } }).lean();
  for (const b of boxes) {
    if (deriveConnection(b, now).state === 'offline') {
      (await notifyPatientCaregivers(b.patient_id, { type: 'device_offline', severity: 'warning', title: 'Medicine box is offline',
        body: `Last contact ${new Date(b.last_seen_at).toISOString()}. Reminders still run on the box, but new events cannot be seen until it reconnects.`,
        dedupeKey: `offline:${b._id}:${new Date(b.last_seen_at).getTime()}` })).forEach((u) => notified.add(u));
      touchedPatients.add(b.patient_id);
    }
  }

  pushNotificationSignal([...notified]);
  for (const pid of touchedPatients) emitToPatientCaregivers(pid, 'dose:update', {});
}

/** Every 12 h each paired box gets a fresh snapshot so its 48 h alarm list never runs out. */
async function rollAlarms(now = new Date()) {
  const { DeviceConfigVersion } = await import('../db/models.js');
  const boxes = await Box.find({ status: 'paired' }, { _id: 1, config_version: 1 }).lean();
  for (const b of boxes) {
    const v = await DeviceConfigVersion.findOne({ box_id: b._id, version: b.config_version }, { created_at: 1 }).lean();
    if (!v || now - v.created_at > 12 * 3600000) await bumpConfig(b._id, 'alarm window refresh', null, now);
  }
}

let timer = null;
export function startWorker() {
  if (!config.runWorker || timer) return;
  const tick = async () => {
    try { await runSweep(); await rollAlarms(); } catch (e) { logger.error({ err: e.message }, 'worker sweep failed'); }
  };
  timer = setInterval(tick, 60000);
  timer.unref();
  tick();
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null; }
