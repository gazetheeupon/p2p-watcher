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
const ICE_WAIT_MS = 8000;
const OFFER_TTL_MS = 60000;

export function trackerListFromLocation(loc = globalThis.location) {
  const q = new URLSearchParams(loc.search).get('trackers');
  if (q) return q.split(',').map((s) => s.trim()).filter(Boolean);
  if (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost') {
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    return [`${proto}://${loc.host}/announce`];
  }
  return [...DEFAULT_TRACKERS];
}

function waitIceComplete(pc, ms = ICE_WAIT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
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
    this._onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      this.announce().catch(() => {});
    };
  }

  log(msg, extra) {
    this.onLog({ sourceId: this.sourceId, msg, extra, t: Date.now() });
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
    this.onStatus({ state: 'announcing', peers: 0 });
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._timer);
    clearInterval(this._hunt);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('pageshow', this._onVis);
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
        this.log('tracker url failed', { url, err: String(err) });
        return;
      }
      this.sockets.set(url, ws);
      ws.addEventListener('open', () => {
        tries = 0;
        this.log('tracker connected', { url });
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
        this.log('tracker closed', { url });
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
      const dc = pc.createDataChannel('p2p-watcher', { ordered: true });
      this._wirePc(offerIdHex, pc, dc, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
      const packed = await encryptSdp(this.key, pc.localDescription);
      this.pendingOffers.set(offerIdHex, { pc, dc, createdAt: Date.now() });
      setTimeout(() => {
        const pending = this.pendingOffers.get(offerIdHex);
        if (pending) {
          this.pendingOffers.delete(offerIdHex);
          try {
            pending.pc.close();
          } catch {
            /* ignore */
          }
        }
      }, OFFER_TTL_MS);
      offers.push({
        offer_id: bytesToBinaryString(offerIdBytes),
        offer: { type: 'offer', sdp: packed },
      });
    }
    return offers;
  }

  _wirePc(id, pc, dc, initiator) {
    pc.addEventListener('connectionstatechange', () => {
      this.log('pc state', { id, state: pc.connectionState, initiator });
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._scheduleReconnect();
      }
    });
    if (dc) this._attachDc(id, pc, dc);
    else {
      pc.addEventListener('datachannel', (ev) => this._attachDc(id, pc, ev.channel));
    }
  }

  _attachDc(id, pc, dc) {
    if (dc._p2pAttached) return;
    dc._p2pAttached = true;
    try {
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 256 * 1024;
    } catch {
      /* Silk may reject these before open */
    }
    this.peers.set(id, { pc, dc });
    this.onDataChannel({ peerId: id, pc, dc });
    const onOpen = () => {
      if (this.destroyed) return;
      this.log('datachannel open', { id, label: dc.label });
      this.onStatus({ state: 'connected', peers: this.peers.size });
      this.onChannelOpen({ peerId: id, pc, dc });
    };
    if (dc.readyState === 'open') onOpen();
    else dc.addEventListener('open', onOpen, { once: true });
    dc.addEventListener('close', () => {
      this.peers.delete(id);
      this.onStatus({ state: this.peers.size ? 'connected' : 'announcing', peers: this.peers.size });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.destroyed) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.announce().catch(() => {}), 1500);
  }

  async _onTrackerMessage(data) {
    if (!data || data.action !== 'announce') return;
    if (data.info_hash && data.info_hash !== this.infoHashBin) return;
    if (data.peer_id && data.peer_id === this.peerIdBin) return;
    if (data.offer && data.peer_id) {
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
  }

  async _onBroadcast(data) {
    if (!data || data.from === this.peerIdHex) return;
    if (data.kind === 'offer') {
      await this._onRemoteOffer({
        peerIdHex: data.from,
        peerIdBin: hexToBinaryString(data.from),
        offer: data.offer,
        offerId: hexToBinaryString(data.offer_id),
        via: 'broadcast',
      });
    } else if (data.kind === 'answer' && data.to === this.peerIdHex) {
      await this._onRemoteAnswer({
        peerIdHex: data.from,
        answer: data.answer,
        offerIdHex: data.offer_id,
      });
    }
  }

  async _onRemoteOffer({ peerIdHex, peerIdBin, offer, offerId, via }) {
    if (this.peers.has(peerIdHex)) return;
    let desc;
    try {
      desc = await decryptSdp(this.key, offer.sdp);
    } catch {
      this.log('offer decrypt failed (wrong key or foreign swarm)', { peerIdHex });
      return;
    }
    const pc = new RTCPeerConnection(rtcConfig());
    this._wirePc(peerIdHex, pc, null, false);
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    const packed = await encryptSdp(this.key, pc.localDescription);
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
    this.log('answered offer', { peerIdHex, via: via || 'tracker' });
  }

  async _onRemoteAnswer({ peerIdHex, answer, offerIdHex }) {
    const pending = this.pendingOffers.get(offerIdHex);
    if (!pending) return;
    let desc;
    try {
      desc = await decryptSdp(this.key, answer.sdp);
    } catch {
      this.log('answer decrypt failed', { peerIdHex });
      return;
    }
    this.pendingOffers.delete(offerIdHex);
    await pending.pc.setRemoteDescription(desc);
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
