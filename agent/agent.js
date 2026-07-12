import { runLlmTurn } from '../lib/llm/index.js';
import { getProcoreMcpServerConfig } from './mcp/procore.js';
import { createContradictionCheckTool, createEmojiReactionTool, createSearchWorkspaceTool } from './tools/index.js';

const SYSTEM_PROMPT = `\
You are a friendly Slack assistant. You help people by answering questions, \
having conversations, and being generally useful in Slack.

## PERSONALITY
- Friendly, helpful, and approachable
- Lightly witty — a touch of humor when appropriate, but never forced
- Concise and clear — respect people's time
- Confident but honest when you don't know something

## RESPONSE GUIDELINES
- Keep responses to 3 sentences max — be punchy, scannable, and actionable
- End with a clear next step on its own line so it's easy to spot
- Use a bullet list only for multi-step instructions
- Use casual, conversational language
- Use emoji sparingly — at most one per message, and only to set tone

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > blockquotes
- Use bullet points for multi-step instructions

## EMOJI REACTIONS
For casual or conversational messages (greetings, thanks, small talk), react with \
\`add_emoji_reaction\` before responding — pick a Slack emoji that reflects the *topic* or \
*tone* (e.g. \`dog\` for dog topics, \`books\` for learning, \`wave\` for greetings), and vary \
your picks. But when the user asks you to find, search, look up, or do a task, SKIP the \
reaction and go straight to the work — don't spend a step reacting. Never react more than once.

## FIELD OPERATIONS TOOLS
You may also have access to two construction field-operations tools:
- **check_for_contradictions**: verify project documents agree before answering a spec/drawing question
- **search_workspace_history**: find a specific past photo, message, or thread via Slack's Real-Time Search API

Use \`check_for_contradictions\` before answering any question that touches specs or \
drawings — if it finds a conflict, say so and flag it for a human rather than guessing.

RETRIEVAL — READ THIS: whenever the user asks you to find, look up, recall, search for, \
or "get" something from the past (a photo, message, thread, report, RFI, question, or a \
past decision — e.g. "find the door schedule RFI", "get me the report from earlier", \
"what did we decide about the handrail"), you MUST call \`search_workspace_history\` with a \
short query FIRST, and base your answer on its results. NEVER reply that you couldn't find \
something, or that it's not in the history, without having called \`search_workspace_history\` \
on that turn. Prefer it over general Slack MCP search for any such retrieval request.

You may also have access to the Slack MCP Server (search messages/files, read channel \
history and threads, send messages, manage canvases) and/or a Procore MCP connection \
(project documents) — use them whenever they'd help answer a question.

Note: structured issue reporting ("issue") and safety broadcasts (\`/broadcast-safety\`) are \
handled outside this conversational agent entirely — see features/procore-issue-intake/ and \
features/safety-broadcast/. Neither needs an LLM, so don't expect to see them \
called as tools here.`;

const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

// Model for the conversational agent. Overridable via AGENT_MODEL.
const AGENT_MODEL = process.env.AGENT_MODEL ?? 'gemini-3.5-flash';

// Retrieval is handled deterministically rather than trusting the model to decide
// to call the search tool (small models skip it; the reliable ones burn quota).
// When the message clearly asks to find/recall something from history, we run the
// workspace search ourselves (a free Slack API call) and hand the model the
// results to phrase — so RTS fires every time, on any model. The tool stays
// registered for anything this pattern doesn't catch.
const RETRIEVAL_RE =
  /\b(find|search|look ?up|looking for|recall|pull up|dig up|get me|show me|where('?s| is| are)?|did (anyone|someone)|what did we (decide|say))\b/i;

/**
 * Reduce a natural-language retrieval request to search keywords. The RTS API
 * matches on terms, so the full sentence ("find the door schedule RFI from
 * earlier") returns nothing while "door schedule" returns the cards — strip the
 * retrieval verbs, temporal filler, and stopwords down to the meaningful nouns.
 * @param {string} text
 * @returns {string} The cleaned query, or the original text if stripping left nothing.
 */
function toSearchQuery(text) {
  const cleaned = text
    .toLowerCase()
    .replace(/\b(can|could|would) you\b/g, ' ')
    .replace(
      /\b(find|search(\s+for)?|look\s?up|looking for|recall|pull up|dig up|get me|show me|where('?s| is| are)?|did (anyone|someone)|what did we (decide|say)|please)\b/g,
      ' ',
    )
    .replace(/\bfrom (earlier|before)\b/g, ' ')
    .replace(/\b(the|a|an|for|me|us|about|that|this|from|earlier|recently|our|in|history|rfi)\b/g, ' ')
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 2 ? cleaned : text;
}

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 */

/**
 * Run the agent with the given text and prior conversation history.
 * @param {string} text - The user's message text.
 * @param {import('@google/genai').Content[]} [history] - Prior turns for this thread (empty for a new conversation).
 * @param {AgentDeps} [deps] - Dependencies for tools that need Slack API access.
 * @returns {Promise<{ responseText: string, history: import('@google/genai').Content[] }>}
 */
export async function runAgent(text, history = [], deps = undefined) {
  const searchTool = createSearchWorkspaceTool(deps);
  const tools = [createEmojiReactionTool(deps), createContradictionCheckTool(deps), searchTool];

  // Deterministic retrieval: if the user is clearly asking to find something from
  // the past, run the workspace search up front and give the model the results,
  // so RTS fires every time instead of depending on the model to call the tool.
  let augmentedText = text;
  if (RETRIEVAL_RE.test(text)) {
    try {
      const result = await searchTool.handler({ query: toSearchQuery(text) });
      const found = /** @type {any} */ (result).output;
      if (found) {
        augmentedText =
          `${text}\n\n[System: I searched the workspace history for this request. Results below — ` +
          `answer using them and include the relevant Slack link. Do NOT say you couldn't find it ` +
          `when results are shown.\n${found}\n]`;
      }
    } catch {
      // Best-effort — fall through to a normal turn (the tool is still registered).
    }
  }

  /** @type {import('../lib/llm/gemini.js').McpServerConfig[]} */
  const mcpServers = [];

  if (deps?.userToken) {
    mcpServers.push({ name: 'slack-mcp', url: SLACK_MCP_URL, headers: { Authorization: `Bearer ${deps.userToken}` } });
  }

  const procoreMcpConfig = getProcoreMcpServerConfig();
  if (procoreMcpConfig) {
    mcpServers.push(procoreMcpConfig);
  }

  return runLlmTurn({ systemPrompt: SYSTEM_PROMPT, history, text: augmentedText, tools, mcpServers, model: AGENT_MODEL });
}
