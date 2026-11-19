// Knuffkampen – game server entry point: static files, WebSocket at /ws, tick loop.
// Everything that arrives on a socket is treated as hostile.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { createStaticHandler } from './static.js';
import { Arcade } from './arcade.js';
import { SIM } from '../shared/sim.js';
import { GAME } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ config

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_SOCKETS = 120;
const MAX_MSGS_PER_SEC = 120;
const MAX_SOCKET_FAILS = 8;
const IP_FAILS = 30;
const IP_WINDOW_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 15000;
const HEARTBEAT_MS = 15000;
const SNAP_SKIP_BYTES = 64 * 1024;   // skip snapshots for a socket this far behind
const KILL_BYTES = 1024 * 1024;      // drop a socket this far behind
const MAX_CATCHUP_S = 0.25;          // real seconds of simulation per loop at most

const PORT = (() => {
  const n = Number(process.env.PORT || 3000);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
})();
// On a cloud host (Railway, Render, …) the platform's proxy must reach the process,
// so bind every interface there; on a laptop stay on loopback unless HOST says otherwise.
const PLATFORM = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? 'Railway'
  : process.env.RENDER ? 'Render' : '';
const HOST = process.env.HOST || (PLATFORM ? '0.0.0.0' : '127.0.0.1');
// Behind the platform's proxy every socket comes from the proxy's address, so the
// client's own address has to be read from the headers the proxy adds.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.KK_TRUST_PROXY || '') || (!!PLATFORM && process.env.KK_TRUST_PROXY !== '0');
// The address people open, for the links printed at start.
const PUBLIC_URL = (() => {
  const raw = (process.env.KK_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).trim();
  return /^https?:\/\/[^\s/]+$/.test(raw.replace(/\/$/, '')) ? raw.replace(/\/$/, '') : '';
})();
const CODE = (() => {
  const env = (process.env.KK_CODE || '').trim().toUpperCase();
  if (/^[A-Z0-9]{1,16}$/.test(env)) return env;
  if (env) console.warn('KK_CODE ogiltig (1–16 tecken A–Z, 0–9); slumpar en ny kod.');
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
})();
const HOST_KEY = (process.env.KK_HOST_KEY || '').trim() || randomBytes(8).toString('hex');
// Test-only: run game time this many times faster than real time.
const SPEED = (() => {
  const n = Number(process.env.KK_TEST_SPEED || 1);
  return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 1;
})();

// ------------------------------------------------------------------ helpers

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();
const HOST_KEY_DIGEST = digest(HOST_KEY);
const CODE_DIGEST = digest(CODE);

