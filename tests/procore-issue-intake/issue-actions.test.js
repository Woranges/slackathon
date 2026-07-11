import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  applyIssueStatus,
  buildAssignmentMessage,
  handleIssueAssignSelect,
  handleIssueResolved,
} from '../../features/procore-issue-intake/issue-actions.js';

const cardBlocks = [
  { type: 'header', text: { type: 'plain_text', text: ':construction: New site issue' } },
  { type: 'section', text: { type: 'mrkdwn', text: '*Description:*\nLoose handrail' } },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Assign' },
        action_id: 'issue_assign',
        value: '+15555550101',
      },
    ],
  },
];

describe('applyIssueStatus', () => {
  it('removes the actions block and appends a status context block', () => {
    const out = applyIssueStatus(cardBlocks, ':white_check_mark: *Assigned*');
    assert.strictEqual(
      out.some((b) => b.type === 'actions'),
      false,
      'buttons should be gone',
    );
    const last = out[out.length - 1];
    assert.strictEqual(last.type, 'context');
    assert.strictEqual(last.elements[0].text, ':white_check_mark: *Assigned*');
  });

  it('keeps the non-action blocks intact', () => {
    const out = applyIssueStatus(cardBlocks, 'status');
    assert.ok(out.some((b) => b.type === 'header'));
    assert.ok(out.some((b) => b.type === 'section'));
  });

  it('tolerates undefined blocks', () => {
    const out = applyIssueStatus(undefined, 'status');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, 'context');
  });
});

describe('handleIssueResolved', () => {
  function harness() {
    const updates = [];
    return {
      updates,
      args: {
        ack: async () => {},
        client: { chat: { update: async (a) => updates.push(a) } },
        logger: { info: () => {}, error: () => {} },
        body: {
          user: { id: 'U999' },
          channel: { id: 'C123MGMT' },
          message: { ts: '1700000000.000100', blocks: cardBlocks },
          actions: [{ value: '+15555550101' }],
        },
      },
    };
  }

  it('updates the card with a Resolved status and no buttons, despite the SMS stub throwing', async () => {
    const { updates, args } = harness();
    await handleIssueResolved(args); // sendSms throws internally; must be swallowed
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].channel, 'C123MGMT');
    assert.strictEqual(updates[0].ts, '1700000000.000100');
    assert.strictEqual(
      updates[0].blocks.some((b) => b.type === 'actions'),
      false,
    );
    assert.match(JSON.stringify(updates[0].blocks), /Resolved/);
    assert.match(JSON.stringify(updates[0].blocks), /U999/);
  });
});

describe('buildAssignmentMessage', () => {
  const cardWithDetails = [
    { type: 'header', text: { type: 'plain_text', text: ':construction: New RFI' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Area:*\nLevel 3, west stairwell' },
        { type: 'mrkdwn', text: '*Site:*\nPark Place' },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: '*Description:*\nHandrail bracket spacing is wrong' } },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: ':page_facing_up: Procore <https://sandbox.procore.com/x/104063|RFI #104063>' },
      ],
    },
  ];

  it('includes rfi number, site, area, description, and the Procore link', () => {
    const msg = buildAssignmentMessage(cardWithDetails, 104063);
    assert.match(msg, /#104063/);
    assert.match(msg, /Park Place/);
    assert.match(msg, /Area: Level 3, west stairwell/);
    assert.match(msg, /Issue: Handrail bracket spacing is wrong/);
    assert.match(msg, /Details: https:\/\/sandbox\.procore\.com\/x\/104063/);
  });

  it('degrades gracefully when the card has no details', () => {
    const msg = buildAssignmentMessage([], null);
    assert.match(msg, /assigned a new RFI/);
    assert.match(msg, /review the details in Procore/);
  });
});

describe('handleIssueAssignSelect', () => {
  it('marks the card assigned to the chosen worker (name in status), buttons gone, SMS failure swallowed', async () => {
    const updates = [];
    const args = {
      ack: async () => {},
      client: { chat: { update: async (a) => updates.push(a) } },
      logger: { info: () => {}, error: () => {} },
      body: {
        user: { id: 'U999' },
        channel: { id: 'C123MGMT' },
        message: { ts: '1700000000.000100', blocks: cardBlocks },
        // static_select fires with selected_option, not value.
        actions: [{ selected_option: { value: JSON.stringify({ p: '+15555550102', n: 'Sofia Reyes', r: 42 }) } }],
      },
    };
    await handleIssueAssignSelect(args); // sendSms throws internally; must be swallowed
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(
      updates[0].blocks.some((b) => b.type === 'actions'),
      false,
      'buttons should be gone',
    );
    assert.match(JSON.stringify(updates[0].blocks), /Assigned to Sofia Reyes/);
    assert.match(JSON.stringify(updates[0].blocks), /U999/);
  });
});
