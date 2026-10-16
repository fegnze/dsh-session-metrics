import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Component, createElement, useMemo, useRef, useState, useEffect } from './support/react-seam.mjs';
import { mount, text } from './support/render.mjs';

const SOURCE = new URL('../src/client.js', import.meta.url);

/** Load the shipped Client bundle through the ModuleLoader seam it expects. */
async function loadClient() {
  const source = await readFile(SOURCE, 'utf8');
  let loaded = null;
  // The bundle's `window` parameter stands in for the browser global, so for
  // anything but the ModuleLoader seam it forwards to what the test set up.
  const window = new Proxy(
    { __ModuleLoader__: { load: registration => { loaded = registration; } } },
    { get: (own, key) => key in own ? own[key] : (globalThis.window && key in globalThis.window ? globalThis.window[key] : globalThis[key]) },
  );
  const require = id => {
    if (id === 'react') return { Component, createElement, useState, useEffect, useMemo, useRef };
    if (id === 'react-dom') return { createPortal: node => node };
    throw new Error(`unexpected require: ${id}`);
  };
  new Function('window', 'require', 'console', source)(window, require, { log: (...a) => console.log(...a), error: (...a) => console.error(...a) });
  assert.ok(loaded, 'bundle must call window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-session-metrics');
  return loaded.factory(require);
}

/** Apply the plugin and return the dock component it registered. */
function dockCell(plugin) {
  const cells = [];
  const styles = [];
  const ctx = {
    effect: callback => { styles.push(callback()); return () => {}; },
    slots: {
      inject: (key, callback) => {
        assert.equal(key, 'conversation.composer.dock');
        callback();
        return () => {};
      },
      register: (options, component) => { cells.push({ ...options, component }); return () => {}; },
    },
  };
  assert.deepEqual(plugin.inject, ['slots']);
  plugin.apply(ctx);
  assert.equal(cells.length, 1, 'exactly one dock cell is registered');
  assert.equal(cells[0].name, 'conversation.composer.dock');
  assert.equal(cells[0].id, 'stats', 'takes over the shipped stats cell');
  assert.ok(cells[0].priority < 0, 'shadows the shipped cell (lowest priority renders)');
  return cells[0].component;
}

const intervals = new Set();
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, delay, ...rest) => {
  const id = realSetInterval(callback, delay, ...rest);
  intervals.add(id);
  return id;
};
const realClearInterval = globalThis.clearInterval;
globalThis.clearInterval = id => { intervals.delete(id); realClearInterval(id); };
/** Drop the polling timer the component armed, so the test process can exit. */
function stopTimers() {
  for (const id of intervals) realClearInterval(id);
  intervals.clear();
}

function browser({ fetch, hidden = false } = {}) {
  const listeners = new Map();
  const styles = [];
  const add = (type, listener) => listeners.set(`${type}:${listeners.size}`, listener);
  globalThis.fetch = fetch;
  globalThis.document = {
    hidden,
    addEventListener: add,
    removeEventListener() {},
    createElement: () => ({ dataset: {}, textContent: '', remove() { this.removed = true; } }),
    head: { appendChild: node => styles.push(node) },
    body: {},
  };
  globalThis.window = { addEventListener: add, removeEventListener() {} };
  return { listeners, styles };
}

const hostMetrics = {
  turns: 3,
  steps: 12,
  toolCalls: 9,
  toolMs: 5200,
  tools: [{ name: 'bash', calls: 4, ms: 5200, errors: 0 }],
  llmMs: 45000,
  ttftMs: 640,
  ttftCoveredSteps: 12,
  decodeMs: 31000,
  tokensPerSecond: 18.4,
  usage: { inputTokens: 1500, outputTokens: 4200, cacheReadTokens: 8500, cacheWriteTokens: 0, total: 14200, billedInput: 10000, cacheHitPercent: 85 },
  running: false,
  currentTurnElapsedMs: null,
  lastTurnMs: 21000,
  latencyMs: 61000,
  pendingToolCalls: 0,
};

const chatNodes = [
  { kind: 'assistant', turn: 1, time: 5000, timing: { stepStartTime: 2000, firstTokenTime: 2500, completedTime: 5000 }, usage: { outputTokens: 900 } },
  { kind: 'tool-result', time: 8000, callTime: 5100 },
  { kind: 'assistant', turn: 2, time: 20000, timing: { stepStartTime: 16000, firstTokenTime: 16500, completedTime: 20000 }, usage: { outputTokens: 700 } },
];

function okFetch(payload, calls = []) {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers });
    return { ok: true, status: 200, json: async () => payload };
  };
}

