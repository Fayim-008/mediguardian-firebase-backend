import { Medicine, Drawer, Box, CaregiverPatient, DoseInstance, StockLedger } from '../db/models.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertPatientAccess } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { applyStock } from './stockService.js';
import { generateDoses, defaultRange, refreshStatuses } from './doseService.js';
import { bumpConfig } from './configService.js';

export const toApiMedicine = (m, drawer = null) => {
  const s = m.schedule;
  return {
    id: m._id, patientId: m.patient_id, name: m.name, type: m.medicine_type, strength: m.strength || '',
    dose: m.dose_label || '', doseQuantity: m.dose_quantity, unit: m.unit,
    quantity: m.stock_quantity, initialQuantity: m.initial_quantity, maxQuantity: m.max_quantity,
    lowStockThreshold: m.low_stock_threshold, lowStock: m.stock_quantity <= m.low_stock_threshold,
    drawerId: m.drawer_id, drawerSlot: drawer?.slot || null, drawerName: drawer?.name || null, boxId: drawer?.box_id || null,
    schedule: s?.schedule_type === 'times'
      ? { type: 'times', times: s.times_local }
      : s?.schedule_type === 'interval' ? { type: 'interval', everyHours: s.interval_hours, anchor: s.anchor_local, anchorDate: s.anchor_date } : null,
    startDate: m.start_date || '', endDate: m.end_date || '', instructions: m.instructions || '', mealTiming: m.meal_timing || '',
    notes: m.notes || '', active: m.active, createdAt: m.created_at,
  };
};

async function withDrawers(meds) {
  const drawers = await Drawer.find({ _id: { $in: meds.map((m) => m.drawer_id).filter(Boolean) } }).lean();
  const D = new Map(drawers.map((d) => [d._id, d]));
  return meds.map((m) => toApiMedicine(m, D.get(m.drawer_id)));
}

export async function listMedicines(userId, { patientId } = {}) {
  const allowed = (await CaregiverPatient.find({ user_id: userId }, { patient_id: 1 }).lean()).map((l) => l.patient_id);
  const ids = patientId ? allowed.filter((p) => p === patientId) : allowed;
  const meds = await Medicine.find({ patient_id: { $in: ids }, archived_at: null }).sort({ created_at: -1 }).lean();
  return withDrawers(meds);
}

/** Raw medicine document after an access check. */
export async function getMedicine(userId, id) {
  const m = await Medicine.findOne({ _id: id, archived_at: null }).lean();
  if (!m) throw notFound('Medicine not found.');
  await assertPatientAccess(userId, m.patient_id);
  return m;
}
const apiMedicine = async (userId, id) => (await withDrawers([await getMedicine(userId, id)]))[0];

/** A drawer may only be used for a medicine if its box is paired to the SAME patient. */
async function resolveDrawer(patientId, drawerId) {
  if (!drawerId) return null;
  const d = await Drawer.findById(drawerId).lean();
  const ok = d && await Box.exists({ _id: d.box_id, patient_id: patientId, status: 'paired' });
  if (!ok) throw badRequest('That drawer does not belong to a box paired with this patient.');
  return d;
}

function buildSchedule(schedule, now) {
  if (!schedule) throw badRequest('A schedule is required.');
  if (schedule.type === 'interval') {
    return { schedule_type: 'interval', times_local: undefined, interval_hours: schedule.everyHours, anchor_local: schedule.anchor, anchor_date: schedule.anchorDate || null, effective_from: now };
  }
  return { schedule_type: 'times', times_local: [...new Set(schedule.times)].sort(), interval_hours: null, anchor_local: null, anchor_date: null, effective_from: now };
}

/** Re-sync dose documents after any schedule/drawer change without touching history. */
async function resyncDoses(patientId, medicineId, now) {
  await DoseInstance.deleteMany({ medicine_id: medicineId, scheduled_at: { $gt: now }, completed_at: null, hardware_detected_at: null, confirmation: null });
  await generateDoses(patientId, { ...defaultRange(now), now });
  await refreshStatuses(now, patientId);
}

async function boxesOf(drawerIds) {
  const ids = drawerIds.filter(Boolean);
  if (!ids.length) return [];
  return [...new Set((await Drawer.find({ _id: { $in: ids } }, { box_id: 1 }).lean()).map((d) => d.box_id))];
}

const clean = (v) => (v === '' ? null : v);

