import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { Patient, Medicine, Drawer, Box, DoseInstance, isDuplicateKey } from '../db/models.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { assertPatientAccess } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';

/**
 * Pure classification of a dose that has (or has not) evidence.
 *   on_time  : evidence at/after scheduled time and within `graceMinutes`
 *   late     : evidence after the grace period but before the missed threshold
 *   missed   : no valid evidence before scheduled + missedAfterHours (evidence after that does NOT rescue the dose)
 *   upcoming : scheduled time not reached
 *   awaiting_confirmation : due, no evidence yet, not yet missed
 */
export function classifyDose({ scheduledAt, evidenceAt = null, graceMinutes = 60, missedAfterHours = 24, now = new Date() }) {
  const s = new Date(scheduledAt).getTime();
  const grace = s + graceMinutes * 60000;
  const missed = s + missedAfterHours * 3600000;
  if (evidenceAt) {
    const e = new Date(evidenceAt).getTime();
    if (e >= s && e <= grace) return 'on_time';
    if (e > grace && e < missed) return 'late';
  }
  const n = new Date(now).getTime();
  if (n < s) return 'upcoming';
  if (n >= missed) return 'missed';
  return 'awaiting_confirmation';
}

export const isEvidenceValid = (scheduledAt, evidenceAt, missedAfterHours) => {
  const s = new Date(scheduledAt).getTime(); const e = new Date(evidenceAt).getTime();
  return e >= s && e < s + missedAfterHours * 3600000;
};

/** HH:MM wall clock on a patient-local date -> UTC Date. DST gaps shift forward; repeated times use the first. */
function localInstant(dateISO, hhmm, zone) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = dateISO.split('-').map(Number);
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: m }, { zone }).toUTC().toJSDate();
}

/** All scheduled instants of one medicine inside [from, to]. Pure; used by generation and unit tests. */
export function computeInstants({ schedule, medicine, timezone, from, to }) {
  const out = [];
  const zone = timezone;
  const effFrom = new Date(schedule.effective_from || 0).getTime();
  const startLocal = medicine.start_date || null;
  const endLocal = medicine.end_date || null;
  const inRange = (d) => d.getTime() >= from.getTime() && d.getTime() <= to.getTime() && d.getTime() >= effFrom;
  const localDate = (d) => DateTime.fromJSDate(d, { zone }).toISODate();
  const withinDates = (d) => { const ld = localDate(d); return (!startLocal || ld >= startLocal) && (!endLocal || ld <= endLocal); };

  if (schedule.schedule_type === 'times') {
    let day = DateTime.fromJSDate(from, { zone }).minus({ days: 1 }).startOf('day');
    const last = DateTime.fromJSDate(to, { zone }).plus({ days: 1 }).startOf('day');
    while (day <= last) {
      for (const t of schedule.times_local || []) {
        const inst = localInstant(day.toISODate(), t, zone);
        if (inRange(inst) && withinDates(inst)) out.push(inst);
      }
      day = day.plus({ days: 1 });
    }
  } else {
    // Interval chain: anchor (local date + HH:MM), then every N absolute hours (crosses midnight and DST evenly).
    const anchorDate = schedule.anchor_date || startLocal || DateTime.fromJSDate(new Date(schedule.effective_from || Date.now()), { zone }).toISODate();
    const anchor = localInstant(anchorDate, schedule.anchor_local, zone);
    const step = schedule.interval_hours * 3600000;
    let k = Math.max(0, Math.floor((from.getTime() - anchor.getTime()) / step) - 1);
    for (;; k++) {
      const inst = new Date(anchor.getTime() + k * step);
      if (inst > to) break;
      if (inRange(inst) && withinDates(inst)) out.push(inst);
    }
  }
  const seen = new Set();
  return out.filter((d) => (seen.has(+d) ? false : seen.add(+d))).sort((a, b) => a - b);
}

