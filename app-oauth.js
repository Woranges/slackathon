import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { App, ExpressReceiver, LogLevel } from '@slack/bolt';
import pkg from '@slack/oauth';

const { FileInstallationStore } = pkg;

import { registerListeners } from './listeners/index.js';
import { registerWebhooks } from './listeners/webhooks/index.js';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf-8'));
const botScopes = manifest.oauth_config.scopes.bot;
const userScopes = manifest.oauth_config.scopes.user;

// ---------------------------------------------------------------------------
// Installation store with bot-token fallback
// ---------------------------------------------------------------------------
// When installed via Slack CLI, SLACK_BOT_TOKEN is available but Bolt clears
// it when OAuth options are present. This wrapper lets the bot token serve as
// a fallback so App Home (with the OAuth install URL) and basic bot operations
// work before anyone has completed the OAuth flow.

const fileStore = new FileInstallationStore({ baseDir: './data/installations' });
const fallbackBotToken = process.env.SLACK_BOT_TOKEN;

/** @type {import('@slack/bolt').InstallationStore} */
const installationStore = {
  storeInstallation: async (installation) => fileStore.storeInstallation(installation),
  fetchInstallation: async (query) => {
    try {
      return await fileStore.fetchInstallation(query);
    } catch {
      if (fallbackBotToken) {
        return /** @type {any} */ ({ bot: { token: fallbackBotToken } });
      }
      throw new Error('No installation found and no fallback bot token configured');
    }
  },
  deleteInstallation: async (query) => fileStore.deleteInstallation(query),
};

// Use an explicit ExpressReceiver (not the default HTTPReceiver) so we can mount
// the Twilio webhook route on its Express `router` in registerWebhooks(). The
// OAuth/installer config lives on the receiver when a custom receiver is used.
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: 'bolt-js-starter-agent',
  scopes: botScopes,
  installationStore,
  installerOptions: {
    stateVerification: true,
    userScopes,
  },
});

const app = new App({
  logLevel: LogLevel.DEBUG,
  ignoreSelf: false,
  receiver,
});

registerListeners(app);
registerWebhooks(app);

(async () => {
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  await app.start(port);
  app.logger.info(`Starter Agent is running on port ${port}!`);
  if (process.env.SLACK_REDIRECT_URI) {
    const origin = new URL(process.env.SLACK_REDIRECT_URI).origin;
    app.logger.info(`Connect the Slack MCP Server: ${origin}/slack/install`);
  }
})();
