/**
 * Pure session-metrics fold shared by the Host route and the local test suite.
 *
 * Every number comes from the durable Session log: an event carries its own
 * commit `time`, so step, model and tool durations are real timestamps rather
 * than an observer's wall clock. The fold is incremental — a tracker consumes
 * each appended event once, keyed by `seq` — and it is also replayable over a
 * whole `session.snapshotEvents()` for Sessions created before the plugin
 * loaded.
 */

const EMPTY_HISTOGRAM = { calls: 0, ms: 0, errors: 0 };

/** Fresh empty accumulator. Exported for tests and for replayed snapshots. */
export function emptyAccumulator() {
  return {
    turns: 0,
    steps: 0,
    openTurn: null,
    openStep: null,
    lastSeq: -1,
    toolCalls: 0,
    tools: {},
    pending: {},
    llmMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    firstTurnStartAt: null,
    lastTurnEndAt: null,
    running: false,
    currentTurn: null,
    currentTurnStartedAt: null,
    lastTurnMs: null,
  };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** First/last content-chunk times of one assistant message. */
export function streamTimes(stream) {
  let first = null;
  let last = null;
  if (!Array.isArray(stream)) return { first: null, last: null };
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue;
    if (record.type === 'chunk') {
      const time = finite(record.time);
      if (time === null) continue;
      if (first === null) first = time;
      last = time;
      continue;
    }
    const time0 = finite(record.time0);
    const deltas = Array.isArray(record.dt) ? record.dt : [];
    if (time0 === null || deltas.length === 0) continue;
    let running = time0;
    for (const delta of deltas) {
      const step = finite(delta);
      if (step !== null) running += step;
    }
    if (first === null) first = time0;
    const end = deltas.length > 0 ? running : time0;
    if (last === null || end > last) last = end;
  }
  return { first, last };
}

function noteTool(accumulator, callId, name, time) {
  accumulator.toolCalls += 1;
  if (typeof name === 'string' && name.length > 0 && name.length <= 64) {
    accumulator.pending[callId] = { name, startedAt: time };
  } else {
    accumulator.pending[callId] = { name: 'unknown', startedAt: time };
  }
}

function closeTool(accumulator, callId, time, isError) {
  const pending = accumulator.pending[callId];
  const name = pending ? pending.name : 'unknown';
  const ms = pending && time >= pending.startedAt ? time - pending.startedAt : 0;
  delete accumulator.pending[callId];
  const entry = accumulator.tools[name] ?? (accumulator.tools[name] = { ...EMPTY_HISTOGRAM });
  entry.calls += 1;
  entry.ms += ms;
  if (isError) entry.errors += 1;
}

function addUsage(accumulator, usage) {
  if (!usage || typeof usage !== 'object') return;
  const totals = accumulator.usage;
  totals.inputTokens += finite(usage.inputTokens) ?? 0;
  totals.outputTokens += finite(usage.outputTokens) ?? 0;
  totals.cacheReadTokens += finite(usage.cacheReadTokens) ?? 0;
  totals.cacheWriteTokens += finite(usage.cacheWriteTokens) ?? 0;
  totals.reasoningTokens += finite(usage.reasoningTokens) ?? 0;
}

