import { Patient, CaregiverPatient, Box, Medicine, DoseInstance, StockLedger, Notification } from '../db/models.js';
import { assertPatientAccess } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';

// API <-> DB mapping. The API keeps the field names the React app already uses.
export const toApiPatient = (p) => ({
  id: p._id, name: p.full_name, relationship: p.relationship || '', dob: p.date_of_birth || '', gender: p.gender || '',
  phone: p.phone || '', email: p.email || '', address: p.address || '', bloodGroup: p.blood_group || '',
  conditions: p.conditions || '', allergies: p.allergies || '', emergencyName: p.emergency_name || '',
  emergencyPhone: p.emergency_phone || '', emergencyRelation: p.emergency_relation || '',
  doctorName: p.doctor_name || '', doctorContact: p.doctor_contact || '', notes: p.notes || '', photo: p.photo_url || '',
  timezone: p.timezone, status: p.status === 'active' ? 'Active' : 'Inactive',
  gracePeriodMinutes: p.grace_minutes, missedAfterHours: p.missed_after_hours,
  createdAt: p.created_at,
});

const COLS = {
  name: 'full_name', relationship: 'relationship', dob: 'date_of_birth', gender: 'gender', phone: 'phone', email: 'email',
  address: 'address', bloodGroup: 'blood_group', conditions: 'conditions', allergies: 'allergies',
  emergencyName: 'emergency_name', emergencyPhone: 'emergency_phone', emergencyRelation: 'emergency_relation',
  doctorName: 'doctor_name', doctorContact: 'doctor_contact', notes: 'notes', photo: 'photo_url', timezone: 'timezone',
  gracePeriodMinutes: 'grace_minutes', missedAfterHours: 'missed_after_hours',
};
const nullIfEmpty = (v) => (v === '' ? null : v);

function checkPolicy(grace, missedH) {
  if (missedH * 60 <= grace) throw badRequest('The missed-dose threshold must be longer than the grace period.');
}

export async function createPatient(userId, data) {
  const doc = { created_by: userId };
  for (const [k, col] of Object.entries(COLS)) if (data[k] !== undefined) doc[col] = nullIfEmpty(data[k]);
  if (doc.timezone === null) delete doc.timezone;
  checkPolicy(doc.grace_minutes ?? 60, doc.missed_after_hours ?? 24);
  const p = (await Patient.create(doc)).toObject();
  await CaregiverPatient.create({ user_id: userId, patient_id: p._id, role: 'owner' });
  await audit({ actorId: userId, action: 'patient.create', entityType: 'patient', entityId: p._id });
  return toApiPatient(p);
}

export async function listPatients(userId) {
  const ids = (await CaregiverPatient.find({ user_id: userId }, { patient_id: 1 }).lean()).map((l) => l.patient_id);
  const rows = await Patient.find({ _id: { $in: ids } }).sort({ created_at: -1 }).lean();
  return rows.map(toApiPatient);
}

export async function getPatient(userId, patientId) {
  return toApiPatient(await assertPatientAccess(userId, patientId));
}

export async function updatePatient(userId, patientId, data) {
  const cur = await assertPatientAccess(userId, patientId);
  const set = {};
  for (const [k, col] of Object.entries(COLS)) if (data[k] !== undefined) set[col] = nullIfEmpty(data[k]);
  if (set.full_name === null) delete set.full_name;
  if (set.timezone === null) delete set.timezone;
  if (data.status !== undefined) set.status = data.status === 'Active' ? 'active' : 'inactive';
  if (!Object.keys(set).length) return toApiPatient(cur);
  checkPolicy(set.grace_minutes ?? cur.grace_minutes, set.missed_after_hours ?? cur.missed_after_hours);
  set.updated_at = new Date();
  const row = await Patient.findByIdAndUpdate(patientId, { $set: set }, { new: true, runValidators: true }).lean();
  if (data.timezone !== undefined || data.gracePeriodMinutes !== undefined || data.missedAfterHours !== undefined) {
    // Device-visible settings changed -> every paired box of this patient gets a new configuration version.
    const { bumpPatientBoxes } = await import('./configService.js');
    await bumpPatientBoxes(patientId, 'patient settings changed', userId);
  }
  await audit({ actorId: userId, action: 'patient.update', entityType: 'patient', entityId: patientId, metadata: { fields: Object.keys(data) } });
  return toApiPatient(row);
}

/** Removes a patient and every medication record that belongs to them (MongoDB has no cascading deletes). */
export async function deletePatientData(patientId) {
  const medIds = (await Medicine.find({ patient_id: patientId }, { _id: 1 }).lean()).map((m) => m._id);
  await StockLedger.deleteMany({ medicine_id: { $in: medIds } });
  await DoseInstance.deleteMany({ patient_id: patientId });
  await Medicine.deleteMany({ patient_id: patientId });
  await Notification.deleteMany({ patient_id: patientId });
  await CaregiverPatient.deleteMany({ patient_id: patientId });
  await Patient.deleteOne({ _id: patientId });
}

/** Deleting a patient deletes their medication data. Their boxes are unpaired (returned to the pool), not deleted. */
export async function deletePatient(userId, patientId) {
  const p = await assertPatientAccess(userId, patientId);
  const link = await CaregiverPatient.findOne({ user_id: userId, patient_id: patientId }).lean();
  if (link?.role !== 'owner') throw badRequest('Only the owner of a patient profile can delete it.');
  const { unpairBoxCore } = await import('./boxService.js');
  for (const b of await Box.find({ patient_id: patientId }, { _id: 1 }).lean()) await unpairBoxCore(b._id, userId, 'patient deleted');
  await deletePatientData(patientId);
  await audit({ actorId: userId, action: 'patient.delete', entityType: 'patient', entityId: patientId, metadata: { name_redacted: true } });
  return { ok: true, name: p.full_name };
}
