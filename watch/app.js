// Viewer-only page. This tab connects to one or more host share links and
// plays their files. It never seeds anything itself and never shows a
// drop zone — the only source of media here is a share/bundle link. That
// split (see host.js for the other half) is what stops a host tab from
// ever trying to reconnect to a library it previously watched, and lets
// this page show real "connecting / authenticating / failed, try again"
// status instead of a spinner that silently never updates.
import { importKey } from '../src/crypto.js?v=paste1';
import { consumeHash, loadSources, upsertSources, removeSource, buildBundleUrl, parsePastedShare } from '../src/store.js?v=paste1';
import { Swarm, trackerListFromLocation } from '../src/swarm.js?v=dc2';
import { RemoteLibrary, channelAlive } from '../src/session.js?v=dc1';
import { bindStreamBridge, ensureServiceWorker, virtualStreamUrl } from '../src/stream-bridge.js';
import { qrSvg } from '../src/qr.js';
import { bindSpatialNav, bindGlobalEsc } from '../src/tvnav.js';

const logs = [];
const remotes = new Map();
const swarms = new Map();
// Per-source connection status shown in the Sources list, independent of
// whatever swarm/remote objects exist right now — this is what was missing
// before: a connection attempt could fail (or time out) with nothing ever
// telling the UI to stop saying "Connecting…".
const connState = new Map(); // id -> { status: 'connecting'|'authenticating'|'connected'|'error', message }
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
  console.log('[p2p-watcher:watch]', msg, extra || '');
}

function originPath() {
  if (/watch\.html$/i.test(location.pathname)) return location.origin + location.pathname;
  return new URL('../watch.html', location.href).href.replace(/[?#].*$/, '');
}

function setState(id, status, message) {
  connState.set(id, { status, message });
  render();
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

function rebuildMerged() {
  merged.length = 0;
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
      const st = connState.get(s.id) || { status: remotes.has(s.id) ? 'connected' : 'connecting', message: '' };
      const label =
        st.status === 'connected'
          ? 'Connected'
          : st.status === 'authenticating'
            ? 'Channel open, authenticating…'
            : st.status === 'error'
              ? 'Couldn’t connect'
              : st.status === 'idle'
                ? 'Not connected'
                : 'Connecting…';
      const pillClass = st.status === 'connected' ? 'client' : st.status === 'error' ? 'client' : 'client';
      const name = remotes.get(s.id)?.map?.name || s.name || s.id.slice(0, 8);
      const showCancel = st.status === 'connecting' || st.status === 'authenticating';
      // A cancelled ('idle') source gets the same Retry control as a failed
      // one — Cancel stops the attempt, but the user still needs a way back
      // in besides removing and re-adding the link.
      const showRetry = st.status === 'error' || st.status === 'idle';
      return `<li class="source-row" data-testid="source">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <span class="pill ${pillClass}">${escapeHtml(label)}</span>
          ${st.message ? `<div class="muted">${escapeHtml(st.message)}</div>` : ''}
        </div>
        <div class="top-actions">
          ${showCancel ? `<button class="ghost danger" data-nav data-cancel="${escapeHtml(s.id)}" aria-label="Stop trying to connect">&times; Cancel</button>` : ''}
          ${showRetry ? `<button class="ghost" data-nav data-retry="${escapeHtml(s.id)}">Retry</button>` : ''}
          <button class="ghost" data-nav data-remove="${escapeHtml(s.id)}">Remove</button>
        </div>
      </li>`;
    })
    .join('');
  sourcesEl.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelConnect(btn.dataset.cancel));
  });
  sourcesEl.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const source = loadSources().find((s) => s.id === btn.dataset.retry);
      if (source) connectRemote(source).catch((err) => log('retry failed', { err: String(err) }));
    });
  });
  sourcesEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cancelConnect(btn.dataset.remove);
      removeSource(btn.dataset.remove);
      connState.delete(btn.dataset.remove);
      render();
    });
  });

  const bundleBtn = $('bundleBtn');
  bundleBtn.disabled = sources.length === 0;
  exposeDebug();
}

// Stops an in-flight (or hung) connection attempt: tears down the swarm so
// no further ICE/data-channel events fire, and puts the UI back to an idle
// state instead of leaving it stuck on "Connecting…" forever. This is the
// "red X" control.
function cancelConnect(id) {
  clearTimeout(connectWatchdogs.get(id));
  connectWatchdogs.delete(id);
  const swarm = swarms.get(id);
  swarm?.destroy();
  swarms.delete(id);
  remotes.delete(id);
  connectingGuard.delete(id);
  // Explicit 'idle' rather than clearing the entry: render()'s fallback for
  // "no connState recorded" is 'connecting' (so a source just added from a
  // link shows as connecting before the first render), which would make a
  // just-cancelled source look like it's still trying to connect.
  connState.set(id, { status: 'idle', message: '' });
  render();
}

