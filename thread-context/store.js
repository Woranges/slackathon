/**
 * @typedef {Object} StoreEntry
 * @property {import('@google/genai').Content[]} history
 * @property {number} timestamp
 */

/**
 * In-memory conversation-history store with TTL-based cleanup.
 *
 * Gemini's chat API doesn't support Claude's server-side session resume by
 * ID — the caller has to hold and replay the full turn history to continue
 * a conversation. So unlike a session-ID store, this tracks the actual
 * `Content[]` array per thread.
 */
export class ConversationStore {
  /**
   * @param {number} [ttlSeconds=86400]
   * @param {number} [maxEntries=1000]
   */
  constructor(ttlSeconds = 86400, maxEntries = 1000) {
    /** @type {Map<string, StoreEntry>} */
    this._store = new Map();
    /** @private @type {number} */
    this._ttlSeconds = ttlSeconds;
    /** @private @type {number} */
    this._maxEntries = maxEntries;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {import('@google/genai').Content[]}
   */
  getHistory(channelId, threadTs) {
    const key = `${channelId}:${threadTs}`;
    const entry = this._store.get(key);
    if (!entry) return [];
    if (Date.now() - entry.timestamp > this._ttlSeconds * 1000) {
      this._store.delete(key);
      return [];
    }
    return entry.history;
  }

  /**
   * Whether this thread has any stored history — used, e.g., to decide
   * whether the bot is already engaged in a channel thread reply.
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {boolean}
   */
  hasHistory(channelId, threadTs) {
    return this.getHistory(channelId, threadTs).length > 0;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @param {import('@google/genai').Content[]} history
   * @returns {void}
   */
  setHistory(channelId, threadTs, history) {
    const key = `${channelId}:${threadTs}`;
    this._store.set(key, {
      history,
      timestamp: Date.now(),
    });
    this._cleanup();
  }

  /**
   * @private
   * @returns {void}
   */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now - entry.timestamp > this._ttlSeconds * 1000) {
        this._store.delete(key);
      }
    }
    if (this._store.size > this._maxEntries) {
      const sorted = [...this._store.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, this._store.size - this._maxEntries);
      for (const [key] of toRemove) {
        this._store.delete(key);
      }
    }
  }
}
