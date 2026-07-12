// Owner: knowledge-agent feature.
//
// Wrapper around Slack's Real-Time Search (RTS) API (`assistant.search.context`)
// — used to let the knowledge-agent find prior field reports/photos/threads
// already living in Slack (from procore-issue-intake and safety-broadcast
// messages) in response to a natural-language question.
//
// Token: RTS accepts a user token (xoxp-, no action_token needed) OR a bot token
// (which additionally requires an event-derived action_token). We use a user
// token — supplied per-call or via SLACK_USER_TOKEN — because it needs no action
// context and works from any handler (DM, mention). Scopes the token needs:
// search:read.public (+ search:read.im / .private / .files / .users for DMs,
// private channels, files). See docs.slack.dev/apis/web-api/real-time-search-api.

const RTS_URL = 'https://slack.com/api/assistant.search.context';

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
 * @param {string} [userToken] - A user token (xoxp-); falls back to SLACK_USER_TOKEN.
 * @returns {Promise<SearchResult[]>}
 */
export async function searchWorkspace(query, userToken) {
  const token = userToken || process.env.SLACK_USER_TOKEN;
  if (!token) {
    throw new Error('No Slack user token — set SLACK_USER_TOKEN (xoxp-) with search:read.* scopes.');
  }

  const res = await fetch(RTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      query,
      content_types: ['messages', 'files'],
      // Search shared site channels, not DMs — a manager asking "find the RFI"
      // wants the posted cards in #site-issues, not incidental DM chatter.
      channel_types: ['public_channel', 'private_channel'],
      limit: 10,
    }),
  });

  const data = /** @type {any} */ (await res.json());
  if (!data.ok) {
    throw new Error(`RTS search failed: ${data.error ?? res.status}`);
  }

  // Slack returns empty `content` for block-only bot messages (our issue cards),
  // even though it indexed and matched their text. Fall back to a channel label so
  // the result is still usable — results are ranked by relevance, so the top match
  // for e.g. "door schedule" is the right card even without a text preview.
  /** @type {SearchResult[]} */
  const messages = (data.results?.messages ?? []).map((/** @type {any} */ m) => ({
    text: (m.content ?? '').trim() || `report card in #${m.channel_name ?? 'a channel'}`,
    permalink: m.permalink ?? '',
    user: m.author_name,
    ts: m.message_ts,
  }));
  /** @type {SearchResult[]} */
  const files = (data.results?.files ?? []).map((/** @type {any} */ f) => ({
    text: f.title || f.name || 'file',
    permalink: f.permalink ?? f.url_private ?? '',
    user: f.author_name,
    ts: f.timestamp ? String(f.timestamp) : undefined,
  }));
  return [...messages, ...files];
}
