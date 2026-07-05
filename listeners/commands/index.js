import { handleBroadcastSafetyCommand } from './broadcast-safety.js';

/**
 * Register slash command listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.command('/broadcast-safety', handleBroadcastSafetyCommand);
}
