// Owner: procore-issue-intake feature.
//
// LLM-driven structured issue-intake flow. A worker starts it by
// texting/typing "issue"; from there the model gathers area + description
// (photo optional) from however the worker actually phrases it — in one
// message or several, in any order — rather than forcing rigid one-question
// steps. Trigger detection itself stays a cheap keyword check (no LLM cost
// on messages that were never going to start this flow); everything after
// that goes through lib/llm/ once triggered.

import { getWorkerByPhone } from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';
import { buildIssueCardBlocks } from './issue-card.js';
import { buildIssueRecord } from './issue-record.js';

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
 * Optional real-world context for the reporter, supplied by the SMS path so the
 * filed record can name the worker/site and carry an inbound photo. The Slack
 * path omits it (no phone), and the flow still works with an "Unknown worker".
 * @typedef {Object} IntakeContext
 * @property {string} [phone] - Reporter phone (E.164), e.g. the Twilio `From`.
 * @property {string | null} [photoUrl] - Photo from an inbound MMS/WhatsApp message.
 */

/**
 * Advance the issue-intake flow by one message. When `file_issue` fires this
 * assembles the structured record (issue-record.js) and management-card blocks
 * (issue-card.js) and returns them; posting the card / writing to Procore is
 * wired by the caller, not here.
 * @param {string} channelId
 * @param {string} threadTs
 * @param {string} text
 * @param {IntakeContext} [context]
 * @returns {Promise<{ reply: string, done: boolean, record?: import('./issue-record.js').IssueRecord, cardBlocks?: import('@slack/types').KnownBlock[] }>}
 */
export async function advanceIssueIntake(channelId, threadTs, text, context = {}) {
  const k = key(channelId, threadTs);
  const history = activeFlows.get(k) ?? [];

  /** @type {import('./issue-record.js').IssueRecord | undefined} */
  let filedRecord;
  /** @type {import('@slack/types').KnownBlock[] | undefined} */
  let filedCardBlocks;

  const fileIssueTool = createFileIssueTool(async ({ area, description, photo_url }) => {
    const worker = context.phone ? await getWorkerByPhone(context.phone) : null;

    // TODO: translate into English using the reporter's preferred_language
    // (worker?.preferredLanguage) once translate.js is wired; passthrough today.
    const englishDescription = await translateText(description, 'en');

    const record = buildIssueRecord({
      phone: context.phone ?? 'unknown',
      worker,
      area,
      description: englishDescription,
      photoUrl: photo_url ?? context.photoUrl ?? null,
    });
    filedRecord = record;
    filedCardBlocks = buildIssueCardBlocks(record);

    // TODO: post filedCardBlocks to the management channel
    // (client.chat.postMessage to MANAGEMENT_CHANNEL_ID) and write the record to
    // Procore (REST sandbox) — both wired in the caller once shared plumbing lands.
    return {
      output: `Filed issue: area="${record.area}", reporter="${record.reporter.name}", photo=${record.photoUrl ?? 'none'} (card + Procore write not yet posted live).`,
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

  return { reply: responseText, done, record: filedRecord, cardBlocks: filedCardBlocks };
}
