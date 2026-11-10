import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User, Patient, CaregiverPatient, Box, DeviceCredential, withId } from '../db/models.js';
import { unauthorized, forbidden, notFound } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';

export function signAccessToken(user) {
  return jwt.sign({ role: user.role }, config.authSecret, {
    algorithm: 'HS256', subject: String(user.id || user._id), audience: 'mg-user', expiresIn: config.accessTokenTtlSec,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.authSecret, { algorithms: ['HS256'], audience: 'mg-user' });
}

export async function requireUser(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ') || h.startsWith('Bearer mgd_')) throw unauthorized('Please sign in to continue.');
    let claims;
    try { claims = verifyAccessToken(h.slice(7)); } catch { throw unauthorized('Session expired. Please sign in again.'); }
    const u = await User.findById(claims.sub).lean();
    if (!u) throw unauthorized('This account no longer exists. Please sign in again.');
    if (u.disabled) throw forbidden('This account has been disabled. Please contact support.');
    req.user = {
      id: u._id, email: u.email, name: u.name, phone: u.phone, role: u.role, photoUrl: u.photo_url || null,
      provider: u.auth_provider || null, emailVerified: !!u.email_verified, createdAt: u.created_at,
    };
    next();
  } catch (e) { next(e); }
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(forbidden('Administrator access required.'));
  next();
}

/**
 * Authorization is ALWAYS decided from the database using the authenticated user id.
 * Returns 404 (not 403) for patients the user cannot see, so ids of other people's patients cannot be probed.
 */
export async function assertPatientAccess(userId, patientId) {
  if (!patientId) throw notFound('Patient not found.');
  const link = await CaregiverPatient.exists({ user_id: userId, patient_id: patientId });
  if (!link) throw notFound('Patient not found.');
  const p = await Patient.findById(patientId).lean();
  if (!p) throw notFound('Patient not found.');
  return withId(p);
}

export async function assertBoxAccess(userId, boxId) {
  const b = await Box.findOne({ _id: boxId, owner_user_id: userId }).lean();
  if (!b) throw notFound('Box not found.');
  return withId(b);
}

/** Look up the box that owns a device token (mgd_...). Returns null when unknown/revoked/retired. */
export async function findBoxByDeviceToken(token) {
  if (!token || !String(token).startsWith('mgd_')) return null;
  const cred = await DeviceCredential.findOne({ token_hash: sha256(String(token)), revoked_at: null }).lean();
  if (!cred) return null;
  const box = await Box.findOne({ _id: cred.box_id, status: { $ne: 'retired' } }).lean();
  if (!box) return null;
  DeviceCredential.updateOne({ _id: cred._id }, { $set: { last_used_at: new Date() } }).catch(() => {});
  return withId(box);
}

/** Device authentication for the HTTP device API: Authorization: Bearer mgd_<secret>. */
export async function requireDevice(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer mgd_')) throw unauthorized('Device credential required.');
    const box = await findBoxByDeviceToken(h.slice(7));
    if (!box) throw unauthorized('Invalid device credential.');
    req.box = box;
    next();
  } catch (e) { next(e); }
}
