import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { isTwilioConfigured, sendSms } from '../../lib/twilio.js';

const TWILIO_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];

afterEach(() => {
  for (const v of TWILIO_VARS) delete process.env[v];
});

describe('isTwilioConfigured', () => {
  it('is false when nothing is set', () => {
    assert.strictEqual(isTwilioConfigured(), false);
  });

  it('is true only when every required var is present', () => {
    for (const v of TWILIO_VARS) process.env[v] = 'x';
    assert.strictEqual(isTwilioConfigured(), true);
    delete process.env.TWILIO_FROM_NUMBER;
    assert.strictEqual(isTwilioConfigured(), false);
  });
});

describe('sendSms', () => {
  it('throws a clear error when Twilio is not configured (no network call)', async () => {
    await assert.rejects(sendSms('+15555550101', 'hello'), /Twilio not configured/);
  });
});
