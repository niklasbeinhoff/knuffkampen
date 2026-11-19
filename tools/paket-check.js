// Heta paketet – rules check without sockets: drives PaketGame directly in game time.
//
//   node tools/paket-check.js [matches]

import { PaketGame } from '../server/paket.js';
import { PHASE, GAME } from '../shared/protocol.js';
import { SIM } from '../shared/sim.js';
import { PAKET } from '../shared/paket.js';

const DT = 1 / SIM.HZ;
let checks = 0;
function ok(cond, what) {
  checks++;
  if (!cond) { console.error('FAILED: ' + what); process.exit(1); }
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Run the game for `secs` of game time (or until stop()), collecting snapshot events. */
function run(g, secs, stop, onSnap) {
  const steps = Math.round(secs * SIM.HZ);
  for (let i = 0; i < steps; i++) {
    g.update(DT);
    if (i % 2 === 1) {
      const s = g.snapshot(0);
      g.drain();
      if (onSnap) onSnap(s);
    }
    if (stop && stop()) return true;
  }
  return false;
}

function checkSnap(s) {
  ok(s.g === GAME.PAKET, 'g = 3');
  ok(Number.isInteger(s.ca) && s.ca >= -1, 'ca');
  ok(typeof s.fu === 'number' && s.fu >= 0 && s.fu <= 1, 'fu range');
  ok(s.ca >= 0 || s.fu === 0, 'fu 0 without a carrier');
  ok(s.rg === s.r0 && (s.ph !== PHASE.PLAYING || s.wf === -1), 'no rings fall');
  if (s.ph === PHASE.LOBBY || s.ph === PHASE.MATCH_END || s.ph === PHASE.ROUND_END) ok(s.ca === -1, 'no parcel outside a round');
  if (s.ph === PHASE.COUNTDOWN) ok(s.ca >= 0 && s.fu === 0, 'carrier shown in the countdown, fuse unburnt');
  if (s.ca >= 0 && s.ph === PHASE.PLAYING) ok(s.p.some((p) => p[0] === s.ca), 'carrier has a body');
}

// ---------------------------------------------------------------- bot matches

const nMatches = Number(process.argv[2] || 6);
const roundLens = [];
let totPass = 0, totPop = 0, totFall = 0, totParcel = 0, edgeStuck = 0;
for (let m = 0; m < nMatches; m++) {
  const g = new PaketGame({ random: seeded(1000 + m), bots: 8, rounds: 3 });
  g.toLobby();
  run(g, 3, null, checkSnap);
  g.command('start');
  ok(g.phase === PHASE.COUNTDOWN && g.carrier >= 0, 'start -> countdown with a carrier');
  let roundStart = 0, lastPh = -1;
  const outIds = new Set();
  const done = run(g, 1500, () => g.phase === PHASE.MATCH_END, (s) => {
    checkSnap(s);
    if (s.ph === PHASE.PLAYING && lastPh !== PHASE.PLAYING) roundStart = g.now;
    if (s.ph === PHASE.ROUND_END && lastPh === PHASE.PLAYING) roundLens.push(g.now - roundStart);
    if (s.ph === PHASE.COUNTDOWN) outIds.clear();
    lastPh = s.ph;
    for (const e of s.e) {
      if (e[0] === 'pass') { totPass++; ok(e.length === 3 && e[1] !== e[2], 'pass event'); }
      if (e[0] === 'parcel') totParcel++;
      if (e[0] === 'pop') {
        totPop++;
        ok(e.length === 3 && Number.isInteger(e[2]), 'pop event');
        ok(!s.p.some((p) => p[0] === e[1]), 'popped car gone from the snapshot');
        outIds.add(e[1]);
      }
      if (e[0] === 'fall' && s.ph === PHASE.PLAYING) { totFall++; outIds.add(e[1]); }
    }
    if (s.ph === PHASE.PLAYING) for (const p of s.p) ok(!outIds.has(p[0]) || p[5] & 1, 'no body after going out');
  });
  ok(done, `bot match ${m} reaches MATCH_END`);
  ok(g.lastMatch && g.lastMatch.g === GAME.PAKET, 'match message carries g = 3');
  ok(g.carrier === -1, 'no parcel in MATCH_END');
}
const avg = roundLens.reduce((a, b) => a + b, 0) / roundLens.length;
console.log(`bot matches: ${nMatches}, rounds ${roundLens.length}, round length avg ${avg.toFixed(1)}s (min ${Math.min(...roundLens).toFixed(1)}, max ${Math.max(...roundLens).toFixed(1)})`);
console.log(`per round: passes ${(totPass / roundLens.length).toFixed(1)}, pops ${(totPop / roundLens.length).toFixed(1)}, falls ${(totFall / roundLens.length).toFixed(1)}, parcels ${(totParcel / roundLens.length).toFixed(1)}`);
ok(totPass > 0 && totPop > 0, 'passes and pops happen');
ok(totFall < 0.65 * (totFall + totPop), 'most cars go out by the parcel, not by falling');

// ---------------------------------------------------------------- edge cases

function newRound(bots, humans = 0, seed = 7) {
  const g = new PaketGame({ random: seeded(seed), bots, rounds: 3 });
  const hs = [];
  for (let i = 0; i < humans; i++) hs.push(g.join('Människa ' + i).id);
  g.toLobby();
  g.command('start');
  run(g, SIM.COUNTDOWN_T + 0.05);
  ok(g.phase === PHASE.PLAYING, 'playing');
  return { g, hs };
}

// Two cars left, the carrier pops: the round ends and the other one wins.
{
  const { g } = newRound(1, 1);
  const c = g.carrier;
  const other = g.participants.find((id) => id !== c);
  for (const b of g.bodies.values()) { b.x = b.id === c ? -3 : 3; b.y = 0; b.vx = 0; b.vy = 0; }
  g.burnt = g.fuse - DT / 2;
  g.update(DT);
  const s = g.snapshot(0);
  ok(s.e.some((e) => e[0] === 'pop' && e[1] === c), 'pop event with two left');
  ok(g.phase === PHASE.ROUND_END, 'round ends right after the pop');
  ok(g.lastRound.winner === other && g.lastRound.order[1] === c && g.lastRound.g === GAME.PAKET, 'survivor wins, popped car second');
  ok(g.lastRound.pts[other] === 1 + 2 && g.lastRound.pts[c] === 0, 'placing points as in Knuffkampen');
}

// A pass and a pop in the same tick: the pop wins, nobody gets an instant parcel.
{
  const { g } = newRound(3);
  const c = g.carrier;
  const o = g.participants.find((id) => id !== c);
  const cb = g.bodies.get(c), ob = g.bodies.get(o);
  cb.x = 0; cb.y = 0; cb.vx = 5; cb.vy = 0;
  ob.x = 1.75; ob.y = 0; ob.vx = -5; ob.vy = 0;
  for (const b of g.bodies.values()) if (b !== cb && b !== ob) { b.x = -8; b.y = (b.id % 3) * 3 - 3; b.vx = 0; b.vy = 0; }
  g.burnt = g.fuse - DT / 2;
  g.update(DT);
  const s = g.snapshot(0);
  ok(s.e.some((e) => e[0] === 'hit') && s.e.some((e) => e[0] === 'pop' && e[1] === c), 'hit and pop in one tick');
  ok(!s.e.some((e) => e[0] === 'pass'), 'no pass when the fuse runs out that tick');
  ok(g.carrier === -1 && Math.abs(g.nextParcelAt - g.now - PAKET.NEXT_T) < 1e-9, 'next parcel scheduled');
  run(g, PAKET.NEXT_T + 0.05);
  ok(g.carrier >= 0 && g.carrier !== c, 'a new parcel after NEXT_T');
}

// A pass, the cooldown and the no-pass-back rule.
{
  const { g } = newRound(3);
  const c = g.carrier;
  const o = g.participants.find((id) => id !== c);
  const cb = g.bodies.get(c), ob = g.bodies.get(o);
  for (const p of g.players.values()) if (p.brain) { p.brain.nextThink = 1e9; p.brain.ix = 0; p.brain.iy = 0; }   // freeze the bots
  for (const b of g.bodies.values()) { b.ix = 0; b.iy = 0; b.x = -8; b.y = (b.id % 3) * 3 - 3; b.vx = 0; b.vy = 0; }
  cb.x = 0; cb.y = 0; cb.vx = 5; ob.x = 1.75; ob.y = 0; ob.vx = -5;
  const fuseBefore = g.burnt;
  g.update(DT);
  let s = g.snapshot(0);
  ok(s.e.some((e) => e[0] === 'pass' && e[1] === c && e[2] === o) && g.carrier === o, 'collision passes the parcel');
  ok(g.burnt > fuseBefore && s.fu > 0, 'a pass does not reset the fuse');
  // Straight back within PASS_BACK: refused even after PASS_CD.
  run(g, PAKET.PASS_CD + 0.1);
  cb.x = 0; cb.y = 0; cb.vx = 5; cb.vy = 0; ob.x = 1.75; ob.y = 0; ob.vx = -5; ob.vy = 0;
  g.update(DT);
  ok(g.carrier === o, 'no pass straight back within PASS_BACK');
  run(g, PAKET.PASS_BACK);
  cb.x = 0; cb.y = 0; cb.vx = 5; cb.vy = 0; ob.x = 1.75; ob.y = 0; ob.vx = -5; ob.vy = 0;
  g.update(DT);
  ok(g.carrier === c, 'passing back allowed after PASS_BACK');
  g.update(DT);
  ok(g.bodies.get(c).acc === PAKET.CARRIER_ACC && g.bodies.get(o).acc === 1, 'carrier accelerates harder');
}

// The carrier falls off: KO credit as usual, a new parcel after NEXT_T.
{
  const { g } = newRound(4);
  const c = g.carrier;
  const cb = g.bodies.get(c);
  const R = SIM.CORE_R + g.r0 * SIM.RING_W;
  cb.x = R + 0.1; cb.y = 0; cb.vx = 3; cb.vy = 0;
  g.update(DT);
  const s = g.snapshot(0);
  ok(s.e.some((e) => e[0] === 'fall' && e[1] === c), 'carrier falls');
  ok(g.carrier === -1 && g.eliminated.has(c), 'parcel gone with the carrier');
  run(g, PAKET.NEXT_T + 0.05);
  ok(g.carrier >= 0 && g.carrier !== c, 'new parcel after the carrier fell');
}

// The carrier is kicked, and a human carrier disconnects.
{
  const { g, hs } = newRound(3, 2);
  g.carrier = hs[0]; g.burnt = 0;
  g.command('kick', hs[0]);
  ok(g.carrier === -1 && g.eliminated.has(hs[0]), 'kicked carrier: parcel dropped, player out');
  run(g, PAKET.NEXT_T + 0.05);
  ok(g.carrier >= 0 && g.carrier !== hs[0], 'new parcel after a kick');
  g.carrier = hs[1];
  g.leave(hs[1]);
  ok(g.carrier === -1, 'disconnected carrier drops the parcel');
  run(g, PAKET.NEXT_T + 0.05);
  ok(g.carrier >= 0 && g.carrier !== hs[1], 'new parcel goes to someone connected');
  const t = g.players.get(hs[1]).token;
  ok(g.join('x', t).rejoined && g.bodies.has(hs[1]), 'reconnect keeps the car in the round');
}

// Carrier kicked during the countdown: a new carrier at once.
{
  const g = new PaketGame({ random: seeded(3), bots: 3, rounds: 1 });
  const h = g.join('Värd').id;
  g.toLobby();
  g.command('start');
  g.carrier = h;
  g.command('kick', h);
  ok(g.phase === PHASE.COUNTDOWN && g.carrier >= 0 && g.carrier !== h, 'countdown carrier replaced at once');
}

// One human alone: the parcel pops on them and the match still ends.
{
  const g = new PaketGame({ random: seeded(5), bots: 0, rounds: 1 });
  g.join('Ensam');
  g.toLobby();
  g.command('start');
  ok(run(g, 60, () => g.phase === PHASE.MATCH_END), 'solo match ends');
}

console.log(`PASS: ${checks} checks`);
