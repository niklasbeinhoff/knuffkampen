// Knuffkampen on GitHub Pages: there is no game server. The host's own tab runs
// the room (room-worker.js, the same game classes as the Node server) and the
// other players reach it over WebRTC data channels. PeerJS's free public broker
// only introduces the browsers to each other; game traffic goes browser to browser
// (or through PeerJS's public relay when a network blocks direct connections).
//
// The sockets below look like a WebSocket to main.js: readyState, send(text),
// close(), onopen / onmessage({ data }) / onclose({ code }).
//   PeerSocket   a player's connection to the host's room
//   LocalSocket  the host's own player, straight into the worker
// Close codes besides the server's own: 4004 no room with that code, 4005 broker unreachable.

const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

const qs = new URLSearchParams(location.search);
/** Pages mode: on github.io, or forced with ?p2p for local tests. */
export const P2P = qs.has('p2p') || /\.github\.io$/i.test(location.hostname);

let peerLib = null;
function loadPeerJs() {
  if (!peerLib) {
    peerLib = new Promise((resolve, reject) => {
      if (window.Peer) { resolve(window.Peer); return; }
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('peerjs')));
      s.onerror = () => reject(new Error('peerjs'));
      document.head.appendChild(s);
    });
    peerLib.catch(() => { peerLib = null; });
  }
  return peerLib;
}

/** The room's address at the broker: derived from the code, so only people with the code find it. */
export async function roomPeerId(code) {
  const data = new TextEncoder().encode('knuffkampen|' + String(code || '').trim().toUpperCase());
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return 'knuffkampen-' + Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

const later = (fn) => setTimeout(fn, 0);

// ------------------------------------------------------------------ player side

let clientPeer = null;           // Promise<Peer>, one per page
const connecting = new Set();    // PeerSockets waiting for the room to answer

function getClientPeer() {
  if (clientPeer) return clientPeer;
  const p = loadPeerJs().then((Peer) => new Promise((resolve, reject) => {
    const peer = new Peer();
    let opened = false;
    peer.on('open', () => { opened = true; resolve(peer); });
    peer.on('disconnected', () => {
      // Lost the broker; open data channels keep working. Come back for new connects.
      setTimeout(() => { try { if (peer.disconnected && !peer.destroyed) peer.reconnect(); } catch { /* ignore */ } }, 1500);
    });
    peer.on('close', () => { if (clientPeer === p) clientPeer = null; });
    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'peer-unavailable') { for (const s of [...connecting]) s._fail(4004); return; }
      if (!opened) { if (clientPeer === p) clientPeer = null; try { peer.destroy(); } catch { /* ignore */ } reject(err); }
    });
  }));
  clientPeer = p;
  p.catch(() => { if (clientPeer === p) clientPeer = null; });
  return p;
}

export class PeerSocket {
  constructor(code) {
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.conn = null;
    this.lastData = 0;
    this.watch = 0;
    connecting.add(this);
    this.timer = setTimeout(() => this._fail(4004), 15000);
    this._start(code);
  }

  async _start(code) {
    let peer, id;
    try {
      [peer, id] = await Promise.all([getClientPeer(), roomPeerId(code)]);
    } catch {
      this._fail(4005);
      return;
    }
    if (this.readyState !== 0) return;
    const conn = peer.connect(id, { reliable: true, serialization: 'raw' });
    this.conn = conn;
    conn.on('open', () => {
      if (this.readyState !== 0) return;
      clearTimeout(this.timer);
      connecting.delete(this);
      this.readyState = 1;
      this.lastData = performance.now();
      // The room sends snapshots many times a second; a long silence means it is gone.
      this.watch = setInterval(() => { if (performance.now() - this.lastData > 8000) this._fail(1006); }, 1000);
      if (this.onopen) this.onopen({});
    });
    conn.on('data', (d) => {
      if (this.readyState !== 1 || typeof d !== 'string') return;
      this.lastData = performance.now();
      if (d.startsWith('{"t":"__bye"')) {
        let c = 1000;
        try { c = JSON.parse(d).code | 0 || 1000; } catch { /* ignore */ }
        this._fail(c);
        return;
      }
      if (this.onmessage) this.onmessage({ data: d });
    });
    conn.on('close', () => this._fail(1006));
    conn.on('error', () => this._fail(1006));
  }

  send(s) {
    if (this.readyState !== 1) return;
    try { this.conn.send(s); } catch { this._fail(1006); }
  }

  close() { this._fail(1000); }

  _fail(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.timer);
    clearInterval(this.watch);
    connecting.delete(this);
    try { if (this.conn) this.conn.close(); } catch { /* ignore */ }
    const cb = this.onclose;
    if (cb) later(() => cb({ code }));
  }
}

