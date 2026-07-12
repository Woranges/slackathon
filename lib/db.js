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

import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} Worker
 * @property {string} phone - E.164 format (e.g. "+14155552671").
 * @property {string} [name] - Display name, e.g. for "Assigned to Mike" replies.
 * @property {string} [slackUserId]
 * @property {string} siteId
 * @property {string} preferredLanguage - ISO 639-1 code.
 */

/**
 * @typedef {Object} Broadcast
 * @property {string} id
 * @property {string} siteId
 * @property {string} message
 * @property {string} createdAt - ISO 8601 timestamp.
 * @property {string} [channel] - Slack channel the live scoreboard was posted to.
 * @property {string} [messageTs] - Slack ts of the live scoreboard message.
 */

// Human-readable site names, keyed by the internal siteId used for lookups. The
// siteId stays a stable key (worker lookup, broadcast grouping); this map is only
// for display on the Slack card and the Procore RFI body. TODO: fold into a real
// `site(id, name)` table once DATABASE_URL is wired.
/** @type {Record<string, string>} */
const SITE_NAMES = {
  'site-1': 'Park Place',
  'site-2': 'Cedar Yards',
};

/**
 * Resolve a siteId to its human-readable name (falls back to the id itself).
 * Pure — safe to import from record-assembly code.
 * @param {string | null | undefined} siteId
 * @returns {string | null}
 */
export function siteLabel(siteId) {
  if (!siteId) return null;
  return SITE_NAMES[siteId] ?? siteId;
}

/**
 * Resolve whatever a manager typed for a site ("Park Place", "site-1", "PARK
 * place") to its internal siteId, so a broadcast finds the registered workers
 * whether the manager used the friendly name or the id. Falls back to the input
 * unchanged (assumed already an id) when nothing matches. Pure.
 * @param {string | null | undefined} input
 * @returns {string | null | undefined}
 */
export function resolveSiteId(input) {
  if (!input) return input;
  const needle = input.trim().toLowerCase();
  for (const [id, name] of Object.entries(SITE_NAMES)) {
    if (id.toLowerCase() === needle || name.toLowerCase() === needle) return id;
  }
  return input;
}

// Temporary in-memory stand-in for the `worker` table above. Lets the SMS
// issue-intake and safety-broadcast flows run end-to-end before DATABASE_URL is
// wired up. TODO: replace this array + the lookups below with real DB queries.
/** @type {Worker[]} */
const SEED_WORKERS = [
  // Live WhatsApp demo tester — the phone the end-to-end SMS/WhatsApp intake is
  // texted from, so the card + Procore RFI show a real reporter + site.
  {
    phone: '+17788837992',
    name: 'Warren Zhang',
    siteId: 'site-1',
    preferredLanguage: 'en',
  },
  // slackUserId maps a Slack user to a worker so the Slack-DM demo path resolves
  // a real reporter + site (the DM has no phone). Replace with a real DB column
  // in production. TODO: set this to your own Slack user id when demoing.
  {
    phone: '+15555550101',
    name: 'Mike Alvarez',
    slackUserId: 'U0BDLQZNN2Z',
    siteId: 'site-1',
    preferredLanguage: 'en',
  },
  { phone: '+15555550102', name: 'Sofia Reyes', siteId: 'site-1', preferredLanguage: 'es' },
  { phone: '+15555550103', name: 'Chen Wei', siteId: 'site-2', preferredLanguage: 'zh' },
];

// Temporary in-memory stand-ins for the `broadcast` and `broadcast_ack` tables.
// Track safety-broadcast acknowledgments so the live "X/Y acknowledged" Slack
// message can be kept up to date. TODO: replace with real DB rows via DATABASE_URL.
/** @type {Map<string, Broadcast>} */
const BROADCASTS = new Map();
/** @type {Set<string>} Keyed `${broadcastId}::${workerPhone}` so each ack counts once. */
const BROADCAST_ACKS = new Set();

/**
 * Reduce a phone number to bare digits so differently-formatted values compare
 * equal (e.g. "+1 (555) 555-0101" and "+15555550101"). Good enough for the seed
 * data; a real DB would store canonical E.164 and match on that directly.
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

/**
 * @param {string} phone
 * @returns {Promise<Worker | null>}
 */
