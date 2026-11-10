/** Validation for everything a box sends — shared by the HTTP device API and the Socket.IO /device namespace. */
import { z, isoDateTime } from './validate.js';

const sensors = z.object({ reed_open: z.boolean(), ir_a: z.boolean(), ir_b: z.boolean() });
const DRAWER_EVENTS = ['drawer_open', 'drawer_close', 'removal_detected', 'interaction_rejected', 'reminder_alert'];

export const eventSchema = z.object({
  event_id: z.string().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/),
  type: z.enum(['boot', 'power_off', 'drawer_open', 'drawer_close', 'removal_detected', 'interaction_rejected', 'refill_start', 'refill_end', 'reminder_alert']),
  drawer: z.number().int().min(1).max(4).optional(),
  occurred_at: isoDateTime,
  config_version: z.number().int().nonnegative().optional(),
  sensors: sensors.optional(),
  refill_mode: z.boolean().optional(),
  firmware_version: z.string().max(40).optional(),
  extra: z.record(z.string(), z.any()).optional(),
}).refine((e) => !DRAWER_EVENTS.includes(e.type) || e.drawer, { message: 'drawer is required for this event type' })
  .refine((e) => e.type !== 'removal_detected' || e.sensors, { message: 'sensors are required for removal_detected' })
  .refine((e) => new Date(e.occurred_at).getTime() < Date.now() + 5 * 60000, { message: 'occurred_at is in the future' });

export const eventsBody = z.object({ events: z.array(eventSchema).min(1).max(100) });

export const heartbeatBody = z.object({
  sent_at: isoDateTime.optional(), firmware_version: z.string().max(40).optional(), config_version: z.number().int().nonnegative().optional(),
  refill_mode: z.boolean().optional(), power_state: z.enum(['on', 'off']).optional(), wifi_rssi: z.number().int().min(-127).max(0).optional(),
  uptime_s: z.number().int().nonnegative().optional(), queued_events: z.number().int().nonnegative().optional(),
});

export const configQuery = z.object({ since: z.coerce.number().int().optional() });

export const ackBody = z.object({ version: z.number().int().nonnegative(), status: z.enum(['applied', 'failed']), error: z.string().max(300).optional() });

/** Parse with a schema and return { ok, data } or { ok:false, error } (sockets can't use Express middleware). */
export function check(schema, value) {
  const r = schema.safeParse(value ?? {});
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ') };
}
