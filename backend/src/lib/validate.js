import { z } from 'zod';
import { badRequest } from './errors.js';

export { z };

/** Express middleware: validates req[source] against a zod schema and replaces it with the parsed value. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[source]);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    // Show the first problem as a readable sentence; the full list stays in `details`.
    const first = details[0];
    const sentence = /^[A-Z]/.test(first.message) ? first.message : `${first.path || 'Value'}: ${first.message}`;
    const more = details.length > 1 ? ` (+${details.length - 1} more)` : '';
    return next(badRequest(`${sentence}${more}`, details));
  }
  Object.defineProperty(req, source, { value: r.data, writable: true, configurable: true });
  next();
};

export const uuid = z.string().uuid();
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const isoDateTime = z.string().datetime({ offset: true });
export const trimmed = (max = 200) => z.string().trim().max(max);
export const optionalText = (max = 500) => z.string().trim().max(max).optional().nullable().transform((v) => (v === '' ? null : v ?? null));

export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export const timezone = z.string().refine(isValidTimezone, 'must be a valid IANA time zone');