/** Idempotently materialise dose documents. The unique index (medicine_id, scheduled_at) makes repeats harmless. */
export async function generateDoses(patientId, { from, to, now = new Date() }) {
  const patient = await Patient.findById(patientId, { timezone: 1 }).lean();
  if (!patient) return 0;
  const meds = await Medicine.find({ patient_id: patientId, active: true, archived_at: null, schedule: { $ne: null } }).lean();
  if (!meds.length) return 0;
  const drawers = await Drawer.find({ _id: { $in: meds.map((m) => m.drawer_id).filter(Boolean) } }).lean();
  const boxes = await Box.find({ _id: { $in: drawers.map((d) => d.box_id) } }, { is_simulated: 1 }).lean();
  const ops = [];
  for (const m of meds) {
    const d = drawers.find((x) => x._id === m.drawer_id);
    const simulated = !!boxes.find((b) => b._id === d?.box_id)?.is_simulated;
    for (const at of computeInstants({ schedule: m.schedule, medicine: m, timezone: patient.timezone, from, to })) {
      ops.push({
        updateOne: {
          filter: { medicine_id: m._id, scheduled_at: at },
          update: { $setOnInsert: {
            _id: crypto.randomUUID(), patient_id: patientId, box_id: d?.box_id || null, drawer_id: d?._id || null, drawer_slot: d?.slot || null,
            status: at > now ? 'upcoming' : 'awaiting_confirmation', completed_at: null, hardware_event_id: null, hardware_detected_at: null,
            confirmation: null, is_simulated: simulated, created_at: new Date(), updated_at: new Date(),
          } },
          upsert: true,
        },
      });
    }
  }
  if (!ops.length) return 0;
  try {
    // Native driver bulk upsert (no Mongoose casting): every field is set explicitly above.
    const r = await DoseInstance.collection.bulkWrite(ops, { ordered: false });
    return r.upsertedCount || 0;
  } catch (e) {
    if (isDuplicateKey(e)) return 0; // another request created the same doses at the same moment
    throw e;
  }
}

/** Default horizon: from 2 days back (late-arriving data) to 2 days ahead. */
export const defaultRange = (now) => ({ from: new Date(now.getTime() - 48 * 3600000), to: new Date(now.getTime() + 48 * 3600000) });

/** Move stored statuses forward with time. Never touches doses that have evidence. */
export async function refreshStatuses(now = new Date(), patientId = null) {
  const pf = patientId ? { patient_id: patientId } : {};
  await DoseInstance.updateMany({ ...pf, status: 'upcoming', scheduled_at: { $lte: now } }, { $set: { status: 'awaiting_confirmation', updated_at: new Date() } });
  const patients = await Patient.find(patientId ? { _id: patientId } : {}, { missed_after_hours: 1 }).lean();
  const byHours = new Map();
  for (const p of patients) byHours.set(p.missed_after_hours, [...(byHours.get(p.missed_after_hours) || []), p._id]);
  for (const [hours, ids] of byHours) {
    await DoseInstance.updateMany(
      { patient_id: { $in: ids }, completed_at: null, status: { $in: ['upcoming', 'awaiting_confirmation'] }, scheduled_at: { $lte: new Date(now.getTime() - hours * 3600000) } },
      { $set: { status: 'missed', updated_at: new Date() } });
  }
}

