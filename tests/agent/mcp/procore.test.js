import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { buildRfiPayload, isProcoreConfigured } from '../../../agent/mcp/procore.js';

/** @type {import('../../../features/procore-issue-intake/issue-record.js').IssueRecord} */
const record = {
  reporter: { name: 'Mike Alvarez', phone: '+15555550101' },
  siteId: 'site-1',
  area: '3rd floor, east stairwell',
  description: 'Loose handrail',
  photoUrl: 'https://example.com/p.jpg',
  geotag: { lat: 40.1, lng: -74.2 },
  timestamp: '2026-07-07T12:00:00.000Z',
};

const PROCORE_VARS = [
  'PROCORE_BASE_URL',
  'PROCORE_CLIENT_ID',
  'PROCORE_CLIENT_SECRET',
  'PROCORE_COMPANY_ID',
  'PROCORE_PROJECT_ID',
];

describe('buildRfiPayload', () => {
  it('puts the area in the subject', () => {
    const payload = buildRfiPayload(record);
    assert.strictEqual(payload.rfi.subject, 'Field issue: 3rd floor, east stairwell');
  });

  it('includes description, reporter, site, location and photo in the body', () => {
    const body = buildRfiPayload(record).rfi.questions[0].body;
    assert.match(body, /Loose handrail/);
    assert.match(body, /Mike Alvarez \(\+15555550101\)/);
    assert.match(body, /Site: site-1/);
    assert.match(body, /40\.1, -74\.2/);
    assert.match(body, /example\.com\/p\.jpg/);
  });

  it('omits optional lines that are absent', () => {
    const bare = { ...record, siteId: null, geotag: null, photoUrl: null };
    const body = buildRfiPayload(bare).rfi.questions[0].body;
    assert.doesNotMatch(body, /Site:/);
    assert.doesNotMatch(body, /Location:/);
    assert.doesNotMatch(body, /Photo:/);
  });
});

describe('isProcoreConfigured', () => {
  afterEach(() => {
    for (const v of PROCORE_VARS) delete process.env[v];
  });

  it('is false when nothing is set', () => {
    assert.strictEqual(isProcoreConfigured(), false);
  });

  it('is true only when every required var is present', () => {
    for (const v of PROCORE_VARS) process.env[v] = 'x';
    assert.strictEqual(isProcoreConfigured(), true);
    delete process.env.PROCORE_PROJECT_ID;
    assert.strictEqual(isProcoreConfigured(), false);
  });
});
