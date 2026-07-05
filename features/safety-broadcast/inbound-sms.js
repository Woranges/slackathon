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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
export async function handleTwilioInboundSms(req, res) {
  const from = req.body?.From;
  const body = req.body?.Body ?? '';

  const intent = await classifyReply(body);

  if (intent === 'acknowledgment') {
    // TODO: look up the actually-open broadcast for this worker/site instead
    // of a hardcoded placeholder ID, once lib/db.js's broadcast table exists.
    await recordBroadcastAck('TODO-broadcast-id', from);
    // TODO: update the live Slack message ("38/45 acknowledged") via client.chat.update.
  } else if (intent === 'issue_report') {
    // TODO: route into features/procore-issue-intake/issue-intake.js's
    // advanceIssueIntake, keyed by this worker's phone rather than a Slack
    // channelId/threadTs — needs a phone-to-thread mapping in lib/db.js first.
  }
  // "other" — no action; TODO: consider a fallback reply if this happens often.

  res.status(200).type('text/xml').send('<Response></Response>');
}
