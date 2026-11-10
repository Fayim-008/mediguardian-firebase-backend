import { DateTime } from 'luxon';
import { Patient, CaregiverPatient, Box, Medicine, DoseInstance, StockLedger, DeviceEvent } from '../db/models.js';
import { assertPatientAccess } from '../middleware/auth.js';
import { generateDoses, defaultRange, refreshStatuses } from './doseService.js';
import { deriveConnection } from './boxService.js';

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const myPatientIds = async (userId) => (await CaregiverPatient.find({ user_id: userId }, { patient_id: 1 }).lean()).map((l) => l.patient_id);

/**
 * Adherence = (on_time + late) / (on_time + late + missed).
 * Upcoming / awaiting doses are NOT in the denominator and NOT counted as taken.
 */
export async function buildReport(userId, { patientId = null, range = '7D', from, to, medicineId, boxId, status, now = new Date() } = {}) {
  let tz = 'UTC';
  let patientIds;
  if (patientId) { tz = (await assertPatientAccess(userId, patientId)).timezone; patientIds = [patientId]; }
  else {
    patientIds = await myPatientIds(userId);
    tz = (await Patient.findOne({ _id: { $in: patientIds } }, { timezone: 1 }).lean())?.timezone || 'UTC';
  }
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf('day');
  const days = range === '1D' ? 0 : range === '30D' ? 29 : 6;
  const start = from ? new Date(from) : today.minus({ days }).toUTC().toJSDate();
  const end = to ? new Date(to) : today.plus({ days: 1 }).toUTC().toJSDate();
  if (!patientIds.length) return emptyReport(range, start, end);

  for (const pid of patientIds) await generateDoses(pid, { ...defaultRange(now), now });
  await refreshStatuses(now);

  const q = { patient_id: { $in: patientIds }, scheduled_at: { $gte: start, $lt: end } };
  if (medicineId) q.medicine_id = medicineId;
  if (boxId) q.box_id = boxId;
  if (status) q.status = status;
  const doses = await DoseInstance.find(q).sort({ scheduled_at: 1 }).lean();
  const [meds, pats] = await Promise.all([
    Medicine.find({ patient_id: { $in: patientIds } }, { name: 1, patient_id: 1 }).lean(),
    Patient.find({ _id: { $in: patientIds } }, { timezone: 1 }).lean(),
  ]);
  const medName = new Map(meds.map((m) => [m._id, m.name]));
  const tzOf = new Map(pats.map((p) => [p._id, p.timezone]));
  const localDate = (d) => DateTime.fromJSDate(d.scheduled_at, { zone: tzOf.get(d.patient_id) || 'UTC' }).toISODate();

  const count = (s) => doses.filter((d) => d.status === s).length;
  const onTime = count('on_time'), late = count('late'), missed = count('missed');
  const upcoming = count('upcoming'), awaiting = count('awaiting_confirmation');
  const resolved = onTime + late + missed;
  const completedRows = doses.filter((d) => d.status === 'on_time' || d.status === 'late');

  const medMap = new Map();
  for (const d of doses) {
    if (!medMap.has(d.medicine_id)) medMap.set(d.medicine_id, { id: d.medicine_id, name: medName.get(d.medicine_id) || '(removed)', patientId: d.patient_id, taken: 0, late: 0, missed: 0 });
    const r = medMap.get(d.medicine_id);
    if (d.status === 'on_time') r.taken++; else if (d.status === 'late') r.late++; else if (d.status === 'missed') r.missed++;
  }
  const medicineWise = [...medMap.values()].map((r) => ({ ...r, total: r.taken + r.late + r.missed, adherence: pct(r.taken + r.late, r.taken + r.late + r.missed) })).filter((r) => r.total > 0);

  const dayMap = new Map();
  for (const d of doses) {
    const ld = localDate(d);
    if (!dayMap.has(ld)) dayMap.set(ld, { date: ld, taken: 0, late: 0, missed: 0, total: 0 });
    const r = dayMap.get(ld);
    if (d.status === 'on_time') { r.taken++; r.total++; } else if (d.status === 'late') { r.late++; r.total++; } else if (d.status === 'missed') { r.missed++; r.total++; }
  }
  const dailyTrend = [...dayMap.values()].sort((a, b) => (a.date > b.date ? 1 : -1)).map((r) => ({
    ...r, label: DateTime.fromISO(r.date).toFormat('dd LLL'), adherence: pct(r.taken + r.late, r.total) }));

  const medIds = meds.map((m) => m._id);
  const refills = await StockLedger.find({ medicine_id: { $in: medIds }, reason: { $in: ['refill', 'adjustment', 'initial'] }, created_at: { $gte: start, $lt: end } })
    .sort({ created_at: -1 }).limit(50).lean();
  // Consumption is attributed to the dose it belonged to.
  const doseIdsInRange = (await DoseInstance.find({ patient_id: { $in: patientIds }, scheduled_at: { $gte: start, $lt: end } }, { _id: 1 }).lean()).map((d) => d._id);
  const consumed = await StockLedger.find({ reason: 'consumption', dose_instance_id: { $in: doseIdsInRange } }, { medicine_id: 1, delta: 1 }).lean();
  const usedBy = new Map();
  for (const l of consumed) { const n = medName.get(l.medicine_id) || '(removed)'; usedBy.set(n, (usedBy.get(n) || 0) - l.delta); }

  const boxes = await Box.find({ patient_id: { $in: patientIds } }, { box_code: 1 }).lean();
  const codeOf = new Map(boxes.map((b) => [b._id, b.box_code]));
  const events = await DeviceEvent.find({ box_id: { $in: boxes.map((b) => b._id) }, occurred_at: { $gte: start, $lt: end }, event_type: { $ne: 'drawer_close' } })
    .sort({ occurred_at: -1 }).limit(50).lean();

  const recent = doses.filter((d) => ['on_time', 'late', 'missed'].includes(d.status)).slice(-12).reverse();

  return {
    range, start, end,
    totals: { scheduled: doses.length, taken: onTime, onTime, late, missed, upcoming, awaiting, completed: onTime + late, resolved,
      hardwareOnly: completedRows.filter((d) => d.hardware_detected_at && !d.confirmation).length,
      confirmedByHuman: doses.filter((d) => d.confirmation).length },
    percentages: { adherence: pct(onTime + late, resolved), onTime: pct(onTime, resolved), late: pct(late, resolved), missed: pct(missed, resolved) },
    definition: 'adherence = (on_time + late) / (on_time + late + missed); upcoming and awaiting-confirmation doses are excluded',
    medicineWise,
    bestMedicine: [...medicineWise].sort((a, b) => b.adherence - a.adherence)[0] || null,
    mostMissed: [...medicineWise].sort((a, b) => b.missed - a.missed).find((m) => m.missed > 0) || null,
    dailyTrend,
    recentActivity: recent.map((d) => ({ id: d._id, medicineId: d.medicine_id, patientId: d.patient_id, medicineName: medName.get(d.medicine_id) || '(removed)', scheduledAt: d.scheduled_at, status: d.status, simulated: d.is_simulated })),
    statusBreakdown: [
      { name: 'On time', value: onTime, color: 'var(--success)' }, { name: 'Late', value: late, color: 'var(--warning)' },
      { name: 'Missed', value: missed, color: 'var(--danger)' }, { name: 'Awaiting', value: awaiting, color: 'var(--info)' },
      { name: 'Upcoming', value: upcoming, color: 'var(--text-muted)' }],
    refillHistory: refills.map((r) => ({ id: r._id, medicineName: medName.get(r.medicine_id) || '(removed)', delta: r.delta, balanceAfter: r.balance_after, reason: r.reason, createdAt: r.created_at })),
    consumption: [...usedBy.entries()].map(([medicineName, used]) => ({ medicineName, used: Math.round(used * 100) / 100 })),
    deviceEvents: events.map((e) => ({ id: e._id, type: e.event_type, drawerSlot: e.drawer_slot, occurredAt: e.occurred_at, outcome: e.outcome, simulated: e.is_simulated, boxCode: codeOf.get(e.box_id) })),
  };
}

