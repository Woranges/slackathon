// MCP connection to Procore, used by check_for_contradictions. Don't build
// the MCP protocol layer from scratch — use one of, in order of preference:
//   1. Procore's own official MCP setup (developers.procore.com/documentation/procore-ai-edge-mcp-setup)
//   2. Pipedream's hosted MCP endpoint (mcp.pipedream.com/app/procore)
//   3. A self-hosted community MCP server, only after reading its source —
//      it will hold live Procore OAuth credentials.
// Whichever is used, point PROCORE_MCP_URL (and PROCORE_MCP_TOKEN, if the
// chosen option needs a bearer token) at it in .env.

const PROCORE_MCP_URL = process.env.PROCORE_MCP_URL;
const PROCORE_MCP_TOKEN = process.env.PROCORE_MCP_TOKEN;

/**
 * Build the Procore MCP server config for agent.js's `mcpServers` list.
 * Returns null when not configured, so callers can omit it conditionally
 * (mirrors how the Slack MCP server is only added when a user token exists).
 * @returns {import('../../lib/llm/gemini.js').McpServerConfig | null}
 */
export function getProcoreMcpServerConfig() {
  if (!PROCORE_MCP_URL) return null;

  return {
    name: 'procore',
    url: PROCORE_MCP_URL,
    ...(PROCORE_MCP_TOKEN && { headers: { Authorization: `Bearer ${PROCORE_MCP_TOKEN}` } }),
  };
}
