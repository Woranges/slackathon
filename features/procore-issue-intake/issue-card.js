// Owner: procore-issue-intake feature.
//
// Builds the Block Kit card posted to the management channel when a worker files
// an issue (structured fields + optional inline photo + Assign/Escalate/Resolved
// buttons). Pure function returning blocks — the actual client.chat.postMessage
// call is wired separately, so this stays unit-testable with no Slack client.
//
// The three buttons carry the reporter's phone as their `value` so the action
// handlers can text the worker back without a lookup. Once issues are persisted
// (and get a Procore/DB id), switch `value` to that id and look the record up.
//
// Photos: a texted photo's Twilio media URL is auth-protected, so it can't be
// rendered via a plain image_url. postIssueCard() re-uploads it to Slack (see
// issue-photo.js) and passes the resulting file id here, which renders inline
// via `slack_file`. When only a public image_url is available (or the re-upload
// fails), the builder falls back to image_url.

import { uploadPhotoToSlack } from './issue-photo.js';

/**
 * @typedef {import('./issue-record.js').IssueRecord} IssueRecord
 */

export const ISSUE_ASSIGN_ACTION = 'issue_assign';
export const ISSUE_ESCALATE_ACTION = 'issue_escalate';
export const ISSUE_RESOLVED_ACTION = 'issue_resolved';

/**
 * @param {IssueRecord} record
 * @param {{ slackFileId?: string | null }} [opts] - A Slack file id to render the
 *   photo inline via `slack_file`; falls back to record.photoUrl when absent.
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildIssueCardBlocks(record, opts = {}) {
  const value = record.reporter.phone;
  // Render the timestamp in each viewer's own locale/timezone via Slack's date
  // token, falling back to the raw ISO string in clients that can't format it.
  const reportedAtUnix = Math.floor(new Date(record.timestamp).getTime() / 1000);
  const reportedAt = `<!date^${reportedAtUnix}^{date_short_pretty} at {time}|${record.timestamp}>`;

  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':construction: New site issue', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Area:*\n${record.area}` },
        { type: 'mrkdwn', text: `*Reported by:*\n${record.reporter.name}` },
        { type: 'mrkdwn', text: `*Site:*\n${record.siteId ?? '—'}` },
        { type: 'mrkdwn', text: `*Reported at:*\n${reportedAt}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Description:*\n${record.description}` },
    },
  ];

  if (opts.slackFileId) {
    blocks.push(
      /** @type {import('@slack/types').ImageBlock} */ ({
        type: 'image',
        slack_file: { id: opts.slackFileId },
        alt_text: 'Photo of the reported issue',
      }),
    );
  } else if (record.photoUrl) {
    blocks.push({
      type: 'image',
      image_url: record.photoUrl,
      alt_text: 'Photo of the reported issue',
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Assign' },
        style: 'primary',
        action_id: ISSUE_ASSIGN_ACTION,
        value,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Escalate' },
        style: 'danger',
        action_id: ISSUE_ESCALATE_ACTION,
        value,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Resolved' },
        action_id: ISSUE_RESOLVED_ACTION,
        value,
      },
    ],
  });

  return blocks;
}

/**
 * Post the issue card to the management channel. Reads MANAGEMENT_CHANNEL_ID at
 * call time and skips gracefully (no throw) when it isn't set, so the intake
 * flow still completes without a channel configured.
 * @param {import('@slack/web-api').WebClient} client
 * @param {IssueRecord} record
 * @returns {Promise<{ posted: boolean, channel?: string, ts?: string, reason?: string }>}
 */
export async function postIssueCard(client, record) {
  const channel = process.env.MANAGEMENT_CHANNEL_ID;
  if (!channel) return { posted: false, reason: 'MANAGEMENT_CHANNEL_ID not set' };

  // Prefer a photo already hosted in Slack (uploaded in a DM); otherwise
  // re-upload an external URL (e.g. a Twilio media URL, which is auth-protected).
  // Best-effort — a null id just omits the inline image.
  const slackFileId =
    record.photoSlackFileId ?? (record.photoUrl ? await uploadPhotoToSlack(client, record.photoUrl) : null);

  const res = await client.chat.postMessage({
    channel,
    // Fallback text shown in notifications / clients that can't render blocks.
    text: `New site issue reported: ${record.area}`,
    blocks: buildIssueCardBlocks(record, { slackFileId }),
  });
  return { posted: true, channel, ts: /** @type {string} */ (res.ts) };
}
