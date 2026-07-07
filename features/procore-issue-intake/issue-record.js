// Owner: procore-issue-intake feature.
//
// Pure assembly of the structured issue record from the pieces gathered during
// intake (worker lookup + the LLM-extracted area/description + inbound photo).
// No I/O here — the caller resolves the Worker (lib/db.js#getWorkerByPhone) and
// translation (lib/translate.js) first, then hands the parts in. Kept pure so it
// stays trivially unit-testable and free of Slack/DB/Twilio dependencies.

/**
 * @typedef {import('../../lib/db.js').Worker} Worker
 */

/**
 * @typedef {Object} Geotag
 * @property {number} lat
 * @property {number} lng
 */

/**
 * @typedef {Object} IssueRecord
 * @property {{ name: string, phone: string }} reporter
 * @property {string | null} siteId
 * @property {string} area
 * @property {string} description - Expected already translated to English by the caller.
 * @property {string | null} photoUrl
 * @property {Geotag | null} geotag
 * @property {string} timestamp - ISO 8601 string.
 */

/**
 * Assemble the structured issue record.
 * @param {Object} params
 * @param {string} params.phone - Reporter's phone (E.164), from the inbound SMS `From`.
 * @param {Worker | null} [params.worker] - Resolved via getWorkerByPhone; null if unknown.
 * @param {string} params.area
 * @param {string} params.description
 * @param {string | null} [params.photoUrl]
 * @param {Geotag | null} [params.geotag]
 * @param {Date | string | number} [params.timestamp] - Defaults to now.
 * @returns {IssueRecord}
 */
export function buildIssueRecord({
  phone,
  worker = null,
  area,
  description,
  photoUrl = null,
  geotag = null,
  timestamp = new Date(),
}) {
  const at = timestamp instanceof Date ? timestamp : new Date(timestamp);

  return {
    reporter: { name: worker?.name ?? 'Unknown worker', phone },
    siteId: worker?.siteId ?? null,
    area,
    description,
    photoUrl,
    geotag,
    timestamp: at.toISOString(),
  };
}
