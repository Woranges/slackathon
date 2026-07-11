import assert from 'node:assert';
import { describe, it } from 'node:test';

import { isIssueIntakeTrigger, nextStep, questionFor } from '../../features/procore-issue-intake/issue-intake.js';

/**
 * @param {Partial<{ stream: 'safety'|'rfi', location: string, description: string, severity: string, photoAsked: boolean }>} o
 */
function state(o = {}) {
  return {
    stream: o.stream ?? 'rfi',
    slots: {
      location: o.location ?? null,
      description: o.description ?? null,
      severity: o.severity ?? null,
      specReference: null,
    },
    photoAsked: o.photoAsked ?? false,
    photo: { photoSlackFileId: null, photoUrl: null },
    lastQuestion: null,
  };
}

describe('isIssueIntakeTrigger', () => {
  it('matches messages starting with "issue"', () => {
    assert.strictEqual(isIssueIntakeTrigger('issue'), true);
    assert.strictEqual(isIssueIntakeTrigger('Issue with the crane'), true);
    assert.strictEqual(isIssueIntakeTrigger('  issue '), true);
  });
  it('does not match unrelated messages', () => {
    assert.strictEqual(isIssueIntakeTrigger('what is the issue'), false);
    assert.strictEqual(isIssueIntakeTrigger('hello'), false);
  });
});

describe('nextStep (deterministic flow order)', () => {
  it('asks for location first when nothing is known', () => {
    assert.deepStrictEqual(nextStep(state()), { action: 'ask', field: 'location' });
  });

  it('asks for description once location is known', () => {
    assert.deepStrictEqual(nextStep(state({ location: '4th floor' })), { action: 'ask', field: 'description' });
  });

  it('asks for a photo once both required slots are filled (rfi)', () => {
    assert.deepStrictEqual(nextStep(state({ location: '4th floor', description: 'leak' })), { action: 'askPhoto' });
  });

  it('files only after the photo has been asked', () => {
    assert.deepStrictEqual(nextStep(state({ location: '4th floor', description: 'leak', photoAsked: true })), {
      action: 'file',
    });
  });

  it('requires severity for a safety report before asking for a photo', () => {
    const s = state({ stream: 'safety', location: '4th floor', description: 'exposed wiring' });
    assert.deepStrictEqual(nextStep(s), { action: 'ask', field: 'severity' });
  });

  it('asks a safety report for a photo only once severity is known', () => {
    const s = state({ stream: 'safety', location: '4th floor', description: 'exposed wiring', severity: 'urgent' });
    assert.deepStrictEqual(nextStep(s), { action: 'askPhoto' });
  });
});

describe('questionFor', () => {
  it('phrases the description question per stream', () => {
    assert.match(questionFor('description', 'safety'), /hazard/i);
    assert.match(questionFor('description', 'rfi'), /question or issue/i);
  });
  it('has a severity question only relevant to safety', () => {
    assert.match(questionFor('severity', 'safety'), /immediate danger/i);
  });
});
