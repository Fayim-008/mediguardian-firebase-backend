import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Crockford-style base32 without ambiguous characters, for human-typable codes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export function randomCode(len, groupEvery = 4) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (groupEvery && (i + 1) % groupEvery === 0 && i + 1 < len) out += '-';
  }
  return out;
}
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

