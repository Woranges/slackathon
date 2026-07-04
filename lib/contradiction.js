// LLM-based comparison of retrieved document excerpts (specs, RFIs, addenda)
// to flag conflicts before the agent answers a field question. Separate from
// rtsEngine.js: this compares *external* Procore documents, not Slack history.

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
 * @param {DocSource[]} sources
 * @returns {Promise<ComparisonResult>}
 */
export async function compareSources(sources) {
  if (sources.length === 0) {
    return { hasConflict: false, summary: 'No sources provided.' };
  }

  // TODO: prompt an LLM to diff `sources` and flag contradictions, citing
  // which sources disagree. Keep the guardrail from agent/tools/contradiction-check.js:
  // only auto-answer when this returns hasConflict: false.
  throw new Error('Not implemented: wire up lib/contradiction.js#compareSources');
}
