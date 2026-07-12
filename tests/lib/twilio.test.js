import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { isTwilioConfigured, placeEscalationCall, sendSms } from '../../lib/twilio.js';

const TWILIO_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const v of TWILIO_VARS) delete process.env[v];
  globalThis.fetch = realFetch;
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

describe('placeEscalationCall', () => {
  it('throws a clear error when Twilio is not configured (no network call)', async () => {
    await assert.rejects(placeEscalationCall('+15555550101', 'Evacuate now'), /Twilio not configured/);
  });

  it('places a voice call via the Twilio Calls API that reads the message aloud', async () => {
    for (const v of TWILIO_VARS) process.env[v] = 'x';
    process.env.TWILIO_ACCOUNT_SID = 'ACxxxx';
    process.env.TWILIO_FROM_NUMBER = '+15550000000';

    /** @type {{ url: string, options: any } | null} */
    let captured = null;
    globalThis.fetch = async (url, options) => {
      captured = { url: String(url), options };
      return new Response('{}', { status: 201 });
    };

    await placeEscalationCall('+15555550101', 'Evacuate zone 3 now');

    assert.ok(captured, 'fetch was called');
    assert.ok(captured.url.endsWith('/Accounts/ACxxxx/Calls.json'), 'calls the Calls endpoint');
    assert.strictEqual(captured.options.method, 'POST');
    const body = captured.options.body;
    assert.strictEqual(body.get('To'), '+15555550101', 'destination number');
    assert.strictEqual(body.get('From'), '+15550000000', 'caller id');
    assert.ok(
      body.get('Twiml').includes('<Say language="en-US">Evacuate zone 3 now</Say>'),
      'reads the message aloud, in English by default',
    );
  });

  it('speaks the call in the worker’s language when one is given', async () => {
    // The whole point of the escalation call is that it reaches a worker who did
    // not read the text. Reading it to them in a language they do not speak — or
    // with an English voice mangling Spanish words — defeats it.
    for (const v of TWILIO_VARS) process.env[v] = 'x';
    /** @type {any} */
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = options.body;
      return new Response('{}', { status: 201 });
    };

    await placeEscalationCall('+15555550102', 'Evacúe la zona 3 ahora', 'es-MX');

    assert.ok(body.get('Twiml').includes('<Say language="es-MX">'), 'uses a Spanish voice');
    assert.ok(body.get('Twiml').includes('Evacúe la zona 3 ahora'), 'speaks the Spanish text');
  });

  it('escapes the language attribute so it cannot break out of the Say element', async () => {
    for (const v of TWILIO_VARS) process.env[v] = 'x';
    /** @type {any} */
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = options.body;
      return new Response('{}', { status: 201 });
    };

    await placeEscalationCall('+15555550101', 'hi', 'es"><Hangup/><Say language="en-US');

    const twiml = body.get('Twiml');
    assert.ok(!twiml.includes('<Hangup/>'), 'no injected TwiML verb survives');
  });

  it('escapes XML-unsafe characters in the spoken message', async () => {
    for (const v of TWILIO_VARS) process.env[v] = 'x';
    /** @type {any} */
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = options.body;
      return new Response('{}', { status: 201 });
    };

    await placeEscalationCall('+15555550101', 'Crew A & B < zone 3');

    assert.ok(body.get('Twiml').includes('Crew A &amp; B &lt; zone 3'), 'ampersand and angle bracket escaped');
  });

  it('throws when the Twilio API returns an error status', async () => {
    for (const v of TWILIO_VARS) process.env[v] = 'x';
    globalThis.fetch = async () => new Response('bad', { status: 400 });
    await assert.rejects(placeEscalationCall('+15555550101', 'hi'), /Twilio call failed/);
  });
});
