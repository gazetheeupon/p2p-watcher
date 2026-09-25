import { makeAuthToken, verifyAuthToken } from './crypto.js';
import {
  encodeChunkFrame,
  decodeChunkFrame,
  dispatchHostControl,
  DATA_CHUNK,
  nextReqId,
} from './protocol.js';
import { mimeOf, needsTranscode, streamMime } from './vfs.js';
import { srtToVtt, attachEmbeddedSubtitle } from './subtitles.js';
import { remuxToFragmentedMp4, probeMediaDuration, remuxSegment, LARGE_REMUX_BYTES } from './transcode.js?v=seek1';

function sendJson(dc, obj) {
  if (dc.readyState === 'open') dc.send(JSON.stringify(obj));
}

function messageAsText(data) {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  } catch {
    /* ignore */
  }
  return null;
}

function isChunkBytes(data) {
  const u8 = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  return !!(u8 && u8.byteLength >= 4 && u8[0] === 0x50 && u8[1] === 0x57 && u8[2] === 0x43 && u8[3] === 0x48);
}

async function waitBuffered(dc) {
  while (dc.readyState === 'open' && dc.bufferedAmount > 1_500_000) {
    await new Promise((r) => {
      const t = setTimeout(r, 40);
      dc.addEventListener(
        'bufferedamountlow',
        () => {
          clearTimeout(t);
          r();
        },
        { once: true },
      );
    });
  }
}

async function sendBlobRange(dc, reqId, blob, start, end) {
  const slice = blob.slice(start, end + 1);
  const buf = new Uint8Array(await slice.arrayBuffer());
  const chunkSize = dc.relayChunk || DATA_CHUNK;
  let offset = start;
  for (let i = 0; i < buf.length; i += chunkSize) {
    const piece = buf.subarray(i, Math.min(i + chunkSize, buf.length));
    await waitBuffered(dc);
    if (dc.readyState !== 'open') throw new Error('channel closed');
    dc.send(encodeChunkFrame(reqId, offset, piece));
    offset += piece.length;
  }
  sendJson(dc, { type: 'read-end', reqId });
}

export function channelAlive(lib) {
  if (!lib || lib.dead) return false;
  const st = lib.dc?.readyState;
  return st === 'open' || st === 'connecting';
}

export class HostLibrary {
  constructor({ sourceId, key, fileMap, map, onTranscode, onLog }) {
    this.sourceId = sourceId;
    this.key = key;
    this.fileMap = fileMap;
    this.map = map;
    this.onTranscode = onTranscode || (() => {});
    this.onLog = onLog || (() => {});
    this.remuxCache = new Map();
    this.segmentCache = new Map();
    this.embeddedSubs = new Map();
    this.channels = new Set();
  }

  attachChannel(dc) {
    const ctx = {
      authed: false,
      verifyAuth: (token) => verifyAuthToken(this.key, token),
      getMap: () => this.publicMap(),
      prepare: (path) => this.prepare(path),
      readText: (path) => this.readText(path),
    };
    this.channels.add(dc);
    dc.addEventListener('close', () => this.channels.delete(dc));
    dc.addEventListener('message', async (ev) => {
      const text = messageAsText(ev.data);
      if (text == null) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      try {
        const reply = await dispatchHostControl(msg, ctx);
        if (msg.reqId != null && reply.reqId == null) reply.reqId = msg.reqId;
        if (reply.close) {
          sendJson(dc, reply);
          dc.close();
          return;
        }
        if (reply.type === 'read-go') {
          const blob = await this.blobFor(reply.path);
          await sendBlobRange(dc, reply.reqId, blob, reply.start, reply.end);
          return;
        }
        if (reply.type === 'segment-go') {
          const bytes = await this.segmentBytes(reply.path, reply.start, reply.dur);
          await sendBlobRange(dc, reply.reqId, new Blob([bytes]), 0, bytes.byteLength - 1);
          return;
        }
        sendJson(dc, reply);
      } catch (err) {
        sendJson(dc, { type: 'error', reqId: msg.reqId, message: String(err.message || err) });
      }
    });
  }

  publicMap() {
    const files = this.map.files.map((f) => {
      const remuxed = this.remuxCache.get(f.path);
      if (remuxed) {
        return { ...f, size: remuxed.size, mime: remuxed.type, transcode: false };
      }
      if (f.transcode) return { ...f, mime: streamMime(f.path, f.mime) };
      return f;
    });
    return { ...this.map, files };
  }

  fileEntry(path) {
    return this.map.files.find((f) => f.path === path) || null;
  }

