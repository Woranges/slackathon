// Owner: procore-intake feature. Structured field-issue intake, written back to
// Procore via the MCP connection configured in agent/mcp/procore.js.

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { translateText } from '../../lib/translate.js';

const DESCRIPTION =
  'Create a structured issue/RFI in Procore from a field report (e.g. a text or ' +
  "WhatsApp message describing a site issue). Use this when a worker reports a problem " +
  'that needs to be tracked and assigned, not just answered.';

/**
 * @param {import('../agent.js').AgentDeps} [deps]
 */
export function createProcoreIssueTool(deps) {
  return tool(
    'create_procore_issue',
    DESCRIPTION,
    {
      site: z.string().describe('Project/site identifier the issue belongs to.'),
      area: z.string().describe('Location within the site (e.g. unit or floor number).'),
      description: z.string().describe('One-line description of the issue.'),
      photo_url: z.string().optional().describe('URL of a photo documenting the issue, if one was provided.'),
      reporter_language: z.string().optional().describe("ISO 639-1 code of the reporter's language, if not English."),
    },
    async ({ site, area, description, photo_url, reporter_language }) => {
      const englishDescription =
        reporter_language && reporter_language !== 'en' ? await translateText(description, 'en') : description;

      // TODO: call the Procore MCP tool (e.g. mcp__procore__create_rfi or
      // create_punch_item) via the mcpServers.procore connection in agent.js,
      // passing { site, area, description: englishDescription, photo_url }.
      // TODO: post a confirmation card back to Slack with Assign/Escalate/Resolve
      // buttons (see listeners/actions for the pattern).
      return {
        content: [
          {
            type: 'text',
            text: `TODO: not yet wired to Procore. Would create issue at ${site}/${area}: "${englishDescription}"`,
          },
        ],
      };
    },
  );
}
