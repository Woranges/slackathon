// Shared translation utility — used by both procore-issue-intake (inbound
// field reports) and safety-broadcast (outbound alerts).
//
// Uses the DeepL REST API when TRANSLATE_API_KEY is set. Without a key — or if
// the API call fails — it falls back to returning the original text unchanged.
// This is deliberate: a safety broadcast must still go out even if translation
// is unavailable, so this function never throws and never blocks a send.

const DEEPL_ENDPOINT = 'https://api-free.deepl.com/v2/translate';

/**
 * Translate text into a target language.
 * @param {string} text - The text to translate.
 * @param {string} targetLang - ISO 639-1 code (e.g. 'es', 'fr', 'en').
 * @returns {Promise<string>} The translated text, or the original text when no
 *   translation is needed, no provider is configured, or the request fails.
 */
export async function translateText(text, targetLang) {
  // Nothing to translate.
  if (!text || !targetLang) return text;

  // Broadcasts originate in English, so an English target is a no-op — skip
  // the API call entirely. Covers 'en', 'EN', 'en-US', etc.
  if (targetLang.toLowerCase().startsWith('en')) return text;

  const apiKey = process.env.TRANSLATE_API_KEY;
  if (!apiKey) {
    // No provider wired up yet: send the original text rather than crash.
    console.warn('[translate] TRANSLATE_API_KEY not set — sending text untranslated.');
    return text;
  }

  try {
    const response = await fetch(DEEPL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ text, target_lang: targetLang.toUpperCase() }),
    });

    if (!response.ok) {
      console.error(`[translate] DeepL responded ${response.status} — sending text untranslated.`);
      return text;
    }

    const data = await response.json();
    return data?.translations?.[0]?.text ?? text;
  } catch (error) {
    // Network failure, timeout, bad JSON, etc. A safety alert must still send.
    console.error('[translate] request failed — sending text untranslated:', error);
    return text;
  }
}