async function playItem(item) {
  const player = $('player');
  const video = $('video');
  currentItem = item;
  $('nowPlaying').textContent = item.name;
  player.hidden = false;
  $('playerStatus').hidden = false;
  $('playerStatus').textContent = 'Loading…';
  video.hidden = true;
  video.querySelectorAll('track').forEach((t) => t.remove());
  const lib = remotes.get(item.sourceId);
  if (!lib) {
    $('playerStatus').textContent = 'This source is no longer connected.';
    return;
  }
  lib.onTranscodeProgress = (msg) => {
    if (msg.path !== item.path) return;
    if (msg.state === 'progress') {
      $('playerStatus').textContent = `The host is preparing this file (remuxing)… ${Math.round((msg.ratio || 0) * 100)}%`;
    } else if (msg.state === 'start') {
      $('playerStatus').textContent = 'The host is preparing this file — this can take a while for a large .mkv/.avi the first time it’s watched…';
    } else if (msg.state === 'error') {
      $('playerStatus').textContent = 'The host could not prepare this file: ' + msg.message;
    }
  };
  let prepared = null;
  try {
    // Wait for the host to finish any needed remux BEFORE pointing <video>
    // at the stream, so the status line above actually means something —
    // previously this fired at the same time as setting video.src, so a
    // slow remux just looked like a video element stuck buffering with no
    // explanation.
    prepared = await lib.prepare(item.path);
  } catch (err) {
    $('playerStatus').textContent = 'Could not load this file: ' + String(err.message || err);
    log('prepare failed', { err: String(err) });
    return;
  }
  $('playerStatus').hidden = true;
  video.hidden = false;
  video.src = virtualStreamUrl(item.sourceId, item.path);
  video.onerror = () => {
    $('playerStatus').hidden = false;
    $('playerStatus').textContent = 'Playback error: ' + (video.error?.message || 'the browser could not decode this stream.');
  };
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

const connectingGuard = new Set();
const connectWatchdogs = new Map();

async function connectRemote(source) {
  if (swarms.has(source.id)) return;
  setState(source.id, 'connecting', '');
  let settled = false;
  clearTimeout(connectWatchdogs.get(source.id));
  const watchdog = setTimeout(() => {
    if (!channelAlive(remotes.get(source.id))) {
      setState(
        source.id,
        'error',
        'No WebRTC data channel opened. Same Wi-Fi helps; some routers block peer-to-peer. Leave this page open and retry.',
      );
    }
  }, 45000);
  connectWatchdogs.set(source.id, watchdog);
  const swarm = new Swarm({
    sourceId: source.id,
    key: await importKey(source.key),
    trackers,
    initiator: true,
    onChannelOpen: ({ dc }) => {
      const start = async () => {
        if (channelAlive(remotes.get(source.id)) || connectingGuard.has(source.id)) return;
        connectingGuard.add(source.id);
        setState(source.id, 'authenticating', '');
        const key = await importKey(source.key);
        const remote = new RemoteLibrary({ sourceId: source.id, key, dc, onLog: (e) => log(e.msg, e.extra) });
        remote.onDead = () => {
          if (remotes.get(source.id) === remote) {
            remotes.delete(source.id);
            if (currentItem && currentItem.sourceId === source.id && !$('player').hidden) {
              resumeItem = currentItem;
              $('playerStatus').hidden = false;
              $('playerStatus').textContent = 'Connection dropped — reconnecting…';
            }
            if (settled) setState(source.id, 'error', 'Connection dropped.');
          }
        };
        remotes.set(source.id, remote);
        try {
          await remote.waitReady();
          settled = true;
          clearTimeout(watchdog);
          upsertSources([{ id: source.id, key: source.key, name: remote.map?.name, role: 'client' }]);
          setState(source.id, 'connected', '');
          if (resumeItem && resumeItem.sourceId === source.id) {
            const item = resumeItem;
            resumeItem = null;
            playItem(item).catch((err) => log('resume play failed', { err: String(err) }));
          }
        } catch (err) {
          if (remotes.get(source.id) === remote) remotes.delete(source.id);
          log('remote handshake failed', { err: String(err), id: source.id });
          setState(source.id, 'error', String(err.message || err));
        } finally {
          connectingGuard.delete(source.id);
        }
      };
      start();
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
    remotes: () => [...remotes.keys()].map((id) => ({ id, map: remotes.get(id)?.map })),
    merged: () => merged,
    connState: () => [...connState.entries()],
    shareUrls: () => loadSources().map((s) => originPath() + '?add=' + s.id + '-' + s.key),
    bundleUrl: () =>
      buildBundleUrl(
        originPath(),
        loadSources().map((s) => ({ id: s.id, key: s.key })),
      ),
    removeSource,
    virtualStreamUrl,
    controller: () => navigator.serviceWorker.controller?.scriptURL || null,
    channelAlive: (id) => channelAlive(id ? remotes.get(id) : [...remotes.values()][0]),
    cancelConnect,
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

async function boot() {
  bindStreamBridge((sourceId) => remotes.get(sourceId) || null);
  try {
    await ensureServiceWorker();
  } catch (err) {
    log('service worker failed', { err: String(err) });
    $('status').textContent = 'Service worker unavailable — playback will fail';
  }

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

  function ingestParsed(parsed) {
    if (parsed.action === 'invalid') {
      $('status').textContent = 'Could not find an add= parameter in that text';
      return;
    }
    if (parsed.sources.length) {
      upsertSources(parsed.sources);
      $('status').textContent = 'Connecting to ' + parsed.sources.length + ' source(s)…';
    } else if (!loadSources().length) {
      $('status').textContent = 'Open a share link, or paste it in the box above.';
    }
    for (const source of loadSources()) {
      if (remotes.has(source.id) || swarms.has(source.id)) continue;
      connectRemote(source).catch((err) => log('connect failed', { err: String(err), id: source.id }));
    }
    render();
  }

  async function ingestHash() {
    const { parsed } = consumeHash();
    ingestParsed(parsed);
  }

  const paste = $('pasteUrl');
  const pasteBtn = $('pasteGo');
  if (paste && pasteBtn) {
    const go = () => ingestParsed(parsePastedShare(paste.value));
    pasteBtn.addEventListener('click', go);
    paste.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    });
    if (!location.search.includes('add=') && !location.hash.includes('add=')) paste.focus();
  }

  await ingestHash();
  window.addEventListener('hashchange', () => ingestHash());
  exposeDebug();
}

boot().catch((err) => {
  log('boot failed', { err: String(err) });
  $('status').textContent = String(err.message || err);
});
