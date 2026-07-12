import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { translateText } from '../../lib/translate.js';

describe('translateText', () => {
  // translate.js prints an error whenever it falls back to the original text.
  // Those are expected in the failure tests, so silence the console.
  let originalError;
  beforeEach(() => {
    originalError = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('returns empty or missing input unchanged (no provider call)', async () => {
    let called = false;
    const llm = async () => {
      called = true;
      return { responseText: 'x' };
    };
    assert.strictEqual(await translateText('', 'es', llm), '');
    assert.strictEqual(await translateText('hello', '', llm), 'hello');
    assert.strictEqual(called, false);
  });

  it('returns the translated text from the provider', async () => {
    const llm = async () => ({ responseText: 'Se requieren cascos' });
    assert.strictEqual(await translateText('Hard hats required', 'es', llm), 'Se requieren cascos');
  });

  it('translates foreign text INTO English (no English-target short-circuit)', async () => {
    const captured = {};
    const llm = async (params) => {
      captured.params = params;
      return { responseText: 'There is a leak on floor 4' };
    };
    const out = await translateText('Hay una fuga en el piso 4', 'en', llm);
    assert.strictEqual(out, 'There is a leak on floor 4');
    // It actually called the provider with the English target (the old bug skipped this).
    assert.match(captured.params.systemPrompt, /"en"/);
    assert.strictEqual(captured.params.text, 'Hay una fuga en el piso 4');
  });

  it('falls back to the original text when the provider throws', async () => {
    const llm = async () => {
      throw new Error('quota exhausted');
    };
    assert.strictEqual(await translateText('Hard hats required', 'es', llm), 'Hard hats required');
  });

  it('falls back to the original text when the provider returns empty', async () => {
    const llm = async () => ({ responseText: '   ' });
    assert.strictEqual(await translateText('Hard hats required', 'es', llm), 'Hard hats required');
  });
});
