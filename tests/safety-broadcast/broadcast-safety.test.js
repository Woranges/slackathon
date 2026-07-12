import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  escalateUnacknowledged,
  formatBroadcastAudit,
  formatBroadcastStatus,
  runEscalationSweep,
} from '../../features/safety-broadcast/broadcast-safety.js';
import {
  createBroadcast,
  getBroadcastAudit,
  getWorkersBySite,
  recordBroadcastAck,
  setBroadcastMessage,
} from '../../lib/db.js';

// A translate stub: marks the text so a test can prove translation happened,
// without calling the model.
/** @type {(text: string, lang: string) => Promise<string>} */
const fakeTranslate = async (text, lang) => `[${lang}] ${text}`;

/**
 * @param {Partial<{ phone: string, name: string, language: string, ackedAt: string | null, escalatedAt: string | null }>} over
 */
const row = (over = {}) => ({
  phone: '+15555550101',
  name: 'Mike Alvarez',
  language: 'en',
  ackedAt: null,
  escalatedAt: null,
  ...over,
});

describe('formatBroadcastStatus', () => {
  it('includes the site, the message, and the acknowledgment count', () => {
    const text = formatBroadcastStatus({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      rows: [
        row({ ackedAt: '2026-07-12T06:33:00.000Z' }),
        row({ name: 'Sofia Reyes', phone: '+2' }),
        row({ name: 'Chen Wei', phone: '+3' }),
      ],
    });
    assert.ok(text.includes('Park Place'), 'shows the site');
    assert.ok(text.includes('Evacuate zone 3'), 'shows the message');
    assert.ok(text.includes('1/3 acknowledged'), 'shows the count');
  });

  it('names who has acknowledged and who has not', () => {
    // "2/3 acknowledged" does not tell a manager the one thing they need: WHICH
    // worker is still unaccounted for.
    const text = formatBroadcastStatus({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      rows: [
        row({ name: 'Mike Alvarez', ackedAt: '2026-07-12T06:33:00.000Z' }),
        row({ name: 'Sofia Reyes', phone: '+2', ackedAt: '2026-07-12T06:35:00.000Z' }),
        row({ name: 'Chen Wei', phone: '+3' }),
      ],
    });

    assert.ok(text.includes('Mike Alvarez'), 'names an acknowledger');
    assert.ok(text.includes('Sofia Reyes'), 'names the other acknowledger');
    assert.ok(text.includes('Chen Wei'), 'names the worker still missing');
    assert.ok(text.includes('2/3 acknowledged'));
  });

  it('derives the count from the same rows as the names, so they cannot disagree', () => {
    const text = formatBroadcastStatus({
      site: 'Park Place',
      message: 'Gas leak',
      rows: [row({ ackedAt: '2026-07-12T06:33:00.000Z' }), row({ phone: '+2' })],
    });
    assert.ok(text.includes('1/2 acknowledged'));
  });

  it('marks a worker who had to be voice-called', () => {
    const text = formatBroadcastStatus({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      rows: [row({ name: 'Chen Wei', escalatedAt: '2026-07-12T06:47:00.000Z' })],
    });
    assert.ok(text.includes('📞'), 'the escalation is visible on the scoreboard');
    assert.ok(text.includes('Chen Wei'));
  });

  it('starts at 0 of the total when nothing is acknowledged yet', () => {
    const text = formatBroadcastStatus({
      site: 'Cedar Yards',
      message: 'Gas leak',
      rows: [row(), row({ phone: '+2' }), row({ phone: '+3' }), row({ phone: '+4' }), row({ phone: '+5' })],
    });
    assert.ok(text.includes('0/5 acknowledged'));
  });

  it('does not blow up on an empty roster', () => {
    const text = formatBroadcastStatus({ site: 'Park Place', message: 'Test', rows: [] });
    assert.ok(text.includes('0/0 acknowledged'));
  });
});

