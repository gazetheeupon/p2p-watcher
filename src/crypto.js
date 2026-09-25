const enc = new TextEncoder();
const dec = new TextDecoder();

export const AUTH_PLAINTEXT = 'p2p-watcher-auth-v1';

export function bytesToBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomHex(nBytes) {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  return bytesToHex(b);
}

export function hexToBytes(hex) {
  const clean = String(hex).trim().toLowerCase();
  if (clean.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(n)) throw new Error('invalid hex');
    out[i] = n;
  }
  return out;
}

export function encodeShareKey(raw) {
  return bytesToHex(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
}

export function decodeShareKey(encoded) {
  const s = String(encoded).trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return hexToBytes(s);
  return base64UrlToBytes(s);
}

export async function generateSourceCredentials() {
  const id = randomHex(16);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const keyHex = encodeShareKey(raw);
  return { id, keyHex, keyB64: keyHex, key };
}

export async function importKey(encoded) {
  const raw = decodeShareKey(encoded);
  if (raw.byteLength !== 32) throw new Error('encryption key must be 256 bits');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// One byte of type, then the message, then AES-GCM. The relay only ever
// forwards this ciphertext, so it cannot read filenames or file bytes.
export async function sealRelayPayload(key, data) {
  const body = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const plain = new Uint8Array(1 + body.byteLength);
  plain[0] = typeof data === 'string' ? 1 : 2;
  plain.set(body, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function openRelayPayload(key, sealed) {
  const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  if (bytes.byteLength < 13) throw new Error('relay payload too short');
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  if (plain[0] === 1) return dec.decode(plain.subarray(1));
  if (plain[0] === 2) return plain.subarray(1).slice();
  throw new Error('relay payload type');
}

export async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return bytesToBase64Url(iv) + '.' + bytesToBase64Url(new Uint8Array(ct));
}

export async function decryptJson(key, packed) {
  const [ivB, ctB] = String(packed).split('.');
  if (!ivB || !ctB) throw new Error('malformed ciphertext');
  const iv = base64UrlToBytes(ivB);
  const ct = base64UrlToBytes(ctB);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt));
}

export async function encryptSdp(key, desc) {
  return 'p2p1.' + (await encryptJson(key, { type: desc.type, sdp: desc.sdp }));
}

export async function decryptSdp(key, sdpField) {
  const packed = String(sdpField).startsWith('p2p1.') ? sdpField.slice(5) : sdpField;
  const obj = await decryptJson(key, packed);
  if (!obj || (obj.type !== 'offer' && obj.type !== 'answer') || typeof obj.sdp !== 'string') {
    throw new Error('invalid SDP payload');
  }
  return obj;
}

export async function trackerInfoHash(sourceId) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode('p2p-watcher:' + sourceId));
  return new Uint8Array(digest).slice(0, 20);
}

export function bytesToBinaryString(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

export function binaryStringToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function bytesToHex(bytes) {
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function randomPeerId() {
  return crypto.getRandomValues(new Uint8Array(20));
}

export async function makeAuthToken(key) {
  return encryptJson(key, { v: AUTH_PLAINTEXT, t: Date.now() });
}

export async function verifyAuthToken(key, token) {
  const obj = await decryptJson(key, token);
  return obj && obj.v === AUTH_PLAINTEXT;
}
