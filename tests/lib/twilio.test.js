import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { placeEscalationCall, sendSms } from '../../lib/twilio.js';

describe('twilio', () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  };
  let originalLog;

  beforeEach(() => {
    // The dev-mode fallback logs to the console; silence it during tests.
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalLog;
    restoreEnv('TWILIO_ACCOUNT_SID', originalEnv.sid);
    restoreEnv('TWILIO_AUTH_TOKEN', originalEnv.token);
    restoreEnv('TWILIO_FROM_NUMBER', originalEnv.from);
  });

  function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function configureTwilio() {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    process.env.TWILIO_FROM_NUMBER = '+15551230000';
  }

  function clearTwilio() {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  }

  it('dev mode: sendSms resolves without calling the network', async () => {
    clearTwilio();
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, text: async () => '' };
    };
    await sendSms('+15559990000', 'hello');
    assert.strictEqual(fetchCalled, false);
  });

  it('dev mode: placeEscalationCall resolves without calling the network', async () => {
    clearTwilio();
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, text: async () => '' };
    };
    await placeEscalationCall('+15559990000', 'evacuate now');
    assert.strictEqual(fetchCalled, false);
  });

  it('configured: sendSms posts To/From/Body to the Messages endpoint', async () => {
    configureTwilio();
    let capturedUrl;
    let capturedBody;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = options.body;
      return { ok: true, text: async () => '' };
    };

    await sendSms('+15559990000', 'Crane lift at zone 3');

    assert.ok(capturedUrl.endsWith('/Accounts/ACtest/Messages.json'));
    assert.strictEqual(capturedBody.get('To'), '+15559990000');
    assert.strictEqual(capturedBody.get('From'), '+15551230000');
    assert.strictEqual(capturedBody.get('Body'), 'Crane lift at zone 3');
  });

  it('configured: sendSms throws when Twilio returns an error status', async () => {
    configureTwilio();
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    await assert.rejects(() => sendSms('+15559990000', 'hi'), /Twilio API error 401/);
  });

  it('configured: placeEscalationCall posts escaped TwiML to the Calls endpoint', async () => {
    configureTwilio();
    let capturedUrl;
    let capturedBody;
    global.fetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = options.body;
      return { ok: true, text: async () => '' };
    };

    await placeEscalationCall('+15559990000', 'Zone 3 & 4 < danger');

    assert.ok(capturedUrl.endsWith('/Accounts/ACtest/Calls.json'));
    const twiml = capturedBody.get('Twiml');
    assert.ok(twiml.includes('<Say>'));
    assert.ok(twiml.includes('&amp;'));
    assert.ok(twiml.includes('&lt;'));
  });
});
