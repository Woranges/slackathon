import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  buildIssueCardBlocks,
  ISSUE_ASSIGN_ACTION,
  ISSUE_ASSIGN_SELECT_ACTION,
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
  photoSlackFileId: null,
  geotag: null,
  timestamp: '2026-07-07T12:00:00.000Z',
};

/** @param {import('@slack/types').KnownBlock[]} blocks */
function actionsBlock(blocks) {
  return blocks.find((b) => b.type === 'actions');
}

/** @param {import('@slack/types').KnownBlock[]} blocks */
function hasPhotoHint(blocks) {
  return blocks.some((b) => b.type === 'context' && JSON.stringify(b.elements).includes('Photo attached in thread'));
}

describe('buildIssueCardBlocks', () => {
  it('an RFI card with no assignees shows a plain Assign button + Resolved (reporter phone + RFI id)', () => {
    const actions = actionsBlock(buildIssueCardBlocks(record, { id: 42, url: 'https://x/42' }));
    assert.ok(actions, 'expected an actions block');
    const ids = actions.elements.map((e) => e.action_id);
    assert.deepStrictEqual(ids, [ISSUE_ASSIGN_ACTION, ISSUE_RESOLVED_ACTION]);
    assert.ok(!ids.includes(ISSUE_ESCALATE_ACTION), 'RFI card should not have Escalate');
    for (const el of actions.elements) {
      const v = JSON.parse(el.value);
      assert.strictEqual(v.phone, '+15555550101');
      assert.strictEqual(v.rfiId, 42);
    }
  });

  it('an RFI card with assignees shows an Assign dropdown carrying each worker + Resolved', () => {
    const assignees = [
      { name: 'Sofia Reyes', phone: '+15555550102' },
      { name: 'Chen Wei', phone: '+15555550103' },
    ];
    const actions = actionsBlock(buildIssueCardBlocks(record, { id: 42, url: 'https://x/42' }, assignees));
    const select = actions.elements.find((e) => e.action_id === ISSUE_ASSIGN_SELECT_ACTION);
    assert.ok(select, 'expected an Assign dropdown');
    assert.strictEqual(select.type, 'static_select');
    assert.strictEqual(select.options.length, 2);
    const first = JSON.parse(select.options[0].value);
    assert.strictEqual(first.p, '+15555550102');
    assert.strictEqual(first.n, 'Sofia Reyes');
    assert.strictEqual(first.r, 42);
    // Resolved is still present; no plain Assign button when the dropdown is shown.
    const ids = actions.elements.map((e) => e.action_id);
    assert.ok(ids.includes(ISSUE_RESOLVED_ACTION));
    assert.ok(!ids.includes(ISSUE_ASSIGN_ACTION));
  });

  it('a safety card shows Escalate + Resolved, never Assign', () => {
    const actions = actionsBlock(
      buildIssueCardBlocks({ ...record, reportType: 'safety', severity: 'urgent' }, { id: 7, url: null }, [
        { name: 'Sofia Reyes', phone: '+15555550102' },
      ]),
    );
    const ids = actions.elements.map((e) => e.action_id);
    assert.deepStrictEqual(ids, [ISSUE_ESCALATE_ACTION, ISSUE_RESOLVED_ACTION]);
    assert.ok(!ids.includes(ISSUE_ASSIGN_ACTION) && !ids.includes(ISSUE_ASSIGN_SELECT_ACTION));
  });

  it('never renders an inline image block (photos go in the thread)', () => {
    const blocks = buildIssueCardBlocks({ ...record, photoSlackFileId: 'F_DM_1' });
    assert.strictEqual(
      blocks.some((b) => b.type === 'image'),
      false,
    );
  });

  it('omits the photo hint when there is no photo', () => {
    assert.strictEqual(hasPhotoHint(buildIssueCardBlocks(record)), false);
  });

  it('shows the photo hint for a DM file id', () => {
    assert.strictEqual(hasPhotoHint(buildIssueCardBlocks({ ...record, photoSlackFileId: 'F_DM_1' })), true);
  });

  it('shows the photo hint for a photo url', () => {
    assert.strictEqual(hasPhotoHint(buildIssueCardBlocks({ ...record, photoUrl: 'https://example.com/p.jpg' })), true);
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

  /** Fake Slack client that records postMessage + file upload calls. */
  function fakeClient(calls) {
    return {
      token: 'xoxb-test',
      chat: {
        postMessage: async (args) => {
          calls.posts.push(args);
          return { ts: '1700000000.000100' };
        },
      },
      files: {
        info: async () => ({ file: { url_private_download: 'https://files.slack.example/dl' } }),
        uploadV2: async (args) => {
          calls.uploads.push(args);
          return { files: [{ id: 'F_BOT_1' }] };
        },
      },
    };
  }

  it('skips (no throw) when MANAGEMENT_CHANNEL_ID is unset', async () => {
    const calls = { posts: [], uploads: [] };
    const result = await postIssueCard(fakeClient(calls), record);
    assert.strictEqual(result.posted, false);
    assert.strictEqual(calls.posts.length, 0);
  });

  it('posts blocks + fallback text to the configured channel', async () => {
    process.env.MANAGEMENT_CHANNEL_ID = 'C123MGMT';
    const calls = { posts: [], uploads: [] };
    const result = await postIssueCard(fakeClient(calls), record);
    assert.strictEqual(result.posted, true);
    assert.strictEqual(result.channel, 'C123MGMT');
    assert.strictEqual(calls.posts.length, 1);
    assert.strictEqual(calls.posts[0].channel, 'C123MGMT');
    assert.ok(Array.isArray(calls.posts[0].blocks));
    // Fallback text is a self-contained summary (also the only thing RTS indexes):
    // type + area + description all present.
    assert.match(calls.posts[0].text, /New RFI/);
    assert.match(calls.posts[0].text, new RegExp(record.area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(calls.posts[0].text, new RegExp(record.description));
    // No photo on this record → no thread upload.
    assert.strictEqual(calls.uploads.length, 0);
  });

  it('uploads a DM photo into the card thread', async () => {
    process.env.MANAGEMENT_CHANNEL_ID = 'C123MGMT';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const calls = { posts: [], uploads: [] };
    try {
      const result = await postIssueCard(fakeClient(calls), { ...record, photoSlackFileId: 'F_DM_1' });
      assert.strictEqual(result.posted, true);
      assert.strictEqual(calls.posts.length, 1);
      assert.strictEqual(calls.uploads.length, 1);
      // Photo is uploaded into the card's thread, in the same channel.
      assert.strictEqual(calls.uploads[0].channel_id, 'C123MGMT');
      assert.strictEqual(calls.uploads[0].thread_ts, result.ts);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
