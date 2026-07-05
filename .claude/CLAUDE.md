# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A **Starter Agent** for Slack built with Bolt for JavaScript and **Google Gemini** (via `@google/genai`). This started as Slack's official `bolt-js-starter-agent` sample, which offered a Claude Agent SDK and an OpenAI Agents SDK implementation side by side. Both have since been replaced: the OpenAI variant was removed first, then the Claude Agent SDK layer was rewritten to use Gemini directly, chosen for its free tier (1,500 requests/day on Flash models, no credit card) over Anthropic's/OpenAI's one-time signup credits.

On top of the starter template, this repo adds three construction field-operations features, each owned by a different person/team and kept in its own `features/` folder specifically so parallel work doesn't collide — see "Feature ownership" below.

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
agent/                # Shared LLM assistant plumbing: agent.js, tools/ (registry), mcp/ (Procore, shared)
features/              # One folder per owned feature — see "Feature ownership" below
lib/                    # Shared utilities: llm/ (Gemini wrapper), translate, db, twilio
listeners/              # Slack event/action/command/webhook/view registration (thin — delegates to features/)
thread-context/         # Conversation-history store for the LLM assistant's multi-turn conversations
tests/                  # Unit tests
manifest.json            # Slack app manifest (agent_view, MCP, OAuth scopes, slash commands)
app.js                   # Entry point (Socket Mode)
app-oauth.js             # Alternate entry point (HTTP mode, for OAuth distribution)
```

CI runs biome lint and TypeScript checks via `.github/workflows/lint.yml`. Dependabot monitors `package.json` at root.

## Feature ownership

Each of the three field-operations features lives entirely in its own `features/` subfolder,
so two people can work in parallel without touching each other's files. A file's top comment
always states which feature it belongs to (`// Owner: <feature> feature.`).

- **`features/procore-issue-intake/`** — `issue-intake.js`. A worker reports an issue by
  texting "issue"; the bot walks them through area -> photo -> description one question at
  a time, then (once wired up) writes to Procore via the MCP connection in `agent/mcp/procore.js`.
- **`features/safety-broadcast/`** — `broadcast-safety.js` (the `/broadcast-safety "message"
  --site=<site>` slash command) and `inbound-sms.js` (the inbound Twilio webhook — worker
  replies/acknowledgments land here).
- **`features/knowledge-agent/`** — `search-workspace.js` and `contradiction-check.js` (the
  two LLM tools registered on the shared conversational agent), plus their supporting logic,
  `rts-engine.js` and `contradiction.js`.

**Genuinely shared code stays outside `features/`**, since more than one feature needs it:
`agent/mcp/procore.js` (both procore-issue-intake and knowledge-agent), and everything in
`lib/` (translate, db, twilio, the Gemini wrapper). Don't move shared code into one feature's
folder just because that feature happened to need it first — check whether another feature
already imports it before relocating anything.

**`listeners/`** stays thin on purpose: `listeners/commands/index.js` and
`listeners/webhooks/index.js` only import a handler from the relevant `features/` folder and
register it with Bolt/Express — the actual logic lives in `features/`, not `listeners/`.

## LLM vs. deterministic: an intentional split

Not everything here goes through the LLM agent, on purpose. Only use an LLM where the
task genuinely requires reasoning over unstructured input — don't route deterministic
work through it just because Gemini is available.

- **`features/procore-issue-intake/issue-intake.js`** — a plain step-by-step state machine
  (in-memory `Map` keyed by `channelId:threadTs`), hooked into `listeners/events/message.js`
  *before* it falls through to the LLM agent. No LLM call anywhere in this file today —
  though see "Future direction" below, since this is the one place a future LLM upgrade is
  explicitly anticipated.
- **`features/safety-broadcast/broadcast-safety.js`** — the manager already knows exactly
  what they want to send, so there's no ambiguity for a model to resolve — this is a direct
  translate -> fan-out-via-Twilio -> ack-tracking flow, no LLM call.
- **`agent/agent.js`** (the actual LLM-driven part) — a conversational assistant with
  three tools: `add_emoji_reaction`, `check_for_contradictions`, and
  `search_workspace_history`. These three genuinely benefit from an LLM: reacting
  appropriately to open-ended messages, comparing document excerpts for *semantic*
  contradictions (not something regex can do), and deciding whether a natural-language
  question is a search request or a spec question.
- **`features/knowledge-agent/contradiction.js#compareSources`** is a standalone
  prompt-completion call, not routed through the chat/history plumbing in `agent/agent.js`
  — it can call `@google/genai`'s `generateContent` directly rather than going through
  `lib/llm/`'s chat-session wrapper.

