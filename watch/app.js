// Viewer-only page. This tab connects to one or more host share links and
// plays their files. It never seeds anything itself and never shows a
// drop zone — the only source of media here is a share/bundle link. That
// split (see host.js for the other half) is what stops a host tab from
// ever trying to reconnect to a library it previously watched, and lets
// this page show real "connecting / authenticating / failed, try again"
// status instead of a spinner that silently never updates.
import { importKey } from '../src/crypto.js?v=paste1';
import { consumeHash, loadSources, upsertSources, removeSource, buildBundleUrl, buildShareUrl, parsePastedShare } from '../src/store.js?v=silk2';
import { Swarm, trackerListFromLocation } from '../src/swarm.js?v=lan1';
import { RemoteLibrary, channelAlive } from '../src/session.js?v=seg3';
import { segmentSpan } from '../src/mp4span.js?v=seg3';
import { bindStreamBridge, ensureServiceWorker, virtualStreamUrl } from '../src/stream-bridge.js?v=tv1';
import { qrSvg } from '../src/qr.js';
import { bindSpatialNav, bindGlobalEsc } from '../src/tvnav.js';
import { connectViewerRelay, isSilk, relayAvailable } from '../src/relay.js?v=silk2';

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
let piecePlay = null;
// 8s is a whole number of AAC frames at 48kHz and of frames at 24/25/30fps.
// 2s is not, and the player hitched at every join. Silk stays shorter.
const PIECE_SECONDS = 8;
const SILK_PIECE_SECONDS = 8 / 3;

const $ = (id) => document.getElementById(id);

const LOG_LEGEND =
  'mdns = Wi-Fi name (Fire TV often cannot use it). host = real local IP. public = internet address. relay = none configured.';

function log(msg, extra) {
  const text = extra ? msg + ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : String(msg);
  if (logs[logs.length - 1] === text) return;
  logs.push(text);
  if (logs.length > 16) logs.shift();
  paintLog();
  console.log('[p2p-watcher:watch]', text);
}

function paintLog() {
  const el = $('log');
  if (!el || el.hidden) return;
  el.textContent = [LOG_LEGEND, ...logs.slice(-12)].join('\n');
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
  if (isSilk()) video.preload = 'metadata';
  if (prepared?.segmented) {
    try {
      await playInPieces(video, lib, item, prepared);
    } catch (err) {
      $('playerStatus').hidden = false;
      $('playerStatus').textContent = 'Could not play this file: ' + String(err.message || err);
      log('segment play failed', { err: String(err) });
    }
    return;
  }
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

function moofStart(bytes) {
  let o = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (o + 8 <= bytes.byteLength) {
    const size = view.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (type === 'moof') return o;
    if (size < 8) break;
    o += size;
  }
  return 0;
}

function bufferedAhead(video) {
  const t = video.currentTime || 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.25 && video.buffered.end(i) > t) return video.buffered.end(i) - t;
  }
  return 0;
}

function snapPiece(t, piece) {
  if (t <= 0) return 0;
  const n = Math.floor((t + 0.001) / piece);
  return Math.round(n * piece * 1000) / 1000;
}

function bufferEndCovering(video, t) {
  for (let i = 0; i < video.buffered.length; i++) {
    const a = video.buffered.start(i);
    const b = video.buffered.end(i);
    if (a - 0.05 <= t && b > t) return b;
  }
  return null;
}

function coversTime(video, t) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) - 0.05 <= t && video.buffered.end(i) > t + 0.15) return true;
  }
  return false;
}

