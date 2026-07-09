// Owner: procore-issue-intake feature.
//
// Handlers for the management-card buttons (Assign / Escalate / Resolved). Each
// updates the card in place — removes the buttons and appends a status line
// showing who acted — and texts the reporter back. The SMS goes through the
// shared lib/twilio.js#sendSms, which is currently a stub that throws, so the
// call is wrapped and its failure logged (not surfaced) until Twilio is wired.

import { sendSms } from '../../lib/twilio.js';
import { ISSUE_ASSIGN_ACTION, ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION } from './issue-card.js';

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
 * Build a button handler that updates the card and texts the reporter.
 * @param {string} label - e.g. "Assigned".
 * @param {string} emoji - Slack emoji shortcode prefix for the status line.
 * @param {string} smsMessage - What the reporter is texted.
 */
function makeHandler(label, emoji, smsMessage) {
  /**
   * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
   * @returns {Promise<void>}
   */
  return async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const phone = body.actions[0]?.value;
      await updateCard(client, body, `${emoji} *${label}* by ${actor(body)}`, `Issue ${label.toLowerCase()}`);
      await textReporter(phone, smsMessage, logger);
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
);

export { ISSUE_ASSIGN_ACTION, ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION };
