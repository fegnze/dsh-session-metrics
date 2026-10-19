import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAccumulator, foldEvent, foldEvents, formatCount, formatDuration, formatRate, snapshot, streamTimes } from '../src/metrics.mjs';

const event = (type, seq, time, data = {}) => ({ type, seq, time, data });

function fold(events) {
  return foldEvents(emptyAccumulator(), events);
}

test('turn, step and model timings come from the log clock', () => {
  const acc = fold([
    event('turn/start', 1, 1000, { turn: 1 }),
    event('step/start', 2, 1010, { turn: 1, step: 1 }),
    event('assistant/message', 3, 3010, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1210, chunk: { type: 'text-delta', index: 0, text: 'a' } }, { type: 'chunk', time: 2910, chunk: { type: 'text-delta', index: 0, text: 'b' } }], usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 20 } }),
    event('step/end', 4, 3050, { turn: 1, step: 1 }),
    event('turn/end', 5, 4000, { turn: 1, reason: { kind: 'completed' } }),
  ]);
  const s = snapshot(acc, 9000);
  assert.equal(s.turns, 1);
  assert.equal(s.steps, 1);
  assert.equal(s.llmMs, 2000);
  assert.equal(s.turnLlmMs, 2000);
  assert.equal(s.ttftMs, 200);
  assert.equal(s.ttftCoveredSteps, 1);
  assert.equal(s.decodeMs, 1700);
  assert.equal(s.tokensPerSecond, 40 / 1.7);
  assert.equal(s.usage.total, 100 + 900 + 20 + 40);
  assert.equal(s.usage.cacheHitPercent, 88);
  assert.equal(s.lastTurnMs, 3000);
  assert.equal(s.latencyMs, 3000);
  assert.equal(s.running, false);
});

test('an unterminated step is not counted twice', () => {
  const acc = fold([
    event('turn/start', 1, 0, { turn: 1 }),
    event('step/start', 2, 100, { turn: 1, step: 1 }),
    event('assistant/message', 3, 900, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 300, chunk: { type: 'chunk', time: 300, chunk: { type: 'finish', reason: { kind: 'stop' } } } }] }),
    event('step/end', 4, 1000, { turn: 1, step: 1 }),
  ]);
  assert.equal(snapshot(acc, 0).llmMs, 800);
});

test('tool calls pair by callId and aggregate by name', () => {
  const acc = fold([
    event('tool/call', 1, 100, { callId: 'c1', name: 'read' }),
    event('tool/result', 2, 400, { message: { toolCallId: 'c1', isError: false } }),
    event('tool/call', 3, 500, { callId: 'c2', name: 'read' }),
    event('tool/result', 4, 900, { message: { toolCallId: 'c2', isError: true }, error: { name: 'x', code: 'y' } }),
    event('tool/call', 5, 1000, { callId: 'c3', name: 'bash' }),
    event('tool/result', 6, 3500, { message: { toolCallId: 'c3' } }),
  ]);
  const s = snapshot(acc, 0);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.toolMs, 3200);
  assert.deepEqual(s.tools.map(t => [t.name, t.calls, t.ms, t.errors]), [['bash', 1, 2500, 0], ['read', 2, 700, 1]]);
  assert.equal(s.pendingToolCalls, 0);
});