  async prepare(path) {
    const file = this.fileMap.get(path);
    if (!file) throw new Error('not found: ' + path);
    if (needsTranscode(path, mimeOf(file))) {
      const forceSegments = new URLSearchParams(location.search).has('seg');
      if (forceSegments || file.size > LARGE_REMUX_BYTES) {
        const emit = (ev) => {
          this.onTranscode(ev);
          this.broadcastTranscode(ev);
        };
        emit({ path, state: 'start' });
        try {
          const duration = await probeMediaDuration(file);
          emit({ path, state: 'done', size: file.size });
          return {
            path,
            size: file.size,
            mime: 'video/mp4',
            segmented: true,
            duration,
            subtitles: [],
          };
        } catch (err) {
          emit({ path, state: 'error', message: String(err.message || err) });
          throw err;
        }
      }
      const blob = await this.ensureRemux(path);
      return { path, size: blob.size, mime: blob.type, subtitles: this.fileEntry(path)?.subtitles || [] };
    }
    return { path, size: file.size, mime: mimeOf(file), subtitles: this.fileEntry(path)?.subtitles || [] };
  }

  async ensureRemux(path) {
    if (this.remuxCache.has(path)) return this.remuxCache.get(path);
    const file = this.fileMap.get(path);
    if (!file) throw new Error('not found: ' + path);
    const emit = (ev) => {
      this.onTranscode(ev);
      this.broadcastTranscode(ev);
    };
    emit({ path, state: 'start' });
    try {
      const { blob, vtt } = await remuxToFragmentedMp4(file, (ratio) => emit({ path, state: 'progress', ratio }));
      this.remuxCache.set(path, blob);
      const entry = this.fileEntry(path);
      const subPath = attachEmbeddedSubtitle(entry, vtt);
      if (subPath) this.embeddedSubs.set(subPath, vtt);
      emit({ path, state: 'done', size: blob.size });
      return blob;
    } catch (err) {
      emit({ path, state: 'error', message: String(err.message || err) });
      throw err;
    }
  }

  // Pushes an unsolicited status message to every connected client so a
  // viewer waiting on a slow remux (a full-length .mkv/.avi can take much
  // longer than the test fixtures ever did) sees real progress instead of a
  // silent spinner. Best-effort: a channel that isn't open yet just drops it.
  broadcastTranscode(ev) {
    for (const dc of this.channels) {
      if (dc.readyState === 'open') sendJson(dc, { type: 'transcode-progress', ...ev });
    }
  }

  async segmentBytes(path, start, dur) {
    const key = path + ':' + start + ':' + dur;
    const cached = this.segmentCache.get(key);
    if (cached) return cached;
    const file = this.fileMap.get(path);
    if (!file) throw new Error('not found: ' + path);
    const bytes = await remuxSegment(file, start, dur);
    this.segmentCache.set(key, bytes);
    if (this.segmentCache.size > 4) this.segmentCache.delete(this.segmentCache.keys().next().value);
    return bytes;
  }

  async blobFor(path) {
    const file = this.fileMap.get(path);
    if (!file) throw new Error('not found: ' + path);
    if (needsTranscode(path, mimeOf(file))) return this.ensureRemux(path);
    return this.remuxCache.get(path) || file;
  }

  async stat(path) {
    const prepared = await this.prepare(path);
    return prepared;
  }

  async *read(path, start, end) {
    const blob = await this.blobFor(path);
    const slice = blob.slice(start, end + 1);
    const buf = new Uint8Array(await slice.arrayBuffer());
    const CHUNK = 64 * 1024;
    for (let i = 0; i < buf.length; i += CHUNK) {
      yield buf.subarray(i, Math.min(i + CHUNK, buf.length));
    }
  }

  async readText(path) {
    if (this.embeddedSubs.has(path)) return this.embeddedSubs.get(path);
    const file = this.fileMap.get(path);
    if (!file) throw new Error('not found: ' + path);
    const raw = await file.text();
    if (/\.srt$/i.test(path)) return srtToVtt(raw);
    return raw;
  }
}

export class RemoteLibrary {
  constructor({ sourceId, key, dc, onLog }) {
    this.sourceId = sourceId;
    this.key = key;
    this.dc = dc;
    this.onLog = onLog || (() => {});
    this.map = null;
    this.dead = false;
    this.onDead = null;
    this.onTranscodeProgress = null;
    this._req = 1;
    this._pending = new Map();
    this._chunks = new Map();
    dc.addEventListener('message', (ev) => this._onMessage(ev));
    this._ready = this._waitOpen().then(() => this._handshake());
    dc.addEventListener('close', () => {
      this.dead = true;
      for (const [, p] of this._pending) p.reject(new Error('channel closed'));
      this._pending.clear();
      for (const [, w] of this._chunks) w.fail?.(new Error('channel closed'));
      this._chunks.clear();
      this.onDead?.();
    });
  }

