/**
 * Minimal but faithful `react` seam for the Client bundle test: identity-stable
 * hook slots, real re-render-on-setState, and effect flushing, driven by the
 * render walker in `render.mjs`.
 *
 * The real thing runs in the browser; this seam exists so the shipped
 * `src/client.js` can be asserted on in Node.
 */

let current = null;

export class Component {
  constructor(props) { this.props = props ?? {}; this.state = this.state ?? {}; }
  setState(patch) { this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }; }
  render() { return null; }
}

export function createElement(type, props, ...children) {
  const flat = children.flat();
  const resolved = props ?? {};
  // React puts children on props; a consumer (the bundle's error boundary)
  // reads exactly that field, so the seam must too.
  if (flat.length > 0) resolved.children = flat;
  return { __el: true, type, props: resolved, children: flat.length > 0 ? flat : (resolved.children ?? []) };
}

export function beginRender(slots) { const previous = current; current = slots; return previous; }
export function bindRoot(slots, root) { slots.root = root; }
export function endRender(previous) { current = previous; }
export function markDirty(slots) { slots.dirty = true; }

function hooks() {
  if (current === null) throw new Error('hook called outside a render');
  return current;
}

export function useState(initial) {
  const self = hooks();
  const index = self.cursor++;
  if (self.states.length <= index) self.states[index] = typeof initial === 'function' ? initial() : initial;
  const set = value => {
    const next = typeof value === 'function' ? value(self.states[index]) : value;
    if (Object.is(next, self.states[index])) return;
    self.states[index] = next;
    self.dirty = true;
    if (self.root) self.root.dirty = true;
  };
  return [self.states[index], set];
}

export function useMemo(factory, deps) {
  const self = hooks();
  const index = self.cursor++;
  const previous = self.memos[index];
  if (previous && sameDeps(previous.deps, deps)) return previous.value;
  const value = factory();
  self.memos[index] = { deps, value };
  return value;
}

export function useRef(initial) {
  const self = hooks();
  const index = self.cursor++;
  if (self.memos.length <= index || self.memos[index] === undefined) self.memos[index] = { current: initial };
  return self.memos[index];
}

export function useEffect(callback, deps) {
  const self = hooks();
  const index = self.cursor++;
  const previous = self.effects[index];
  if (previous && previous.ran && sameDeps(previous.deps, deps)) return;
  if (previous && typeof previous.cleanup === 'function') previous.cleanup();
  self.effects[index] = { deps, callback, cleanup: undefined, ran: false };
}

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

/** Fresh slot bundle for one mounted instance, with identity-stable arrays. */
export function createSlots() {
  return { cursor: 0, states: [], memos: [], effects: [], dirty: false, registry: new Map(), root: null };
}
