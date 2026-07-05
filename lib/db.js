// Shared Postgres/Supabase client. TODO: pick a client (`pg` or the Supabase
// JS client) and wire up a real connection using DATABASE_URL from .env.
//
// Minimal schema this project needs:
//   worker(phone PK, slack_user_id, site_id, preferred_language)
//   site(id PK, name)
//   broadcast(id PK, site_id, message, created_at)
//   broadcast_ack(broadcast_id FK, worker_phone FK, acked_at)
//   conversation_state(channel_id, thread_ts, flow, step)  -- for multi-step
//     SMS intake flows (e.g. the "issue" keyword flow, currently tracked
//     in-memory in features/procore-issue-intake/issue-intake.js), separate
//     from the LLM assistant's ConversationStore in thread-context/.

/**
 * @typedef {Object} Worker
 * @property {string} phone
 * @property {string} [slackUserId]
 * @property {string} siteId
 * @property {string} preferredLanguage - ISO 639-1 code.
 */

/**
 * @param {string} phone
 * @returns {Promise<Worker | null>}
 */
export async function getWorkerByPhone(phone) {
  throw new Error('Not implemented: wire up lib/db.js#getWorkerByPhone');
}

/**
 * @param {string} siteId
 * @returns {Promise<Worker[]>}
 */
export async function getWorkersBySite(siteId) {
  // TODO: replace with a real query. Empty array keeps callers (e.g.
  // features/safety-broadcast/broadcast-safety.js) runnable before the DB is wired up.
  return [];
}

/**
 * @param {string} broadcastId
 * @param {string} workerPhone
 * @returns {Promise<void>}
 */
export async function recordBroadcastAck(broadcastId, workerPhone) {
  throw new Error('Not implemented: wire up lib/db.js#recordBroadcastAck');
}
