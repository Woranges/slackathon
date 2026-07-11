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
 * @property {string} phone - E.164 format (e.g. "+14155552671").
 * @property {string} [name] - Display name, e.g. for "Assigned to Mike" replies.
 * @property {string} [slackUserId]
 * @property {string} siteId
 * @property {string} preferredLanguage - ISO 639-1 code.
 */

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
 * @param {string} siteId
 * @returns {Promise<Worker[]>}
 */
export async function getWorkersBySite(siteId) {
  return SEED_WORKERS.filter((w) => w.siteId === siteId);
}

/**
 * @param {string} broadcastId
 * @param {string} workerPhone
 * @returns {Promise<void>}
 */
export async function recordBroadcastAck(broadcastId, workerPhone) {
  // DB not wired yet — degrade to a logged no-op instead of throwing, so an
  // acknowledgment-classified SMS doesn't crash the inbound handler. TODO:
  // persist to the broadcast_ack table once DATABASE_URL is wired.
  console.warn(`[db] recordBroadcastAck stub: ack from ${workerPhone} for broadcast ${broadcastId} (not persisted)`);
}
