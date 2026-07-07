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
// NOTE: an `image` block needs a publicly fetchable `image_url`. Twilio media
// URLs are auth-protected, so the caller must re-host / re-upload the photo
// before putting its URL here (see the design doc's photo caveat) — this builder
// just includes the block when given a usable URL.

/**
 * @typedef {import('./issue-record.js').IssueRecord} IssueRecord
 */

export const ISSUE_ASSIGN_ACTION = 'issue_assign';
export const ISSUE_ESCALATE_ACTION = 'issue_escalate';
export const ISSUE_RESOLVED_ACTION = 'issue_resolved';

/**
 * @param {IssueRecord} record
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildIssueCardBlocks(record) {
  const value = record.reporter.phone;

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
        { type: 'mrkdwn', text: `*Reported at:*\n${record.timestamp}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Description:*\n${record.description}` },
    },
  ];

  if (record.photoUrl) {
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
