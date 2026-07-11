import assert from 'node:assert';
import { describe, it } from 'node:test';

import { getWorkerByPhone, getWorkerBySlackUserId, getWorkersBySite } from '../../lib/db.js';

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
