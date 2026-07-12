// Owner: safety-broadcast feature.
//
// Inbound Twilio webhook — worker SMS replies land here (issue reports,
// broadcast acknowledgments). Served by a small HTTP listener that runs inside
// app.js (Socket Mode) — see listeners/webhooks/startTwilioWebhookServer — so
// inbound acks share the same in-memory store as the Slack button handlers that
// create broadcasts. (app-oauth.js mounts the same handler on its Express
// receiver for the OAuth/HTTP deployment.)
//
// Reply classification is LLM-driven rather than exact-string matching
// ("OK") — real replies vary ("got it", "yes", "👍", "roger"), and a rigid
// match would miss most of them.

import {
  getAckStatus,
  getBroadcastAudit,
  getLatestBroadcastForPhone,
  recordBroadcastAck,
  siteLabel,
} from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { postIssueCard } from '../procore-issue-intake/issue-card.js';
import { advanceIssueIntake, hasActiveFlow } from '../procore-issue-intake/issue-intake.js';
import { formatBroadcastStatus } from './broadcast-safety.js';

// Issue-intake conversations over SMS are keyed by phone number; this stands in
// for the Slack thread key that the same flow uses in the DM path.
const SMS_THREAD = 'sms';

// Twilio re-delivers a webhook if we don't respond within its timeout (~15s), and
// this handler makes LLM calls that can approach that — so a slow message gets
// retried and would otherwise be processed twice (duplicate cards/RFIs). Track
// the message SIDs we've already accepted and ignore repeats. In-memory is fine:
// retries arrive within minutes, and a process restart only risks re-processing a
// message that was in flight across the restart.
/** @type {Set<string>} */
const processedMessageSids = new Set();

/**
 * @param {string | undefined} sid
 * @returns {boolean} true if this SID was already handled (caller should skip).
 */
function isDuplicate(sid) {
  if (!sid) return false;
  if (processedMessageSids.has(sid)) return true;
  processedMessageSids.add(sid);
  // Bound memory — these are throwaway once their retry window has passed.
  if (processedMessageSids.size > 1000) processedMessageSids.clear();
  return false;
}

const CLASSIFY_SYSTEM_PROMPT = `\
Classify an incoming worker SMS reply to a construction site. Always call classify_reply — \
never respond in plain text.

- "acknowledgment": the worker is confirming they received/understood a safety alert \
  (e.g. "ok", "got it", "yes", "roger", "👍", "on it").
- "issue_report": the worker is starting a new report of ANY kind that should be logged — \
  a site problem, a safety hazard, OR a field question / RFI needing an answer from the \
  office (e.g. "there's a leak on 4", "I need clarification on the door schedule", \
  "who approved this detail?"). Anything that isn't just an acknowledgment or small talk.
- "other": greetings, small talk, or noise that doesn't start a report and isn't an ack.`;

/**
 * @param {(intent: 'acknowledgment' | 'issue_report' | 'other') => void} onClassified
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
function createClassifyReplyTool(onClassified) {
  return {
    functionDeclaration: {
      name: 'classify_reply',
      description: 'Classify the incoming worker SMS reply.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: ['acknowledgment', 'issue_report', 'other'] },
        },
        required: ['intent'],
      },
    },
    handler: async (args) => {
      onClassified(/** @type {'acknowledgment' | 'issue_report' | 'other'} */ (args.intent));
      return { output: 'Classified.' };
    },
  };
}

/**
 * @param {string} text
 * @returns {Promise<'acknowledgment' | 'issue_report' | 'other'>}
 */
async function classifyReply(text) {
  /** @type {'acknowledgment' | 'issue_report' | 'other'} */
  let intent = 'other';
  const tool = createClassifyReplyTool((classified) => {
    intent = classified;
  });

  await runLlmTurn({ systemPrompt: CLASSIFY_SYSTEM_PROMPT, history: [], text, tools: [tool] });
  return intent;
}

/**
 * Turn a worker's acknowledgment reply into a recorded ack and a live scoreboard
 * update. Finds the most recent broadcast for the worker's site, records the ack
 * against it, and rewrites the "X/Y acknowledged" Slack message with the new
 * count. Returns the matched broadcast, or null if the phone maps to no known
 * worker or open broadcast.
 * @param {string | undefined} from - The replying worker's phone (E.164).
 * @param {import('@slack/web-api').WebClient} client
 * @returns {Promise<import('../../lib/db.js').Broadcast | null>}
 */
