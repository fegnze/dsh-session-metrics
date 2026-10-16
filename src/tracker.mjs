/**
 * Live per-Session tracker backing the local metrics route.
 *
 * The tracker is keyed by Session id and folds the durable log, so a Session
 * that already existed when the plugin loaded is backfilled from
 * `session.snapshotEvents()` and only new appends are added afterwards.
 */
import { emptyAccumulator, foldEvents, snapshot } from './metrics.mjs';

export function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
}

export function createTracker(sessions, now = Date.now) {
  const states = new Map();
  let disposed = false;

  function state(sessionId) {
    let entry = states.get(sessionId);
    if (entry) return entry;
    const accumulator = emptyAccumulator();
    const session = sessions.get(sessionId);
    if (session && typeof session.snapshotEvents === 'function') foldEvents(accumulator, session.snapshotEvents());
    entry = { accumulator, lastSeenAt: now() };
    states.set(sessionId, entry);
    return entry;
  }

  return {
    /** Fold one committed append; unknown Sessions are discovered lazily. */
    measure(sessionId, event) {
      if (disposed || !validSessionId(sessionId)) return;
      const entry = state(sessionId);
      entry.lastSeenAt = now();
      foldEvents(entry.accumulator, [event]);
    },
    /** A whole replayed log for a Session whose live objects are gone. */
    replay(sessionId, events) {
      if (disposed || !validSessionId(sessionId)) return;
      foldEvents(state(sessionId).accumulator, events);
    },
    read(sessionId) {
      if (disposed || !validSessionId(sessionId)) return null;
      const entry = states.get(sessionId);
      if (!entry) return null;
      return snapshot(entry.accumulator, now());
    },
    has(sessionId) {
      return states.has(sessionId);
    },
    /**
     * Report whether a Session exists at all, creating its tracker on first
     * read so that an open Session with no appends yet answers with zeros.
     */
    ensure(sessionId) {
      if (disposed || !validSessionId(sessionId)) return false;
      state(sessionId);
      return true;
    },
    /**
     * The most recently active Session, used only when the Client cannot name
     * one; an explicit Session id always wins over this inference.
     */
    latest() {
      let best = null;
      for (const [id, entry] of states) if (!best || entry.lastSeenAt > best.lastSeenAt) best = { id, lastSeenAt: entry.lastSeenAt };
      return best ? best.id : null;
    },
    forget(sessionId) {
      states.delete(sessionId);
    },
    dispose() {
      disposed = true;
      states.clear();
    },
  };
}
