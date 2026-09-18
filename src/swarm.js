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
const SDP_STEP_TIMEOUT_MS = 8000;
const DC_OPTS = { negotiated: true, id: 0, ordered: true };

// pc.createOffer()/createAnswer()/setLocalDescription()/setRemoteDescription()
// are all supposed to settle (resolve or reject) on their own, but a buggy or
// unusual WebRTC stack can leave one pending forever instead of erroring —
// which, with no timeout, would silently stall this connection attempt with
// no log line ever explaining why (waitForUsefulIce has its own hard cap and
// doesn't need this; these four calls don't). Racing every such call against
// this timeout turns a silent, undiagnosable hang into a logged, recoverable
// failure — this is exactly the gap that made a real Fire TV Silk failure
// show nothing in the debug log beyond tracker connect/close noise.
function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${SDP_STEP_TIMEOUT_MS}ms`)), SDP_STEP_TIMEOUT_MS);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

export function stripMdnsCandidates(sdp) {
  return String(sdp || '')
    .split(/\r?\n/)
    .filter((line) => {
      if (!/^a=candidate:/i.test(line)) return true;
      return !/\.local\b/i.test(line);
    })
    .join('\r\n');
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
    const openSockets = [...this.sockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN).length;
    this.log('announce', { event, initiator: this.initiator, openSockets, totalSockets: this.sockets.size });
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
      this.log('generating offer', { i, of: n, offerIdHex });
      let pc;
      let dc;
      try {
        pc = new RTCPeerConnection(rtcConfig());
        dc = openChannel(pc);
      } catch (err) {
        this.log('offer setup failed: could not create peer connection/data channel', { err: String(err) });
        continue;
      }
      const ref = this._wirePc(offerIdHex, pc, dc, true);
      let packed;
      try {
        const offer = await withTimeout(pc.createOffer(), 'createOffer');
        await withTimeout(pc.setLocalDescription(offer), 'setLocalDescription');
        await waitForUsefulIce(pc);
        packed = await encryptSdp(this.key, {
          type: pc.localDescription.type,
          sdp: stripMdnsCandidates(pc.localDescription.sdp),
        });
      } catch (err) {
        // A hung (never resolving, never rejecting) createOffer/
        // setLocalDescription used to stall this whole attempt forever with
        // no log line — the debug panel would show nothing beyond tracker
        // connect/close noise, indistinguishable from "never even tried".
        this.log('offer setup failed or timed out', { offerIdHex, err: String(err) });
        this.peers.delete(ref.key);
        try {
          pc.close();
        } catch {
          /* ignore */
        }
        continue;
      }
      this.pendingOffers.set(offerIdHex, { pc, dc, ref, createdAt: Date.now() });
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
        // _wirePc above already added this offer's pc/dc to this.peers,
        // keyed through `ref` (initially ref.key === offerIdHex, since we
        // don't know who — if anyone — will answer it yet). If the offer
        // was answered, _onRemoteAnswer re-keys `ref` to the real peer id,
        // so `ref.key` no longer equals `offerIdHex` here and this block
        // is a correct no-op. If nobody ever answered, ref.key is still
        // offerIdHex and, unless the channel separately reached 'open',
        // the entry is dead: only a real dc 'close' event otherwise
        // removes a peers entry, and a dc that never opened never fires
        // one. Over a long session every 8-30s re-announce would leave 2
        // more dead entries behind, which is why the host's "N watching"
        // count climbed well past the number of actual viewers.
        const rec = this.peers.get(ref.key);
        if (rec && rec.dc && rec.dc.readyState !== 'open') {
          this.peers.delete(ref.key);
          this.onStatus({ state: this.peers.size ? 'connected' : 'announcing', peers: this.peers.size });
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
    // `ref` is a mutable handle on this connection's current key in
    // `this.peers`. For an outgoing offer (see _generateOffers) the key
    // starts as the random offer id, since we don't yet know which remote
    // peer (if any) will answer it; _onRemoteAnswer later updates
    // `ref.key` to the real peer id once we do. Every place that needs to
    // remove or look up this connection's peers entry goes through
    // `ref.key` rather than a value captured at attach time — otherwise,
    // after that re-key, the dc 'close' listener below (bound once, here)
    // would delete the stale offer-id key and leave the real, re-keyed
    // entry orphaned in `this.peers` forever, permanently inflating the
    // "N watching" count by one for every connection that ever closes.
    const ref = { key: id };
    pc.addEventListener('connectionstatechange', () => {
      this.log('pc state', { id: ref.key, state: pc.connectionState, initiator });
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._scheduleReconnect();
      }
    });
    this._attachDc(ref, pc, dc || openChannel(pc));
    return ref;
  }

  _attachDc(ref, pc, dc) {
    if (dc._p2pAttached) return;
    dc._p2pAttached = true;
    try {
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 256 * 1024;
    } catch {
      /* Silk may reject these before open */
    }
    this.peers.set(ref.key, { pc, dc });
    this.onDataChannel({ peerId: ref.key, pc, dc });
    const onOpen = () => {
      if (this.destroyed) return;
      this.log('datachannel open', { id: ref.key, label: dc.label });
      this.onStatus({ state: 'connected', peers: this.peers.size });
      this.onChannelOpen({ peerId: ref.key, pc, dc });
    };
    if (dc.readyState === 'open') onOpen();
    else dc.addEventListener('open', onOpen, { once: true });
    dc.addEventListener('close', () => {
      this.peers.delete(ref.key);
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
    this.log('received offer', { peerIdHex, via: via || 'tracker' });
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
      desc.sdp = stripMdnsCandidates(desc.sdp);
    } catch {
      this.log('offer decrypt failed (wrong key or foreign swarm)', { peerIdHex });
      return;
    }
    let pc;
    let dc;
    try {
      pc = new RTCPeerConnection(rtcConfig());
      dc = openChannel(pc);
    } catch (err) {
      this.log('answer setup failed: could not create peer connection/data channel', { peerIdHex, err: String(err) });
      return;
    }
    this._wirePc(peerIdHex, pc, dc, false);
    let packed;
    try {
      await withTimeout(pc.setRemoteDescription(desc), 'setRemoteDescription');
      const answer = await withTimeout(pc.createAnswer(), 'createAnswer');
      await withTimeout(pc.setLocalDescription(answer), 'setLocalDescription (answer)');
      await waitForUsefulIce(pc);
      packed = await encryptSdp(this.key, {
        type: pc.localDescription.type,
        sdp: stripMdnsCandidates(pc.localDescription.sdp),
      });
    } catch (err) {
      // Same silent-hang risk as the offering side (see _generateOffers):
      // without a timeout, a stuck setRemoteDescription/createAnswer here
      // would leave an incoming connection attempt looking identical, in
      // the debug log, to one that was never received at all.
      this.log('answer setup failed or timed out', { peerIdHex, err: String(err) });
      this.peers.delete(peerIdHex);
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      return;
    }
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
    if (!pending) {
      this.log('received answer for unknown/expired offer', { peerIdHex, offerIdHex });
      return;
    }
    this.log('received answer', { peerIdHex, offerIdHex });
    let desc;
    try {
      desc = await decryptSdp(this.key, answer.sdp);
      desc.sdp = stripMdnsCandidates(desc.sdp);
    } catch {
      this.log('answer decrypt failed', { peerIdHex });
      return;
    }
    this.pendingOffers.delete(offerIdHex);
    await pending.pc.setRemoteDescription(desc);
    // Re-key the peers entry _attachDc already created for this connection
    // (under the random offer id, since we didn't know the remote peer's
    // real id until now) onto the peer's real id, instead of inserting a
    // second entry for the same pc/dc. Also repoint `pending.ref.key` so
    // the dc 'close' listener (which reads `ref.key` fresh, not a value
    // captured at attach time) deletes the right key later. Without this,
    // every successfully-answered outgoing offer left two live entries in
    // `this.peers` for one real connection — double-counting it in "N
    // watching" — and once the connection closed, only the offer-id entry
    // was removed, orphaning the peer-id one forever.
    const ref = pending.ref;
    const oldKey = ref ? ref.key : offerIdHex;
    const rec = this.peers.get(oldKey);
    if (rec) this.peers.delete(oldKey);
    if (ref) ref.key = peerIdHex;
    this.peers.set(peerIdHex, rec || { pc: pending.pc, dc: pending.dc });
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
