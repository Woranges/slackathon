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
  const receiver = /** @type {import('@slack/bolt').ExpressReceiver} */ (/** @type {any} */ (app).receiver);
  // A webhook isn't a Slack event, so Bolt never hands us a per-event authorized
  // client and `app.client` has no token in OAuth mode — use an explicit
  // bot-token client so the inbound handler can post the card + upload the photo.
  const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  receiver.router.post('/twilio/sms', express.urlencoded({ extended: false }), (req, res) =>
    handleTwilioInboundSms(req, res, botClient),
  );
}

/**
 * Start a standalone Express server for the Twilio webhook, so a Socket Mode
 * process (app.js) can receive inbound SMS *in the same process* as the Slack
 * button handlers. This matters for broadcast acknowledgments: the Escalate
 * button creates the broadcast in this process's in-memory store, and the
 * worker's "got it" reply must land in the SAME process to find it and update
 * the live scoreboard (a separate app-oauth.js process has its own memory and
 * never sees it). Runs one server for both webhooks + buttons until the store
 * moves to a shared DB (DATABASE_URL).
 * @param {number} [port] - Defaults to PORT env or 3000 (what ngrok points at).
 * @returns {import('node:http').Server}
 */
export function startTwilioWebhookServer(port = Number(process.env.PORT) || 3000) {
  const server = express();
  const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  // Health check for the host (Render) and for a keep-alive ping that stops a
  // free instance from sleeping (which would drop the Slack Socket Mode session).
  server.get('/health', (_req, res) => res.status(200).send('ok'));
  server.post('/twilio/sms', express.urlencoded({ extended: false }), (req, res) =>
    handleTwilioInboundSms(req, res, botClient),
  );
  return server.listen(port, () => console.log(`Twilio webhook listening on :${port}/twilio/sms`));
}
