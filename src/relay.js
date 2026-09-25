// Fire OS does not resolve the *.local names Chrome puts in WebRTC, so a
// Silk viewer on the same Wi-Fi never completes ICE to the hosting computer.
// When this page was served by the local server (lan.json exists), Silk
// streams through that server. Otherwise it uses the public relay. Either
// relay only forwards AES-GCM ciphertext sealed with the share-link key.

import { openRelayPayload, sealRelayPayload } from './crypto.js';

export function isSilk(ua = globalThis.navigator?.userAgent || '') {
  return /\bSilk\//.test(String(ua));
}

export async function relayAvailable() {
  try {
    const res = await fetch(new URL('./lan.json', location.href), { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function lanInfo() {
  try {
    const res = await fetch(new URL('./lan.json', location.href), { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.host ? data : null;
  } catch {
    return null;
  }
}

function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/relay`;
}

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const PUBLIC_RELAY = 'wss://p2p-watcher-relay.typical-impala.workers.dev/relay/';

class SocketChannel {
  constructor(send, key) {
    this.readyState = 'open';
    // Fewer, larger messages so a deployed relay stays inside a free quota
    // while a movie is playing. WebRTC keeps the smaller DATA_CHUNK.
    // Small enough that sealing one piece (plain bytes, ciphertext, and the
    // base64 copy) stays modest on a Fire TV stick. The relay is Silk-only.
    this.relayChunk = 32 * 1024;
    this._send = send;
    this._key = key;
    this._listeners = {};
    this._queue = [];
    this._sendChain = Promise.resolve();
    this._recvChain = Promise.resolve();
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
    if (type === 'message' && this._queue.length) {
      const queued = this._queue;
      this._queue = [];
      for (const data of queued) fn({ data });
    }
  }

  send(data) {
    if (this.readyState !== 'open') return;
    this._sendChain = this._sendChain
      .then(async () => {
        if (this.readyState !== 'open') return;
        const sealed = await sealRelayPayload(this._key, data);
        this._send({ kind: 'bin', data: bytesToBase64(sealed) });
      })
      .catch(() => this.close());
  }

  receive(msg) {
    // A cleartext text frame is never a valid message. Only sealed blobs.
    if (msg.op === 'text' || msg.kind === 'text' || typeof msg.data !== 'string') {
      this.close();
      return;
    }
    this._recvChain = this._recvChain
      .then(async () => {
        if (this.readyState === 'closed') return;
        const data = await openRelayPayload(this._key, base64ToBytes(msg.data));
        const list = this._listeners.message;
        if (!list || !list.length) {
          this._queue.push(data);
          return;
        }
        for (const fn of list) fn({ data });
      })
      .catch(() => this.close());
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    for (const fn of this._listeners.close || []) fn();
  }
}

function socketUrl(sourceId, opts) {
  if (opts?.public) return PUBLIC_RELAY + sourceId;
  return relayUrl();
}

export function connectHostRelay(sourceId, onViewer, opts) {
  const ws = new WebSocket(socketUrl(sourceId, opts));
  const channels = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ op: 'hello', role: 'host', sourceId }));
      resolve();
    });
    ws.addEventListener('error', () => reject(new Error('relay failed')));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.op === 'join') {
      const ch = new SocketChannel((payload) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 'to-viewer', viewerId: msg.viewerId, ...payload }));
        }
      }, opts.key);
      channels.set(msg.viewerId, ch);
      onViewer(ch);
      return;
    }
    if (msg.op === 'text' || msg.op === 'bin') channels.get(msg.viewerId)?.receive(msg);
    if (msg.op === 'leave') {
      channels.get(msg.viewerId)?.close();
      channels.delete(msg.viewerId);
    }
  });
  return {
    ready,
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      for (const ch of channels.values()) ch.close();
      channels.clear();
    },
  };
}

export function connectViewerRelay(sourceId, opts) {
  const ws = new WebSocket(socketUrl(sourceId, opts));
  const ch = new SocketChannel((payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: payload.kind, data: payload.data }));
  }, opts.key);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fail(new Error('relay timeout'));
    }, 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ op: 'hello', role: 'viewer', sourceId }));
    });
    ws.addEventListener('error', () => fail(new Error('relay failed')));
    ws.addEventListener('close', () => {
      ch.close();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.op === 'ready') {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ch);
        return;
      }
      if (msg.op === 'text' || msg.op === 'bin') ch.receive(msg);
      if (msg.op === 'leave') ch.close();
    });
  });
}
