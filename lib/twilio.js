// Outbound Twilio client — SMS sends and escalation voice calls. Inbound
// webhook handling (worker replies, acknowledgments) lives in
// features/safety-broadcast/inbound-sms.js, not here.
//
// ---------------------------------------------------------------------------
// COORDINATION NOTE — Lindsay (safety-broadcast), branch lindsay/translate,
// 2026-07-06. For Warren / Warren's Claude:
//   Implemented so the safety-broadcast flow runs end-to-end. When the TWILIO_*
//   env vars are set, this makes real Twilio REST API calls. When they are NOT
//   set (local dev / demo without a Twilio account) it logs what WOULD be sent
//   and returns without error, so a missing credential never blocks a send.
//   Uses the built-in fetch + Twilio's REST API directly — no new npm package.
// ---------------------------------------------------------------------------

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/**
 * Read Twilio credentials from the environment.
 * @returns {{ accountSid: string, authToken: string, fromNumber: string } | null}
 *   null when any credential is missing (dev mode).
 */
function getTwilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

/**
 * Send an SMS via Twilio. Falls back to a dev-mode log when Twilio isn't
 * configured, so a broadcast never crashes for lack of credentials.
 * @param {string} to - E.164 phone number.
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function sendSms(to, body) {
  const config = getTwilioConfig();
  if (!config) {
    console.log(`[twilio:dev] would send SMS to ${to}: ${body}`);
    return;
  }

  await postToTwilio(config, `/Accounts/${config.accountSid}/Messages.json`, {
    To: to,
    From: config.fromNumber,
    Body: body,
  });
}

/**
 * Place an automated voice call that reads a message aloud, for
 * safety-broadcast escalation when a worker hasn't acknowledged in time.
 * Falls back to a dev-mode log when Twilio isn't configured.
 * @param {string} to - E.164 phone number.
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function placeEscalationCall(to, message) {
  const config = getTwilioConfig();
  if (!config) {
    console.log(`[twilio:dev] would call ${to} and read aloud: ${message}`);
    return;
  }

  // TwiML tells Twilio what to do on the call; <Say> reads text aloud.
  const twiml = `<Response><Say>${escapeXml(message)}</Say></Response>`;
  await postToTwilio(config, `/Accounts/${config.accountSid}/Calls.json`, {
    To: to,
    From: config.fromNumber,
    Twiml: twiml,
  });
}

/**
 * POST form-encoded params to the Twilio REST API with HTTP Basic auth.
 * @param {{ accountSid: string, authToken: string }} config
 * @param {string} path
 * @param {Record<string, string>} params
 * @returns {Promise<void>}
 */
async function postToTwilio(config, path, params) {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  const response = await fetch(`${TWILIO_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Twilio API error ${response.status}: ${detail}`);
  }
}

/**
 * Escape text placed inside TwiML XML so special characters don't break it.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
