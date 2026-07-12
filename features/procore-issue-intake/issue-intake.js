// Owner: procore-issue-intake feature.
//
// Deterministic, code-controlled issue-intake flow. A worker starts it by
// texting/typing "issue"; from there a slot-filling state machine gathers the
// report. The key design choice: THE CODE OWNS THE FLOW, the LLM only extracts
// fields from each message. Earlier this whole conversation was LLM-driven and
// it was unreliable — it would skip a required field, ask twice, or forget the
// photo. Now the model is a pure extractor and the state machine guarantees the
// order: collect the required slots -> ask for a photo exactly once -> file ->
// confirm. The photo is tracked entirely in code (never handed to the model),
// which is what previously got "forgotten".
//
// Two streams, classified from the first message:
//   - safety: an immediate hazard / danger / injury risk. Extra required slot:
//     severity. Filed as a high-priority RFI tagged SAFETY.
//   - rfi: a question or field condition needing an office/engineer answer.
//     Optional slot: a drawing/spec reference. Filed as a standard RFI.
//
// Language: the same extraction call reports the language of each message, so the
// bot mirrors the worker's language in its replies and follows a mid-conversation
// switch (Spanish -> Spanish until they write English -> then English). What gets
// filed to Slack/Procore is always normalized to English for the office. All of
// this degrades to English-only if the model/translation call fails.

import { createProcoreRfi, isProcoreConfigured } from '../../agent/mcp/procore.js';
import { getWorkerByPhone, getWorkerBySlackUserId } from '../../lib/db.js';
import { runLlmTurn } from '../../lib/llm/index.js';
import { translateText } from '../../lib/translate.js';
import { buildIssueRecord } from './issue-record.js';

/**
 * @typedef {'safety' | 'rfi'} ReportStream
 * @typedef {Object} Slots
 * @property {string | null} location
 * @property {string | null} description
 * @property {string | null} severity - Safety only: immediate_danger | urgent | normal.
 * @property {string | null} specReference - RFI only: a drawing/spec/detail reference.
 * @typedef {Object} FlowState
 * @property {ReportStream | null} stream
 * @property {Slots} slots
 * @property {boolean} photoAsked
 * @property {{ photoSlackFileId: string | null, photoUrl: string | null }} photo
 * @property {string | null} lastQuestion
 * @property {string} language - ISO 639-1 code of the language the worker is writing in;
 *   the bot's replies are mirrored into it, and it follows switches turn-to-turn. Defaults 'en'.
 */

const EXTRACT_SYSTEM = `\
You extract structured fields from a construction worker's message during a site issue report.
Always call update_report; never reply in plain text. Include ONLY fields actually present in
their latest message — omit anything not mentioned (do not guess or repeat prior values).

report_type: "safety" for an immediate hazard, danger, or injury risk; "rfi" for a question or
field condition needing an answer/clarification from the office or engineer.`;

const PHOTO_QUESTION = 'Thanks. Can you send a photo of it? (Optional — just reply "no" if you can\'t.)';

/**
 * The extraction tool. Its handler captures whatever the model parsed out of the
 * latest message; the state machine (not the model) decides what to do with it.
 * @param {(fields: Record<string, string>) => void} onExtract
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
function createUpdateReportTool(onExtract) {
  return {
    functionDeclaration: {
      name: 'update_report',
      description: 'Record the report details found in the latest worker message.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          report_type: {
            type: 'string',
            enum: ['safety', 'rfi'],
            description:
              'safety = immediate hazard/danger/injury risk; rfi = a question or field issue needing an office answer.',
          },
          location: { type: 'string', description: 'Where it is — building/floor/area. Omit if not mentioned.' },
          description: { type: 'string', description: 'What the issue or question is. Omit if not mentioned.' },
          severity: {
            type: 'string',
            enum: ['immediate_danger', 'urgent', 'normal'],
            description: 'Safety reports only: how urgent. Omit if not a safety report or not mentioned.',
          },
          spec_reference: {
            type: 'string',
            description:
              'RFIs only: a drawing/spec/detail reference if mentioned (e.g. "Detail 5/A-301"). Omit if none.',
          },
          language: {
            type: 'string',
            description:
              'ISO 639-1 code of the language THIS message is written in (e.g. "en", "es", "zh"). Omit if the message is too short or ambiguous to tell (e.g. "ok", "no", a number).',
          },
        },
        required: ['report_type'],
      },
    },
    handler: async (args) => {
      onExtract(/** @type {Record<string, string>} */ (args));
      return { output: 'ok' };
    },
  };
}