// ------------------------------------------------------------------ host side

const SNAP_SKIP_BYTES = 64 * 1024;   // skip snapshots for a connection this far behind
const KILL_BYTES = 1024 * 1024;      // and drop it this far behind

class LocalSocket {
  constructor(room) {
    this.room = room;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    if (room.local) room.local._fail(1000);
    room.local = this;
    later(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      room.worker.postMessage({ k: 'open', cid: 0 });
      if (this.onopen) this.onopen({});
    });
  }
  send(s) { if (this.readyState === 1) this.room.worker.postMessage({ k: 'msg', cid: 0, d: s }); }
  close() { this._fail(1000); }
  _recv(d) { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: d }); }
  _fail(code) {
    if (this.readyState === 3) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 3;
    if (this.room.local === this) {
      this.room.local = null;
      if (wasOpen) this.room.worker.postMessage({ k: 'close', cid: 0 });
    }
    const cb = this.onclose;
    if (cb) later(() => cb({ code }));
  }
}

/**
 * Open the room in this tab. Resolves once the broker has given us the room's
 * address; rejects with { type: 'unavailable-id' } if a room with this code is
 * already open somewhere else, or another PeerJS error / 'peerjs' if the broker
 * cannot be reached.
 */
export async function startRoom(code, startGame) {
  const Peer = await loadPeerJs();
  const id = await roomPeerId(code);

  // A reload can find our own old address still held for a few seconds: retry a little.
  let peer = null;
  for (let attempt = 0; ; attempt++) {
    try {
      peer = await new Promise((resolve, reject) => {
        const p = new Peer(id);
        let opened = false;
        p.on('open', () => { opened = true; resolve(p); });
        p.on('error', (err) => { if (!opened) { try { p.destroy(); } catch { /* ignore */ } reject(err); } });
      });
      break;
    } catch (err) {
      if (err && err.type === 'unavailable-id' && attempt < 5) { await new Promise((r) => setTimeout(r, 2500)); continue; }
      throw err;
    }
  }

  const worker = new Worker(new URL('./room-worker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ k: 'init', code: String(code).trim().toUpperCase(), game: startGame });
  const conns = new Map();   // cid -> DataConnection
  let nextCid = 1;

  const room = {
    worker,
    local: null,
    localSocket() { return new LocalSocket(room); },
    remoteCount() { return conns.size; },
  };

  function closeConn(cid, code) {
    if (cid === 0) { if (room.local) room.local._fail(code); return; }
    const c = conns.get(cid);
    if (!c) return;
    conns.delete(cid);
    try { c.send(JSON.stringify({ t: '__bye', code })); } catch { /* ignore */ }
    setTimeout(() => { try { c.close(); } catch { /* ignore */ } }, 400);
  }

  function deliver(cid, d, drop) {
    if (cid === 0) { if (room.local) room.local._recv(d); return; }
    const c = conns.get(cid);
    if (!c) return;
    const dc = c.dataChannel;
    if (!dc || dc.readyState !== 'open') return;
    const buffered = dc.bufferedAmount;
    if (buffered > KILL_BYTES) { closeConn(cid, 1008); worker.postMessage({ k: 'close', cid }); return; }
    if (drop && buffered > SNAP_SKIP_BYTES) return;
    try { c.send(d); } catch { /* the close event follows */ }
  }

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.k === 'send') deliver(m.cid, m.d, m.drop);
    else if (m.k === 'bcast') for (const cid of m.cids) deliver(cid, m.d, m.drop);
    else if (m.k === 'close') closeConn(m.cid, m.code);
  };
  worker.onerror = (e) => console.error('room worker:', e.message || e);

  peer.on('connection', (c) => {
    const cid = nextCid++;
    c.on('open', () => {
      conns.set(cid, c);
      worker.postMessage({ k: 'open', cid });
    });
    c.on('data', (d) => {
      if (conns.get(cid) !== c) return;
      worker.postMessage({ k: 'msg', cid, d: typeof d === 'string' ? d.slice(0, 2048) : '' });
    });
    const gone = () => {
      if (conns.get(cid) !== c) return;
      conns.delete(cid);
      worker.postMessage({ k: 'close', cid });
    };
    c.on('close', gone);
    c.on('error', gone);
  });

  // Lost the broker: players already in keep playing; reconnect so new ones can join.
  let backoff = 1000;
  peer.on('disconnected', () => {
    const again = () => {
      if (peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch { /* ignore */ }
      backoff = Math.min(15000, backoff * 2);
      setTimeout(again, backoff);
    };
    setTimeout(again, backoff);
  });
  peer.on('open', () => { backoff = 1000; });
  peer.on('error', (err) => console.warn('room broker:', err && err.type));

  return room;
}