  waitReady() {
    return this._ready;
  }

  _waitOpen() {
    if (this.dc.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('data channel open timeout')), 20000);
      this.dc.addEventListener(
        'open',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
      this.dc.addEventListener(
        'error',
        () => {
          clearTimeout(t);
          reject(new Error('data channel error'));
        },
        { once: true },
      );
    });
  }

  async _handshake() {
    const token = await makeAuthToken(this.key);
    const ok = this._waitType('auth-ok');
    sendJson(this.dc, { type: 'auth', token });
    await ok;
    this.map = (await this.rpc({ type: 'get-map' })).map;
    return this.map;
  }

  _waitType(type, ms = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for ' + type)), ms);
      const id = 'type:' + type + ':' + nextReqId(this._req++);
      this._pending.set(id, {
        match: (msg) => msg && msg.type === type,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  rpc(msg, ms = 60000) {
    const reqId = nextReqId(this._req++);
    const payload = { ...msg, reqId };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error('rpc timeout: ' + msg.type));
      }, ms);
      this._pending.set(reqId, {
        match: (m) => m && m.reqId === reqId,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      sendJson(this.dc, payload);
    });
  }

  _onMessage(ev) {
    const data = ev.data;
    // binaryType defaults to "blob", and Silk can refuse the switch to
    // arraybuffer. A Blob is neither a string nor an ArrayBuffer, so without
    // this the video bytes are dropped and the player never starts.
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buf) => this._onMessage({ data: buf }))
        .catch(() => {});
      return;
    }
    if (typeof data !== 'string' && isChunkBytes(data)) {
      const frame = decodeChunkFrame(data);
      if (!frame) return;
      const waiter = this._chunks.get(frame.reqId);
      waiter?.push(frame.payload);
      return;
    }
    const text = messageAsText(ev.data);
    if (text == null) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'transcode-progress') {
      this.onTranscodeProgress?.(msg);
      return;
    }
    if (msg.type === 'read-end') {
      this._chunks.get(msg.reqId)?.end();
      return;
    }
    if (msg.type === 'error') {
      const waiter = this._chunks.get(msg.reqId);
      if (waiter) waiter.fail(new Error(msg.message || 'error'));
    }
    for (const [id, p] of this._pending) {
      if (p.match(msg)) {
        this._pending.delete(id);
        if (msg.type === 'error') p.reject(new Error(msg.message || 'error'));
        else p.resolve(msg);
        return;
      }
    }
  }

  async prepare(path) {
    // A real .mkv/.avi can take far longer to remux than the tiny test
    // fixtures — give this the same generous ceiling as the service
    // worker's own stat timeout (sw.js STAT_TIMEOUT) rather than the
    // default 60s used by every other (near-instant) RPC.
    return this.rpc({ type: 'prepare', path }, 600000);
  }

  async segment(path, start, dur) {
    const reqId = nextReqId(this._req++);
    const queue = [];
    let notify;
    const waiter = {
      push(c) {
        queue.push(c);
        notify?.();
      },
      end() {
        waiter.done = true;
        notify?.();
      },
      fail(err) {
        waiter.err = err;
        notify?.();
      },
    };
    this._chunks.set(reqId, waiter);
    sendJson(this.dc, { type: 'segment', reqId, path, start, dur });
    const parts = [];
    try {
      while (true) {
        if (waiter.err) throw waiter.err;
        if (queue.length) {
          parts.push(queue.shift());
          continue;
        }
        if (waiter.done) break;
        await new Promise((r) => {
          notify = r;
        });
      }
    } finally {
      this._chunks.delete(reqId);
    }
    let len = 0;
    for (const p of parts) len += p.byteLength;
    const out = new Uint8Array(len);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  }

  async stat(path) {
    const prepared = await this.prepare(path);
    return { size: prepared.size, mime: prepared.mime, path };
  }

  async *read(path, start, end) {
    const reqId = nextReqId(this._req++);
    const queue = [];
    let notify;
    const waiter = {
      push(c) {
        queue.push(c);
        notify?.();
      },
      end() {
        waiter.done = true;
        notify?.();
      },
      fail(err) {
        waiter.err = err;
        notify?.();
      },
    };
    this._chunks.set(reqId, waiter);
    sendJson(this.dc, { type: 'read', reqId, path, start, end });
    try {
      while (true) {
        if (waiter.err) throw waiter.err;
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (waiter.done) return;
        await new Promise((r) => {
          notify = r;
        });
      }
    } finally {
      this._chunks.delete(reqId);
    }
  }

  async readText(path) {
    const res = await this.rpc({ type: 'get-text', path });
    return res.body;
  }
}
