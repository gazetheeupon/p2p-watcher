import { generateSourceCredentials, importKey } from './src/crypto.js';
import {
  consumeHash,
  loadSources,
  upsertSources,
  removeSource,
  buildShareUrl,
  buildBundleUrl,
} from './src/store.js';
import { filesFromDataTransfer, filesFromFileList, filesFromDirectoryHandle, buildMap, toFileMap, guessFolderName } from './src/vfs.js';
import { Swarm, trackerListFromLocation } from './src/swarm.js';
import { HostLibrary, RemoteLibrary, channelAlive } from './src/session.js';
import { bindStreamBridge, ensureServiceWorker, virtualStreamUrl } from './src/stream-bridge.js';
import { qrSvg } from './src/qr.js';
import { bindSpatialNav, bindGlobalEsc } from './src/tvnav.js';

const logs = [];
const hosts = new Map();
const remotes = new Map();
const swarms = new Map();
const connecting = new Set();
const merged = [];
const trackers = trackerListFromLocation();
let currentItem = null;
let resumeItem = null;

const $ = (id) => document.getElementById(id);

function log(msg, extra) {
  const entry = { t: Date.now(), msg, extra };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  const el = $('log');
  if (el && new URLSearchParams(location.search).has('debug')) {
    el.hidden = false;
    el.textContent = logs
      .slice(-40)
      .map((l) => l.msg + (l.extra ? ' ' + JSON.stringify(l.extra) : ''))
      .join('\n');
  }
  console.log('[p2p-watcher]', msg, extra || '');
}

function originPath() {
  return location.origin + location.pathname;
}

function lookupLib(sourceId) {
  return hosts.get(sourceId) || remotes.get(sourceId) || null;
}

function rebuildMerged() {
  merged.length = 0;
  for (const [sourceId, host] of hosts) {
    for (const f of host.publicMap().files) {
      if (f.kind === 'video' || f.kind === 'audio') {
        merged.push({ ...f, sourceId, sourceName: host.map.name, origin: 'host' });
      }
    }
  }
  for (const [sourceId, remote] of remotes) {
    const map = remote.map;
    if (!map) continue;
    for (const f of map.files) {
      if (f.kind === 'video' || f.kind === 'audio') {
        merged.push({ ...f, sourceId, sourceName: map.name, origin: 'remote' });
      }
    }
  }
}

function sourceStatus(id) {
  const swarm = swarms.get(id);
  const host = hosts.get(id);
  const remote = remotes.get(id);
  if (host) return { role: 'host', peers: swarm?.peers.size || 0, name: host.map.name };
  if (remote) return { role: 'client', peers: swarm?.peers.size || 0, name: remote.map?.name || 'Connecting…' };
  return { role: 'idle', peers: 0, name: id.slice(0, 8) };
}

function render() {
  rebuildMerged();
  const library = $('library');
  const empty = $('emptyState');
  const sourcesEl = $('sources');
  if (!merged.length) {
    empty.hidden = false;
    library.innerHTML = '';
  } else {
    empty.hidden = true;
    library.innerHTML = merged
      .map(
        (item, i) => `
      <button class="card" data-nav data-testid="card" data-idx="${i}" tabindex="0">
        <div class="poster">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</div>
        <div class="meta">
          <div class="title">${escapeHtml(item.name)}</div>
          <div class="sub">${escapeHtml(item.sourceName || '')} · ${formatSize(item.size)}</div>
        </div>
      </button>`,
      )
      .join('');
    library.querySelectorAll('[data-idx]').forEach((btn) => {
      btn.addEventListener('click', () => playItem(merged[Number(btn.dataset.idx)]));
    });
  }

  const sources = loadSources();
  sourcesEl.innerHTML = sources
    .map((s) => {
      const st = sourceStatus(s.id);
      const share = buildShareUrl(originPath(), s.id, s.key);
      return `<li class="source-row" data-testid="source">
        <div>
          <strong>${escapeHtml(st.name)}</strong>
          <span class="pill ${st.role}">${st.role}${st.peers ? ' · ' + st.peers + ' peer(s)' : ''}</span>
          <div class="muted mono" data-testid="share-url">${escapeHtml(share)}</div>
        </div>
        <button class="ghost" data-nav data-copy="${escapeHtml(share)}">Copy link</button>
      </li>`;
    })
    .join('');
  sourcesEl.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select URL';
      }
    });
  });

  const bundleBtn = $('bundleBtn');
  bundleBtn.disabled = sources.length === 0;
  exposeDebug();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v < 10 && i ? 1 : 0) + ' ' + u[i];
}