async function playInPieces(video, lib, item, prepared) {
  if (typeof MediaSource === 'undefined') throw new Error('this browser cannot play this file in pieces');
  piecePlay?.abort();
  const ac = new AbortController();
  piecePlay = ac;
  const signal = ac.signal;

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  video.dataset.objectUrl = objectUrl;
  video.src = objectUrl;
  await new Promise((resolve, reject) => {
    ms.addEventListener('sourceopen', resolve, { once: true });
    ms.addEventListener('error', () => reject(new Error('could not open the player')), { once: true });
  });
  if (signal.aborted) return;
  const mime = MediaSource.isTypeSupported('video/mp4; codecs="avc1.640033,mp4a.40.2"')
    ? 'video/mp4; codecs="avc1.640033,mp4a.40.2"'
    : 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
  const sb = ms.addSourceBuffer(mime);
  sb.mode = 'segments';
  const duration = Number(prepared.duration) || 0;
  if (duration) ms.duration = duration;
  const piece = isSilk() ? SILK_PIECE_SECONDS : PIECE_SECONDS;
  const ahead = piece * (isSilk() ? 2 : 3);
  let nextAt = 0;
  let busy = false;
  let haveInit = false;
  let token = 0;
  let pendingSeek = false;
  let adjusting = false;
  let failed = false;
  let lastFetched = -1;

  const waitUpdate = () =>
    new Promise((resolve, reject) => {
      const done = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        reject(new Error('player rejected a piece of this file'));
      };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', fail);
    });

  const idle = async () => {
    if (sb.updating) await waitUpdate();
  };

  const note = (text) => {
    const el = $('playerStatus');
    el.textContent = text;
    el.hidden = !text;
  };
  const clearPreparing = () => {
    const el = $('playerStatus');
    if ((el.textContent || '').startsWith('Preparing')) el.hidden = true;
  };

  const pump = async () => {
    if (signal.aborted || busy || failed || ms.readyState !== 'open' || video.error) return;
    const t = video.currentTime || 0;
    if (duration && t >= duration - 0.25 && coversTime(video, t)) {
      try {
        if (ms.readyState === 'open') ms.endOfStream();
      } catch {
        /* already ended */
      }
      return;
    }
    const jumping = pendingSeek;
    if (!jumping && haveInit && bufferedAhead(video) >= ahead && coversTime(video, t)) return;
    if (jumping) pendingSeek = false;
    let start;
    if (jumping) start = snapPiece(Math.min(t, Math.max(0, duration - 0.05)), piece);
    else if (!haveInit) start = 0;
    else {
      const end = bufferEndCovering(video, t);
      start = end == null ? snapPiece(t, piece) : snapPiece(end - 0.001, piece);
      if (end != null && start + 0.05 < end && end >= start + piece - 0.15) {
        start = Math.round((start + piece) * 1000) / 1000;
      }
    }
    if (duration && start >= duration - 0.05) return;
    if (!jumping && start === lastFetched) return;
    if (jumping) lastFetched = -1;
    lastFetched = start;
    nextAt = start;
    busy = true;
    const mine = token;
    // Only while the playhead has nothing to show. Prefetching the next
    // piece used to flash this line the whole time the movie was playing.
    const stalled = !haveInit || !coversTime(video, t) || bufferedAhead(video) < 0.35;
    if (stalled) note(haveInit ? 'Preparing the next few seconds…' : 'Preparing the first few seconds…');
    else clearPreparing();
    let showedError = false;
    try {
      const bytes = await lib.segment(item.path, start, piece);
      if (signal.aborted || mine !== token || pendingSeek || ms.readyState !== 'open') return;
      if (!bytes || bytes.byteLength < 32) throw new Error('empty piece');
      await idle();
      if (mine !== token || pendingSeek) return;
      if (jumping && video.buffered.length) {
        const removed = waitUpdate();
        sb.remove(0, 1e12);
        await removed;
        if (signal.aborted || mine !== token || ms.readyState !== 'open') return;
      }
      // The piece starts at the previous keyframe, not at `start`. Putting
      // that lead-in on the skip point replayed a few seconds and left the
      // sound on a different clock.
      const span = segmentSpan(bytes);
      const lead = span > piece ? span - piece : 0;
      const placeAt = Math.max(0, start - lead);
      const body = haveInit ? bytes.subarray(moofStart(bytes)) : bytes;
      sb.timestampOffset = placeAt;
      sb.appendWindowStart = 0;
      sb.appendWindowEnd = placeAt + (span || piece) + 0.5;
      const updated = waitUpdate();
      sb.appendBuffer(body);
      await updated;
      if (signal.aborted || mine !== token || pendingSeek) return;
      try {
        sb.appendWindowEnd = Number.POSITIVE_INFINITY;
      } catch {
        /* window is only needed while appending */
      }
      if (duration && ms.duration + 1 < duration) {
        try {
          ms.duration = duration;
        } catch {
          /* a remove or append still owns the buffer */
        }
      }
      const started = haveInit;
      haveInit = true;
      nextAt = Math.round((start + piece) * 1000) / 1000;
      if (isSilk() && t > 40 && !sb.updating) {
        const trimmed = waitUpdate();
        sb.remove(0, Math.max(0, t - 20));
        await trimmed;
      }
      if (jumping) {
        const playAt = video.currentTime || 0;
        for (let i = 0; i < video.buffered.length; i++) {
          const a = video.buffered.start(i);
          const b = video.buffered.end(i);
          if (playAt >= a && playAt < b) break;
          if (playAt < a && a - playAt < 0.75 && b > a + 0.05) {
            adjusting = true;
            video.currentTime = Math.min(a + 0.02, b - 0.02);
            adjusting = false;
            break;
          }
        }
      }
      clearPreparing();
      if ((!started || jumping) && video.paused) {
        try {
          await video.play();
        } catch {
          /* the remote can start playback */
        }
      }
    } catch (err) {
      if (signal.aborted || mine !== token || pendingSeek) return;
      failed = true;
      showedError = true;
      note('Could not play this file: ' + String(err.message || err));
      log('segment failed', { err: String(err.message || err) });
    } finally {
      busy = false;
      if (!showedError && !signal.aborted && !failed && (pendingSeek || token !== mine || bufferedAhead(video) < ahead)) {
        pump();
      }
    }
  };

  video.addEventListener('timeupdate', () => pump(), { signal });
  video.addEventListener('waiting', () => pump(), { signal });
  video.addEventListener(
    'seeking',
    () => {
      if (adjusting || signal.aborted) return;
      const t = video.currentTime || 0;
      if (coversTime(video, t)) {
        nextAt = Math.max(nextAt, snapPiece(t, piece));
        return;
      }
      // A skip that arrives while a piece is still being built used to be
      // thrown away, and the picture sat at the new time with nothing to play.
      token++;
      pendingSeek = true;
      failed = false;
      nextAt = snapPiece(t, piece);
      try {
        if (sb.updating) sb.abort();
      } catch {
        /* idle */
      }
      pump();
    },
    { signal },
  );
  await pump();
}

