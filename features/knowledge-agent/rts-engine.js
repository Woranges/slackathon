// Owner: knowledge-agent feature.
//
// Wrapper around Slack's Real-Time Search (RTS) API — used to let the
// knowledge-agent find prior field reports/photos/threads already living in
// Slack (from procore-issue-intake and safety-broadcast messages) in response
// to a natural-language question. Scoped to the requesting user's own access
// via their user token, same as the existing Slack MCP connection in
// agent/agent.js.

/**
 * @typedef {Object} SearchResult
 * @property {string} text
 * @property {string} permalink
 * @property {string} [user]
 * @property {string} [ts]
 */

/**
 * Search the Slack workspace via the Real-Time Search API.
 * @param {string} query
 * @param {string} userToken
 * @returns {Promise<SearchResult[]>}
 */
export async function searchWorkspace(query, userToken) {
  // TODO: call the RTS API (docs.slack.dev/apis/web-api/real-time-search-api/)
  // with `query`, authenticated as the requesting user via `userToken`.
  throw new Error('Not implemented: wire up features/knowledge-agent/rts-engine.js#searchWorkspace');
}
