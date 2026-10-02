import { createClient, loadAll, buildGraph, relationsOf, visibleGraph, AuthError, NetworkError } from './monica.js';
import { createView3d } from './view3d.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

let cy = null;
let baseUrl = '';
let hidden = new Set(); // hidden categories
let currentGraph = null;
let lastWarnings = [];
let mode = '2d';
const view3d = createView3d($('graph3d'), {
  onSelect: (id) => showDetails(currentGraph.nodes.find((n) => n.id === id), relationsOf(currentGraph, id)),
  onClear: () => { $('details').hidden = true; },
});
const filterOptions = () => ({ hiddenCategories: hidden, hideIsolated: $('hide-isolated').checked });

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const categoryColor = (c) => css(`--${c}`) || css('--other');

// ---------- status line ----------
function setStatus(content, { error = false, progress = null } = {}) {
  const el = $('status');
  el.replaceChildren();
  el.className = error ? 'error' : '';
  if (content == null) { el.hidden = true; return; }
  el.hidden = false;
  const text = document.createElement('div');
  text.textContent = content;
  el.append(text);
  if (progress) {
    const bar = document.createElement('progress');
    bar.max = progress.total;
    bar.value = progress.done;
    el.append(bar);
  }
  return el;
}

function showWarnings(warnings) {
  if (!warnings.length) return setStatus(null);
  const el = setStatus(`Graph loaded. ${warnings.length} contact(s) could not be fully loaded.`);
  const d = document.createElement('details');
  const s = document.createElement('summary');
  s.textContent = 'Show details';
  d.append(s);
  for (const w of warnings) {
    const p = document.createElement('div');
    p.textContent = w;
    d.append(p);
  }
  el.append(d);
}

function explain(err) {
  if (err instanceof AuthError) return 'Monica rejected the token. Check that it is a current personal access token, then connect again.';
  if (err instanceof NetworkError) return 'The request was blocked or could not reach Monica. Check the URL, and make sure your Monica server allows requests from this page (CORS).';
  return `Could not load the graph: ${err.message}`;
}

// ---------- graph ----------
function cyStyle() {
  return [
    { selector: 'node', style: {
      label: 'data(label)', 'font-family': 'Bricolage Grotesque, system-ui, sans-serif', 'font-size': 12,
      color: css('--ink'), 'text-valign': 'bottom', 'text-margin-y': 5,
      'background-color': css('--node'), 'border-width': 2, 'border-color': css('--ink-soft'),
      width: 22, height: 22, 'text-background-color': css('--paper'), 'text-background-opacity': 0.75,
      'text-background-padding': 2,
    } },
    { selector: 'node[?isMe]', style: {
      width: 46, height: 46, 'background-color': css('--me'), 'border-color': css('--ink'),
      'border-width': 3, 'font-size': 15, 'font-weight': 800,
      'underlay-color': css('--me'), 'underlay-opacity': 0.25, 'underlay-padding': 12, 'underlay-shape': 'ellipse',
    } },
    { selector: 'edge', style: {
      width: 2, 'line-color': 'data(color)', 'curve-style': 'bezier', opacity: 0.85,
    } },
    // Lines from "me" to everyone converge into a bundle; keep them faint so the rest stands out.
    { selector: 'edge.spoke', style: { width: 1, opacity: 0.3 } },
    { selector: '.dim', style: { opacity: 0.12 } },
    { selector: 'edge.shown-label', style: {
      width: 2, opacity: 0.95, label: 'data(label)', 'font-size': 11, color: css('--ink-soft'), 'text-rotation': 'autorotate',
      'text-background-color': css('--paper'), 'text-background-opacity': 0.9, 'text-background-padding': 2,
    } },
    { selector: '.gone', style: { display: 'none' } },
  ];
}

