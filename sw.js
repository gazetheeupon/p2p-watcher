/* p2p-watcher service worker: virtual range streaming + COOP/COEP for ffmpeg.wasm */
const STREAM_MARK = '/virtual-stream/';
const MAX_WINDOW = 4 * 1024 * 1024;
// A real .mkv/.avi remux (as opposed to the few-second test fixtures) can
// legitimately take minutes, especially when the fallback path has to
// re-encode rather than just copy streams into a new container. This used
// to be 120000 (2 minutes), which is why real-world files that took longer
// than that appeared to just "not play" with no explanation: the stat()
// RPC below timed out and the <video> element got a bare 503 with no
// further detail. Raised to something a real file has a real chance of
// finishing within; see src/session.js's matching prepare() timeout.
const STAT_TIMEOUT = 600000;
const READ_TIMEOUT = 180000;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.includes(STREAM_MARK)) {
    event.respondWith(handleStream(event.request, url));
    return;
  }
  const isWatch =
    /watch\.html$/i.test(url.pathname) || /\/watch(\/|$)/i.test(url.pathname);
  if (isWatch) return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(() => new Response('', { status: 504 })),
  );
});

function parseRange(h) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(h).trim());
  if (!m) return null;
  return { start: m[1] === '' ? null : Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
}

function capRange(start, end, size, maxWindow) {
  if (!size) return { start: 0, end: 0 };
  let s = start == null ? 0 : start;
  if (s < 0) s = 0;
  if (s >= size) s = size - 1;
  let e = end == null ? Math.min(s + maxWindow - 1, size - 1) : end;
  if (e >= size) e = size - 1;
  if (e - s + 1 > maxWindow) e = s + maxWindow - 1;
  if (e < s) e = s;
  return { start: s, end: e };
}

function streamParts(url) {
  const i = url.pathname.indexOf(STREAM_MARK);
  if (i === -1) return null;
  const rest = url.pathname.slice(i + STREAM_MARK.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  return {
    sourceId: decodeURIComponent(rest.slice(0, slash)),
    path: decodeURIComponent(rest.slice(slash + 1)),
  };
}

const STREAM_CH = 'p2p-watcher-stream';

function rpc(msg, timeout, onChunk) {
  const rpcId = crypto.randomUUID();
  const ch = new BroadcastChannel(STREAM_CH);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ch.close();
        reject(new Error('rpc timeout'));
      }
    }, timeout);
    ch.onmessage = (event) => {
      const data = event.data || {};
      if (data.dir !== 'reply' || data.rpcId !== rpcId) return;
      if (data.skip) return;
      if (onChunk) {
        if (data.error) {
          settled = true;
          clearTimeout(timer);
          ch.close();
          reject(new Error(data.error));
          return;
        }
        if (data.done) {
          settled = true;
          clearTimeout(timer);
          ch.close();
          resolve({ done: true });
          return;
        }
        if (data.chunk) onChunk(data.chunk);
        return;
      }
      settled = true;
      clearTimeout(timer);
      ch.close();
      resolve(data);
    };
    ch.postMessage({ dir: 'ask', rpcId, ...msg });
  });
}

function withCoi(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleStream(request, url) {
  const parts = streamParts(url);
  if (!parts) return withCoi(new Response('bad stream url', { status: 400 }));
  let stat;
  try {
    stat = await rpc({ type: 'stat', sourceId: parts.sourceId, path: parts.path, page: url.searchParams.get('p') || '' }, STAT_TIMEOUT);
  } catch (err) {
    return withCoi(new Response(String(err.message || err), { status: 503 }));
  }
  if (stat.error) return withCoi(new Response(stat.error, { status: 500 }));
  const size = stat.size;
  const mime = stat.mime || 'video/mp4';
  if (request.method === 'HEAD') {
    return withCoi(
      new Response(null, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      }),
    );
  }
  const range = parseRange(request.headers.get('Range'));
  const { start, end } = capRange(range?.start, range?.end, size, MAX_WINDOW);
  const length = end - start + 1;
  const page = url.searchParams.get('p') || '';
  const stream = new ReadableStream({
    start(controller) {
      let sent = 0;
      rpc(
        { type: 'read', sourceId: parts.sourceId, path: parts.path, start, end, page },
        READ_TIMEOUT,
        (chunk) => {
          if (sent >= length) return;
          let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (sent + bytes.byteLength > length) bytes = bytes.subarray(0, length - sent);
          sent += bytes.byteLength;
          controller.enqueue(bytes);
        },
      )
        .then(() => {
          if (sent !== length) controller.error(new Error('short read'));
          else controller.close();
        })
        .catch((err) => controller.error(err));
    },
  });
  const headers = {
    'Content-Type': mime,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const status = range ? 206 : 200;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return withCoi(new Response(stream, { status, headers }));
}
