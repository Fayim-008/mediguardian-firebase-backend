import mongoose from 'mongoose';
import { config } from '../config.js';

mongoose.set('strictQuery', true);

/** Connect once and make sure every unique / lookup index exists (replaces SQL migrations). */
export async function connectDB(uri = config.mongoUri, { log = () => {} } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!uri) throw new Error('MONGODB_URI is empty. Set it in backend/.env.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const { syncAllIndexes } = await import('./models.js');
  await syncAllIndexes();
  log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}

export const isDBUp = () => mongoose.connection.readyState === 1;
