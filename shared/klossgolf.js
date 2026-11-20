// Klossgolf – shared rules of the classic golf game: surfaces, clubs, ball flight.
// Pure and deterministic. The server steps every ball with stepBall(); the client and
// the bots preview a shot with predict(). Sim plane x, y in metres, z up, ground z = 0.
// Courses live in shared/klosscourses.js and follow the format described there.

const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

export const KG = Object.freeze({
  DT: 1 / 60,          // the step the server uses; predict() uses the same
  BALL_R: 0.11,
  GRAVITY: 16,
  WIND_ACC: 0.45,      // m/s² of push on a ball in the air per m/s of wind
  MAX_WIND: 6,         // m/s
  MIN_POWER: 0.03,
  ROLL_VZ: 1.3,        // a bounce that leaves the ground slower than this becomes a roll
  STOP_SPEED: 0.25,

  CUP_R: 0.4,          // kinder than a real cup: this is party golf
  CUP_SPEED: 4.5,      // a ball rolling faster than this skips over the cup
  CUP_PULL_R: 0.9,     // inside this the green leans towards the cup
  CUP_PULL: 4,
  DUNK_R: 0.4,         // landing this close to the pin from the air drops straight in

  TRUNK_R: 0.45,
  CANOPY_FROM: 0.4,    // leaves start at this fraction of a tree's height
  LEAF_KEEP: 0.3,      // speed left after flying into the leaves
  PENALTY_T: 1.3,      // seconds from a splash / out of bounds until the ball is put back

  TEE_W: 8,            // side of the square tee box
  RUN_SPEED: 18,       // figures sprint after their ball
  RUN_DELAY: 0.55,     // seconds a figure holds its follow-through before it runs
  REACH: 1.3,          // a figure this close to its resting ball may swing
  CHARGE_T: 1.15,      // seconds the swing meter takes from 0 to 100 % (then it falls back)

  MAX_OVER: 4,         // strokes allowed on a hole = par + MAX_OVER
  DNF_PENALTY: 1,
  MISSED_HOLE: 2,      // a late joiner gets par + this for each hole already played
  INTRO_T: 5,
  HOLE_END_T: 6,
  RESPAWN_T: 2,        // practice range: a ball that is holed goes back to the tee after this
});

export const SURF = Object.freeze({ ROUGH: 0, FAIRWAY: 1, GREEN: 2, SAND: 3, WATER: 4, TEE: 5, OOB: 6 });

// bounce: vertical speed kept at touchdown. keep: horizontal speed kept at touchdown.
// roll: deceleration of a rolling ball, m/s². power: share of a swing's energy that
// reaches the ball from this lie. scatter: largest random aim error in radians.
export const SURFACE = Object.freeze([
  { name: 'Ruff',    bounce: 0.22, keep: 0.45, roll: 15,  power: 0.8,  scatter: 0.05 },
  { name: 'Fairway', bounce: 0.4,  keep: 0.55, roll: 6.5, power: 1,    scatter: 0 },
  { name: 'Green',   bounce: 0.28, keep: 0.5,  roll: 3.2, power: 1,    scatter: 0 },
  { name: 'Bunker',  bounce: 0,    keep: 0.12, roll: 45,  power: 0.55, scatter: 0.08 },
  { name: 'Vatten',  bounce: 0,    keep: 0,    roll: 99,  power: 1,    scatter: 0 },
  { name: 'Tee',     bounce: 0.4,  keep: 0.55, roll: 6.5, power: 1,    scatter: 0 },
  { name: 'Utanför', bounce: 0,    keep: 0,    roll: 99,  power: 1,    scatter: 0 },
]);

// speed: launch speed at full power from a clean lie. Launch speed goes with the
// square root of power, so distance grows evenly along the swing meter.
export const CLUBS = Object.freeze([
  { name: 'Driver', speed: 41.5, loft: 24 * DEG },
  { name: 'Järn',   speed: 32,   loft: 34 * DEG },
  { name: 'Wedge',  speed: 22,   loft: 52 * DEG },
  { name: 'Putter', speed: 13.5, loft: 0 },
]);
export const PUTTER = 3;

// Bits in a ball's `st`. READY is set by the server in snapshots only: the ball is at
// rest, its figure has reached it and the player may swing.
export const KST = Object.freeze({ MOVING: 1, HOLED: 2, HAZARD: 4, READY: 8 });

// ---------------------------------------------------------------- course geometry

function segDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

export function inShape(s, x, y) {
  if (s.k === 'circle') {
    const dx = x - s.x, dy = y - s.y;
    return dx * dx + dy * dy <= s.r * s.r;
  }
  if (s.k === 'rect') {
    const c = Math.cos(s.a || 0), n = Math.sin(s.a || 0);
    const dx = x - s.x, dy = y - s.y;
    return Math.abs(dx * c + dy * n) <= s.w / 2 && Math.abs(dy * c - dx * n) <= s.h / 2;
  }
  if (s.k === 'path') {
    const h2 = s.w * s.w / 4, pts = s.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (segDistSq(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= h2) return true;
    }
  }
  return false;
}

function inAny(list, x, y) {
  if (list) for (const s of list) if (inShape(s, x, y)) return true;
  return false;
}

function inTee(course, x, y) {
  const t = course.tee, c = Math.cos(t.a), n = Math.sin(t.a), h = KG.TEE_W / 2;
  const dx = x - t.x, dy = y - t.y;
  return Math.abs(dx * c + dy * n) <= h && Math.abs(dy * c - dx * n) <= h;
}

/** What the ground is at (x, y). Sand beats green beats tee beats water beats fairway. */
export function surfaceAt(course, x, y) {
  const b = course.bounds;
  if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) return SURF.OOB;
  if (inAny(course.sand, x, y)) return SURF.SAND;
  if (inAny(course.green, x, y)) return SURF.GREEN;
  if (inTee(course, x, y)) return SURF.TEE;
  if (inAny(course.water, x, y)) return SURF.WATER;
  if (inAny(course.fairway, x, y)) return SURF.FAIRWAY;
  return course.base ?? SURF.ROUGH;
}

/** Where player number i (0-based, in join order) tees off: rows across the tee box. */
export function teeSpot(course, i) {
  const t = course.tee, COLS = 7, GAP = 0.95;
  const c = i % COLS;
  const off = c === 0 ? 0 : (c % 2 ? (c + 1) / 2 : -c / 2);
  const fwd = 1.5 - Math.floor(i / COLS) % 6 * GAP;
  const dx = Math.cos(t.a), dy = Math.sin(t.a);
  return [r2(t.x - dy * off * GAP + dx * fwd), r2(t.y + dx * off * GAP + dy * fwd)];
}

export const maxStrokes = (course) => course.par + KG.MAX_OVER;
export const holeClock = (course) => course.time || 20 + 25 * course.par;

// ---------------------------------------------------------------- the ball

export function createBall(id) {
  return { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, st: 0, air: false, sx: 0, sy: 0, wait: 0, leaf: -1 };
}

export function placeBall(b, x, y) {
  b.x = x; b.y = y; b.z = 0;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.st = 0; b.air = false;
  b.sx = x; b.sy = y;
  b.wait = 0; b.leaf = -1;
}

export const atRest = (b) => !(b.st & (KST.MOVING | KST.HOLED | KST.HAZARD));

/**
 * Hit a ball that is at rest. club = index into CLUBS, power 0..1, angle = direction
 * in the sim plane (radians, atan2(dy, dx)). rnd in [-1, 1] spreads the shot by the
 * lie's scatter. Returns the power that was used.
 */
export function launch(b, course, club, power, angle, rnd = 0) {
  const c = CLUBS[club] || CLUBS[0];
  const lie = SURFACE[surfaceAt(course, b.x, b.y)];
  const p = Math.min(1, Math.max(KG.MIN_POWER, power));
  const v = c.speed * Math.sqrt(p * lie.power);
  const a = angle + rnd * lie.scatter;
  const flat = Math.cos(c.loft) * v;
  b.sx = b.x; b.sy = b.y;
  b.vx = Math.cos(a) * flat;
  b.vy = Math.sin(a) * flat;
  b.vz = Math.sin(c.loft) * v;
  b.z = 0;
  b.air = b.vz > 0;
  b.leaf = -1;
  b.st = KST.MOVING;
  return p;
}

function hazard(b, s, events) {
  events.push([s === SURF.WATER ? 'splash' : 'oob', b.id, r2(b.x), r2(b.y)]);
  b.vx = 0; b.vy = 0; b.vz = 0; b.z = 0;
  b.air = false;
  b.st = KST.HAZARD;
  b.wait = KG.PENALTY_T;
}

function hole(b, course, events, dunk) {
  b.x = course.cup[0]; b.y = course.cup[1]; b.z = 0;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.air = false;
  b.st = KST.HOLED;
  events.push(['holed', b.id, dunk]);
}

// Trees are [x, y, r, h]: leaves of radius r from CANOPY_FROM * h up to h, a trunk below.
function hitTrees(b, course, events) {
  const trees = course.trees;
  if (!trees) return;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    if (b.z >= t[3]) continue;
    const dx = b.x - t[0], dy = b.y - t[1];
    const d2 = dx * dx + dy * dy;
    if (b.z >= t[3] * KG.CANOPY_FROM) {
      if (d2 >= t[2] * t[2] || b.leaf === i) continue;
      b.leaf = i;                                   // each tree slows a shot once
      b.vx *= KG.LEAF_KEEP; b.vy *= KG.LEAF_KEEP;
      if (b.vz > 0) b.vz *= KG.LEAF_KEEP;
      events.push(['tree', b.id, r2(b.x), r2(b.y), r2(b.z)]);
    } else if (d2 < KG.TRUNK_R * KG.TRUNK_R) {
      const d = Math.sqrt(d2) || 1e-6;
      const nx = dx / d, ny = dy / d;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx = (b.vx - 1.4 * vn * nx) * 0.6;
        b.vy = (b.vy - 1.4 * vn * ny) * 0.6;
        events.push(['tree', b.id, r2(b.x), r2(b.y), r2(b.z)]);
      }
      b.x = t[0] + nx * KG.TRUNK_R;
      b.y = t[1] + ny * KG.TRUNK_R;
    }
  }
}

/**
 * Advance one ball by dt. wind = [wx, wy] in m/s. Pushes onto `events`:
 *   ['land', id, x, y, surf, speed]   touchdown (every bounce); speed = downward m/s
 *   ['tree', id, x, y, z]             leaves or trunk
 *   ['splash', id, x, y]              into water: the ball waits PENALTY_T, then 'reset'
 *   ['oob', id, x, y]                 out of bounds: same
 *   ['reset', id]                     the ball is back where it was hit from
 *   ['rest', id, surf]                the ball stopped
 *   ['holed', id, dunk]               dunk = 1 when it dropped straight in from the air
 */
export function stepBall(b, course, wind, dt, events) {
  if (b.st & KST.HAZARD) {
    b.wait -= dt;
    if (b.wait <= 0) {
      placeBall(b, b.sx, b.sy);
      events.push(['reset', b.id]);
    }
    return;
  }
  if (!(b.st & KST.MOVING)) return;

  if (b.air) {
    b.vx += wind[0] * KG.WIND_ACC * dt;
    b.vy += wind[1] * KG.WIND_ACC * dt;
    b.vz -= KG.GRAVITY * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    hitTrees(b, course, events);
    if (b.z > 0) return;

    b.z = 0;
    const s = surfaceAt(course, b.x, b.y);
    if (s === SURF.WATER || s === SURF.OOB) { hazard(b, s, events); return; }
    const cx = course.cup[0] - b.x, cy = course.cup[1] - b.y;
    if (cx * cx + cy * cy <= KG.DUNK_R * KG.DUNK_R) { hole(b, course, events, 1); return; }
    const f = SURFACE[s];
    events.push(['land', b.id, r2(b.x), r2(b.y), s, r2(-b.vz)]);
    b.vz = -b.vz * f.bounce;
    b.vx *= f.keep; b.vy *= f.keep;
    if (b.vz < KG.ROLL_VZ) { b.vz = 0; b.air = false; }
    return;
  }

  const s = surfaceAt(course, b.x, b.y);
  if (s === SURF.WATER || s === SURF.OOB) { hazard(b, s, events); return; }
  const cx = course.cup[0] - b.x, cy = course.cup[1] - b.y;
  const cd = Math.hypot(cx, cy);
  let sp = Math.hypot(b.vx, b.vy);
  if (cd <= KG.CUP_R && sp <= KG.CUP_SPEED) { hole(b, course, events, 0); return; }
  if (cd <= KG.CUP_PULL_R) {
    b.vx += cx / cd * KG.CUP_PULL * dt;
    b.vy += cy / cd * KG.CUP_PULL * dt;
    sp = Math.hypot(b.vx, b.vy);
  }
  const ns = sp - SURFACE[s].roll * dt;
  if (ns <= KG.STOP_SPEED) {
    b.vx = 0; b.vy = 0;
    b.st &= ~KST.MOVING;
    events.push(['rest', b.id, s]);
    return;
  }
  b.vx *= ns / sp; b.vy *= ns / sp;
  b.x += b.vx * dt; b.y += b.vy * dt;
  hitTrees(b, course, events);
}

// ---------------------------------------------------------------- looking ahead

const NO_WIND = [0, 0];

/**
 * Play a shot from (x, y) on a scratch ball. opts.wind = [wx, wy] (default: none).
 * opts.path: an array that is filled with [x, y, z] points of the flight up to the
 * first touchdown (two points for a putt). Returns
 *   { land: [x, y], rest: [x, y], end: 'rest' | 'water' | 'oob' | 'holed', carry, total }
 * where land is the first touchdown and rest is where the ball ends up.
 */
export function predict(course, x, y, angle, club, power, opts = {}) {
  const b = createBall(-1);
  placeBall(b, x, y);
  launch(b, course, club, power, angle, 0);
  const wind = opts.wind || NO_WIND, path = opts.path, ev = [];
  if (path) { path.length = 0; path.push([x, y, 0]); }
  let land = null, end = 'rest';
  for (let n = 1; n <= 2400; n++) {
    stepBall(b, course, wind, KG.DT, ev);
    if (path && !land && b.air && n % 2 === 0) path.push([b.x, b.y, b.z]);
    for (const e of ev) {
      if (e[0] === 'land') { if (!land) land = [e[2], e[3]]; }
      else if (e[0] === 'splash') end = 'water';
      else if (e[0] === 'oob') end = 'oob';
      else if (e[0] === 'holed') end = 'holed';
    }
    ev.length = 0;
    if (end !== 'rest' || !(b.st & KST.MOVING)) break;
  }
  if (!land) land = [b.x, b.y];
  if (path) path.push([land[0], land[1], 0]);
  return {
    land,
    rest: [b.x, b.y],
    end,
    carry: Math.hypot(land[0] - x, land[1] - y),
    total: Math.hypot(b.x - x, b.y - y),
  };
}

/**
 * The power (0..1) that leaves the ball closest to (tx, ty) when hit along `angle`,
 * and how far from the target it stops: { p, miss }. Shots that end in a hazard lose.
 */
export function bestPower(course, x, y, angle, club, tx, ty, opts) {
  let p = 1, miss = Infinity;
  const tryPower = (v) => {
    const r = predict(course, x, y, angle, club, v, opts);
    let m = Math.hypot(r.rest[0] - tx, r.rest[1] - ty);
    if (r.end === 'holed') m = 0;
    else if (r.end !== 'rest') m += 1000;
    if (m < miss) { miss = m; p = v; }
  };
  for (let i = 1; i <= 20; i++) tryPower(i / 20);
  const mid = p;
  for (let i = -4; i <= 4; i++) {
    if (i) tryPower(Math.min(1, Math.max(KG.MIN_POWER, mid + i * 0.01)));
  }
  return { p, miss };
}

// How far each club sends the ball (carry and run) at full power from the fairway.
const FLAT = { bounds: [-1e6, -1e6, 1e6, 1e6], cup: [9e5, 9e5], tee: { x: 9e5, y: -9e5, a: 0 }, base: SURF.FAIRWAY };
export const REACH = Object.freeze(CLUBS.map((c, i) => r2(predict(FLAT, 0, 0, 0, i, 1).total)));

/**
 * Where the caddie would aim from (x, y): the cup when it is within a drive, else the
 * furthest point of course.line that lies ahead and within a drive. Returns [x, y].
 */
export function aimPoint(course, x, y) {
  const line = course.line, cup = course.cup;
  const reach = REACH[0] * 0.95;
  if (!line || line.length < 2 || Math.hypot(cup[0] - x, cup[1] - y) <= reach) return cup;
  let seg = 0, best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = segDistSq(x, y, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    if (d < best) { best = d; seg = i; }
  }
  const far = (i) => Math.hypot(line[i][0] - x, line[i][1] - y);
  let pick = -1;
  for (let i = seg + 1; i < line.length; i++) if (far(i) <= reach) pick = i;
  if (pick < 0) pick = seg + 1;
  else if (far(pick) < 20 && pick < line.length - 1) pick++;   // as good as there: go for the next one
  return line[pick];
}

/** The club the caddie hands you at (x, y) for a shot of `dist` metres. */
export function suggestClub(course, x, y, dist) {
  const s = surfaceAt(course, x, y);
  if (s === SURF.GREEN) return PUTTER;
  if (s === SURF.SAND) return 2;
  const k = SURFACE[s].power;
  if (dist <= REACH[2] * k) return 2;
  if (dist <= REACH[1] * k || s === SURF.ROUGH) return 1;
  return 0;
}