test('a turn that ends with an open tool call closes it as an error', () => {
  const acc = fold([
    event('turn/start', 1, 0, { turn: 1 }),
    event('tool/call', 2, 100, { callId: 'c1', name: 'bash' }),
    event('turn/end', 3, 700, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]);
  const s = snapshot(acc, 0);
  assert.equal(s.pendingToolCalls, 0);
  assert.deepEqual(s.tools[0], { name: 'bash', calls: 1, ms: 600, errors: 1 });
});

test('replayed events are folded exactly once and out-of-order events are ignored', () => {
  const acc = emptyAccumulator();
  const log = [event('turn/start', 1, 0, { turn: 1 }), event('step/start', 2, 10, { turn: 1, step: 1 })];
  foldEvents(acc, log);
  foldEvents(acc, log);
  assert.equal(snapshot(acc, 0).steps, 1);
  foldEvent(acc, event('step/start', 2, 10, { turn: 1, step: 1 }));
  assert.equal(snapshot(acc, 0).steps, 1);
});

test('a running turn reports its open-start window without inventing time', () => {
  const acc = fold([event('turn/start', 1, 1000, { turn: 3 })]);
  const s = snapshot(acc, 4500);
  assert.equal(s.running, true);
  assert.equal(s.currentTurn, 3);
  assert.equal(s.currentTurnElapsedMs, 3500);
  assert.equal(s.lastTurnMs, null);
  assert.equal(s.turnLlmMs, 0);
});

test('turn model time covers the running turn only, joining the whole-log total', () => {
  const acc = fold([
    event('turn/start', 1, 0, { turn: 1 }),
    event('step/start', 2, 100, { turn: 1, step: 1 }),
    event('assistant/message', 3, 1100, { turn: 1, step: 1, stream: [] }),
    event('step/end', 4, 1200, { turn: 1, step: 1 }),
    event('turn/end', 5, 1500, { turn: 1, reason: { kind: 'completed' } }),
  ]);
  assert.equal(snapshot(acc, 9000).turnLlmMs, 1000);
  assert.equal(snapshot(acc, 9000).llmMs, 1000, 'one turn: both figures agree');

  foldEvents(acc, [
    event('turn/start', 6, 2000, { turn: 2 }),
    event('step/start', 7, 2100, { turn: 2, step: 1 }),
    event('assistant/message', 8, 2600, { turn: 2, step: 1, stream: [] }),
    event('step/end', 9, 2700, { turn: 2, step: 1 }),
  ]);
  // Closed steps of the open turn only: the first turn no longer adds in.
  assert.equal(snapshot(acc, 9000).turnLlmMs, 500);
  assert.equal(snapshot(acc, 9000).llmMs, 1500);

  // An open step counts as elapsed model time until its message assembles.
  foldEvents(acc, [event('step/start', 10, 3000, { turn: 2, step: 2 })]);
  assert.equal(snapshot(acc, 4000).turnLlmMs, 1500);
  foldEvents(acc, [
    event('assistant/message', 11, 4000, { turn: 2, step: 2, stream: [] }),
    event('step/end', 12, 4050, { turn: 2, step: 2 }),
  ]);
  assert.equal(snapshot(acc, 9000).turnLlmMs, 1500, 'the charged step replaces the live estimate');
  assert.equal(snapshot(acc, 9000).llmMs, 2500);

  foldEvents(acc, [event('turn/end', 13, 4100, { turn: 2, reason: { kind: 'completed' } })]);
  assert.equal(snapshot(acc, 9000).turnLlmMs, 1500, 'an idle row keeps the last closed turn');
  assert.equal(snapshot(acc, 9000).running, false);
});

test('streamTimes reads chunk and delta records and tolerates garbage', () => {
  assert.deepEqual(streamTimes(undefined), { first: null, last: null });
  assert.deepEqual(streamTimes([{ type: 'text-chunks', time0: 100, dt: [10, 20], texts: ['a', 'b'] }, { type: 'chunk', time: 500, chunk: {} }]), { first: 100, last: 500 });
  assert.deepEqual(streamTimes([{ type: 'text-chunks', time0: 100, dt: [], texts: [] }]), { first: null, last: null });
});

test('missing usage never fabricates a cache-hit ratio', () => {
  const acc = fold([event('turn/start', 1, 0, { turn: 1 })]);
  assert.equal(snapshot(acc, 0).usage.cacheHitPercent, null);
  assert.equal(snapshot(acc, 0).usage.total, 0);
});

test('formatting stays compact and explicit', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(948), '948');
  assert.equal(formatCount(12500), '12.5k');
  assert.equal(formatCount(2400000), '2.4M');
  assert.equal(formatDuration(8400), '8.4s');
  assert.equal(formatDuration(162000), '2m42s');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatRate(12.34), '12.3 tok/s');
  assert.equal(formatRate(0), null);
});
