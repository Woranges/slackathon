// Gemini-backed LLM turn runner. Chosen for its free tier (no credit card) over
// Anthropic/OpenAI's one-time signup credits. NOTE: free-tier daily request
// caps are per-model and vary widely — gemini-3.5-flash is only 20 req/day,
// while gemini-3.1-flash-lite is 500 req/day (as of 2026-07). Each interaction
// here can spend several requests (one per message + tool-call rounds), so the
// default is the higher-quota flash-lite model, and it stays env-overridable via
// GEMINI_MODEL to switch to a more capable model/paid tier without a code change.
// MCP support (Tool.mcpServers) is present in the SDK but documented as
// experimental — worth re-verifying against a live run once GEMINI_API_KEY and a
// real MCP server are both configured; this was built against @google/genai's
// actual .d.ts files, not just docs, but hasn't been exercised against the live
// API yet.

import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';

// Hard cap on tool-calling rounds per turn. Without this, a model stuck in a
// call-the-same-tool loop (a known function-calling failure mode when a
// tool's response doesn't give it enough to stop) can burn through the daily
// free-tier quota in seconds instead of over a day of normal use.
const MAX_TOOL_CALL_ROUNDS = 8;

/**
 * @typedef {Object} ToolDefinition
 * @property {import('@google/genai').FunctionDeclaration} functionDeclaration
 * @property {(args: Record<string, unknown>) => Promise<Record<string, unknown>>} handler
 */

/**
 * @typedef {Object} McpServerConfig
 * @property {string} name
 * @property {string} url
 * @property {Record<string, string>} [headers]
 */

/**
 * Run one turn of a conversation against Gemini, with local function-calling
 * tools and/or MCP servers declared directly (no manual MCP client/transport
 * management needed — see agent/mcp/procore.js).
 * @param {Object} params
 * @param {string} params.systemPrompt
 * @param {import('@google/genai').Content[]} params.history - Prior turns (empty for a new conversation).
 * @param {string} params.text - The new user message.
 * @param {ToolDefinition[]} [params.tools] - Local tools, dispatched by function name.
 * @param {McpServerConfig[]} [params.mcpServers] - Remote MCP servers, executed server-side by Gemini.
 * @returns {Promise<{ responseText: string, history: import('@google/genai').Content[] }>}
 */
export async function runLlmTurn({ systemPrompt, history, text, tools = [], mcpServers = [] }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set — see .env.sample');
  }

  const ai = new GoogleGenAI({ apiKey });
  const handlers = new Map(tools.map((t) => [t.functionDeclaration.name, t.handler]));

  /** @type {import('@google/genai').Tool[]} */
  const toolConfig = [];
  if (tools.length > 0) {
    toolConfig.push({ functionDeclarations: tools.map((t) => t.functionDeclaration) });
  }
  if (mcpServers.length > 0) {
    toolConfig.push({
      mcpServers: mcpServers.map((s) => ({
        name: s.name,
        streamableHttpTransport: { url: s.url, headers: s.headers },
      })),
    });
  }

  const chat = ai.chats.create({
    model: MODEL,
    history,
    config: {
      systemInstruction: systemPrompt,
      ...(toolConfig.length > 0 && { tools: toolConfig }),
    },
  });

  let response = await chat.sendMessage({ message: text });

  // Dispatch our own local tool calls manually. MCP-declared tools (above)
  // are executed server-side by Gemini directly against the MCP server, so
  // they shouldn't surface as pending function calls here — this loop only
  // needs to resolve names present in our own `handlers` map.
  let round = 0;
  while (response.functionCalls && response.functionCalls.length > 0) {
    round += 1;
    if (round > MAX_TOOL_CALL_ROUNDS) {
      throw new Error(
        `Exceeded ${MAX_TOOL_CALL_ROUNDS} tool-call rounds in a single turn — stopping to avoid a runaway loop burning through the daily quota.`,
      );
    }

    /** @type {Record<string, unknown>[]} */
    const responseParts = [];
    for (const call of response.functionCalls) {
      const handler = call.name ? handlers.get(call.name) : undefined;
      const result = handler ? await handler(call.args ?? {}) : { error: `No handler registered for ${call.name}` };
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }
    response = await chat.sendMessage({ message: responseParts });
  }

  return { responseText: response.text ?? '', history: chat.getHistory() };
}
