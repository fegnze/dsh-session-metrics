/**
 * Host half: track live Session metrics and serve them to this plugin's Client.
 *
 * Reads only the durable Session log through `ctx.sessions`; it never inspects
 * prompts or model output beyond token counts, and it stores nothing on disk.
 */
import { createTracker, validSessionId } from './tracker.mjs';

export const inject = ['sessions', 'webServer'];

const ROUTE = '/myspace-session-metrics/api';
const HEADER = 'x-dsh-session-metrics';

/** Loopback, same-origin, custom-header-gated request check. */
export function trusted(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
      && (!req.headers.origin || new URL(req.headers.origin).host === host.host)
      && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin')
      && req.headers[HEADER] === '1';
  } catch {
    return false;
  }
}

export function sessionIdFrom(url) {
  try {
    const value = new URL(url, 'http://127.0.0.1').searchParams.get('sessionId');
    return validSessionId(value) ? value : null;
  } catch {
    return null;
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const tracker = createTracker(ctx.sessions);
    const onEvent = (session, event) => {
      if (!session || typeof session.id !== 'string') return;
      tracker.measure(session.id, event);
    };
    const offEvent = ctx.on('session/event', onEvent);
    const offDisposed = ctx.on('session/disposed', (session) => {
      if (session && typeof session.id === 'string') tracker.forget(session.id);
    });
    const offRoute = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!trusted(req)) {
          res.statusCode = 403;
          res.end('{"state":"forbidden"}');
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('{"state":"method"}');
          return;
        }
        const requested = sessionIdFrom(req.url);
        let sessionId = requested;
        let inferred = false;
        if (sessionId === null) {
          sessionId = tracker.latest();
          inferred = sessionId !== null;
        }
        if (sessionId === null) {
          res.statusCode = 400;
          res.end('{"state":"bad-session"}');
          return;
        }
        const live = ctx.sessions.get(sessionId);
        let metrics = tracker.read(sessionId);
        if (!metrics && !live) {
          res.statusCode = 404;
          res.end('{"state":"unknown-session"}');
          return;
        }
        if (!metrics) {
          tracker.ensure(sessionId);
          metrics = tracker.read(sessionId);
        }
        res.end(JSON.stringify({ state: 'ready', sessionId, inferred, updatedAt: Date.now(), metrics }));
      },
    });
    return () => {
      offRoute();
      offDisposed();
      offEvent();
      tracker.dispose();
    };
  });
}
