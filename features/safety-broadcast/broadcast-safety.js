// Owner: safety-broadcast feature.
//
// LLM-driven safety-broadcast slash command. The manager already knows what
// they want to send, but shouldn't be forced into a rigid `"message"
// --site=<site>` syntax — the model extracts the message and site from
// however they actually phrase the command (e.g. "crane lift at zone 3,
// avoid 10-2, downtown site"), handling that variation better than a fixed
// regex would.

import { createBroadcast, getWorkersBySite, hasAcked, setBroadcastMessage, siteLabel } from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';
import { placeEscalationCall, sendSms } from '../../lib/twilio.js';

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
 * Voice-call every worker who has NOT acknowledged a broadcast. Runs after the
 * escalation window elapses. Each call is wrapped so one failure (a bad number,
 * or Twilio being unconfigured) doesn't stop the rest — an escalation should
 * reach as many non-responders as possible.
 * @param {import('../../lib/db.js').Broadcast} broadcast
 * @param {import('../../lib/db.js').Worker[]} workers - Workers the broadcast was sent to.
 * @param {{ placeCall?: (to: string, message: string) => Promise<void> }} [deps]
 *   placeCall is injectable so escalation can be tested without hitting Twilio.
 * @returns {Promise<number>} How many escalation calls succeeded.
 */
export async function escalateUnacknowledged(broadcast, workers, { placeCall = placeEscalationCall } = {}) {
  let called = 0;
  for (const worker of workers) {
    if (await hasAcked(broadcast.id, worker.phone)) continue;
    try {
      await placeCall(worker.phone, broadcast.message);
      called += 1;
    } catch (error) {
      console.error(`[broadcast-safety] escalation call to ${worker.phone} failed:`, error);
    }
  }
  return called;
}

/**
 * After a broadcast, schedule a voice-call sweep of anyone who still hasn't
 * acknowledged within the window. Extracted so BOTH callers of broadcastToSite
 * (the slash command and the Escalate button) get escalation. The delay is read
 * at call time so it can be tuned per run (ESCALATION_DELAY_MS=30000 to see it
 * quickly in a demo); a negative value disables escalation. .unref() keeps the
 * pending timer from holding the process open on its own.
 * @param {import('../../lib/db.js').Broadcast} broadcast
 * @param {import('../../lib/db.js').Worker[]} workers
 */
function scheduleEscalationSweep(broadcast, workers) {
  const delayMs = Number(process.env.ESCALATION_DELAY_MS ?? 15 * 60 * 1000);
  if (Number.isFinite(delayMs) && delayMs >= 0) {
    setTimeout(() => {
      escalateUnacknowledged(broadcast, workers).catch((error) =>
        console.error('[broadcast-safety] escalation sweep failed:', error),
      );
    }, delayMs).unref();
  }
}

/**
 * Send a safety message to every worker at a site (translated per worker), post
 * the live acknowledgment scoreboard to Slack, register it so inbound acks
 * (features/safety-broadcast/inbound-sms.js) can update the count, and schedule
 * the escalation sweep. Shared by the /broadcast-safety slash command and the
 * issue card's Escalate button, so a safety escalation reuses the exact same
 * fan-out + scoreboard + follow-up. Best-effort per send: one bad number never
 * aborts the rest of a safety alert.
 * @param {{ site: string, message: string, client: any, channel: string }} params
 *   `site` is the lookup id (getWorkersBySite); the scoreboard shows its friendly name.
 * @returns {Promise<{ sent: number, total: number, broadcastId: string | null }>}
 */
export async function broadcastToSite({ site, message, client, channel }) {
  const workers = await getWorkersBySite(site);
  if (workers.length === 0) return { sent: 0, total: 0, broadcastId: null };

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
      console.error(`[safety-broadcast] SMS to ${worker.phone} failed:`, error);
    }
  }

  // Post the live scoreboard, then remember its location so inbound acks can update it.
  const posted = await client.chat.postMessage({
    channel,
    text: formatBroadcastStatus({ site: siteLabel(site) ?? site, message, acknowledged: 0, total: workers.length }),
  });
  if (posted.ts) {
    await setBroadcastMessage(broadcast.id, channel, posted.ts);
  }

  // Chase non-responders by voice after the window (both callers get this).
  scheduleEscalationSweep(broadcast, workers);

  return { sent, total: workers.length, broadcastId: broadcast.id };
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
  const { sent, total } = await broadcastToSite({ site, message, client, channel: command.channel_id });

  if (total === 0) {
    await respond(`No workers are registered for site "${site}", so nothing was sent.`);
    return;
  }

  await respond(`Safety broadcast sent to ${sent}/${total} worker(s) at ${site}. Live count posted above.`);
}
