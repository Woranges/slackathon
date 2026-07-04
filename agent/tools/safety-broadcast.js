// Owner: safety-broadcast feature. Fans a message out via SMS/WhatsApp to every
// worker on a site, translated per recipient, with acknowledgment tracking.

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { getWorkersBySite } from '../../lib/db.js';
import { translateText } from '../../lib/translate.js';
import { sendSms } from '../../lib/twilio.js';

const DESCRIPTION =
  'Broadcast a safety message to every worker on a site via SMS, translated into each ' +
  "worker's preferred language. Use this for urgent, safety-critical announcements " +
  '(e.g. a crane lift, a hazard, a schedule change affecting safety) — not routine updates.';

/**
 * @param {import('../agent.js').AgentDeps} [deps]
 */
export function createSafetyBroadcastTool(deps) {
  return tool(
    'trigger_safety_broadcast',
    DESCRIPTION,
    {
      site: z.string().describe('Project/site identifier to broadcast to.'),
      message: z.string().describe('The safety message to send, in English.'),
    },
    async ({ site, message }) => {
      const workers = await getWorkersBySite(site);

      // TODO: create a broadcast record in lib/db.js to track acknowledgments.
      // TODO: send translated SMS to each worker via lib/twilio.js#sendSms.
      // TODO: post a live-updating Slack message ("38/45 acknowledged") — update
      // it as inbound acks arrive via listeners/webhooks/twilio.js.
      // TODO: schedule an escalation check (~15 min) that calls
      // lib/twilio.js#placeEscalationCall for any worker who hasn't acknowledged.
      for (const worker of workers) {
        const translated =
          worker.preferredLanguage !== 'en' ? await translateText(message, worker.preferredLanguage) : message;
        await sendSms(worker.phone, translated);
      }

      return {
        content: [
          { type: 'text', text: `TODO: broadcast "${message}" queued for ${workers.length} worker(s) at ${site}.` },
        ],
      };
    },
  );
}