export async function recordAckAndUpdateScoreboard(from, client) {
  if (!from) return null;

  const broadcast = await getLatestBroadcastForPhone(from);
  if (!broadcast) return null;

  await recordBroadcastAck(broadcast.id, from);

  // Only touch Slack if this broadcast actually has a posted scoreboard message
  // (it won't in HTTP-only edge cases where the original postMessage failed).
  if (broadcast.channel && broadcast.messageTs) {
    await client.chat.update({
      channel: broadcast.channel,
      ts: broadcast.messageTs,
      text: formatBroadcastStatus({
        site: siteLabel(broadcast.siteId) ?? broadcast.siteId,
        message: broadcast.message,
        rows: await getBroadcastAudit(broadcast.id),
      }),
    });
  }

  return broadcast;
}

/**
 * Escape text for inclusion in a TwiML XML body.
 * @param {string} s
 * @returns {string}
 */
function escapeXml(s) {
  return String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );
}

/**
 * Advance the issue-intake flow for this phone and reply over SMS. Posts the
 * management card once the issue is filed.
 * @param {string} from - Reporter phone (E.164).
 * @param {string} body - The inbound message text.
 * @param {string | null} photoUrl - Twilio MediaUrl0, if any.
 * @param {import('@slack/web-api').WebClient} client
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function runIssueIntake(from, body, photoUrl, client, res) {
  // The intake engine tracks the photo in code, so a photo-only message (empty
  // Body) just passes empty text and gets latched via photoUrl — no hint needed.
  const { reply, done, record, rfi } = await advanceIssueIntake(from, SMS_THREAD, body, { phone: from, photoUrl });
  if (done && record) await postIssueCard(client, record, rfi);
  res
    .status(200)
    .type('text/xml')
    .send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('@slack/web-api').WebClient} client - Bot client, for posting the issue card.
 * @returns {Promise<void>}
 */
export async function handleTwilioInboundSms(req, res, client) {
  // Ignore Twilio's retry re-deliveries of a message we've already accepted.
  if (isDuplicate(req.body?.MessageSid ?? req.body?.SmsMessageSid)) {
    res.status(200).type('text/xml').send('<Response></Response>');
    return;
  }

  // Twilio prefixes WhatsApp senders with "whatsapp:"; strip it so the value is a
  // clean E.164 for worker lookup, the flow key, and the card/RFI (SMS has no prefix).
  const from = (req.body?.From ?? '').replace(/^whatsapp:/i, '') || null;
  const body = req.body?.Body ?? '';
  const photoUrl = req.body?.MediaUrl0 ?? null;

  try {
    // An in-progress issue-intake conversation for this phone takes precedence
    // over reply classification — keep advancing it until the issue is filed.
    if (from && hasActiveFlow(from, SMS_THREAD)) {
      await runIssueIntake(from, body, photoUrl, client, res);
      return;
    }

    const intent = await classifyReply(body);

    if (intent === 'acknowledgment') {
      // Record the ack against the worker's latest broadcast and bump the live
      // "X/Y acknowledged" scoreboard. Log the outcome for demo visibility.
      const broadcast = await recordAckAndUpdateScoreboard(from, client);
      if (broadcast) {
        const { acknowledged, total } = await getAckStatus(broadcast.id);
        console.log(`[ack] ${from} acknowledged broadcast ${broadcast.id} — now ${acknowledged}/${total}`);
      } else {
        console.log(`[ack] "${body}" from ${from}: no active broadcast matched`);
      }
    } else if (intent === 'issue_report' && from) {
      await runIssueIntake(from, body, photoUrl, client, res);
      return;
    }
    // "other" — no action; TODO: consider a fallback reply if this happens often.

    res.status(200).type('text/xml').send('<Response></Response>');
  } catch (e) {
    console.error(`Failed to handle inbound SMS: ${e}`);
    // Always return valid TwiML so Twilio doesn't retry a hard failure.
    res.status(200).type('text/xml').send('<Response></Response>');
  }
}
