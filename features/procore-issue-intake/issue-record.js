// Owner: procore-issue-intake feature.
//
// Pure assembly of the structured issue record from the pieces gathered during
// intake (worker lookup + the LLM-extracted area/description + inbound photo).
// No I/O here — the caller resolves the Worker (lib/db.js#getWorkerByPhone) and
// translation (lib/translate.js) first, then hands the parts in. Kept pure so it
// stays trivially unit-testable and free of Slack/DB/Twilio dependencies.

import { siteLabel } from '../../lib/db.js';

/**
 * @typedef {import('../../lib/db.js').Worker} Worker
 */

/**
 * @typedef {Object} Geotag
 * @property {number} lat
 * @property {number} lng
 */

/**
 * @typedef {'safety' | 'rfi'} ReportType
 * @typedef {Object} IssueRecord
 * @property {{ name: string, phone: string }} reporter - `name` may be a Slack
 *   mention (`<@U…>`) on the DM path, which renders as the user's name.
 * @property {string | null} siteId
 * @property {string | null} siteName - Human-readable site name for display (e.g. "Park Place").
 * @property {string} area
 * @property {string} description - Expected already translated to English by the caller.
 * @property {ReportType} [reportType] - Which intake stream produced this (safety vs rfi).
 * @property {string | null} [severity] - Safety only: immediate_danger | urgent | normal.
 * @property {string | null} [specReference] - RFI only: a drawing/spec/detail reference.
 * @property {string | null} photoUrl - External photo URL (e.g. a Twilio media URL).
 * @property {string | null} photoSlackFileId - Slack file id for a photo already
 *   hosted in Slack (e.g. uploaded in a DM); preferred over photoUrl for rendering.
 * @property {Geotag | null} geotag
 * @property {string} timestamp - ISO 8601 string.
 */

/**
 * Assemble the structured issue record.
 * @param {Object} params
 * @param {string} params.phone - Reporter's phone (E.164), from the inbound SMS `From`.
 * @param {Worker | null} [params.worker] - Resolved via getWorkerByPhone/SlackUserId; null if unknown.
 * @param {string} [params.slackUserId] - Reporter's Slack user id (DM path); used as a
 *   `<@…>` mention for the name when no worker record is found.
 * @param {string} params.area
 * @param {string} params.description
 * @param {ReportType} [params.reportType]
 * @param {string | null} [params.severity]
 * @param {string | null} [params.specReference]
 * @param {string | null} [params.photoUrl]
 * @param {string | null} [params.photoSlackFileId]
 * @param {Geotag | null} [params.geotag]
 * @param {Date | string | number} [params.timestamp] - Defaults to now.
 * @returns {IssueRecord}
 */
export function buildIssueRecord({
  phone,
  worker = null,
  slackUserId,
  area,
  description,
  reportType = 'rfi',
  severity = null,
  specReference = null,
  photoUrl = null,
  photoSlackFileId = null,
  geotag = null,
  timestamp = new Date(),
}) {
  const at = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const name = worker?.name ?? (slackUserId ? `<@${slackUserId}>` : 'Unknown worker');

  return {
    reporter: { name, phone },
    siteId: worker?.siteId ?? null,
    siteName: siteLabel(worker?.siteId),
    area,
    description,
    reportType,
    severity,
    specReference,
    photoUrl,
    photoSlackFileId,
    geotag,
    timestamp: at.toISOString(),
  };
}
