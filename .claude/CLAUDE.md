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
agent/                # Agent definition (agent.js) and tool registration (index.js)
listeners/             # Slack event/action/view handlers
thread-context/        # Session-ID store for multi-turn conversations
tests/                 # Unit tests
manifest.json           # Slack app manifest (agent_view, MCP, OAuth scopes)
app.js                  # Entry point (Socket Mode)
app-oauth.js            # Alternate entry point (HTTP mode, for OAuth distribution)
```

CI runs biome lint and TypeScript checks via `.github/workflows/lint.yml`. Dependabot monitors `package.json` at root.

## Architecture

Three-layer design: **app.js** -> **listeners/** -> **agent/**

**Entry point (`app.js`)** initializes Bolt with Socket Mode and calls `registerListeners(app)`.

**Listeners** are organized by Slack platform feature:
- `listeners/events/` -- `app-home-opened` (Home tab view + Messages-tab suggested prompts via `event.tab` branch), `app-mentioned`, `message`
- `listeners/actions/` -- `feedback-buttons`

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