function renderGraph(graph) {
  currentGraph = graph;
  if (cy) cy.destroy();
  const degree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) {
    degree.set(e.source, degree.get(e.source) + 1);
    degree.set(e.target, degree.get(e.target) + 1);
  }
  const elements = [
    ...graph.nodes.map((n) => ({ data: { ...n, degree: degree.get(n.id) } })),
    ...graph.edges.map((e) => ({ data: { ...e, color: categoryColor(e.category) } })),
  ];
  cy = cytoscape({ container: $('graph'), elements, style: cyStyle(), minZoom: 0.2, maxZoom: 3 });

  // Force layout: connected people pull towards each other, so related people end up close.
  // "Me" is not pinned: being linked to everyone, it settles in the middle with each group pulled
  // out in its own direction. Pinning it made every group drift to one side. People with no
  // relationships are tiled off to the side.
  const me = cy.nodes('[?isMe]').first();
  cy.layout({
    name: window.cytoscapeFcose ? 'fcose' : 'cose',
    quality: 'proof', randomize: false, animate: false, fit: false,
    nodeDimensionsIncludeLabels: true, idealEdgeLength: 110, nodeRepulsion: 9000,
  }).run();
  if (me.nonempty()) { me.connectedEdges().addClass('spoke'); centerOn(me); } else fitConnected();

  cy.on('tap', 'node', (evt) => selectNode(evt.target));
  cy.on('tap', (evt) => { if (evt.target === cy) clearSelection(); });
  cy.on('mouseover', 'node', (evt) => {
    const n = evt.target;
    const t = $('tooltip');
    t.textContent = `${n.data('label')} · ${n.data('degree')} relationship${n.data('degree') === 1 ? '' : 's'}`;
    t.hidden = false;
  });
  cy.on('mousemove', 'node', (evt) => {
    const t = $('tooltip');
    t.style.left = `${evt.originalEvent.clientX + 14}px`;
    t.style.top = `${evt.originalEvent.clientY + 14}px`;
  });
  cy.on('mouseout', 'node', () => { $('tooltip').hidden = true; });

  renderLegend(graph.categories);
  applyFilters();
  if (mode === '3d') showView3d();
}

// Zoom so everyone with relationships fits while `centre` stays exactly in the middle of the view.
function centerOn(centre) {
  const bb = cy.nodes().filter((n) => n.data('isMe') || n.data('degree') > 0).boundingBox();
  const p = centre.position();
  const halfW = Math.max(p.x - bb.x1, bb.x2 - p.x) + 60;
  const halfH = Math.max(p.y - bb.y1, bb.y2 - p.y) + 110; // room for the top bar and legend
  cy.zoom(Math.min(cy.width() / (2 * halfW), cy.height() / (2 * halfH), 1.5));
  cy.center(centre);
}

// Fit the view to everyone who has relationships. People with none are tiled far out and are left
// off-screen (pan to reach them) rather than shrinking everything else.
function fitConnected() {
  const connected = cy.nodes().filter((n) => n.data('isMe') || n.data('degree') > 0);
  cy.fit(connected, 90);
  if (cy.zoom() > 1.5) { cy.zoom(1.5); cy.center(connected); }
}

function selectNode(node) {
  cy.elements().removeClass('dim shown-label');
  const keep = node.closedNeighborhood();
  cy.elements().not(keep).addClass('dim');
  node.connectedEdges().addClass('shown-label');
  showDetails(node.data(), relationsOf(currentGraph, node.id()));
}