**Future direction, on purpose:** `features/procore-issue-intake/issue-intake.js` and
`features/safety-broadcast/broadcast-safety.js` are deliberately rigid right now (exact-match
steps, one question at a time) to keep them simple and free to run. The plan is for
both to eventually call into `lib/llm/` too — e.g. to parse a free-form issue report
in one message instead of three rigid questions, or to make broadcast acknowledgment
detection more forgiving than exact string matches. `lib/llm/` is deliberately
structured as a provider-agnostic layer (`index.js` re-exporting whichever provider
file, currently `gemini.js`) specifically so it's easy to call from these deterministic
features later without re-plumbing anything — don't couple `features/procore-issue-intake/`
or `features/safety-broadcast/` directly to `@google/genai`; go through `lib/llm/`.

## Architecture

Three-layer design for the LLM-driven half: **app.js** -> **listeners/** -> **agent/** (which
pulls tools from **features/knowledge-agent/**). The deterministic half
(**features/procore-issue-intake/**, **features/safety-broadcast/**) is reached via
`listeners/events/message.js` and `listeners/commands/`/`listeners/webhooks/` respectively,
but never touches `agent/`.

**Entry point (`app.js`)** initializes Bolt with Socket Mode and calls `registerListeners(app)`.

**Listeners** are organized by Slack platform feature, and stay thin (see "Feature ownership"):
- `listeners/events/` -- `app-home-opened` (Home tab view + Messages-tab suggested prompts via `event.tab` branch), `app-mentioned`, `message` (checks for the deterministic issue-intake flow before falling through to the LLM agent)
- `listeners/actions/` -- `feedback-buttons`
- `listeners/commands/` -- `/broadcast-safety` (fully deterministic, no LLM)
- `listeners/webhooks/` -- inbound Twilio SMS (HTTP mode only — see `app-oauth.js`)

Each sub-module has a `register(app)` function called from `listeners/index.js`.

**AgentDeps** carries `client`, `userId`, `channelId`, `threadTs`, `messageTs`, `userToken`. Constructed in each listener handler and passed to the agent at runtime.

**Conversation history** (`thread-context/store.js`) is an in-memory `Map` keyed by `channelId:threadTs` with TTL-based cleanup (24h) and a max entry limit (1000). Unlike Claude's server-side session resume by ID, Gemini's chat API needs the full turn history replayed on each call, so this stores `Content[]` arrays (via `ConversationStore`), not a session ID.

**Handler flow** (DM, mention): get history from store -> run agent -> stream response in thread with feedback blocks -> store updated history.

## Gemini Specifics

**Agent (`agent/agent.js`)** builds a list of local tools (`agent/tools/`, which re-exports the two knowledge-agent tools from `features/knowledge-agent/`) and MCP server configs (Slack's, and Procore's if `PROCORE_MCP_URL` is set), then calls `lib/llm/`'s `runLlmTurn()` with the system prompt, prior history, and the new message.

**`lib/llm/gemini.js`** wraps `@google/genai`: creates a chat session via `ai.chats.create({ model, history, config })`, sends the message, and manually dispatches any local function calls (matching by name against the tools passed in) in a loop until the model returns plain text. The loop is capped at `MAX_TOOL_CALL_ROUNDS` (currently 8) — without this, a model stuck in a call-the-same-tool loop could burn through the daily free-tier quota in seconds. MCP-declared tools are executed server-side by Gemini directly against the MCP server — they shouldn't need manual dispatch, but this hasn't been exercised against a live API key + real MCP server yet, so double-check that assumption once both exist. Model is `gemini-3.5-flash` (the current GA model as of May 2026 — check ai.google.dev for anything newer before assuming this is still current).

**Tools** are plain objects — `{ functionDeclaration: { name, description, parametersJsonSchema }, handler }` — not Zod schemas (Gemini's function declarations use JSON Schema directly via `parametersJsonSchema`). Tool handlers return `{ output: ... }` on success or `{ error: ... }` on failure, matching Gemini's own documented convention for `FunctionResponse.response`.

**MCP servers** are declared directly as `{ name, streamableHttpTransport: { url, headers } }` on the `Tool.mcpServers` field — no manual `@modelcontextprotocol/sdk` client/transport setup needed, unlike a fully manual MCP client integration. This field is documented as experimental in `@google/genai`.

**Feedback blocks** use the `context_actions` block type with `feedback_buttons` elements. A single `feedback` action ID is registered.

## Code Style

- ES modules (`"type": "module"` in package.json)
- JSDoc + TypeScript validation (`npm run check` — `tsc --checkJs`)
- Biome for linting and formatting (single quotes, 2-space indent, 120 line width)
- Node.js built-in test runner (`node --test`)
- Kebab-case filenames
