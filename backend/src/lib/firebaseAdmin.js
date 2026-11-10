/**
 * Firebase Admin: verifies the ID tokens the React app gets from Firebase Authentication
 * (email/password sign-up/sign-in and "Continue with Google").
 *
 * Two ways to configure (backend/.env):
 *  A) FULL (recommended): a service account — FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY,
 *     or FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json.
 *     Enables revoked-token checks and deleting the Firebase user when an account is deleted.
 *  B) MINIMAL: only FIREBASE_PROJECT_ID. Token signatures are still verified (Google's public keys),
 *     but revocation can't be checked and the browser deletes the Firebase user itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config.js';
import { HttpError } from './errors.js';
import { logger } from './logger.js';

let auth = null;
let hasCredentials = false;
let initError = null;

function loadServiceAccount() {
  const p = config.firebase.serviceAccountPath;
  if (p) {
    const full = path.resolve(p);
    if (!fs.existsSync(full)) throw new Error(`FIREBASE_SERVICE_ACCOUNT_PATH points to ${full}, but that file does not exist.`);
    try { return JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch { throw new Error(`${full} is not a valid service-account JSON file (download it again from Firebase console).`); }
  }
  const { projectId, clientEmail, privateKey } = config.firebase;
  if (clientEmail && privateKey) {
    if (!privateKey.includes('BEGIN PRIVATE KEY')) throw new Error('FIREBASE_PRIVATE_KEY does not look like a private key. Copy the whole "private_key" value, including -----BEGIN PRIVATE KEY-----.');
    return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }
  return null;
}

export function initFirebaseAdmin() {
  if (auth || initError) return { ok: !!auth, hasCredentials, error: initError };
  try {
    const sa = loadServiceAccount();
    const projectId = config.firebase.projectId || sa?.project_id;
    if (!projectId) throw new Error('Firebase is not configured. Set FIREBASE_PROJECT_ID (and ideally the service account) in backend/.env.');
    const app = getApps()[0] || initializeApp(sa ? { credential: cert(sa), projectId } : { projectId });
    auth = getAuth(app);
    hasCredentials = !!sa;
    logger.info(`Firebase Admin ready for project "${projectId}" (${hasCredentials ? 'service account' : 'project id only — revocation checks off'})`);
  } catch (e) {
    initError = e.message;
    logger.error(`Firebase Admin NOT ready: ${e.message}`);
  }
  return { ok: !!auth, hasCredentials, error: initError };
}

export const firebaseStatus = () => ({ ok: !!auth, hasCredentials, error: initError });

const unauthorizedToken = (message, code) => new HttpError(401, message, code);

/**
 * Verify a Firebase ID token. Every failure becomes an HttpError with a message the app can show as-is.
 */
export async function verifyFirebaseToken(idToken) {
  if (!auth) {
    initFirebaseAdmin();
    if (!auth) throw new HttpError(503, 'Sign-in is temporarily unavailable: the server\'s Firebase configuration is missing or invalid. Please contact the administrator.', 'auth_not_configured');
  }
  try {
    return await auth.verifyIdToken(idToken, hasCredentials);
  } catch (e) {
    const code = e?.code || e?.errorInfo?.code || '';
    switch (code) {
      case 'auth/id-token-expired':
        throw unauthorizedToken('Your sign-in has expired. Please sign in again.', 'token_expired');
      case 'auth/id-token-revoked':
        throw unauthorizedToken('This sign-in was revoked (password changed or account signed out). Please sign in again.', 'token_revoked');
      case 'auth/user-disabled':
        throw new HttpError(403, 'This account has been disabled. Please contact support.', 'user_disabled');
      case 'auth/user-not-found':
        throw unauthorizedToken('This account no longer exists.', 'user_not_found');
      case 'auth/argument-error':
      case 'auth/invalid-id-token':
        if (/aud|audience|project/i.test(e.message || '')) {
          logger.error({ err: e.message }, 'Firebase token is for a different project. Frontend VITE_FIREBASE_PROJECT_ID and backend FIREBASE_PROJECT_ID must match.');
          throw new HttpError(401, 'Sign-in failed because the app and server use different Firebase projects. Please contact the administrator.', 'firebase_project_mismatch');
        }
        throw unauthorizedToken('Invalid sign-in token. Please sign in again.', 'token_invalid');
      default:
        if (/fetch|network|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(e?.message || '')) {
          logger.error({ err: e.message }, 'Could not reach Google to verify the Firebase token');
          throw new HttpError(503, 'The server could not reach Google to verify your sign-in. Please try again in a moment.', 'auth_upstream_unavailable');
        }
        logger.warn({ code, err: e?.message }, 'Firebase token verification failed');
        throw unauthorizedToken('We could not verify your sign-in. Please sign in again.', 'token_invalid');
    }
  }
}

/** Delete the Firebase user (needs a service account). Returns true if deleted here. */
export async function deleteFirebaseUser(uid) {
  if (!auth || !hasCredentials || !uid) return false;
  try { await auth.deleteUser(uid); return true; }
  catch (e) {
    if (e?.code === 'auth/user-not-found') return true;
    logger.warn({ err: e.message }, 'Could not delete Firebase user');
    return false;
  }
}

/** Sign the user out of every device on the Firebase side too (needs a service account). */
export async function revokeFirebaseSessions(uid) {
  if (!auth || !hasCredentials || !uid) return false;
  try { await auth.revokeRefreshTokens(uid); return true; } catch { return false; }
}
