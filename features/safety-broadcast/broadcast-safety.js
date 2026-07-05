// Owner: safety-broadcast feature.
//
// LLM-driven safety-broadcast slash command. The manager already knows what
// they want to send, but shouldn't be forced into a rigid `"message"
// --site=<site>` syntax — the model extracts the message and site from
// however they actually phrase the command (e.g. "crane lift at zone 3,
// avoid 10-2, downtown site"), handling that variation better than a fixed
// regex would.

import { getWorkersBySite } from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';
import { sendSms } from '../../lib/twilio.js';

const PARSE_SYSTEM_PROMPT = `\
Extract the safety broadcast message and site identifier from a construction manager's \
request. Clean the message up for SMS (concise, no filler) but keep all safety-critical \
details (location, time window, hazard). Always call parse_broadcast with what you find — \
never respond in plain text, and never ask a follow-up question.`;

/**
 * @param {(args: { message: string, site: string }) => void} onParsed
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
function createParseBroadcastTool(onParsed) {
  return {
    functionDeclaration: {
      name: 'parse_broadcast',
      description: "Extract the safety message and site identifier from the manager's request.",
      parametersJsonSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The safety message to broadcast, cleaned up for SMS.' },
          site: { type: 'string', description: 'The site/project identifier.' },
        },
        required: ['message', 'site'],
      },
    },
    handler: async (args) => {
      onParsed(/** @type {{ message: string, site: string }} */ (args));
      return { output: 'Captured.' };
    },
  };
}

/**
 * @param {string} text
 * @returns {Promise<{ message: string, site: string } | null>}
 */
async function parseCommandText(text) {
  /** @type {{ message: string, site: string } | null} */
  let parsed = null;
  const tool = createParseBroadcastTool((args) => {
    parsed = args;
  });

  await runLlmTurn({ systemPrompt: PARSE_SYSTEM_PROMPT, history: [], text, tools: [tool] });
  return parsed;
}

/**
 * @param {import('@slack/bolt').SlackCommandMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleBroadcastSafetyCommand({ command, ack, respond }) {
  await ack();

  const parsed = await parseCommandText(command.text);
  if (!parsed) {
    await respond(
      'Could not figure out the message and site from that — try including both, e.g. "crane lift at zone 3, avoid 10am-2pm, downtown site".',
    );
    return;
  }

  const { message, site } = parsed;
  const workers = await getWorkersBySite(site);

  // TODO: create a broadcast record in lib/db.js to track acknowledgments.
  // TODO: post a live-updating message in the channel ("38/45 acknowledged")
  // via client.chat.update — update it as inbound acks arrive via
  // features/safety-broadcast/inbound-sms.js.
  // TODO: schedule an escalation check (~15 min) that calls
  // lib/twilio.js#placeEscalationCall for any worker who hasn't acknowledged.
  for (const worker of workers) {
    const translated =
      worker.preferredLanguage !== 'en' ? await translateText(message, worker.preferredLanguage) : message;
    await sendSms(worker.phone, translated);
  }

  await respond(
    `Broadcast "${message}" queued for ${workers.length} worker(s) at ${site}. (TODO: not yet wired to Twilio.)`,
  );
}