/** Fold one durable Session event into the accumulator. */
export function foldEvent(accumulator, event) {
  if (!event || typeof event !== 'object') return accumulator;
  const seq = finite(event.seq);
  if (seq !== null) {
    if (seq <= accumulator.lastSeq) return accumulator;
    accumulator.lastSeq = seq;
  }
  const time = finite(event.time) ?? 0;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  switch (event.type) {
    case 'turn/start': {
      accumulator.turns += 1;
      accumulator.running = true;
      accumulator.currentTurn = finite(data.turn);
      accumulator.currentTurnStartedAt = time;
      accumulator.openStep = null;
      if (accumulator.firstTurnStartAt === null) accumulator.firstTurnStartAt = time;
      break;
    }
    case 'turn/end': {
      accumulator.running = false;
      if (accumulator.currentTurnStartedAt !== null) accumulator.lastTurnMs = Math.max(0, time - accumulator.currentTurnStartedAt);
      accumulator.lastTurnEndAt = time;
      accumulator.currentTurn = null;
      accumulator.currentTurnStartedAt = null;
      accumulator.openStep = null;
      // An unterminated tool call can only belong to the turn that just closed.
      for (const [callId] of Object.entries(accumulator.pending)) closeTool(accumulator, callId, time, true);
      break;
    }
    case 'step/start': {
      accumulator.steps += 1;
      accumulator.openStep = { turn: data.turn, step: data.step, startedAt: time };
      break;
    }
    case 'step/end': {
      // Model wall time is charged once, at the step's assistant message: a
      // step/end carries tool execution too and must not be added on top.
      accumulator.openStep = null;
      break;
    }
    case 'assistant/message': {
      const open = accumulator.openStep;
      const { first, last } = streamTimes(data.stream);
      const completed = time;
      if (open && open.startedAt !== null) {
        accumulator.llmMs += Math.max(0, completed - open.startedAt);
        if (first !== null) {
          accumulator.ttftMs += Math.max(0, first - open.startedAt);
          accumulator.ttftSteps += 1;
        }
      }
      if (first !== null && last !== null && last >= first) {
        accumulator.decodeMs += last - first;
        const tokens = data.usage && finite(data.usage.outputTokens);
        if (tokens !== null) accumulator.decodeTokens += tokens;
      }
      addUsage(accumulator, data.usage);
      accumulator.openStep = null;
      break;
    }
    case 'tool/call': {
      noteTool(accumulator, data.callId, data.name, time);
      break;
    }
    case 'tool/result': {
      closeTool(accumulator, data.message?.toolCallId ?? data.callId, time, data.message?.isError === true || data.error !== undefined);
      break;
    }
    default:
      break;
  }
  return accumulator;
}

/**
 * Display-ready numbers derived from an accumulator over one Session log.
 * Wall-clock fields (`elapsedMs`, `running`) are the Host's own reading; the
 * rest are log deltas.
 */
export function snapshot(accumulator, now = Date.now()) {
  const tools = Object.entries(accumulator.tools)
    .map(([name, value]) => ({ name, calls: value.calls, ms: value.ms, errors: value.errors }))
    .sort((a, b) => (b.ms - a.ms) || (b.calls - a.calls) || a.name.localeCompare(b.name))
    .slice(0, 8);
  const toolMs = Object.values(accumulator.tools).reduce((total, entry) => total + entry.ms, 0);
  const billedInput = accumulator.usage.inputTokens + accumulator.usage.cacheReadTokens + accumulator.usage.cacheWriteTokens;
  const total = billedInput + accumulator.usage.outputTokens;
  const cacheHitPercent = billedInput > 0 ? Math.min(100, Math.round((accumulator.usage.cacheReadTokens / billedInput) * 100)) : null;
  const latencyMs = accumulator.firstTurnStartAt !== null && accumulator.lastTurnEndAt !== null
    ? Math.max(0, accumulator.lastTurnEndAt - accumulator.firstTurnStartAt)
    : 0;
  return {
    turns: accumulator.turns,
    steps: accumulator.steps,
    toolCalls: accumulator.toolCalls,
    toolMs: Math.round(toolMs),
    tools,
    llmMs: Math.round(accumulator.llmMs),
    ttftMs: accumulator.ttftSteps > 0 ? Math.round(accumulator.ttftMs / accumulator.ttftSteps) : null,
    ttftCoveredSteps: accumulator.ttftSteps,
    decodeMs: Math.round(accumulator.decodeMs),
    tokensPerSecond: accumulator.decodeMs > 0 && accumulator.decodeTokens > 0 ? accumulator.decodeTokens / (accumulator.decodeMs / 1000) : null,
    usage: { ...accumulator.usage, total, billedInput, cacheHitPercent },
    running: accumulator.running,
    currentTurn: accumulator.currentTurn,
    currentTurnElapsedMs: accumulator.running && accumulator.currentTurnStartedAt !== null ? Math.max(0, now - accumulator.currentTurnStartedAt) : null,
    lastTurnMs: accumulator.lastTurnMs,
    latencyMs,
    pendingToolCalls: Object.keys(accumulator.pending).length,
  };
}

/** Fold a whole replayed log in one shot. */
export function foldEvents(accumulator, events) {
  if (Array.isArray(events)) for (const event of events) foldEvent(accumulator, event);
  return accumulator;
}

/** Compact integer/decimal formatting for tokens and counts. */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) {
    const scaled = value / 1_000;
    const rounded = Math.round(scaled * 10) / 10;
    return `${Math.abs(rounded) >= 100 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return String(Math.round(value));
}

/** `45.2s` under a minute, `2m42s` from there on. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = ms / 1000;
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}

/** `12.3 tok/s`. */
export function formatRate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return `${(Math.round(value * 10) / 10).toFixed(1)} tok/s`;
}