export async function createMedicine(userId, patientId, data, now = new Date()) {
  await assertPatientAccess(userId, patientId);
  const drawer = await resolveDrawer(patientId, data.drawerId);
  const m = (await Medicine.create({
    patient_id: patientId, drawer_id: drawer?._id || null, name: data.name, medicine_type: data.type || 'Tablet',
    strength: clean(data.strength) ?? null, dose_label: clean(data.dose) ?? null, dose_quantity: data.doseQuantity ?? 1, unit: data.unit || 'tablets',
    instructions: clean(data.instructions) ?? null, meal_timing: clean(data.mealTiming) ?? null, notes: clean(data.notes) ?? null,
    initial_quantity: data.quantity ?? 0, max_quantity: 0, stock_quantity: 0, low_stock_threshold: data.lowStockThreshold ?? 6,
    start_date: clean(data.startDate) ?? null, end_date: clean(data.endDate) ?? null, active: data.active ?? true,
    schedule: buildSchedule(data.schedule, now),
  })).toObject();
  if ((data.quantity ?? 0) > 0) await applyStock(m._id, data.quantity, { reason: 'initial', source: 'caregiver', userId });
  await resyncDoses(patientId, m._id, now);
  if (drawer) await bumpConfig(drawer.box_id, 'medicine added', userId, now);
  await audit({ actorId: userId, action: 'medicine.create', entityType: 'medicine', entityId: m._id });
  return apiMedicine(userId, m._id);
}

export async function updateMedicine(userId, id, data, now = new Date()) {
  const cur = await getMedicine(userId, id);
  const drawerChanged = data.drawerId !== undefined && (data.drawerId || null) !== cur.drawer_id;
  const drawer = data.drawerId !== undefined ? await resolveDrawer(cur.patient_id, data.drawerId) : null;
  const map = { name: 'name', type: 'medicine_type', strength: 'strength', dose: 'dose_label', doseQuantity: 'dose_quantity', unit: 'unit',
    instructions: 'instructions', mealTiming: 'meal_timing', notes: 'notes', lowStockThreshold: 'low_stock_threshold',
    startDate: 'start_date', endDate: 'end_date', active: 'active' };
  const set = { updated_at: new Date() };
  for (const [k, col] of Object.entries(map)) if (data[k] !== undefined) set[col] = clean(data[k]);
  if (set.name === null) delete set.name;
  if (data.drawerId !== undefined) set.drawer_id = drawer?._id || null;
  if (data.schedule) set.schedule = buildSchedule(data.schedule, now);
  const sd = set.start_date !== undefined ? set.start_date : cur.start_date; const ed = set.end_date !== undefined ? set.end_date : cur.end_date;
  if (sd && ed && ed < sd) throw badRequest('endDate must not be before startDate');
  await Medicine.updateOne({ _id: id }, { $set: set }, { runValidators: true });
  // Explicit stock correction becomes a ledger adjustment (never a silent overwrite).
  if (data.quantity !== undefined && Number(data.quantity) !== cur.stock_quantity) {
    await applyStock(id, Number(data.quantity) - cur.stock_quantity, { reason: 'adjustment', source: 'caregiver', userId, note: 'edited in medicine form' });
  }
  await resyncDoses(cur.patient_id, id, now);
  for (const b of await boxesOf([cur.drawer_id, drawer?._id])) await bumpConfig(b, drawerChanged ? 'medicine moved' : 'medicine changed', userId, now);
  await audit({ actorId: userId, action: 'medicine.update', entityType: 'medicine', entityId: id, metadata: { fields: Object.keys(data) } });
  return apiMedicine(userId, id);
}

/** Medicines are archived, not erased: past doses and the stock ledger stay valid for reports. */
export async function archiveMedicine(userId, id, now = new Date()) {
  const cur = await getMedicine(userId, id);
  await Medicine.updateOne({ _id: id }, { $set: { archived_at: new Date(), active: false, drawer_id: null, updated_at: new Date() } });
  await DoseInstance.deleteMany({ medicine_id: id, scheduled_at: { $gt: now }, completed_at: null, hardware_detected_at: null, confirmation: null });
  for (const b of await boxesOf([cur.drawer_id])) await bumpConfig(b, 'medicine removed', userId, now);
  await audit({ actorId: userId, action: 'medicine.archive', entityType: 'medicine', entityId: id });
  return { patientId: cur.patient_id };
}

export async function refill(userId, id, { amount, note }) {
  const cur = await getMedicine(userId, id);
  if (!(amount > 0)) throw badRequest('Refill amount must be greater than zero.');
  const r = await applyStock(id, amount, { reason: 'refill', source: 'caregiver', userId, note });
  await audit({ actorId: userId, action: 'medicine.refill', entityType: 'medicine', entityId: id, metadata: { amount } });
  return { quantity: r.balance, medicineId: id, patientId: cur.patient_id };
}

export async function adjustStock(userId, id, { newQuantity, note }) {
  const cur = await getMedicine(userId, id);
  if (newQuantity < 0) throw badRequest('Quantity cannot be negative.');
  const r = await applyStock(id, newQuantity - cur.stock_quantity, { reason: 'adjustment', source: 'caregiver', userId, note });
  await audit({ actorId: userId, action: 'medicine.adjust_stock', entityType: 'medicine', entityId: id, metadata: { newQuantity } });
  return { quantity: r.balance, patientId: cur.patient_id };
}

export async function stockHistory(userId, id) {
  await getMedicine(userId, id);
  const rows = await StockLedger.find({ medicine_id: id }).sort({ created_at: -1 }).limit(200).lean();
  return rows.map((r) => ({ id: r._id, delta: r.delta, balanceAfter: r.balance_after, reason: r.reason, source: r.source, note: r.note, createdAt: r.created_at }));
}
