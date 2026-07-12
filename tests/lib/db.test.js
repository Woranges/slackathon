import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  createBroadcast,
  getAckStatus,
  getBroadcast,
  getBroadcastAudit,
  getLatestBroadcastForPhone,
  getWorkerByPhone,
  getWorkerBySlackUserId,
  getWorkersBySite,
  hasAcked,
  recordBroadcastAck,
  recordEscalation,
  setBroadcastMessage,
  siteLabel,
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

describe('siteLabel', () => {
  it('maps a known site id to its human name', () => {
    assert.strictEqual(siteLabel('site-1'), 'Park Place');
  });

  it('falls back to the id for an unknown site, and null for empty', () => {
    assert.strictEqual(siteLabel('site-xyz'), 'site-xyz');
    assert.strictEqual(siteLabel(null), null);
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

describe('getLatestBroadcastForPhone', () => {
  it("returns the most recent broadcast for the worker's site", async () => {
    const older = await createBroadcast('site-1', 'Older alert');
    const newer = await createBroadcast('site-1', 'Newer alert');
    // Sofia (+15555550102) is on site-1, so she should map to the newest site-1 broadcast.
    const found = await getLatestBroadcastForPhone('+15555550102');
    assert.strictEqual(found?.id, newer.id);
    assert.notStrictEqual(found?.id, older.id);
  });

  it('matches the worker regardless of phone formatting', async () => {
    const broadcast = await createBroadcast('site-1', 'Formatted-phone alert');
    // Mike is +15555550101; look him up with human formatting.
    const found = await getLatestBroadcastForPhone('+1 (555) 555-0101');
    assert.strictEqual(found?.id, broadcast.id);
  });

  it('returns null for an unknown phone', async () => {
    await createBroadcast('site-1', 'Alert');
    assert.strictEqual(await getLatestBroadcastForPhone('+19998887777'), null);
  });

  it("returns null when the worker's site has no broadcast", async () => {
    // Chen Wei is on site-2; no site-2 broadcast has been created in this file.
    assert.strictEqual(await getLatestBroadcastForPhone('+15555550103'), null);
  });
});

describe('hasAcked', () => {
  it('is true after a worker acknowledges, false before', async () => {
    const broadcast = await createBroadcast('site-1', 'Alert');
    assert.strictEqual(await hasAcked(broadcast.id, '+15555550101'), false);
    await recordBroadcastAck(broadcast.id, '+15555550101');
    assert.strictEqual(await hasAcked(broadcast.id, '+15555550101'), true);
  });

  it('is false for a worker who has not acknowledged this broadcast', async () => {
    const broadcast = await createBroadcast('site-1', 'Alert');
    await recordBroadcastAck(broadcast.id, '+15555550101');
    assert.strictEqual(await hasAcked(broadcast.id, '+15555550102'), false);
  });
});

describe('getBroadcastAudit', () => {
  it('returns a row for every worker the broadcast was sent to', async () => {
    const broadcast = await createBroadcast('site-1', 'Evacuate zone 3');
    const audit = await getBroadcastAudit(broadcast.id);

    // site-1 has three seeded workers.
    assert.strictEqual(audit.length, 3);
    for (const row of audit) {
      assert.ok(row.phone, 'every row carries the worker phone');
      assert.ok(row.name, 'every row carries the worker name');
    }
  });

  it('timestamps an acknowledgment so the record shows WHEN it happened', async () => {
    const broadcast = await createBroadcast('site-1', 'Alert');
    const before = Date.now();
    await recordBroadcastAck(broadcast.id, '+15555550101');

    const row = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550101');
    assert.ok(row?.ackedAt, 'an acknowledged worker has an ackedAt timestamp');
    // A real ISO 8601 instant, at or after the moment we recorded it.
    const acked = new Date(/** @type {string} */ (row.ackedAt)).getTime();
    assert.ok(Number.isFinite(acked), 'ackedAt parses as a date');
    assert.ok(acked >= before - 1000 && acked <= Date.now() + 1000, 'ackedAt is the time of the ack');
  });

  it('leaves ackedAt null for a worker who never acknowledged', async () => {
    const broadcast = await createBroadcast('site-1', 'Alert');
    await recordBroadcastAck(broadcast.id, '+15555550101');

    const row = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550102');
    assert.strictEqual(row?.ackedAt, null);
  });

  it('keeps the FIRST acknowledgment time when a worker acks twice', async () => {
    // The legally relevant instant is when they first confirmed they were warned —
    // a duplicate "ok" must not quietly rewrite the record to a later time.
    const broadcast = await createBroadcast('site-1', 'Alert');
    await recordBroadcastAck(broadcast.id, '+15555550101');
    const first = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550101')?.ackedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordBroadcastAck(broadcast.id, '+15555550101');
    const second = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550101')?.ackedAt;

    assert.strictEqual(second, first, 'the original ack time survives a repeat ack');
  });

  it('records when a worker was escalated to a voice call', async () => {
    const broadcast = await createBroadcast('site-1', 'Alert');
    await recordEscalation(broadcast.id, '+15555550102');

    const row = (await getBroadcastAudit(broadcast.id)).find((r) => r.phone === '+15555550102');
    assert.ok(row?.escalatedAt, 'an escalated worker has an escalatedAt timestamp');
    assert.ok(Number.isFinite(new Date(/** @type {string} */ (row.escalatedAt)).getTime()));
    assert.strictEqual(row?.ackedAt, null, 'escalating does not fabricate an acknowledgment');
  });

  it('returns no rows for an unknown broadcast', async () => {
    assert.deepStrictEqual(await getBroadcastAudit('does-not-exist'), []);
  });
});
