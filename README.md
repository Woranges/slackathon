# HazTrack

**Workers report issues and safety hazards over WhatsApp, and HazTrack files them in Slack and Procore — in any language.**

On a construction site, the people closest to the problems are the least likely to open Slack or Procore. So issues get lost in group texts, language barriers go unaddressed, and safety hazards slip through — the same things that make jobsites dangerous and blow budgets. HazTrack meets workers where they already are (WhatsApp), and does the office paperwork for them.

A worker texts a problem in their own words, in any language. An AI intake agent asks only the few follow-ups it needs (location, description, a photo), then posts a structured card to Slack **and** files an RFI in Procore with the photo attached. Supervisors act from the card — assign it to a worker (who gets a WhatsApp back) or escalate a hazard into a site-wide alert with a live acknowledgment counter. And with Slack's Real-Time Search, a supervisor can just ask *"find the RFI about the door schedule"* and get it back.

Built as a [Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/) Slack agent on top of Slack's `bolt-js-starter-agent`, using [Google Gemini](https://ai.google.dev/) for the language work.

---

## Features

### 1. Field intake → Slack card + Procore RFI
A worker texts a question or issue on WhatsApp. A deterministic slot-filling state machine (code owns the flow; the LLM only extracts fields) gathers **location + description**, asks for a **photo** once, then files. The result is posted as a card in the site's Slack channel and created as an **RFI in Procore** with the photo attached. Two streams, classified from the first message: everyday **RFIs** and **safety** hazards (tagged and prioritized).

From the card, a supervisor can:
- **Assign** it to a specific worker from a dropdown — that worker gets a WhatsApp with the RFI details, in their language.
- **Resolve** it — the resolution is posted back to the Procore RFI as the official response.

### 2. Safety broadcasts + acknowledgment tracking
Escalating a safety card (or the `/broadcast-safety` slash command) fans a **site-wide alert** out to every worker, translated into each worker's language, and posts a live **"X/Y acknowledged"** scoreboard in Slack that ticks up as workers reply. Non-responders get an automated follow-up call after a window.

### 3. Multilingual, end to end
Report in Spanish and the whole conversation — and every alert you receive — stays in Spanish, following mid-conversation switches, while what's filed to Slack and Procore is always normalized to **English** for the office. Runs on the Gemini API (no separate translation key).

### 4. Real-Time Search (RTS)
Ask the assistant to find a past report, photo, or RFI and it searches the workspace via Slack's [Real-Time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api) (`assistant.search.context`) and returns the thread.

---

## Tech stack

- **Slack** — Bolt for JS (Socket Mode + an HTTP webhook), the agent surface, the Slack MCP server, and the Real-Time Search API.
- **Google Gemini** (`@google/genai`) — conversational intake, extraction, classification, and translation, all behind `lib/llm/`.
- **Twilio** — WhatsApp for the field (inbound reports + outbound alerts/assignments).
- **Procore** — REST API (client-credentials) for creating RFIs and attaching photos.

## Repo layout

```
agent/          Shared conversational-assistant plumbing (agent.js, tools/, mcp/)
features/       One folder per owned feature:
  procore-issue-intake/   intake state machine, card, buttons, photo, Procore RFI
  safety-broadcast/       /broadcast-safety command + inbound SMS/acks/escalation
  knowledge-agent/        RTS search + contradiction checking
lib/            Shared utilities: llm/ (Gemini), translate, db, twilio
listeners/      Thin Slack event/action/command/webhook registration
thread-context/ In-memory conversation history for the assistant
app.js          Entry point — Socket Mode + the Twilio webhook on one process
app-oauth.js    Alternate HTTP/OAuth entry point
manifest.json   Slack app manifest
```

See [`.claude/CLAUDE.md`](./.claude/CLAUDE.md) for the design rationale and feature-ownership notes.

---

## Running it

### 1. Create the Slack app
Open [api.slack.com/apps/new](https://api.slack.com/apps/new), choose **From an app manifest**, and paste the contents of [`manifest.json`](./manifest.json). Then **Install to Workspace**.

### 2. Configure environment
Copy `.env.sample` to `.env` and fill in what you need. Minimum to boot:

```sh
GEMINI_API_KEY=...        # aistudio.google.com/apikey (free tier)
SLACK_BOT_TOKEN=xoxb-...  # OAuth & Permissions → Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...  # Basic Information → App-Level Token (connections:write)
```

Everything else is optional and its feature degrades gracefully when unset:
`SLACK_USER_TOKEN` (RTS), `PROCORE_*` (RFIs), `TWILIO_*` (WhatsApp), `MANAGEMENT_CHANNEL_ID` (the card channel). See `.env.sample` for the full list.

### 3. Run

```sh
npm install
node app.js        # Socket Mode; also serves the Twilio webhook on :3000
```

For the WhatsApp path, point your Twilio number's inbound webhook at `https://<public-url>/twilio/sms` (e.g. via ngrok in development).

## Development

```sh
npm run check   # JSDoc + TypeScript validation (tsc --checkJs)
npm run lint    # Biome lint + format
npm test        # Node's built-in test runner
```

CI runs all three on every push and PR.
