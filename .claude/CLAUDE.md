# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A **Starter Agent** for Slack built with Bolt for JavaScript and the **Claude Agent SDK**. This started as Slack's official `bolt-js-starter-agent` sample (which offered both a Claude Agent SDK and an OpenAI Agents SDK implementation side by side); the OpenAI variant has been removed and the Claude Agent SDK app flattened to the repo root, since this repo is committed to a single framework.

This is a minimal starter template. It includes one example tool (emoji reactions) and optional Slack MCP Server integration.

## Commands

```sh
# Run the app (requires .env with ANTHROPIC_API_KEY; Slack tokens optional with CLI)
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
lib/                    # Shared utilities: translate, db, twilio, rtsEngine, contradiction
listeners/              # Slack event/action/command/view handlers
thread-context/         # Session-ID store for the LLM assistant's multi-turn conversations
tests/                  # Unit tests
manifest.json            # Slack app manifest (agent_view, MCP, OAuth scopes, slash commands)
app.js                   # Entry point (Socket Mode)
app-oauth.js             # Alternate entry point (HTTP mode, for OAuth distribution)
```

CI runs biome lint and TypeScript checks via `.github/workflows/lint.yml`. Dependabot monitors `package.json` at root.

## LLM vs. deterministic: an intentional split

Not everything here goes through the LLM agent, on purpose. Only use an LLM where the
task genuinely requires reasoning over unstructured input — don't route deterministic
work through it just because the SDK is available.

- **`flows/issue-intake.js`** — a worker reports an issue by texting "issue"; the bot
  walks them through area -> photo -> description one question at a time. This is a
  plain step-by-step state machine (in-memory `Map` keyed by `channelId:threadTs`),
  hooked into `listeners/events/message.js` *before* it falls through to the LLM
  agent. No LLM call anywhere in this file.
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
  routed through the Claude Agent SDK's tool-calling loop — it can use any LLM
  provider, independent of what `agent/agent.js` uses. Google Gemini's free tier
  (1,500 req/day on Flash, no credit card) is a practical no-cost choice for this one
  call, even though `agent/agent.js` itself is tied to Anthropic via the Claude Agent
  SDK.

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

**Conversation history** (`thread-context/store.js`) is an in-memory Map keyed by `channelId:threadTs` with TTL-based cleanup (24h) and a max entry limit (1000). The Claude Agent SDK manages conversation history server-side via sessions, so only session IDs need to be tracked locally for resuming conversations via `{ resume: sessionId }`.

**Handler flow** (DM, mention): get session ID from store -> run agent -> stream response in thread with feedback blocks -> store updated session ID.

## Claude Agent SDK Specifics

**Agent (`agent/agent.js`)** uses `query()` async generator from `@anthropic-ai/claude-agent-sdk`. Tools are registered via `createSdkMcpServer()` and passed as `mcpServers` in options, alongside any external MCP servers (e.g. Slack's own MCP server) — both your own tools and external MCP connections live in the same `mcpServers` object. The `runAgent()` function is async and returns `{ responseText, sessionId }`.

**Tools** are defined with `tool()` from `@anthropic-ai/claude-agent-sdk` using Zod schemas. One example tool (emoji reaction) is included. Tools are created as closures inside `runAgent()` to capture `deps`.

**Feedback blocks** use the `context_actions` block type with `feedback_buttons` elements. A single `feedback` action ID is registered.

## Code Style

- ES modules (`"type": "module"` in package.json)
- JSDoc + TypeScript validation (`npm run check` — `tsc --checkJs`)
- Biome for linting and formatting (single quotes, 2-space indent, 120 line width)
- Node.js built-in test runner (`node --test`)
- Kebab-case filenames
