export const MAGIC = new Uint8Array([0x50, 0x57, 0x43, 0x48]); // PWCH
export const WRITE_TYPES = new Set(['write', 'delete', 'put', 'mkdir', 'move', 'unlink', 'truncate', 'rename']);
export const ALLOWED_CLIENT_TO_HOST = new Set(['auth', 'get-map', 'prepare', 'read', 'segment', 'ping', 'get-text']);
export const DEFAULT_RANGE_WINDOW = 1 * 1024 * 1024;
export const MAX_RANGE_WINDOW = 4 * 1024 * 1024;
export const DATA_CHUNK = 16 * 1024;

export function isForbiddenWrite(msg) {
  return !!(msg && typeof msg.type === 'string' && WRITE_TYPES.has(msg.type.toLowerCase()));
}

export function isAllowedClientMessage(msg) {
  return !!(msg && typeof msg.type === 'string' && ALLOWED_CLIENT_TO_HOST.has(msg.type));
}

export function encodeChunkFrame(reqId, offset, payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const buf = new Uint8Array(20 + bytes.byteLength);
  buf.set(MAGIC, 0);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(4, reqId >>> 0);
  view.setFloat64(8, offset);
  view.setUint32(16, bytes.byteLength);
  buf.set(bytes, 20);
  return buf;
}

export function decodeChunkFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < 20) return null;
  if (u8[0] !== 0x50 || u8[1] !== 0x57 || u8[2] !== 0x43 || u8[3] !== 0x48) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const reqId = view.getUint32(4);
  const offset = view.getFloat64(8);
  const len = view.getUint32(16);
  if (u8.byteLength < 20 + len) return null;
  return { reqId, offset, payload: u8.subarray(20, 20 + len) };
}

export function parseRangeHeader(h) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(h).trim());
  if (!m) return null;
  return {
    start: m[1] === '' ? null : Number(m[1]),
    end: m[2] === '' ? null : Number(m[2]),
  };
}

export function capRange(start, end, size, maxWindow = DEFAULT_RANGE_WINDOW) {
  if (!size || size < 0) size = 0;
  if (size === 0) return { start: 0, end: 0, length: 0 };
  let s = start == null ? 0 : start;
  if (!Number.isFinite(s) || s < 0) s = 0;
  if (s >= size) s = size - 1;
  let e = end == null ? Math.min(s + maxWindow - 1, size - 1) : end;
  if (!Number.isFinite(e) || e >= size) e = size - 1;
  if (e - s + 1 > maxWindow) e = s + maxWindow - 1;
  if (e < s) e = s;
  return { start: s, end: e, length: e - s + 1 };
}

export function nextReqId(n) {
  const v = ((n || 0) + 1) >>> 0;
  return v || 1;
}

export async function dispatchHostControl(msg, ctx) {
  if (!msg || typeof msg !== 'object') return { type: 'error', message: 'invalid message' };
  if (isForbiddenWrite(msg)) {
    return { type: 'error', message: 'read-only: modification of host files is prohibited' };
  }
  if (!ctx.authed) {
    if (msg.type !== 'auth') return { type: 'error', message: 'auth required', close: true };
    const ok = await ctx.verifyAuth(msg.token);
    if (!ok) return { type: 'error', message: 'auth failed', close: true };
    ctx.authed = true;
    return { type: 'auth-ok' };
  }
  if (!isAllowedClientMessage(msg)) {
    return { type: 'error', message: 'unsupported' };
  }
  switch (msg.type) {
    case 'auth':
      return { type: 'auth-ok' };
    case 'ping':
      return { type: 'pong' };
    case 'get-map':
      return { type: 'map', map: await ctx.getMap() };
    case 'prepare': {
      const prepared = await ctx.prepare(msg.path);
      return { type: 'prepared', reqId: msg.reqId, ...prepared };
    }
    case 'get-text': {
      const body = await ctx.readText(msg.path);
      return { type: 'text', reqId: msg.reqId, path: msg.path, body };
    }
    case 'read':
      return { type: 'read-go', reqId: msg.reqId, path: msg.path, start: msg.start, end: msg.end };
    case 'segment':
      return {
        type: 'segment-go',
        reqId: msg.reqId,
        path: msg.path,
        start: Number(msg.start) || 0,
        dur: Number(msg.dur) || 2,
      };
    default:
      return { type: 'error', message: 'unsupported' };
  }
}
