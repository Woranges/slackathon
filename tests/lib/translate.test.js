import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { translateText } from '../../lib/translate.js';

describe('translateText', () => {
  // translate.js intentionally prints a warning/error whenever it falls back to
  // the original text. Those are expected here, so we silence the console
  // during the suite, and we restore the real fetch + env after each test so
  // the tests stay independent of one another.
  const originalFetch = global.fetch;
  const originalKey = process.env.TRANSLATE_API_KEY;
  let originalWarn;
  let originalError;

  beforeEach(() => {
    originalWarn = console.warn;
    originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
    if (originalKey === undefined) {
      delete process.env.TRANSLATE_API_KEY;
    } else {
      process.env.TRANSLATE_API_KEY = originalKey;
    }
  });

  it('returns the text unchanged when the target language is English', async () => {
    assert.strictEqual(await translateText('Hard hats required', 'en'), 'Hard hats required');
    assert.strictEqual(await translateText('Hard hats required', 'EN'), 'Hard hats required');
    assert.strictEqual(await translateText('Hard hats required', 'en-US'), 'Hard hats required');
  });

  it('returns empty or missing input unchanged', async () => {
    assert.strictEqual(await translateText('', 'es'), '');
    assert.strictEqual(await translateText('hello', ''), 'hello');
  });

  it('falls back to the original text when no API key is configured', async () => {
    delete process.env.TRANSLATE_API_KEY;
    assert.strictEqual(await translateText('Hard hats required', 'es'), 'Hard hats required');
  });

  it('returns the translated text on a successful API call', async () => {
    process.env.TRANSLATE_API_KEY = 'test-key';
    // Fake the network call: return a canned DeepL-shaped response so the test
    // never touches the internet.
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ translations: [{ text: 'Se requieren cascos' }] }),
    });
    assert.strictEqual(await translateText('Hard hats required', 'es'), 'Se requieren cascos');
  });

  it('falls back to the original text when the API returns an error status', async () => {
    process.env.TRANSLATE_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    assert.strictEqual(await translateText('Hard hats required', 'es'), 'Hard hats required');
  });

  it('falls back to the original text when the network request throws', async () => {
    process.env.TRANSLATE_API_KEY = 'test-key';
    global.fetch = async () => {
      throw new Error('network down');
    };
    assert.strictEqual(await translateText('Hard hats required', 'es'), 'Hard hats required');
  });
});
