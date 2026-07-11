import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  createBroadcast,
  getAckStatus,
  getBroadcast,
  getWorkerByPhone,
  getWorkerBySlackUserId,
  getWorkersBySite,
  recordBroadcastAck,
  setBroadcastMessage,
} from '../../lib/db.js';

describe('getWorkerByPhone', () => {
  it('finds a seeded worker by exact E.164 phone', async () => {
    const worker = await getWorkerByPhone('+15555550101');
    assert.strictEqual(worker?.name, 'Mike Alvarez');
    assert.strictEqual(worker?.siteId, 'site-1');
  });

  it('matches regardless of phone formatting', async () => {
    const worker = await getWorkerByPhone('+1 (555) 555-0101');
    assert.strictEqual(worker?.name, 'Mike Alvarez');
  });

  it('returns null for an unknown phone', async () => {
    assert.strictEqual(await getWorkerByPhone('+19998887777'), null);
  });
});

describe('getWorkerBySlackUserId', () => {
  it('finds a seeded worker by Slack user id', async () => {
    const worker = await getWorkerBySlackUserId('U0BDLQZNN2Z');
    assert.strictEqual(worker?.name, 'Mike Alvarez');
    assert.strictEqual(worker?.siteId, 'site-1');
  });

  it('returns null for an unknown Slack user id', async () => {
    assert.strictEqual(await getWorkerBySlackUserId('UNOPE'), null);
  });
});

describe('getWorkersBySite', () => {
  it('returns every worker on a site', async () => {
    const workers = await getWorkersBySite('site-1');
    assert.deepStrictEqual(workers.map((w) => w.name).sort(), ['Mike Alvarez', 'Sofia Reyes', 'Warren Zhang']);
  });

  it('returns an empty array for an unknown site', async () => {
    assert.deepStrictEqual(await getWorkersBySite('site-999'), []);
  });
});

describe('createBroadcast', () => {
  it('returns a broadcast with an id, timestamp, and the given fields', async () => {
    const broadcast = await createBroadcast('site-1', 'Crane lift at zone 3');
    assert.strictEqual(typeof broadcast.id, 'string');
    assert.ok(broadcast.id.length > 0);
    assert.strictEqual(broadcast.siteId, 'site-1');
    assert.strictEqual(broadcast.message, 'Crane lift at zone 3');
    assert.ok(broadcast.createdAt);
  });
});

describe('recordBroadcastAck / getAckStatus', () => {
  it('counts acknowledgments against the number of workers on the site', async () => {
    // site-1 has three seeded workers (Warren, Mike, Sofia).
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');

    let status = await getAckStatus(broadcast.id);
    assert.deepStrictEqual(status, { acknowledged: 0, total: 3 });

    await recordBroadcastAck(broadcast.id, '+15555550101');
    await recordBroadcastAck(broadcast.id, '+15555550102');
    status = await getAckStatus(broadcast.id);
    assert.deepStrictEqual(status, { acknowledged: 2, total: 3 });
  });

  it('counts a repeated acknowledgment from the same worker only once', async () => {
    const broadcast = await createBroadcast('site-1', 'Test');
    await recordBroadcastAck(broadcast.id, '+15555550101');
    await recordBroadcastAck(broadcast.id, '+15555550101');
    const status = await getAckStatus(broadcast.id);
    assert.strictEqual(status.acknowledged, 1);
  });

  it('reports zeros for an unknown broadcast', async () => {
    assert.deepStrictEqual(await getAckStatus('does-not-exist'), { acknowledged: 0, total: 0 });
  });
});

describe('setBroadcastMessage / getBroadcast', () => {
  it('stores and returns the Slack message reference on a broadcast', async () => {
    const broadcast = await createBroadcast('site-1', 'Test');
    await setBroadcastMessage(broadcast.id, 'C123', '1700000000.000100');
    const fetched = await getBroadcast(broadcast.id);
    assert.strictEqual(fetched?.channel, 'C123');
    assert.strictEqual(fetched?.messageTs, '1700000000.000100');
  });

  it('returns null for an unknown broadcast', async () => {
    assert.strictEqual(await getBroadcast('nope'), null);
  });
});
