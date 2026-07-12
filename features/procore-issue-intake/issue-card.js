// Owner: procore-issue-intake feature.
//
// Builds the Block Kit card posted to the management channel when a worker files
// an issue (structured fields + Assign/Escalate/Resolved buttons). Pure function
// returning blocks — the actual client.chat.postMessage call is wired separately,
// so this stays unit-testable with no Slack client.
//
// Buttons are stream-specific: a SAFETY card gets Escalate (urgent attention),
// a normal RFI card gets Assign (hand it to a specific worker); both get
// Resolved. Escalate/Resolved buttons carry the reporter's phone + RFI id as
// their `value` so the handlers can text the reporter / note the RFI without a
// lookup. Assign is a worker-picker dropdown whose option values carry the
// chosen worker's phone + name, so the handler texts *that* worker (best-effort,
// like every outbound leg). When the directory has no textable workers, Assign
// falls back to a plain button that just marks the card assigned.
//
// Photos are NOT rendered inline in the card: Slack won't render a `slack_file`
// reference to a freshly bot-uploaded file, and `image_url` can't fetch the
// auth-protected DM/Twilio source URLs. Instead postIssueCard() posts the photo
// as a reply in the card's thread (see issue-photo.js#postPhotoReply), and the
// card shows a "photo attached in thread" hint when a photo is present.

import { getWorkersBySite } from '../../lib/db.js';
import { postPhotoReply } from './issue-photo.js';

/**
 * @typedef {import('./issue-record.js').IssueRecord} IssueRecord
 */

export const ISSUE_ASSIGN_ACTION = 'issue_assign';
export const ISSUE_ASSIGN_SELECT_ACTION = 'issue_assign_select';
export const ISSUE_ESCALATE_ACTION = 'issue_escalate';
export const ISSUE_RESOLVED_ACTION = 'issue_resolved';

/**
 * @typedef {{ name?: string, phone: string }} Assignee - A worker who can be assigned an RFI (must have a phone to text).
 */

/**
 * @param {IssueRecord} record
 * @param {{ id: number, url: string | null } | null} [rfi] - The created Procore RFI, if any.
 * @param {Assignee[]} [assignees] - Textable workers offered in the Assign dropdown (RFI cards only).
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function buildIssueCardBlocks(record, rfi = null, assignees = []) {
  // Escalate/Resolved carry the reporter phone + the RFI id (so the handlers can
  // text the reporter and reply on the RFI) plus the site id (so Escalate can fan
  // a safety broadcast out to the whole site) without any lookup.
  const value = JSON.stringify({ phone: record.reporter.phone, rfiId: rfi?.id ?? null, siteId: record.siteId ?? null });
  const isSafety = record.reportType === 'safety';
  // Render the timestamp in each viewer's own locale/timezone via Slack's date
  // token, falling back to the raw ISO string in clients that can't format it.
  // `{date_long}` gives weekday + full date (e.g. "Wednesday, July 8th, 2026")
  // and never collapses to "today"/"tomorrow" the way `{date_*_pretty}` does.
  const reportedAtUnix = Math.floor(new Date(record.timestamp).getTime() / 1000);
  const reportedAt = `<!date^${reportedAtUnix}^{date_long} at {time}|${record.timestamp}>`;

  /** @type {{ type: 'mrkdwn', text: string }[]} */
  const fields = [
    { type: 'mrkdwn', text: `*Area:*\n${record.area}` },
    { type: 'mrkdwn', text: `*Reported by:*\n${record.reporter.name}` },
    { type: 'mrkdwn', text: `*Site:*\n${record.siteName ?? record.siteId ?? '—'}` },
    { type: 'mrkdwn', text: `*Reported at:*\n${reportedAt}` },
  ];
  if (isSafety) fields.push({ type: 'mrkdwn', text: `*Severity:*\n${record.severity ?? '—'}` });
  else if (record.specReference) fields.push({ type: 'mrkdwn', text: `*Reference:*\n${record.specReference}` });

  /** @type {import('@slack/types').KnownBlock[]} */
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: isSafety ? ':rotating_light: Safety report' : ':construction: New RFI',
        emoji: true,
      },
    },
    { type: 'section', fields },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Description:*\n${record.description}` },
    },
  ];

  // Link the Procore RFI if it was created.
  if (rfi) {
    const link = rfi.url ? `<${rfi.url}|RFI #${rfi.id}>` : `RFI #${rfi.id}`;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:page_facing_up: Procore ${link}` }] });
  }

  // Photo lives in the card's thread (see file header); surface a hint so it's
  // easy to find.
  if (record.photoSlackFileId || record.photoUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':camera_with_flash: Photo attached in thread' }],
    });
  }

  /** @type {any[]} */
  const elements = [];
  if (isSafety) {
    // Safety cards: Escalate (urgent attention) — not Assign.
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Escalate' },
      style: 'danger',
      action_id: ISSUE_ESCALATE_ACTION,
      value,
    });
  } else if (assignees.length > 0) {
    // Normal RFI cards: a worker-picker so the handler can text the chosen worker.
    elements.push({
      type: 'static_select',
      placeholder: { type: 'plain_text', text: 'Assign to…' },
      action_id: ISSUE_ASSIGN_SELECT_ACTION,
      options: assignees.slice(0, 100).map((w) => ({
        text: { type: 'plain_text', text: (w.name ?? w.phone).slice(0, 75) },
        // Keep the value compact (Slack caps option values at 75 chars): phone,
        // name, rfi id — enough to text the worker and update the card.
        value: JSON.stringify({ p: w.phone, n: (w.name ?? w.phone).slice(0, 40), r: rfi?.id ?? null }),
      })),
    });
  } else {
    // No textable workers in the directory — plain Assign that just marks the card.
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Assign' },
      style: 'primary',
      action_id: ISSUE_ASSIGN_ACTION,
      value,
    });
  }
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Resolved' },
    action_id: ISSUE_RESOLVED_ACTION,
    value,
  });
  blocks.push({ type: 'actions', elements });

  return blocks;
}

