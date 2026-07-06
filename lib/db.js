// Shared database layer — workers, sites, broadcasts, and acknowledgments.
//
// ---------------------------------------------------------------------------
// COORDINATION NOTE — Lindsay (safety-broadcast), branch lindsay/translate,
// 2026-07-06. For Warren / Warren's Claude:
//   This is a TEMPORARY in-memory implementation, added so the safety-broadcast
//   flow can run and be demoed locally WITHOUT a real database. It is NOT the
//   real persistence layer — data lives only for the life of the process and
//   resets on restart. The real Postgres/Supabase wiring (using DATABASE_URL)
//   is still TODO; the target schema is below. If you pick up the real DB
//   layer, please ping Lindsay first so we don't build it twice or collide.
// ---------------------------------------------------------------------------
//
// Target schema for the real database:
//   worker(phone PK, slack_user_id, site_id, preferred_language)
//   site(id PK, name)
//   broadcast(id PK, site_id, message, created_at)
//   broadcast_ack(broadcast_id FK, worker_phone FK, acked_at)
//   conversation_state(channel_id, thread_ts, flow, step)  -- SMS intake flows

import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} Worker
 * @property {string} phone
 * @property {string} [slackUserId]
 * @property {string} siteId
 * @property {string} preferredLanguage - ISO 639-1 code.
 * @property {string} [name]
 */

/**
 * @typedef {Object} Broadcast
 * @property {string} id
 * @property {string} siteId
 * @property {string} message
 * @property {string} createdAt - ISO 8601 timestamp.
 */

// --- In-memory tables (seeded with sample data; reset on process restart) ---

/** @type {Worker[]} */
const workers = [
  { phone: '+15550000001', siteId: 'downtown', preferredLanguage: 'en', name: 'Alex' },
  { phone: '+15550000002', siteId: 'downtown', preferredLanguage: 'es', name: 'Maria' },
  { phone: '+15550000003', siteId: 'downtown', preferredLanguage: 'pt', name: 'Joao' },
  { phone: '+15550000004', siteId: 'riverside', preferredLanguage: 'es', name: 'Diego' },
];

/** @type {Map<string, Broadcast>} */
const broadcasts = new Map();

/** @type {Set<string>} Keyed `${broadcastId}::${workerPhone}` so each ack counts once. */
const acks = new Set();

/**
 * Look up a single worker by phone number.
 * @param {string} phone
 * @returns {Promise<Worker | null>}
 */
export async function getWorkerByPhone(phone) {
  return workers.find((worker) => worker.phone === phone) ?? null;
}

/**
 * List every worker assigned to a site.
 * @param {string} siteId
 * @returns {Promise<Worker[]>}
 */
export async function getWorkersBySite(siteId) {
  return workers.filter((worker) => worker.siteId === siteId);
}

/**
 * Create a broadcast record so its acknowledgments can be tracked.
 * @param {string} siteId
 * @param {string} message
 * @returns {Promise<Broadcast>}
 */
export async function createBroadcast(siteId, message) {
  const broadcast = { id: randomUUID(), siteId, message, createdAt: new Date().toISOString() };
  broadcasts.set(broadcast.id, broadcast);
  return broadcast;
}

/**
 * Record that a worker acknowledged a broadcast. Idempotent — the same worker
 * acknowledging twice still counts once.
 * @param {string} broadcastId
 * @param {string} workerPhone
 * @returns {Promise<void>}
 */
export async function recordBroadcastAck(broadcastId, workerPhone) {
  acks.add(`${broadcastId}::${workerPhone}`);
}

/**
 * How many workers have acknowledged a broadcast, out of how many were sent it.
 * Powers the live "X/Y acknowledged" Slack message.
 * @param {string} broadcastId
 * @returns {Promise<{ acknowledged: number, total: number }>}
 */
export async function getAckStatus(broadcastId) {
  const broadcast = broadcasts.get(broadcastId);
  const total = broadcast ? (await getWorkersBySite(broadcast.siteId)).length : 0;

  let acknowledged = 0;
  for (const key of acks) {
    if (key.startsWith(`${broadcastId}::`)) acknowledged += 1;
  }
  return { acknowledged, total };
}
