window.__ModuleLoader__.load({ id: 'dsh-session-metrics', factory: require => {
  const React = require('react'), h = React.createElement;
  const { createPortal } = require('react-dom');
  const ID = 'dsh-session-metrics';
  // Shadow the shipped `stats` cell: same id at a lower priority renders instead
  // of it (lowest wins), and disabling this plugin hands the cell back to DSH.
  const CELL = 'stats', PRIORITY = -1;
  const ROUTE = '/myspace-session-metrics/api';
  const POLL_MS = 2500;
  const HEADER = { 'X-DSH-Session-Metrics': '1' };
  const PANEL_GAP = 8, PANEL_MARGIN = 12, HOVER_CLOSE_MS = 160;

  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const formatCount = v => { const n = num(v); if (n === null) return '—'; const a = Math.abs(n); if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`; if (a >= 1e3) return `${(n / 1e3).toFixed(n / 1e3 >= 99.95 ? 0 : 1)}k`; return String(Math.round(n)); };
  const formatDuration = ms => { const n = num(ms); if (n === null || n < 0) return '—'; const s = n / 1e3; if (s < 60) return `${(Math.round(s * 10) / 10).toFixed(1)}s`; const w = Math.round(s); return `${Math.floor(w / 60)}m${String(w % 60).padStart(2, '0')}s`; };

  /** Cache-hit share that only reads 100 when nothing missed, like the shipped pill. */
  function cachePercent(read, billed) {
    if (!(billed > 0)) return null;
    if (read >= billed) return '100';
    for (let places = 0; places <= 3; places++) {
      const factor = 10 ** places;
      const value = Math.round((read / billed) * 100 * factor) / factor;
      if (value < 100) return value.toFixed(places);
    }
    return '99.999';
  }

  /**
   * One reading for the row. The shipped projections are authoritative and
   * live; the Host reading fills in only what they do not carry.
   */
  /** Context occupancy, read the same way as the shipped meter. */
  function context(pressure, breakdown) {
    const used = pressure ? num(pressure.projectedTokens) ?? num(pressure.pressureTokens) : null;
    const window = pressure ? num(pressure.contextWindow) : null;
    if (used === null || !(window > 0)) return null;
    const parts = breakdown ? [['系统提示词', num(breakdown.systemTokens)], ['工具定义', num(breakdown.toolsTokens)], ['对话消息', num(breakdown.messageTokens)]].filter(([, v]) => v !== null) : [];
    return { used, window, percent: Math.min(100, Math.round((used / window) * 100)), parts };
  }

  function combine(stats, usage, host) {
    const h0 = host ?? {};
    const hu = h0.usage ?? null;
    const u = usage ? {
      input: num(usage.uncachedInputTokens) ?? 0,
      read: num(usage.cacheReadTokens) ?? 0,
      write: num(usage.cacheWriteTokens) ?? 0,
      output: num(usage.outputTokens) ?? 0,
    } : hu ? { input: hu.inputTokens ?? 0, read: hu.cacheReadTokens ?? 0, write: hu.cacheWriteTokens ?? 0, output: hu.outputTokens ?? 0 } : null;
    const billed = u ? u.input + u.read + u.write : 0;
    const pick = (key, hostKey = key) => stats && num(stats[key]) !== null ? stats[key] : num(h0[hostKey]);
    return {
      turns: pick('turns'),
      steps: pick('steps'),
      llmMs: pick('llmMs'),
      toolMs: pick('toolMs'),
      usage: u && (billed > 0 || u.output > 0) ? { ...u, billed, total: billed + u.output, cache: cachePercent(u.read, billed) } : null,
      toolCalls: num(h0.toolCalls),
      tools: Array.isArray(h0.tools) ? h0.tools : [],
      latencyMs: num(h0.latencyMs) > 0 ? h0.latencyMs : null,
      running: Boolean(h0.running),
      currentTurnElapsedMs: num(h0.currentTurnElapsedMs),
    };
  }

  const GaugeIcon = () => h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('path', { d: 'M2.5 11.5a5.5 5.5 0 1 1 11 0' }), h('path', { d: 'M8 11.5 10.6 7' }));

  /** The seven always-visible figures, in the owner's reading order. */
  function rowParts(m) {
    const parts = [];
    if (m.usage) parts.push(`Token ${formatCount(m.usage.total)}`);
    if (m.context) parts.push(`上下文 ${m.context.percent}%`);
    if (m.usage && m.usage.cache !== null) parts.push(`缓存 ${m.usage.cache}%`);
    if (m.llmMs !== null && m.llmMs > 0) parts.push(`模型 ${formatDuration(m.llmMs)}`);
    if (m.toolMs !== null && m.toolMs > 0) parts.push(`工具 ${formatDuration(m.toolMs)}`);
    if (m.turns !== null) parts.push(`${m.turns} 轮`);
    if (m.steps !== null) parts.push(`${formatCount(m.steps)} 步`);
    return parts;
  }

  /** Share of the group total; one decimal below 10% so small parts never read 0%. */
  const formatShare = (part, total) => {
    if (!(total > 0)) return '—';
    const value = (part / total) * 100;
    if (value === 0) return '0%';
    if (part >= total) return '100%';
    if (value < 10) return `${(Math.round(value * 10) / 10).toFixed(1)}%`;
    // Never round a partial share up to 100%, like the cache-hit figure.
    return `${cachePercent(part, total)}%`;
  };
  const shares = (rows, base) => {
    const total = base ?? rows.reduce((sum, [, value]) => sum + (num(value) ?? 0), 0);
    return rows.map(([label, value]) => [label, value, formatShare(num(value) ?? 0, total)]);
  };

  function Details({ m, elapsed }) {
    const dl = (key, rows) => h('dl', { key, className: 'dsm-details' }, rows.filter(Boolean).flatMap(([label, value]) => [h('dt', { key: `t-${label}` }, label), h('dd', { key: `d-${label}` }, value)]));
    const failed = m.tools.reduce((total, tool) => total + (num(tool.errors) ?? 0), 0);
    const out = [
      h('div', { key: 'title', className: 'dsm-title' },
        h('span', { className: 'dsm-title-label' }, h(GaugeIcon), '会话指标'),
        m.running && elapsed !== null ? h('span', { className: 'dsm-title-value dsm-live' }, h('i', { className: 'dsm-dot', 'aria-hidden': true }), `本轮 ${formatDuration(elapsed)}`) : null),
      h('div', { key: 'rule', className: 'dsm-rule', 'aria-hidden': true }),
      dl('time', [
        m.toolCalls !== null ? ['工具调用', `${m.toolCalls} 次${failed ? ` · ${failed} 失败` : ''}`] : null,
        m.latencyMs !== null ? ['会话跨度', formatDuration(m.latencyMs)] : null,
      ]),
    ];
    if (m.context) {
      out.push(h('div', { key: 'rule-c', className: 'dsm-rule dsm-rule-gap', 'aria-hidden': true }));
      out.push(dl('context', [
        ['上下文', `${m.context.percent}% · ${formatCount(m.context.used)} / ${formatCount(m.context.window)}`],
        ...shares(m.context.parts, m.context.used).map(([label, value, share]) => [label, `${share} · ${formatCount(value)}`]),
      ]));
    }
    if (m.usage) {
      out.push(h('div', { key: 'rule-u', className: 'dsm-rule dsm-rule-gap', 'aria-hidden': true }));
      out.push(dl('usage', [
        ['Token 总计', formatCount(m.usage.total)],
        ...shares([['未缓存输入', m.usage.input], ['缓存读取', m.usage.read], m.usage.write ? ['缓存写入', m.usage.write] : null, ['输出', m.usage.output]].filter(Boolean))
          .map(([label, value, share]) => [label, `${share} · ${formatCount(value)}`]),
      ]));
    }
    if (m.tools.length) {
      out.push(h('div', { key: 'rule-t', className: 'dsm-rule dsm-rule-gap', 'aria-hidden': true }));
      out.push(h('dl', { key: 'tools', className: 'dsm-details' }, m.tools.flatMap(tool => [
        h('dt', { key: `t-${tool.name}`, className: 'dsm-tool-name' }, tool.name),
        h('dd', { key: `d-${tool.name}` }, `${tool.calls} 次 · ${formatDuration(tool.ms)}${tool.errors ? ` · ${tool.errors} 失败` : ''}`),
      ])));
    }
    return out;
  }

  /** Anything the live renderer throws becomes visible instead of a silent unmount. */
  class Guard extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    render() {
      if (this.state.error) return h('span', { className: 'dsm-error' }, `会话指标渲染失败：${String(this.state.error && this.state.error.message || this.state.error)}`);
      return this.props.children;
    }
  }

  /** Host reading, polled only while `active`. */
  function useHost(sessionId, active) {
    const [reading, setReading] = React.useState(null);
    React.useEffect(() => {
      if (!active) return undefined;
      const query = typeof sessionId === 'string' && sessionId.length > 0 ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      let stopped = false, pending = false;
      const controller = new AbortController();
      const load = async () => {
        if (pending || document.hidden) return;
        pending = true;
        try {
          const res = await fetch(`${ROUTE}${query}`, { headers: HEADER, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
          if (!res.ok) throw new Error(`http ${res.status}`);
          const body = await res.json();
          if (!stopped && body && body.metrics) setReading({ metrics: body.metrics, at: Date.now() });
        } catch { /* Keep the last reading. */ }
        finally { pending = false; }
      };
      void load();
      const timer = setInterval(load, POLL_MS);
      window.addEventListener('focus', load);
      document.addEventListener('visibilitychange', load);
      return () => { stopped = true; controller.abort(); clearInterval(timer); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', load); };
    }, [sessionId, active]);
    return reading;
  }

  /** Anchored above the pill, viewport-clamped, closed by Escape or an outside press. */
  function usePanel(open, setOpen, anchorRef, panelRef) {
    const [pos, setPos] = React.useState(null);
    React.useEffect(() => {
      if (!open) { setPos(null); return undefined; }
      const place = () => {
        const anchor = anchorRef.current, panel = panelRef.current;
        if (!anchor || !panel || typeof anchor.getBoundingClientRect !== 'function') return;
        const rect = anchor.getBoundingClientRect();
        const width = panel.offsetWidth, height = panel.offsetHeight;
        const left = Math.min(Math.max(PANEL_MARGIN, rect.left + rect.width / 2 - width / 2), Math.max(PANEL_MARGIN, window.innerWidth - PANEL_MARGIN - width));
        const top = Math.max(PANEL_MARGIN, rect.top - PANEL_GAP - height);
        setPos(prev => prev && prev.left === left && prev.top === top ? prev : { left, top });
      };
      const onKey = e => { if (e.key === 'Escape') setOpen(false); };
      const onPointer = e => {
        if (anchorRef.current && anchorRef.current.contains(e.target)) return;
        if (panelRef.current && panelRef.current.contains(e.target)) return;
        setOpen(false);
      };
      place();
      const observer = typeof ResizeObserver === 'function' && panelRef.current ? new ResizeObserver(place) : null;
      if (observer) observer.observe(panelRef.current);
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      document.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onPointer, true);
      return () => {
        if (observer) observer.disconnect();
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onPointer, true);
      };
    }, [open]);
    return pos;
  }

  const noProjection = () => undefined;

  function MetricsPill({ sessionId, useProjection }) {
    const project = typeof useProjection === 'function' ? useProjection : noProjection;
    const stats = project('sessionStats');
    const usage = project('tokenUsage');
    const [open, setOpen] = React.useState(false);
    const [, setTick] = React.useState(0);
    const anchorRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const closeTimer = React.useRef(null);
    // Without the shipped projections the row itself must come from the Host.
    const host = useHost(sessionId, open || stats === undefined);
    const pos = usePanel(open, setOpen, anchorRef, panelRef);
    const m = combine(stats, usage, host && host.metrics);
    m.context = context(project('contextPressure'), project('contextBreakdown'));
    const running = open && m.running;
    React.useEffect(() => {
      if (!running) return undefined;
      const timer = setInterval(() => setTick(v => v + 1), 500);
      return () => clearInterval(timer);
    }, [running]);
    React.useEffect(() => () => clearTimeout(closeTimer.current), []);

    const parts = rowParts(m);
    if (parts.length === 0 || !(m.steps > 0 || m.usage || m.context)) return null;
    const elapsed = m.running && m.currentTurnElapsedMs !== null && host ? m.currentTurnElapsedMs + Math.max(0, Date.now() - host.at) : null;
    const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
    // A spurious leave (a re-render, a theme overlay) must not close a panel the
    // pointer is still over, so the close re-checks real hover state.
    const hovered = el => Boolean(el && typeof el.matches === 'function' && el.matches(':hover'));
    const hide = () => {
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => { if (!hovered(anchorRef.current) && !hovered(panelRef.current)) setOpen(false); }, HOVER_CLOSE_MS);
    };
    const label = parts.join(' · ');
    // `dsm-root` + `data-composer-stats` match the shipped cell's hooks, so themes
    // that style the stats band (its top rule included) treat this cell the same.
    return h('div', { className: 'dsm-root', 'data-composer-stats': true }, h('span', { ref: anchorRef, className: 'dsm-anchor', onMouseEnter: show, onMouseLeave: hide },
      h('button', { type: 'button', className: 'dsm-pill', 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-label': label, onClick: () => setOpen(v => !v), onFocus: show },
        h(GaugeIcon),
        h('span', { className: 'dsm-label' }, parts.flatMap((part, index) => index === 0
          ? [h('span', { key: part }, part)]
          : [h('span', { key: `s${index}`, className: 'dsm-sep', 'aria-hidden': true }, '·'), h('span', { key: part }, part)]))),
      open ? createPortal(h('div', {
        ref: panelRef, className: 'dsm-panel', role: 'dialog', 'aria-label': '会话指标',
        onMouseEnter: show, onMouseLeave: hide,
        style: pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: 0, top: 0, visibility: 'hidden' },
      }, h(Details, { m, elapsed })), document.body) : null));
  }

  function Cell(props) {
    return h(Guard, null, h(MetricsPill, { sessionId: props.sessionId, useProjection: props.useProjection }));
  }

  // Pill and panel mirror the shipped dock pills and stat dialog token for token.
  const css = [
    '.dsm-root{box-sizing:border-box;min-width:0;max-width:100%;display:flex;justify-content:center;gap:12px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
    '.dsm-anchor{min-width:0;max-width:100%;display:inline-flex}',
    '.dsm-pill{box-sizing:border-box;min-width:0;max-width:100%;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}',
    '.dsm-pill svg{flex:none;width:14px;height:14px}',
    '.dsm-pill:hover,.dsm-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
    '.dsm-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.dsm-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '.dsm-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
    '.dsm-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:default}',
    '.dsm-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}',
    '.dsm-title-label,.dsm-title-value{display:inline-flex;align-items:center;gap:6px;min-width:0}',
    '.dsm-title-label svg{flex:none;width:14px;height:14px}',
    '.dsm-title-value{font-variant-numeric:tabular-nums}',
    '.dsm-live{color:var(--dsw-alias-brand-primary)}',
    '.dsm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:dsm-pulse 1.1s ease-in-out infinite}',
    '@keyframes dsm-pulse{0%,100%{opacity:1}50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.dsm-dot{animation:none}}',
    '.dsm-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
    '.dsm-rule-gap{margin-top:10px}',
    '.dsm-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}',
    '.dsm-details dt,.dsm-details dd{min-width:0;margin:0}',
    '.dsm-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
    '.dsm-tool-name{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // The shipped context meter sits beside the slot anchor in the same dock row;
    // its figure now lives inside this band, so only that sibling is hidden.
    ':has(> [data-slot="conversation.composer.dock"] .dsm-root) > :not([data-slot]){display:none}',
    '.dsm-error{color:var(--dsw-alias-state-error-primary);font-size:11px}',
  ].join('');

  function apply(ctx) {
    ctx.effect(() => {
      const style = document.createElement('style');
      style.dataset.plugin = ID;
      style.textContent = css;
      document.head.appendChild(style);
      return () => style.remove();
    });
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
      { name: 'conversation.composer.dock', id: CELL, priority: PRIORITY, order: 0, label: '会话指标' },
      Cell,
    ));
  }
  return { inject: ['slots'], apply };
} });
