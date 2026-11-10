import pino from 'pino';
import { config } from '../config.js';

// Redact anything credential-like if it is ever logged by accident.
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.password_hash', '*.token', '*.newPassword', '*.currentPassword', '*.refreshToken', '*.idToken', '*.privateKey', '*.private_key'],
    censor: '[redacted]',
  },
});
