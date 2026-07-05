// Owner: knowledge-agent feature. Checks whether project documents (specs,
// RFIs, addenda) agree on a topic, via the Procore MCP connection, before
// answering.

import { compareSources } from './contradiction.js';

const DESCRIPTION =
  'Check whether project documents (specs, drawings, RFIs, addenda) agree on a topic ' +
  'before answering a field question. Use this whenever a question touches spec or ' +
  'drawing details — if sources conflict, do not answer directly; flag it for a human.';

/**
 * @param {import('../../agent/agent.js').AgentDeps} [deps]
 * @returns {import('../../lib/llm/gemini.js').ToolDefinition}
 */
export function createContradictionCheckTool(deps) {
  return {
    functionDeclaration: {
      name: 'check_for_contradictions',
      description: DESCRIPTION,
      parametersJsonSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The spec/drawing topic or question to check (e.g. "rebar spacing in zone 3").',
          },
        },
        required: ['topic'],
      },
    },
    handler: async ({ topic }) => {
      // TODO: retrieve relevant sources for `topic` via the Procore MCP
      // connection (declared in agent/agent.js's mcpServers) — e.g. latest
      // drawing revision, spec section, addenda, prior RFI answers.
      // TODO: pass retrieved sources to ./contradiction.js#compareSources.
      const result = await compareSources([]);

      return result.hasConflict
        ? { output: `Contradiction found on "${topic}": ${result.summary}` }
        : { output: `TODO: not yet wired to Procore MCP — no sources checked for "${topic}" yet.` };
    },
  };
}
