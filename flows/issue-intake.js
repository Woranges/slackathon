// Deterministic (non-LLM) structured issue-intake flow. A worker starts it
// by texting/typing "issue"; the bot walks them through area -> photo ->
// description one step at a time, then writes to Procore and posts a Slack
// card. No LLM call anywhere in this file — see CLAUDE.md for why.

import { translateText } from '../lib/translate.js';

/** @typedef {'area' | 'photo' | 'description'} FlowStep */

/**
 * @typedef {Object} FlowState
 * @property {FlowStep} step
 * @property {string} [area]
 * @property {string} [photoUrl]
 */

/** @type {Map<string, FlowState>} */
const activeFlows = new Map();

/**
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {string}
 */
function key(channelId, threadTs) {
  return `${channelId}:${threadTs}`;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isIssueIntakeTrigger(text) {
  return /^issue\b/i.test(text.trim());
}

/**
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {boolean}
 */
export function hasActiveFlow(channelId, threadTs) {
  return activeFlows.has(key(channelId, threadTs));
}

/**
 * Advance the issue-intake flow by one message.
 * @param {string} channelId
 * @param {string} threadTs
 * @param {string} text
 * @returns {Promise<{ reply: string, done: boolean }>}
 */
export async function advanceIssueIntake(channelId, threadTs, text) {
  const k = key(channelId, threadTs);
  const state = activeFlows.get(k);

  if (!state) {
    activeFlows.set(k, { step: 'area' });
    return { reply: 'Got it — which area/floor is this? (e.g. "3rd floor, east stairwell")', done: false };
  }

  if (state.step === 'area') {
    state.area = text;
    state.step = 'photo';
    return { reply: 'Thanks. Send a photo if you have one, or reply "skip".', done: false };
  }

  if (state.step === 'photo') {
    state.photoUrl = /^skip$/i.test(text.trim()) ? undefined : text;
    state.step = 'description';
    return { reply: 'One-line description of the issue?', done: false };
  }

  // state.step === 'description'
  activeFlows.delete(k);

  // TODO: translate using the reporter's actual preferred_language once
  // captured (lib/db.js#getWorkerByPhone); defaulting to a pass-through
  // until per-worker language lookup is wired up here.
  const englishDescription = await translateText(text, 'en');

  // TODO: write to Procore via the MCP connection (agent/mcp/procore.js) —
  // e.g. mcp__procore__create_rfi with { area: state.area, photo: state.photoUrl,
  // description: englishDescription }.
  // TODO: post a Slack card with Assign/Escalate/Resolve buttons (see
  // listeners/actions/ for the interactive-component pattern) instead of a
  // plain text reply.
  return {
    reply: `TODO: not yet wired to Procore. Would file: area="${state.area}", photo=${state.photoUrl ?? 'none'}, description="${englishDescription}"`,
    done: true,
  };
}
