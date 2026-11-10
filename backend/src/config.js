import 'dotenv/config';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable ${name}. Copy backend/.env.example to backend/.env and fill it in (see README).`);
  }
  return v;
}

const authSecret = process.env.AUTH_SECRET || (isProd ? '' : 'dev-only-insecure-secret-change-me-0123456789');
if (isProd && authSecret.length < 32) {
  throw new Error('AUTH_SECRET must be set to a random string of at least 32 characters in production.');
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd,
  isTest,
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 4000),
  mongoUri: isTest ? (process.env.TEST_MONGODB_URI || process.env.MONGODB_URI || '') : required('MONGODB_URI'),
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, ''),
  extraOrigins: (process.env.EXTRA_CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  authSecret,
  accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC || 15 * 60),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : (isProd ? 1 : 0),
  pairingTokenTtlHours: Number(process.env.PAIRING_TOKEN_TTL_HOURS || 24 * 14),
  passwordResetTtlMin: Number(process.env.PASSWORD_RESET_TTL_MIN || 30),
  heartbeatIntervalSec: Number(process.env.HEARTBEAT_INTERVAL_SEC || 60),
  offlineAfterSec: Number(process.env.OFFLINE_AFTER_SEC || 180),
  enableDevTools: process.env.ENABLE_DEV_TOOLS ? process.env.ENABLE_DEV_TOOLS === 'true' : !isProd,
  runWorker: process.env.RUN_WORKER ? process.env.RUN_WORKER === 'true' : !isTest,
  logLevel: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  firebase: {
    projectId: (process.env.FIREBASE_PROJECT_ID || '').trim(),
    clientEmail: (process.env.FIREBASE_CLIENT_EMAIL || '').trim(),
    // .env files usually hold the key on one line with literal "\n": turn them back into real newlines.
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
    serviceAccountPath: (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim(),
  },
  // Deleting an account requires a sign-in no older than this (minutes).
  recentLoginMinutes: Number(process.env.RECENT_LOGIN_MINUTES || 5),
};

export const allowedOrigins = () => [config.frontendUrl, ...config.extraOrigins];
