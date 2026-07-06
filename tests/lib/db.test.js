import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createBroadcast, getAckStatus, getWorkerByPhone, getWorkersBySite, recordBroadcastAck } from '../../lib/db.js';

describe('db (in-memory)', () => {
  it('finds a worker by phone number', async () => {
    const worker = await getWorkerByPhone('+15550000002');
    assert.strictEqual(worker?.name, 'Maria');
    assert.strictEqual(worker?.preferredLanguage, 'es');
  });

  it('returns null for an unknown phone number', async () => {
    assert.strictEqual(await getWorkerByPhone('+10000000000'), null);
  });

  it('lists only the workers on a given site', async () => {
    const downtown = await getWorkersBySite('downtown');
    assert.strictEqual(downtown.length, 3);
    assert.ok(downtown.every((worker) => worker.siteId === 'downtown'));

    const riverside = await getWorkersBySite('riverside');
    assert.strictEqual(riverside.length, 1);
  });

  it('returns an empty list for a site with no workers', async () => {
    assert.deepStrictEqual(await getWorkersBySite('no-such-site'), []);
  });

  it('creates a broadcast with an id and timestamp', async () => {
    const broadcast = await createBroadcast('downtown', 'Crane lift at zone 3');
    assert.strictEqual(typeof broadcast.id, 'string');
    assert.ok(broadcast.id.length > 0);
    assert.strictEqual(broadcast.siteId, 'downtown');
    assert.strictEqual(broadcast.message, 'Crane lift at zone 3');
    assert.ok(broadcast.createdAt);
  });

  it('counts acknowledgments against the number of workers on the site', async () => {
    const broadcast = await createBroadcast('downtown', 'Evacuate zone 3');

    let status = await getAckStatus(broadcast.id);
    assert.deepStrictEqual(status, { acknowledged: 0, total: 3 });

    await recordBroadcastAck(broadcast.id, '+15550000001');
    await recordBroadcastAck(broadcast.id, '+15550000002');
    status = await getAckStatus(broadcast.id);
    assert.deepStrictEqual(status, { acknowledged: 2, total: 3 });
  });

  it('counts a repeated acknowledgment from the same worker only once', async () => {
    const broadcast = await createBroadcast('downtown', 'Test');
    await recordBroadcastAck(broadcast.id, '+15550000001');
    await recordBroadcastAck(broadcast.id, '+15550000001');
    const status = await getAckStatus(broadcast.id);
    assert.strictEqual(status.acknowledged, 1);
  });

  it('reports zeros for an unknown broadcast', async () => {
    assert.deepStrictEqual(await getAckStatus('does-not-exist'), { acknowledged: 0, total: 0 });
  });
});
