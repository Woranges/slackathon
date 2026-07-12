// Owner: safety-broadcast feature.
//
// LLM-driven safety-broadcast slash command. The manager already knows what
// they want to send, but shouldn't be forced into a rigid `"message"
// --site=<site>` syntax — the model extracts the message and site from
// however they actually phrase the command (e.g. "crane lift at zone 3,
// avoid 10-2, downtown site"), handling that variation better than a fixed
// regex would.

import {
  createBroadcast,
  getBroadcast,
  getBroadcastAudit,
  getWorkersBySite,
  hasAcked,
  recordEscalation,
  setBroadcastMessage,
  siteLabel,
} from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';
import { DEFAULT_VOICE_LANGUAGE, placeEscalationCall, sendSms, voiceLanguageFor } from '../../lib/twilio.js';

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
 * @typedef {import('../../lib/db.js').BroadcastAuditRow} AuditRow
 */

// Language names for the audit trail. The record has to be readable by a person
// who was not there — "called in Spanish" means something; "called in es" doesn't.
/** @type {Record<string, string>} */
const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
  zh: 'Chinese',
  fr: 'French',
  pt: 'Portuguese',
  ru: 'Russian',
  pl: 'Polish',
  ko: 'Korean',
  ja: 'Japanese',
  it: 'Italian',
  de: 'German',
  ar: 'Arabic',
};

/**
 * @param {string} iso
 * @returns {string}
 */
function languageName(iso) {
  return (
    LANGUAGE_NAMES[
      String(iso ?? '')
        .toLowerCase()
        .split('-')[0]
    ] ?? iso
  );
}

/**
 * Render an instant as a Slack date token, so every viewer sees it in their own
 * timezone, with the raw ISO instant as the fallback (and as the literal value a
 * court or an auditor would read). Same pattern as the issue card.
 * @param {string} iso
 * @returns {string}
 */
function slackTime(iso) {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return `<!date^${unix}^{time}|${iso}>`;
}

/**
 * Format the live acknowledgment scoreboard that gets posted to Slack and
 * updated as workers reply (see features/safety-broadcast/inbound-sms.js).
 *
 * It names names. "2/3 acknowledged" does not tell a manager the one thing they
 * actually need — WHICH worker is still unaccounted for — and the count is
 * derived from the same rows as the names so the two can never disagree.
 * @param {{ site: string, message: string, rows: AuditRow[] }} status
 * @returns {string}
 */
export function formatBroadcastStatus({ site, message, rows }) {
  const acked = rows.filter((r) => r.ackedAt);
  const called = rows.filter((r) => !r.ackedAt && r.escalatedAt);
  const pending = rows.filter((r) => !r.ackedAt && !r.escalatedAt);

  const lines = [
    `🚨 *Safety broadcast — ${site}*`,
    `> ${message}`,
    '',
    `*${acked.length}/${rows.length} acknowledged*`,
  ];
  if (acked.length) lines.push(`✅ ${acked.map((r) => r.name).join(' · ')}`);
  if (called.length) lines.push(`📞 ${called.map((r) => r.name).join(' · ')} — no reply, voice-called`);
  if (pending.length) lines.push(`⏳ ${pending.map((r) => r.name).join(' · ')}`);

  return lines.join('\n');
}

/**
 * The audit trail for a broadcast, as a human-readable record: who was warned,
 * whether they confirmed it, when, and who had to be phoned because they didn't.
 *
 * This is the deliverable the whole feature exists to produce. A timestamp in a
 * database is a claim; this is the record — it protects the worker (proof they
 * were warned in a language they read) and the company (proof of due diligence).
 * Pure, so it can be tested without Slack.
 * @param {{ site: string, message: string, createdAt: string, rows: AuditRow[] }} broadcast
 * @returns {string}
 */
export function formatBroadcastAudit({ site, message, createdAt, rows }) {
  const lines = [
    `📋 *Acknowledgment record — ${site}*`,
    `> ${message}`,
    `_Sent ${slackTime(createdAt)} to ${rows.length} worker(s)._`,
    '',
  ];

  for (const r of rows) {
    if (r.ackedAt) {
      lines.push(`✅ *${r.name}* — acknowledged ${slackTime(r.ackedAt)}, alerted in ${languageName(r.language)}`);
    } else if (r.escalatedAt) {
      lines.push(
        `📞 *${r.name}* — no reply to the text; voice call placed ${slackTime(r.escalatedAt)} in ${languageName(r.language)}`,
      );
    } else {
      lines.push(`⚠️ *${r.name}* — no acknowledgment, and no call was placed`);
    }
  }

  // State the happy path outright rather than leaving the reader to infer it from
  // the absence of warnings.
  if (rows.length && rows.every((r) => r.ackedAt)) {
    lines.push('', '_All workers acknowledged. No escalation was needed._');
  }

  return lines.join('\n');
}

/**
 * What the escalation call should actually say to one worker, and in which voice.
 *
 * A worker who ignored the text is, very often, the worker who could not read it.
 * So the call is translated the same way the SMS was. Two deliberate fallbacks:
 * if Twilio has no voice for their language we speak the English original rather
 * than have an English voice mangle words it cannot pronounce (coherent English
 * beats garbled Spanish, and the translated SMS already went out); and if the
 * translation itself fails we still place the call, because a call in the wrong
 * language beats no call at all when someone may be walking under a crane.
 * @param {import('../../lib/db.js').Worker} worker
 * @param {string} message - The original (English) broadcast message.
 * @param {(text: string, targetLang: string) => Promise<string>} translate
 * @returns {Promise<{ spoken: string, language: string }>}
 */