/** @type {Map<string, FlowState>} */
const activeFlows = new Map();

/** @returns {FlowState} */
function newFlowState() {
  return {
    stream: null,
    slots: { location: null, description: null, severity: null, specReference: null },
    photoAsked: false,
    photo: { photoSlackFileId: null, photoUrl: null },
    lastQuestion: null,
    language: 'en',
  };
}

/**
 * Localize a canonical (English) reply into the worker's current language. A
 * no-op for English so an English conversation makes zero translation calls;
 * kept best-effort by translateText (returns the English text if the model call
 * fails), so a translation hiccup never blocks the reply.
 * @param {string} text
 * @param {string} language - ISO 639-1 code.
 * @returns {Promise<string>}
 */
async function localize(text, language) {
  if (!language || language.toLowerCase().startsWith('en')) return text;
  return translateText(text, language);
}

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
 * The required slots for a stream, in the order they're asked.
 * @param {ReportStream} stream
 * @returns {(keyof Slots)[]}
 */
function requiredSlots(stream) {
  return stream === 'safety' ? ['location', 'description', 'severity'] : ['location', 'description'];
}

/**
 * Pure flow decision: given the current state, what happens next? Kept pure so
 * the ordering guarantees (required slots first, photo asked exactly once, then
 * file) are unit-testable without the LLM.
 * @param {FlowState} state
 * @returns {{ action: 'ask', field: keyof Slots } | { action: 'askPhoto' } | { action: 'file' }}
 */
export function nextStep(state) {
  const stream = state.stream ?? 'rfi';
  const missing = requiredSlots(stream).find((s) => !state.slots[s]);
  if (missing) return { action: 'ask', field: missing };
  if (!state.photoAsked) return { action: 'askPhoto' };
  return { action: 'file' };
}

/**
 * The deterministic question for a missing slot.
 * @param {keyof Slots} field
 * @param {ReportStream} stream
 * @returns {string}
 */
export function questionFor(field, stream) {
  switch (field) {
    case 'location':
      return 'Where is this — which building, floor, and area?';
    case 'description':
      return stream === 'safety' ? "Got it. What's the hazard?" : "Got it. What's the question or issue?";
    case 'severity':
      return 'Is anyone in immediate danger right now, or is this a hazard to flag for follow-up?';
    default:
      return 'Can you tell me a bit more?';
  }
}

/**
 * Run the extractor over one message. Returns the fields the model parsed out
 * (report_type, location, description, severity, spec_reference).
 * @param {string} text
 * @param {FlowState} state
 * @returns {Promise<Record<string, string>>}
 */
async function extractFields(text, state) {
  /** @type {Record<string, string>} */
  let fields = {};
  const tool = createUpdateReportTool((f) => {
    fields = f;
  });

  const known = JSON.stringify(state.slots);
  const context = state.lastQuestion
    ? `You just asked the worker: "${state.lastQuestion}". Map their reply to the right field.`
    : 'This is the start of the report.';
  const systemPrompt = `${EXTRACT_SYSTEM}\n\nKnown so far: ${known}\n${context}`;

  await runLlmTurn({ systemPrompt, history: [], text, tools: [tool] });
  return fields;
}

/**
 * Assemble the record and write the Procore RFI (awaited, so the confirmation
 * can cite the RFI number). Returns the record + the RFI result (null when
 * Procore is unconfigured or the write fails — the report is never blocked on it).
 * @param {FlowState} state
 * @param {IntakeContext} context
 * @returns {Promise<{ record: import('./issue-record.js').IssueRecord, rfi: { id: number, url: string | null } | null }>}
 */
