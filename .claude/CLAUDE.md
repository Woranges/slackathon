# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A **Starter Agent** for Slack built with Bolt for JavaScript and **Google Gemini** (via `@google/genai`). This started as Slack's official `bolt-js-starter-agent` sample, which offered a Claude Agent SDK and an OpenAI Agents SDK implementation side by side. Both have since been replaced: the OpenAI variant was removed first, then the Claude Agent SDK layer was rewritten to use Gemini directly, chosen for its free tier (1,500 requests/day on Flash models, no credit card) over Anthropic's/OpenAI's one-time signup credits.

On top of the starter template, this repo adds three construction field-operations features — see "LLM vs. deterministic" below for why only one of them is LLM-driven.

## Commands

```sh
# Run the app (requires .env with GEMINI_API_KEY; Slack tokens optional with CLI)
slack run          # via Slack CLI
node app.js        # directly

# Lint and format (CI runs these on push to main and all PRs)
npm run lint

# Type check (JSDoc + TypeScript validation)
npm run check

# Run tests
npm test
```

## Repo Structure

```
.github/              # CI workflows and dependabot config
agent/                # LLM-driven conversational assistant: agent.js, tools/, mcp/
flows/                 # Deterministic (no-LLM) multi-step conversation flows
lib/                    # Shared utilities: llm/ (Gemini wrapper), translate, db, twilio, rtsEngine, contradiction
listeners/              # Slack event/action/command/view handlers
thread-context/         # Conversation-history store for the LLM assistant's multi-turn conversations
tests/                  # Unit tests
manifest.json            # Slack app manifest (agent_view, MCP, OAuth scopes, slash commands)
app.js                   # Entry point (Socket Mode)
app-oauth.js             # Alternate entry point (HTTP mode, for OAuth distribution)
```

CI runs biome lint and TypeScript checks via `.github/workflows/lint.yml`. Dependabot monitors `package.json` at root.

## LLM vs. deterministic: an intentional split

Not everything here goes through the LLM agent, on purpose. Only use an LLM where the
task genuinely requires reasoning over unstructured input — don't route deterministic
work through it just because Gemini is available.

- **`flows/issue-intake.js`** — a worker reports an issue by texting "issue"; the bot
  walks them through area -> photo -> description one question at a time. This is a
  plain step-by-step state machine (in-memory `Map` keyed by `channelId:threadTs`),
  hooked into `listeners/events/message.js` *before* it falls through to the LLM
  agent. No LLM call anywhere in this file today — though see the note below, since
  this is the one place a future LLM upgrade is explicitly anticipated.
- **`listeners/commands/broadcast-safety.js`** — the `/broadcast-safety "message"
  --site=<site>` slash command. The manager already knows exactly what they want to
  send, so there's no ambiguity for a model to resolve — this is a direct
  translate -> fan-out-via-Twilio -> ack-tracking flow, no LLM call.
- **`agent/agent.js`** (the actual LLM-driven part) — a conversational assistant with
  three tools: `add_emoji_reaction`, `check_for_contradictions`, and
  `search_workspace_history`. These three genuinely benefit from an LLM: reacting
  appropriately to open-ended messages, comparing document excerpts for *semantic*
  contradictions (not something regex can do), and deciding whether a natural-language
  question is a search request or a spec question.
- **`lib/contradiction.js#compareSources`** is a standalone prompt-completion call, not
  routed through the chat/history plumbing in `agent/agent.js` — it can call
  `@google/genai`'s `generateContent` directly rather than going through `lib/llm/`'s
  chat-session wrapper.

**Future direction, on purpose:** `flows/issue-intake.js` and
`listeners/commands/broadcast-safety.js` are deliberately rigid right now (exact-match
steps, one question at a time) to keep them simple and free to run. The plan is for
both to eventually call into `lib/llm/` too — e.g. to parse a free-form issue report
in one message instead of three rigid questions, or to make broadcast acknowledgment
detection more forgiving than exact string matches. `lib/llm/` is deliberately
structured as a provider-agnostic layer (`index.js` re-exporting whichever provider
file, currently `gemini.js`) specifically so it's easy to call from these deterministic
flows later without re-plumbing anything — don't couple `flows/` or
`listeners/commands/` directly to `@google/genai`; go through `lib/llm/`.

## Architecture

Three-layer design for the LLM-driven half: **app.js** -> **listeners/** -> **agent/**.
The deterministic half (`flows/`, `listeners/commands/`) bypasses `agent/` entirely.

**Entry point (`app.js`)** initializes Bolt with Socket Mode and calls `registerListeners(app)`.

**Listeners** are organized by Slack platform feature:
- `listeners/events/` -- `app-home-opened` (Home tab view + Messages-tab suggested prompts via `event.tab` branch), `app-mentioned`, `message` (checks for the deterministic issue-intake flow before falling through to the LLM agent)
- `listeners/actions/` -- `feedback-buttons`
- `listeners/commands/` -- `/broadcast-safety` (fully deterministic, no LLM)

Each sub-module has a `register(app)` function called from `listeners/index.js`.

**AgentDeps** carries `client`, `userId`, `channelId`, `threadTs`, `messageTs`, `userToken`. Constructed in each listener handler and passed to the agent at runtime.

**Conversation history** (`thread-context/store.js`) is an in-memory `Map` keyed by `channelId:threadTs` with TTL-based cleanup (24h) and a max entry limit (1000). Unlike Claude's server-side session resume by ID, Gemini's chat API needs the full turn history replayed on each call, so this stores `Content[]` arrays (via `ConversationStore`), not a session ID.

**Handler flow** (DM, mention): get history from store -> run agent -> stream response in thread with feedback blocks -> store updated history.

## Gemini Specifics

**Agent (`agent/agent.js`)** builds a list of local tools (`agent/tools/`) and MCP server configs (Slack's, and Procore's if `PROCORE_MCP_URL` is set), then calls `lib/llm/`'s `runLlmTurn()` with the system prompt, prior history, and the new message.

**`lib/llm/gemini.js`** wraps `@google/genai`: creates a chat session via `ai.chats.create({ model, history, config })`, sends the message, and manually dispatches any local function calls (matching by name against the tools passed in) in a loop until the model returns plain text. MCP-declared tools are executed server-side by Gemini directly against the MCP server — they shouldn't need manual dispatch, but this hasn't been exercised against a live API key + real MCP server yet, so double-check that assumption once both exist.

**Tools** are plain objects — `{ functionDeclaration: { name, description, parametersJsonSchema }, handler }` — not Zod schemas (Gemini's function declarations use JSON Schema directly via `parametersJsonSchema`). Tool handlers return `{ output: ... }` on success or `{ error: ... }` on failure, matching Gemini's own documented convention for `FunctionResponse.response`.

**MCP servers** are declared directly as `{ name, streamableHttpTransport: { url, headers } }` on the `Tool.mcpServers` field — no manual `@modelcontextprotocol/sdk` client/transport setup needed, unlike a fully manual MCP client integration. This field is documented as experimental in `@google/genai`.

**Feedback blocks** use the `context_actions` block type with `feedback_buttons` elements. A single `feedback` action ID is registered.

## Code Style

- ES modules (`"type": "module"` in package.json)
- JSDoc + TypeScript validation (`npm run check` — `tsc --checkJs`)
- Biome for linting and formatting (single quotes, 2-space indent, 120 line width)
- Node.js built-in test runner (`node --test`)
- Kebab-case filenames