/** Attach medicine / drawer / patient info to dose documents and shape them for the API. */
export async function shapeDoses(rows, now = new Date()) {
  const [meds, drawers, patients] = await Promise.all([
    Medicine.find({ _id: { $in: [...new Set(rows.map((r) => r.medicine_id))] } }, { name: 1, dose_label: 1 }).lean(),
    Drawer.find({ _id: { $in: [...new Set(rows.map((r) => r.drawer_id).filter(Boolean))] } }, { name: 1 }).lean(),
    Patient.find({ _id: { $in: [...new Set(rows.map((r) => r.patient_id))] } }, { grace_minutes: 1 }).lean(),
  ]);
  const M = new Map(meds.map((m) => [m._id, m])); const D = new Map(drawers.map((d) => [d._id, d])); const P = new Map(patients.map((p) => [p._id, p]));
  return rows.map((r) => {
    const grace = P.get(r.patient_id)?.grace_minutes ?? 60;
    const overdue = r.status === 'awaiting_confirmation' && new Date(r.scheduled_at).getTime() + grace * 60000 <= now.getTime();
    return {
      id: r._id, patientId: r.patient_id, medicineId: r.medicine_id, medicineName: M.get(r.medicine_id)?.name || '(removed)',
      doseLabel: M.get(r.medicine_id)?.dose_label || null,
      boxId: r.box_id, drawerSlot: r.drawer_slot, drawerName: D.get(r.drawer_id)?.name || null,
      scheduledAt: r.scheduled_at, status: r.status, overdue,
      completedAt: r.completed_at,
      hardwareDetected: !!r.hardware_detected_at, hardwareDetectedAt: r.hardware_detected_at,
      intakeConfirmed: !!r.confirmation, intakeConfirmedAt: r.confirmation?.confirmed_at || null, confirmationSource: r.confirmation?.source || null,
      simulated: r.is_simulated,
    };
  });
}

export async function listDoses(userId, patientId, { from, to, status, medicineId, now = new Date() } = {}) {
  await assertPatientAccess(userId, patientId);
  await generateDoses(patientId, { ...defaultRange(now), now });
  await refreshStatuses(now, patientId);
  const q = { patient_id: patientId };
  if (from || to) q.scheduled_at = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lt: new Date(to) } : {}) };
  if (status) q.status = status;
  if (medicineId) q.medicine_id = medicineId;
  const rows = await DoseInstance.find(q).sort({ scheduled_at: 1 }).limit(1000).lean();
  return shapeDoses(rows, now);
}

/** Today in the patient's own time zone. */
export async function todaySchedule(userId, patientId, now = new Date()) {
  const p = await assertPatientAccess(userId, patientId);
  const start = DateTime.fromJSDate(now, { zone: p.timezone }).startOf('day');
  return listDoses(userId, patientId, { from: start.toUTC().toJSDate(), to: start.plus({ days: 1 }).toUTC().toJSDate(), now });
}

/**
 * Human confirmation of intake (stored separately from hardware evidence).
 * It can make a dose on_time/late using the confirmation time, but cannot resurrect a dose past its missed threshold.
 * It does NOT change medicine stock (only validated hardware events do).
 */
export async function confirmDose(userId, doseId, { confirmedAt, note } = {}, now = new Date()) {
  const d = await DoseInstance.findById(doseId).lean();
  if (!d) throw notFound('Dose not found.');
  const patient = await assertPatientAccess(userId, d.patient_id);
  const at = confirmedAt ? new Date(confirmedAt) : now;
  if (at > new Date(now.getTime() + 60000)) throw badRequest('Confirmation time cannot be in the future.');
  if (at < new Date(d.scheduled_at)) throw badRequest('Intake cannot be confirmed before the scheduled time.');
  const claimed = await DoseInstance.findOneAndUpdate(
    { _id: doseId, confirmation: null },
    { $set: { confirmation: { source: 'caregiver', confirmed_by: userId, confirmed_at: at, note: note || null, created_at: new Date() } } },
    { new: true }).lean();
  if (!claimed) throw conflict('This dose has already been confirmed.');
  const earliest = claimed.completed_at && new Date(claimed.completed_at) < at ? new Date(claimed.completed_at) : at;
  const valid = isEvidenceValid(claimed.scheduled_at, earliest, patient.missed_after_hours);
  const status = classifyDose({ scheduledAt: claimed.scheduled_at, evidenceAt: valid ? earliest : null,
    graceMinutes: patient.grace_minutes, missedAfterHours: patient.missed_after_hours, now });
  await DoseInstance.updateOne({ _id: doseId }, { $set: { status, completed_at: status === 'on_time' || status === 'late' ? earliest : null, updated_at: new Date() } });
  await audit({ actorId: userId, action: 'dose.confirm', entityType: 'dose', entityId: doseId, metadata: { status } });
  return { status, countedAsCompleted: status === 'on_time' || status === 'late', patientId: d.patient_id };
}