function safeEqual(input, refDigest) {
  if (typeof input !== 'string' || input.length > 128) return false;
  return timingSafeEqual(digest(input), refDigest);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const firstHeader = (v) => (typeof v === 'string' && v.trim() ? v.split(',')[0].trim().slice(0, 64) : '');

function clientIp(req) {
  const peer = req.socket.remoteAddress || '?';
  if (TRUST_PROXY) {
    // Railway sets X-Real-IP; others pass the client first in X-Forwarded-For.
    const ip = firstHeader(req.headers['x-real-ip']) || firstHeader(req.headers['cf-connecting-ip'])
      || firstHeader(req.headers['true-client-ip']) || firstHeader(req.headers['x-forwarded-for']);
    if (ip) return ip;
  }
  if (isLoopback(peer)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  }
  return peer.slice(0, 64);
}

// Which game the room opens in. In the cloud there is usually no big screen, and
// the demo is Heta paketet, so that is the default there; locally Knuffkampen.
const START_GAME = (() => {
  const names = { knuff: GAME.KNUFF, knuffkampen: GAME.KNUFF, paket: GAME.PAKET, heta: GAME.PAKET, golf: GAME.GOLF, molngolf: GAME.GOLF, kloss: GAME.KLOSS, klossgolf: GAME.KLOSS };
  const env = (process.env.KK_GAME || '').trim().toLowerCase();
  if (env in names) return names[env];
  if (env) console.warn('KK_GAME okänt (knuff, paket, golf eller kloss); använder standard.');
  return PLATFORM ? GAME.PAKET : GAME.KNUFF;
})();

const game = new Arcade({ makeToken: () => randomBytes(16).toString('hex'), startGame: START_GAME });

// ------------------------------------------------------------------ IP failure accounting

const ipFails = new Map(); // ip -> { n, since }

function ipBlocked(ip) {
  const r = ipFails.get(ip);
  if (!r) return false;
  if (Date.now() - r.since > IP_WINDOW_MS) { ipFails.delete(ip); return false; }
  return r.n >= IP_FAILS;
}

function ipFail(ip) {
  const now = Date.now();
  let r = ipFails.get(ip);
  if (!r || now - r.since > IP_WINDOW_MS) {
    if (ipFails.size > 20000) ipFails.clear(); // memory bound under a spoofed-header flood
    r = { n: 0, since: now };
    ipFails.set(ip, r);
  }
  r.n++;
}

// ------------------------------------------------------------------ sockets

const conns = new Set();
const byPid = new Map(); // player id -> conn

function sendRaw(conn, str, droppable) {
  const ws = conn.ws;
  if (ws.readyState !== WebSocket.OPEN) return;
  const buffered = ws.bufferedAmount;
  if (buffered > KILL_BYTES) { ws.terminate(); return; }
  if (droppable && buffered > SNAP_SKIP_BYTES) return;
  ws.send(str);
}

function send(conn, msg) {
  sendRaw(conn, JSON.stringify(msg), false);
}

function broadcast(str, droppable) {
  for (const c of conns) if (c.role) sendRaw(c, str, droppable);
}

function flush() {
  for (const [to, msg] of game.drain()) {
    const str = JSON.stringify(msg);
    if (to === 'all') broadcast(str, false);
    else {
      const c = byPid.get(to);
      if (c) sendRaw(c, str, false);
    }
  }
}

function fail(conn, m, countIp) {
  send(conn, { t: 'err', m });
  if (countIp) ipFail(conn.ip);
  if (++conn.fails >= MAX_SOCKET_FAILS) conn.ws.close(1008, 'too many attempts');
}

function onJoin(conn, msg) {
  if (conn.role) return;
  if (ipBlocked(conn.ip)) return fail(conn, 'rate', false);
  const code = typeof msg.code === 'string' && msg.code.length <= 32 ? msg.code.trim().toUpperCase() : '';
  if (!safeEqual(code, CODE_DIGEST)) return fail(conn, 'code', true);
  const token = typeof msg.token === 'string' ? msg.token : undefined;
  const r = game.join(msg.name, token);
  if (r.err) return fail(conn, r.err, false);

  const old = byPid.get(r.id);
  if (old && old !== conn) {
    // Same player opened a new connection: the old one is retired silently.
    old.role = null; old.pid = null; old.ctl = false;
    old.ws.close(4001, 'replaced');
  }
  conn.role = 'player';
  conn.pid = r.id;
  byPid.set(r.id, conn);
  send(conn, { t: 'joined', id: r.id, token: r.token });
  for (const m of game.welcome()) send(conn, m);
  flush();
}

// Two ways to hold the host controls: a socket that is only the big screen
// (role 'host'), or a joined player whose socket also showed the host key
// (role 'player' with ctl set), so the host can play and steer from one screen.
function onHost(conn, msg) {
  if (conn.role === 'host' || conn.ctl) return;
  if (ipBlocked(conn.ip)) return fail(conn, 'rate', false);
  if (!safeEqual(msg.key, HOST_KEY_DIGEST)) return fail(conn, 'key', true);
  if (conn.role === 'player') {
    conn.ctl = true;
    send(conn, { t: 'hosted', code: CODE, id: conn.pid });
    return;
  }
  conn.role = 'host';
  send(conn, { t: 'hosted', code: CODE });
  for (const m of game.welcome()) send(conn, m);
}

function onCmd(conn, msg) {
  if (conn.role !== 'host' && !(conn.role === 'player' && conn.ctl)) return;
  if (typeof msg.c !== 'string' || msg.c.length > 16) return;
  const v = typeof msg.v === 'number' && Number.isFinite(msg.v) ? msg.v : undefined;
  if (msg.c === 'kick' && conn.role === 'player' && v === conn.pid) return; // not yourself
  const kicked = game.command(msg.c, v);
  flush(); // delivers 'kicked' while the socket is still bound
  if (kicked >= 0) {
    const c = byPid.get(kicked);
    if (c) {
      byPid.delete(kicked);
      c.role = null; c.pid = null; c.ctl = false;
      c.ws.close(4002, 'kicked');
    }
  }
}

function onMessage(conn, data, isBinary) {
  const now = performance.now();
  if (now - conn.winStart >= 1000) { conn.winStart = now; conn.winCount = 0; }
  if (++conn.winCount > MAX_MSGS_PER_SEC) { conn.ws.terminate(); return; }
  if (isBinary) return;

  let msg;
  try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
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
      if ((typeof c === 'number' && Number.isFinite(c)) || (typeof c === 'string' && c.length <= 32)) {
        send(conn, { t: 'pong', c });
      }
      return;
    }
    case 'join': return onJoin(conn, msg);
    case 'host': return onHost(conn, msg);
    case 'cmd': return onCmd(conn, msg);
    default: return;
  }
}

