/**
 * Authentication with Firebase.
 *
 * 1. The React app signs the user in with Firebase (email/password or Google) and gets a Firebase ID token.
 * 2. It sends that ID token to POST /api/v1/auth/firebase.
 * 3. We verify it with Firebase Admin, find or create the MediGuardian user, and return OUR session:
 *    a short-lived access token (JWT) + a rotating refresh token. All other APIs and Socket.IO use that session.
 * Passwords never reach this server; Firebase stores and checks them.
 */
import { config } from '../config.js';
import { User, RefreshSession, CaregiverPatient, Box, Notification, isDuplicateKey } from '../db/models.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { HttpError, badRequest, unauthorized, conflict, forbidden } from '../lib/errors.js';
import { signAccessToken } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { verifyFirebaseToken, deleteFirebaseUser, revokeFirebaseSessions } from '../lib/firebaseAdmin.js';

const SUPPORTED_PROVIDERS = new Set(['password', 'google.com']);

export const publicUser = (u) => ({
  id: u._id, name: u.name, email: u.email, phone: u.phone, role: u.role, photoUrl: u.photo_url || null,
  provider: u.auth_provider || null, emailVerified: !!u.email_verified, createdAt: u.created_at,
});

async function createRefreshSession(userId, userAgent) {
  const token = randomToken(48);
  await RefreshSession.create({
    user_id: userId, token_hash: sha256(token),
    expires_at: new Date(Date.now() + config.refreshTokenTtlDays * 86400000),
    user_agent: (userAgent || '').slice(0, 200),
  });
  return token;
}

const session = async (user, ctx, extra = {}) => ({
  user: publicUser(user),
  accessToken: signAccessToken({ id: user._id, role: user.role }),
  refreshToken: await createRefreshSession(user._id, ctx.userAgent),
  ...extra,
});

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 100);

/**
 * Exchange a Firebase ID token for a MediGuardian session. Creates the account on first sign-in.
 * `profile` = optional { name, phone } typed on the registration form.
 */
export async function signInWithFirebase(idToken, profile = {}, ctx = {}) {
  const t = await verifyFirebaseToken(idToken);
  const provider = t.firebase?.sign_in_provider;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw badRequest('This sign-in method is not supported. Please use email and password, or Google.', { code: 'provider_not_supported' });
  }
  const email = String(t.email || '').trim().toLowerCase();
  if (!email) throw badRequest('Your account has no email address. Please sign in with an account that has an email.', { code: 'email_missing' });

  const now = new Date();
  const refresh = {
    email_verified: !!t.email_verified, auth_provider: provider, last_login_at: now, updated_at: now,
    ...(t.picture ? { photo_url: t.picture } : {}),
  };

  // 1) Known Firebase user
  let user = await User.findOne({ firebase_uid: t.uid }).lean();
  if (user) {
    if (user.disabled) throw forbidden('This account has been disabled. Please contact support.');
    const set = { ...refresh };
    if (user.email !== email) set.email = email;                 // email changed in Firebase
    if (!user.name && (profile.name || t.name)) set.name = cleanName(profile.name || t.name);
    try { user = await User.findByIdAndUpdate(user._id, { $set: set }, { new: true }).lean(); }
    catch (e) { if (isDuplicateKey(e)) throw conflict('Another MediGuardian account already uses this email address.', 'email_taken'); throw e; }
    await audit({ actorId: user._id, action: 'user.login', entityType: 'user', entityId: user._id, metadata: { provider }, ip: ctx.ip });
    return session(user, ctx, { isNewUser: false });
  }

  // 2) An account with this email exists but is linked to a different Firebase user (or none)
  const byEmail = await User.findOne({ email }).lean();
  if (byEmail) {
    if (byEmail.firebase_uid) {
      throw conflict('This email is already registered with a different sign-in. Use the method you signed up with, or reset your password.', 'email_linked_elsewhere');
    }
    // Legacy account without Firebase: link it only when Firebase has PROVEN the email belongs to this person.
    if (!t.email_verified) {
      throw forbidden('An account with this email already exists. Verify your email address (check your inbox), then sign in again to link it.');
    }
    if (byEmail.disabled) throw forbidden('This account has been disabled. Please contact support.');
    user = await User.findByIdAndUpdate(byEmail._id, { $set: { firebase_uid: t.uid, ...refresh } }, { new: true }).lean();
    await audit({ actorId: user._id, action: 'user.linked_firebase', entityType: 'user', entityId: user._id, metadata: { provider }, ip: ctx.ip });
    return session(user, ctx, { isNewUser: false });
  }

  // 3) Brand-new account
  const name = cleanName(profile.name || t.name || email.split('@')[0]);
  try {
    user = (await User.create({ email, name: name || 'Caregiver', phone: profile.phone || null, firebase_uid: t.uid, ...refresh })).toObject();
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // Two tabs signed up at the same moment: the other request created it.
    user = await User.findOne({ firebase_uid: t.uid }).lean();
    if (!user) throw conflict('An account with this email already exists.', 'email_taken');
    return session(user, ctx, { isNewUser: false });
  }
  await audit({ actorId: user._id, action: 'user.register', entityType: 'user', entityId: user._id, metadata: { provider }, ip: ctx.ip });
  return session(user, ctx, { isNewUser: true });
}

