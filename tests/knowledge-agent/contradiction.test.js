import assert from 'node:assert';
import { describe, it } from 'node:test';

import { compareSources } from '../../features/knowledge-agent/contradiction.js';

describe('compareSources', () => {
  it('reports no conflict when there are no sources', async () => {
    const result = await compareSources([]);
    assert.deepStrictEqual(result, { hasConflict: false, summary: 'No sources provided.' });
  });

  it('reports no conflict for a single source (nothing to compare against)', async () => {
    const result = await compareSources([{ source: 'Addendum 3', text: 'Rebar spacing 12 in.' }]);
    assert.strictEqual(result.hasConflict, false);
    assert.match(result.summary, /nothing to compare/i);
  });

  it('returns the analyzer verdict, with the sources passed through, when they conflict', async () => {
    const sources = [
      { source: 'Spec 03 30 00', text: 'Rebar spacing shall be 12 inches on center.' },
      { source: 'Addendum 3', text: 'Rebar spacing revised to 8 inches on center.' },
    ];
    let seen = null;
    const analyze = async (s) => {
      seen = s;
      return { hasConflict: true, summary: 'Spec 03 30 00 and Addendum 3 disagree on rebar spacing (12 in vs 8 in).' };
    };

    const result = await compareSources(sources, { analyze });

    assert.strictEqual(result.hasConflict, true);
    assert.match(result.summary, /rebar spacing/i);
    assert.deepStrictEqual(seen, sources, 'the sources are handed to the analyzer unchanged');
  });

  it('returns the analyzer verdict when the sources agree', async () => {
    const analyze = async () => ({ hasConflict: false, summary: 'Both sources agree on a 7-day cure.' });
    const result = await compareSources(
      [
        { source: 'Spec A', text: 'Concrete cure 7 days.' },
        { source: 'RFI 12', text: 'Confirmed: cure 7 days.' },
      ],
      { analyze },
    );
    assert.strictEqual(result.hasConflict, false);
    assert.match(result.summary, /agree/i);
  });

  it('fails safe (assumes a conflict) when the analyzer throws', async () => {
    const analyze = async () => {
      throw new Error('Gemini unavailable');
    };
    const result = await compareSources(
      [
        { source: 'A', text: 'x' },
        { source: 'B', text: 'y' },
      ],
      { analyze },
    );
    assert.strictEqual(result.hasConflict, true, 'unverifiable should be treated as a possible conflict');
    assert.match(result.summary, /review/i);
  });

  it('fails safe when the analyzer returns a malformed result', async () => {
    const analyze = async () => ({ summary: 'missing the hasConflict flag' });
    const result = await compareSources(
      [
        { source: 'A', text: 'x' },
        { source: 'B', text: 'y' },
      ],
      { analyze },
    );
    assert.strictEqual(result.hasConflict, true);
    assert.match(result.summary, /review/i);
  });
});
