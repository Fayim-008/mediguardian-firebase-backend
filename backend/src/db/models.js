/**
 * MongoDB collections (Mongoose models). This file replaces the old PostgreSQL schema.
 *
 * Conventions
 *  - Every document id is a UUID string stored in `_id` (the React app and the API validators expect UUIDs).
 *  - Field names are snake_case, exactly like the former SQL columns, so the API shape did not change.
 *  - Relations are plain id fields. There are no foreign keys in MongoDB, so deletes are cascaded in the services.
 *  - Uniqueness rules that protect correctness (one dose per medicine+time, one event per box+event_id, one
 *    consumption per dose, one notification per user+dedupe key, ...) are enforced by UNIQUE INDEXES below.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const { Schema } = mongoose;
const uuid = () => crypto.randomUUID();
const id = { type: String, default: uuid };
const ref = { type: String, default: null };
const opts = { versionKey: false };
const now = () => new Date();

/** Lean documents get an `id` copy of `_id` so service code can use `doc.id` everywhere. */
export function withId(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(withId);
  doc.id = doc._id;
  return doc;
}

/* ---------------- accounts ---------------- */
const userSchema = new Schema({
  _id: id,
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  phone: { type: String, default: null },
  role: { type: String, enum: ['caregiver', 'admin'], default: 'caregiver' },
  // Identity comes from Firebase Authentication (email/password or Google). No password is stored here.
  firebase_uid: { type: String, default: null },
  auth_provider: { type: String, default: null },            // 'password' | 'google.com'
  email_verified: { type: Boolean, default: false },
  photo_url: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  last_login_at: { type: Date, default: null },
  created_at: { type: Date, default: now },
  updated_at: { type: Date, default: now },
}, opts);
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ firebase_uid: 1 }, { unique: true, partialFilterExpression: { firebase_uid: { $type: 'string' } } });

const refreshSessionSchema = new Schema({
  _id: id,
  user_id: { type: String, required: true },
  token_hash: { type: String, required: true },
  expires_at: { type: Date, required: true },
  revoked_at: { type: Date, default: null },
  user_agent: { type: String, default: null },
  created_at: { type: Date, default: now },
}, opts);
refreshSessionSchema.index({ token_hash: 1 }, { unique: true });
refreshSessionSchema.index({ user_id: 1 });
refreshSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 }); // MongoDB deletes expired sessions itself


/* ---------------- patients ---------------- */
const patientSchema = new Schema({
  _id: id,
  full_name: { type: String, required: true },
  relationship: ref, date_of_birth: ref, gender: ref, phone: ref, email: ref, address: ref, blood_group: ref,
  conditions: ref, allergies: ref, emergency_name: ref, emergency_phone: ref, emergency_relation: ref,
  doctor_name: ref, doctor_contact: ref, notes: ref, photo_url: ref,
  timezone: { type: String, default: 'Asia/Dhaka' },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  grace_minutes: { type: Number, default: 60, min: 5, max: 720 },
  missed_after_hours: { type: Number, default: 24, min: 2, max: 72 },
  created_by: ref,
  created_at: { type: Date, default: now },
  updated_at: { type: Date, default: now },
}, opts);

/** Authorization table: which user may manage which patient. Every patient API checks it. */
const caregiverPatientSchema = new Schema({
  _id: id,
  user_id: { type: String, required: true },
  patient_id: { type: String, required: true },
  role: { type: String, enum: ['owner', 'caregiver'], default: 'owner' },
  created_at: { type: Date, default: now },
}, opts);
caregiverPatientSchema.index({ user_id: 1, patient_id: 1 }, { unique: true });
caregiverPatientSchema.index({ patient_id: 1 });

/* ---------------- boxes ---------------- */
const boxSchema = new Schema({
  _id: id,
  box_code: { type: String, required: true },
  status: { type: String, enum: ['registered', 'paired', 'retired'], default: 'registered' },
  owner_user_id: ref,
  patient_id: ref,
  label: ref,
  is_simulated: { type: Boolean, default: false },
  // reported by the device (never inferred)
  last_seen_at: { type: Date, default: null },
  power_state: { type: String, enum: ['on', 'off'], default: null },
  refill_mode: { type: Boolean, default: null },
  refill_reported_at: { type: Date, default: null },
  power_reported_at: { type: Date, default: null },
  firmware_version: ref,
  config_version_reported: { type: Number, default: null },
  wifi_rssi: { type: Number, default: null },
  // server side
  config_version: { type: Number, default: 1 },
  paired_at: { type: Date, default: null },
  created_at: { type: Date, default: now },
}, opts);
boxSchema.index({ box_code: 1 }, { unique: true });
boxSchema.index({ owner_user_id: 1 });
boxSchema.index({ patient_id: 1 });

const deviceCredentialSchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  token_hash: { type: String, required: true },
  revoked_at: { type: Date, default: null },
  last_used_at: { type: Date, default: null },
  created_at: { type: Date, default: now },
}, opts);
deviceCredentialSchema.index({ token_hash: 1 }, { unique: true });
deviceCredentialSchema.index({ box_id: 1 });

const pairingTokenSchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  token_hash: { type: String, required: true },
  expires_at: { type: Date, required: true },
  used_at: { type: Date, default: null },
  used_by: ref,
  created_at: { type: Date, default: now },
}, opts);
pairingTokenSchema.index({ token_hash: 1 }, { unique: true });
pairingTokenSchema.index({ box_id: 1 });

const ownershipHistorySchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  action: { type: String, enum: ['registered', 'paired', 'unpaired', 'reassigned', 'pairing_token_issued', 'retired'], required: true },
  user_id: ref, patient_id: ref, actor_id: ref, note: ref,
  created_at: { type: Date, default: now },
}, opts);
ownershipHistorySchema.index({ box_id: 1, created_at: -1 });

const drawerSchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  slot: { type: Number, min: 1, max: 4, required: true },
  kind: { type: String, enum: ['morning', 'noon', 'night', 'extra'], required: true },
  name: { type: String, required: true },
}, opts);
drawerSchema.index({ box_id: 1, slot: 1 }, { unique: true });

/* ---------------- medicines ---------------- */
const scheduleSchema = new Schema({
  schedule_type: { type: String, enum: ['times', 'interval'], required: true },
  times_local: { type: [String], default: undefined },       // 'HH:MM' patient-local wall clock
  interval_hours: { type: Number, default: null },
  anchor_local: { type: String, default: null },             // 'HH:MM' of the first interval dose
  anchor_date: { type: String, default: null },              // 'YYYY-MM-DD' patient-local
  effective_from: { type: Date, default: now },              // doses before this instant are never generated
}, { _id: false });

const medicineSchema = new Schema({
  _id: id,
  patient_id: { type: String, required: true },
  drawer_id: ref,
  name: { type: String, required: true },
  medicine_type: { type: String, default: 'Tablet' },
  strength: ref, dose_label: ref,
  dose_quantity: { type: Number, default: 1, min: 0.01 },
  unit: { type: String, default: 'tablets' },
  instructions: ref, meal_timing: ref, notes: ref,
  initial_quantity: { type: Number, default: 0, min: 0 },
  max_quantity: { type: Number, default: 0, min: 0 },
  stock_quantity: { type: Number, default: 0, min: 0 },      // estimate; changed only through stockService (ledger)
  low_stock_threshold: { type: Number, default: 6, min: 0 },
  start_date: ref, end_date: ref,                            // 'YYYY-MM-DD' patient-local
  active: { type: Boolean, default: true },
  archived_at: { type: Date, default: null },
  schedule: { type: scheduleSchema, default: null },
  created_at: { type: Date, default: now },
  updated_at: { type: Date, default: now },
}, opts);
medicineSchema.index({ patient_id: 1 });
medicineSchema.index({ drawer_id: 1 });

/* ---------------- device data ---------------- */
const configVersionSchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  version: { type: Number, required: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  reason: ref, created_by: ref,
  created_at: { type: Date, default: now },
  ack_status: { type: String, enum: ['pending', 'applied', 'failed', 'superseded'], default: 'pending' },
  ack_at: { type: Date, default: null },
  ack_error: ref,
}, opts);
configVersionSchema.index({ box_id: 1, version: 1 }, { unique: true });

const deviceEventSchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  event_uid: { type: String, required: true },              // device generated, stable across retries
  event_type: { type: String, required: true, enum: ['boot', 'power_off', 'drawer_open', 'drawer_close', 'removal_detected',
    'interaction_rejected', 'refill_start', 'refill_end', 'reminder_alert'] },
  drawer_slot: { type: Number, default: null },
  occurred_at: { type: Date, required: true },               // device clock: authoritative for classification
  received_at: { type: Date, default: now },
  config_version: { type: Number, default: null },
  sensors: { type: Schema.Types.Mixed, default: null },
  refill_mode: { type: Boolean, default: null },
  firmware_version: ref,
  payload: { type: Schema.Types.Mixed, default: null },
  is_simulated: { type: Boolean, default: false },
  outcome: { type: String, default: 'recorded' },
  via: { type: String, default: 'http' },                     // http | socket
}, opts);
deviceEventSchema.index({ box_id: 1, event_uid: 1 }, { unique: true });
deviceEventSchema.index({ box_id: 1, occurred_at: -1 });

const confirmationSchema = new Schema({
  source: { type: String, enum: ['caregiver', 'patient'] },
  confirmed_by: ref,
  confirmed_at: Date,
  note: ref,
  created_at: { type: Date, default: now },
}, { _id: false });

