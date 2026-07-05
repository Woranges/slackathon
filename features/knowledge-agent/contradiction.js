// Owner: knowledge-agent feature.
//
// LLM-based comparison of retrieved document excerpts (specs, RFIs, addenda)
// to flag conflicts before the agent answers a field question. Separate from
// rts-engine.js: this compares *external* Procore documents, not Slack history.

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

/**
 * Compare document excerpts and flag contradictions between them.
 *
 * This is a single, standalone prompt-completion call — it does NOT need to
 * go through the full chat/tool-calling loop in agent/agent.js (lib/llm/),
 * so it's a good candidate for calling the Gemini API directly here via
 * @google/genai's `generateContent`, independent of the conversation-history
 * plumbing that loop needs.
 * @param {DocSource[]} sources
 * @returns {Promise<ComparisonResult>}
 */
export async function compareSources(sources) {
  if (sources.length === 0) {
    return { hasConflict: false, summary: 'No sources provided.' };
  }

  // TODO: prompt an LLM to diff `sources` and flag contradictions, citing
  // which sources disagree. Keep the guardrail from ./contradiction-check.js:
  // only auto-answer when this returns hasConflict: false.
  throw new Error('Not implemented: wire up features/knowledge-agent/contradiction.js#compareSources');
}
