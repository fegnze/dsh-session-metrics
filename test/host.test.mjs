import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, validSessionId } from '../src/tracker.mjs';
import { apply, sessionIdFrom, trusted } from '../src/host.mjs';

const event = (type, seq, time, data = {}) => ({ type, seq, time, data });

function store(seed = []) {
  const sessions = new Map();
  return {
    get: id => sessions.get(id),
    seed(id, events) {
      const list = [...events];
      sessions.set(id, { id, snapshotEvents: () => list, append: e => list.push(e) });
      return sessions.get(id);
    },
  };
}

test('session ids are validated before use', () => {
  assert.equal(validSessionId('session-abc_1.2:3'), true);
  assert.equal(validSessionId(''), false);
  assert.equal(validSessionId('../../etc/passwd'), false);
  assert.equal(validSessionId('a'.repeat(121)), false);
  assert.equal(validSessionId(undefined), false);
});

test('a live session is backfilled from its existing log', () => {
  const sessions = store();
  sessions.seed('session-1', [event('turn/start', 1, 0, { turn: 1 }), event('step/start', 2, 10, { turn: 1, step: 1 })]);
  const tracker = createTracker(sessions, () => 0);
  const before = tracker.read('session-1');
  assert.equal(before, null);
  tracker.ensure('session-1');
  assert.equal(tracker.read('session-1').steps, 1);
});

test('appended events are folded once, unknown sessions are created on demand', () => {
  const sessions = store();
  const tracker = createTracker(sessions, () => 0);
  tracker.measure('session-9', event('turn/start', 1, 0, { turn: 1 }));
  tracker.measure('session-9', event('turn/start', 1, 0, { turn: 1 }));
  tracker.measure('session-9', event('turn/end', 2, 50, { turn: 1, reason: { kind: 'completed' } }));
  const metrics = tracker.read('session-9');
  assert.equal(metrics.turns, 1);
  assert.equal(metrics.lastTurnMs, 50);
  assert.equal(tracker.read('nope'), null);
});

test('an invalid id is refused without creating state', () => {
  const tracker = createTracker(store(), () => 0);
  tracker.measure('../x', event('turn/start', 1, 0, { turn: 1 }));
  assert.equal(tracker.has('../x'), false);
  assert.equal(tracker.ensure('../x'), false);
});

test('forget drops a disposed session and dispose clears everything', () => {
  const tracker = createTracker(store(), () => 0);
  tracker.measure('session-1', event('turn/start', 1, 0, { turn: 1 }));
  tracker.forget('session-1');
  assert.equal(tracker.read('session-1'), null);
  tracker.measure('session-2', event('turn/start', 1, 0, { turn: 1 }));
  tracker.dispose();
  assert.equal(tracker.read('session-2'), null);
  tracker.measure('session-3', event('turn/start', 1, 0, { turn: 1 }));
  assert.equal(tracker.has('session-3'), false);
});

test('the route accepts only loopback, same-origin, custom-header requests', () => {
  const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin', 'x-dsh-session-metrics': '1' } };
  assert.equal(trusted(base), true);
  assert.equal(trusted({ ...base, headers: { ...base.headers, 'x-dsh-session-metrics': undefined } }), false);
  assert.equal(trusted({ ...base, socket: { remoteAddress: '10.0.0.4' } }), false);
  assert.equal(trusted({ ...base, headers: { ...base.headers, origin: 'http://evil.example' } }), false);
  assert.equal(trusted({ ...base, headers: { ...base.headers, 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(trusted({ ...base, headers: { ...base.headers, host: 'evil.example' } }), false);
});

test('the session id is read from the query and rejected when malformed', () => {
  assert.equal(sessionIdFrom('/myspace-session-metrics/api?sessionId=session-42'), 'session-42');
  assert.equal(sessionIdFrom('/myspace-session-metrics/api'), null);
  assert.equal(sessionIdFrom('/myspace-session-metrics/api?sessionId=' + encodeURIComponent('../x')), null);
});

test('the route serves the turn-scoped model time alongside the whole-log figures', () => {
  const sessions = store();
  sessions.seed('session-1', [
    event('turn/start', 1, 1000, { turn: 1 }),
    event('step/start', 2, 1100, { turn: 1, step: 1 }),
    event('assistant/message', 3, 3100, { turn: 1, step: 1, stream: [] }),
    event('step/end', 4, 3150, { turn: 1, step: 1 }),
  ]);
  let handler = null;
  const ctx = {
    sessions,
    effect: callback => callback(),
    on: () => () => {},
    webServer: { register: spec => { handler = spec.handler; return () => {}; } },
  };
  apply(ctx);
  assert.equal(typeof handler, 'function');
  const headers = {};
  let body = null;
  handler(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387', 'x-dsh-session-metrics': '1' }, method: 'GET', url: '/myspace-session-metrics/api?sessionId=session-1' },
    { setHeader: (name, value) => { headers[name] = value; }, end: chunk => { body = chunk; } },
  );
  const payload = JSON.parse(body);
  assert.equal(payload.state, 'ready');
  assert.equal(payload.metrics.llmMs, 2000);
  assert.equal(payload.metrics.turnLlmMs, 2000);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});
