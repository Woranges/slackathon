import express from 'express';

import { handleTwilioInboundSms } from '../../features/safety-broadcast/inbound-sms.js';

/**
 * Mount non-Slack inbound webhook routes (Twilio, and later Procore if it
 * pushes updates) on the Bolt app's underlying Express receiver. Only call
 * this from app-oauth.js — Socket Mode (app.js) has no HTTP receiver to
 * attach routes to.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function registerWebhooks(app) {
  const receiver = /** @type {import('@slack/bolt').ExpressReceiver} */ (app.receiver);
  receiver.router.post('/twilio/sms', express.urlencoded({ extended: false }), handleTwilioInboundSms);
}
