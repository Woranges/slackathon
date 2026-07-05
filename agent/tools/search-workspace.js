// Owner: knowledge-agent feature (search half). Finds a specific past photo,
// message, or thread via Slack's Real-Time Search (RTS) API — distinct from
// the general-purpose search already available through the Slack MCP server,
// which this project claims as one of the hackathon's three named technologies.

import { searchWorkspace } from '../../lib/rtsEngine.js';

const DESCRIPTION =
  'Search Slack workspace history via the Real-Time Search (RTS) API — for finding ' +
  'a specific past photo, message, or thread (e.g. "find the photo of the water damage ' +
  'in the east stairwell from March"). Prefer this over general Slack MCP search when ' +
  'the user is asking to retrieve something specific from history rather than general ' +
  'channel context.';

/**
 * @param {import('../agent.js').AgentDeps} [deps]
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
export function createSearchWorkspaceTool(deps) {
  return {
    functionDeclaration: {
      name: 'search_workspace_history',
      description: DESCRIPTION,
      parametersJsonSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language search query (e.g. "water damage east stairwell March").',
          },
        },
        required: ['query'],
      },
    },
    handler: async ({ query }) => {
      if (!deps?.userToken) {
        return { error: 'Cannot search workspace history: no user token available for this session.' };
      }

      try {
        const results = await searchWorkspace(/** @type {string} */ (query), deps.userToken);
        if (results.length === 0) {
          return { output: `No results found for "${query}".` };
        }
        const formatted = results.map((r) => `- ${r.text}${r.permalink ? ` (${r.permalink})` : ''}`).join('\n');
        return { output: formatted };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { error: `TODO: RTS search not yet wired up (${err.message})` };
      }
    },
  };
}
