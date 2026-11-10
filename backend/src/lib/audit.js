import { AuditLog } from '../db/models.js';

/** Append an audit record. Never throws (auditing must not break the request). Never pass secrets in metadata. */
export async function audit({ actorType = 'user', actorId = null, action, entityType = null, entityId = null, metadata = null, ip = null }) {
  try {
    await AuditLog.create({ actor_type: actorType, actor_id: actorId, action, entity_type: entityType, entity_id: entityId, metadata, ip });
  } catch { /* ignore */ }
}
