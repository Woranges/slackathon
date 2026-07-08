import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildIssueRecord } from '../../features/procore-issue-intake/issue-record.js';

describe('buildIssueRecord', () => {
  const worker = { phone: '+15555550101', name: 'Mike Alvarez', siteId: 'site-1', preferredLanguage: 'en' };

  it('assembles reporter and site from the worker', () => {
    const record = buildIssueRecord({
      phone: '+15555550101',
      worker,
      area: '3rd floor, east stairwell',
      description: 'Loose handrail',
      timestamp: new Date('2026-07-07T12:00:00Z'),
    });

    assert.deepStrictEqual(record.reporter, { name: 'Mike Alvarez', phone: '+15555550101' });
    assert.strictEqual(record.siteId, 'site-1');
    assert.strictEqual(record.area, '3rd floor, east stairwell');
    assert.strictEqual(record.description, 'Loose handrail');
    assert.strictEqual(record.timestamp, '2026-07-07T12:00:00.000Z');
  });

  it('falls back gracefully when the worker is unknown', () => {
    const record = buildIssueRecord({
      phone: '+19998887777',
      worker: null,
      area: 'Parking lot',
      description: 'Pothole',
    });

    assert.strictEqual(record.reporter.name, 'Unknown worker');
    assert.strictEqual(record.reporter.phone, '+19998887777');
    assert.strictEqual(record.siteId, null);
  });

  it('defaults optional photo and geotag to null', () => {
    const record = buildIssueRecord({ phone: '+15555550101', worker, area: 'A', description: 'B' });
    assert.strictEqual(record.photoUrl, null);
    assert.strictEqual(record.geotag, null);
  });

  it('keeps a provided photo and geotag', () => {
    const record = buildIssueRecord({
      phone: '+15555550101',
      worker,
      area: 'A',
      description: 'B',
      photoUrl: 'https://example.com/p.jpg',
      geotag: { lat: 40.1, lng: -74.2 },
    });
    assert.strictEqual(record.photoUrl, 'https://example.com/p.jpg');
    assert.deepStrictEqual(record.geotag, { lat: 40.1, lng: -74.2 });
  });

  it('normalizes a string/number timestamp to an ISO string', () => {
    const record = buildIssueRecord({
      phone: '+15555550101',
      worker,
      area: 'A',
      description: 'B',
      timestamp: '2026-01-02T03:04:05Z',
    });
    assert.strictEqual(record.timestamp, '2026-01-02T03:04:05.000Z');
  });
});
