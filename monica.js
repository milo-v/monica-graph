// Data logic for the Monica relationship graph. No DOM; fetch is injectable.

export class AuthError extends Error {}
export class NetworkError extends Error {}

const RATE_LIMIT_BACKOFF_MS = [5000, 10000, 20000, 30000, 30000]; // one entry per retry, 95s in all
const PAGE_LIMITS = [100, 30, null]; // null: let the server pick its default
const CONCURRENCY = 5;

export function createClient({
  baseUrl, token, fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRateLimit = () => {},
}) {
  const root = baseUrl.replace(/\/+$/, '');
  let pause = null; // shared by all requests while the server is rate limiting us

  function waitOutRateLimit(res, attempt) {
    if (!pause) {
      // Retry-After is only readable cross-origin if the server exposes it; otherwise back off
      // long enough for a per-minute window to reset.
      const header = Number(res.headers?.get?.('Retry-After'));
      const ms = header > 0 ? header * 1000 : RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
      onRateLimit(ms);
      pause = sleep(ms).finally(() => { pause = null; });
    }
    return pause;
  }

  async function request(path) {
    for (let attempt = 0; ; attempt++) {
      while (pause) await pause;
      let res;
      try {
        res = await fetch(`${root}/api${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
      } catch (err) {
        throw new NetworkError(err.message);
      }
      if (res.status === 401 || res.status === 403) throw new AuthError(`Token rejected (${res.status})`);
      if (res.status === 429 && attempt < RATE_LIMIT_BACKOFF_MS.length) {
        await waitOutRateLimit(res, attempt);
        continue;
      }
      return res;
    }
  }

  async function get(path) {
    const res = await request(path);
    if (!res.ok) throw new Error(`Request to ${path} failed (${res.status})`);
    return res.json();
  }

  async function getAllPages(path) {
    const sep = path.includes('?') ? '&' : '?';
    const pageUrl = (limit, page) => `${path}${sep}${limit ? `limit=${limit}&` : ''}page=${page}`;
    for (const limit of PAGE_LIMITS) {
      const first = await request(pageUrl(limit, 1));
      if (first.status === 400 && limit !== PAGE_LIMITS.at(-1)) continue; // limit above server max
      if (!first.ok) throw new Error(`Request to ${path} failed (${first.status})`);
      const body = await first.json();
      const items = [...body.data];
      for (let page = 2; page <= (body.meta?.last_page ?? 1); page++) {
        const next = await get(pageUrl(limit, page));
        items.push(...next.data);
      }
      return items;
    }
  }

  return { get, getAllPages };
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function loadAll(client, { onProgress = () => {} } = {}) {
  const groups = await client.getAllPages('/relationshiptypegroups');
  const contacts = await client.getAllPages('/contacts');

  const warnings = [];
  let done = 0;
  const perContact = await mapLimit(contacts, CONCURRENCY, async (c) => {
    try {
      return (await client.get(`/contacts/${c.id}/relationships`)).data;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      warnings.push(`Could not load relationships for ${c.complete_name}: ${err.message}`);
      return [];
    } finally {
      onProgress(++done, contacts.length);
    }
  });

  return { contacts, groups, relationships: perContact.flat(), warnings };
}

export function buildGraph(contacts, relationships, groups) {
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const known = new Set(contacts.map((c) => String(c.id)));

  const nodes = contacts.map((c) => ({
    id: String(c.id),
    label: c.complete_name,
    hashId: c.hash_id,
    isMe: Boolean(c.is_me),
  }));

  const edges = new Map();
  for (const r of relationships) {
    const source = String(r.contact_is.id);
    const target = String(r.of_contact.id);
    if (!known.has(source) || !known.has(target)) continue;

    const type = r.relationship_type;
    // A relationship and its reverse row (parent/child) share one key.
    const key = [
      [source, target].sort().join('-'),
      [type.name, type.name_reverse_relationship].sort().join('/'),
    ].join('|');
    if (edges.has(key)) continue;

    edges.set(key, {
      id: key,
      source,
      target,
      label: type.name,
      category: groupName.get(type.relationship_type_group_id) ?? 'other',
    });
  }

  const edgeList = [...edges.values()];
  const categories = [...new Set(edgeList.map((e) => e.category))].sort();

  return { nodes, edges: edgeList, categories };
}

// ---------- helpers shared by the 2D and 3D views ----------

// The subset of the graph to display. Relationship counts are taken from the full graph, so hiding
// a category never turns people into "isolated" ones.
export function visibleGraph(graph, { hiddenCategories, hideIsolated }) {
  const connected = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const nodes = graph.nodes.filter((n) => !hideIsolated || n.isMe || connected.has(n.id));
  const shown = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => !hiddenCategories.has(e.category) && shown.has(e.source) && shown.has(e.target));
  return { nodes, edges };
}

// A random person from the visible graph, "me" included. `random` is injectable for tests.
// Returns undefined when there is nobody to pick.
export function pickRandomPerson(visibleNodes, random = Math.random) {
  if (!visibleNodes.length) return undefined;
  return visibleNodes[Math.min(visibleNodes.length - 1, Math.floor(random() * visibleNodes.length))];
}

// One row per relationship of a person: what it is, and who it is with.
export function relationsOf(graph, id) {
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return graph.edges
    .filter((e) => e.source === id || e.target === id)
    .map((e) => ({ kind: e.label, who: label.get(e.source === id ? e.target : e.source) }));
}

// Same colour with an alpha channel; anything that is not #rgb, #rrggbb or rgb() is returned as is.
export function withAlpha(color, alpha) {
  const c = color.trim();
  let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  m = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${alpha})` : color;
}
