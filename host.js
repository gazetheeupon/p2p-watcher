// Host-only page. This tab is the *source*: it indexes a folder you drop or
// pick, seeds it to any client that connects, and shows connection status.
// It deliberately does NOT connect to anyone else's share link, does NOT
// keep a <video> player, and does NOT let you click a file to play it here
// — playback only ever happens on the viewer page (watch/). That split
// exists specifically so refreshing this tab can never make it try to
// reconnect to a library you separately watched as a client (the old
// single-page app kept both roles' sources in one localStorage list, so a
// browser that had ever done both would try to re-connect as a client
// every time you reopened it as a host).
import { generateSourceCredentials } from './src/crypto.js?v=tv1';
import { loadSources, upsertSources, removeSource, buildBundleUrl, HOST_STORAGE_KEY } from './src/store.js?v=tv1';
import { filesFromDataTransfer, filesFromFileList, filesFromDirectoryHandle, buildMap, toFileMap, guessFolderName } from './src/vfs.js';
import { Swarm, trackerListFromLocation } from './src/swarm.js';
import { HostLibrary } from './src/session.js';
import { bindStreamBridge, ensureServiceWorker } from './src/stream-bridge.js';
import { qrSvg } from './src/qr.js';
import { bindSpatialNav, bindGlobalEsc } from './src/tvnav.js';

const logs = [];
const hosts = new Map();
const swarms = new Map();
const trackers = trackerListFromLocation();

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
  console.log('[p2p-watcher:host]', msg, extra || '');
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

// Real file (watch.html), not /watch/ — Fire TV Silk 404s directory indexes
// when the #fragment is dropped or glued onto the path. Query string + hyphen
// survive URL pastes that fold case or strip hashes.
function watchPageUrl() {
  return new URL('./watch.html', location.href).href.replace(/[?#].*$/, '');
}

function buildWatchShareUrl(id, key) {
  return watchPageUrl() + '?add=' + String(id).toLowerCase() + '-' + String(key).toLowerCase();
}

function render() {
  const sourcesEl = $('sources');
  const empty = $('emptyState');
  const sources = loadSources(globalThis.localStorage, HOST_STORAGE_KEY);
  if (!sources.length) {
    empty.hidden = false;
    sourcesEl.innerHTML = '';
  } else {
    empty.hidden = true;
    sourcesEl.innerHTML = sources
      .map((s) => {
        const swarm = swarms.get(s.id);
        const host = hosts.get(s.id);
        const peers = swarm?.peers.size || 0;
        const name = host?.map.name || s.name || s.id.slice(0, 8);
        const share = buildWatchShareUrl(s.id, s.key);
        const fileCount = host ? host.map.files.filter((f) => f.kind === 'video' || f.kind === 'audio').length : 0;
        return `<li class="source-row" data-testid="source">
          <div>
            <strong>${escapeHtml(name)}</strong>
            <span class="pill host">${peers ? peers + ' watching' : 'seeding · 0 connected'}</span>
            <div class="muted">${fileCount} playable file(s)</div>
            <div class="muted mono" data-testid="share-url">${escapeHtml(share)}</div>
          </div>
          <div class="top-actions">
            <button class="ghost" data-nav data-copy="${escapeHtml(share)}">Copy link</button>
            <button class="ghost" data-nav data-remove="${escapeHtml(s.id)}">Stop sharing</button>
          </div>
        </li>`;
      })
      .join('');
    sourcesEl.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy);
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy link'), 1500);
        } catch {
          btn.textContent = 'Select URL';
        }
      });
    });
    sourcesEl.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => stopSharing(btn.dataset.remove));
    });
  }
  const bundleBtn = $('bundleBtn');
  bundleBtn.disabled = sources.length === 0;
  exposeDebug();
}

function stopSharing(id) {
  const swarm = swarms.get(id);
  swarm?.destroy();
  swarms.delete(id);
  hosts.delete(id);
  removeSource(id, globalThis.localStorage, HOST_STORAGE_KEY);
  render();
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
      $('status').textContent =
        ev.state === 'progress'
          ? `Remuxing ${ev.path}… ${Math.round((ev.ratio || 0) * 100)}% (only needed once per file, then it's cached)`
          : ev.state === 'start'
            ? `Remuxing ${ev.path}… a viewer is loading this file`
            : ev.state === 'error'
              ? `Remux failed for ${ev.path}: ${ev.message}`
              : 'Ready';
      log('transcode', ev);
    },
    onLog: (e) => log(e.msg, e.extra),
  });
  hosts.set(creds.id, host);
  upsertSources([{ id: creds.id, key: creds.keyB64, name: map.name, role: 'host' }], globalThis.localStorage, HOST_STORAGE_KEY);
  const swarm = new Swarm({
    sourceId: creds.id,
    key: creds.key,
    trackers,
    initiator: false,
    onDataChannel: ({ dc }) => host.attachChannel(dc),
    onStatus: (st) => {
      $('status').textContent = st.state === 'connected' ? `Seeding · ${st.peers} watching` : 'Seeding (waiting for a viewer to connect)';
      render();
    },
    onLog: (e) => log(e.msg, e.extra),
  });
  swarms.set(creds.id, swarm);
  await swarm.start();
  $('status').textContent = 'Seeding ' + map.files.filter((f) => f.kind === 'video' || f.kind === 'audio').length + ' file(s) — share the link below';
  render();
  return creds;
}

function showBundle() {
  const sources = loadSources(globalThis.localStorage, HOST_STORAGE_KEY);
  if (!sources.length) return;
  const url = buildBundleUrl(
    watchPageUrl(),
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
  window.__P2P_WATCHER_HOST__ = {
    logs,
    hosts: () => [...hosts.keys()],
    shareUrls: () => loadSources(globalThis.localStorage, HOST_STORAGE_KEY).map((s) => buildWatchShareUrl(s.id, s.key)),
    bundleUrl: () =>
      buildBundleUrl(
        watchPageUrl(),
        loadSources(globalThis.localStorage, HOST_STORAGE_KEY).map((s) => ({ id: s.id, key: s.key })),
      ),
    peers: (id) => swarms.get(id)?.peers.size || 0,
    stopSharing,
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
  // The host still needs cross-origin isolation (COOP/COEP) for
  // ffmpeg.wasm's remuxing to work, even though this page never shows a
  // <video> itself — the remux runs here, on demand, whenever a viewer
  // requests a .mkv/.avi file.
  bindStreamBridge((sourceId) => hosts.get(sourceId) || null);
  try {
    await ensureServiceWorker();
    const params = new URLSearchParams(location.search);
    if (!params.has('nocoil') && !window.crossOriginIsolated && !sessionStorage.getItem('p2p-host-coi-reloaded')) {
      sessionStorage.setItem('p2p-host-coi-reloaded', '1');
      location.reload();
      return;
    }
  } catch (err) {
    log('service worker failed', { err: String(err) });
    $('status').textContent = 'Service worker unavailable — remuxing .mkv/.avi files will fail, but browser-native formats (mp4, webm) still work';
  }

  bindDrop();
  bindSpatialNav(() => (!$('shareModal').hidden ? $('shareModal') : document));
  bindGlobalEsc(() => {
    if (!$('shareModal').hidden) $('shareModal').hidden = true;
  });
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

  render();
  // Re-render periodically so the peer count updates live without requiring
  // a swarm status event for every tick.
  setInterval(render, 3000);
}

boot().catch((err) => {
  log('boot failed', { err: String(err) });
  $('status').textContent = String(err.message || err);
});
