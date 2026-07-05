import * as actions from './actions/index.js';
import * as commands from './commands/index.js';
import * as events from './events/index.js';
import * as views from './views/index.js';

/**
 * Register all Slack event, action, command, and view listeners.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function registerListeners(app) {
  actions.register(app);
  commands.register(app);
  events.register(app);
  views.register(app);
}
