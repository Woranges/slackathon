import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { uploadPhotoToSlack } from '../../features/procore-issue-intake/issue-photo.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

/** Fake fetch returning an OK image response. */
function okImageFetch(captured) {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  };
}

function uploadClient(calls) {
  return {
    files: {
      uploadV2: async (args) => {
        calls.push(args);
        return { files: [{ id: 'F12345' }] };
      },
    },
  };
}

describe('uploadPhotoToSlack', () => {
  it('downloads the media and re-uploads it, returning the Slack file id', async () => {
    const captured = {};
    globalThis.fetch = okImageFetch(captured);
    const calls = [];
    const id = await uploadPhotoToSlack(uploadClient(calls), 'https://media.twilio.example/x');
    assert.strictEqual(id, 'F12345');
    assert.strictEqual(captured.url, 'https://media.twilio.example/x');
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].filename, /\.png$/);
  });

  it('sends Twilio Basic auth when credentials are set', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC1';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    const captured = {};
    globalThis.fetch = okImageFetch(captured);
    await uploadPhotoToSlack(uploadClient([]), 'https://media.twilio.example/x');
    assert.match(captured.init.headers.Authorization, /^Basic /);
  });

  it('returns null when the download fails', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const id = await uploadPhotoToSlack(uploadClient([]), 'https://media.twilio.example/x');
    assert.strictEqual(id, null);
  });

  it('returns null (no throw) when fetch throws', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const id = await uploadPhotoToSlack(uploadClient([]), 'https://media.twilio.example/x');
    assert.strictEqual(id, null);
  });
});
