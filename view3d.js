import { visibleGraph, withAlpha } from './monica.js';

// Loaded on first use: ~1.4 MB, includes three.js. Pinned by version and by hash.
const LIB_URL = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/dist/3d-force-graph.min.js';
const LIB_HASH = 'sha384-i98VDQKdpyVrtyuFn0fjUWJBLBmxnqHqOANcvYe9HLJUgT2wPixa4ZkLd7Dh3VEk';

let loading = null;
function loadLibrary() {
  if (window.ForceGraph3D) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIB_URL;
    script.integrity = LIB_HASH;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => { loading = null; script.remove(); reject(new Error('Could not load the 3D library.')); };
    document.head.append(script);
  });
  return loading;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const endId = (end) => (typeof end === 'object' ? end.id : end);

export function createView3d(container, { onSelect, onClear }) {
  let fg = null;
  let graph = null; // the full graph
  let nodes = [];
  let links = [];
  let degree = new Map();
  let shown = { nodes: new Set(), edges: new Set() };
  let selected = null; // { ids: Set of node ids, edges: Set of edge ids }
  let meId = null;

  const categoryColor = (c) => css(`--${c}`) || css('--other');

  const nodeColor = (n) => {
    const base = n.isMe ? css('--me') : css('--ink-soft');
    return selected && !selected.ids.has(n.id) ? withAlpha(base, 0.15) : base;
  };
  const linkColor = (l) => {
    const color = categoryColor(l.category);
    if (selected) return withAlpha(color, selected.edges.has(l.id) ? 1 : 0.05);
    // Lines from "me" to everyone converge into a bundle; keep them faint.
    const spoke = endId(l.source) === meId || endId(l.target) === meId;
    return withAlpha(color, spoke ? 0.18 : 0.75);
  };
  const linkWidth = (l) => (selected?.edges.has(l.id) ? 1 : 0.5);

  function restyle() {
    if (!fg) return;
    // Fresh wrappers each time, so the library re-evaluates every accessor.
    fg.backgroundColor(css('--paper'))
      .nodeColor((n) => nodeColor(n))
      .linkColor((l) => linkColor(l))
      .linkWidth((l) => linkWidth(l));
  }

  function create() {
    fg = window.ForceGraph3D()(container)
      .backgroundColor(css('--paper'))
      .nodeId('id')
      .nodeLabel((n) => escapeHtml(`${n.label} · ${degree.get(n.id) ?? 0} relationship${degree.get(n.id) === 1 ? '' : 's'}`))
      .nodeVal((n) => (n.isMe ? 10 : 2))
      .nodeRelSize(4)
      .nodeResolution(14)
      .nodeOpacity(1)
      .nodeColor(nodeColor)
      .nodeVisibility((n) => shown.nodes.has(n.id))
      .linkVisibility((l) => shown.edges.has(l.id))
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkOpacity(1) // the alpha lives in each link's colour
      .warmupTicks(120) // settle the layout before the first frame, so framing can happen early
      .cooldownTime(1500)
      .onNodeClick((n) => select(n.id))
      .onBackgroundClick(() => { clear(); onClear(); })
      .onEngineStop(frame);
    labels = document.createElement('div');
    labels.className = 'labels3d';
    container.append(labels);
    resize();
  }

  // Names are HTML labels laid over the canvas. The bundled three.js is not exposed to us, so text
  // sprites are not an option; instead each frame projects every person to the screen.
  let labels = null;
  let labelEls = new Map();
  let frameId = 0;

  const measure = document.createElement('canvas').getContext('2d');
  let labelWidth = new Map();

  function makeLabels() {
    labels.replaceChildren();
    labelEls = new Map();
    labelWidth = new Map();
    for (const n of nodes) {
      const el = document.createElement('div');
      el.className = n.isMe ? 'label3d me' : 'label3d';
      el.textContent = n.label;
      labels.append(el);
      labelEls.set(n.id, el);
      // Same font as the CSS, measured once so that overlap checks do not force a layout every frame.
      measure.font = `${n.isMe ? '800 15px' : '600 12px'} "Bricolage Grotesque", system-ui, sans-serif`;
      labelWidth.set(n.id, measure.measureText(n.label).width + 6);
    }
  }

  function updateLabels() {
    if (!fg || !labelEls.size) return;
    const camera = fg.camera();
    const here = camera.position;
    const forward = here.clone(); // a Vector3 to receive the viewing direction
    camera.getWorldDirection(forward);
    const focusDistance = Math.max(1, here.distanceTo(fg.controls().target));

    const items = [];
    for (const n of nodes) {
      const el = labelEls.get(n.id);
      if (!shown.nodes.has(n.id) || n.x === undefined) { el.style.display = 'none'; continue; }
      const depth = (n.x - here.x) * forward.x + (n.y - here.y) * forward.y + (n.z - here.z) * forward.z;
      if (depth <= 1) { el.style.display = 'none'; continue; } // behind the camera
      items.push({ n, el, depth, p: fg.graph2ScreenCoords(n.x, n.y, n.z) });
    }

    // Place names in priority order ("me", then the selection, then nearest first) and hide any name
    // that would land on top of one already placed; zooming in or rotating separates them.
    const priority = (it) => (it.n.isMe ? -Infinity : it.depth - (selected?.ids.has(it.n.id) ? 1e6 : 0));
    items.sort((a, b) => priority(a) - priority(b));
    const placed = [];
    for (const { n, el, depth, p } of items) {
      const half = labelWidth.get(n.id) / 2;
      const rect = { x1: p.x - half, x2: p.x + half, y1: p.y + 12, y2: p.y + (n.isMe ? 34 : 30) };
      const clear = placed.every((q) => rect.x2 <= q.x1 || rect.x1 >= q.x2 || rect.y2 <= q.y1 || rect.y1 >= q.y2);
      if (clear) placed.push(rect);
      el.style.display = '';
      el.style.visibility = clear ? 'visible' : 'hidden';
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, 12px)`;
      // Nearer people read stronger and distant ones fade; a selection dims everyone outside it.
      const nearness = Math.min(1, Math.max(0.3, 1.4 - (0.7 * depth) / focusDistance));
      el.style.opacity = selected ? (selected.ids.has(n.id) ? 1 : 0.1) : nearness;
    }
  }

  function startLabels() {
    cancelAnimationFrame(frameId);
    const loop = () => { updateLabels(); frameId = requestAnimationFrame(loop); };
    loop();
  }

  // Put "me" in the middle of the view and back the camera off until everyone with relationships fits.
  let framed = true;
  function frame() {
    if (framed || !fg) return;
    framed = true;
    const me = nodes.find((n) => n.id === meId);
    if (!me) { fg.zoomToFit(600, 80); return; }
    // Size the view by people who connect to "me". Detached groups drift far away and would
    // shrink everyone else if they counted.
    const adjacent = new Map(nodes.map((n) => [n.id, []]));
    for (const l of links) {
      adjacent.get(endId(l.source)).push(endId(l.target));
      adjacent.get(endId(l.target)).push(endId(l.source));
    }
    const reach = new Set([meId]);
    for (const queue = [meId]; queue.length;) {
      for (const next of adjacent.get(queue.shift())) if (!reach.has(next)) { reach.add(next); queue.push(next); }
    }
    const radius = Math.max(40, ...nodes.filter((n) => reach.has(n.id))
      .map((n) => Math.hypot(n.x - me.x, n.y - me.y, n.z - me.z)));
    const look = { x: me.x, y: me.y, z: me.z };
    // The lens has a 50 degree field of view; 2.8 radii back leaves room for the top bar and panels.
    fg.cameraPosition({ x: me.x, y: me.y, z: me.z + radius * 2.8 }, look, 800);
  }

  function resize() {
    if (!fg) return;
    fg.width(window.innerWidth).height(window.innerHeight);
    // The controls cache the viewport size, which sets how far a drag rotates or pans; refresh it.
    fg.controls().handleResize?.();
  }
  window.addEventListener('resize', resize);

  function setSelection(id) {
    const ids = new Set([id]);
    const edges = new Set();
    for (const l of links) {
      if (endId(l.source) === id || endId(l.target) === id) {
        edges.add(l.id);
        ids.add(endId(l.source));
        ids.add(endId(l.target));
      }
    }
    selected = { ids, edges };
    restyle();
  }

  function select(id) {
    setSelection(id);
    onSelect(id);
  }

  function clear() {
    selected = null;
    restyle();
  }

  function render(newGraph) {
    graph = newGraph;
    selected = null;
    meId = graph.nodes.find((n) => n.isMe)?.id ?? null;
    degree = new Map(graph.nodes.map((n) => [n.id, 0]));
    for (const e of graph.edges) {
      degree.set(e.source, degree.get(e.source) + 1);
      degree.set(e.target, degree.get(e.target) + 1);
    }
    // The library mutates the objects it is given (positions, resolved link ends), so give it copies.
    nodes = graph.nodes.map((n) => ({ ...n }));
    links = graph.edges.map((e) => ({ ...e }));
    shown = { nodes: new Set(nodes.map((n) => n.id)), edges: new Set(links.map((l) => l.id)) };
    framed = false;
    makeLabels();
    fg.graphData({ nodes, links });
  }

  return {
    // Show the view, creating it (and loading the library) the first time. Rejects if the library
    // cannot be loaded.
    async show(currentGraph) {
      await loadLibrary();
      // Show the container before creating the view: the camera controls measure it once, when they
      // are created, and a hidden container measures 0 x 0 (rotate and pan then silently do nothing).
      container.hidden = false;
      if (!fg) create();
      resize();
      fg.resumeAnimation();
      if (currentGraph !== graph) render(currentGraph);
      startLabels();
    },
    hide() {
      container.hidden = true;
      cancelAnimationFrame(frameId);
      fg?.pauseAnimation();
    },
    applyFilters(options) {
      if (!graph || !fg) return;
      const v = visibleGraph(graph, options);
      shown = { nodes: new Set(v.nodes.map((n) => n.id)), edges: new Set(v.edges.map((e) => e.id)) };
      fg.nodeVisibility((n) => shown.nodes.has(n.id)).linkVisibility((l) => shown.edges.has(l.id));
    },
    // Select the first visible person whose name contains the text, and fly the camera to them.
    find(query) {
      const q = query.trim().toLowerCase();
      return this.focus(nodes.find((n) => shown.nodes.has(n.id) && n.label.toLowerCase().includes(q))?.id);
    },
    // Select the visible person with this id and fly the camera to them.
    focus(id) {
      const match = nodes.find((n) => n.id === id && shown.nodes.has(n.id));
      if (!match) return false;
      select(match.id);
      // Approach along the line from "me" through the person, stopping a little beyond them, so "me"
      // is never between the camera and the person.
      const from = nodes.find((n) => n.id === meId) ?? { x: 0, y: 0, z: 0 };
      const dx = match.x - from.x;
      const dy = match.y - from.y;
      const dz = match.z - from.z;
      const len = Math.max(1, Math.hypot(dx, dy, dz));
      const stand = 1 + 140 / len;
      fg.cameraPosition({ x: from.x + dx * stand, y: from.y + dy * stand, z: from.z + dz * stand }, match, 800);
      return true;
    },
    clear,
    restyle,
  };
}