// The panel shared by the 2D and 3D views.
function showDetails(person, relations) {
  const d = $('details');
  d.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = person.label;
  const ul = document.createElement('ul');
  for (const r of relations) {
    const li = document.createElement('li');
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = r.kind;
    const who = document.createElement('span');
    who.textContent = r.who;
    li.append(kind, who);
    ul.append(li);
  }
  if (!ul.children.length) {
    const li = document.createElement('li');
    li.textContent = 'No relationships recorded.';
    ul.append(li);
  }
  const link = document.createElement('a');
  link.href = `${baseUrl}/people/${encodeURIComponent(person.hashId)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open in Monica';
  d.append(h, ul, link);
  d.hidden = false;
}

function clearSelection() {
  cy?.elements().removeClass('dim shown-label');
  view3d.clear();
  $('details').hidden = true;
}

function applyFilters() {
  view3d.applyFilters(filterOptions());
  if (!cy) return;
  const visible = visibleGraph(currentGraph, filterOptions());
  const shownNodes = new Set(visible.nodes.map((n) => n.id));
  const shownEdges = new Set(visible.edges.map((e) => e.id));
  cy.batch(() => {
    cy.edges().forEach((e) => e.toggleClass('gone', !shownEdges.has(e.id())));
    cy.nodes().forEach((n) => n.toggleClass('gone', !shownNodes.has(n.id())));
  });
}

// ---------- 2D / 3D ----------
async function setMode(next) {
  if (next === mode) return;
  mode = next;
  clearSelection(); // a selection belongs to the view it was made in
  $('search').value = '';
  $('mode-2d').setAttribute('aria-pressed', String(mode === '2d'));
  $('mode-3d').setAttribute('aria-pressed', String(mode === '3d'));
  $('tooltip').hidden = true;
  $('graph').hidden = mode === '3d';
  if (mode === '3d') {
    await showView3d();
  } else {
    view3d.hide();
    cy?.resize();
  }
}

async function showView3d() {
  if (!currentGraph) return;
  $('graph').hidden = true;
  try {
    setStatus('Loading the 3D view…');
    await view3d.show(currentGraph);
    view3d.applyFilters(filterOptions());
    showWarnings(lastWarnings);
  } catch (err) {
    setStatus(`${err.message} Staying in 2D.`, { error: true });
    mode = '2d';
    $('mode-2d').setAttribute('aria-pressed', 'true');
    $('mode-3d').setAttribute('aria-pressed', 'false');
    $('graph').hidden = false;
    cy?.resize();
  }
}
$('mode-2d').addEventListener('click', () => setMode('2d'));
$('mode-3d').addEventListener('click', () => setMode('3d'));

function renderLegend(categories) {
  const box = $('legend');
  box.replaceChildren();
  for (const c of categories) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hidden.has(c);
    cb.addEventListener('change', () => { cb.checked ? hidden.delete(c) : hidden.add(c); applyFilters(); });
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = categoryColor(c);
    const name = document.createElement('span');
    name.textContent = c;
    label.append(cb, sw, name);
    box.append(label);
  }
}

// ---------- search ----------
$('search').addEventListener('input', (e) => {
  if (!cy) return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) return clearSelection();
  if (mode === '3d') { view3d.find(q); return; }
  const match = cy.nodes().filter((n) => !n.hasClass('gone') && n.data('label').toLowerCase().includes(q)).first();
  if (match.empty()) return;
  selectNode(match);
  cy.animate({ center: { eles: match }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 250 });
});
$('hide-isolated').addEventListener('change', applyFilters);

// ---------- connect flow ----------
function openConnect() {
  $('base-url').value = store.get('monica.baseUrl');
  $('token').value = store.get('monica.token');
  $('remember').checked = Boolean(store.get('monica.token'));
  $('connect').showModal();
}
$('reconnect').addEventListener('click', openConnect);

$('connect-form').addEventListener('submit', async () => {
  const url = $('base-url').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!/^https?:\/\//i.test(url)) return setStatus('The Monica URL must start with http:// or https://', { error: true });

  baseUrl = url;
  store.set('monica.baseUrl', url);
  if ($('remember').checked) store.set('monica.token', token); else store.del('monica.token');

  try {
    setStatus('Loading contacts…');
    const client = createClient({
      baseUrl: url, token,
      onRateLimit: (ms) => setStatus(`Monica is limiting requests. Resuming in ${Math.round(ms / 1000)} seconds…`),
    });
    const data = await loadAll(client, {
      onProgress: (done, total) => setStatus(`Loading relationships (${done} of ${total})`, { progress: { done, total } }),
    });
    lastWarnings = data.warnings;
    renderGraph(buildGraph(data.contacts, data.relationships, data.groups));
    showWarnings(lastWarnings);
  } catch (err) {
    setStatus(explain(err), { error: true });
    if (err instanceof AuthError) openConnect();
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  view3d.restyle();
  if (!cy) return;
  cy.style(cyStyle());
  cy.edges().forEach((e) => e.data('color', categoryColor(e.data('category'))));
});

// First run: ask for connection details.
openConnect();
