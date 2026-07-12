// Shared translation utility — used by both procore-issue-intake (mirroring the
// worker's language in the intake conversation, and normalizing the filed report
// to English) and safety-broadcast (outbound alerts in each worker's language).
//
// Backed by the same Gemini provider as the rest of the app (via lib/llm/), so it
// needs no separate translation API key — just GEMINI_API_KEY. If the model call
// fails for any reason, it returns the original text unchanged: translation must
// never throw or block a safety alert / a report from being filed.
//
// NOTE: callers should gate on "source language != target" themselves (e.g. skip
// calling this for an English worker) — this function does NOT short-circuit an
// English target, because normalizing a foreign report *to* English is one of its
// jobs.

import { runLlmTurn } from './llm/index.js';

/**
 * @param {string} targetLang
 * @returns {string}
 */
function systemPrompt(targetLang) {
  return (
    'You are a translation engine for a construction-site messaging app. Translate the ' +
    `user's message into the language with ISO 639-1 code "${targetLang}". Output ONLY the ` +
    'translation — no quotes, labels, or commentary. Preserve line breaks, numbers, emoji, ' +
    'and URLs exactly. If the message is already in that language, return it unchanged.'
  );
}

/**
 * Translate text into a target language.
 * @param {string} text - The text to translate.
 * @param {string} targetLang - ISO 639-1 code (e.g. 'es', 'zh', 'en').
 * @param {(params: { systemPrompt: string, history: [], text: string }) => Promise<{ responseText: string }>} [llm]
 *   The provider call; defaults to lib/llm's runLlmTurn. Injectable for tests.
 * @returns {Promise<string>} The translated text, or the original text when there's
 *   nothing to translate or the provider call fails.
 */
export async function translateText(text, targetLang, llm = runLlmTurn) {
  if (!text || !targetLang) return text;

  try {
    const { responseText } = await llm({ systemPrompt: systemPrompt(targetLang), history: [], text });
    const out = responseText?.trim();
    return out || text;
  } catch (error) {
    console.error('[translate] request failed — returning text untranslated:', error);
    return text;
  }
}
