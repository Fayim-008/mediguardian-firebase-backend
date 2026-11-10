import { CaregiverPatient, Notification, Patient, isDuplicateKey } from '../db/models.js';
import { emitToUser } from '../lib/realtime.js';

/**
 * In-app notifications. (user_id, dedupe_key) is UNIQUE, so an unresolved condition notifies each caregiver once.
 * Returns the user ids that actually received a NEW notification (caller emits the realtime signal).
 */
export async function notifyPatientCaregivers(patientId, { type, severity = 'info', title, body = null, dedupeKey }) {
  if (!patientId) return [];
  const links = await CaregiverPatient.find({ patient_id: patientId }, { user_id: 1 }).lean();
  const created = [];
  for (const l of links) {
    try {
      await Notification.create({ user_id: l.user_id, patient_id: patientId, type, severity, title, body, dedupe_key: dedupeKey });
      created.push(l.user_id);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
    }
  }
  return created;
}

export const pushNotificationSignal = (userIds) => (userIds || []).forEach((u) => emitToUser(u, 'notification:new', {}));

export async function listNotifications(userId, { unreadOnly = false } = {}) {
  const rows = await Notification.find({ user_id: userId, ...(unreadOnly ? { read_at: null } : {}) }).sort({ created_at: -1 }).limit(100).lean();
  const patients = await Patient.find({ _id: { $in: [...new Set(rows.map((n) => n.patient_id).filter(Boolean))] } }, { full_name: 1 }).lean();
  const P = new Map(patients.map((p) => [p._id, p.full_name]));
  return rows.map((n) => ({ id: n._id, type: n.type, severity: n.severity, title: n.title, body: n.body, patientId: n.patient_id,
    patientName: P.get(n.patient_id) || null, createdAt: n.created_at, read: !!n.read_at }));
}

export const markRead = (userId, id) =>
  Notification.updateMany({ user_id: userId, read_at: null, ...(id ? { _id: id } : {}) }, { $set: { read_at: new Date() } });
