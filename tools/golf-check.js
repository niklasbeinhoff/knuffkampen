// Molngolf – course check. For every course: searches shots with the real stepBall
// for the fewest strokes from the tee, checks tee/cup/size, makes sure a straight
// full-power shot is no ace on the later holes, and lets a medium bot play each hole.
//
//   node tools/golf-check.js            all courses
//   node tools/golf-check.js 3          only COURSES[3]

import { GOLF, COURSES, onGround, courseBounds, createBall, placeBall, shoot, stepBall, canShoot } from '../shared/golf.js';
import { distField, simulate, candidateDirs, planShot } from '../server/golfbot.js';

const DT = 1 / 60;              // the server's step
const BEAM = 6;
const POWERS = [];
for (let p = GOLF.MIN_POWER; p <= GOLF.MAX_POWER + 1e-9; p += 0.9) POWERS.push(p);
POWERS.push(GOLF.MAX_POWER);
const BOT_GAMES = 24;
const BOT_FINISH = 0.8;         // a medium bot must finish at least this share within MAX_STROKES

let failed = 0;
const fail = (m) => { failed++; console.log('  FAIL ' + m); };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Fewest strokes found from the tee (beam search), or null within maxDepth. */
function fewest(course, maxDepth) {
  const field = distField(course);
  const spin = (course.spinners || []).length > 0;
  const waits = spin ? [0, 0.4, 0.8, 1.2, 1.6, 2.0] : [0];
  let states = [{ x: course.tee[0], y: course.tee[1], t: GOLF.INTRO_T }];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = new Map();
    for (const st of states) {
      for (const a of candidateDirs(course, st.x, st.y, 72, [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1])) {
        const c = Math.cos(a), s = Math.sin(a);
        for (const p of POWERS) for (const w of waits) {
          const r = simulate(course, st.x, st.y, c * p, s * p, st.t + w, DT, 12);
          if (r.holed) return depth;
          if (r.oob) continue;
          const v = field.at(r.x, r.y);
          const key = Math.round(r.x / 0.4) + ',' + Math.round(r.y / 0.4);
          const old = next.get(key);
          if (!old || old.v > v) next.set(key, { x: r.x, y: r.y, t: r.t, v });
        }
      }
    }
    states = [...next.values()].sort((m, n) => m.v - n.v).slice(0, BEAM);
    if (!states.length) return null;
  }
  return null;
}

/** A bot plays the hole with the real step; returns strokes (holed) or Infinity. */
function botPlay(course, skill, random) {
  const brain = {
    skill, aimErr: 0.012 + (1 - skill) * 0.06, powErr: 0.025 + (1 - skill) * 0.1, think: 0.7 + (1 - skill) * 1.2,
  };
  const b = createBall(1);
  placeBall(b, course.tee[0], course.tee[1]);
  let t = GOLF.INTRO_T, strokes = 0;
  const ev = [], trail = [];
  while (t < GOLF.INTRO_T + GOLF.HOLE_TIME && strokes < GOLF.MAX_STROKES && !b.holed) {
    for (let k = 0, n = Math.round(brain.think * (0.7 + random() * 0.8) / DT); k < n; k++) { stepBall(b, course, t, DT, ev); t += DT; }
    if (!canShoot(b)) { stepBall(b, course, t, DT, ev); t += DT; continue; }
    const [vx, vy] = planShot(course, b.x, b.y, t, brain, random);
    trail.push(`(${b.x.toFixed(1)},${b.y.toFixed(1)}) ${Math.hypot(vx, vy).toFixed(1)}@${Math.atan2(vy, vx).toFixed(2)} t${t.toFixed(1)}`);
    shoot(b, vx, vy);
    strokes++;
    for (let k = 0; k < 20 / DT && (b.moving || b.falling); k++) {
      ev.length = 0;
      stepBall(b, course, t, DT, ev);
      t += DT;
      if (ev.some((e) => e[0] === 'reset')) strokes++;
    }
  }
  if (b.holed) return strokes;
  if (process.env.GOLF_DEBUG) console.log('    DNF ' + trail.join(' | ') + ` -> (${b.x.toFixed(1)},${b.y.toFixed(1)}) m${+b.moving} f${+b.falling}`);
  return Infinity;
}

const only = process.argv[2] !== undefined ? Number(process.argv[2]) : -1;
console.log('ci  par  best  bot(med) avg / finished   bot(sharp) avg   size      name');
COURSES.forEach((course, ci) => {
  if (only >= 0 && ci !== only) return;
  const tag = `[${ci}] ${course.name}`;
  if (!onGround(course, ...course.tee)) fail(`${tag}: tee off the green`);
  if (!onGround(course, ...course.cup)) fail(`${tag}: cup off the green`);
  const bb = courseBounds(course);
  const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
  if (w > 35 || h > 21) fail(`${tag}: ${w.toFixed(1)} x ${h.toFixed(1)} m is too big`);
  if (h > w) fail(`${tag}: taller than wide`);
  if (!(course.par >= 2 && course.par <= 4)) fail(`${tag}: par ${course.par}`);
  if (!Array.isArray(course.line) || course.line.length < 2) fail(`${tag}: no line`);
  if (distField(course).at(...course.tee) >= 999) fail(`${tag}: no way from tee to cup`);

  const best = fewest(course, course.par);
  if (best === null) fail(`${tag}: cannot be finished within par ${course.par}`);

  if (ci >= 2) {
    const dx = course.cup[0] - course.tee[0], dy = course.cup[1] - course.tee[1], d = Math.hypot(dx, dy);
    for (let t = 0; t < 3; t += 0.25) {
      const r = simulate(course, course.tee[0], course.tee[1], (dx / d) * GOLF.MAX_POWER, (dy / d) * GOLF.MAX_POWER, GOLF.INTRO_T + t, DT);
      if (r.holed) { fail(`${tag}: a straight full-power shot is an ace`); break; }
    }
  }

  const random = rng(1234 + ci);
  const med = [], sharp = [];
  for (let g = 0; g < BOT_GAMES; g++) med.push(botPlay(course, 0.5, random));
  for (let g = 0; g < 8; g++) sharp.push(botPlay(course, 0.85, random));
  const fin = med.filter(Number.isFinite);
  const avg = (a) => { const f = a.filter(Number.isFinite); return f.length ? (f.reduce((s, v) => s + v, 0) / f.length).toFixed(2) : '-'; };
  if (fin.length < BOT_FINISH * BOT_GAMES) fail(`${tag}: a medium bot finished only ${fin.length}/${BOT_GAMES}`);
  console.log(`${String(ci).padEnd(4)}${String(course.par).padEnd(5)}${String(best ?? '-').padEnd(6)}${avg(med).padStart(5)} / ${String(fin.length).padStart(2)} of ${BOT_GAMES}      ${avg(sharp).padStart(5)}        ${w.toFixed(1)} x ${h.toFixed(1)}  ${course.name}`);
});

if (failed) { console.log(`golf-check: ${failed} problem(s)`); process.exit(1); }
console.log('golf-check: OK');
