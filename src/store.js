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
  const t = s.trim();
  const colon = t.indexOf(':');
  if (colon > 0) {
    const id = t.slice(0, colon).trim().toLowerCase();
    let shareKey = t.slice(colon + 1).trim();
    if (!ID_RE.test(id)) return null;
    if (HEX_KEY_RE.test(shareKey)) shareKey = shareKey.toLowerCase();
    else if (!LEGACY_KEY_RE.test(shareKey)) return null;
    return { id, key: shareKey };
  }
  const hyphen = t.match(/^([0-9a-f]{32})-([0-9a-f]{64})$/i);
  if (hyphen) return { id: hyphen[1].toLowerCase(), key: hyphen[2].toLowerCase() };
  return null;
}

function parsePayload(kind, payload, pairSep) {
  if (kind === 'add') {
    const src = parsePair(payload);
    return src ? { action: 'add', sources: [src] } : { action: 'invalid', sources: [] };
  }
  if (kind === 'bundle') {
    const sources = payload.split(pairSep).map(parsePair).filter(Boolean);
    return { action: sources.length ? 'bundle' : 'invalid', sources };
  }
  return { action: 'none', sources: [] };
}

export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return { action: 'none', sources: [] };
  const lower = raw.toLowerCase();
  const payload = raw.slice(raw.indexOf('=') + 1);
  if (lower.startsWith('add=')) return parsePayload('add', payload, '&');
  if (lower.startsWith('bundle=')) return parsePayload('bundle', payload, '&');
  return { action: 'none', sources: [] };
}

export function parseShareInput(hash, search) {
  const fromHash = parseHash(hash);
  if (fromHash.action !== 'none') return fromHash;
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (q.has('add')) return parsePayload('add', q.get('add'), '~');
  if (q.has('bundle')) return parsePayload('bundle', q.get('bundle'), '~');
  return { action: 'none', sources: [] };
}

export function parsePastedShare(text) {
  const t = String(text || '').trim();
  if (!t) return { action: 'none', sources: [] };
  try {
    const u = new URL(t);
    const parsed = parseShareInput(u.hash, u.search);
    if (parsed.action !== 'none') return parsed;
  } catch {
    /* not an absolute URL */
  }
  const lower = t.toLowerCase();
  const addAt = lower.lastIndexOf('add=');
  const bundleAt = lower.lastIndexOf('bundle=');
  if (bundleAt >= 0 && bundleAt > addAt) {
    const payload = t.slice(bundleAt + 7).split(/\s/)[0].replace(/\/$/, '');
    return parsePayload('bundle', payload, /[&~]/);
  }
  if (addAt >= 0) {
    const payload = t.slice(addAt + 4).split(/\s/)[0].replace(/\/$/, '');
    return parsePayload('add', payload, '~');
  }
  const pair = parsePair(t);
  if (pair) return { action: 'add', sources: [pair] };
  return { action: 'invalid', sources: [] };
}

export function buildAddHash(id, key) {
  const k = HEX_KEY_RE.test(key) ? String(key).toLowerCase() : key;
  return `#add=${String(id).toLowerCase()}:${k}`;
}

export function buildAddQuery(id, key) {
  return `?add=${String(id).toLowerCase()}-${String(key).toLowerCase()}`;
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

export function buildBundleQuery(sources) {
  return (
    '?bundle=' +
    sources.map((s) => `${String(s.id).toLowerCase()}-${String(s.key).toLowerCase()}`).join('~')
  );
}

export function buildShareUrl(originPath, id, key) {
  return String(originPath).replace(/[?#].*$/, '') + buildAddQuery(id, key);
}

export function buildBundleUrl(originPath, sources) {
  return String(originPath).replace(/[?#].*$/, '') + buildBundleQuery(sources);
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

const KEEP_QS = new Set(['nocoil', 'debug', 'trackers']);

export function stripShareParams(loc = globalThis.location, hist = globalThis.history) {
  const q = new URLSearchParams(loc.search);
  q.delete('add');
  q.delete('bundle');
  const kept = new URLSearchParams();
  for (const [k, v] of q.entries()) {
    if (KEEP_QS.has(k)) kept.set(k, v);
  }
  const qs = kept.toString();
  hist.replaceState(null, '', loc.pathname + (qs ? '?' + qs : ''));
}

export function consumeHash(loc = globalThis.location, hist = globalThis.history, storage = globalThis.localStorage, key = STORAGE_KEY) {
  const parsed = parseShareInput(loc.hash, loc.search);
  if (parsed.sources.length || parsed.action === 'invalid') {
    if (parsed.sources.length) upsertSources(parsed.sources, storage, key);
    stripShareParams(loc, hist);
  }
  return { parsed, sources: loadSources(storage, key) };
}
