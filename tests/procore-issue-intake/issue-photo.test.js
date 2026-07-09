import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { postPhotoReply } from '../../features/procore-issue-intake/issue-photo.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

/** Fake fetch returning an OK image response, recording what was requested. */
function okImageFetch(captured, contentType = 'image/jpeg') {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  };
}

/** Client recording files.info + uploadV2 calls. */
function client(calls, { token = 'xoxb-abc', fileInfo } = {}) {
  return {
    token,
    files: {
      info: async (args) => {
        calls.info = args;
        return fileInfo ?? { file: { url_private_download: 'https://files.slack.example/dl' } };
      },
      uploadV2: async (args) => {
        calls.upload = args;
        return { files: [{ id: 'F_BOT_1' }] };
      },
    },
  };
}

const baseRecord = {
  reporter: { name: 'Mike Alvarez', phone: '+1' },
  siteId: 'site-1',
  area: 'x',
  description: 'y',
  photoUrl: null,
  photoSlackFileId: null,
  geotag: null,
  timestamp: '2026-07-07T12:00:00.000Z',
};

describe('postPhotoReply', () => {
  it('returns false when the record has no photo', async () => {
    const calls = {};
    const ok = await postPhotoReply(client(calls), baseRecord, 'C1', '111.222');
    assert.strictEqual(ok, false);
    assert.strictEqual(calls.upload, undefined);
  });

  it('downloads a DM file with the bot token and uploads it into the thread', async () => {
    const captured = {};
    globalThis.fetch = okImageFetch(captured);
    const calls = {};
    const ok = await postPhotoReply(
      client(calls, { token: 'xoxb-abc' }),
      { ...baseRecord, photoSlackFileId: 'F_DM_1' },
      'C1',
      '111.222',
    );
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls.info, { file: 'F_DM_1' });
    assert.strictEqual(captured.url, 'https://files.slack.example/dl');
    assert.strictEqual(captured.init.headers.Authorization, 'Bearer xoxb-abc');
    assert.strictEqual(calls.upload.channel_id, 'C1');
    assert.strictEqual(calls.upload.thread_ts, '111.222');
  });

  it('falls back to SLACK_BOT_TOKEN when the client has no token', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-env';
    const captured = {};
    globalThis.fetch = okImageFetch(captured);
    await postPhotoReply(client({}, { token: null }), { ...baseRecord, photoSlackFileId: 'F_DM_1' }, 'C1', '111.222');
    assert.strictEqual(captured.init.headers.Authorization, 'Bearer xoxb-env');
  });

  it('downloads a Twilio media URL with Basic auth and uploads it', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC1';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    const captured = {};
    globalThis.fetch = okImageFetch(captured, 'image/png');
    const calls = {};
    const ok = await postPhotoReply(
      client(calls),
      { ...baseRecord, photoUrl: 'https://media.twilio.example/x' },
      'C1',
      '111.222',
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(captured.url, 'https://media.twilio.example/x');
    assert.match(captured.init.headers.Authorization, /^Basic /);
    assert.match(calls.upload.filename, /\.png$/);
  });

  it('returns false (no throw) when files.info throws', async () => {
    const bad = {
      files: {
        info: async () => {
          throw new Error('missing_scope');
        },
      },
    };
    const ok = await postPhotoReply(bad, { ...baseRecord, photoSlackFileId: 'F_DM_1' }, 'C1', '111.222');
    assert.strictEqual(ok, false);
  });

  it('returns false when the download yields Slack HTML instead of an image', async () => {
    globalThis.fetch = okImageFetch({}, 'text/html');
    const ok = await postPhotoReply(client({}), { ...baseRecord, photoSlackFileId: 'F_DM_1' }, 'C1', '111.222');
    assert.strictEqual(ok, false);
  });
});
