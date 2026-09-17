const CHANNEL = 'p2p-watcher-stream';

export function bindStreamBridge(lookup) {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || !msg.rpcId || msg.dir === 'reply') return;
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

export function virtualStreamUrl(sourceId, path) {
  const base = new URL('./virtual-stream/', location.href);
  return new URL(encodeURIComponent(sourceId) + '/' + encodeURIComponent(path), base).href;
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