async function playItem(item) {
  const player = $('player');
  const video = $('video');
  currentItem = item;
  $('nowPlaying').textContent = item.name;
  player.hidden = false;
  video.querySelectorAll('track').forEach((t) => t.remove());
  const lib = lookupLib(item.sourceId);
  let prepared = null;
  if (lib?.prepare) {
    try {
      prepared = await lib.prepare(item.path);
    } catch (err) {
      log('prepare failed', { err: String(err) });
    }
  }
  video.src = virtualStreamUrl(item.sourceId, item.path);
  video.onerror = () => log('video error', { code: video.error?.code, message: video.error?.message, src: video.src });
  video.focus();
  try {
    await video.play();
  } catch {
    /* user can press play */
  }
  const subs = prepared?.subtitles || item.subtitles || [];
  item.subtitles = subs;
  for (const sub of subs) {
    try {
      const body = await lib.readText(sub.path);
      const url = URL.createObjectURL(new Blob([body], { type: 'text/vtt' }));
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = sub.label;
      track.srclang = sub.lang;
      track.src = url;
      track.default = subs.indexOf(sub) === 0;
      video.appendChild(track);
    } catch (err) {
      log('subtitle failed', { err: String(err) });
    }
  }
}

function closePlayer() {
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('player').hidden = true;
  currentItem = null;
  resumeItem = null;
  const first = document.querySelector('[data-nav]');
  first?.focus();
}

async function startHostFromFiles(fileList, nameHint) {
  if (!fileList.length) return;
  const creds = await generateSourceCredentials();
  const map = buildMap({ sourceId: creds.id, name: nameHint || guessFolderName(fileList), files: fileList });
  const fileMap = toFileMap(fileList);
  const host = new HostLibrary({
    sourceId: creds.id,
    key: creds.key,
    fileMap,
    map,
    onTranscode: (ev) => {
      $('status').textContent = ev.state === 'progress'
        ? `Remuxing ${ev.path}… ${Math.round((ev.ratio || 0) * 100)}%`
        : ev.state === 'start'
          ? `Remuxing ${ev.path}…`
          : 'Ready';
      log('transcode', ev);
    },
    onLog: (e) => log(e.msg, e.extra),
  });
  hosts.set(creds.id, host);
  upsertSources([{ id: creds.id, key: creds.keyB64, name: map.name, role: 'host' }]);
  const swarm = new Swarm({
    sourceId: creds.id,
    key: creds.key,
    trackers,
    initiator: false,
    onDataChannel: ({ dc }) => host.attachChannel(dc),
    onStatus: (st) => {
      $('status').textContent = st.state === 'connected' ? `Seeding · ${st.peers} connected` : 'Seeding (waiting for peers)';
      render();
    },
    onLog: (e) => log(e.msg, e.extra),
  });
  swarms.set(creds.id, swarm);
  await swarm.start();
  $('status').textContent = 'Seeding ' + map.files.filter((f) => f.kind === 'video').length + ' video(s)';
  render();
  return creds;
}

async function connectRemote(source) {
  if (hosts.has(source.id) || swarms.has(source.id)) return;
  const key = await importKey(source.key);
  const swarm = new Swarm({
    sourceId: source.id,
    key,
    trackers,
    initiator: true,
    onDataChannel: async ({ dc }) => {
      if (channelAlive(remotes.get(source.id)) || connecting.has(source.id)) return;
      connecting.add(source.id);
      const remote = new RemoteLibrary({ sourceId: source.id, key, dc, onLog: (e) => log(e.msg, e.extra) });
      remote.onDead = () => {
        if (remotes.get(source.id) === remote) {
          remotes.delete(source.id);
          if (currentItem && currentItem.sourceId === source.id && !$('player').hidden) {
            resumeItem = currentItem;
            $('status').textContent = 'Reconnecting…';
          }
        }
      };
      remotes.set(source.id, remote);
      try {
        await remote.waitReady();
        upsertSources([{ id: source.id, key: source.key, name: remote.map?.name, role: 'client' }]);
        $('status').textContent = 'Connected to ' + (remote.map?.name || 'library');
        render();
        if (resumeItem && resumeItem.sourceId === source.id) {
          const item = resumeItem;
          resumeItem = null;
          playItem(item).catch((err) => log('resume play failed', { err: String(err) }));
        }
      } catch (err) {
        if (remotes.get(source.id) === remote) remotes.delete(source.id);
        log('remote handshake failed', { err: String(err) });
      } finally {
        connecting.delete(source.id);
      }
    },
    onStatus: () => render(),
    onLog: (e) => log(e.msg, e.extra),
  });
  swarms.set(source.id, swarm);
  await swarm.start();
}

