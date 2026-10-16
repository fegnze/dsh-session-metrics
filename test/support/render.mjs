/**
 * Render walker for the Client bundle test.
 *
 * `mount()` grows a host tree by invoking every function component and class
 * component it meets, keeping each component's hooks in identity-stable slots
 * so `useState` re-renders the whole tree and `useEffect` runs once per
 * dependency change — the two behaviours the shipped `src/client.js` relies on.
 */
import { beginRender, bindRoot, createSlots, endRender } from './react-seam.mjs';

const isClass = type => typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function';
/** A render function: a plain component or a `forwardRef`-style wrapper. */
const isComponent = type => typeof type === 'function' || (type !== null && typeof type === 'object' && typeof type.render === 'function');
const invokeComponent = (type, props) => typeof type === 'function' ? type(props) : type.render(props, null);

function slotsFor(root, type) {
  if (!root.registry.has(type)) {
    const slots = { ...createSlots(), instance: null };
    bindRoot(slots, root);
    root.registry.set(type, slots);
  }
  return root.registry.get(type);
}

function walk(node, root) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(child => walk(child, root));
  if (!node.__el) return node;
  const { type, props, children } = node;
  if (isComponent(type)) {
    const slots = slotsFor(root, type);
    if (isClass(type)) {
      slots.instance = slots.instance ?? new type(props);
      slots.instance.props = props;
      slots.cursor = 0;
      const previous = beginRender(slots);
      let inner;
      try {
        inner = slots.instance.render();
      } catch (error) {
        if (typeof type.getDerivedStateFromError !== 'function') throw error;
        slots.instance.state = { ...slots.instance.state, ...type.getDerivedStateFromError(error) };
        inner = slots.instance.render();
      } finally {
        endRender(previous);
      }
      return walk(inner, root);
    }
    slots.cursor = 0;
    const previous = beginRender(slots);
    let inner;
    try {
      inner = invokeComponent(type, props);
    } finally {
      endRender(previous);
    }
    return walk(inner, root);
  }
  return { type, props, children: children.map(child => walk(child, root)) };
}

function runEffects(root) {
  let ran = false;
  for (const slots of root.registry.values()) {
    for (const effect of slots.effects) {
      if (!effect || effect.ran || typeof effect.callback !== 'function') continue;
      effect.ran = true;
      const cleanup = effect.callback();
      if (typeof cleanup === 'function') effect.cleanup = cleanup;
      ran = true;
    }
  }
  return ran;
}

/**
 * Mount an occupant and settle it.
 * @param type - a component function (the slot wrapper) or an element.
 * @param props - the slot's standard props.
 * @returns an object whose `tree` getter is the settled host tree.
 */
/** Collapse `[null]` and nested empties so "renders nothing" is a plain null. */
function normalize(tree) {
  if (Array.isArray(tree)) {
    const kept = tree.map(normalize).filter(child => child !== null && child !== undefined);
    return kept.length === 0 ? null : kept;
  }
  return tree;
}

export async function mount(type, props = {}) {
  const root = createSlots();
  const render = () => { root.tree = normalize(walk({ __el: true, type, props, children: [] }, root)); };
  const settle = async passes => {
    for (let pass = 0; pass < passes; pass++) {
      runEffects(root);
      // Give the component's own async work (its fetch) a real turn to land.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setImmediate(resolve));
      if (!root.dirty) continue;
      // A state setter fired: re-render, then flush the effects it queued.
      root.dirty = false;
      render();
      pass--;
    }
  };
  render();
  await settle(12);
  return {
    get tree() { return root.tree; },
    get registry() { return root.registry; },
    render,
    async tick(rounds = 4) {
      for (let pass = 0; pass < rounds; pass++) {
        runEffects(root);
        await new Promise(resolve => setImmediate(resolve));
        if (!root.dirty) break;
        root.dirty = false;
        render();
      }
      return root.tree;
    },
  };
}

/** Flat list of text nodes under one host tree. */
export function text(tree, out = []) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) { tree.forEach(child => text(child, out)); return out; }
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out; }
  if (tree.children !== undefined) text(tree.children, out);
  return out;
}
