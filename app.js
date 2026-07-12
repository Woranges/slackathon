import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';
import { startTwilioWebhookServer } from './listeners/webhooks/index.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
  ignoreSelf: false,
});

registerListeners(app);

(async () => {
  await app.start();
  app.logger.info('Starter Agent is running!');
  // Also serve the Twilio webhook here so inbound SMS (worker acknowledgments,
  // SMS issue reports) shares this process's in-memory store with the Slack
  // button handlers — otherwise a broadcast created by the Escalate button is
  // invisible to the ack arriving on a separate HTTP process. Skip if Twilio
  // isn't configured (no point binding a port for a webhook that won't fire).
  if (process.env.TWILIO_ACCOUNT_SID) {
    startTwilioWebhookServer();
  }
})();