function showBundle() {
  const sources = loadSources();
  if (!sources.length) return;
  const url = buildBundleUrl(
    originPath(),
    sources.map((s) => ({ id: s.id, key: s.key })),
  );
  $('bundleUrl').textContent = url;
  try {
    $('qr').innerHTML = qrSvg(url);
  } catch (err) {
    $('qr').textContent = String(err.message || err);
  }
  $('shareModal').hidden = false;
  $('closeShare').focus();
}

function exposeDebug() {
  window.__P2P_WATCHER__ = {
    logs,
    loadSources,
    hosts: () => [...hosts.keys()],
    remotes: () => [...remotes.keys()].map((id) => ({ id, map: remotes.get(id)?.map })),
    merged: () => merged,
    shareUrls: () => loadSources().map((s) => buildShareUrl(originPath(), s.id, s.key)),
    bundleUrl: () =>
      buildBundleUrl(
        originPath(),
        loadSources().map((s) => ({ id: s.id, key: s.key })),
      ),
    removeSource,
    virtualStreamUrl,
    controller: () => navigator.serviceWorker.controller?.scriptURL || null,
    channelAlive: (id) => channelAlive(id ? remotes.get(id) : [...remotes.values()][0]),
    killRemote(id) {
      const r = id ? remotes.get(id) : [...remotes.values()][0];
      r?.dc?.close();
    },
    async probe(sourceId, path) {
      const url = virtualStreamUrl(sourceId, path);
      try {
        const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
        const buf = await res.arrayBuffer();
        return {
          url,
          status: res.status,
          contentType: res.headers.get('content-type'),
          contentRange: res.headers.get('content-range'),
          bytes: buf.byteLength,
          sw: !!navigator.serviceWorker.controller,
        };
      } catch (err) {
        return { url, error: String(err), sw: !!navigator.serviceWorker.controller };
      }
    },
  };
}

function bindDrop() {
  const drop = $('drop');
  const input = $('folderInput');
  const setDrag = (on) => drop.classList.toggle('drag', on);
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      setDrag(true);
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      setDrag(false);
    }),
  );
  drop.addEventListener('drop', async (e) => {
    const files = await filesFromDataTransfer(e.dataTransfer);
    await startHostFromFiles(files);
  });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', async () => {
    const files = filesFromFileList(input.files);
    await startHostFromFiles(files);
    input.value = '';
  });
  const openBtn = $('openFolder');
  if (openBtn && typeof window.showDirectoryPicker === 'function') {
    openBtn.hidden = false;
    openBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const files = await filesFromDirectoryHandle(handle);
        await startHostFromFiles(files, handle.name);
      } catch (err) {
        if (err && err.name !== 'AbortError') log('directory picker failed', { err: String(err) });
      }
    });
  }
}

async function boot() {
  bindStreamBridge(lookupLib);
  try {
    await ensureServiceWorker();
    const params = new URLSearchParams(location.search);
    if (!params.has('nocoil') && !window.crossOriginIsolated && !sessionStorage.getItem('p2p-coi-reloaded')) {
      sessionStorage.setItem('p2p-coi-reloaded', '1');
      location.reload();
      return;
    }
  } catch (err) {
    log('service worker failed', { err: String(err) });
    $('status').textContent = 'Service worker unavailable — playback will fail';
  }

  bindDrop();
  bindSpatialNav(() => {
    if (!$('shareModal').hidden) return $('shareModal');
    if (!$('player').hidden) return $('player');
    return document;
  });
  bindGlobalEsc(() => {
    if (!$('shareModal').hidden) {
      $('shareModal').hidden = true;
      return;
    }
    if (!$('player').hidden) closePlayer();
  });
  $('backBtn').addEventListener('click', closePlayer);
  $('bundleBtn').addEventListener('click', showBundle);
  $('closeShare').addEventListener('click', () => {
    $('shareModal').hidden = true;
  });
  $('copyBundle').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('bundleUrl').textContent);
    } catch {
      /* ignore */
    }
  });

  async function ingestHash() {
    const { parsed } = consumeHash();
    if (parsed.action === 'invalid') $('status').textContent = 'That share link was malformed';
    else if (parsed.sources.length) $('status').textContent = 'Saved ' + parsed.sources.length + ' source(s) from link';
    for (const source of loadSources()) {
      if (hosts.has(source.id) || remotes.has(source.id)) continue;
      if (source.role === 'host' && !hosts.has(source.id)) continue;
      connectRemote(source).catch((err) => log('connect failed', { err: String(err), id: source.id }));
    }
    render();
  }

  await ingestHash();
  window.addEventListener('hashchange', () => ingestHash());
  exposeDebug();
}

boot().catch((err) => {
  log('boot failed', { err: String(err) });
  $('status').textContent = String(err.message || err);
});