function onClose(conn) {
  if (!conns.delete(conn)) return;
  if (conn.role === 'player' && byPid.get(conn.pid) === conn) {
    byPid.delete(conn.pid);
    game.leave(conn.pid);
    flush();
  }
  conn.role = null;
  conn.ctl = false;
}

function onConnection(ws, req) {
  const conn = {
    ws, ip: clientIp(req), role: null, pid: null, ctl: false, fails: 0,
    born: Date.now(), alive: true, winStart: performance.now(), winCount: 0,
  };
  conns.add(conn);
  ws.on('message', (data, isBinary) => {
    try { onMessage(conn, data, isBinary); } catch (e) { console.error('message handler:', e); ws.terminate(); }
  });
  ws.on('pong', () => { conn.alive = true; });
  ws.on('error', () => { /* e.g. maxPayload exceeded; 'close' follows */ });
  ws.on('close', () => {
    try { onClose(conn); } catch (e) { console.error('close handler:', e); }
  });
}

// ------------------------------------------------------------------ http + upgrade

const handleStatic = createStaticHandler(ROOT);
const server = http.createServer((req, res) => {
  // Health check for the hosting platform: cheap, no files, no game state.
  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': 3 });
    res.end(req.method === 'HEAD' ? undefined : 'ok\n');
    return;
  }
  handleStatic(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } });
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 64;
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

const wss = new WebSocketServer({
  noServer: true, maxPayload: 1024, perMessageDeflate: false, clientTracking: false,
});
wss.on('error', () => {});

let shuttingDown = false;

function refuse(socket, status) {
  try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return refuse(socket, '400 Bad Request'); }
  if (pathname !== '/ws') return refuse(socket, '404 Not Found');
  if (shuttingDown || conns.size >= MAX_SOCKETS) return refuse(socket, '503 Service Unavailable');
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (shuttingDown || conns.size >= MAX_SOCKETS) { ws.terminate(); return; }
    onConnection(ws, req);
  });
});

// ------------------------------------------------------------------ loops

const DT = 1 / SIM.HZ;
const SNAP_EVERY = Math.max(1, Math.round(SIM.HZ / SIM.SNAP_HZ));
let last = performance.now();
let acc = 0;
let steps = 0;

const tickTimer = setInterval(() => {
  try {
    const t = performance.now();
    acc += Math.min((t - last) / 1000, MAX_CATCHUP_S) * SPEED;
    last = t;
    while (acc >= DT) {
      acc -= DT;
      game.update(DT);
      if (++steps % SNAP_EVERY === 0) {
        // Snapshot first, so the events that ended a round arrive before 'round' / 'match'.
        broadcast(JSON.stringify(game.snapshot(Math.round(performance.now()))), true);
        flush();
      }
    }
  } catch (e) {
    console.error('tick:', e);
  }
}, 5);

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const c of conns) {
    if (!c.role && now - c.born > AUTH_TIMEOUT_MS) c.ws.terminate();
  }
  for (const [ip, r] of ipFails) if (now - r.since > IP_WINDOW_MS) ipFails.delete(ip);
}, 1000);

const heartbeatTimer = setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { c.ws.terminate(); }
  }
}, HEARTBEAT_MS);

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

server.on('error', (e) => {
  console.error('Servern kunde inte starta:', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log('Knuffkampen är igång!' + (PLATFORM ? ` (${PLATFORM}, ${HOST}:${PORT})` : ''));
  console.log(`  Spelarlänk:       ${base}/?k=${CODE}`);
  console.log(`  Spela som värd:   ${base}/?k=${CODE}&host=${HOST_KEY}`);
  console.log(`  Värdlänk (TV):    ${base}/?host=${HOST_KEY}`);
  console.log(`  Rumskod:          ${CODE}`);
  if (!PUBLIC_URL) console.log(`  Den publika adressen får du från tunneln eller molntjänsten: byt ut ${base} mot den.`);
  if (PLATFORM && (!process.env.KK_CODE || !process.env.KK_HOST_KEY)) {
    console.warn('  OBS: KK_CODE och KK_HOST_KEY är inte satta, så koden och värdnyckeln byts vid varje omstart.');
  }
  if (SPEED !== 1) console.log(`  (Testläge: speltiden går ${SPEED} gånger fortare.)`);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Stänger ner Knuffkampen …');
  clearInterval(tickTimer);
  clearInterval(sweepTimer);
  clearInterval(heartbeatTimer);
  for (const c of conns) { try { c.ws.close(1001, 'server shutting down'); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => {
    for (const c of conns) c.ws.terminate();
    process.exit(0);
  }, 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
