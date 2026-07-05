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
  texting "issue"; an LLM conversation (via `lib/llm/`) gathers area + description
  (photo optional) from however they actually phrase it, then (once wired up) writes to
  Procore via the MCP connection in `agent/mcp/procore.js`.
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

## Where the LLM is actually used

All three features now go through `lib/llm/` (Gemini). This is a deliberate reversal from
an earlier version of this repo where issue-intake and safety-broadcast were kept fully
deterministic (rigid keyword/regex matching, no model call) specifically to avoid cost and
non-determinism. That tradeoff was revisited: rigid state machines and exact-match parsing
get unmanageable fast as real-world phrasing varies, so all three features now call into
`lib/llm/` — each with its own narrow system prompt and tool(s), not a shared conversation.

- **`features/procore-issue-intake/issue-intake.js`** — an LLM conversation gathers area +
  description (photo optional) from however the worker phrases it, across as many messages
  as it takes, then calls a local `file_issue` tool once it has enough. Per-thread history
  (`Content[]`) is tracked in an in-memory `Map`, separate from the general assistant's
  `ConversationStore`. Trigger detection ("does this message start the flow") stays a plain
  keyword check — no LLM cost on messages that were never going to start this flow.
- **`features/safety-broadcast/broadcast-safety.js`** — a single-shot LLM call extracts
  `{ message, site }` from however the manager phrases the slash-command text (not a rigid
  `"message" --site=<site>` syntax), via a forced tool call rather than parsing plain text.
- **`features/safety-broadcast/inbound-sms.js`** — a single-shot LLM call classifies an
  inbound SMS reply as `acknowledgment` / `issue_report` / `other`, since real acknowledgment
  replies vary ("got it", "👍", "roger") far more than an exact `"OK"` match would catch.
- **`agent/agent.js`** — the general conversational assistant, with three tools:
  `add_emoji_reaction`, `check_for_contradictions`, `search_workspace_history`.
- **`features/knowledge-agent/contradiction.js#compareSources`** is a standalone
  prompt-completion call, not routed through the chat/history plumbing in `agent/agent.js`
  — it can call `@google/genai`'s `generateContent` directly rather than going through
  `lib/llm/`'s chat-session wrapper.

**Why `lib/llm/` exists as its own layer, not just inline `@google/genai` calls everywhere:**
so a future provider swap (or per-feature provider choice) only touches one file
(`lib/llm/index.js`) instead of every call site. Don't import `@google/genai` directly from
`features/` or `agent/` — always go through `lib/llm/`.

**Cost/predictability tradeoff, worth knowing:** every one of these features now makes at
least one Gemini call per interaction. `MAX_TOOL_CALL_ROUNDS` in `lib/llm/gemini.js` guards
against a runaway loop in any of them. If cost or determinism ever becomes a real problem
for `broadcast-safety.js` or `inbound-sms.js` specifically (both are single-shot extraction
calls, easy to fall back to regex/keyword matching if needed), that's a narrower, cheaper
rollback than undoing the whole LLM integration.

## Architecture

**app.js** -> **listeners/** -> either **agent/** (general assistant, pulling tools from
**features/knowledge-agent/**) or directly into **features/procore-issue-intake/** /
**features/safety-broadcast/**, each running its own separate `lib/llm/` call rather than
sharing the general assistant's conversation.

**Entry point (`app.js`)** initializes Bolt with Socket Mode and calls `registerListeners(app)`.

**Listeners** are organized by Slack platform feature, and stay thin (see "Feature ownership"):
- `listeners/events/` -- `app-home-opened` (Home tab view + Messages-tab suggested prompts via `event.tab` branch), `app-mentioned`, `message` (checks for an active/triggered issue-intake flow before falling through to the general LLM agent)
- `listeners/actions/` -- `feedback-buttons`
- `listeners/commands/` -- `/broadcast-safety` (its own LLM call, separate from the general agent)
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
