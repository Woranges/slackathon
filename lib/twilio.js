// Outbound Twilio client — SMS sends and escalation voice calls. Inbound
// webhook handling (worker replies, acknowledgments) lives in
// listeners/webhooks/twilio.js, not here.

/**
 * Send an SMS via Twilio.
 * @param {string} to - E.164 phone number.
 * @param {string} body
 * @returns {Promise<void>}
 */
export async function sendSms(to, body) {
  // TODO: wire up the Twilio client using TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
  // / TWILIO_FROM_NUMBER from .env.
  throw new Error('Not implemented: wire up lib/twilio.js#sendSms');
}

/**
 * Place an automated voice call reading a message aloud, for safety-broadcast
 * escalation when a worker hasn't acknowledged an SMS within the timeout.
 * @param {string} to - E.164 phone number.
 * @param {string} message
 * @returns {Promise<void>}
 */
export async function placeEscalationCall(to, message) {
  throw new Error('Not implemented: wire up lib/twilio.js#placeEscalationCall');
}
