export const STORAGE_KEY = 'p2p-watcher.sources.v1';

const ID_RE = /^[0-9a-f]{32}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{32,86}$/;

export function parsePair(s) {
  if (typeof s !== 'string') return null;
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const id = s.slice(0, i).trim();
  const key = s.slice(i + 1).trim();
  if (!ID_RE.test(id) || !KEY_RE.test(key)) return null;
  return { id: id.toLowerCase(), key };
}

export function parseHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return { action: 'none', sources: [] };
  if (h.startsWith('add=')) {
    const src = parsePair(h.slice(4));
    return src ? { action: 'add', sources: [src] } : { action: 'invalid', sources: [] };
  }
  if (h.startsWith('bundle=')) {
    const sources = h.slice(7).split('&').map(parsePair).filter(Boolean);
    return { action: sources.length ? 'bundle' : 'invalid', sources };
  }
  return { action: 'none', sources: [] };
}

export function buildAddHash(id, key) {
  return `#add=${id}:${key}`;
}

export function buildBundleHash(sources) {
  return '#bundle=' + sources.map((s) => `${s.id}:${s.key}`).join('&');
}

export function buildShareUrl(originPath, id, key) {
  return originPath.replace(/#.*$/, '') + buildAddHash(id, key);
}

export function buildBundleUrl(originPath, sources) {
  return originPath.replace(/#.*$/, '') + buildBundleHash(sources);
}

export function loadSources(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && ID_RE.test(s.id) && KEY_RE.test(s.key));
  } catch {
    return [];
  }
}

export function saveSources(sources, storage = globalThis.localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(sources));
}

export function upsertSources(incoming, storage = globalThis.localStorage) {
  const existing = loadSources(storage);
  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const s of incoming) {
    if (!s || !ID_RE.test(s.id) || !KEY_RE.test(s.key)) continue;
    const prev = byId.get(s.id) || {};
    byId.set(s.id, {
      ...prev,
      ...s,
      id: s.id.toLowerCase(),
      key: s.key,
      addedAt: prev.addedAt || Date.now(),
    });
  }
  const next = [...byId.values()];
  saveSources(next, storage);
  return next;
}

export function removeSource(id, storage = globalThis.localStorage) {
  const next = loadSources(storage).filter((s) => s.id !== id);
  saveSources(next, storage);
  return next;
}

export function consumeHash(loc = globalThis.location, hist = globalThis.history, storage = globalThis.localStorage) {
  const parsed = parseHash(loc.hash);
  if (parsed.sources.length) {
    upsertSources(parsed.sources, storage);
    hist.replaceState(null, '', loc.pathname + loc.search);
  }
  return { parsed, sources: loadSources(storage) };
}
