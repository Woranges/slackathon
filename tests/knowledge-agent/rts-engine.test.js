import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { searchWorkspace } from '../../features/knowledge-agent/rts-engine.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SLACK_USER_TOKEN;
});

describe('searchWorkspace (RTS)', () => {
  it('throws a clear error when no user token is available', async () => {
    await assert.rejects(() => searchWorkspace('anything'), /SLACK_USER_TOKEN/);
  });

  it('POSTs the query to assistant.search.context with the user token', async () => {
    const captured = {};
    globalThis.fetch = async (url, init) => {
      captured.url = url;
      captured.init = init;
      return { json: async () => ({ ok: true, results: { messages: [], files: [] } }) };
    };
    await searchWorkspace('water damage east stairwell', 'xoxp-abc');
    assert.strictEqual(captured.url, 'https://slack.com/api/assistant.search.context');
    assert.strictEqual(captured.init.headers.Authorization, 'Bearer xoxp-abc');
    assert.match(captured.init.body, /water damage east stairwell/);
  });

  it('falls back to SLACK_USER_TOKEN when no token is passed', async () => {
    process.env.SLACK_USER_TOKEN = 'xoxp-env';
    const captured = {};
    globalThis.fetch = async (_url, init) => {
      captured.init = init;
      return { json: async () => ({ ok: true, results: {} }) };
    };
    await searchWorkspace('anything');
    assert.strictEqual(captured.init.headers.Authorization, 'Bearer xoxp-env');
  });

  it('maps messages and files into results with text + permalink', async () => {
    globalThis.fetch = async () => ({
      json: async () => ({
        ok: true,
        results: {
          messages: [
            { content: 'Loose handrail on 4', permalink: 'https://x/p1', author_name: 'Mike', message_ts: '1.2' },
          ],
          files: [{ title: 'issue-photo.jpg', permalink: 'https://x/f1', author_name: 'Mike', timestamp: 99 }],
        },
      }),
    });
    const results = await searchWorkspace('handrail', 'xoxp-abc');
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].text, 'Loose handrail on 4');
    assert.strictEqual(results[0].permalink, 'https://x/p1');
    assert.strictEqual(results[1].text, 'issue-photo.jpg');
  });

  it('throws with the Slack error when ok is false', async () => {
    globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: 'not_allowed_token_type' }) });
    await assert.rejects(() => searchWorkspace('x', 'xoxp-abc'), /not_allowed_token_type/);
  });
});
