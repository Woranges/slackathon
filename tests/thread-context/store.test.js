import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { ConversationStore } from '../../thread-context/store.js';

describe('ConversationStore', () => {
  let store;

  beforeEach(() => {
    store = new ConversationStore();
  });

  it('stores and retrieves history', () => {
    const history = [{ role: 'user', parts: [{ text: 'hi' }] }];
    store.setHistory('C1', 'T1', history);
    assert.deepStrictEqual(store.getHistory('C1', 'T1'), history);
  });

  it('returns an empty array for missing key', () => {
    assert.deepStrictEqual(store.getHistory('C1', 'T99'), []);
  });

  it('hasHistory reflects whether a thread has stored history', () => {
    assert.strictEqual(store.hasHistory('C1', 'T1'), false);
    store.setHistory('C1', 'T1', [{ role: 'user', parts: [{ text: 'hi' }] }]);
    assert.strictEqual(store.hasHistory('C1', 'T1'), true);
  });

  it('keeps different threads independent', () => {
    const historyOne = [{ role: 'user', parts: [{ text: 'one' }] }];
    const historyTwo = [{ role: 'user', parts: [{ text: 'two' }] }];
    store.setHistory('C1', 'T1', historyOne);
    store.setHistory('C1', 'T2', historyTwo);
    assert.deepStrictEqual(store.getHistory('C1', 'T1'), historyOne);
    assert.deepStrictEqual(store.getHistory('C1', 'T2'), historyTwo);
  });

  it('expires entries after TTL', async () => {
    const shortStore = new ConversationStore(0);
    shortStore.setHistory('C1', 'T1', [{ role: 'user', parts: [{ text: 'hi' }] }]);
    // Need a tiny delay to ensure Date.now() advances past the stored timestamp
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(shortStore.getHistory('C1', 'T1'), []);
  });

  it('evicts oldest entries when max is exceeded', () => {
    const smallStore = new ConversationStore(86400, 2);
    smallStore.setHistory('C1', 'T1', [{ role: 'user', parts: [{ text: '1' }] }]);
    smallStore.setHistory('C1', 'T2', [{ role: 'user', parts: [{ text: '2' }] }]);
    smallStore.setHistory('C1', 'T3', [{ role: 'user', parts: [{ text: '3' }] }]);
    assert.deepStrictEqual(smallStore.getHistory('C1', 'T1'), []);
    assert.strictEqual(smallStore.hasHistory('C1', 'T2'), true);
    assert.strictEqual(smallStore.hasHistory('C1', 'T3'), true);
  });

  it('overwrites existing key', () => {
    store.setHistory('C1', 'T1', [{ role: 'user', parts: [{ text: 'old' }] }]);
    const newHistory = [{ role: 'user', parts: [{ text: 'new' }] }];
    store.setHistory('C1', 'T1', newHistory);
    assert.deepStrictEqual(store.getHistory('C1', 'T1'), newHistory);
  });
});
