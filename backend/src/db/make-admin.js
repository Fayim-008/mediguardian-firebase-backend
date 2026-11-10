/**
 * Give an existing account the admin role (admins can register boxes in the web app: Admin → Boxes).
 * The person must have signed up first (email/password or Google).
 *   npm run make-admin -- someone@example.com
 *   npm run make-admin -- someone@example.com --remove     (back to caregiver)
 */
import { connectDB, disconnectDB } from './mongo.js';
import { User } from './models.js';

const args = process.argv.slice(2);
const email = (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
const remove = args.includes('--remove');
if (!email || !email.includes('@')) {
  console.error('Usage: npm run make-admin -- someone@example.com [--remove]');
  process.exit(1);
}
await connectDB();
const u = await User.findOneAndUpdate({ email }, { $set: { role: remove ? 'caregiver' : 'admin', updated_at: new Date() } }, { new: true }).lean();
if (!u) {
  console.error(`No account with email ${email}. Sign up in the web app first, then run this again.`);
  await disconnectDB();
  process.exit(1);
}
console.log(`${u.email} is now ${u.role}. Sign out and in again to see the change.`);
await disconnectDB();