function closePlayer() {
  piecePlay?.abort();
  piecePlay = null;
  const video = $('video');
  video.pause();
  if (video.dataset.objectUrl) {
    URL.revokeObjectURL(video.dataset.objectUrl);
    delete video.dataset.objectUrl;
  }
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
let transportKind = 'webrtc';

function armWatchdog(source) {
  clearTimeout(connectWatchdogs.get(source.id));
  const watchdog = setTimeout(() => {
    if (!channelAlive(remotes.get(source.id))) {
      setState(
        source.id,
        'error',
        'No connection opened. On a computer or phone, both devices need the same Wi-Fi. On Fire TV, open the link that shows this computer’s address.',
      );
    }
  }, 45000);
  connectWatchdogs.set(source.id, watchdog);
  return watchdog;
}

async function beginRemote(source, dc, watchdog) {
  if (channelAlive(remotes.get(source.id)) || connectingGuard.has(source.id)) return;
  connectingGuard.add(source.id);
  setState(source.id, 'authenticating', '');
  let settled = false;
  const key = await importKey(source.key);
  const remote = new RemoteLibrary({ sourceId: source.id, key, dc, onLog: (e) => log(e.msg) });
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
      playItem(item).catch((err) => log('resume play failed: ' + String(err.message || err)));
    }
  } catch (err) {
    if (remotes.get(source.id) === remote) remotes.delete(source.id);
    try {
      dc.close();
    } catch {
      /* already closed */
    }
    clearTimeout(watchdog);
    log('handshake failed: ' + String(err.message || err));
    setState(source.id, 'error', String(err.message || err));
  } finally {
    connectingGuard.delete(source.id);
  }
}

async function connectRemote(source) {
  if (swarms.has(source.id) || remotes.has(source.id)) return;
  setState(source.id, 'connecting', '');
  const watchdog = armWatchdog(source);
  if (isSilk()) {
    const wan = new URLSearchParams(location.search).has('wan');
    const localRelay = !wan && (await relayAvailable());
    transportKind = localRelay ? 'relay' : 'public-relay';
    log(localRelay ? 'silk using relay' : 'silk using public relay');
    try {
      const dc = await connectViewerRelay(source.id, { public: !localRelay, key: await importKey(source.key) });
      await beginRemote(source, dc, watchdog);
    } catch (err) {
      log('relay failed: ' + String(err.message || err));
      setState(source.id, 'error', 'Could not reach the computer serving this page.');
    }
    return;
  }
  const swarm = new Swarm({
    sourceId: source.id,
    key: await importKey(source.key),
    trackers,
    initiator: true,
    onChannelOpen: ({ dc }) => {
      beginRemote(source, dc, watchdog);
    },
    onStatus: () => render(),
    onLog: (e) => log(e.msg),
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
    transport: () => transportKind,
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
  $('logBtn')?.addEventListener('click', () => {
    const el = $('log');
    el.hidden = !el.hidden;
    if (!el.hidden) paintLog();
  });
  if (new URLSearchParams(location.search).has('debug')) {
    $('log').hidden = false;
    paintLog();
  }
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