const doseSchema = new Schema({
  _id: id,
  patient_id: { type: String, required: true },
  medicine_id: { type: String, required: true },
  box_id: ref, drawer_id: ref,
  drawer_slot: { type: Number, default: null },
  scheduled_at: { type: Date, required: true },
  status: { type: String, enum: ['upcoming', 'awaiting_confirmation', 'on_time', 'late', 'missed'], default: 'upcoming' },
  completed_at: { type: Date, default: null },
  hardware_event_id: ref,
  hardware_detected_at: { type: Date, default: null },
  confirmation: { type: confirmationSchema, default: null }, // human confirmation (separate from hardware evidence)
  is_simulated: { type: Boolean, default: false },
  created_at: { type: Date, default: now },
  updated_at: { type: Date, default: now },
}, opts);
doseSchema.index({ medicine_id: 1, scheduled_at: 1 }, { unique: true }); // never two rows for the same dose
doseSchema.index({ patient_id: 1, scheduled_at: 1 });
doseSchema.index({ box_id: 1, drawer_slot: 1, scheduled_at: 1 });
doseSchema.index({ status: 1 });

const refillSessionSchema = new Schema({
  _id: id,
  box_id: { type: String, required: true },
  started_at: { type: Date, required: true },
  ended_at: { type: Date, default: null },
  start_event_uid: ref, end_event_uid: ref,
  is_simulated: { type: Boolean, default: false },
}, opts);
refillSessionSchema.index({ box_id: 1, started_at: 1 }, { unique: true });

const stockLedgerSchema = new Schema({
  _id: id,
  medicine_id: { type: String, required: true },
  delta: { type: Number, required: true },
  balance_after: { type: Number, required: true, min: 0 },
  reason: { type: String, enum: ['initial', 'refill', 'adjustment', 'consumption'], required: true },
  source: { type: String, enum: ['caregiver', 'device', 'system'], required: true },
  dose_instance_id: ref,
  user_id: ref, note: ref,
  created_at: { type: Date, default: now },
}, opts);
stockLedgerSchema.index({ medicine_id: 1, created_at: -1 });
// One consumption entry per dose = idempotent stock decrement.
stockLedgerSchema.index({ dose_instance_id: 1 }, { unique: true, partialFilterExpression: { reason: 'consumption' } });

const notificationSchema = new Schema({
  _id: id,
  user_id: { type: String, required: true },
  patient_id: ref,
  type: { type: String, required: true },
  severity: { type: String, enum: ['info', 'warning', 'danger', 'success'], default: 'info' },
  title: { type: String, required: true },
  body: ref,
  dedupe_key: { type: String, required: true },
  created_at: { type: Date, default: now },
  read_at: { type: Date, default: null },
}, opts);
notificationSchema.index({ user_id: 1, dedupe_key: 1 }, { unique: true });
notificationSchema.index({ user_id: 1, created_at: -1 });

const auditSchema = new Schema({
  _id: id,
  actor_type: { type: String, enum: ['user', 'device', 'system', 'admin'], default: 'user' },
  actor_id: ref, action: { type: String, required: true }, entity_type: ref, entity_id: ref,
  metadata: { type: Schema.Types.Mixed, default: null }, ip: ref,
  created_at: { type: Date, default: now },
}, opts);
auditSchema.index({ entity_type: 1, entity_id: 1 });
auditSchema.index({ actor_id: 1, created_at: -1 });

const model = (name, schema, collection) => mongoose.models[name] || mongoose.model(name, schema, collection);

export const User = model('User', userSchema, 'users');
export const RefreshSession = model('RefreshSession', refreshSessionSchema, 'refresh_sessions');
export const Patient = model('Patient', patientSchema, 'patients');
export const CaregiverPatient = model('CaregiverPatient', caregiverPatientSchema, 'caregiver_patients');
export const Box = model('Box', boxSchema, 'boxes');
export const DeviceCredential = model('DeviceCredential', deviceCredentialSchema, 'device_credentials');
export const BoxPairingToken = model('BoxPairingToken', pairingTokenSchema, 'box_pairing_tokens');
export const BoxOwnershipHistory = model('BoxOwnershipHistory', ownershipHistorySchema, 'box_ownership_history');
export const Drawer = model('Drawer', drawerSchema, 'drawers');
export const Medicine = model('Medicine', medicineSchema, 'medicines');
export const DeviceConfigVersion = model('DeviceConfigVersion', configVersionSchema, 'device_config_versions');
export const DeviceEvent = model('DeviceEvent', deviceEventSchema, 'device_events');
export const DoseInstance = model('DoseInstance', doseSchema, 'dose_instances');
export const RefillSession = model('RefillSession', refillSessionSchema, 'refill_sessions');
export const StockLedger = model('StockLedger', stockLedgerSchema, 'stock_ledger');
export const Notification = model('Notification', notificationSchema, 'notifications');
export const AuditLog = model('AuditLog', auditSchema, 'audit_logs');

const ALL = [User, RefreshSession, Patient, CaregiverPatient, Box, DeviceCredential, BoxPairingToken,
  BoxOwnershipHistory, Drawer, Medicine, DeviceConfigVersion, DeviceEvent, DoseInstance, RefillSession, StockLedger, Notification, AuditLog];

export async function syncAllIndexes() {
  for (const m of ALL) await m.createIndexes();
}

/** true when a MongoDB write failed only because a unique index already had that key. */
export const isDuplicateKey = (e) => e?.code === 11000 || (Array.isArray(e?.writeErrors) && e.writeErrors.length > 0 && e.writeErrors.every((w) => (w.code ?? w.err?.code) === 11000));
