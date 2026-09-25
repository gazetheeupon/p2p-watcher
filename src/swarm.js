import {
  encryptSdp,
  decryptSdp,
  trackerInfoHash,
  bytesToBinaryString,
  bytesToHex,
  randomPeerId,
} from './crypto.js';

export const DEFAULT_TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
];

function rtcConfig() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const turn = typeof location !== 'undefined' && new URLSearchParams(location.search).get('turn');
  if (turn) {
    const [urls, username, credential] = turn.split('|');
    if (urls) iceServers.push({ urls: urls.split(','), username: username || '', credential: credential || '' });
  }
  return { iceServers, iceCandidatePoolSize: 4 };
}

const OFFER_COUNT = 2;
const ICE_WAIT_MS = 6000;
const OFFER_TTL_MS = 60000;
const DC_OPTS = { negotiated: true, id: 0, ordered: true };

export function stripMdnsCandidates(sdp) {
  return String(sdp || '')
    .split(/\r?\n/)
    .filter((line) => {
      if (!/^a=candidate:/i.test(line)) return true;
      return !/\.local\b/i.test(line);
    })
    .join('\r\n');
}

// Chrome publishes LAN addresses as mDNS names (*.local) instead of 192.168.x.x.
// Those names are what makes two of your own devices on the same network able to
// connect. Removing them leaves only the public STUN address, and home routers
// usually cannot hairpin that back onto the LAN, so nothing connects.
// ?nomdns=1 still strips them for a Fire TV experiment: Silk often cannot
// resolve *.local, but stripping is opt-in because it breaks every other device.
export function summarizeCandidates(sdp) {
  const counts = { host: 0, mdns: 0, srflx: 0, relay: 0 };
  for (const line of String(sdp || '').split(/\r?\n/)) {
    if (!/^a=candidate:/i.test(line)) continue;
    if (/\.local\b/i.test(line)) counts.mdns++;
    else if (/ typ host\b/i.test(line)) counts.host++;
    else if (/ typ srflx\b/i.test(line)) counts.srflx++;
    else if (/ typ relay\b/i.test(line)) counts.relay++;
  }
  return counts;
}

export function formatCandidates(sdp) {
  const c = summarizeCandidates(sdp);
  return `mdns ${c.mdns}, host ${c.host}, public ${c.srflx}, relay ${c.relay}`;
}

function trackerLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

export function sdpForPeer(sdp, loc = globalThis.location) {
  const text = String(sdp || '');
  try {
    const q = new URLSearchParams(String(loc?.search || '').replace(/^\?/, ''));
    if (q.has('nomdns')) return stripMdnsCandidates(text);
  } catch {
    /* no location in unit tests */
  }
  return text;
}

function openChannel(pc) {
  return pc.createDataChannel('p2p-watcher', DC_OPTS);
}

export function trackerListFromLocation(loc = globalThis.location) {
  const q = new URLSearchParams(loc.search).get('trackers');
  if (q) return q.split(',').map((s) => s.trim()).filter(Boolean);
  if (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost') {
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    return [`${proto}://${loc.host}/announce`];
  }
  return [...DEFAULT_TRACKERS];
}