async function speechFor(worker, message, translate) {
  const voice = voiceLanguageFor(worker.preferredLanguage);

  // No voice for this language, or they already speak English — say it in English.
  if (!voice || voice === DEFAULT_VOICE_LANGUAGE) {
    return { spoken: message, language: DEFAULT_VOICE_LANGUAGE };
  }

  try {
    return { spoken: await translate(message, worker.preferredLanguage), language: voice };
  } catch (error) {
    console.error(`[safety-broadcast] could not translate the escalation call for ${worker.phone}:`, error);
    return { spoken: message, language: DEFAULT_VOICE_LANGUAGE };
  }
}

/**
 * Voice-call every worker who has NOT acknowledged a broadcast, in their own
 * language. Runs after the escalation window elapses. Each call is wrapped so one
 * failure (a bad number, or Twilio being unconfigured) doesn't stop the rest — an
 * escalation should reach as many non-responders as possible. Every call that
 * connects is written to the audit trail, so the record can show we texted, got
 * no reply, and then phoned them.
 * @param {import('../../lib/db.js').Broadcast} broadcast
 * @param {import('../../lib/db.js').Worker[]} workers - Workers the broadcast was sent to.
 * @param {{
 *   placeCall?: (to: string, message: string, language?: string) => Promise<void>,
 *   translate?: (text: string, targetLang: string) => Promise<string>,
 * }} [deps] Both are injectable so escalation can be tested without Twilio or the model.
 * @returns {Promise<number>} How many escalation calls succeeded.
 */
export async function escalateUnacknowledged(
  broadcast,
  workers,
  { placeCall = placeEscalationCall, translate = translateText } = {},
) {
  let called = 0;
  for (const worker of workers) {
    if (await hasAcked(broadcast.id, worker.phone)) continue;

    const { spoken, language } = await speechFor(worker, broadcast.message, translate);
    try {
      await placeCall(worker.phone, spoken, language);
      // Only record a call that actually went out — an audit trail that claims a
      // call which never connected is worse than no audit trail at all.
      await recordEscalation(broadcast.id, worker.phone);
      called += 1;
    } catch (error) {
      console.error(`[safety-broadcast] escalation call to ${worker.phone} failed:`, error);
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
 * @param {any} client - Slack WebClient, for the scoreboard refresh + audit reply.
 */
function scheduleEscalationSweep(broadcast, workers, client) {
  const delayMs = Number(process.env.ESCALATION_DELAY_MS ?? 15 * 60 * 1000);
  if (Number.isFinite(delayMs) && delayMs >= 0) {
    setTimeout(() => {
      runEscalationSweep(broadcast, workers, client).catch((error) =>
        console.error('[safety-broadcast] escalation sweep failed:', error),
      );
    }, delayMs).unref();
  }
}

/**
 * Close out a broadcast: voice-call whoever still hasn't acknowledged, then post
 * the acknowledgment record as a reply in the scoreboard's thread.
 *
 * The record is posted whether or not anyone had to be called — a broadcast that
 * everyone acknowledged still needs its "everyone was warned, here is the proof"
 * artifact. Exported so it can be tested (and triggered) without waiting out the
 * escalation window.
 * @param {import('../../lib/db.js').Broadcast} broadcast
 * @param {import('../../lib/db.js').Worker[]} workers
 * @param {any} client - Slack WebClient.
 * @param {{
 *   placeCall?: (to: string, message: string, language?: string) => Promise<void>,
 *   translate?: (text: string, targetLang: string) => Promise<string>,
 * }} [deps]
 * @returns {Promise<{ called: number, audited: boolean }>}
 */
export async function runEscalationSweep(broadcast, workers, client, deps = {}) {
  const called = await escalateUnacknowledged(broadcast, workers, deps);

  // The scoreboard is where the record belongs — but if it was never posted there
  // is no thread to reply to, and the escalation still stands on its own.
  const stored = (await getBroadcast(broadcast.id)) ?? broadcast;
  if (!stored.channel || !stored.messageTs) return { called, audited: false };

  const rows = await getBroadcastAudit(broadcast.id);
  const site = siteLabel(stored.siteId) ?? stored.siteId;

  // Refresh the scoreboard so it shows who got called, then file the record under it.
  await client.chat.update({
    channel: stored.channel,
    ts: stored.messageTs,
    text: formatBroadcastStatus({ site, message: stored.message, rows }),
  });
  await client.chat.postMessage({
    channel: stored.channel,
    thread_ts: stored.messageTs,
    text: formatBroadcastAudit({ site, message: stored.message, createdAt: stored.createdAt, rows }),
  });

  return { called, audited: true };
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
    text: formatBroadcastStatus({
      site: siteLabel(site) ?? site,
      message,
      rows: await getBroadcastAudit(broadcast.id),
    }),
  });
  if (posted.ts) {
    await setBroadcastMessage(broadcast.id, channel, posted.ts);
  }

  // Chase non-responders by voice after the window, then file the acknowledgment
  // record in the scoreboard's thread (both callers get this).
  scheduleEscalationSweep(broadcast, workers, client);

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