/** Rotating refresh tokens with reuse detection. */
export async function refreshSession(oldToken, ctx = {}) {
  if (!oldToken) throw unauthorized('Please sign in.');
  const s = await RefreshSession.findOneAndUpdate(
    { token_hash: sha256(oldToken), revoked_at: null },
    { $set: { revoked_at: new Date() } },
    { new: false }).lean();
  if (!s) {
    const old = await RefreshSession.findOne({ token_hash: sha256(oldToken) }).lean();
    if (old) {
      // A rotated token was presented again: assume theft, kill every session of this user.
      await RefreshSession.updateMany({ user_id: old.user_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
      await audit({ actorId: old.user_id, action: 'user.refresh_reuse_detected', entityType: 'user', entityId: old.user_id, ip: ctx.ip });
    }
    throw unauthorized('Your session has ended. Please sign in again.');
  }
  if (new Date(s.expires_at) < new Date()) throw unauthorized('Your session has expired. Please sign in again.');
  const user = await User.findById(s.user_id).lean();
  if (!user) throw unauthorized('This account no longer exists.');
  if (user.disabled) throw forbidden('This account has been disabled. Please contact support.');
  return session(user, ctx);
}

export async function logoutSession(token) {
  if (!token) return;
  await RefreshSession.updateOne({ token_hash: sha256(token), revoked_at: null }, { $set: { revoked_at: new Date() } });
}

/** Sign out on every device (used after a password change). */
export async function logoutEverywhere(userId, ctx = {}) {
  await RefreshSession.updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: new Date() } });
  const u = await User.findById(userId, { firebase_uid: 1 }).lean();
  await revokeFirebaseSessions(u?.firebase_uid);
  await audit({ actorId: userId, action: 'user.logout_all', entityType: 'user', entityId: userId, ip: ctx.ip });
}

/** Name and phone live here. Email and password belong to Firebase and are changed there. */
export async function updateProfile(userId, { name, phone }) {
  const set = { updated_at: new Date() };
  if (name !== undefined) set.name = cleanName(name);
  if (phone !== undefined) set.phone = phone ? phone.trim() : null;
  if (set.name === '') throw badRequest('Name cannot be empty.');
  const u = await User.findByIdAndUpdate(userId, { $set: set }, { new: true }).lean();
  if (!u) throw unauthorized('This account no longer exists.');
  await audit({ actorId: userId, action: 'user.update_profile', entityType: 'user', entityId: userId });
  return publicUser(u);
}

/**
 * Account deletion. Requires a FRESH Firebase sign-in (the app re-asks for the password or Google),
 * so a stolen session alone cannot delete an account.
 */
export async function deleteAccount(userId, idToken, ctx = {}) {
  const u = await User.findById(userId).lean();
  if (!u) throw unauthorized('This account no longer exists.');
  const t = await verifyFirebaseToken(idToken);
  if (!u.firebase_uid || t.uid !== u.firebase_uid) throw forbidden('Please confirm with the same account you are signed in with.');
  const ageMin = (Date.now() / 1000 - Number(t.auth_time || 0)) / 60;
  if (ageMin > config.recentLoginMinutes) {
    throw new HttpError(401, 'For your security, please confirm your sign-in again before deleting the account.', 'requires_recent_login');
  }
  const { unpairBoxCore } = await import('./boxService.js');
  const { deletePatientData } = await import('./patientService.js');
  for (const b of await Box.find({ owner_user_id: userId }, { _id: 1 }).lean()) await unpairBoxCore(b._id, null, 'owner account deleted');
  for (const link of await CaregiverPatient.find({ user_id: userId }).lean()) {
    const others = await CaregiverPatient.countDocuments({ patient_id: link.patient_id, user_id: { $ne: userId } });
    if (!others) await deletePatientData(link.patient_id);
  }
  await CaregiverPatient.deleteMany({ user_id: userId });
  await RefreshSession.deleteMany({ user_id: userId });
  await Notification.deleteMany({ user_id: userId });
  await User.deleteOne({ _id: userId });
  const firebaseDeleted = await deleteFirebaseUser(u.firebase_uid);
  await audit({ actorType: 'system', action: 'user.account_deleted', entityType: 'user', entityId: userId, ip: ctx.ip });
  return { ok: true, firebaseDeleted };
}
