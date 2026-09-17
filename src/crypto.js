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
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function generateSourceCredentials() {
  const id = randomHex(16);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  return { id, keyB64: bytesToBase64Url(raw), key };
}

export async function importKey(keyB64) {
  const raw = base64UrlToBytes(keyB64);
  if (raw.byteLength !== 32) throw new Error('encryption key must be 256 bits');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
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
