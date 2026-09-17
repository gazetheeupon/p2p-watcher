export const STORAGE_KEY = 'p2p-watcher.sources.v1';
// Separate key for the host page's own bookkeeping of folders *it* is seeding.
// Kept apart from STORAGE_KEY (the viewer's list of sources it has connected
// to) so the host page never iterates over — and never tries to reconnect
// to — sources this browser previously *watched* as a client, and vice
// versa. This is what lets host.html and watch/index.html be reloaded
// independently without one page's state bleeding into the other's.
export const HOST_STORAGE_KEY = 'p2p-watcher.hosted.v1';

const ID_RE = /^[0-9a-f]{32}$/i;
const HEX_KEY_RE = /^[0-9a-f]{64}$/i;
const LEGACY_KEY_RE = /^[A-Za-z0-9_-]{32,86}$/;

export function parsePair(s) {
  if (typeof s !== 'string') return null;
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const id = s.slice(0, i).trim().toLowerCase();
  let shareKey = s.slice(i + 1).trim();
  if (!ID_RE.test(id)) return null;
  if (HEX_KEY_RE.test(shareKey)) shareKey = shareKey.toLowerCase();
  else if (!LEGACY_KEY_RE.test(shareKey)) return null;
  return { id, key: shareKey };
}

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return { action: 'none', sources: [] };
  const lower = raw.toLowerCase();
  const payload = raw.slice(raw.indexOf('=') + 1);
  if (lower.startsWith('add=')) {
    const src = parsePair(payload);
    return src ? { action: 'add', sources: [src] } : { action: 'invalid', sources: [] };
  }
  if (lower.startsWith('bundle=')) {
    const sources = payload.split('&').map(parsePair).filter(Boolean);
    return { action: sources.length ? 'bundle' : 'invalid', sources };
  }
  return { action: 'none', sources: [] };
}

export function buildAddHash(id, key) {
  const k = HEX_KEY_RE.test(key) ? String(key).toLowerCase() : key;
  return `#add=${String(id).toLowerCase()}:${k}`;
}

export function buildBundleHash(sources) {
  return (
    '#bundle=' +
    sources
      .map((s) => {
        const k = HEX_KEY_RE.test(s.key) ? String(s.key).toLowerCase() : s.key;
        return `${String(s.id).toLowerCase()}:${k}`;
      })
      .join('&')
  );
}

export function buildShareUrl(originPath, id, key) {
  return originPath.replace(/#.*$/, '') + buildAddHash(id, key);
}

export function buildBundleUrl(originPath, sources) {
  return originPath.replace(/#.*$/, '') + buildBundleHash(sources);
}

export function loadSources(storage = globalThis.localStorage, key = STORAGE_KEY) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => s && ID_RE.test(s.id) && (HEX_KEY_RE.test(s.key) || LEGACY_KEY_RE.test(s.key)));
  } catch {
    return [];
  }
}

export function saveSources(sources, storage = globalThis.localStorage, key = STORAGE_KEY) {
  storage.setItem(key, JSON.stringify(sources));
}

export function upsertSources(incoming, storage = globalThis.localStorage, key = STORAGE_KEY) {
  const existing = loadSources(storage, key);
  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const s of incoming) {
    if (!s || !ID_RE.test(s.id) || !(HEX_KEY_RE.test(s.key) || LEGACY_KEY_RE.test(s.key))) continue;
    const prev = byId.get(s.id) || {};
    const shareKey = HEX_KEY_RE.test(s.key) ? s.key.toLowerCase() : s.key;
    byId.set(s.id, {
      ...prev,
      ...s,
      id: s.id.toLowerCase(),
      key: shareKey,
      addedAt: prev.addedAt || Date.now(),
    });
  }
  const next = [...byId.values()];
  saveSources(next, storage, key);
  return next;
}

export function removeSource(id, storage = globalThis.localStorage, key = STORAGE_KEY) {
  const next = loadSources(storage, key).filter((s) => s.id !== id);
  saveSources(next, storage, key);
  return next;
}

export function consumeHash(loc = globalThis.location, hist = globalThis.history, storage = globalThis.localStorage, key = STORAGE_KEY) {
  const parsed = parseHash(loc.hash);
  if (parsed.sources.length) {
    upsertSources(parsed.sources, storage, key);
    hist.replaceState(null, '', loc.pathname + loc.search);
  }
  return { parsed, sources: loadSources(storage, key) };
}
