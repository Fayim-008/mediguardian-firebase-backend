import crypto from 'node:crypto';
import { Router } from 'express';
import { z, validate, uuid } from '../lib/validate.js';
import { requireUser, assertBoxAccess } from '../middleware/auth.js';
import { registerBox } from '../services/boxService.js';
import * as dev from '../services/deviceService.js';
import { Box, Drawer, Medicine, DoseInstance } from '../db/models.js';
import { badRequest, conflict } from '../lib/errors.js';
import { refreshStatuses } from '../services/doseService.js';
import { runSweep } from '../services/worker.js';
import { emitToPatientCaregivers } from '../lib/realtime.js';

/**
 * DEVELOPMENT / DEMO ONLY (disabled in production). Everything created here is flagged is_simulated
 * and labelled SIMULATED in the UI; it must never be mistaken for a real box.
 */
export const devRouter = Router();
devRouter.use(requireUser);
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const uid = () => `sim-${crypto.randomUUID()}`;

devRouter.post('/simulated-box', h(async (req, res) => {
  res.status(201).json(await registerBox({ simulated: true, label: 'Simulated box', actorId: req.user.id, ttlHours: 24 }));
}));

async function simBox(userId, boxId) {
  const box = await assertBoxAccess(userId, boxId);
  if (!box.is_simulated) throw badRequest('Scenario controls only work on simulated boxes, never on real hardware.');
  return box;
}

const removal = (slot, at, extra = {}) => ({ event_id: uid(), type: 'removal_detected', drawer: slot, occurred_at: at.toISOString(),
  sensors: { reed_open: true, ir_a: true, ir_b: false }, refill_mode: false, ...extra });

/** Create a back-dated, clearly simulated dose so each scenario is deterministic. */
async function makeSimDose(box, slot, offsetMinutes, now) {
  const d = await Drawer.findOne({ box_id: box.id, slot }).lean();
  const m = d && await Medicine.findOne({ drawer_id: d._id, active: true, archived_at: null }).lean();
  if (!m) throw conflict('Add a medicine to that drawer first.');
  const at = new Date(now.getTime() - offsetMinutes * 60000);
  await DoseInstance.collection.updateOne(
    { medicine_id: m._id, scheduled_at: at },
    { $setOnInsert: { _id: crypto.randomUUID(), patient_id: box.patient_id, box_id: box.id, drawer_id: d._id, drawer_slot: slot,
      status: 'awaiting_confirmation', completed_at: null, hardware_event_id: null, hardware_detected_at: null, confirmation: null,
      is_simulated: true, created_at: new Date(), updated_at: new Date() } },
    { upsert: true });
  return at;
}

devRouter.post('/boxes/:id/simulate', validate(z.object({ id: uuid }), 'params'), validate(z.object({
  scenario: z.enum(['on_time_dose', 'drawer_open_no_hand', 'late_dose', 'missed_dose', 'refill_mode', 'go_offline', 'reconnect', 'power_on', 'duplicate_event']),
  slot: z.number().int().min(1).max(4).default(1),
})), h(async (req, res) => {
  const box = await simBox(req.user.id, req.params.id);
  const { scenario, slot } = req.body; const now = new Date(); let detail = {};
  if (box.status !== 'paired') throw conflict('Pair the box first.');
  switch (scenario) {
    case 'power_on':
      await dev.recordHeartbeat(box, { power_state: 'on', refill_mode: false, firmware_version: 'simulator-1.0' }, now);
      await dev.ingestEvents(box, [{ event_id: uid(), type: 'boot', occurred_at: now.toISOString(), firmware_version: 'simulator-1.0' }], now);
      break;
    case 'on_time_dose':
      await makeSimDose(box, slot, 1, now);
      detail = await dev.ingestEvents(box, [removal(slot, now)], now); break;
    case 'late_dose':
      await makeSimDose(box, slot, 90, now);
      detail = await dev.ingestEvents(box, [removal(slot, now)], now); break;
    case 'missed_dose':
      await makeSimDose(box, slot, 25 * 60, now);
      await runSweep(now); break;
    case 'drawer_open_no_hand':
      detail = await dev.ingestEvents(box, [
        { event_id: uid(), type: 'drawer_open', drawer: slot, occurred_at: now.toISOString() },
        { event_id: uid(), type: 'interaction_rejected', drawer: slot, occurred_at: new Date(now.getTime() + 1000).toISOString(), sensors: { reed_open: true, ir_a: false, ir_b: false } },
      ], now); break;
    case 'refill_mode':
      detail = await dev.ingestEvents(box, [
        { event_id: uid(), type: 'refill_start', occurred_at: now.toISOString() },
        removal(slot, new Date(now.getTime() + 2000), { refill_mode: true }),
        { event_id: uid(), type: 'refill_end', occurred_at: new Date(now.getTime() + 5000).toISOString() },
      ], now); break;
    case 'go_offline':
      await Box.updateOne({ _id: box.id }, { $set: { last_seen_at: new Date(Date.now() - 10 * 60000) } }); break;
    case 'reconnect':
      await dev.recordHeartbeat(box, { power_state: 'on', refill_mode: false }, now); break;
    case 'duplicate_event': {
      const ev = { event_id: uid(), type: 'drawer_open', drawer: slot, occurred_at: now.toISOString() };
      await dev.ingestEvents(box, [ev], now); detail = await dev.ingestEvents(box, [ev], now); break;
    }
    default: break;
  }
  await refreshStatuses(new Date(), box.patient_id);
  emitToPatientCaregivers(box.patient_id, 'device:event', { boxId: box.id });
  res.json({ ok: true, scenario, simulated: true, detail });
}));