describe('runEscalationSweep', () => {
  /** A Slack client stub that records what it was asked to post/update. */
  function fakeClient() {
    /** @type {any[]} */
    const posted = [];
    /** @type {any[]} */
    const updated = [];
    return {
      posted,
      updated,
      chat: {
        postMessage: async (/** @type {any} */ args) => void posted.push(args),
        update: async (/** @type {any} */ args) => void updated.push(args),
      },
    };
  }

  it('files the acknowledgment record in the scoreboard’s thread', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    await setBroadcastMessage(broadcast.id, 'C123', '111.222');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550102');

    const client = fakeClient();
    const result = await runEscalationSweep(broadcast, workers, client, {
      placeCall: async () => {},
      translate: fakeTranslate,
    });

    assert.strictEqual(result.audited, true);
    assert.strictEqual(client.posted.length, 1, 'the record is posted once');
    assert.strictEqual(client.posted[0].channel, 'C123');
    assert.strictEqual(client.posted[0].thread_ts, '111.222', 'as a reply under the scoreboard, not a new message');
    assert.ok(client.posted[0].text.includes('Acknowledgment record'));
    assert.ok(client.posted[0].text.includes('Sofia Reyes'));
  });

  it('refreshes the scoreboard so it shows who had to be called', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    await setBroadcastMessage(broadcast.id, 'C123', '111.222');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550102');

    const client = fakeClient();
    await runEscalationSweep(broadcast, workers, client, {
      placeCall: async () => {},
      translate: fakeTranslate,
    });

    assert.strictEqual(client.updated.length, 1, 'the live scoreboard is rewritten');
    assert.ok(client.updated[0].text.includes('📞'), 'and now shows the escalation');
  });

  it('still files the record when everyone acknowledged and nobody was called', async () => {
    // A broadcast everyone acknowledged still needs its "here is the proof" artifact.
    const broadcast = await createBroadcast('site-1', 'All clear');
    await setBroadcastMessage(broadcast.id, 'C123', '111.222');
    const workers = await getWorkersBySite('site-1');
    for (const w of workers) await recordBroadcastAck(broadcast.id, w.phone);

    const client = fakeClient();
    const result = await runEscalationSweep(broadcast, workers, client, {
      placeCall: async () => assert.fail('nobody should be called'),
      translate: fakeTranslate,
    });

    assert.strictEqual(result.called, 0);
    assert.strictEqual(result.audited, true, 'the record is filed anyway');
    assert.ok(/all .*acknowledged/i.test(client.posted[0].text));
  });

  it('does not post when the broadcast never got a scoreboard message', async () => {
    const broadcast = await createBroadcast('site-1', 'Orphan broadcast');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550102');

    const client = fakeClient();
    const result = await runEscalationSweep(broadcast, workers, client, {
      placeCall: async () => {},
      translate: fakeTranslate,
    });

    assert.strictEqual(result.audited, false, 'no thread to reply to');
    assert.strictEqual(client.posted.length, 0);
    assert.strictEqual(result.called, 1, 'but the escalation call still went out');
  });
});

describe('formatBroadcastAudit', () => {
  const sent = '2026-07-12T06:32:00.000Z';

  it('shows, per worker, whether and when they acknowledged', () => {
    const text = formatBroadcastAudit({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      createdAt: sent,
      rows: [row({ name: 'Mike Alvarez', ackedAt: '2026-07-12T06:33:00.000Z' })],
    });

    assert.ok(text.includes('Mike Alvarez'));
    assert.ok(text.includes('acknowledged'));
    // Times render as a Slack date token so every viewer sees their own timezone,
    // with the raw ISO instant as the fallback (see issue-card.js for the pattern).
    const unix = Math.floor(new Date('2026-07-12T06:33:00.000Z').getTime() / 1000);
    assert.ok(text.includes(`<!date^${unix}^`), 'the ack time is a Slack date token');
    assert.ok(text.includes('2026-07-12T06:33:00.000Z'), 'with the ISO instant as fallback');
  });

  it('records that a non-responder was voice-called, and in which language', () => {
    const text = formatBroadcastAudit({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      createdAt: sent,
      rows: [row({ name: 'Sofia Reyes', language: 'es', escalatedAt: '2026-07-12T06:47:00.000Z' })],
    });

    assert.ok(text.includes('Sofia Reyes'));
    assert.ok(text.includes('📞'), 'the call is on the record');
    assert.ok(/spanish/i.test(text), 'and the language it was placed in');
  });

  it('marks a worker who neither acknowledged nor could be called', () => {
    const text = formatBroadcastAudit({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      createdAt: sent,
      rows: [row({ name: 'Chen Wei' })],
    });
    assert.ok(text.includes('Chen Wei'));
    assert.ok(/no (reply|response|acknowledgment)/i.test(text), 'says plainly that they never responded');
  });

  it('says so when everyone acknowledged and nobody needed calling', () => {
    const text = formatBroadcastAudit({
      site: 'Park Place',
      message: 'Evacuate zone 3',
      createdAt: sent,
      rows: [row({ ackedAt: '2026-07-12T06:33:00.000Z' })],
    });
    assert.ok(/all .*acknowledged/i.test(text), 'the happy path is stated, not implied by absence');
  });
});

