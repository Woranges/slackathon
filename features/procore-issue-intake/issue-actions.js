// Owner: procore-issue-intake feature.
//
// Handlers for the management-card controls. Cards are stream-specific: a normal
// RFI card carries an Assign dropdown (+ Resolved), a safety card carries Escalate
// (+ Resolved). Each handler updates the card in place — removes the controls and
// appends a status line showing who acted — and sends the relevant SMS via
// lib/twilio.js#sendSms: Escalate/Resolved text the reporter, Assign texts the
// chosen worker. Resolved additionally posts a resolution reply on the Procore
// RFI. Every outbound side effect is best-effort (wrapped + logged) so a
// Twilio/Procore hiccup never breaks the interaction.

import { addRfiReply } from '../../agent/mcp/procore.js';
import { sendSms } from '../../lib/twilio.js';
import {
  ISSUE_ASSIGN_ACTION,
  ISSUE_ASSIGN_SELECT_ACTION,
  ISSUE_ESCALATE_ACTION,
  ISSUE_RESOLVED_ACTION,
} from './issue-card.js';

/**
 * Parse the button `value`, which carries the reporter phone + RFI id as JSON.
 * Tolerates a bare phone string (older cards) so old buttons don't break.
 * @param {string | undefined} raw
 * @returns {{ phone: string | undefined, rfiId: number | null }}
 */
function parseButtonValue(raw) {
  if (!raw) return { phone: undefined, rfiId: null };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return { phone: v.phone, rfiId: v.rfiId ?? null };
  } catch {
    // Not JSON — an older card whose value was the bare phone.
  }
  return { phone: raw, rfiId: null };
}

/**
 * Return a copy of the card blocks with the action buttons removed and a status
 * line appended. Pure.
 * @param {import('@slack/types').KnownBlock[] | undefined} blocks
 * @param {string} statusText - mrkdwn.
 * @returns {import('@slack/types').KnownBlock[]}
 */
export function applyIssueStatus(blocks, statusText) {
  const kept = (blocks ?? []).filter((b) => b.type !== 'actions');
  return [...kept, { type: 'context', elements: [{ type: 'mrkdwn', text: statusText }] }];
}

/**
 * @param {any} body
 * @returns {string}
 */
function actor(body) {
  const id = body?.user?.id;
  return id ? `<@${id}>` : 'a manager';
}

/**
 * Update the card message in place: new status line, no buttons.
 * @param {any} client
 * @param {any} body
 * @param {string} statusText - mrkdwn shown on the card.
 * @param {string} fallbackText - plain text for notifications (no mrkdwn/emoji markup).
 */
async function updateCard(client, body, statusText, fallbackText) {
  const channel = body?.channel?.id;
  const ts = body?.message?.ts;
  if (!channel || !ts) return;
  await client.chat.update({
    channel,
    ts,
    text: fallbackText,
    blocks: applyIssueStatus(body?.message?.blocks, statusText),
  });
}

/**
 * Text a phone (reporter or assignee); swallow (log) failures so a Twilio
 * stub/outage — or a recipient who never opted into the WhatsApp sandbox —
 * doesn't break the button interaction.
 * @param {string | undefined} phone
 * @param {string} message
 * @param {any} logger
 */
async function textPhone(phone, message, logger) {
  if (!phone) return;
  try {
    await sendSms(phone, message);
  } catch (e) {
    logger?.info?.(`SMS not sent (${phone}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Post a resolution note on the RFI; swallow (log) failures so a Procore
 * outage doesn't break the button interaction.
 * @param {number | null} rfiId
 * @param {string} note
 * @param {any} logger
 */
async function noteOnRfi(rfiId, note, logger) {
  if (!rfiId) return;
  try {
    // Mark it the official response — the recorded "resolution" on the RFI, since
    // Procore's API won't flip the status to closed (see addRfiReply).
    await addRfiReply(rfiId, note, { official: true });
  } catch (e) {
    logger?.info?.(`RFI reply not posted (#${rfiId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Build a button handler that updates the card and texts the reporter, and
 * optionally posts a note on the Procore RFI.
 * @param {string} label - e.g. "Assigned".
 * @param {string} emoji - Slack emoji shortcode prefix for the status line.
 * @param {string} smsMessage - What the reporter is texted.
 * @param {boolean} [postsRfiNote] - When true and the card carries an RFI id, post a reply on the RFI.
 */
function makeHandler(label, emoji, smsMessage, postsRfiNote = false) {
  /**
   * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
   * @returns {Promise<void>}
   */
  return async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const { phone, rfiId } = parseButtonValue(body.actions[0]?.value);
      await updateCard(client, body, `${emoji} *${label}* by ${actor(body)}`, `Issue ${label.toLowerCase()}`);
      await textPhone(phone, smsMessage, logger);
      if (postsRfiNote) {
        const today = new Date().toISOString().slice(0, 10);
        await noteOnRfi(rfiId, `Marked ${label.toLowerCase()} via Slack on ${today}.`, logger);
      }
    } catch (e) {
      logger.error(`Failed to handle issue ${label.toLowerCase()}: ${e}`);
    }
  };
}

export const handleIssueAssign = makeHandler(
  'Assigned',
  ':white_check_mark:',
  'Your reported issue has been assigned to the team.',
);

/**
 * Parse an Assign-dropdown option value (compact `{ p, n, r }` — phone, name, rfi id).
 * @param {string | undefined} raw
 * @returns {{ phone: string | undefined, name: string, rfiId: number | null }}
 */
function parseAssignValue(raw) {
  if (!raw) return { phone: undefined, name: 'the assigned worker', rfiId: null };
  try {
    const v = JSON.parse(raw);
    return { phone: v?.p, name: v?.n ?? 'the assigned worker', rfiId: v?.r ?? null };
  } catch {
    return { phone: undefined, name: 'the assigned worker', rfiId: null };
  }
}

/**
 * Handle the Assign dropdown (normal RFI cards): mark the card assigned to the
 * chosen worker and text that worker. Best-effort outbound, like every leg.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleIssueAssignSelect({ ack, body, client, logger }) {
  await ack();
  try {
    const action = /** @type {any} */ (body).actions?.[0];
    const { phone, name, rfiId } = parseAssignValue(action?.selected_option?.value);
    await updateCard(client, body, `:wrench: *Assigned to ${name}* by ${actor(body)}`, `Issue assigned to ${name}`);
    const detail = rfiId ? ` — RFI #${rfiId}` : '';
    await textPhone(
      phone,
      `You've been assigned a new field issue${detail}. Please review the details in Procore and follow up.`,
      logger,
    );
  } catch (e) {
    logger.error(`Failed to handle issue assign-select: ${e}`);
  }
}
export const handleIssueEscalate = makeHandler(
  'Escalated',
  ':rotating_light:',
  'Your reported issue has been escalated for urgent attention.',
);
export const handleIssueResolved = makeHandler(
  'Resolved',
  ':ballot_box_with_check:',
  'Your reported issue has been marked resolved. Thank you.',
  true,
);

export { ISSUE_ASSIGN_ACTION, ISSUE_ASSIGN_SELECT_ACTION, ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION };
