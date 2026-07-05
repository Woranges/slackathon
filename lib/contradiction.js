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
 *
 * This is a single, standalone prompt-completion call — it does NOT need to
 * go through the Claude Agent SDK's tool-calling loop in agent/agent.js, and
 * it doesn't need to use the same provider as that loop. Any provider with a
 * plain chat/completion API works. For a hackathon, Google Gemini's free
 * tier (1,500 req/day on Flash models, no credit card, ai.google.dev) is the
 * most practical choice — it's an ongoing free quota, not a one-time credit
 * like Anthropic's or OpenAI's starter credits.
 *
 * Note: the general conversational agent (agent/agent.js) is still built on
 * @anthropic-ai/claude-agent-sdk regardless of what's chosen here — that's a
 * separate, larger decision (see CLAUDE.md).
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
