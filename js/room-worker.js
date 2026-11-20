// Knuffkampen on GitHub Pages: the game room, run in a worker in the host's tab.
// It is the browser twin of server/server.js minus the Node parts (HTTP, IPs):
// the same game classes, the same messages, the same checks. The main thread
// (p2p.js) owns the WebRTC connections and relays their text frames here.
//
//   main -> worker  { k:'init', code, game }      once
//                   { k:'open', cid }             a connection is up (cid 0 = the host's own player)
//                   { k:'msg', cid, d }           a text frame from that connection
//                   { k:'close', cid }            it went away
//   worker -> main  { k:'send', cid, d, drop }    one frame to one connection
//                   { k:'bcast', cids, d, drop }  the same frame to several
//                   { k:'close', cid, code }      close it (4001 replaced, 4002 kicked, 1008 abuse)
// `drop`: the frame is a snapshot and may be skipped for a connection that is behind.

import { Arcade } from '../server/arcade.js';
import { SIM } from '../shared/sim.js';
import { GAME } from '../shared/protocol.js';

const MAX_CONNS = 60;
const MAX_MSGS_PER_SEC = 120;
const MAX_SOCKET_FAILS = 8;
const AUTH_TIMEOUT_MS = 15000;
const SILENT_MS = 120000;       // nothing at all for this long: treat as gone (WebRTC itself notices most drops)
const MAX_CATCHUP_S = 0.25;
const LOCAL = 0;                // the host's own player, in this tab: trusted with the controls

let CODE = '';
let game = null;
const conns = new Map();        // cid -> conn
const byPid = new Map();        // player id -> conn

const out = (msg) => postMessage(msg);

function makeToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function send(conn, msg) { out({ k: 'send', cid: conn.cid, d: JSON.stringify(msg), drop: false }); }

function broadcast(str, drop) {
  const cids = [];
  for (const c of conns.values()) if (c.role) cids.push(c.cid);
  if (cids.length) out({ k: 'bcast', cids, d: str, drop });
}

function flush() {
  for (const [to, msg] of game.drain()) {
    const str = JSON.stringify(msg);
    if (to === 'all') broadcast(str, false);
    else {
      const c = byPid.get(to);
      if (c) out({ k: 'send', cid: c.cid, d: str, drop: false });
    }
  }
}

function drop(conn, code) {
  conns.delete(conn.cid);
  if (conn.role === 'player' && byPid.get(conn.pid) === conn) {
    byPid.delete(conn.pid);
    game.leave(conn.pid);
    flush();
  }
  conn.role = null; conn.ctl = false;
  out({ k: 'close', cid: conn.cid, code });
}

function fail(conn, m) {
  send(conn, { t: 'err', m });
  if (++conn.fails >= MAX_SOCKET_FAILS) drop(conn, 1008);
}

function onJoin(conn, msg) {
  if (conn.role) return;
  const code = typeof msg.code === 'string' && msg.code.length <= 32 ? msg.code.trim().toUpperCase() : '';
  if (code !== CODE) return fail(conn, 'code');
  const token = typeof msg.token === 'string' && msg.token.length <= 64 ? msg.token : undefined;
  const r = game.join(msg.name, token);
  if (r.err) return fail(conn, r.err);
  const old = byPid.get(r.id);
  if (old && old !== conn) {
    // Same player opened a new connection: the old one is retired.
    old.role = null; old.pid = null; old.ctl = false;
    conns.delete(old.cid);
    out({ k: 'close', cid: old.cid, code: 4001 });
  }
  conn.role = 'player';
  conn.pid = r.id;
  byPid.set(r.id, conn);
  send(conn, { t: 'joined', id: r.id, token: r.token });
  for (const m of game.welcome()) send(conn, m);
  flush();
}

// Only the host's own player, in this very tab, gets the controls. Nobody else
// can become host over the network: there is no key to guess.
function onHost(conn) {
  if (conn.ctl) return;
  if (conn.cid !== LOCAL || conn.role !== 'player') return fail(conn, 'key');
  conn.ctl = true;
  send(conn, { t: 'hosted', code: CODE, id: conn.pid });
}

