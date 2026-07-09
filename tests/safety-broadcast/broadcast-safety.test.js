import assert from 'node:assert';
import { describe, it } from 'node:test';

import { escalateUnacknowledged, formatBroadcastStatus } from '../../features/safety-broadcast/broadcast-safety.js';
import { createBroadcast, getWorkersBySite, recordBroadcastAck } from '../../lib/db.js';

describe('formatBroadcastStatus', () => {
  it('includes the site, the message, and the acknowledgment count', () => {
    const text = formatBroadcastStatus({ site: 'site-1', message: 'Evacuate zone 3', acknowledged: 1, total: 3 });
    assert.ok(text.includes('site-1'), 'shows the site');
    assert.ok(text.includes('Evacuate zone 3'), 'shows the message');
    assert.ok(text.includes('1/3 acknowledged'), 'shows the count');
  });

  it('starts at 0 of the total when nothing is acknowledged yet', () => {
    const text = formatBroadcastStatus({ site: 'site-2', message: 'Gas leak', acknowledged: 0, total: 5 });
    assert.ok(text.includes('0/5 acknowledged'));
  });
});

describe('escalateUnacknowledged', () => {
  it('voice-calls only the workers who have not acknowledged', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    const workers = await getWorkersBySite('site-1'); // Mike + Sofia
    await recordBroadcastAck(broadcast.id, '+15555550101'); // Mike acknowledges

    /** @type {Array<{ to: string, message: string }>} */
    const called = [];
    const count = await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (to, message) => void called.push({ to, message }),
    });

    assert.strictEqual(count, 1);
    assert.strictEqual(called.length, 1);
    assert.strictEqual(called[0].to, '+15555550102', 'Sofia, who did not acknowledge');
    assert.strictEqual(called[0].message, 'Evacuate zone 3', 'reads the broadcast message');
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
    const workers = await getWorkersBySite('site-1'); // nobody has acknowledged

    /** @type {string[]} */
    const attempted = [];
    const count = await escalateUnacknowledged(broadcast, workers, {
      placeCall: async (to) => {
        attempted.push(to);
        if (to === '+15555550101') throw new Error('bad number');
      },
    });

    assert.strictEqual(attempted.length, 2, 'both workers were attempted');
    assert.strictEqual(count, 1, 'one call failed, one succeeded');
  });
});
