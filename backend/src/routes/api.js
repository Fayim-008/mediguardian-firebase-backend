import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { z, validate, uuid, hhmm, isoDate, isoDateTime, timezone } from '../lib/validate.js';
import { requireUser, requireAdmin, assertPatientAccess } from '../middleware/auth.js';
import * as patients from '../services/patientService.js';
import * as boxes from '../services/boxService.js';
import * as meds from '../services/medicineService.js';
import * as doses from '../services/doseService.js';
import * as reports from '../services/reportService.js';
import * as notifs from '../services/notificationService.js';
import { emitToPatientCaregivers } from '../lib/realtime.js';

export const apiRouter = Router();
apiRouter.use(requireUser);
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const id = z.object({ id: uuid });

/* ---------- patients ---------- */
const optStr = (n = 300) => z.string().trim().max(n).optional().nullable();
const patientBody = z.object({
  name: z.string().trim().min(1).max(120), relationship: optStr(60), dob: z.union([isoDate, z.literal('')]).optional().nullable(), gender: optStr(30),
  phone: optStr(30), email: z.union([z.string().trim().email().max(254), z.literal('')]).optional().nullable(), address: optStr(300),
  bloodGroup: optStr(10), conditions: optStr(500), allergies: optStr(500), emergencyName: optStr(120), emergencyPhone: optStr(30),
  emergencyRelation: optStr(60), doctorName: optStr(120), doctorContact: optStr(60), notes: optStr(2000), photo: optStr(500),
  timezone: timezone.optional(), gracePeriodMinutes: z.number().int().min(5).max(720).optional(), missedAfterHours: z.number().int().min(2).max(72).optional(),
  status: z.enum(['Active', 'Inactive']).optional(),
});
apiRouter.get('/patients', h(async (req, res) => res.json({ patients: await patients.listPatients(req.user.id) })));
apiRouter.post('/patients', validate(patientBody), h(async (req, res) => res.status(201).json({ patient: await patients.createPatient(req.user.id, req.body) })));
apiRouter.get('/patients/:id', validate(id, 'params'), h(async (req, res) => res.json({ patient: await patients.getPatient(req.user.id, req.params.id) })));
apiRouter.patch('/patients/:id', validate(id, 'params'), validate(patientBody.partial()), h(async (req, res) => res.json({ patient: await patients.updatePatient(req.user.id, req.params.id, req.body) })));
apiRouter.delete('/patients/:id', validate(id, 'params'), h(async (req, res) => res.json(await patients.deletePatient(req.user.id, req.params.id))));

/* ---------- boxes ---------- */
apiRouter.get('/boxes', h(async (req, res) => res.json({ boxes: await boxes.listBoxesForUser(req.user.id) })));
const pairLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 100000 : 15, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many pairing attempts. Please wait a few minutes.' } } });
apiRouter.post('/boxes/pair', pairLimiter, validate(z.object({
  boxCode: z.string().trim().min(5).max(40), pairingCode: z.string().trim().min(8).max(40),
  patientId: uuid.optional(), newPatient: patientBody.optional(), label: z.string().trim().max(60).optional(),
})), h(async (req, res) => res.status(201).json(await boxes.pairBox(req.user.id, req.body, { ip: req.ip }))));
apiRouter.get('/patients/:id/boxes', validate(id, 'params'), h(async (req, res) => {
  await assertPatientAccess(req.user.id, req.params.id);
  res.json({ boxes: await boxes.listBoxesForPatient(req.params.id) });
}));
apiRouter.post('/boxes/:id/unpair', validate(id, 'params'), h(async (req, res) => res.json(await boxes.unpairBox(req.user.id, req.params.id))));
apiRouter.get('/boxes/:id/history', validate(id, 'params'), h(async (req, res) => res.json({ history: await boxes.boxHistory(req.user.id, req.params.id) })));
apiRouter.patch('/boxes/:id/drawers/:slot', validate(z.object({ id: uuid, slot: z.coerce.number().int().min(1).max(4) }), 'params'),
  validate(z.object({ name: z.string().trim().min(1).max(40) })), h(async (req, res) => {
    await boxes.renameDrawer(req.user.id, req.params.id, req.params.slot, req.body.name); res.json({ ok: true });
  }));
apiRouter.get('/boxes/:id/config-history', validate(id, 'params'), h(async (req, res) => res.json({ versions: await boxes.configHistory(req.user.id, req.params.id) })));
/** Real-time command to the physical box over Socket.IO. */
apiRouter.post('/boxes/:id/command', validate(id, 'params'), validate(z.object({
  command: z.enum(['ring', 'sync_config', 'message', 'stop_alarm']), drawer: z.number().int().min(1).max(4).optional(), text: z.string().trim().max(32).optional(),
})), h(async (req, res) => res.json(await boxes.sendBoxCommand(req.user.id, req.params.id, req.body))));

