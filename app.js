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
  // invisible to the ack arriving on a separate HTTP process. Start it when
  // Twilio is configured, or when a host provides PORT (so the health check /
  // keep-alive has something to hit even before Twilio is wired).
  if (process.env.TWILIO_ACCOUNT_SID || process.env.PORT) {
    startTwilioWebhookServer();
  }
})();
