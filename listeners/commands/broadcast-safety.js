// Deterministic (non-LLM) safety-broadcast slash command. No LLM call
// anywhere in this file — the manager already knows exactly what they want
// to send, so there's no ambiguity for a model to resolve. See CLAUDE.md.

import { getWorkersBySite } from '../../lib/db.js';
import { translateText } from '../../lib/translate.js';
import { sendSms } from '../../lib/twilio.js';

/**
 * Parse `"<message>" --site=<site>` out of the slash command text.
 * @param {string} text
 * @returns {{ message: string, site: string } | null}
 */
function parseCommandText(text) {
  const messageMatch = text.match(/"([^"]+)"/);
  const siteMatch = text.match(/--site=(\S+)/);
  if (!messageMatch || !siteMatch) return null;
  return { message: messageMatch[1], site: siteMatch[1] };
}

/**
 * @param {import('@slack/bolt').SlackCommandMiddlewareArgs & import('@slack/bolt').AllMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleBroadcastSafetyCommand({ command, ack, respond }) {
  await ack();

  const parsed = parseCommandText(command.text);
  if (!parsed) {
    await respond('Usage: `/broadcast-safety "message" --site=<site>`');
    return;
  }

  const { message, site } = parsed;
  const workers = await getWorkersBySite(site);

  // TODO: create a broadcast record in lib/db.js to track acknowledgments.
  // TODO: post a live-updating message in the channel ("38/45 acknowledged")
  // via client.chat.update — update it as inbound acks arrive via
  // listeners/webhooks/twilio.js.
  // TODO: schedule an escalation check (~15 min) that calls
  // lib/twilio.js#placeEscalationCall for any worker who hasn't acknowledged.
  for (const worker of workers) {
    const translated =
      worker.preferredLanguage !== 'en' ? await translateText(message, worker.preferredLanguage) : message;
    await sendSms(worker.phone, translated);
  }

  await respond(`TODO: broadcast "${message}" queued for ${workers.length} worker(s) at ${site}.`);
}