/* ---------- medicines ---------- */
const schedule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('times'), times: z.array(hhmm).min(1).max(12) }),
  z.object({ type: z.literal('interval'), everyHours: z.number().int().min(1).max(24), anchor: hhmm, anchorDate: isoDate.optional() }),
]);
const medBase = z.object({
  name: z.string().trim().min(1).max(120), type: z.string().trim().max(30).optional(), strength: z.string().trim().max(60).optional().nullable(),
  dose: z.string().trim().max(60).optional().nullable(), doseQuantity: z.number().positive().max(100).optional(), unit: z.string().trim().max(20).optional(),
  quantity: z.number().min(0).max(100000).optional(), lowStockThreshold: z.number().min(0).max(100000).optional(),
  drawerId: uuid.nullable().optional(), schedule, startDate: z.union([isoDate, z.literal('')]).optional().nullable(),
  endDate: z.union([isoDate, z.literal('')]).optional().nullable(), instructions: z.string().trim().max(300).optional().nullable(),
  mealTiming: z.string().trim().max(40).optional().nullable(), notes: z.string().trim().max(1000).optional().nullable(), active: z.boolean().optional(),
});
const dateOrder = (v) => !v.startDate || !v.endDate || v.endDate >= v.startDate;
apiRouter.get('/medicines', validate(z.object({ patientId: uuid.optional() }), 'query'),
  h(async (req, res) => res.json({ medicines: await meds.listMedicines(req.user.id, { patientId: req.query.patientId }) })));
apiRouter.post('/patients/:id/medicines', validate(id, 'params'), validate(medBase.refine(dateOrder, 'endDate must not be before startDate')),
  h(async (req, res) => { const m = await meds.createMedicine(req.user.id, req.params.id, req.body); emitToPatientCaregivers(req.params.id, 'config:changed', {}); res.status(201).json({ medicine: m }); }));
apiRouter.patch('/medicines/:id', validate(id, 'params'), validate(medBase.partial()),
  h(async (req, res) => { const m = await meds.updateMedicine(req.user.id, req.params.id, req.body); emitToPatientCaregivers(m.patientId, 'config:changed', {}); res.json({ medicine: m }); }));
apiRouter.delete('/medicines/:id', validate(id, 'params'),
  h(async (req, res) => { const r = await meds.archiveMedicine(req.user.id, req.params.id); emitToPatientCaregivers(r.patientId, 'config:changed', {}); res.json({ ok: true }); }));
apiRouter.post('/medicines/:id/refill', validate(id, 'params'), validate(z.object({ amount: z.number().positive().max(100000), note: z.string().trim().max(200).optional() })),
  h(async (req, res) => { const r = await meds.refill(req.user.id, req.params.id, req.body); emitToPatientCaregivers(r.patientId, 'stock:changed', {}); res.json(r); }));
apiRouter.post('/medicines/:id/adjust-stock', validate(id, 'params'), validate(z.object({ newQuantity: z.number().min(0).max(100000), note: z.string().trim().max(200).optional() })),
  h(async (req, res) => { const r = await meds.adjustStock(req.user.id, req.params.id, req.body); emitToPatientCaregivers(r.patientId, 'stock:changed', {}); res.json({ quantity: r.quantity }); }));
apiRouter.get('/medicines/:id/stock-history', validate(id, 'params'), h(async (req, res) => res.json({ ledger: await meds.stockHistory(req.user.id, req.params.id) })));

/* ---------- doses / schedule ---------- */
apiRouter.get('/patients/:id/doses', validate(id, 'params'),
  validate(z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), status: z.string().max(40).optional(), medicineId: uuid.optional() }), 'query'),
  h(async (req, res) => res.json({ doses: await doses.listDoses(req.user.id, req.params.id, req.query) })));
apiRouter.get('/patients/:id/today', validate(id, 'params'), h(async (req, res) => res.json({ doses: await doses.todaySchedule(req.user.id, req.params.id) })));
apiRouter.post('/doses/:id/confirm', validate(id, 'params'), validate(z.object({ confirmedAt: isoDateTime.optional(), note: z.string().trim().max(200).optional() })),
  h(async (req, res) => {
    const { patientId, ...r } = await doses.confirmDose(req.user.id, req.params.id, req.body);
    emitToPatientCaregivers(patientId, 'dose:update', {});
    res.json(r);
  }));

/* ---------- reports / dashboard / notifications ---------- */
apiRouter.get('/dashboard', h(async (req, res) => res.json(await reports.dashboardSummary(req.user.id))));
apiRouter.get('/reports', validate(z.object({
  patientId: uuid.optional(), range: z.enum(['1D', '7D', '30D']).optional(), from: isoDateTime.optional(), to: isoDateTime.optional(),
  medicineId: uuid.optional(), boxId: uuid.optional(), status: z.enum(['upcoming', 'awaiting_confirmation', 'on_time', 'late', 'missed']).optional(),
}), 'query'), h(async (req, res) => res.json(await reports.buildReport(req.user.id, req.query))));
apiRouter.get('/notifications', h(async (req, res) => res.json({ notifications: await notifs.listNotifications(req.user.id, { unreadOnly: req.query.unread === 'true' }) })));
apiRouter.post('/notifications/read', validate(z.object({ id: uuid.optional() })), h(async (req, res) => { await notifs.markRead(req.user.id, req.body.id); res.json({ ok: true }); }));

/* ---------- admin: manufacturing / box registration ---------- */
export const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);
adminRouter.post('/boxes', validate(z.object({ count: z.number().int().min(1).max(50).default(1), label: z.string().trim().max(60).optional() })),
  h(async (req, res) => {
    const out = [];
    for (let i = 0; i < req.body.count; i++) out.push(await boxes.registerBox({ label: req.body.label, actorId: req.user.id }));
    res.status(201).json({ boxes: out, note: 'deviceToken and pairingCode are shown only once.' });
  }));
adminRouter.post('/boxes/:code/reissue-pairing', h(async (req, res) => res.json(await boxes.reissuePairing(req.params.code, req.user.id))));