function waitForUsefulIce(pc, ms = ICE_WAIT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let usefulTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hard);
      clearTimeout(usefulTimer);
      pc.removeEventListener('icecandidate', onCand);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    };
    const hard = setTimeout(finish, ms);
    const onCand = (e) => {
      if (!e.candidate) {
        finish();
        return;
      }
      const c = e.candidate.candidate || '';
      if (/\.local\b/i.test(c)) return;
      if (/ typ (host|srflx|relay)/i.test(c)) {
        clearTimeout(usefulTimer);
        usefulTimer = setTimeout(finish, 700);
      }
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icecandidate', onCand);
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

export class Swarm {
  constructor({ sourceId, key, trackers, initiator = false, onDataChannel, onChannelOpen, onStatus, onLog }) {
    this.sourceId = sourceId;
    this.key = key;
    this.trackers = trackers || trackerListFromLocation();
    this.initiator = initiator;
    this.onDataChannel = onDataChannel || (() => {});
    this.onChannelOpen = onChannelOpen || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});
    this.peerId = randomPeerId();
    this.peerIdHex = bytesToHex(this.peerId);
    this.peerIdBin = bytesToBinaryString(this.peerId);
    this.sockets = new Map();
    this.pendingOffers = new Map();
    this.peers = new Map();
    this.destroyed = false;
    this.infoHash = null;
    this.infoHashBin = null;
    this._timer = null;
    this._offerTimers = new Set();
    this._onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      this.announce().catch(() => {});
    };
  }

  log(msg) {
    const text = String(msg || '');
    if (!text || text === this._lastLog) return;
    this._lastLog = text;
    this.onLog({ sourceId: this.sourceId, msg: text, t: Date.now() });
  }

  // Viewers with an open channel. Half-open offers and failed peer connections
  // are not viewers — counting those is what made the host number climb.
  watching() {
    for (const [key, rec] of [...this.peers]) {
      const dc = rec?.dc;
      const pcState = rec?.pc?.connectionState;
      if (!dc || dc.readyState === 'closed' || dc.readyState === 'closing' || pcState === 'failed' || pcState === 'closed') {
        this.peers.delete(key);
      }
    }
    const seen = new Set();
    for (const rec of this.peers.values()) {
      if (rec.dc?.readyState === 'open' && !seen.has(rec.dc)) seen.add(rec.dc);
    }
    return seen.size;
  }

  async start() {
    this.infoHash = await trackerInfoHash(this.sourceId);
    this.infoHashBin = bytesToBinaryString(this.infoHash);
    try {
      this.bc = new BroadcastChannel('p2p-watcher:' + this.sourceId);
      this.bc.onmessage = (e) => this._onBroadcast(e.data);
    } catch {
      this.bc = null;
    }
    for (const url of this.trackers) this._connectTracker(url);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('pageshow', this._onVis);
    await this.announce('started');
    this._timer = setInterval(() => this.announce().catch(() => {}), 30000);
    if (this.initiator) {
      this._hunt = setInterval(() => {
        const open = [...this.peers.values()].some((p) => p.dc && p.dc.readyState === 'open');
        if (!open) this.announce().catch(() => {});
      }, 8000);
    }
    this.onStatus({ state: 'announcing', peers: this.watching() });
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._timer);
    clearInterval(this._hunt);
    clearTimeout(this._reconnectTimer);
    for (const t of this._offerTimers) clearTimeout(t);
    this._offerTimers.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    if (typeof window !== 'undefined') window.removeEventListener('pageshow', this._onVis);
    try {
      this.bc?.close();
    } catch {
      /* ignore */
    }
    for (const [, ws] of this.sockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    for (const [, pending] of this.pendingOffers) {
      try {
        pending.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.pendingOffers.clear();
    for (const [, peer] of this.peers) {
      try {
        peer.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
  }

  _connectTracker(url) {
    let tries = 0;
    const open = () => {
      if (this.destroyed) return;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this.log('tracker failed: ' + trackerLabel(url));
        return;
      }
      this.sockets.set(url, ws);
      ws.addEventListener('open', () => {
        tries = 0;
        this._loggedUp = this._loggedUp || new Set();
        if (!this._loggedUp.has(url)) {
          this._loggedUp.add(url);
          this.log('tracker up: ' + trackerLabel(url));
        }
        this.announce().catch(() => {});
      });
      ws.addEventListener('message', (ev) => {
        try {
          const data = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
          this._onTrackerMessage(data, url);
        } catch {
          /* ignore */
        }
      });
      ws.addEventListener('close', () => {
        if (this.destroyed) return;
        this._loggedDown = this._loggedDown || new Set();
        if (!this._loggedDown.has(url)) {
          this._loggedDown.add(url);
          this.log('tracker down: ' + trackerLabel(url));
        }
        const delay = Math.min(30000, 1000 * 2 ** Math.min(tries++, 5));
        setTimeout(open, delay);
      });
      ws.addEventListener('error', () => {
        /* close handler reconnects */
      });
    };
    open();
  }

  async announce(event) {
    if (this.destroyed || !this.infoHashBin) return;
    const offers = this.initiator ? await this._generateOffers(OFFER_COUNT) : [];
    const params = {
      action: 'announce',
      info_hash: this.infoHashBin,
      peer_id: this.peerIdBin,
      numwant: OFFER_COUNT,
      uploaded: 0,
      downloaded: 0,
      left: 0,
      offers,
    };
    if (event) params.event = event;
    const json = JSON.stringify(params);
    for (const [, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
    if (this.bc) {
      for (const off of offers) {
        this.bc.postMessage({
          kind: 'offer',
          from: this.peerIdHex,
          offer_id: bytesToHex(binaryish(off.offer_id)),
          offer: off.offer,
        });
      }
    }
  }

  async _generateOffers(n) {
    const offers = [];
    for (let i = 0; i < n; i++) {
      const offerIdBytes = crypto.getRandomValues(new Uint8Array(20));
      const offerIdHex = bytesToHex(offerIdBytes);
      const pc = new RTCPeerConnection(rtcConfig());
      const dc = openChannel(pc);
      this._wirePc(offerIdHex, pc, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForUsefulIce(pc);
      const localSdp = sdpForPeer(pc.localDescription.sdp);
      this.log('sent offer: ' + formatCandidates(localSdp));
      const packed = await encryptSdp(this.key, {
        type: pc.localDescription.type,
        sdp: localSdp,
      });
      this.pendingOffers.set(offerIdHex, { pc, dc, createdAt: Date.now() });
      const offerTimer = setTimeout(() => {
        this._offerTimers.delete(offerTimer);
        if (this.destroyed) return;
        const pending = this.pendingOffers.get(offerIdHex);
        if (pending) {
          this.pendingOffers.delete(offerIdHex);
          try {
            pending.pc.close();
          } catch {
            /* ignore */
          }
        }
        const rec = this.peers.get(offerIdHex);
        if (rec && rec.dc && rec.dc.readyState !== 'open') {
          this.peers.delete(offerIdHex);
          const n = this.watching();
          this.onStatus({ state: n ? 'connected' : 'announcing', peers: n });
        }
      }, OFFER_TTL_MS);
      this._offerTimers.add(offerTimer);
      offers.push({
        offer_id: bytesToBinaryString(offerIdBytes),
        offer: { type: 'offer', sdp: packed },
      });
    }
    return offers;
  }

  _wirePc(id, pc, dc) {
    pc.addEventListener('connectionstatechange', () => {
      // `disconnected` is a transient ICE blip. Treating it as a dead
      // connection made every blip send fresh offers, and each of those was
      // counted as another viewer, so the host number climbed forever.
      if (pc.connectionState === 'failed') {
        this.log('connection failed');
        this._scheduleReconnect();
      }
    });
    this._attachDc(id, pc, dc || openChannel(pc));
  }

  _attachDc(id, pc, dc) {
    if (dc._p2pAttached) return;
    dc._p2pAttached = true;
    // Separate tries: Silk throws on one of these before the channel is open,
    // and a single try used to skip binaryType as well. Without arraybuffer,
    // video chunks arrive as Blobs and the viewer drops them.
    try {
      dc.binaryType = 'arraybuffer';
    } catch {
      /* Silk may reject this before open */
    }
    try {
      dc.bufferedAmountLowThreshold = 256 * 1024;
    } catch {
      /* Silk may reject this before open */
    }
    this.peers.set(id, { pc, dc });
    this.onDataChannel({ peerId: id, pc, dc });
    const onOpen = () => {
      if (this.destroyed) return;
      dc._p2pOpened = true;
      this.log('channel open');
      const n = this.watching();
      this.onStatus({ state: n ? 'connected' : 'announcing', peers: n });
      this.onChannelOpen({ peerId: id, pc, dc });
    };
    if (dc.readyState === 'open') onOpen();
    else dc.addEventListener('open', onOpen, { once: true });
    dc.addEventListener('close', () => {
      // The entry may have been re-keyed from the offer id to the peer id.
      for (const [key, rec] of this.peers) {
        if (rec.dc === dc) this.peers.delete(key);
      }
      if (dc._p2pOpened) this.log('channel closed');
      const n = this.watching();
      this.onStatus({ state: n ? 'connected' : 'announcing', peers: n });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.destroyed || this.watching() > 0) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this.destroyed || this.watching() > 0) return;
      this.announce().catch(() => {});
    }, 1500);
  }

  async _onTrackerMessage(data) {
    try {
      if (!data || data.action !== 'announce') return;
      if (data.info_hash && data.info_hash !== this.infoHashBin) return;
      if (data.peer_id && data.peer_id === this.peerIdBin) return;
      // Only the host answers offers. A viewer that answers too will connect
      // to the other viewer, handshake with nobody who has the files, and
      // then stop trying the host.
      if (!this.initiator && data.offer && data.peer_id) {
        await this._onRemoteOffer({
          peerIdBin: data.peer_id,
          peerIdHex: bytesToHex(binaryish(data.peer_id)),
          offer: data.offer,
          offerId: data.offer_id,
        });
      }
      if (data.answer && data.peer_id) {
        await this._onRemoteAnswer({
          peerIdHex: bytesToHex(binaryish(data.peer_id)),
          answer: data.answer,
          offerIdHex: bytesToHex(binaryish(data.offer_id)),
        });
      }
    } catch (err) {
      this.log('signaling error: ' + String(err && err.message ? err.message : err));
    }
  }

  async _onBroadcast(data) {
    if (!data || data.from === this.peerIdHex) return;
    if (!this.initiator && data.kind === 'offer') {
      await this._onRemoteOffer({
        peerIdHex: data.from,
        peerIdBin: hexToBinaryString(data.from),
        offer: data.offer,
        offerId: hexToBinaryString(data.offer_id),
      });
    } else if (data.kind === 'answer' && data.to === this.peerIdHex) {
      await this._onRemoteAnswer({
        peerIdHex: data.from,
        answer: data.answer,
        offerIdHex: data.offer_id,
      });
    }
  }

  async _onRemoteOffer({ peerIdHex, peerIdBin, offer, offerId }) {
    const existing = this.peers.get(peerIdHex);
    if (existing?.dc?.readyState === 'open') return;
    if (existing) {
      try {
        existing.pc.close();
      } catch {
        /* ignore */
      }
      this.peers.delete(peerIdHex);
    }
    let desc;
    try {
      desc = await decryptSdp(this.key, offer.sdp);
      desc.sdp = sdpForPeer(desc.sdp);
      this.log('got offer: ' + formatCandidates(desc.sdp));
    } catch {
      this.log('could not decrypt offer');
      return;
    }
    const pc = new RTCPeerConnection(rtcConfig());
    const dc = openChannel(pc);
    this._wirePc(peerIdHex, pc, dc);
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForUsefulIce(pc);
    const localSdp = sdpForPeer(pc.localDescription.sdp);
    this.log('sent answer: ' + formatCandidates(localSdp));
    const packed = await encryptSdp(this.key, {
      type: pc.localDescription.type,
      sdp: localSdp,
    });
    const payload = {
      action: 'announce',
      info_hash: this.infoHashBin,
      peer_id: this.peerIdBin,
      to_peer_id: peerIdBin,
      offer_id: offerId,
      answer: { type: 'answer', sdp: packed },
    };
    const json = JSON.stringify(payload);
    for (const [, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
    if (this.bc) {
      this.bc.postMessage({
        kind: 'answer',
        from: this.peerIdHex,
        to: peerIdHex,
        offer_id: typeof offerId === 'string' && /^[0-9a-f]+$/i.test(offerId) ? offerId : bytesToHex(binaryish(offerId)),
        answer: { type: 'answer', sdp: packed },
      });
    }
  }

  async _onRemoteAnswer({ peerIdHex, answer, offerIdHex }) {
    const pending = this.pendingOffers.get(offerIdHex);
    if (!pending) return;
    let desc;
    try {
      desc = await decryptSdp(this.key, answer.sdp);
      desc.sdp = sdpForPeer(desc.sdp);
      this.log('got answer: ' + formatCandidates(desc.sdp));
    } catch {
      this.log('could not decrypt answer');
      return;
    }
    this.pendingOffers.delete(offerIdHex);
    await pending.pc.setRemoteDescription(desc);
    // One connection was stored under the random offer id when the offer was
    // created. Re-key it to the real peer id so the count is not doubled and
    // so closing the channel removes the entry the UI is actually showing.
    const speculative = this.peers.get(offerIdHex);
    if (speculative && speculative.dc === pending.dc) this.peers.delete(offerIdHex);
    const displaced = this.peers.get(peerIdHex);
    if (displaced && displaced.dc !== pending.dc) {
      this.peers.delete(peerIdHex);
      try {
        displaced.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.set(peerIdHex, { pc: pending.pc, dc: pending.dc });
  }
}

function binaryish(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }
  return new Uint8Array(0);
}

function hexToBinaryString(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytesToBinaryString(out);
}
