import { WebClient } from '@slack/web-api';
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
  // A webhook isn't a Slack event, so Bolt never hands us a per-event authorized
  // client and `app.client` has no token in OAuth mode — use an explicit
  // bot-token client so the inbound handler can post the card + upload the photo.
  const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  receiver.router.post('/twilio/sms', express.urlencoded({ extended: false }), (req, res) =>
    handleTwilioInboundSms(req, res, botClient),
  );
}
