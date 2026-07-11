// Owner: procore-issue-intake feature.
//
// Handlers for the management-card buttons (Assign / Escalate / Resolved). Each
// updates the card in place — removes the buttons and appends a status line
// showing who acted — and texts the reporter back via lib/twilio.js#sendSms.
// Resolved additionally posts a resolution reply on the Procore RFI. Every
// outbound side effect is best-effort (wrapped + logged) so a Twilio/Procore
// hiccup never breaks the button interaction.

import { addRfiReply } from '../../agent/mcp/procore.js';
import { sendSms } from '../../lib/twilio.js';
import { ISSUE_ASSIGN_ACTION, ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION } from './issue-card.js';

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
 * Text the reporter; swallow (log) failures so a Twilio stub/outage doesn't
 * break the button interaction.
 * @param {string | undefined} phone
 * @param {string} message
 * @param {any} logger
 */
async function textReporter(phone, message, logger) {
  if (!phone) return;
  try {
    await sendSms(phone, message);
  } catch (e) {
    logger?.info?.(`Reporter SMS not sent (${phone}): ${e instanceof Error ? e.message : String(e)}`);
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
    await addRfiReply(rfiId, note);
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
      await textReporter(phone, smsMessage, logger);
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

export { ISSUE_ASSIGN_ACTION, ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION };
