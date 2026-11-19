// Knuffkampen – end-to-end smoke test for the game server.
// Starts the real server on a free port with sped-up game time, drives it over
// WebSockets and exits non-zero on the first failed assertion.
//
//   node tools/smoke.js

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PHASE, ST, PALETTE, LIMITS, GAME } from '../shared/protocol.js';
import { GOLF, BALL, COURSES, onGround } from '../shared/golf.js';
import { SIM } from '../shared/sim.js';
import { KG, KST, SURF, CLUBS, surfaceAt, maxStrokes, holeClock } from '../shared/klossgolf.js';
import { KCOURSES } from '../shared/klosscourses.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = 'SMKQ';
const KEY = 'feedc0ffee123456';
const SPEED = 10;
const T0 = Date.now();

let server = null;
let serverOut = '';
let checks = 0;

function log(...a) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a); }
function ok(cond, what) {
  checks++;
  if (!cond) throw new Error('FAILED: ' + what);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (port !== 3000 && port !== 3100) return port;
  }
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

// ------------------------------------------------------------------ client

let PORT = 0;
const snapErrors = [];

class Client {
  constructor(label, ip = '10.0.0.1') {
    this.label = label;
    this.log = [];
    this.waiters = new Set();
    this.snap = null;
    this.snapCount = 0;
    this.closed = false;
    this.closeCode = null;
    this.onSnap = null;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'x-forwarded-for': `${ip}, 127.0.0.1` } });
    this.ws.on('error', () => {});
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 's') { this.snap = m; this.snapCount++; if (this.onSnap) this.onSnap(m); }
      else this.log.push(m);
      for (const w of [...this.waiters]) w(m);
    });
    this.ws.on('close', (code) => {
      this.closed = true; this.closeCode = code;
      for (const w of [...this.waiters]) w({ t: '__close', code });
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve(this);
      this.ws.once('open', () => resolve(this));
      this.ws.once('close', () => reject(new Error(`${this.label}: closed before open`)));
    });
  }
  send(o) { this.ws.send(typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o)); }
  mark() { return this.log.length; }
  /** Wait for a message matching pred: first in the log since `since`, then live. */
  wait(pred, what, ms = 4000, since = null) {
    if (since !== null) {
      for (let i = since; i < this.log.length; i++) if (pred(this.log[i])) return Promise.resolve(this.log[i]);
    }
    return new Promise((resolve, reject) => {
      const w = (m) => {
        let hit = false;
        try { hit = pred(m); } catch { hit = false; }
        if (hit) { clearTimeout(timer); this.waiters.delete(w); resolve(m); }
      };
      const timer = setTimeout(() => { this.waiters.delete(w); reject(new Error(`FAILED: ${this.label}: timed out waiting for ${what}`)); }, ms);
      this.waiters.add(w);
    });
  }
  waitClose(what, ms = 4000) {
    if (this.closed) return Promise.resolve({ t: '__close', code: this.closeCode });
    return this.wait((m) => m.t === '__close', what, ms);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function connect(label, ip) {
  const c = new Client(label, ip);
  await c.open();
  return c;
}

async function joinOk(c, name, token) {
  const since = c.mark();
  c.send({ t: 'join', name, code: CODE.toLowerCase(), token });
  const j = await c.wait((m) => m.t === 'joined' || m.t === 'err', 'joined', 4000, since);
  ok(j.t === 'joined', `${c.label} joins (got ${JSON.stringify(j)})`);
  ok(Number.isInteger(j.id) && typeof j.token === 'string' && j.token.length >= 16, 'joined carries id and token');
  c.id = j.id; c.token = j.token;
  await c.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === j.id), 'roster after join', 4000, since);
  return j;
}

const lastRoster = (c) => [...c.log].reverse().find((m) => m.t === 'roster');

