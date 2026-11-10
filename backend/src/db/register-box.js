/**
 * Manufacturing CLI: register boxes, print the codes ONCE and write a QR PNG per box.
 *   npm run register-box -- --count 3 [--simulated] [--out ./qr-out]
 * The DEVICE TOKEN goes into that box's firmware (secrets.h -> DEVICE_TOKEN). The QR / pairing code goes on the label.
 */
import fs from 'node:fs';
import path from 'node:path';
import { connectDB, disconnectDB } from './mongo.js';
import { registerBox } from '../services/boxService.js';

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const count = Number(val('count', 1)); const simulated = argv.includes('--simulated'); const out = path.resolve(String(val('out', './qr-out')));
await connectDB();
fs.mkdirSync(out, { recursive: true });
for (let i = 0; i < count; i++) {
  const b = await registerBox({ simulated, label: simulated ? 'Simulated box' : null });
  const png = path.join(out, `${b.boxCode}.png`);
  fs.writeFileSync(png, Buffer.from(b.qrDataUrl.split(',')[1], 'base64'));
  console.log(`\nBox ${i + 1}${simulated ? ' (SIMULATED)' : ''}
  box code      : ${b.boxCode}
  pairing code  : ${b.pairingCode}   (type this in "Add Box", single use, expires in ${Math.round(b.expiresInHours / 24)} days)
  device token  : ${b.deviceToken}
                  -> paste into esp32-firmware/MediGuardianBox/secrets.h as DEVICE_TOKEN (shown ONCE, keep it secret)
  QR image      : ${png}`);
}
await disconnectDB();
