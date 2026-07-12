import assert from 'node:assert';
import { describe, it } from 'node:test';

import { recordAckAndUpdateScoreboard } from '../../features/safety-broadcast/inbound-sms.js';
import { createBroadcast, getWorkersBySite, setBroadcastMessage } from '../../lib/db.js';

/** A stand-in Slack WebClient that records the chat.update calls it receives. */
function fakeClient() {
  /** @type {Array<{ channel: string, ts: string, text: string }>} */
  const updates = [];
  return { updates, chat: { update: async (args) => void updates.push(args) } };
}

describe('recordAckAndUpdateScoreboard', () => {
  it('records the ack and updates the scoreboard message with the new count', async () => {
    const broadcast = await createBroadcast('site-1', 'Crane lift at zone 3');
    await setBroadcastMessage(broadcast.id, 'C123', '1700000000.000100');
    const client = fakeClient();
    // Derive the expected denominator from the seed so this doesn't break when
    // workers are added to site-1.
    const total = (await getWorkersBySite('site-1')).length;

    // Mike (+15555550101) is on site-1 and replies "ok".
    const result = await recordAckAndUpdateScoreboard('+15555550101', client);

    assert.strictEqual(result?.id, broadcast.id);
    assert.strictEqual(client.updates.length, 1);
    const update = client.updates[0];
    assert.strictEqual(update.channel, 'C123');
    assert.strictEqual(update.ts, '1700000000.000100');
    assert.ok(update.text.includes(`1/${total} acknowledged`), `scoreboard shows 1 of ${total} acknowledged`);
    // The scoreboard shows the site's friendly name (siteLabel), matching the
    // initial post — site-1 renders as "Park Place".
    assert.ok(update.text.includes('Park Place'), 'scoreboard shows the site name');
  });

  it('does nothing for a reply from an unknown phone', async () => {
    const client = fakeClient();
    const result = await recordAckAndUpdateScoreboard('+19998887777', client);
    assert.strictEqual(result, null);
    assert.strictEqual(client.updates.length, 0);
  });

  it('records the ack but skips the Slack update when no message was posted', async () => {
    // A broadcast whose scoreboard message was never stored (e.g. postMessage failed).
    const broadcast = await createBroadcast('site-2', 'Gas leak');
    const client = fakeClient();

    // Chen Wei (+15555550103) is on site-2.
    const result = await recordAckAndUpdateScoreboard('+15555550103', client);

    assert.strictEqual(result?.id, broadcast.id);
    assert.strictEqual(client.updates.length, 0, 'no chat.update without a stored message');
  });
});