export async function getWorkerByPhone(phone) {
  const target = normalizePhone(phone);
  return SEED_WORKERS.find((w) => normalizePhone(w.phone) === target) ?? null;
}

/**
 * @param {string} slackUserId
 * @returns {Promise<Worker | null>}
 */
export async function getWorkerBySlackUserId(slackUserId) {
  return SEED_WORKERS.find((w) => w.slackUserId === slackUserId) ?? null;
}

/**
 * Remember the language a worker actually communicates in (detected from their
 * intake messages), so later outbound messages to them — safety broadcasts,
 * assignment texts — go out in that language. Best-effort: unknown worker is a
 * no-op. TODO: persist to the worker row once DATABASE_URL is wired.
 * @param {string} phone - E.164.
 * @param {string} language - ISO 639-1 code.
 * @returns {Promise<void>}
 */
export async function setWorkerLanguage(phone, language) {
  if (!language) return;
  const worker = await getWorkerByPhone(phone);
  if (worker) worker.preferredLanguage = language;
}

/**
 * @param {string} siteId
 * @returns {Promise<Worker[]>}
 */
export async function getWorkersBySite(siteId) {
  return SEED_WORKERS.filter((w) => w.siteId === siteId);
}

/**
 * Create a broadcast record so its acknowledgments can be tracked.
 * @param {string} siteId
 * @param {string} message
 * @returns {Promise<Broadcast>}
 */
export async function createBroadcast(siteId, message) {
  const broadcast = { id: randomUUID(), siteId, message, createdAt: new Date().toISOString() };
  BROADCASTS.set(broadcast.id, broadcast);
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
  BROADCAST_ACKS.add(`${broadcastId}::${workerPhone}`);
}

/**
 * How many workers have acknowledged a broadcast, out of how many it was sent
 * to. Powers the live "X/Y acknowledged" Slack message.
 * @param {string} broadcastId
 * @returns {Promise<{ acknowledged: number, total: number }>}
 */
export async function getAckStatus(broadcastId) {
  const broadcast = BROADCASTS.get(broadcastId);
  const total = broadcast ? (await getWorkersBySite(broadcast.siteId)).length : 0;

  let acknowledged = 0;
  for (const key of BROADCAST_ACKS) {
    if (key.startsWith(`${broadcastId}::`)) acknowledged += 1;
  }
  return { acknowledged, total };
}

/**
 * Attach the Slack message (channel + ts) that displays a broadcast's live
 * acknowledgment count, so inbound acks can update that message later.
 * @param {string} broadcastId
 * @param {string} channel
 * @param {string} messageTs
 * @returns {Promise<void>}
 */
export async function setBroadcastMessage(broadcastId, channel, messageTs) {
  const broadcast = BROADCASTS.get(broadcastId);
  if (broadcast) {
    broadcast.channel = channel;
    broadcast.messageTs = messageTs;
  }
}

/**
 * Fetch a broadcast by id, including its Slack message ref if one was set.
 * @param {string} broadcastId
 * @returns {Promise<Broadcast | null>}
 */
export async function getBroadcast(broadcastId) {
  return BROADCASTS.get(broadcastId) ?? null;
}

/**
 * Find the broadcast a worker's inbound reply should be counted against: the
 * most recent broadcast for the site that worker is on. Used by the inbound-SMS
 * handler to turn a worker's "ok" into an acknowledgment on the right broadcast.
 * Iterates in insertion order (newest wins) so it doesn't depend on createdAt
 * timestamps, which can tie when two broadcasts are created in the same ms.
 * @param {string} phone - The replying worker's phone (any formatting).
 * @returns {Promise<Broadcast | null>}
 */
export async function getLatestBroadcastForPhone(phone) {
  const worker = await getWorkerByPhone(phone);
  if (!worker) return null;

  /** @type {Broadcast | null} */
  let latest = null;
  for (const broadcast of BROADCASTS.values()) {
    if (broadcast.siteId === worker.siteId) latest = broadcast;
  }
  return latest;
}

/**
 * Whether a specific worker has already acknowledged a broadcast. Powers the
 * escalation step, which voice-calls only the workers who have NOT acked.
 * @param {string} broadcastId
 * @param {string} workerPhone
 * @returns {Promise<boolean>}
 */
export async function hasAcked(broadcastId, workerPhone) {
  return BROADCAST_ACKS.has(`${broadcastId}::${workerPhone}`);
}
