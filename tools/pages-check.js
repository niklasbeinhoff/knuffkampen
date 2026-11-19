// Checks the GitHub Pages room (public/js/room-worker.js) without a browser:
// builds the Pages folder, loads the worker module in this process with a
// stand-in for the worker globals, and drives it like p2p.js would.
//
//   node tools/pages-check.js

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PHASE, GAME } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(path.join(os.tmpdir(), 'kk-pages-'));
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-pages.js'), OUT], { stdio: 'ignore' });

let checks = 0;
function ok(cond, what) { checks++; if (!cond) throw new Error('FAILED: ' + what); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Worker globals: what the module posts lands in `outs`; we call its onmessage.
const outs = [];
globalThis.onmessage = null;
globalThis.postMessage = (m) => outs.push(m);
await import(pathToFileURL(path.join(OUT, 'js', 'room-worker.js')).href);
const toRoom = (data) => globalThis.onmessage({ data });

/** Frames a connection received (decoded), and its close code if closed. */
function inbox(cid, since = 0) {
  const msgs = [];
  let closed = null;
  for (const m of outs.slice(since)) {
    if (m.k === 'send' && m.cid === cid) msgs.push(JSON.parse(m.d));
    else if (m.k === 'bcast' && m.cids.includes(cid)) msgs.push(JSON.parse(m.d));
    else if (m.k === 'close' && m.cid === cid) closed = m.code;
  }
  return { msgs, closed };
}
const send = (cid, obj) => toRoom({ k: 'msg', cid, d: typeof obj === 'string' ? obj : JSON.stringify(obj) });
const lastRoster = (cid) => inbox(cid).msgs.filter((m) => m.t === 'roster').pop();
const mark = () => outs.length;

try {
  toRoom({ k: 'init', code: 'paket1', game: GAME.PAKET });

  // The host's own player (cid 0) joins and takes the controls.
  toRoom({ k: 'open', cid: 0 });
  send(0, { t: 'join', name: 'Värd', code: 'PAKET1' });
  await sleep(50);
  const hj = inbox(0).msgs.find((m) => m.t === 'joined');
  ok(hj && Number.isInteger(hj.id) && hj.token.length === 32, 'host player joins');
  ok(lastRoster(0).game === GAME.PAKET, 'room opens in Heta paketet');
  let s = mark();
  send(0, { t: 'host', key: 'p2p' });
  await sleep(20);
  const hh = inbox(0, s).msgs.find((m) => m.t === 'hosted');
  ok(hh && hh.code === 'PAKET1' && hh.id === hj.id, 'host player gets the controls');

  // A remote player: wrong code, then right code; may not take the controls.
  toRoom({ k: 'open', cid: 1 });
  s = mark();
  send(1, { t: 'join', name: 'Kollega', code: 'NOPE' });
  await sleep(20);
  ok(inbox(1, s).msgs.some((m) => m.t === 'err' && m.m === 'code'), 'wrong code -> err code');
  s = mark();
  send(1, { t: 'join', name: 'Kollega', code: 'paket1' });
  await sleep(20);
  const pj = inbox(1, s).msgs.find((m) => m.t === 'joined');
  ok(pj && pj.id !== hj.id, 'remote player joins with the code (any case)');
  s = mark();
  send(1, { t: 'host', key: 'p2p' });
  send(1, { t: 'cmd', c: 'bots', v: 6 });
  send(1, { t: 'cmd', c: 'start' });
  await sleep(100);
  ok(inbox(1, s).msgs.some((m) => m.t === 'err' && m.m === 'key'), 'remote player cannot become host');
  ok(lastRoster(0).bots === 0, 'remote player cmd ignored');

  // Snapshots reach both.
  await sleep(200);
  const snap1 = inbox(1).msgs.filter((m) => m.t === 's').pop();
  ok(snap1 && snap1.g === GAME.PAKET && snap1.ph === PHASE.LOBBY && snap1.p.length === 2, 'remote player gets lobby snapshots');
  ok(outs.some((m) => m.k === 'bcast' && m.drop === true && m.cids.includes(0) && m.cids.includes(1)), 'snapshots are broadcast as droppable');

  // Host controls: bots, rounds, start, back to lobby.
  s = mark();
  send(0, { t: 'cmd', c: 'bots', v: 3 });
  send(0, { t: 'cmd', c: 'rounds', v: 1 });
  await sleep(50);
  const r1 = lastRoster(1);
  ok(r1.bots === 3 && r1.players.filter((p) => p.bot).length === 3 && r1.rounds === 1, 'host adds bots and sets rounds');
  send(0, { t: 'cmd', c: 'bots', v: 1 });
  await sleep(50);
  ok(lastRoster(1).players.filter((p) => p.bot).length === 1, 'host removes bots');
  s = mark();
  send(0, { t: 'cmd', c: 'start' });
  await sleep(300);
  ok(inbox(1, s).msgs.some((m) => m.t === 's' && m.ph === PHASE.COUNTDOWN), 'host starts the match');
  send(0, { t: 'cmd', c: 'lobby' });
  await sleep(200);
  ok(inbox(1).msgs.filter((m) => m.t === 's').pop().ph === PHASE.LOBBY, 'host goes back to the lobby');

  // Input moves the remote player's body.
  const before = inbox(1).msgs.filter((m) => m.t === 's').pop().p.find((b) => b[0] === pj.id);
  for (let i = 0; i < 10; i++) { send(1, { t: 'in', x: 1, y: 0, d: 0 }); await sleep(30); }
  const after = inbox(1).msgs.filter((m) => m.t === 's').pop().p.find((b) => b[0] === pj.id);
  ok(before && after && Math.hypot(after[1] - before[1], after[2] - before[2]) > 0.2, 'remote input moves the body');

  // Reconnect with the token keeps the player; the old connection is retired with 4001.
  toRoom({ k: 'open', cid: 2 });
  s = mark();
  send(2, { t: 'join', name: 'Vem som helst', code: 'PAKET1', token: pj.token });
  await sleep(30);
  ok(inbox(2, s).msgs.find((m) => m.t === 'joined')?.id === pj.id, 'token rebinds the same player');
  ok(inbox(1, s).closed === 4001, 'old connection closed as replaced');

  // Kick: not yourself; someone else yes ('kicked' first, then close 4002).
  s = mark();
  send(0, { t: 'cmd', c: 'kick', v: hj.id });
  send(0, { t: 'cmd', c: 'kick', v: pj.id });
  await sleep(30);
  const k = inbox(2, s);
  ok(k.msgs.some((m) => m.t === 'kicked') && k.closed === 4002, 'host kicks a player');
  ok(lastRoster(0).players.some((p) => p.id === hj.id) && !lastRoster(0).players.some((p) => p.id === pj.id), 'host cannot kick itself');

  // Garbage and floods.
  toRoom({ k: 'open', cid: 3 });
  for (const g of ['', 'x', '[]', 'null', '{"t":1}', '{"t":"in","x":"a"}', '{"t":"cmd","c":"start"}', 'z'.repeat(5000), '{"t":"join","name":"A","code":"PAKET1","token":' + JSON.stringify('t'.repeat(100)) + '}']) send(3, g);
  await sleep(30);
  ok(inbox(3).closed === null, 'garbage is ignored');
  toRoom({ k: 'open', cid: 4 });
  for (let i = 0; i < 130; i++) send(4, { t: 'ping', c: i });
  ok(inbox(4).closed === 1008, 'message flood closes the connection');
  toRoom({ k: 'open', cid: 5 });
  for (let i = 0; i < 9; i++) send(5, { t: 'join', name: 'B', code: 'BAD' + i });
  ok(inbox(5).closed === 1008, 'repeated wrong codes close the connection');

  // A player who leaves shows as offline; the room keeps running.
  toRoom({ k: 'open', cid: 6 });
  send(6, { t: 'join', name: 'Går snart', code: 'PAKET1' });
  await sleep(20);
  const gid = inbox(6).msgs.find((m) => m.t === 'joined').id;
  toRoom({ k: 'close', cid: 6 });
  await sleep(50);
  const gone = lastRoster(0).players.find((p) => p.id === gid);
  ok(!gone || gone.on === false, 'a player who leaves is marked offline or removed');
  const n = outs.length;
  await sleep(200);
  ok(outs.slice(n).some((m) => m.k === 'bcast'), 'room still ticking');

  console.log(`pages-check: PASS (${checks} checks)`);
} catch (e) {
  console.error(e.message || e);
  process.exitCode = 1;
} finally {
  rmSync(OUT, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
