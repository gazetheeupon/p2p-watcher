const CHANNEL = 'p2p-watcher-stream';
const PAGE_KEY = 'p2p-watcher.page';

export function pageId() {
  let id = sessionStorage.getItem(PAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(PAGE_KEY, id);
  }
  return id;
}

// Host and viewer on the same computer share one BroadcastChannel. A seek
// must be answered only by the page whose <video> asked, or the two replies
// are stitched together and the decoder rejects the audio.
export function answersStreamAsk(msg, mine) {
  return !!(msg && msg.rpcId && msg.dir !== 'reply' && msg.page === mine);
}

export function bindStreamBridge(lookup) {
  const mine = pageId();
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = async (event) => {
    const msg = event.data;
    if (!answersStreamAsk(msg, mine)) return;
    const { type, sourceId, path, start, end, rpcId } = msg;
    const lib = lookup(sourceId);
    if (!lib) {
      ch.postMessage({ dir: 'reply', rpcId, skip: true });
      return;
    }
    try {
      if (type === 'stat') {
        const st = await lib.stat(path);
        ch.postMessage({ dir: 'reply', rpcId, ok: true, size: st.size, mime: st.mime });
        return;
      }
      if (type === 'read') {
        for await (const chunk of lib.read(path, start, end)) {
          const copy = chunk.slice();
          ch.postMessage({ dir: 'reply', rpcId, chunk: copy });
        }
        ch.postMessage({ dir: 'reply', rpcId, done: true });
      }
    } catch (err) {
      ch.postMessage({ dir: 'reply', rpcId, error: String(err.message || err) });
    }
  };
}

// A Fire TV stick has about 1 GB of RAM and Silk already uses most of it.
// 512 KB is one slice the player can hold, plus the copies made while a
// relay chunk is decoded, without crowding out the video decoder.
export const FIRE_TV_STREAM_WINDOW = 512 * 1024;

export function virtualStreamUrl(sourceId, path) {
  const base = new URL('./virtual-stream/', location.href);
  const url = new URL(encodeURIComponent(sourceId) + '/' + encodeURIComponent(path), base);
  url.searchParams.set('p', pageId());
  if (/\bSilk\//.test(navigator.userAgent)) url.searchParams.set('w', String(FIRE_TV_STREAM_WINDOW));
  return url.href;
}

export async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('service workers are required');
  const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      setTimeout(resolve, 2500);
    });
  }
  if (!navigator.serviceWorker.controller && !sessionStorage.getItem('p2p-sw-reloaded')) {
    sessionStorage.setItem('p2p-sw-reloaded', '1');
    location.reload();
    return new Promise(() => {});
  }
  return reg;
}
