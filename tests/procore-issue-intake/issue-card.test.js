import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  buildIssueCardBlocks,
  ISSUE_ASSIGN_ACTION,
  ISSUE_ESCALATE_ACTION,
  ISSUE_RESOLVED_ACTION,
  postIssueCard,
} from '../../features/procore-issue-intake/issue-card.js';

/** @type {import('../../features/procore-issue-intake/issue-record.js').IssueRecord} */
const record = {
  reporter: { name: 'Mike Alvarez', phone: '+15555550101' },
  siteId: 'site-1',
  area: '3rd floor, east stairwell',
  description: 'Loose handrail',
  photoUrl: null,
  geotag: null,
  timestamp: '2026-07-07T12:00:00.000Z',
};

/** @param {import('@slack/types').KnownBlock[]} blocks */
function actionsBlock(blocks) {
  return blocks.find((b) => b.type === 'actions');
}

describe('buildIssueCardBlocks', () => {
  it('includes the three action buttons carrying the reporter phone', () => {
    const actions = actionsBlock(buildIssueCardBlocks(record));
    assert.ok(actions, 'expected an actions block');
    const byAction = Object.fromEntries(actions.elements.map((e) => [e.action_id, e.value]));
    assert.strictEqual(byAction[ISSUE_ASSIGN_ACTION], '+15555550101');
    assert.strictEqual(byAction[ISSUE_ESCALATE_ACTION], '+15555550101');
    assert.strictEqual(byAction[ISSUE_RESOLVED_ACTION], '+15555550101');
  });

  it('omits the image block when there is no photo', () => {
    const blocks = buildIssueCardBlocks(record);
    assert.strictEqual(
      blocks.some((b) => b.type === 'image'),
      false,
    );
  });

  it('includes an image block with the photo url when present', () => {
    const blocks = buildIssueCardBlocks({ ...record, photoUrl: 'https://example.com/p.jpg' });
    const image = blocks.find((b) => b.type === 'image');
    assert.ok(image, 'expected an image block');
    assert.strictEqual(image.image_url, 'https://example.com/p.jpg');
  });

  it('renders the area and description in the card text', () => {
    const text = JSON.stringify(buildIssueCardBlocks(record));
    assert.ok(text.includes('3rd floor, east stairwell'));
    assert.ok(text.includes('Loose handrail'));
  });
});

describe('postIssueCard', () => {
  afterEach(() => {
    delete process.env.MANAGEMENT_CHANNEL_ID;
  });

  /** Fake Slack client that records postMessage calls. */
  function fakeClient(calls) {
    return {
      chat: {
        postMessage: async (args) => {
          calls.push(args);
          return { ts: '1700000000.000100' };
        },
      },
    };
  }

  it('skips (no throw) when MANAGEMENT_CHANNEL_ID is unset', async () => {
    const calls = [];
    const result = await postIssueCard(fakeClient(calls), record);
    assert.strictEqual(result.posted, false);
    assert.strictEqual(calls.length, 0);
  });

  it('posts blocks + fallback text to the configured channel', async () => {
    process.env.MANAGEMENT_CHANNEL_ID = 'C123MGMT';
    const calls = [];
    const result = await postIssueCard(fakeClient(calls), record);
    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.channel, 'C123MGMT');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].channel, 'C123MGMT');
    assert.ok(Array.isArray(calls[0].blocks));
    assert.match(calls[0].text, /New site issue reported/);
  });
});
