import { Medicine, StockLedger, isDuplicateKey } from '../db/models.js';
import { badRequest } from '../lib/errors.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The ONLY place medicines.stock_quantity changes. Every change writes a stock_ledger row.
 *  - consumption is clamped at zero (the box can't count tablets) and is idempotent per dose (unique index)
 *  - every other reason must not take stock below zero
 * Uses optimistic concurrency (update only if the quantity is still what we read), so parallel changes can't corrupt it.
 */
export async function applyStock(medicineId, delta, { reason, source, doseInstanceId = null, userId = null, note = null }) {
  if (reason === 'consumption' && doseInstanceId && await StockLedger.exists({ dose_instance_id: doseInstanceId, reason: 'consumption' })) {
    const m = await Medicine.findById(medicineId, { stock_quantity: 1 }).lean();
    return { applied: false, balance: m?.stock_quantity ?? 0 };
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const m = await Medicine.findById(medicineId, { stock_quantity: 1 }).lean();
    if (!m) throw badRequest('Medicine not found.');
    let d = Number(delta);
    if (reason === 'consumption') d = -Math.min(Math.abs(d), m.stock_quantity);
    const balance = round2(m.stock_quantity + d);
    if (balance < 0) throw badRequest('Stock cannot go below zero.');
    const upd = await Medicine.updateOne(
      { _id: medicineId, stock_quantity: m.stock_quantity },
      { $set: { stock_quantity: balance, updated_at: new Date() }, $max: { max_quantity: balance } });
    if (!upd.modifiedCount && !(upd.matchedCount && d === 0)) continue; // someone changed it meanwhile: re-read and retry
    try {
      await StockLedger.create({ medicine_id: medicineId, delta: round2(d), balance_after: balance, reason, source, dose_instance_id: doseInstanceId, user_id: userId, note });
    } catch (e) {
      // Parallel duplicate consumption for the same dose: undo our decrement.
      if (isDuplicateKey(e)) { await Medicine.updateOne({ _id: medicineId }, { $inc: { stock_quantity: -d } }); return { applied: false, balance: m.stock_quantity }; }
      throw e;
    }
    return { applied: true, balance, delta: round2(d) };
  }
  throw badRequest('Stock is being changed by someone else right now. Please try again.');
}
