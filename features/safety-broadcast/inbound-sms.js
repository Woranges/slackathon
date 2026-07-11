// Owner: safety-broadcast feature.
//
// Inbound Twilio webhook — worker SMS replies land here (issue reports,
// broadcast acknowledgments). Only reachable when running in HTTP mode
// (app-oauth.js), since Socket Mode (app.js) exposes no inbound HTTP endpoint.
//
// Reply classification is LLM-driven rather than exact-string matching
// ("OK") — real replies vary ("got it", "yes", "👍", "roger"), and a rigid
// match would miss most of them.

import { recordBroadcastAck } from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { postIssueCard } from '../procore-issue-intake/issue-card.js';
import { advanceIssueIntake, hasActiveFlow } from '../procore-issue-intake/issue-intake.js';

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
- "issue_report": the worker is reporting a new problem, not acknowledging anything.
- "other": anything else.`;

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
  // A photo-only MMS/WhatsApp message has an empty Body; nudge the model so it
  // knows a photo arrived (and files) rather than seeing a blank turn. Mirrors
  // the Slack DM path in listeners/events/message.js.
  const text = body || (photoUrl ? '[photo attached]' : body);
  const { reply, done, record } = await advanceIssueIntake(from, SMS_THREAD, text, { phone: from, photoUrl });
  if (done && record) await postIssueCard(client, record);
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
      // TODO: look up the actually-open broadcast for this worker/site instead
      // of a hardcoded placeholder ID, once lib/db.js's broadcast table exists.
      await recordBroadcastAck('TODO-broadcast-id', from);
      // TODO: update the live Slack message ("38/45 acknowledged") via client.chat.update.
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