function emptyReport(range, start, end) {
  return { range, start, end, totals: { scheduled: 0, taken: 0, onTime: 0, late: 0, missed: 0, upcoming: 0, awaiting: 0, completed: 0, resolved: 0, hardwareOnly: 0, confirmedByHuman: 0 },
    percentages: { adherence: 0, onTime: 0, late: 0, missed: 0 }, medicineWise: [], bestMedicine: null, mostMissed: null, dailyTrend: [], recentActivity: [],
    statusBreakdown: [], refillHistory: [], consumption: [], deviceEvents: [] };
}

/** Combined caregiver dashboard summary. */
export async function dashboardSummary(userId, now = new Date()) {
  const allIds = await myPatientIds(userId);
  const patients = await Patient.find({ _id: { $in: allIds }, status: 'active' }, { timezone: 1, full_name: 1 }).lean();
  const ids = patients.map((p) => p._id);
  const boxes = await Box.find({ owner_user_id: userId }).lean();
  const conns = boxes.map((b) => deriveConnection(b, now).state);
  const today = { scheduled: 0, onTime: 0, late: 0, missed: 0, upcoming: 0, awaiting: 0 };
  for (const p of patients) {
    await generateDoses(p._id, { ...defaultRange(now), now });
  }
  if (ids.length) await refreshStatuses(now);
  for (const p of patients) {
    const s = DateTime.fromJSDate(now, { zone: p.timezone }).startOf('day');
    const rows = await DoseInstance.find({ patient_id: p._id, scheduled_at: { $gte: s.toUTC().toJSDate(), $lt: s.plus({ days: 1 }).toUTC().toJSDate() } }, { status: 1 }).lean();
    today.scheduled += rows.length;
    for (const r of rows) {
      if (r.status === 'on_time') today.onTime++; else if (r.status === 'late') today.late++; else if (r.status === 'missed') today.missed++;
      else if (r.status === 'upcoming') today.upcoming++; else if (r.status === 'awaiting_confirmation') today.awaiting++;
    }
  }
  const nameOf = new Map(patients.map((p) => [p._id, p.full_name]));
  const low = await Medicine.find({ patient_id: { $in: ids }, active: true, archived_at: null, $expr: { $lte: ['$stock_quantity', '$low_stock_threshold'] } })
    .sort({ stock_quantity: 1 }).lean();
  const myBoxIds = boxes.map((b) => b._id);
  const recent = await DeviceEvent.find({ box_id: { $in: myBoxIds }, event_type: { $in: ['removal_detected', 'interaction_rejected', 'refill_start', 'refill_end', 'boot', 'power_off'] } })
    .sort({ occurred_at: -1 }).limit(10).lean();
  const boxPatient = new Map(boxes.map((b) => [b._id, b.patient_id]));
  const allNames = new Map((await Patient.find({ _id: { $in: allIds } }, { full_name: 1 }).lean()).map((p) => [p._id, p.full_name]));
  return {
    patients: ids.length, boxes: boxes.length,
    boxesOnline: conns.filter((s) => s === 'online').length, boxesOffline: conns.filter((s) => s === 'offline').length,
    boxesAwaiting: conns.filter((s) => s === 'awaiting_first_connection').length, boxesPoweredOff: conns.filter((s) => s === 'powered_off').length,
    today,
    lowStock: low.map((m) => ({ medicineId: m._id, name: m.name, quantity: m.stock_quantity, unit: m.unit, patientId: m.patient_id, patientName: nameOf.get(m.patient_id) })),
    recentEvents: recent.map((e) => {
      const pid = boxPatient.get(e.box_id) || null;
      return { id: e._id, type: e.event_type, drawerSlot: e.drawer_slot, occurredAt: e.occurred_at, outcome: e.outcome, simulated: e.is_simulated, patientId: pid, patientName: allNames.get(pid) || null };
    }),
  };
}
