// Re-exports the configured LLM provider so call sites (agent/agent.js, and
// later flows/ if you want more natural responses there — see CLAUDE.md)
// don't need to know which provider is behind it. Currently Gemini; swap
// this file's contents to change providers without touching callers.

export { runLlmTurn } from './gemini.js';
