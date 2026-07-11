// Owner: safety-broadcast feature.
//
// LLM-driven safety-broadcast slash command. The manager already knows what
// they want to send, but shouldn't be forced into a rigid `"message"
// --site=<site>` syntax — the model extracts the message and site from
// however they actually phrase the command (e.g. "crane lift at zone 3,
// avoid 10-2, downtown site"), handling that variation better than a fixed
// regex would.

import { createBroadcast, getWorkersBySite, setBroadcastMessage } from '../../lib/db.js';
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
 * Format the live acknowledgment scoreboard that gets posted to Slack and
 * updated as workers reply (see features/safety-broadcast/inbound-sms.js).
 * @param {{ site: string, message: string, acknowledged: number, total: number }} status
 * @returns {string}
 */
export function formatBroadcastStatus({ site, message, acknowledged, total }) {
  return `🚨 *Safety broadcast — ${site}*\n> ${message}\n\n*${acknowledged}/${total} acknowledged*`;
}

/**
 * @param {import('@slack/bolt').SlackCommandMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleBroadcastSafetyCommand({ command, ack, respond, client }) {
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

  if (workers.length === 0) {
    await respond(`No workers are registered for site "${site}", so nothing was sent.`);
    return;
  }

  // Record the broadcast so replies can be counted against it.
  const broadcast = await createBroadcast(site, message);

  // Text every worker in their language. Wrap each send so one failure (a bad
  // number, or Twilio not being configured yet) doesn't abort the whole
  // broadcast — a safety alert should reach as many workers as possible.
  let sent = 0;
  for (const worker of workers) {
    const translated =
      worker.preferredLanguage !== 'en' ? await translateText(message, worker.preferredLanguage) : message;
    try {
      await sendSms(worker.phone, translated);
      sent += 1;
    } catch (error) {
      console.error(`[broadcast-safety] SMS to ${worker.phone} failed:`, error);
    }
  }

  // Post the live scoreboard, then remember its location so inbound acks can
  // update it (task #2, features/safety-broadcast/inbound-sms.js).
  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: formatBroadcastStatus({ site, message, acknowledged: 0, total: workers.length }),
  });
  if (posted.ts) {
    await setBroadcastMessage(broadcast.id, command.channel_id, posted.ts);
  }

  await respond(`Safety broadcast sent to ${sent}/${workers.length} worker(s) at ${site}. Live count posted above.`);
}
