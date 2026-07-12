// Outbound Twilio client — SMS sends and escalation voice calls. Inbound
// webhook handling (worker replies, acknowledgments) lives in
// features/safety-broadcast/inbound-sms.js, not here.
//
// Talks to Twilio's REST API directly via fetch (no SDK dependency). Env is
// read at call time so it can be set/changed at runtime and unit-tested.

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/**
 * @returns {{ accountSid?: string, authToken?: string, fromNumber?: string }}
 */
function twilioEnv() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
  };
}

/**
 * True when every var needed to send is present.
 * @returns {boolean}
 */
export function isTwilioConfigured() {
  const e = twilioEnv();
  return Boolean(e.accountSid && e.authToken && e.fromNumber);
}

/**
 * Send an SMS via Twilio.
 * @param {string} to - E.164 phone number.
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function sendSms(to, body) {
  const e = twilioEnv();
  if (!isTwilioConfigured()) {
    throw new Error('Twilio not configured — set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER.');
  }

  // When the configured From is a WhatsApp sender (whatsapp:+…), the recipient
  // must be WhatsApp-addressed too — mirror the prefix so replies reach a worker
  // who reported via WhatsApp, not a plain (possibly unreachable) SMS number.
  const from = /** @type {string} */ (e.fromNumber);
  const toAddress = from.startsWith('whatsapp:') && !to.startsWith('whatsapp:') ? `whatsapp:${to}` : to;

  const auth = Buffer.from(`${e.accountSid}:${e.authToken}`).toString('base64');
  const res = await fetch(`${TWILIO_API_BASE}/Accounts/${e.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toAddress, From: from, Body: body }),
  });
  if (!res.ok) {
    throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Escape text for safe inclusion in a TwiML XML body, so a message containing
 * `<`, `&`, etc. can't break the `<Say>` element or inject markup.
 * @param {string} s
 * @returns {string}
 */
function escapeXml(s) {
  return String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );
}

// Twilio `<Say>` needs a locale (e.g. "es-MX"), not the ISO 639-1 code we store
// on a worker ("es"). Only languages Twilio can actually speak belong here: if a
// worker's language is absent, the caller is expected to fall back to speaking
// the English original rather than have an English voice mangle text it cannot
// pronounce. See voiceLanguageFor.
/** @type {Record<string, string>} */
const TWILIO_VOICE_LANGUAGES = {
  en: 'en-US',
  es: 'es-MX',
  zh: 'zh-CN',
  fr: 'fr-FR',
  pt: 'pt-BR',
  ru: 'ru-RU',
  pl: 'pl-PL',
  ko: 'ko-KR',
  ja: 'ja-JP',
  it: 'it-IT',
  de: 'de-DE',
  ar: 'arb',
};

/** The default voice when we have nothing better. */
export const DEFAULT_VOICE_LANGUAGE = 'en-US';

/**
 * Map a worker's ISO 639-1 language to a Twilio voice locale, or null when
 * Twilio has no voice for it.
 * @param {string | undefined | null} isoCode
 * @returns {string | null}
 */
export function voiceLanguageFor(isoCode) {
  if (!isoCode) return null;
  return TWILIO_VOICE_LANGUAGES[isoCode.toLowerCase().split('-')[0]] ?? null;
}

/**
 * Place an automated voice call reading a message aloud, for safety-broadcast
 * escalation when a worker hasn't acknowledged an SMS within the timeout. Uses
 * the Twilio Calls API with inline TwiML (`<Say>`), mirroring sendSms above.
 * @param {string} to - E.164 phone number.
 * @param {string} message
 * @param {string} [language] - Twilio voice locale (e.g. "es-MX"). Defaults to English.
 * @returns {Promise<void>}
 */
export async function placeEscalationCall(to, message, language = DEFAULT_VOICE_LANGUAGE) {
  const e = twilioEnv();
  if (!isTwilioConfigured()) {
    throw new Error('Twilio not configured — set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER.');
  }

  // The language is escaped like the body: it reaches us from worker data, and an
  // unescaped quote in an attribute could otherwise close the tag and inject TwiML.
  const twiml = `<Response><Say language="${escapeXml(language)}">${escapeXml(message)}</Say></Response>`;
  const auth = Buffer.from(`${e.accountSid}:${e.authToken}`).toString('base64');
  const res = await fetch(`${TWILIO_API_BASE}/Accounts/${e.accountSid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: /** @type {string} */ (e.fromNumber), Twiml: twiml }),
  });
  if (!res.ok) {
    throw new Error(`Twilio call failed: ${res.status} ${await res.text()}`);
  }
}
