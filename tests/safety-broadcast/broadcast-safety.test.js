import assert from 'node:assert';
import { describe, it } from 'node:test';

import { formatBroadcastStatus } from '../../features/safety-broadcast/broadcast-safety.js';

describe('formatBroadcastStatus', () => {
  it('includes the site, the message, and the acknowledgment count', () => {
    const text = formatBroadcastStatus({ site: 'site-1', message: 'Evacuate zone 3', acknowledged: 1, total: 3 });
    assert.ok(text.includes('site-1'), 'shows the site');
    assert.ok(text.includes('Evacuate zone 3'), 'shows the message');
    assert.ok(text.includes('1/3 acknowledged'), 'shows the count');
  });

  it('starts at 0 of the total when nothing is acknowledged yet', () => {
    const text = formatBroadcastStatus({ site: 'site-2', message: 'Gas leak', acknowledged: 0, total: 5 });
    assert.ok(text.includes('0/5 acknowledged'));
  });
});
