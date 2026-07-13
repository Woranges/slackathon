// Owner: knowledge-agent feature.
//
// LLM-based comparison of retrieved document excerpts (specs, RFIs, addenda)
// to flag conflicts before the agent answers a field question. Separate from
// rts-engine.js: this compares *external* Procore documents, not Slack history.

import { runLlmTurn } from '../../lib/llm/index.js';

/**
 * @typedef {Object} DocSource
 * @property {string} source - Where this excerpt came from (e.g. "Addendum 3", "Spec 03 30 00").
 * @property {string} text
 */

/**
 * @typedef {Object} ComparisonResult
 * @property {boolean} hasConflict
 * @property {string} summary
 */

const SYSTEM_PROMPT = `\
You compare excerpts from construction project documents (specs, drawings, RFIs, \
addenda) and detect genuine contradictions — places where two or more sources give \
conflicting requirements (different dimensions, materials, dates, or instructions). \
Only flag real conflicts, not differences in wording, formatting, or unrelated \
details. Always call report_contradiction — never answer in plain text. When there \
is a conflict, name which sources disagree and how.`;

/**
 * Build the user-message prompt listing every source excerpt for the model to
 * compare. Small and pure so it can be reasoned about on its own.
 * @param {DocSource[]} sources
 * @returns {string}
 */
function buildComparisonPrompt(sources) {
  const blocks = sources.map((s, i) => `Source ${i + 1} — ${s.source}:\n${s.text}`).join('\n\n');
  return `Compare these document excerpts and decide whether any of them contradict each other:\n\n${blocks}`;
}

/**
 * The real Gemini-backed analyzer: a single forced-tool call that returns a
 * structured verdict. Factored out (and injectable via compareSources) so the
 * comparison logic can be tested without hitting the API.
 * @param {DocSource[]} sources
 * @returns {Promise<ComparisonResult>}
 */
async function analyzeWithGemini(sources) {
  /** @type {ComparisonResult | null} */
  let verdict = null;

  /** @type {import('../../lib/llm/gemini.js').ToolDefinition} */
  const reportTool = {
    functionDeclaration: {
      name: 'report_contradiction',
      description: 'Report whether the provided document excerpts contradict one another.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          hasConflict: {
            type: 'boolean',
            description: 'True if two or more sources give conflicting requirements.',
          },
          summary: {
            type: 'string',
            description: 'One or two sentences. If conflicting, name which sources disagree and how.',
          },
        },
        required: ['hasConflict', 'summary'],
      },
    },
    handler: async (args) => {
      verdict = /** @type {ComparisonResult} */ (args);
      return { output: 'Recorded.' };
    },
  };

  await runLlmTurn({
    systemPrompt: SYSTEM_PROMPT,
    history: [],
    text: buildComparisonPrompt(sources),
    tools: [reportTool],
  });

  if (!verdict) {
    throw new Error('the model did not report a contradiction verdict');
  }
  return verdict;
}

/**
 * Compare document excerpts and flag contradictions between them.
 *
 * Fails safe: if the check cannot be completed (the model errors or returns an
 * unusable result), it reports hasConflict: true so the caller does not treat an
 * unverified answer as safe — see the guardrail in ./contradiction-check.js,
 * where the agent only auto-answers when hasConflict is false.
 * @param {DocSource[]} sources
 * @param {{ analyze?: (sources: DocSource[]) => Promise<ComparisonResult> }} [deps]
 *   analyze is injectable so the comparison can be tested without calling Gemini.
 * @returns {Promise<ComparisonResult>}
 */
export async function compareSources(sources, { analyze = analyzeWithGemini } = {}) {
  if (sources.length === 0) {
    return { hasConflict: false, summary: 'No sources provided.' };
  }
  if (sources.length === 1) {
    return { hasConflict: false, summary: 'Only one source provided; nothing to compare.' };
  }

  try {
    const result = await analyze(sources);
    if (typeof result?.hasConflict !== 'boolean' || typeof result?.summary !== 'string') {
      return {
        hasConflict: true,
        summary: 'Could not verify these sources (unexpected checker response) — flagging for human review.',
      };
    }
    return { hasConflict: result.hasConflict, summary: result.summary };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      hasConflict: true,
      summary: `Could not verify these sources automatically (${detail}) — flagging for human review.`,
    };
  }
}
