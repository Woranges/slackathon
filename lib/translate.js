// Shared translation utility — used by both procore-issue.js (inbound field
// reports) and safety-broadcast.js (outbound alerts). TODO: wire up a real
// provider (DeepL or Google Translate API are both cheap and fast enough here).

/**
 * Translate text into a target language.
 * @param {string} text
 * @param {string} targetLang - ISO 639-1 code (e.g. 'es', 'en').
 * @returns {Promise<string>}
 */
export async function translateText(text, targetLang) {
  // TODO: call DeepL or Google Translate API. Until wired up, this is a no-op
  // passthrough so callers can be built/tested without a translation provider.
  return text;
}