const projections = {
  sessionStats: { turns: 2, steps: 353, llmMs: 1208000, toolMs: 673000, ttftMs: 247100, ttftSteps: 353, decodeMs: 900000, decodeTokens: 152000 },
  tokenUsage: { uncachedInputTokens: 230000, cacheReadTokens: 81770000, cacheWriteTokens: 0, outputTokens: 163000 },
  contextPressure: { projectedTokens: 74000, contextWindow: 200000 },
  contextBreakdown: { systemTokens: 9000, toolsTokens: 15000, messageTokens: 50000 },
};
const useProjection = key => projections[key];

test('the row shows billed tokens, context, cache hit, model time, tool time, turns and steps from the shipped projections', async () => {
  const plugin = await loadClient();
  const calls = [];
  browser({ fetch: okFetch({ state: 'ready', metrics: hostMetrics }, calls) });
  const { tree } = await mount(dockCell(plugin), { sessionId: 'session-abc', useProjection });
  const strings = text(tree).filter(part => part !== '·').join(' | ');
  assert.equal(strings, 'Token 82M | 上下文 37% | 缓存 99.7% | 模型 20m08s | 工具 11m13s | 2 轮 | 353 步');
  assert.equal(calls.length, 0, 'the closed row never polls the Host when projections exist');
});

test('the hover panel reads in compact units and shares, without latency rows', async () => {
  const plugin = await loadClient();
  browser({ fetch: okFetch({ state: 'ready', metrics: hostMetrics }) });
  const harness = await mount(dockCell(plugin), { sessionId: 'session-abc', useProjection });
  const root = Array.isArray(harness.tree) ? harness.tree[0] : harness.tree;
  const findAnchor = node => !node || typeof node !== 'object' ? null : node.props && node.props.className === 'dsm-anchor' ? node : (node.children || []).map(findAnchor).find(Boolean) ?? null;
  findAnchor(root).props.onMouseEnter();
  const strings = text(await harness.tick(8)).join(' | ');
  for (const gone of ['首字均值', '解码速度', '上一轮耗时']) assert.ok(!strings.includes(gone), `still shows ${gone}`);
  assert.ok(strings.includes('37% · 74.0k / 200k'), `context missing: ${strings}`);
  assert.ok(strings.includes('20% · 15.0k'), `context share missing: ${strings}`);
  assert.ok(strings.includes('82M'), `token total missing: ${strings}`);
  assert.ok(strings.includes('99.5% · 82M'), `cache-read share missing: ${strings}`);
  assert.ok(!/\d{1,3},\d{3}/.test(strings), `exact digit grouping leaked: ${strings}`);
});

test('the row stays one band carrying the shipped stats hooks', async () => {
  const plugin = await loadClient();
  browser({ fetch: okFetch({ state: 'ready', metrics: hostMetrics }) });
  const { tree } = await mount(dockCell(plugin), { sessionId: 'session-abc', useProjection });
  const root = Array.isArray(tree) ? tree[0] : tree;
  assert.equal(root.props.className, 'dsm-root');
  assert.equal(root.props['data-composer-stats'], true);
});

test('without projections the row falls back to the Host reading', async () => {
  const plugin = await loadClient();
  const calls = [];
  browser({ fetch: okFetch({ state: 'ready', sessionId: 'session-abc', inferred: false, metrics: hostMetrics }, calls) });
  const { tree } = await mount(dockCell(plugin), { sessionId: 'session-abc' });
  const strings = text(tree).filter(part => part !== '·').join(' | ');
  assert.equal(strings, 'Token 14.2k | 缓存 85% | 模型 45.0s | 工具 5.2s | 3 轮 | 12 步');
  assert.equal(calls[0].headers['X-DSH-Session-Metrics'], '1');
  assert.match(calls[0].url, /sessionId=session-abc/);
});

test('an empty Session renders nothing', async () => {
  const plugin = await loadClient();
  browser({ fetch: okFetch({ state: 'ready', metrics: hostMetrics }) });
  const empty = key => key === 'sessionStats' ? { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 } : undefined;
  const { tree } = await mount(dockCell(plugin), { sessionId: 'session-abc', useProjection: empty });
  assert.equal(tree, null);
});

test('a Host that never answers leaves the cell empty and does not throw', async () => {
  const plugin = await loadClient();
  browser({ fetch: async () => { throw new Error('host unavailable'); } });
  const { tree } = await mount(dockCell(plugin), { sessionId: 'session-abc' });
  assert.equal(tree, null);
});

test('a hidden page skips polling rather than reading in the background', async () => {
  const plugin = await loadClient();
  const calls = [];
  browser({ fetch: okFetch({ state: 'ready', metrics: hostMetrics }, calls), hidden: true });
  const { tree } = await mount(dockCell(plugin), { sessionId: 'session-abc' });
  assert.equal(calls.length, 0);
  assert.equal(tree, null);
});

after(() => { stopTimers(); globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; });