async function fileReport(state, context) {
  const worker =
    (context.phone ? await getWorkerByPhone(context.phone) : null) ??
    (context.slackUserId ? await getWorkerBySlackUserId(context.slackUserId) : null);

  // Normalize the report to English for the office (Slack card + Procore RFI),
  // even though the conversation happened in the worker's language. Only translate
  // when the worker wasn't already writing English, so English reports make no
  // extra calls; best-effort (translateText returns the original on failure).
  const isEnglish = !state.language || state.language.toLowerCase().startsWith('en');
  const englishDescription = isEnglish
    ? (state.slots.description ?? '')
    : await translateText(state.slots.description ?? '', 'en');
  const englishLocation =
    isEnglish || !state.slots.location ? state.slots.location : await translateText(state.slots.location, 'en');

  const record = buildIssueRecord({
    phone: context.phone ?? 'unknown',
    worker,
    slackUserId: context.slackUserId,
    area: englishLocation ?? 'Unspecified',
    description: englishDescription,
    reportType: state.stream ?? 'rfi',
    severity: state.slots.severity,
    specReference: state.slots.specReference,
    photoUrl: state.photo.photoUrl,
    photoSlackFileId: state.photo.photoSlackFileId,
  });

  /** @type {{ id: number, url: string | null } | null} */
  let rfi = null;
  if (isProcoreConfigured()) {
    try {
      rfi = await createProcoreRfi(record);
      console.log(`Procore RFI #${rfi.id} created`);
    } catch (err) {
      console.error(`Procore write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { record, rfi };
}

/**
 * @param {ReportStream} stream
 * @param {{ id: number, url: string | null } | null} rfi
 * @returns {string}
 */
function confirmation(stream, rfi) {
  const kind = stream === 'safety' ? 'safety report' : 'RFI';
  return rfi
    ? `✅ Thanks — I've filed this as ${kind} #${rfi.id} in Procore. The team will follow up.`
    : `✅ Thanks — your ${kind} has been logged and the team will follow up.`;
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
 * Advance the intake flow by one message. The state machine (not the model)
 * decides whether to ask for a missing slot, ask for a photo, or file.
 * @param {string} channelId
 * @param {string} threadTs
 * @param {string} text
 * @param {IntakeContext} [context]
 * @returns {Promise<{ reply: string, done: boolean, record?: import('./issue-record.js').IssueRecord, rfi?: { id: number, url: string | null } | null }>}
 */
export async function advanceIssueIntake(channelId, threadTs, text, context = {}) {
  const k = key(channelId, threadTs);
  const state = activeFlows.get(k) ?? newFlowState();
  activeFlows.set(k, state);

  // Latch the photo in code — the model never sees or manages it, which is what
  // previously got it "forgotten". Any photo seen on any turn survives to filing.
  if (context.photoSlackFileId) state.photo.photoSlackFileId = context.photoSlackFileId;
  if (context.photoUrl) state.photo.photoUrl = context.photoUrl;

  // Only run the extractor when there's text to parse (a photo-only message has
  // none). Skipping it also saves an LLM call on the photo turn.
  if (text?.trim()) {
    const fields = await extractFields(text, state);
    if (!state.stream && (fields.report_type === 'safety' || fields.report_type === 'rfi')) {
      state.stream = fields.report_type;
    }
    if (fields.location) state.slots.location = fields.location;
    if (fields.description) state.slots.description = fields.description;
    if (fields.severity) state.slots.severity = fields.severity;
    if (fields.spec_reference) state.slots.specReference = fields.spec_reference;
    // Mirror the worker's language, and follow switches turn-to-turn. Only update
    // when the model is confident enough to report one (it omits it for short,
    // ambiguous replies like "ok"/"no"), so the language stays sticky otherwise.
    if (fields.language) state.language = fields.language;
  }
  // If the model never classified (e.g. a photo-only opener), default to rfi.
  if (!state.stream) state.stream = 'rfi';

  // lastQuestion is kept in English (it's internal context for the extractor);
  // only the outgoing reply is localized into the worker's language.
  const step = nextStep(state);
  if (step.action === 'ask') {
    state.lastQuestion = questionFor(step.field, state.stream);
    return { reply: await localize(state.lastQuestion, state.language), done: false };
  }
  if (step.action === 'askPhoto') {
    state.photoAsked = true;
    state.lastQuestion = PHOTO_QUESTION;
    return { reply: await localize(PHOTO_QUESTION, state.language), done: false };
  }

  const { record, rfi } = await fileReport(state, context);
  activeFlows.delete(k);
  return { reply: await localize(confirmation(state.stream, rfi), state.language), done: true, record, rfi };
}