function onCmd(conn, msg) {
  if (!(conn.role === 'player' && conn.ctl)) return;
  if (typeof msg.c !== 'string' || msg.c.length > 16) return;
  const v = typeof msg.v === 'number' && Number.isFinite(msg.v) ? msg.v : undefined;
  if (msg.c === 'kick' && v === conn.pid) return;
  const kicked = game.command(msg.c, v);
  flush(); // delivers 'kicked' while the connection is still bound
  if (kicked >= 0) {
    const c = byPid.get(kicked);
    if (c) {
      byPid.delete(kicked);
      c.role = null; c.pid = null; c.ctl = false;
      conns.delete(c.cid);
      out({ k: 'close', cid: c.cid, code: 4002 });
    }
  }
}

function onFrame(conn, data) {
  const now = performance.now();
  conn.last = now;
  if (now - conn.winStart >= 1000) { conn.winStart = now; conn.winCount = 0; }
  if (++conn.winCount > MAX_MSGS_PER_SEC) { drop(conn, 1008); return; }
  if (typeof data !== 'string' || data.length > 1024) return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'in': {
      if (conn.role !== 'player') return;
      const { x, y, d } = msg;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      game.input(conn.pid, x, y, d === 1 || d === true);
      return;
    }
    case 'shot': {
      if (conn.role !== 'player') return;
      const { x, y } = msg;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
      game.shot(conn.pid, x, y);
      return;
    }
    case 'swing': {
      if (conn.role !== 'player') return;
      const { a, p, c } = msg;
      if (typeof a !== 'number' || typeof p !== 'number' || !Number.isFinite(a) || !Number.isFinite(p)) return;
      if (!Number.isInteger(c) || c < 0 || c > 3) return;
      game.swing(conn.pid, a, Math.min(1, Math.max(0, p)), c);
      return;
    }
    case 'ping': {
      const c = msg.c;
      if ((typeof c === 'number' && Number.isFinite(c)) || (typeof c === 'string' && c.length <= 32)) send(conn, { t: 'pong', c });
      return;
    }
    case 'join': return onJoin(conn, msg);
    case 'host': return onHost(conn);
    case 'cmd': return onCmd(conn, msg);
    default: return;
  }
}

// ------------------------------------------------------------------ loops

const DT = 1 / SIM.HZ;
const SNAP_EVERY = Math.max(1, Math.round(SIM.HZ / SIM.SNAP_HZ));
let last = 0;
let acc = 0;
let steps = 0;

function tick() {
  try {
    const t = performance.now();
    acc += Math.min((t - last) / 1000, MAX_CATCHUP_S);
    last = t;
    while (acc >= DT) {
      acc -= DT;
      game.update(DT);
      if (++steps % SNAP_EVERY === 0) {
        broadcast(JSON.stringify(game.snapshot(Math.round(performance.now()))), true);
        flush();
      }
    }
  } catch (e) {
    console.error('tick:', e);
  }
}

function sweep() {
  const now = performance.now();
  for (const c of [...conns.values()]) {
    if (c.cid === LOCAL) continue;
    if (!c.role && now - c.born > AUTH_TIMEOUT_MS) drop(c, 1008);
    else if (now - c.last > SILENT_MS) drop(c, 1001);
  }
}

// ------------------------------------------------------------------ main thread

onmessage = (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  try {
    if (m.k === 'init') {
      if (game) return;
      CODE = String(m.code || '').trim().toUpperCase();
      const start = [GAME.KNUFF, GAME.GOLF, GAME.KLOSS, GAME.PAKET].includes(m.game) ? m.game : GAME.PAKET;
      game = new Arcade({ makeToken, startGame: start });
      last = performance.now();
      setInterval(tick, 5);
      setInterval(sweep, 1000);
    } else if (!game) {
      return;
    } else if (m.k === 'open') {
      if (conns.has(m.cid)) return;
      if (conns.size >= MAX_CONNS && m.cid !== LOCAL) { out({ k: 'close', cid: m.cid, code: 1013 }); return; }
      const now = performance.now();
      conns.set(m.cid, { cid: m.cid, role: null, pid: null, ctl: false, fails: 0, born: now, last: now, winStart: now, winCount: 0 });
    } else if (m.k === 'msg') {
      const c = conns.get(m.cid);
      if (c) onFrame(c, m.d);
    } else if (m.k === 'close') {
      const c = conns.get(m.cid);
      if (c) {
        conns.delete(c.cid);
        if (c.role === 'player' && byPid.get(c.pid) === c) {
          byPid.delete(c.pid);
          game.leave(c.pid);
          flush();
        }
      }
    }
  } catch (e) {
    console.error('room:', e);
  }
};
