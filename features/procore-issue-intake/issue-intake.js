// Owner: procore-issue-intake feature.
//
// LLM-driven structured issue-intake flow. A worker starts it by
// texting/typing "issue"; from there the model gathers area + description
// (photo optional) from however the worker actually phrases it — in one
// message or several, in any order — rather than forcing rigid one-question
// steps. Trigger detection itself stays a cheap keyword check (no LLM cost
// on messages that were never going to start this flow); everything after
// that goes through lib/llm/ once triggered.

import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';

const SYSTEM_PROMPT = `\
You are helping a construction worker report a site issue over text messaging.

Gather two required pieces of information:
- area: the location/area of the issue (e.g. "3rd floor, east stairwell")
- description: a one-line description of the problem

A photo is optional — if they mention or link one, capture its URL, but never require it.

Ask short, casual follow-up questions for whatever's missing. If the worker already gave \
you multiple pieces of information in one message, don't force them through a rigid \
one-field-at-a-time order — just ask about whatever's still missing. Once you have both \
area and description, call the file_issue tool immediately with what you have — don't ask \
for confirmation first.`;

/**
 * @param {(args: { area: string, description: string, photo_url?: string }) => Promise<Record<string, unknown>>} onFileIssue
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
function createFileIssueTool(onFileIssue) {
  return {
    functionDeclaration: {
      name: 'file_issue',
      description: 'File the collected issue report once area and description are both known.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'Location/area of the issue.' },
          description: { type: 'string', description: 'One-line description of the issue.' },
          photo_url: { type: 'string', description: 'URL of a photo documenting the issue, if provided.' },
        },
        required: ['area', 'description'],
      },
    },
    handler: (args) => onFileIssue(/** @type {{ area: string, description: string, photo_url?: string }} */ (args)),
  };
}

/** @type {Map<string, import('@google/genai').Content[]>} */
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
 * @param {import('@google/genai').Content[]} history
 * @returns {boolean}
 */
function wasFileIssueCalled(history) {
  return history.some((turn) => turn.parts?.some((p) => p.functionCall?.name === 'file_issue'));
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
  const history = activeFlows.get(k) ?? [];

  const fileIssueTool = createFileIssueTool(async ({ area, description, photo_url }) => {
    // TODO: translate using the reporter's actual preferred_language once
    // captured (lib/db.js#getWorkerByPhone); defaulting to a pass-through
    // until per-worker language lookup is wired up here.
    const englishDescription = await translateText(description, 'en');

    // TODO: write to Procore via the MCP connection (agent/mcp/procore.js) —
    // e.g. mcp__procore__create_rfi with { area, photo_url, description: englishDescription }.
    // TODO: post a Slack card with Assign/Escalate/Resolve buttons (see
    // listeners/actions/ for the interactive-component pattern) instead of a
    // plain text reply.
    return {
      output: `Filed: area="${area}", photo=${photo_url ?? 'none'}, description="${englishDescription}" (TODO: not yet wired to Procore).`,
    };
  });

  const { responseText, history: newHistory } = await runLlmTurn({
    systemPrompt: SYSTEM_PROMPT,
    history,
    text,
    tools: [fileIssueTool],
  });

  const done = wasFileIssueCalled(newHistory);
  if (done) {
    activeFlows.delete(k);
  } else {
    activeFlows.set(k, newHistory);
  }

  return { reply: responseText, done };
}