describe('escalateUnacknowledged', () => {
  it('voice-calls only the workers who have not acknowledged', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    // Scope to Mike + Sofia explicitly so this doesn't depend on how many other
    // workers happen to be seeded on site-1.
    const workers = (await getWorkersBySite('site-1')).filter((w) =>
      ['+15555550101', '+15555550102'].includes(w.phone),
    );
    await recordBroadcastAck(broadcast.id, '+15555550101'); // Mike acknowledges

    /** @type {Array<{ to: string, message: string }>} */
    const called = [];
    const count = await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (to, message) => void called.push({ to, message }),
      translate: fakeTranslate,
    });

    assert.strictEqual(count, 1);
    assert.strictEqual(called.length, 1);
    assert.strictEqual(called[0].to, '+15555550102', 'Sofia, who did not acknowledge');
    // Sofia's language is Spanish, so the call reads the translated alert.
    assert.ok(called[0].message.includes('Evacuate zone 3'), 'reads the broadcast message');
  });

  it('speaks the alert in the worker’s own language', async () => {
    // The bug this covers: the SMS was translated but the escalation voice call
    // read the raw English, so the worker least able to read the text was also
    // the one the phone call failed. Sofia's language is Spanish.
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550102');

    /** @type {Array<{ to: string, message: string, language: string | undefined }>} */
    const called = [];
    await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (to, message, language) => void called.push({ to, message, language }),
      translate: fakeTranslate,
    });

    assert.strictEqual(called[0].message, '[es] Evacuate zone 3', 'the spoken text was translated to Spanish');
    assert.strictEqual(called[0].language, 'es-MX', 'and Twilio is told to use a Spanish voice');
  });

  it('does not translate for a worker who already speaks English', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550101'); // Mike, en

    /** @type {Array<{ message: string, language: string | undefined }>} */
    const called = [];
    let translateCalls = 0;
    await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (_to, message, language) => void called.push({ message, language }),
      translate: async (text, lang) => {
        translateCalls += 1;
        return fakeTranslate(text, lang);
      },
    });

    assert.strictEqual(translateCalls, 0, 'no pointless model call for an English speaker');
    assert.strictEqual(called[0].message, 'Evacuate zone 3');
    assert.strictEqual(called[0].language, 'en-US');
  });

  it('speaks English when Twilio has no voice for the worker’s language', async () => {
    // Reading translated text with an English voice produces garbled nonsense.
    // Coherent English is the better failure mode — and the translated SMS has
    // already gone out regardless.
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    /** @type {any[]} */
    const workers = [{ phone: '+15555559999', name: 'Ana Silva', siteId: 'site-1', preferredLanguage: 'xx' }];

    /** @type {Array<{ message: string, language: string | undefined }>} */
    const called = [];
    await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (_to, message, language) => void called.push({ message, language }),
      translate: fakeTranslate,
    });

    assert.strictEqual(called[0].message, 'Evacuate zone 3', 'falls back to the English original');
    assert.strictEqual(called[0].language, 'en-US', 'spoken by an English voice');
  });

  it('records each escalation call in the audit trail', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550102');

    await escalateUnacknowledged(broadcast, workers, {
      placeCall: async () => {},
      translate: fakeTranslate,
    });

    const row = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550102');
    assert.ok(row?.escalatedAt, 'the call is on the record, with the time it was placed');
  });

  it('does not record an escalation for a call that failed to connect', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    const workers = (await getWorkersBySite('site-1')).filter((w) => w.phone === '+15555550102');

    await escalateUnacknowledged(broadcast, workers, {
      placeCall: async () => {
        throw new Error('bad number');
      },
      translate: fakeTranslate,
    });

    const row = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550102');
    assert.strictEqual(row?.escalatedAt, null, 'the audit trail must not claim a call that never happened');
  });

  it('places no calls when everyone has acknowledged', async () => {
    const broadcast = await createBroadcast('site-1', 'All-clear check');
    const workers = await getWorkersBySite('site-1');
    for (const w of workers) await recordBroadcastAck(broadcast.id, w.phone);

    /** @type {string[]} */
    const called = [];
    const count = await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (to) => void called.push(to),
    });

    assert.strictEqual(count, 0);
    assert.strictEqual(called.length, 0);
  });

  it('keeps calling the remaining workers when one call throws', async () => {
    const broadcast = await createBroadcast('site-1', 'Crane failure');
    // Mike + Sofia only (see note above); nobody has acknowledged.
    const workers = (await getWorkersBySite('site-1')).filter((w) =>
      ['+15555550101', '+15555550102'].includes(w.phone),
    );

    /** @type {string[]} */
    const attempted = [];
    const count = await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (to) => {
        attempted.push(to);
        if (to === '+15555550101') throw new Error('bad number');
      },
      translate: fakeTranslate,
    });

    assert.strictEqual(attempted.length, 2, 'both workers were attempted');
    assert.strictEqual(count, 1, 'one call failed, one succeeded');
  });
});
