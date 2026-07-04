// Owner: knowledge-agent feature. Checks whether project documents (specs, RFIs,
// addenda) agree on a topic, via the Procore MCP connection, before answering.

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { compareSources } from '../../lib/contradiction.js';

const DESCRIPTION =
  'Check whether project documents (specs, drawings, RFIs, addenda) agree on a topic ' +
  'before answering a field question. Use this whenever a question touches spec or ' +
  'drawing details — if sources conflict, do not answer directly; flag it for a human.';

/**
 * @param {import('../agent.js').AgentDeps} [deps]
 */
export function createContradictionCheckTool(deps) {
  return tool(
    'check_for_contradictions',
    DESCRIPTION,
    {
      topic: z.string().describe('The spec/drawing topic or question to check (e.g. "rebar spacing in zone 3").'),
    },
    async ({ topic }) => {
      // TODO: retrieve relevant sources for `topic` via the Procore MCP connection
      // (mcp__procore__*, configured in agent/mcp/procore.js) — e.g. latest drawing
      // revision, spec section, addenda, prior RFI answers.
      // TODO: pass retrieved sources to lib/contradiction.js#compareSources.
      const result = await compareSources([]);

      return {
        content: [
          {
            type: 'text',
            text: result.hasConflict
              ? `Contradiction found on "${topic}": ${result.summary}`
              : `TODO: not yet wired to Procore MCP — no sources checked for "${topic}" yet.`,
          },
        ],
      };
    },
  );
}
