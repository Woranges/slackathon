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
// Escalate reuses the safety-broadcast feature's fan-out (its owner's code,
// exported for exactly this): escalating a safety card sends the same site-wide
// alert + live ack scoreboard the /broadcast-safety command does.
import { broadcastToSite } from '../safety-broadcast/broadcast-safety.js';
import {
  ISSUE_ASSIGN_ACTION,
  ISSUE_ASSIGN_SELECT_ACTION,
  ISSUE_ESCALATE_ACTION,
  ISSUE_RESOLVED_ACTION,
} from './issue-card.js';

/**
 * Parse the button `value`, which carries the reporter phone + RFI id + site id
 * as JSON. Tolerates a bare phone string (older cards) so old buttons don't break.
 * @param {string | undefined} raw
 * @returns {{ phone: string | undefined, rfiId: number | null, siteId: string | null }}
 */
function parseButtonValue(raw) {
  if (!raw) return { phone: undefined, rfiId: null, siteId: null };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return { phone: v.phone, rfiId: v.rfiId ?? null, siteId: v.siteId ?? null };
  } catch {
    // Not JSON — an older card whose value was the bare phone.
  }
  return { phone: raw, rfiId: null, siteId: null };
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
 * Pull a `*Label:*\nvalue` field out of the card's blocks (section text or the
 * fields array). Returns null when the label isn't present.
 * @param {any[] | undefined} blocks
 * @param {string} label - e.g. "Area" (without the surrounding markup).
 * @returns {string | null}
 */
function cardField(blocks, label) {
  const prefix = `*${label}:*`;
  for (const b of blocks ?? []) {
    if (b?.type !== 'section') continue;
    for (const el of [b.text, ...(b.fields ?? [])]) {
      const t = el?.text;
      if (typeof t === 'string' && t.startsWith(prefix)) return t.slice(prefix.length).trim();
    }
  }
  return null;
}

/**
 * Extract the Procore RFI URL from the card's link context block, if present.
 * @param {any[] | undefined} blocks
 * @returns {string | null}
 */
function cardRfiUrl(blocks) {
  for (const b of blocks ?? []) {
    if (b?.type !== 'context') continue;
    for (const el of b.elements ?? []) {
      const m = typeof el?.text === 'string' ? el.text.match(/<(https?:\/\/[^|>]+)\|[^>]*RFI/) : null;
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Compose the SMS an assignee receives, pulling the real issue details out of the
 * card blocks (the dropdown option value is too small to carry them). Pure.
 * @param {any[] | undefined} blocks - The card's blocks (from body.message.blocks).
 * @param {number | null} rfiId
 * @returns {string}
 */
export function buildAssignmentMessage(blocks, rfiId) {
  const area = cardField(blocks, 'Area');
  const description = cardField(blocks, 'Description');
  const site = cardField(blocks, 'Site');
  const url = cardRfiUrl(blocks);
  const lines = [
    `🔧 You've been assigned a new RFI${rfiId ? ` (#${rfiId})` : ''}${site ? ` at ${site}` : ''}.`,
    area ? `Area: ${area}` : null,
    description ? `Issue: ${description}` : null,
    url ? `Details: ${url}` : 'Please review the details in Procore and follow up.',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Handle the Assign dropdown (normal RFI cards): mark the card assigned to the
 * chosen worker and text that worker with the issue details. Best-effort
 * outbound, like every leg.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleIssueAssignSelect({ ack, body, client, logger }) {
  await ack();
  try {
    const action = /** @type {any} */ (body).actions?.[0];
    const { phone, name, rfiId } = parseAssignValue(action?.selected_option?.value);
    await updateCard(client, body, `:wrench: *Assigned to ${name}* by ${actor(body)}`, `Issue assigned to ${name}`);
    const message = buildAssignmentMessage(/** @type {any} */ (body).message?.blocks, rfiId);
    await textPhone(phone, message, logger);
  } catch (e) {
    logger.error(`Failed to handle issue assign-select: ${e}`);
  }
}
/**
 * Compose the site-wide safety alert sent when a safety card is escalated,
 * pulling the hazard details out of the card blocks. Pure.
 * @param {any[] | undefined} blocks
 * @returns {string}
 */
export function buildEscalationBroadcast(blocks) {
  const area = cardField(blocks, 'Area');
  const description = cardField(blocks, 'Description');
  const site = cardField(blocks, 'Site');
  const severity = cardField(blocks, 'Severity');
  const lines = [
    `🚨 SAFETY ALERT${site ? ` — ${site}` : ''}${severity ? ` (${severity})` : ''}`,
    area ? `Location: ${area}` : null,
    description ? `Hazard: ${description}` : null,
    'Reply to confirm you have seen this.',
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Handle the Escalate button (safety cards): fan a site-wide safety alert out to
 * every worker and post the live acknowledgment scoreboard, then stamp the card.
 * The broadcast is wrapped so a Twilio/Slack hiccup still lets the card update.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleIssueEscalate({ ack, body, client, logger }) {
  await ack();
  try {
    const { siteId } = parseButtonValue(body.actions[0]?.value);
    const channel = /** @type {any} */ (body).channel?.id;
    const message = buildEscalationBroadcast(/** @type {any} */ (body).message?.blocks);

    let note = 'safety broadcast skipped (no site on record)';
    if (siteId) {
      try {
        const { sent, total } = await broadcastToSite({ site: siteId, message, client, channel });
        note = total > 0 ? `site-wide safety alert sent (${sent}/${total})` : 'no workers registered for this site';
      } catch (e) {
        note = 'safety broadcast failed to send';
        logger?.info?.(`Escalation broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await updateCard(client, body, `:rotating_light: *Escalated* by ${actor(body)} — ${note}`, 'Issue escalated');
  } catch (e) {
    logger.error(`Failed to handle issue escalate: ${e}`);
  }
}
export const handleIssueResolved = makeHandler(
  'Resolved',
  ':ballot_box_with_check:',
  'Your reported issue has been marked resolved. Thank you.',
  true,
);

export { ISSUE_ASSIGN_ACTION, ISSUE_ASSIGN_SELECT_ACTION, ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION };
