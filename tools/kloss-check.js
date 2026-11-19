// Klossgolf – course check. For every hole in shared/klosscourses.js: checks the
// format, cup on the green, a clean tee box, every tee spot on the tee, the line,
// margins to the bounds and the length for the par. Then plays each hole many times
// with the caddie (aimPoint + suggestClub + bestPower via server/klossbot.js) at three
// error levels, with the server's wind, and reports strokes, finish rate, time and
// the share of shots that find water or go out of bounds.
//
//   node tools/kloss-check.js            all holes
//   node tools/kloss-check.js 3          only KCOURSES[3]
//   node tools/kloss-check.js -v         also print a stroke histogram per hole

import {
  KG, SURF, SURFACE, inShape, surfaceAt, teeSpot, maxStrokes, holeClock, createBall, placeBall,
  atRest, launch, stepBall, PUTTER,
} from '../shared/klossgolf.js';
import { KCOURSES } from '../shared/klosscourses.js';
import { planSwing, botWait, brainForSkill } from '../server/klossbot.js';

const GAMES = 300;            // plays per hole and error level
const MARGIN = 12;            // rough between anything in play and the bounds
const LENGTH = { 3: [70, 105], 4: [150, 200], 5: [240, 290] };
const LEVELS = [               // the caddie's plan, then a bot's error at this skill (server bots: 0.2 .. 0.85)
  { name: 'skarp     ', brain: brainForSkill(0.85), target: [-0.9, -0.25] },   // target: strokes over par
  { name: 'mellan    ', brain: brainForSkill(0.5), target: [-0.3, 0.4] },     // per match hole, averaged
  { name: 'ringrostig', brain: brainForSkill(0.2), target: [0.3, 1.2] },
];

let failed = 0;
const fail = (m) => { failed++; console.log('  FAIL ' + m); };
const note = (m) => console.log('  ' + m);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(isNum);

function shapeOk(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.k === 'circle') return isNum(s.x) && isNum(s.y) && isNum(s.r) && s.r > 0;
  if (s.k === 'rect') return isNum(s.x) && isNum(s.y) && isNum(s.w) && isNum(s.h) && s.w > 0 && s.h > 0 && (s.a === undefined || isNum(s.a));
  if (s.k === 'path') return Array.isArray(s.pts) && s.pts.length >= 2 && s.pts.every(isPt) && isNum(s.w) && s.w > 0;
  return false;
}

/** Axis-aligned box of a shape: [minX, minY, maxX, maxY]. */
function shapeBox(s) {
  if (s.k === 'circle') return [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r];
  if (s.k === 'rect') {
    const c = Math.abs(Math.cos(s.a || 0)), n = Math.abs(Math.sin(s.a || 0));
    const hx = (s.w * c + s.h * n) / 2, hy = (s.w * n + s.h * c) / 2;
    return [s.x - hx, s.y - hy, s.x + hx, s.y + hy];
  }
  const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
  return [Math.min(...xs) - s.w / 2, Math.min(...ys) - s.w / 2, Math.max(...xs) + s.w / 2, Math.max(...ys) + s.w / 2];
}

function teeCorners(t, grow = 0) {
  const h = KG.TEE_W / 2 + grow, c = Math.cos(t.a), n = Math.sin(t.a), out = [];
  for (const [u, v] of [[-h, -h], [h, -h], [h, h], [-h, h]]) out.push([t.x + u * c - v * n, t.y + u * n + v * c]);
  return out;
}

function lineLength(line) {
  let L = 0;
  for (let i = 0; i + 1 < line.length; i++) L += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  return L;
}

function checkFormat(c, ci) {
  if (typeof c.name !== 'string' || !c.name) fail('name');
  if (![3, 4, 5].includes(c.par)) fail('par');
  if (c.time !== undefined && !(isNum(c.time) && c.time > 0)) fail('time');
  if (!Array.isArray(c.bounds) || c.bounds.length !== 4 || !c.bounds.every(isNum) || c.bounds[0] >= c.bounds[2] || c.bounds[1] >= c.bounds[3]) { fail('bounds'); return false; }
  if (!c.tee || !isNum(c.tee.x) || !isNum(c.tee.y) || !isNum(c.tee.a)) { fail('tee'); return false; }
  if (!isPt(c.cup)) { fail('cup'); return false; }
  if (!Array.isArray(c.line) || c.line.length < 2 || !c.line.every(isPt)) { fail('line'); return false; }
  for (const k of ['fairway', 'green', 'sand', 'water']) {
    if (c[k] === undefined) continue;
    if (!Array.isArray(c[k]) || !c[k].every(shapeOk)) fail(k + ' shapes');
  }
  if (!Array.isArray(c.green) || !c.green.length) fail('no green');
  if (c.trees !== undefined && (!Array.isArray(c.trees) || !c.trees.every((t) => Array.isArray(t) && t.length === 4 && t.every(isNum) && t[2] > 0 && t[3] > 0))) fail('trees');
  if (c.base !== undefined) fail('base is not part of the course format');
  return true;
}

function checkGeometry(c, ci) {
  const b = c.bounds;
  const cupS = surfaceAt(c, c.cup[0], c.cup[1]);
  if (cupS !== SURF.GREEN) fail(`cup is on ${SURFACE[cupS].name}, not the green`);
  // Cup well inside the green: the whole cup circle is green.
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * Math.PI * 2;
    if (surfaceAt(c, c.cup[0] + Math.cos(a) * 2, c.cup[1] + Math.sin(a) * 2) !== SURF.GREEN) { fail('cup closer than 2 m to the edge of the green'); break; }
  }
  // Tee box: no water, sand or green on it, no tree trunk or canopy over it.
  const h = KG.TEE_W / 2, tc = Math.cos(c.tee.a), tn = Math.sin(c.tee.a);
  let dirty = false;
  for (let u = -h; u <= h; u += 0.5) for (let v = -h; v <= h; v += 0.5) {
    const x = c.tee.x + u * tc - v * tn, y = c.tee.y + u * tn + v * tc;
    for (const k of ['water', 'sand', 'green']) for (const s of c[k] || []) if (inShape(s, x, y)) dirty = true;
    if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) dirty = true;
  }
  if (dirty) fail('tee box overlaps water, sand, green or bounds');
  for (const t of c.trees || []) {
    const d = Math.hypot(t[0] - c.tee.x, t[1] - c.tee.y);
    if (d < h * Math.SQRT2 + t[2] + 1) fail(`tree at ${t[0]},${t[1]} over the tee box`);
  }
  for (let i = 0; i < 42; i++) {
    const [x, y] = teeSpot(c, i);
    if (surfaceAt(c, x, y) !== SURF.TEE) { fail(`tee spot ${i} (${x}, ${y}) is not on the tee`); break; }
  }
  // Line: starts on the tee, ends at the cup, no point in water or out of bounds.
  const l0 = c.line[0], ln = c.line[c.line.length - 1];
  if (Math.hypot(l0[0] - c.tee.x, l0[1] - c.tee.y) > h) fail('line does not start on the tee');
  if (ln[0] !== c.cup[0] || ln[1] !== c.cup[1]) fail('line does not end at the cup');
  for (const p of c.line) {
    const s = surfaceAt(c, p[0], p[1]);
    if (s === SURF.WATER || s === SURF.OOB) fail(`line point ${p} is in ${SURFACE[s].name}`);
  }
  // Margins: everything in play keeps MARGIN m of rough to the bounds.
  const boxes = [];
  for (const k of ['fairway', 'green', 'sand', 'water']) for (const s of c[k] || []) boxes.push([k, shapeBox(s)]);
  const tcs = teeCorners(c.tee);
  boxes.push(['tee', [Math.min(...tcs.map((p) => p[0])), Math.min(...tcs.map((p) => p[1])), Math.max(...tcs.map((p) => p[0])), Math.max(...tcs.map((p) => p[1]))]]);
  for (const [k, bx] of boxes) {
    const m = Math.min(bx[0] - b[0], bx[1] - b[1], b[2] - bx[2], b[3] - bx[3]);
    if (m < MARGIN - 1e-9) fail(`${k} is ${m.toFixed(1)} m from the bounds (want ${MARGIN})`);
  }
  for (const t of c.trees || []) {
    if (t[0] - t[2] < b[0] || t[1] - t[2] < b[1] || t[0] + t[2] > b[2] || t[1] + t[2] > b[3]) fail(`tree ${t} sticks out of bounds`);
  }
  const L = lineLength(c.line);
  if (ci > 0) {
    const [lo, hi] = LENGTH[c.par];
    if (L < lo || L > hi) fail(`length ${L.toFixed(0)} m outside ${lo}-${hi} for par ${c.par}`);
  }
  return L;
}

/** Wind as the server draws it for hole `rd` (1-based; 0 = none). */
function drawWind(random, rd) {
  if (rd === 0) return [0, 0];
  const a = random() * Math.PI * 2;
  const v = random() * KG.MAX_WIND * (rd === 1 ? 0.3 : 1);
  return [Math.round(Math.cos(a) * v * 10) / 10, Math.round(Math.sin(a) * v * 10) / 10];
}

/** Play one hole like a server bot would. Returns { strokes, holed, water, oob, shots, time }. */
function playHole(c, rd, level, seed, spot) {
  const random = rng(seed);
  const wind = drawWind(random, rd);
  const brain = level.brain;
  const b = createBall(0);
  const [x0, y0] = teeSpot(c, spot);
  placeBall(b, x0, y0);
  let fx = x0, fy = y0, strokes = 0, water = 0, oob = 0, shots = 0, time = 0, holed = false;
  const max = maxStrokes(c), ev = [];
  while (strokes < max) {
    // walk: the figure runs after RUN_DELAY at RUN_SPEED to 1 m short of the ball
    time += Math.max(0, Math.hypot(b.x - fx, b.y - fy) - 1) / KG.RUN_SPEED + botWait(brain, random);
    fx = b.x; fy = b.y;
    const s = planSwing(c, b.x, b.y, wind, brain, random);
    launch(b, c, s.c, s.p, s.a, random() * 2 - 1);
    strokes++; shots++;
    time += KG.RUN_DELAY;
    let t = 0;
    for (let n = 0; n < 6000; n++) {
      stepBall(b, c, wind, KG.DT, ev);
      t += KG.DT;
      for (const e of ev) {
        if (e[0] === 'splash') { water++; strokes++; }
        else if (e[0] === 'oob') { oob++; strokes++; }
        else if (e[0] === 'holed') holed = true;
      }
      ev.length = 0;
      if (holed || atRest(b)) break;
    }
    time += Math.max(0, t - KG.RUN_DELAY) * 0.3;   // the figure runs while the ball is moving
    if (holed) break;
  }
  return { strokes: holed ? strokes : Math.max(strokes, max) + KG.DNF_PENALTY, holed, water, oob, shots, time };
}

const only = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const verbose = process.argv.includes('-v');
const t0 = Date.now();
const summary = [];

KCOURSES.forEach((c, ci) => {
  if (only !== undefined && Number(only) !== ci) return;
  console.log(`KCOURSES[${ci}] ${c.name} (par ${c.par})`);
  if (!checkFormat(c, ci)) return;
  const L = checkGeometry(c, ci);
  note(`length ${L.toFixed(0)} m, hole clock ${holeClock(c)} s, max ${maxStrokes(c)} strokes`);
  const rd = ci === 0 ? 0 : ci;
  for (const level of LEVELS) {
    let sum = 0, fin = 0, wat = 0, oob = 0, shots = 0, slow = 0, tsum = 0;
    const hist = {};
    for (let g = 0; g < GAMES; g++) {
      const r = playHole(c, rd, level, 1000 * ci + g * 7919 + Math.round(level.brain.skill * 1e5), g % 21);
      sum += r.strokes; fin += r.holed ? 1 : 0; wat += r.water; oob += r.oob; shots += r.shots; tsum += r.time;
      if (r.time > holeClock(c)) slow++;
      const k = r.holed ? r.strokes - c.par : 'DNF';
      hist[k] = (hist[k] || 0) + 1;
    }
    const avg = sum / GAMES;
    note(`${level.name}: ${avg.toFixed(2)} strokes (${(avg - c.par >= 0 ? '+' : '') + (avg - c.par).toFixed(2)}), finished ${(100 * fin / GAMES).toFixed(0)} %, ` +
      `water ${(100 * wat / shots).toFixed(1)} % / oob ${(100 * oob / shots).toFixed(1)} % of shots, ~${(tsum / GAMES).toFixed(0)} s, over the clock ${(100 * slow / GAMES).toFixed(0)} %`);
    if (verbose) note('        ' + Object.entries(hist).sort((a, b) => (a[0] === 'DNF') - (b[0] === 'DNF') || a[0] - b[0]).map(([k, v]) => `${k === 'DNF' ? 'DNF' : (k > 0 ? '+' : '') + k}:${v}`).join(' '));
    summary.push({ ci, par: c.par, level: level.name, avg: avg - c.par, fin: fin / GAMES, ace: (hist[1 - c.par] || 0) / GAMES, wat: wat / shots, oob: oob / shots });
    // Finishable around par: the sharp caddie must nearly always finish and not be
    // over par by much; even the rusty one must finish most of the time. The lower
    // bound only catches holes that play trivially short (with the cup constants of
    // shared/klossgolf.js every hole plays about one under par; see the report).
    if (ci > 0) {
      if (level === LEVELS[0] && (fin / GAMES < 0.97 || avg - c.par > 1.2 || avg - c.par < -1.7)) fail(`sharp caddie: ${avg.toFixed(2)} on par ${c.par}, finished ${(100 * fin / GAMES).toFixed(0)} %`);
      if (level === LEVELS[2] && (fin / GAMES < 0.85 || avg - c.par > 2.8)) fail(`rusty caddie: ${avg.toFixed(2)} on par ${c.par}, finished ${(100 * fin / GAMES).toFixed(0)} %`);
      if (oob / shots > 0.05) fail(`too many shots out of bounds (${(100 * oob / shots).toFixed(1)} %)`);
      if (wat / shots > 0.12) fail(`too many shots in the water (${(100 * wat / shots).toFixed(1)} %)`);
      if (slow / GAMES > 0.05) fail('the hole clock is too short');
    } else if (fin / GAMES < 0.95) fail('practice range must be easy');
  }
});

for (const level of LEVELS) {
  const rows = summary.filter((r) => r.ci > 0 && r.level === level.name);
  if (!rows.length) continue;
  const avg = rows.reduce((t, r) => t + r.avg, 0) / rows.length;
  const fin = rows.reduce((t, r) => t + r.fin, 0) / rows.length;
  const aces = rows.filter((r) => r.par === 3);
  const ace = aces.length ? aces.reduce((t, r) => t + r.ace, 0) / aces.length : 0;
  const [lo, hi] = level.target;
  if (only === undefined && (avg < lo || avg > hi)) fail(`${level.name.trim()} bots average ${avg.toFixed(2)} per hole, want ${lo} .. ${hi}`);
  if (only === undefined && fin < 0.95) fail(`${level.name.trim()} bots finish only ${(100 * fin).toFixed(1)} % of holes`);
  console.log(`match holes, ${level.name}: ${(avg >= 0 ? '+' : '') + avg.toFixed(2)} per hole, finished ${(100 * fin).toFixed(1)} %, aces ${(100 * ace).toFixed(1)} % of par 3s`);
}
console.log(`${failed ? 'FAILED' : 'OK'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