// ------------------------------------------------------------------ snapshot validation

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const cents = (v) => isNum(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const SNAP_KEYS = ['t', 'ts', 'g', 'ph', 'pt', 'rd', 'rn', 'r0', 'rg', 'wf', 'p', 'e'].sort().join();
const GOLF_KEYS = ['t', 'ts', 'g', 'ph', 'pt', 'rd', 'rn', 'ci', 'ht', 'tl', 'p', 'e'].sort().join();
const PAKET_KEYS = ['t', 'ts', 'g', 'ph', 'pt', 'rd', 'rn', 'r0', 'rg', 'wf', 'p', 'e', 'ca', 'fu'].sort().join();
const KLOSS_KEYS = ['t', 'ts', 'g', 'ph', 'pt', 'rd', 'rn', 'ci', 'tl', 'w', 'p', 'e'].sort().join();

function checkSnap(s) {
  const err = (w) => { if (snapErrors.length < 20) snapErrors.push(w + ' :: ' + JSON.stringify(s).slice(0, 300)); };
  if (s.g === GAME.GOLF) return checkGolfSnap(s, err);
  if (s.g === GAME.KLOSS) return checkKlossSnap(s, err);
  const paket = s.g === GAME.PAKET;
  if (Object.keys(s).sort().join() !== (paket ? PAKET_KEYS : SNAP_KEYS)) return err('snapshot keys');
  if (s.g !== GAME.KNUFF && !paket) err('g');
  if (paket) {
    if (!Number.isInteger(s.ca) || s.ca < -1) err('ca');
    if (!cents(s.fu) || s.fu < 0 || s.fu > 1 || (s.ca < 0 && s.fu !== 0)) err('fu');
    if (s.rg !== s.r0 || s.wf !== -1) err('paket: rings never fall');
    if (s.ph !== PHASE.COUNTDOWN && s.ph !== PHASE.PLAYING && s.ca !== -1) err('paket: parcel outside a round');
    if (s.ph === PHASE.COUNTDOWN && (s.ca < 0 || s.fu !== 0)) err('paket: carrier shown in the countdown');
    if (s.ca >= 0 && !s.p.some((b) => b[0] === s.ca)) err('paket: carrier without a body');
  }
  if (!Number.isInteger(s.ts) || s.ts < 0) err('ts');
  if (!Object.values(PHASE).includes(s.ph)) err('ph');
  if (!isNum(s.pt) || s.pt < 0 || !cents(s.pt)) err('pt');
  if (!Number.isInteger(s.rd) || s.rd < 0 || s.rd > LIMITS.MAX_ROUNDS) err('rd');
  if (s.ph === PHASE.LOBBY && s.rd !== 0) err('rd in lobby');
  if (!Number.isInteger(s.rn) || s.rn < LIMITS.MIN_ROUNDS || s.rn > LIMITS.MAX_ROUNDS) err('rn');
  if (!Number.isInteger(s.r0) || s.r0 < SIM.MIN_RINGS || s.r0 > SIM.MAX_RINGS) err('r0');
  if (!Number.isInteger(s.rg) || s.rg < -1 || s.rg > s.r0) err('rg');
  if (!isNum(s.wf) || !cents(s.wf) || (s.wf < 0 && s.wf !== -1)) err('wf');
  if (s.ph !== PHASE.PLAYING && s.wf !== -1) err('wf outside PLAYING');
  if (!paket && s.ph === PHASE.PLAYING && s.rg >= 0 && s.wf < 0) err('wf missing in PLAYING');
  if ((s.ph === PHASE.LOBBY || s.ph === PHASE.MATCH_END) && s.rg !== s.r0) err('arena not intact in free play');
  if (!Array.isArray(s.p) || !Array.isArray(s.e)) return err('p/e arrays');
  const ids = new Set();
  for (const b of s.p) {
    if (!Array.isArray(b) || b.length !== 7) { err('body length'); continue; }
    const [id, x, y, z, face, st, cd] = b;
    if (!Number.isInteger(id) || ids.has(id)) err('body id');
    ids.add(id);
    if (!cents(x) || !cents(y) || !cents(z) || !cents(face)) err('body coords rounding');
    if (Math.abs(face) > 3.15) err('face range');
    if (z > 0 || z < SIM.KILL_Z - 2) err('z range');
    if (!Number.isInteger(st) || st < 0 || st > 7) err('st');
    if (!(st & ST.FALLING) && z !== 0) err('z while standing');
    if (!(st & ST.FALLING) && Math.hypot(x, y) > SIM.CORE_R + SIM.MAX_RINGS * SIM.RING_W + 0.5) err('standing off arena');
    if ((st & ST.FROZEN) && s.ph !== PHASE.COUNTDOWN) err('frozen outside countdown');
    if (s.ph === PHASE.COUNTDOWN && !(st & ST.FROZEN)) err('not frozen in countdown');
    if (!cents(cd) || cd < 0 || cd > 1) err('cd');
  }
  for (const e of s.e) {
    if (!Array.isArray(e)) { err('event'); continue; }
    switch (e[0]) {
      case 'hit': if (e.length !== 6 || !e.slice(1, 4).every(cents) || !Number.isInteger(e[4]) || !Number.isInteger(e[5])) err('hit event'); break;
      case 'dash': if (e.length !== 2 || !Number.isInteger(e[1])) err('dash event'); break;
      case 'fall': if (e.length !== 4 || !Number.isInteger(e[1]) || !Number.isInteger(e[2]) || e[2] < -1 || !Number.isInteger(e[3]) || e[3] < 0 || e[3] > 999) err('fall event'); break;
      case 'ring': if (e.length !== 2 || !Number.isInteger(e[1]) || e[1] !== s.rg) err('ring event'); break;
      case 'spawn': if (e.length !== 2 || !Number.isInteger(e[1])) err('spawn event'); break;
      case 'parcel': if (!paket || e.length !== 2 || !Number.isInteger(e[1])) err('parcel event'); break;
      case 'pass': if (!paket || e.length !== 3 || !Number.isInteger(e[1]) || !Number.isInteger(e[2]) || e[1] === e[2]) err('pass event'); break;
      case 'pop': if (!paket || e.length !== 3 || !Number.isInteger(e[1]) || !Number.isInteger(e[2]) || e[2] < 0 || e[2] > 999 || s.p.some((b) => b[0] === e[1])) err('pop event'); break;
      default: err('unknown event ' + e[0]);
    }
  }
}

function checkGolfSnap(s, err) {
  if (Object.keys(s).sort().join() !== GOLF_KEYS) return err('golf snapshot keys');
  if (!Number.isInteger(s.ts) || s.ts < 0) err('ts');
  if (!Object.values(PHASE).includes(s.ph)) err('ph');
  const free = s.ph === PHASE.LOBBY || s.ph === PHASE.MATCH_END;
  if (!isNum(s.pt) || s.pt < 0 || !cents(s.pt)) err('pt');
  if ((s.ph === PHASE.COUNTDOWN && s.pt > GOLF.INTRO_T) || (s.ph === PHASE.ROUND_END && s.pt > GOLF.HOLE_END_T)) err('pt range');
  if (!Number.isInteger(s.rd) || s.rd < 0 || s.rd > COURSES.length - 1) err('rd');
  if (s.ph === PHASE.LOBBY && s.rd !== 0) err('rd in lobby');
  if (!Number.isInteger(s.rn) || s.rn < 1 || s.rn > COURSES.length - 1) err('rn');
  if (!Number.isInteger(s.ci) || s.ci < 0 || s.ci >= COURSES.length) err('ci');
  if (free && s.ci !== 0) err('practice green in free play');
  if (!free && s.ci !== s.rd) err('ci follows the hole');
  if (!isNum(s.ht) || s.ht < 0 || !cents(s.ht)) err('ht');
  if (!isNum(s.tl) || !cents(s.tl)) err('tl');
  if (s.ph === PHASE.PLAYING ? (s.tl < 0 || s.tl > GOLF.HOLE_TIME) : s.tl !== -1) err('tl range');
  if (!Array.isArray(s.p) || !Array.isArray(s.e)) return err('p/e arrays');
  const ids = new Set();
  const course = COURSES[s.ci] || COURSES[0];
  for (const b of s.p) {
    if (!Array.isArray(b) || b.length !== 6) { err('ball length'); continue; }
    const [id, x, y, z, st, n] = b;
    if (!Number.isInteger(id) || ids.has(id)) err('ball id');
    ids.add(id);
    if (!cents(x) || !cents(y) || !cents(z)) err('ball coords rounding');
    if (!Number.isInteger(st) || st < 0 || st > 7) err('ball st');
    if (!(st & BALL.FALLING) && !(st & BALL.HOLED) && (z !== 0 || !onGround(course, x, y))) err('resting ball off the green');
    if ((st & BALL.HOLED) && (Math.hypot(x - course.cup[0], y - course.cup[1]) > 0.02 || z >= 0)) err('holed ball not in the cup');
    if (!Number.isInteger(n) || n < 0 || (!free && n > GOLF.MAX_STROKES + 4)) err('strokes ' + n);
  }
  for (const e of s.e) {
    if (!Array.isArray(e)) { err('event'); continue; }
    switch (e[0]) {
      case 'shot': if (e.length !== 3 || !Number.isInteger(e[1]) || !cents(e[2]) || e[2] < 0 || e[2] > 1) err('shot event'); break;
      case 'bounce': if (e.length !== 5 || !e.slice(1, 4).every(cents) || ![0, 1, 2].includes(e[4])) err('bounce event'); break;
      case 'holed': if (e.length !== 4 || !Number.isInteger(e[1]) || !Number.isInteger(e[2]) || e[2] < 1 || !Number.isInteger(e[3]) || e[3] < 0 || e[3] > 999) err('holed event'); break;
      case 'boost': case 'oob': case 'reset': case 'spawn': if (e.length !== 2 || !Number.isInteger(e[1])) err(e[0] + ' event'); break;
      default: err('unknown golf event ' + e[0]);
    }
  }
}

function checkKlossSnap(s, err) {
  if (Object.keys(s).sort().join() !== KLOSS_KEYS) return err('kloss snapshot keys');
  if (!Number.isInteger(s.ts) || s.ts < 0) err('ts');
  if (!Object.values(PHASE).includes(s.ph)) err('ph');
  const free = s.ph === PHASE.LOBBY || s.ph === PHASE.MATCH_END;
  if (!isNum(s.pt) || s.pt < 0 || !cents(s.pt)) err('pt');
  if ((s.ph === PHASE.COUNTDOWN && s.pt > KG.INTRO_T) || (s.ph === PHASE.ROUND_END && s.pt > KG.HOLE_END_T)) err('pt range');
  if (!Number.isInteger(s.rd) || s.rd < 0 || s.rd > KCOURSES.length - 1) err('rd');
  if (s.ph === PHASE.LOBBY && s.rd !== 0) err('rd in lobby');
  if (!Number.isInteger(s.rn) || s.rn < 1 || s.rn > KCOURSES.length - 1) err('rn');
  if (!Number.isInteger(s.ci) || s.ci < 0 || s.ci >= KCOURSES.length) return err('ci');
  if (free && s.ci !== 0) err('practice range in free play');
  if (!free && s.ci !== s.rd) err('ci follows the hole');
  const course = KCOURSES[s.ci];
  if (!isNum(s.tl) || !cents(s.tl)) err('tl');
  if (s.ph === PHASE.PLAYING ? (s.tl < 0 || s.tl > holeClock(course)) : s.tl !== -1) err('tl range');
  if (!Array.isArray(s.w) || s.w.length !== 2 || !s.w.every((v) => isNum(v) && Math.abs(v * 10 - Math.round(v * 10)) < 1e-6)) err('w');
  else if (Math.hypot(s.w[0], s.w[1]) > KG.MAX_WIND + 0.15 || (free && (s.w[0] !== 0 || s.w[1] !== 0))) err('w range');
  if (!Array.isArray(s.p) || !Array.isArray(s.e)) return err('p/e arrays');
  const ids = new Set();
  for (const b of s.p) {
    if (!Array.isArray(b) || b.length !== 8) { err('kloss ball length'); continue; }
    const [id, x, y, z, st, n, fx, fy] = b;
    if (!Number.isInteger(id) || ids.has(id)) err('ball id');
    ids.add(id);
    if (![x, y, z, fx, fy].every(cents)) err('kloss coords rounding');
    if (!Number.isInteger(st) || st < 0 || st > 15) err('kloss st');
    const busy = st & (KST.MOVING | KST.HOLED | KST.HAZARD);
    if ((st & KST.READY) && busy) err('READY while not at rest');
    if ((st & KST.READY) && (Math.hypot(fx - x, fy - y) > KG.REACH + 0.02 || s.ph === PHASE.COUNTDOWN || s.ph === PHASE.ROUND_END)) err('READY without the figure or outside play');
    if (!busy) {
      const g = surfaceAt(course, x, y);
      if (z !== 0 || g === SURF.WATER || g === SURF.OOB) err('resting ball in a hazard or in the air');
    }
    if ((st & KST.HOLED) && (Math.hypot(x - course.cup[0], y - course.cup[1]) > 0.02 || z !== 0)) err('holed ball not in the cup');
    if (z < 0) err('ball below ground');
    if (!Number.isInteger(n) || n < 0 || (!free && n > maxStrokes(course) + 1)) err('strokes ' + n);
  }
  for (const e of s.e) {
    if (!Array.isArray(e) || !Number.isInteger(e[1])) { err('event'); continue; }
    switch (e[0]) {
      case 'shot': if (e.length !== 5 || !Number.isInteger(e[2]) || e[2] < 0 || e[2] >= CLUBS.length || !cents(e[3]) || e[3] < KG.MIN_POWER - 0.005 || e[3] > 1 || !cents(e[4]) || Math.abs(e[4]) > 3.15) err('shot event'); break;
      case 'land': if (e.length !== 6 || !cents(e[2]) || !cents(e[3]) || !Object.values(SURF).includes(e[4]) || !cents(e[5]) || e[5] < 0) err('land event'); break;
      case 'tree': if (e.length !== 5 || !e.slice(2).every(cents)) err('tree event'); break;
      case 'splash': case 'oob': if (e.length !== 4 || !cents(e[2]) || !cents(e[3])) err(e[0] + ' event'); break;
      case 'holed': if (e.length !== 5 || !Number.isInteger(e[2]) || e[2] < 1 || !Number.isInteger(e[3]) || e[3] < 0 || e[3] > 999 || (e[4] !== 0 && e[4] !== 1)) err('holed event'); break;
      case 'reset': case 'spawn': if (e.length !== 2) err(e[0] + ' event'); break;
      default: err('unknown kloss event ' + e[0]);
    }
  }
}

// ------------------------------------------------------------------ main

async function main() {
  PORT = await freePort();
  log(`starting server on port ${PORT} at ${SPEED}x speed`);
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', KK_CODE: CODE, KK_HOST_KEY: KEY, KK_TEST_SPEED: String(SPEED) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  for (let i = 0; i < 100 && !serverOut.includes('Rumskod'); i++) await sleep(50);
  await sleep(100);
  ok(serverOut.includes(`http://localhost:${PORT}/?k=${CODE}`), 'prints player link');
  ok(serverOut.includes(`http://localhost:${PORT}/?host=${KEY}`), 'prints host link');
  ok(/tunnel/i.test(serverOut), 'mentions the tunnel');

  // HTTP
  const idx = await httpGet(PORT, '/');
  ok(idx.status === 200 && idx.body.includes('<html'), 'serves index.html');
  ok((await httpGet(PORT, '/%2e%2e/server/server.js')).status === 404, 'no path traversal');
  ok((await httpGet(PORT, '/ws')).status === 404, 'plain GET /ws is harmless');
  const health = await httpGet(PORT, '/health');
  ok(health.status === 200 && health.body.trim() === 'ok', 'health check answers ok');
  ok(serverOut.includes(`http://localhost:${PORT}/?k=${CODE}&host=${KEY}`), 'prints the playing-host link');

  // An idle socket that never authenticates: must be closed after ~15 s.
  const idle = await connect('idle', '10.0.0.50');
  const idleOpenedAt = Date.now();

  // ---- join
  const a = await connect('A', '10.0.0.1');
  let since = a.mark();
  a.send({ t: 'join', name: 'Anna', code: 'NOPE' });
  ok((await a.wait((m) => m.t === 'err', 'err code', 4000, since)).m === 'code', 'wrong code -> err code');
  await joinOk(a, '  Anna​ ‮  Svensson\u0007\n ');
  let ro = lastRoster(a);
  const meA = ro.players.find((p) => p.id === a.id);
  ok(meA && meA.name === 'Anna Svensson', `name cleaned (got ${JSON.stringify(meA && meA.name)})`);
  ok(meA.bot === false && meA.on === true && meA.score === 0 && meA.kos === 0 && meA.color === 0, 'roster entry fields');
  ok(ro.bots === 0 && Number.isInteger(ro.rounds), 'roster bots/rounds');

  const b = await connect('B', '10.0.0.2');
  await joinOk(b, 'anna svensson');
  ro = await a.wait((m) => m.t === 'roster' && m.players.length === 2, 'roster with 2', 4000, 0);
  const meB = ro.players.find((p) => p.id === b.id);
  ok(meB.name === 'anna svensson 2' && meB.color === 1, `duplicate name / colour (got ${meB.name}, ${meB.color})`);

  const longName = await connect('Long', '10.0.0.3');
  await joinOk(longName, 'Abcdefghijklmnopqrstuvwxyz');
  ro = lastRoster(longName);
  ok(ro.players.find((p) => p.id === longName.id).name === 'Abcdefghijklmnop', 'name cut to NAME_MAX');
  longName.close();

  const c = await connect('C', '10.0.0.4');
  since = c.mark();
  c.send({ t: 'join', name: ' ​​  \u0000 ', code: CODE });
  ok((await c.wait((m) => m.t === 'err', 'err name', 4000, since)).m === 'name', 'empty name -> err name');
  c.close();

  // ---- host
  const h = await connect('Host', '10.0.0.10');
  since = h.mark();
  h.send({ t: 'host', key: 'wrongwrongwrong1' });
  ok((await h.wait((m) => m.t === 'err', 'err key', 4000, since)).m === 'key', 'wrong host key -> err key');
  since = h.mark();
  h.send({ t: 'host', key: KEY });
  const hosted = await h.wait((m) => m.t === 'hosted', 'hosted', 4000, since);
  ok(hosted.code === CODE, 'hosted carries the code');
  await h.wait((m) => m.t === 'roster', 'host gets roster', 4000, since);
  h.onSnap = checkSnap;
  const h2 = await connect('Host2', '10.0.0.11');
  h2.send({ t: 'host', key: KEY });
  await h2.wait((m) => m.t === 'hosted', 'second host', 4000, 0);

  // ---- snapshot shape in the lobby
  await h.wait((m) => m.t === 's' && m.p.length >= 2, 'lobby snapshot');
  let s = h.snap;
  checkSnap(s);
  ok(s.ph === PHASE.LOBBY && s.rd === 0 && s.wf === -1 && s.r0 >= SIM.LOBBY_RINGS && s.rg === s.r0, 'lobby snapshot values');
  ok(s.p.some((p) => p[0] === a.id) && s.p.some((p) => p[0] === b.id), 'lobby bodies exist for players');

  // ---- input moves the body
  const ax0 = s.p.find((p) => p[0] === a.id)[1];
  const ay0 = s.p.find((p) => p[0] === a.id)[2];
  // Steer toward the centre so the body cannot fall off at 10x speed.
  const [ux, uy] = Math.hypot(ax0, ay0) > 1 ? [-ax0 / Math.hypot(ax0, ay0), -ay0 / Math.hypot(ax0, ay0)] : [1, 0];
  a.send({ t: 'in', x: ux, y: uy, d: 0 });
  await sleep(60);
  a.send({ t: 'in', x: 0, y: 0, d: 0 });
  await sleep(60);
  const aBody = h.snap.p.find((p) => p[0] === a.id);
  ok(aBody && Math.hypot(aBody[1] - ax0, aBody[2] - ay0) > 0.3, 'input moves the body');

  // ---- non-host cmd is ignored
  since = a.mark();
  a.send({ t: 'cmd', c: 'bots', v: 5 });
  a.send({ t: 'cmd', c: 'start' });
  await sleep(300);
  ok(h.snap.ph === PHASE.LOBBY, 'non-host start ignored');
  ok(lastRoster(h).bots === 0, 'non-host bots ignored');

  // ---- ping
  a.send({ t: 'ping', c: 42 });
  ok((await a.wait((m) => m.t === 'pong', 'pong', 4000, since)).c === 42, 'ping -> pong');

  // ---- reconnect keeps the id
  const aToken = a.token, aId = a.id;
  a.close();
  await h.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === aId && p.on === false), 'roster shows A offline');
  const a2 = await connect('A2', '10.0.0.1');
  await joinOk(a2, 'Impostor', aToken);
  ok(a2.id === aId, 'reconnect with token keeps the same id');
  ro = lastRoster(a2);
  ok(ro.players.find((p) => p.id === aId).name === 'Anna Svensson' && ro.players.find((p) => p.id === aId).on, 'reconnected player keeps name, is on');

  // ---- kick
  const bId = b.id, bToken = b.token;
  since = b.mark();
  h.send({ t: 'cmd', c: 'kick', v: bId });
  await b.wait((m) => m.t === 'kicked', 'kicked', 4000, since);
  await b.waitClose('kicked socket closes');
  await h.wait((m) => m.t === 'roster' && !m.players.some((p) => p.id === bId), 'roster without kicked player', 4000, 0);
  const b2 = await connect('B2', '10.0.0.2');
  await joinOk(b2, 'Bertil', bToken);
  ok(b2.id !== bId, 'kicked token is invalid');

  // ---- garbage barrage from an authenticated player socket
  const g = await connect('Garbage', '10.0.0.66');
  await joinOk(g, 'Garbage');
  const onIds = (r) => r.players.filter((p) => p.on).map((p) => p.id).sort().join();
  await sleep(100);
  const onBefore = onIds(lastRoster(h));
  const junk = [
    'not json', '', '{', '[]', 'null', '42', '"str"', '{"t":5}', '{"t":null}', '{"t":{}}',
    '{"t":"in"}', '{"t":"in","x":"1","y":0}', '{"t":"in","x":1e999,"y":0}', '{"t":"in","x":null,"y":[]}',
    '{"t":"in","x":1e300,"y":-1e300,"d":1}', '{"t":"in","x":0.5,"y":0.5,"d":"yes"}',
    '{"t":"cmd","c":"start"}', '{"t":"cmd","c":"lobby"}', '{"t":"cmd","c":"kick","v":1}',
    '{"__proto__":{"t":"cmd"},"t":"x"}', '{"constructor":{"prototype":{"role":"host"}},"t":"cmd","c":"start"}',
    '{"t":"join","name":{},"code":[]}', '{"t":"join","name":"x","code":"' + CODE + '"}',
    '{"t":"host","key":{"length":16}}', '{"t":"host","key":null}',
    '{"t":"ping","c":{"a":1}}', '{"t":"ping","c":"' + 'x'.repeat(200) + '"}', '{"t":"toString"}', '{"t":"hasOwnProperty"}',
    JSON.stringify({ t: 'in', x: 0, y: 0, d: 0, pad: '\u0000\ud800'.repeat(50) }),
  ];
  const hBefore = h.mark();
  for (const j of junk) g.send(j);
  g.send(Buffer.from([0, 1, 2, 3, 255]));
  g.ws.send(Buffer.from('{"t":"cmd","c":"start"}'), { binary: true });
  await sleep(300);
  ok(!g.closed, 'garbage (below rate limit) does not close an authenticated socket');
  ok(h.snap.ph === PHASE.LOBBY, 'garbage did not change the phase');
  ok(onIds(lastRoster(h)) === onBefore, 'garbage did not add/kick players');
  ok(!h.log.slice(hBefore).some((m) => m.t === 'err'), 'host saw no errors');

  // flood: > 120 messages / s closes the socket
  const flood = await connect('Flood', '10.0.0.67');
  for (let i = 0; i < 300; i++) flood.send('{"t":"ping","c":1}');
  await flood.waitClose('flooding socket closed');
  ok(true, 'flood closed');

  // oversized message closes the socket with 1009
  const big = await connect('Big', '10.0.0.68');
  big.send(JSON.stringify({ t: 'join', name: 'x'.repeat(5000), code: CODE }));
  const bc = await big.waitClose('oversized socket closed');
  ok(bc.code === 1009, `oversized message -> 1009 (got ${bc.code})`);

  // 8 failed joins on one socket close it
  const brute = await connect('Brute', '10.0.0.69');
  for (let i = 0; i < 10; i++) brute.send({ t: 'join', name: 'x', code: 'ZZZ' + i });
  await brute.waitClose('brute-force socket closed');
  ok(brute.log.filter((m) => m.t === 'err').length === 8, 'exactly 8 failures answered before close');

  // 30 failures per IP -> err rate even with the right code
  for (let k = 0; k < 4; k++) {
    const x = await connect('IpBrute' + k, '10.9.9.9');
    for (let i = 0; i < 8; i++) x.send({ t: 'host', key: 'nope' + i });
    await x.waitClose('ip brute socket closed');
  }
  const late = await connect('Late', '10.9.9.9');
  since = late.mark();
  late.send({ t: 'join', name: 'Late', code: CODE });
  ok((await late.wait((m) => m.t === 'err', 'err rate', 4000, since)).m === 'rate', 'IP over limit -> err rate');
  late.close();
  const other = await connect('OtherIp', '10.9.9.10');
  await joinOk(other, 'Annan');
  other.close();

  ok(h.snap.ph === PHASE.LOBBY && !h.closed && !a2.closed, 'game undisturbed after abuse');

  // ---- a match with bots
  const phases = [];
  const ringEvents = [];
  const fallEvents = [];
  let lastRg = null;
  let rgMonotone = true;
  const participants = {}; // rd -> ids at countdown
  let midJoinerId = -1;
  let midJoinerSeen = false;
  h.onSnap = (sn) => {
    checkSnap(sn);
    if ((phases.length || sn.ph === PHASE.COUNTDOWN) && phases[phases.length - 1] !== sn.ph) phases.push(sn.ph);
    if (sn.ph === PHASE.COUNTDOWN && !participants[sn.rd]) participants[sn.rd] = sn.p.map((p) => p[0]);
    if (sn.ph === PHASE.PLAYING) {
      if (lastRg !== null && sn.rg > lastRg) rgMonotone = false;
      lastRg = sn.rg;
    } else if (sn.ph === PHASE.COUNTDOWN) lastRg = null;
    for (const e of sn.e) {
      if (e[0] === 'ring') ringEvents.push([sn.rd, e[1]]);
      if (e[0] === 'fall') fallEvents.push(e);
    }
    if (midJoinerId >= 0 && sn.ph !== PHASE.MATCH_END && sn.p.some((p) => p[0] === midJoinerId)) midJoinerSeen = true;
  };

  since = h.mark();
  h.send({ t: 'cmd', c: 'rounds', v: 2 });
  h.send({ t: 'cmd', c: 'bots', v: 4 });
  ro = await h.wait((m) => m.t === 'roster' && m.bots === 4 && m.rounds === 2 && m.players.filter((p) => p.bot).length === 4, 'roster with 4 bots', 4000, since);
  const botNames = ro.players.filter((p) => p.bot).map((p) => p.name);
  ok(botNames.every((n) => n.length <= LIMITS.NAME_MAX && /Bot/.test(n)), 'bot names');
  ok(new Set(ro.players.map((p) => p.color)).size === ro.players.length, 'distinct colours');
  ok(ro.players.every((p) => p.color >= 0 && p.color < PALETTE.length), 'colours in palette');

  // Closed sockets leave after their grace; let that happen before the match, not during it.
  for (let i = 0; i < 80 && lastRoster(h).players.some((p) => !p.on); i++) await sleep(100);
  ok(!lastRoster(h).players.some((p) => !p.on), 'closed sockets have left before the match');
  since = h.mark();
  const matchStart = Date.now();
  h.send({ t: 'cmd', c: 'start' });
  await h.wait((m) => m.t === 's' && m.ph === PHASE.COUNTDOWN && m.rd === 1, 'countdown');

  // a non-host 'lobby' mid-round is ignored; garbage keeps flowing
  a2.send({ t: 'cmd', c: 'lobby' });
  for (const j of junk.slice(0, 20)) g.send(j);

  const round1 = await h.wait((m) => m.t === 'round' && m.rd === 1, 'round 1 result', 15000, since);
  // join during ROUND_END: gets roster + the latest round message
  const re = await connect('RoundEndJoiner', '10.0.0.70');
  const reSince = re.mark();
  await joinOk(re, 'Sen Ankomst');
  const reFirst = await re.wait((m) => m.t === 's', 'first snapshot');
  if (reFirst.ph === PHASE.ROUND_END) { // joined while ROUND_END (phases never go back)
    await re.wait((m) => m.t === 'round' && m.rd === 1, 'round msg to late joiner', 2000, reSince);
  }

  // join during PLAYING of round 2: no body until the match ends
  await h.wait((m) => m.t === 's' && m.ph === PHASE.PLAYING && m.rd === 2, 'round 2 playing', 15000);
  const mid = await connect('MidJoiner', '10.0.0.71');
  await joinOk(mid, 'Mitt I');
  midJoinerId = mid.id;

  const round2 = await h.wait((m) => m.t === 'round' && m.rd === 2, 'round 2 result', 15000, since);
  const match = await h.wait((m) => m.t === 'match', 'match result', 15000, since);
  await h.wait((m) => m.t === 's' && m.ph === PHASE.MATCH_END, 'MATCH_END snapshot');
  log(`match took ${((Date.now() - matchStart) / 1000).toFixed(1)}s real time`);

  ok(JSON.stringify(phases) === JSON.stringify([PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.MATCH_END]),
    `phase sequence (got ${JSON.stringify(phases)})`);
  ok(rgMonotone, 'rings only decrease during a round');
  ok(ringEvents.length >= 1, 'at least one ring fell');
  ok(!midJoinerSeen, 'mid-round joiner has no body during the round');
  await h.wait((m) => m.t === 's' && m.p.some((p) => p[0] === mid.id), 'mid joiner gets a body in MATCH_END');

  // scores
  const totals = {};
  const kosFromPts = {};
  for (const r of [round1, round2]) {
    const ids = participants[r.rd];
    ok(Array.isArray(ids) && ids.length >= 2, `participants of round ${r.rd}`);
    ok(r.order.length === ids.length && ids.every((id) => r.order.includes(id)), `round ${r.rd} order covers participants`);
    ok(r.winner === r.order[0], `round ${r.rd} winner is first`);
    const n = ids.length;
    r.order.forEach((id, i) => {
      const base = (n - 1 - i) + (i === 0 ? 2 : 0);
      const extra = r.pts[id] - base;
      ok(Number.isInteger(r.pts[id]) && extra >= 0, `round ${r.rd} pts for ${id} >= placing points`);
      totals[id] = (totals[id] || 0) + r.pts[id];
      kosFromPts[id] = (kosFromPts[id] || 0) + extra;
    });
  }
  const st = match.standings;
  ok(st.length >= 7, 'standings list everyone');
  for (let i = 1; i < st.length; i++) ok(st[i - 1].score >= st[i].score, 'standings sorted by score');
  for (const p of st) {
    ok(p.score === (totals[p.id] || 0), `score of ${p.name} = sum of round points (${p.score} vs ${totals[p.id] || 0})`);
    ok(p.kos === (kosFromPts[p.id] || 0), `kos of ${p.name} match round points`);
    ok(['id', 'name', 'color', 'bot', 'score', 'kos'].every((k) => k in p), 'standing fields');
  }
  const credited = fallEvents.filter((e) => e[2] >= 0).length;
  ok(st.reduce((s2, p) => s2 + p.kos, 0) <= credited, 'KOs never exceed credited falls');

  // join during MATCH_END: receives the match message
  const me = await connect('MatchEndJoiner', '10.0.0.72');
  const meSince = me.mark();
  await joinOk(me, 'Efterhand');
  await me.wait((m) => m.t === 'match', 'match msg to late joiner', 3000, meSince);

  // back to lobby
  h.send({ t: 'cmd', c: 'lobby' });
  await h.wait((m) => m.t === 's' && m.ph === PHASE.LOBBY && m.rd === 0, 'back in lobby');

  // ---- switch to minigolf: same players, ids, tokens, colours; scores reset
  const rosterKey = (r) => r.players.map((p) => [p.id, p.name, p.color, p.bot, p.on].join(':')).sort().join('|');
  await sleep(200);
  const knuffRoster = lastRoster(h);
  ok(knuffRoster.game === GAME.KNUFF, 'roster carries game = KNUFF');
  since = h.mark();
  a2.send({ t: 'cmd', c: 'game', v: GAME.GOLF });
  await sleep(200);
  ok(h.snap.g === GAME.KNUFF, 'non-host game switch ignored');
  h.send({ t: 'cmd', c: 'game', v: 7 });
  h.send({ t: 'cmd', c: 'game', v: GAME.GOLF });
  ro = await h.wait((m) => m.t === 'roster' && m.game === GAME.GOLF, 'golf roster', 4000, since);
  await h.wait((m) => m.t === 's' && m.g === GAME.GOLF, 'golf snapshot');
  ok(rosterKey(ro) === rosterKey(knuffRoster), 'switching game keeps ids, names, colours, bot flags, connection state');
  ok(ro.bots === knuffRoster.bots && ro.rounds === knuffRoster.rounds, 'switching keeps bot and round settings');
  ok(ro.players.every((p) => p.score === 0 && p.kos === 0 && p.hs === 0 && p.in === false), 'golf roster: scores reset, hs / in present');
  const a3 = await connect('A3', '10.0.0.1');
  await joinOk(a3, 'Whoever', aToken);
  ok(a3.id === aId, 'token from before the switch still binds the same id');
  await a2.waitClose('replaced socket closes');
  s = await h.wait((m) => m.t === 's' && m.p.length === ro.players.length, 'every player has a ball');
  ok(s.ph === PHASE.LOBBY && s.ci === 0 && s.rd === 0 && s.tl === -1, 'golf lobby is the practice green');

  // ---- shots: garbage, non-players and a moving ball are ignored
  const shotsOf = (id) => { let n = 0; const prev = h.onSnap; return { stop: () => { h.onSnap = prev; return n; }, start() { h.onSnap = (sn) => { prev(sn); for (const e of sn.e) if (e[0] === 'shot' && e[1] === id) n++; }; return this; } }; };
  h.onSnap = (sn) => checkSnap(sn);
  let counter = shotsOf(a3.id).start();
  for (const j of ['{"t":"shot"}', '{"t":"shot","x":"5","y":0}', '{"t":"shot","x":1e999,"y":0}', '{"t":"shot","x":null,"y":[]}',
    '{"t":"shot","x":0,"y":0}', '{"t":"shot","x":{},"y":1}', '{"t":"shot","x":5}']) a3.send(j);
  h.send({ t: 'shot', x: 5, y: 0 });
  await sleep(300);
  ok(counter.stop() === 0, 'garbage and host shots are ignored');
  ok(lastRoster(h).players.find((p) => p.id === a3.id).hs === 0, 'no stroke counted for ignored shots');
  counter = shotsOf(a3.id).start();
  since = h.mark();
  a3.send({ t: 'shot', x: 1e6, y: 0.5 });
  a3.send({ t: 'shot', x: -4, y: 0 });
  await sleep(150);
  const moving = h.snap.p.find((p) => p[0] === a3.id);
  ok(moving && (moving[4] & BALL.MOVING), 'a shot sets the ball rolling');
  a3.send({ t: 'shot', x: -4, y: 2 });
  await sleep(200);
  ok(counter.stop() === 1, 'a second shot while the ball moves is ignored');
  await h.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === a3.id && p.hs === 1), 'roster shows one stroke', 4000, since);

  // ---- a golf match with bots: 2 holes; a player joins during hole 2
  const gPhases = [];
  const gStart = {};
  let golfMidId = -1, golfMidBall = false, switchedMidMatch = false;
  h.onSnap = (sn) => {
    checkSnap(sn);
    if (sn.g !== GAME.GOLF) switchedMidMatch = true;
    if ((gPhases.length || sn.ph === PHASE.COUNTDOWN) && gPhases[gPhases.length - 1] !== sn.ph) gPhases.push(sn.ph);
    if (sn.ph === PHASE.COUNTDOWN && !gStart[sn.rd]) gStart[sn.rd] = sn.p.map((p) => p[0]);
    if (golfMidId >= 0 && sn.ph === PHASE.PLAYING && sn.p.some((p) => p[0] === golfMidId)) golfMidBall = true;
  };
  since = h.mark();
  h.send({ t: 'cmd', c: 'rounds', v: 2 });
  h.send({ t: 'cmd', c: 'start' });
  await h.wait((m) => m.t === 's' && m.ph === PHASE.COUNTDOWN && m.rd === 1 && m.ci === 1, 'golf hole 1 intro');
  h.send({ t: 'cmd', c: 'game', v: GAME.KNUFF });   // not allowed mid-match
  const g1 = await h.wait((m) => m.t === 'round' && m.rd === 1, 'golf hole 1 result', 20000, since);
  await h.wait((m) => m.t === 's' && m.ph === PHASE.PLAYING && m.rd === 2, 'golf hole 2 playing', 15000);
  const gm = await connect('GolfMid', '10.0.0.73');
  await joinOk(gm, 'Golfsen');
  golfMidId = gm.id;
  const g2 = await h.wait((m) => m.t === 'round' && m.rd === 2, 'golf hole 2 result', 20000, since);
  const gMatch = await h.wait((m) => m.t === 'match', 'golf match result', 15000, since);
  await h.wait((m) => m.t === 's' && m.ph === PHASE.MATCH_END && m.ci === 0, 'golf MATCH_END on the practice green');
  ok(!switchedMidMatch, 'game switch ignored mid-match');
  ok(JSON.stringify(gPhases) === JSON.stringify([PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.MATCH_END]),
    `golf phase sequence (got ${JSON.stringify(gPhases)})`);
  ok(golfMidBall, 'mid-match joiner gets a ball on the hole in progress');
  ok(g1.g === GAME.GOLF && g1.ci === 1 && g2.ci === 2 && gMatch.g === GAME.GOLF, 'golf round / match messages carry g and ci');
  const gTotals = {}, gAces = {};
  for (const r of [g1, g2]) {
    const ids = gStart[r.rd].concat(r.rd === 2 ? [golfMidId] : []);
    ok(r.order.length === ids.length && ids.every((id) => r.order.includes(id)), `golf hole ${r.rd} order covers players`);
    ok(r.winner === r.order[0], `golf hole ${r.rd} winner is first`);
    for (let i = 1; i < r.order.length; i++) ok(r.pts[r.order[i - 1]] <= r.pts[r.order[i]], `golf hole ${r.rd} order by strokes`);
    for (const id of r.order) {
      const v = r.pts[id];
      ok(Number.isInteger(v) && v >= 1 && v <= GOLF.MAX_STROKES + 1 + GOLF.DNF_PENALTY, `golf hole ${r.rd} strokes of ${id} sane (${v})`);
      gTotals[id] = (gTotals[id] || 0) + v;
      if (v === 1) gAces[id] = (gAces[id] || 0) + 1;
    }
  }
  gTotals[golfMidId] += COURSES[1].par + GOLF.MISSED_HOLE;
  const humanIds = new Set(lastRoster(h).players.filter((p) => !p.bot).map((p) => p.id));
  ok(g1.order.filter((id) => !humanIds.has(id)).filter((id) => g1.pts[id] <= GOLF.MAX_STROKES).length >= 3, 'golf bots hole out on hole 1');
  ok(g1.order.filter((id) => humanIds.has(id)).every((id) => g1.pts[id] === GOLF.MAX_STROKES + GOLF.DNF_PENALTY), 'idle humans get MAX_STROKES + DNF_PENALTY');
  const gst = gMatch.standings;
  for (let i = 1; i < gst.length; i++) ok(gst[i - 1].score <= gst[i].score, 'golf standings: fewest strokes first');
  for (const p of gst) {
    ok(p.score === gTotals[p.id], `golf total of ${p.name} = sum of holes (${p.score} vs ${gTotals[p.id]})`);
    ok(p.kos === (gAces[p.id] || 0), `golf kos of ${p.name} = holes in one`);
  }
  await me.wait((m) => m.t === 'match' && m.g === GAME.GOLF, 'golf match msg to players', 3000, 0);

  // ---- switch to Klossgolf (from golf's MATCH_END): same players, scores reset
  await sleep(200);
  const golfRoster = lastRoster(h);
  since = h.mark();
  h.onSnap = checkSnap;
  a3.send({ t: 'cmd', c: 'game', v: GAME.KLOSS });
  await sleep(200);
  ok(h.snap.g === GAME.GOLF, 'non-host switch to Klossgolf ignored');
  h.send({ t: 'cmd', c: 'game', v: GAME.KLOSS });
  ro = await h.wait((m) => m.t === 'roster' && m.game === GAME.KLOSS, 'kloss roster', 4000, since);
  ok(rosterKey(ro) === rosterKey(golfRoster), 'switching to Klossgolf keeps ids, names, colours, bot flags, connection state');
  ok(ro.bots === golfRoster.bots && ro.rounds === golfRoster.rounds, 'Klossgolf keeps bot and round settings');
  ok(ro.players.every((p) => p.score === 0 && p.kos === 0 && p.hs === 0 && p.in === false), 'kloss roster: scores reset, hs / in present');
  s = await h.wait((m) => m.t === 's' && m.g === GAME.KLOSS && m.p.length === ro.players.length, 'kloss snapshot with every ball');
  ok(s.ph === PHASE.LOBBY && s.ci === 0 && s.rd === 0 && s.tl === -1 && s.w[0] === 0 && s.w[1] === 0, 'Klossgolf lobby is the practice range, no wind');
  await h.wait((m) => m.t === 's' && m.p.some((p) => p[0] === a3.id && (p[4] & KST.READY)), 'own ball READY on the range');

  // ---- reconnect in Klossgolf keeps the id and the ball
  a3.close();
  await h.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === aId && p.on === false), 'kloss roster shows A offline');
  await h.wait((m) => m.t === 's' && m.p.some((p) => p[0] === aId && !(p[4] & KST.READY)), 'an offline player is not READY');
  const a4 = await connect('A4', '10.0.0.1');
  await joinOk(a4, 'Whoever', aToken);
  ok(a4.id === aId, 'kloss: token rebinds the same id');
  await h.wait((m) => m.t === 's' && m.p.some((p) => p[0] === aId && (p[4] & KST.READY)), 'reconnected ball READY again');

  // ---- swings: garbage, non-players and a moving ball are ignored; p is clamped
  counter = shotsOf(a4.id).start();
  for (const j of ['{"t":"swing"}', '{"t":"swing","a":"1","p":0.5,"c":0}', '{"t":"swing","a":1e999,"p":0.5,"c":0}',
    '{"t":"swing","a":1,"p":null,"c":0}', '{"t":"swing","a":1,"p":0.5,"c":4}', '{"t":"swing","a":1,"p":0.5,"c":-1}',
    '{"t":"swing","a":1,"p":0.5,"c":1.5}', '{"t":"swing","a":1,"p":0.5,"c":"0"}', '{"t":"swing","a":1,"p":0.5}',
    '{"t":"swing","a":{},"p":0.5,"c":0}', '{"t":"shot","x":5,"y":0}']) a4.send(j);
  h.send({ t: 'swing', a: Math.PI / 2, p: 0.5, c: 2 });
  await sleep(300);
  ok(counter.stop() === 0, 'garbage swings, a shot and a host swing are ignored');
  ok(lastRoster(h).players.find((p) => p.id === a4.id).hs === 0, 'no stroke for ignored swings');
  const kShots = [];
  const prevSnap = h.onSnap;
  h.onSnap = (sn) => { prevSnap(sn); for (const e of sn.e) if (e[0] === 'shot' && e[1] === a4.id) kShots.push(e); };
  since = h.mark();
  a4.send({ t: 'swing', a: Math.PI / 2, p: 0.3, c: 2 });
  a4.send({ t: 'swing', a: Math.PI / 2, p: 0.3, c: 2 });
  await h.wait((m) => m.t === 's' && m.p.some((p) => p[0] === a4.id && (p[4] & KST.MOVING)), 'a swing sends the ball off');
  a4.send({ t: 'swing', a: 0, p: 1, c: 0 });
  await h.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === a4.id && p.hs === 1), 'roster shows one stroke', 4000, since);
  await h.wait((m) => m.t === 's' && m.p.some((p) => p[0] === a4.id && (p[4] & KST.READY)), 'figure reaches the ball: READY again', 6000);
  ok(kShots.length === 1 && kShots[0][2] === 2 && kShots[0][3] === 0.3 && Math.abs(kShots[0][4] - Math.PI / 2) < 0.02,
    `one shot event with club, power and angle (got ${JSON.stringify(kShots)})`);
  const kb = h.snap.p.find((p) => p[0] === a4.id);
  ok(kb[2] > 5 && Math.hypot(kb[6] - kb[1], kb[7] - kb[2]) <= KG.REACH, 'the ball flew up the range and the figure ran after it');
  a4.send({ t: 'swing', a: Math.PI / 2, p: 7, c: 3 });
  await h.wait((m) => m.t === 's' && kShots.length === 2, 'clamped swing played');
  ok(kShots[1][2] === 3 && kShots[1][3] === 1, `power above 1 is clamped (got ${JSON.stringify(kShots[1])})`);
  h.onSnap = prevSnap;

  // ---- a Klossgolf match with bots: 2 holes; a player joins during hole 2
  const kPhases = [];
  const kStart = {};
  const kWind = {};
  let kMidId = -1, kMidBall = false, kSwitched = false, kTeeOk = true;
  h.onSnap = (sn) => {
    checkSnap(sn);
    if (sn.g !== GAME.KLOSS) kSwitched = true;
    if ((kPhases.length || sn.ph === PHASE.COUNTDOWN) && kPhases[kPhases.length - 1] !== sn.ph) kPhases.push(sn.ph);
    if (sn.ph === PHASE.COUNTDOWN && !kStart[sn.rd]) {
      kStart[sn.rd] = sn.p.map((p) => p[0]);
      kWind[sn.rd] = sn.w;
      const c = KCOURSES[sn.ci];
      for (const p of sn.p) {
        if (surfaceAt(c, p[1], p[2]) !== SURF.TEE || p[5] !== 0 || Math.hypot(p[6] - p[1], p[7] - p[2]) > KG.REACH) kTeeOk = false;
      }
    }
    if (kMidId >= 0 && sn.ph === PHASE.PLAYING && sn.p.some((p) => p[0] === kMidId)) kMidBall = true;
  };
  since = h.mark();
  h.send({ t: 'cmd', c: 'rounds', v: 2 });
  h.send({ t: 'cmd', c: 'start' });
  await h.wait((m) => m.t === 's' && m.ph === PHASE.COUNTDOWN && m.rd === 1 && m.ci === 1, 'kloss hole 1 intro');
  h.send({ t: 'cmd', c: 'game', v: GAME.KNUFF });   // not allowed mid-match
  const k1 = await h.wait((m) => m.t === 'round' && m.rd === 1, 'kloss hole 1 result', 30000, since);
  await h.wait((m) => m.t === 's' && m.ph === PHASE.PLAYING && m.rd === 2, 'kloss hole 2 playing', 15000);
  const km = await connect('KlossMid', '10.0.0.74');
  await joinOk(km, 'Klossen');
  kMidId = km.id;
  const k2r = await h.wait((m) => m.t === 'round' && m.rd === 2, 'kloss hole 2 result', 30000, since);
  const kMatch = await h.wait((m) => m.t === 'match', 'kloss match result', 15000, since);
  await h.wait((m) => m.t === 's' && m.ph === PHASE.MATCH_END && m.ci === 0, 'kloss MATCH_END on the practice range');
  ok(!kSwitched, 'game switch ignored mid Klossgolf match');
  ok(JSON.stringify(kPhases) === JSON.stringify([PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.MATCH_END]),
    `kloss phase sequence (got ${JSON.stringify(kPhases)})`);
  ok(kTeeOk, 'every ball starts on the tee with its figure beside it and no strokes');
  ok(Math.hypot(...kWind[1]) <= KG.MAX_WIND * 0.3 + 0.15, `hole 1 wind is gentle (${kWind[1]})`);
  ok(kMidBall, 'mid-match joiner gets a ball on the Klossgolf hole in progress');
  ok(k1.g === GAME.KLOSS && k1.ci === 1 && k2r.ci === 2 && kMatch.g === GAME.KLOSS, 'kloss round / match messages carry g and ci');
  const kTotals = {}, kAces = {};
  for (const r of [k1, k2r]) {
    const c = KCOURSES[r.ci];
    const ids = kStart[r.rd].concat(r.rd === 2 ? [kMidId] : []);
    ok(r.order.length === ids.length && ids.every((id) => r.order.includes(id)), `kloss hole ${r.rd} order covers players`);
    ok(r.winner === r.order[0], `kloss hole ${r.rd} winner is first`);
    for (let i = 1; i < r.order.length; i++) ok(r.pts[r.order[i - 1]] <= r.pts[r.order[i]], `kloss hole ${r.rd} order by strokes`);
    for (const id of r.order) {
      const v = r.pts[id];
      ok(Number.isInteger(v) && v >= 1 && v <= maxStrokes(c) + 1 + KG.DNF_PENALTY, `kloss hole ${r.rd} strokes of ${id} sane (${v})`);
      kTotals[id] = (kTotals[id] || 0) + v;
      if (v === 1) kAces[id] = (kAces[id] || 0) + 1;
    }
  }
  kTotals[kMidId] += KCOURSES[1].par + KG.MISSED_HOLE;
  const kHumans = new Set(lastRoster(h).players.filter((p) => !p.bot).map((p) => p.id));
  ok(k1.order.filter((id) => !kHumans.has(id)).filter((id) => k1.pts[id] <= maxStrokes(KCOURSES[1])).length >= 3, 'kloss bots hole out on hole 1');
  ok(k1.order.filter((id) => kHumans.has(id) && id !== a4.id).every((id) => k1.pts[id] === maxStrokes(KCOURSES[1]) + KG.DNF_PENALTY), 'idle humans get maxStrokes + DNF_PENALTY');
  const kst = kMatch.standings;
  for (let i = 1; i < kst.length; i++) ok(kst[i - 1].score <= kst[i].score, 'kloss standings: fewest strokes first');
  for (const p of kst) {
    ok(p.score === kTotals[p.id], `kloss total of ${p.name} = sum of holes (${p.score} vs ${kTotals[p.id]})`);
    ok(p.kos === (kAces[p.id] || 0), `kloss kos of ${p.name} = holes in one`);
  }
  await me.wait((m) => m.t === 'match' && m.g === GAME.KLOSS, 'kloss match msg to players', 3000, 0);
  const kme = await connect('KlossLate', '10.0.0.75');
  const kmeSince = kme.mark();
  await joinOk(kme, 'Efterklossen');
  await kme.wait((m) => m.t === 'match' && m.g === GAME.KLOSS, 'kloss match msg to a MATCH_END joiner', 3000, kmeSince);

  // ---- Heta paketet: Knuffkampen's arena and rounds, plus a parcel with a hidden fuse
  await h.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === kme.id), 'kloss roster with the late joiner', 4000, 0);
  const klossRoster = lastRoster(h);
  since = h.mark();
  const pPhases = [];
  const pStart = {};
  const pEv = [];           // [rd, ph, event]
  let pMidId = -1, pMidSeen = false;
  let pGoneSeen = false;    // a car that popped or fell came back during its round
  const pOut = new Set();
  let pCarrierIdle = true;  // ca stays -1 between a pop and the next parcel
  let pAfterPop = false;
  let pSwitched = false;
  h.onSnap = (sn) => {
    checkSnap(sn);
    if (sn.g !== GAME.PAKET) { if (pPhases.length) pSwitched = true; return; }
    if ((pPhases.length || sn.ph === PHASE.COUNTDOWN) && pPhases[pPhases.length - 1] !== sn.ph) pPhases.push(sn.ph);
    if (sn.ph === PHASE.COUNTDOWN && !pStart[sn.rd]) { pStart[sn.rd] = sn.p.map((b) => b[0]); pOut.clear(); pAfterPop = false; }
    for (const e of sn.e) {
      if (pPhases.length) pEv.push([sn.rd, sn.ph, e]);
      if (sn.ph === PHASE.PLAYING && (e[0] === 'pop' || e[0] === 'fall')) pOut.add(e[1]);
      if (e[0] === 'pop') pAfterPop = true;
      if (e[0] === 'parcel') pAfterPop = false;
    }
    if (pAfterPop && sn.ca !== -1 && !sn.e.some((e) => e[0] === 'parcel')) pCarrierIdle = false;
    if (sn.ph === PHASE.PLAYING && sn.p.some((b) => pOut.has(b[0]) && !(b[5] & ST.FALLING))) pGoneSeen = true;
    if (pMidId >= 0 && sn.ph !== PHASE.MATCH_END && sn.p.some((b) => b[0] === pMidId)) pMidSeen = true;
  };
  a4.send({ t: 'cmd', c: 'game', v: GAME.PAKET });
  await sleep(200);
  ok(h.snap.g === GAME.KLOSS, 'non-host switch to Heta paketet ignored');
  h.send({ t: 'cmd', c: 'game', v: GAME.PAKET });
  ro = await h.wait((m) => m.t === 'roster' && m.game === GAME.PAKET, 'paket roster', 4000, since);
  ok(rosterKey(ro) === rosterKey(klossRoster), 'switching to Heta paketet keeps ids, names, colours, bot flags, connection state');
  ok(ro.bots === klossRoster.bots && ro.rounds === klossRoster.rounds, 'Heta paketet keeps bot and round settings');
  ok(ro.players.every((p) => p.score === 0 && p.kos === 0), 'paket roster: scores reset');
  s = await h.wait((m) => m.t === 's' && m.g === GAME.PAKET && m.p.length === ro.players.length, 'paket snapshot with every car');
  ok(s.ph === PHASE.LOBBY && s.rd === 0 && s.ca === -1 && s.fu === 0 && s.wf === -1, 'Heta paketet lobby: free play, no parcel');
  // reconnect with the token: same car
  const a5 = await connect('A5', '10.0.0.1');
  await joinOk(a5, 'Whoever', aToken);
  ok(a5.id === aId, 'paket: token rebinds the same id');
  await a4.waitClose('replaced socket closes');
  await h.wait((m) => m.t === 's' && m.p.some((b) => b[0] === aId), 'reconnected car on the ice');
  a5.send({ t: 'in', x: 1, y: 0, d: 1 });

  h.send({ t: 'cmd', c: 'bots', v: 7 });
  h.send({ t: 'cmd', c: 'rounds', v: 2 });
  await h.wait((m) => m.t === 'roster' && m.bots === 7 && m.rounds === 2 && m.players.filter((p) => p.bot).length === 7, 'paket roster with 7 bots', 4000, since);
  const pMatchStart = Date.now();
  h.send({ t: 'cmd', c: 'start' });
  s = await h.wait((m) => m.t === 's' && m.ph === PHASE.COUNTDOWN && m.rd === 1, 'paket countdown');
  ok(s.ca >= 0 && s.fu === 0, 'first carrier shown in the countdown');
  h.send({ t: 'cmd', c: 'game', v: GAME.KNUFF });   // not allowed mid-match
  const p1 = await h.wait((m) => m.t === 'round' && m.rd === 1, 'paket round 1 result', 40000, since);
  await h.wait((m) => m.t === 's' && m.ph === PHASE.PLAYING && m.rd === 2, 'paket round 2 playing', 15000);
  const pm = await connect('PaketMid', '10.0.0.76');
  await joinOk(pm, 'Paketsen');
  pMidId = pm.id;
  const p2 = await h.wait((m) => m.t === 'round' && m.rd === 2, 'paket round 2 result', 40000, since);
  const pMatch = await h.wait((m) => m.t === 'match', 'paket match result', 15000, since);
  s = await h.wait((m) => m.t === 's' && m.ph === PHASE.MATCH_END, 'paket MATCH_END snapshot');
  log(`Heta paketet match took ${((Date.now() - pMatchStart) / 1000).toFixed(1)}s real time`);
  ok(s.g === GAME.PAKET && s.ca === -1, 'no parcel in MATCH_END');
  ok(!pSwitched, 'game switch ignored mid Heta paketet match');
  ok(JSON.stringify(pPhases) === JSON.stringify([PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.COUNTDOWN, PHASE.PLAYING, PHASE.ROUND_END, PHASE.MATCH_END]),
    `paket phase sequence (got ${JSON.stringify(pPhases)})`);
  ok(p1.g === GAME.PAKET && p2.g === GAME.PAKET && pMatch.g === GAME.PAKET, 'paket round / match messages carry g = 3');
  const pk = (k) => pEv.filter(([, , e]) => e[0] === k);
  ok(pk('ring').length === 0, 'no rings fall in Heta paketet');
  ok(pEv.filter(([, ph, e]) => e[0] === 'parcel' && ph === PHASE.COUNTDOWN).length === 2, 'a parcel event in each countdown');
  ok(pk('pass').length >= 1, `the parcel is passed on (${pk('pass').length} passes)`);
  ok(pk('pop').length >= 1, `a parcel pops (${pk('pop').length} pops)`);
  const pops = pk('pop');
  const popFollowed = pops.some(([rd, , e]) => pEv.some(([rd2, ph2, e2], i) => rd2 === rd && ph2 === PHASE.PLAYING && e2[0] === 'parcel' && i > pEv.findIndex(([, , x]) => x === e)));
  ok(popFollowed, 'a new parcel follows a pop');
  ok(pCarrierIdle, 'nobody carries a parcel between a pop and the next one');
  ok(!pGoneSeen, 'a car that popped or fell stays out for the round');
  ok(!pMidSeen, 'mid-round joiner has no car during the round');
  for (const r of [p1, p2]) {
    const ids = pStart[r.rd];
    ok(Array.isArray(ids) && ids.length >= 8, `paket participants of round ${r.rd}`);
    ok(r.order.length === ids.length && ids.every((id) => r.order.includes(id)), `paket round ${r.rd} order covers participants`);
    ok(r.winner === r.order[0], `paket round ${r.rd} winner is first`);
    const n = ids.length;
    r.order.forEach((id, i) => ok(Number.isInteger(r.pts[id]) && r.pts[id] >= (n - 1 - i) + (i === 0 ? 2 : 0), `paket round ${r.rd} placing points for ${id}`));
    const popped = pops.filter(([rd]) => rd === r.rd).map(([, , e]) => e[1]);
    ok(popped.every((id) => id !== r.winner), `paket round ${r.rd}: a popped car does not win`);
  }
  const pst = pMatch.standings;
  for (let i = 1; i < pst.length; i++) ok(pst[i - 1].score >= pst[i].score, 'paket standings sorted by score');
  for (const p of pst) ok(p.score === (p1.pts[p.id] || 0) + (p2.pts[p.id] || 0), `paket score of ${p.name} = sum of round points`);
  await h.wait((m) => m.t === 's' && m.p.some((b) => b[0] === pm.id), 'paket mid joiner gets a car in MATCH_END');
  const pme = await connect('PaketLate', '10.0.0.77');
  const pmeSince = pme.mark();
  await joinOk(pme, 'Efterpaketet');
  await pme.wait((m) => m.t === 'match' && m.g === GAME.PAKET, 'paket match msg to a MATCH_END joiner', 3000, pmeSince);
  ok(lastRoster(pme).game === GAME.PAKET, 'late joiner gets the paket roster');

  // ---- back to Knuffkampen: still plays a match
  since = h.mark();
  h.onSnap = checkSnap;
  h.send({ t: 'cmd', c: 'game', v: GAME.KNUFF });
  ro = await h.wait((m) => m.t === 'roster' && m.game === GAME.KNUFF, 'knuff roster again', 4000, since);
  ok(ro.players.some((p) => p.id === golfMidId) && ro.players.some((p) => p.id === a5.id) && ro.players.some((p) => p.id === kMidId) && ro.players.some((p) => p.id === pm.id), 'switching back keeps players');
  await h.wait((m) => m.t === 's' && m.g === GAME.KNUFF && m.ph === PHASE.LOBBY, 'knuff lobby again');
  h.send({ t: 'cmd', c: 'rounds', v: 1 });
  h.send({ t: 'cmd', c: 'start' });
  const k2 = await h.wait((m) => m.t === 'match', 'knuff match after golf', 20000, since);
  ok(!('g' in k2) && k2.standings.length === ro.players.length, 'knuff match after golf has everyone');
  h.send({ t: 'cmd', c: 'lobby' });
  await h.wait((m) => m.t === 's' && m.ph === PHASE.LOBBY && m.g === GAME.KNUFF, 'knuff lobby after match');

  // ---- playing host: a joined player who also shows the host key gets the controls
  {
    // A plain player still cannot steer, and a wrong key leaves it a plain player.
    const botsBefore = lastRoster(h).bots;
    since = b2.mark();
    b2.send({ t: 'cmd', c: 'bots', v: 7 });
    b2.send({ t: 'host', key: 'wrongwrongwrong2' });
    ok((await b2.wait((m) => m.t === 'err', 'player wrong key', 4000, since)).m === 'key', 'player with wrong host key -> err key');
    b2.send({ t: 'cmd', c: 'bots', v: 7 });
    b2.send({ t: 'cmd', c: 'game', v: GAME.GOLF });
    b2.send({ t: 'cmd', c: 'start' });
    await sleep(300);
    ok(lastRoster(h).bots === botsBefore && lastRoster(h).game === GAME.KNUFF && h.snap.ph === PHASE.LOBBY, 'plain player cmds still ignored');
    ok(!b2.closed && !b2.log.slice(since).some((m) => m.t === 'hosted'), 'plain player stays a player');

    // Join, then show the key on the same socket.
    const ph = await connect('PlayHost', '10.0.0.30');
    await joinOk(ph, 'Värdis');
    since = ph.mark();
    ph.send({ t: 'cmd', c: 'bots', v: 4 });
    await sleep(250);
    ok(lastRoster(h).bots === botsBefore, 'player cmd before the key is ignored');
    ph.send({ t: 'host', key: KEY });
    const phh = await ph.wait((m) => m.t === 'hosted', 'player hosted', 4000, since);
    ok(phh.code === CODE && phh.id === ph.id, 'player-host: hosted carries code and own id');
    since = ph.mark();
    ph.send({ t: 'host', key: KEY });
    await sleep(200);
    ok(!ph.log.slice(since).some((m) => m.t === 'hosted' || m.t === 'err'), 'second host key on a player-host is ignored');

    // Bots and every game switch.
    since = ph.mark();
    ph.send({ t: 'cmd', c: 'bots', v: 2 });
    ro = await ph.wait((m) => m.t === 'roster' && m.bots === 2, 'player-host sets bots', 4000, since);
    ok(ro.players.filter((p) => p.bot).length === 2, 'player-host: bots added');
    ok(ro.players.some((p) => p.id === ph.id && !p.bot && p.on), 'player-host is still a player in the roster');
    for (const g of [GAME.GOLF, GAME.KLOSS, GAME.PAKET, GAME.KNUFF]) {
      since = ph.mark();
      ph.send({ t: 'cmd', c: 'game', v: g });
      ro = await ph.wait((m) => m.t === 'roster' && m.game === g, `player-host switches to game ${g}`, 4000, since);
      ok(ro.players.some((p) => p.id === ph.id) && ro.bots === 2, `player-host keeps place and bots in game ${g}`);
      await ph.wait((m) => m.t === 's' && m.g === g && m.ph === PHASE.LOBBY, `game ${g} lobby snapshot`);
    }
    since = ph.mark();
    ph.send({ t: 'cmd', c: 'rounds', v: 2 });
    ok((await ph.wait((m) => m.t === 'roster' && m.rounds === 2, 'player-host sets rounds', 4000, since)).rounds === 2, 'player-host: rounds');

    // Still drives like any player.
    const before = ph.snap.p.find((q) => q[0] === ph.id);
    ok(before, 'player-host has a body');

    // Kick: someone else yes, itself no.
    const vic = await connect('Victim', '10.0.0.31');
    await joinOk(vic, 'Offer');
    const vicId = vic.id;
    since = vic.mark();
    const hSince = h.mark();
    ph.send({ t: 'cmd', c: 'kick', v: ph.id });
    ph.send({ t: 'cmd', c: 'kick', v: vicId });
    await vic.wait((m) => m.t === 'kicked', 'kicked by player-host', 4000, since);
    await vic.waitClose('victim socket closes');
    ro = await h.wait((m) => m.t === 'roster' && !m.players.some((p) => p.id === vicId), 'roster without victim', 4000, hSince);
    ok(ro.players.some((p) => p.id === ph.id), 'player-host cannot kick itself');
    ok(!ph.closed, 'player-host socket still open after self-kick attempt');

    // Start from the player view, then back to the lobby.
    since = ph.mark();
    ph.send({ t: 'cmd', c: 'start' });
    await ph.wait((m) => m.t === 's' && (m.ph === PHASE.COUNTDOWN || m.ph === PHASE.PLAYING), 'player-host starts a match');
    ph.send({ t: 'cmd', c: 'lobby' });
    await ph.wait((m) => m.t === 's' && m.ph === PHASE.LOBBY, 'player-host back to lobby');

    // The controls belong to the socket: a reconnect must show the key again.
    const phToken = ph.token, phId = ph.id;
    ph.close();
    await h.wait((m) => m.t === 'roster' && m.players.some((p) => p.id === phId && p.on === false), 'player-host offline');
    const ph2 = await connect('PlayHost2', '10.0.0.30');
    await joinOk(ph2, 'Värdis', phToken);
    ok(ph2.id === phId, 'player-host reconnects as the same player');
    ph2.send({ t: 'cmd', c: 'bots', v: 5 });
    await sleep(250);
    ok(lastRoster(h).bots === 2, 'reconnected player without the key cannot steer');
    since = ph2.mark();
    ph2.send({ t: 'host', key: KEY });
    await ph2.wait((m) => m.t === 'hosted', 'player-host hosted again', 4000, since);
    ph2.send({ t: 'cmd', c: 'bots', v: botsBefore });
    await h.wait((m) => m.t === 'roster' && m.bots === botsBefore, 'player-host restores bots', 4000, h.mark());
    ph2.close();
    await sleep(150);
  }

  // ---- socket cap
  const many = [];
  for (let i = 0; i < 125; i++) many.push(new Client('many' + i, '10.1.0.' + (i % 250)));
  await sleep(1500);
  const openMany = many.filter((m) => m.ws.readyState === WebSocket.OPEN).length;
  ok(openMany < 125 && openMany <= 120, `socket cap enforced (${openMany} of 125 opened)`);
  for (const m of many) m.close();
  await sleep(300);

  // ---- idle socket times out after 15 s
  const waitIdle = Math.max(0, idleOpenedAt + 17500 - Date.now());
  await idle.waitClose('unauthenticated socket closed', waitIdle + 2000);
  ok(Date.now() - idleOpenedAt >= 14000, 'idle socket closed only after ~15 s');

  ok(snapErrors.length === 0, 'all snapshots valid:\n  ' + snapErrors.join('\n  '));
  ok(!/uncaught|unhandled|tick:|handler:/.test(serverOut), 'no server errors logged');
  ok(server.exitCode === null, 'server still running');

  // ---- KK_GAME: a room can open straight in Heta paketet (the cloud default)
  {
    const port2 = await freePort();
    let out2 = '';
    const s2 = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', KK_CODE: CODE, KK_HOST_KEY: KEY, KK_GAME: 'paket' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    s2.stdout.on('data', (d) => { out2 += d; });
    s2.stderr.on('data', (d) => { out2 += d; });
    for (let i = 0; i < 100 && !out2.includes('Rumskod'); i++) await sleep(50);
    const mainPort = PORT;
    PORT = port2;
    const pk = await connect('PaketStart', '10.0.0.40');
    PORT = mainPort;
    await joinOk(pk, 'Paketvärd');
    ok(lastRoster(pk).game === GAME.PAKET, 'KK_GAME=paket opens the room in Heta paketet');
    since = pk.mark();
    pk.send({ t: 'host', key: KEY });
    await pk.wait((m) => m.t === 'hosted', 'paket player-host', 4000, since);
    pk.send({ t: 'cmd', c: 'bots', v: 3 });
    ro = await pk.wait((m) => m.t === 'roster' && m.bots === 3, 'paket bots', 4000, since);
    ok(ro.game === GAME.PAKET && ro.players.filter((p) => p.bot).length === 3, 'player-host adds bots in Heta paketet');
    pk.send({ t: 'cmd', c: 'start' });
    await pk.wait((m) => m.t === 's' && m.g === GAME.PAKET && m.ph !== PHASE.LOBBY, 'paket match starts from the player view');
    ok(!/uncaught|unhandled|tick:|handler:/.test(out2), 'no errors on the paket-start server');
    pk.close();
    s2.kill('SIGTERM');
    await sleep(200);
  }

  // ---- clean shutdown
  for (const cl of [a5, b2, g, h, h2, re, mid, me, gm, km, kme, pm, pme]) cl.close();
  const exited = new Promise((r) => server.once('exit', (code, sig) => r({ code, sig })));
  server.kill('SIGTERM');
  const ex = await Promise.race([exited, sleep(4000).then(() => null)]);
  ok(ex && ex.code === 0, 'server exits cleanly on SIGTERM');

  log(`PASS: ${checks} checks`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e.message || e);
  if (snapErrors.length) console.error('snapshot errors:\n' + snapErrors.join('\n'));
  console.error('--- server output ---\n' + serverOut.slice(-3000));
  if (server && server.exitCode === null) server.kill('SIGKILL');
  process.exit(1);
});
