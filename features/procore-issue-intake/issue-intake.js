// Owner: procore-issue-intake feature.
//
// LLM-driven structured issue-intake flow. A worker starts it by
// texting/typing "issue"; from there the model gathers area + description
// (photo optional) from however the worker actually phrases it — in one
// message or several, in any order — rather than forcing rigid one-question
// steps. Trigger detection itself stays a cheap keyword check (no LLM cost
// on messages that were never going to start this flow); everything after
// that goes through lib/llm/ once triggered.

import { createProcoreRfi, isProcoreConfigured } from '../../agent/mcp/procore.js';
import { getWorkerByPhone, getWorkerBySlackUserId } from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';
import { buildIssueCardBlocks } from './issue-card.js';
import { buildIssueRecord } from './issue-record.js';

const SYSTEM_PROMPT = `\
You are helping a construction worker report a site issue over text messaging.

Gather two required pieces of information:
- area: the location/area of the issue (e.g. "3rd floor, east stairwell")
- description: a one-line description of the problem

Ask short, casual follow-up questions for whatever's missing. If the worker already gave \
you multiple pieces of information in one message, don't force them through a rigid \
one-field-at-a-time order — just ask about whatever's still missing.

Once you have BOTH area and description, ask once if they can send a photo of the issue \
(a photo is helpful but optional). On their next reply — whether they send/mention a photo, \
decline, or ignore it — call the file_issue tool immediately with what you have. Never \
require a photo, never ask for it more than once, and don't ask for confirmation.`;

/**
 * @param {(args: { area: string, description: string }) => Promise<Record<string, unknown>>} onFileIssue
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
function createFileIssueTool(onFileIssue) {
  return {
    functionDeclaration: {
      name: 'file_issue',
      description: 'File the collected issue report once area and description are both known.',
      // No photo field: the photo is captured deterministically by the listener
      // (an SMS media URL or a Slack DM file id, latched onto the flow), never
      // supplied by the model — exposing a photo_url here just invited the model
      // to hallucinate a URL, which then failed to render as an image block.
      parametersJsonSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'Location/area of the issue.' },
          description: { type: 'string', description: 'One-line description of the issue.' },
        },
        required: ['area', 'description'],
      },
    },
    handler: (args) => onFileIssue(/** @type {{ area: string, description: string }} */ (args)),
  };
}

/** @type {Map<string, import('@google/genai').Content[]>} */
const activeFlows = new Map();

// A worker often sends the photo on a different turn than the one where the model
// finally calls file_issue (e.g. they send the photo, the model says "thanks",
// then files on the next reply). The per-call `context` only carries the photo
// from the current message, so without this the photo would be lost. Latch the
// most recent photo seen anywhere in the flow, keyed like activeFlows, and clear
// it when the flow completes.
/** @type {Map<string, { photoSlackFileId: string | null, photoUrl: string | null }>} */
const flowPhotos = new Map();

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
 * @property {string} [slackUserId] - Reporter's Slack user id (DM path), for identity/site.
 * @property {string | null} [photoUrl] - Photo from an inbound MMS/WhatsApp message.
 * @property {string | null} [photoSlackFileId] - Photo already uploaded in a Slack DM.
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

  // Latch any photo from this turn onto the flow so it survives to file_issue,
  // even if the model files on a later turn that carries no photo.
  const priorPhoto = flowPhotos.get(k);
  const photo = {
    photoSlackFileId: context.photoSlackFileId ?? priorPhoto?.photoSlackFileId ?? null,
    photoUrl: context.photoUrl ?? priorPhoto?.photoUrl ?? null,
  };
  flowPhotos.set(k, photo);

  /** @type {import('./issue-record.js').IssueRecord | undefined} */
  let filedRecord;
  /** @type {import('@slack/types').KnownBlock[] | undefined} */
  let filedCardBlocks;

  const fileIssueTool = createFileIssueTool(async ({ area, description }) => {
    // Resolve the reporter: by phone (SMS path) or Slack user id (DM path).
    const worker =
      (context.phone ? await getWorkerByPhone(context.phone) : null) ??
      (context.slackUserId ? await getWorkerBySlackUserId(context.slackUserId) : null);

    // TODO: translate into English using the reporter's preferred_language
    // (worker?.preferredLanguage) once translate.js is wired; passthrough today.
    const englishDescription = await translateText(description, 'en');

    const record = buildIssueRecord({
      phone: context.phone ?? 'unknown',
      worker,
      slackUserId: context.slackUserId,
      area,
      description: englishDescription,
      photoUrl: photo.photoUrl,
      photoSlackFileId: photo.photoSlackFileId,
    });
    filedRecord = record;
    filedCardBlocks = buildIssueCardBlocks(record);

    // Fire-and-forget the Procore write so the worker's confirmation isn't
    // delayed by the round-trip; log the outcome. Skipped when unconfigured.
    if (isProcoreConfigured()) {
      createProcoreRfi(record)
        .then((r) => console.log(`Procore RFI #${r.id} created`))
        .catch((err) => console.error(`Procore write failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    const hasPhoto = Boolean(record.photoUrl || record.photoSlackFileId);
    return {
      output: `Filed issue: area="${record.area}", reporter="${record.reporter.name}", photo=${hasPhoto ? 'yes' : 'none'}.`,
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
    flowPhotos.delete(k);
  } else {
    activeFlows.set(k, newHistory);
  }

  return { reply: responseText, done, record: filedRecord, cardBlocks: filedCardBlocks };
}