/**
 * Post the issue card to the management channel. Reads MANAGEMENT_CHANNEL_ID at
 * call time and skips gracefully (no throw) when it isn't set, so the intake
 * flow still completes without a channel configured.
 * @param {import('@slack/web-api').WebClient} client
 * @param {IssueRecord} record
 * @param {{ id: number, url: string | null } | null} [rfi] - The created Procore RFI, if any.
 * @returns {Promise<{ posted: boolean, channel?: string, ts?: string, reason?: string }>}
 */
export async function postIssueCard(client, record, rfi = null) {
  const channel = process.env.MANAGEMENT_CHANNEL_ID;
  if (!channel) return { posted: false, reason: 'MANAGEMENT_CHANNEL_ID not set' };

  // Fallback text shown in notifications / clients that can't render blocks — and,
  // just as importantly, the ONLY text the Real-Time Search API can index for this
  // card (the structured fields live in blocks, which RTS doesn't read). So make it
  // a self-contained summary: type, site, area, and description all searchable.
  const label = record.reportType === 'safety' ? 'Safety report' : 'RFI';
  const site = record.siteName ?? record.siteId;
  const text = `New ${label}${site ? ` at ${site}` : ''}: ${record.area}. ${record.description}`;

  // For a normal RFI, offer the site's textable workers in the Assign dropdown.
  // Best-effort: a directory lookup failure must not block posting the card.
  /** @type {import('./issue-card.js').Assignee[]} */
  let assignees = [];
  if (record.reportType !== 'safety' && record.siteId) {
    try {
      assignees = (await getWorkersBySite(record.siteId)).filter((w) => Boolean(w.phone));
    } catch {
      assignees = [];
    }
  }

  const res = await client.chat.postMessage({ channel, text, blocks: buildIssueCardBlocks(record, rfi, assignees) });
  const ts = /** @type {string} */ (res.ts);

  // Attach the photo as a reply in the card's thread (best-effort; see
  // issue-photo.js for why it isn't an inline block).
  if (record.photoSlackFileId || record.photoUrl) {
    await postPhotoReply(client, record, channel, ts);
  }

  return { posted: true, channel, ts };
}
