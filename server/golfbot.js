// Molngolf – bot putting. Pure functions over shared/golf.js; no I/O.
//
// A bot looks at shots along course.line (plus a sweep round the ball), plays each
// one out with the real stepBall, rates where it stops by the walking distance to
// the cup, prefers shots that still work when they are a little off, and then hits
// with its own aim and power error.

import { GOLF, createBall, placeBall, shoot, stepBall, onGround, courseBounds } from '../shared/golf.js';

const CELL = 0.25;
const OOB_PEN = 6;          // metres a lost ball is worth (a stroke and the same lie again)
const POWERS = [1.5, 2.2, 3, 3.8, 4.6, 5.5, 6.5, 7.6, 8.8, 10, 11.3, 12.6, 13.8, 15];
const fields = new WeakMap();

export function createGolfBrain(random = Math.random) {
  const skill = 0.2 + random() * 0.65;           // same spread as the Knuffkampen bots
  return {
    skill,
    aimErr: 0.012 + (1 - skill) * 0.06,           // radians (1 sigma)
    powErr: 0.025 + (1 - skill) * 0.1,            // fraction of the speed (1 sigma)
    think: 0.7 + (1 - skill) * 1.2,               // seconds before a shot
    shootAt: -1,
  };
}

function segDist(px, py, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1;
  const l2 = ex * ex + ey * ey;
  let u = l2 > 0 ? ((px - x1) * ex + (py - y1) * ey) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(px - x1 - ex * u, py - y1 - ey * u);
}

function crosses(ax, ay, bx, by, w) {
  const d = (x1, y1, x2, y2, x3, y3) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const d1 = d(w[0], w[1], w[2], w[3], ax, ay), d2 = d(w[0], w[1], w[2], w[3], bx, by);
  const d3 = d(ax, ay, bx, by, w[0], w[1]), d4 = d(ax, ay, bx, by, w[2], w[3]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Walking distance to the cup over a grid (rails and bumpers block; spinners and pads ignored). */
export function distField(course) {
  let f = fields.get(course);
  if (f) return f;
  const bb = courseBounds(course);
  const x0 = bb.minX, y0 = bb.minY;
  const nx = Math.ceil((bb.maxX - x0) / CELL) + 1, ny = Math.ceil((bb.maxY - y0) / CELL) + 1;
  const free = new Uint8Array(nx * ny);
  const cx = (i) => x0 + (i + 0.5) * CELL, cy = (j) => y0 + (j + 0.5) * CELL;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = cx(i), y = cy(j);
    if (!onGround(course, x, y)) continue;
    let ok = true;
    for (const w of course.walls || []) if (segDist(x, y, w[0], w[1], w[2], w[3]) < GOLF.BALL_R + GOLF.WALL_T - 0.08) { ok = false; break; }
    for (const m of course.bumpers || []) if (ok && Math.hypot(x - m[0], y - m[1]) < m[2] + GOLF.BALL_R - 0.05) ok = false;
    if (ok) free[j * nx + i] = 1;
  }
  const dist = new Float64Array(nx * ny).fill(Infinity);
  const ci = Math.max(0, Math.min(nx - 1, Math.floor((course.cup[0] - x0) / CELL)));
  const cj = Math.max(0, Math.min(ny - 1, Math.floor((course.cup[1] - y0) / CELL)));
  // Dijkstra with a plain binary heap.
  const heap = [];
  const push = (d, k) => {
    heap.push([d, k]);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  const start = cj * nx + ci;
  dist[start] = 0;
  free[start] = 1;
  push(0, start);
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.length) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    const i = k % nx, j = (k - i) / nx;
    for (const [di, dj] of steps) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const kk = b * nx + a;
      if (!free[kk]) continue;
      const nd = d + CELL * Math.hypot(di, dj);
      if (nd >= dist[kk]) continue;
      let blocked = false;
      for (const w of course.walls || []) if (crosses(cx(i), cy(j), cx(a), cy(b), w)) { blocked = true; break; }
      if (blocked) continue;
      dist[kk] = nd;
      push(nd, kk);
    }
  }
  f = {
    at(x, y) {
      const i = Math.floor((x - x0) / CELL), j = Math.floor((y - y0) / CELL);
      let best = Infinity;
      for (let r = 0; r <= 2 && best === Infinity; r++) {
        for (let b = j - r; b <= j + r; b++) for (let a = i - r; a <= i + r; a++) {
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          const v = dist[b * nx + a] + Math.hypot(cx(a) - x, cy(b) - y);
          if (v < best) best = v;
        }
      }
      return best === Infinity ? 999 : best;
    },
  };
  fields.set(course, f);
  return f;
}

/** Play one shot out. Returns { holed } | { oob } | { x, y }, plus t = hole time when it settles. */
export function simulate(course, x, y, vx, vy, t, dt = 1 / 30, maxT = 10) {
  const b = createBall(-1);
  placeBall(b, x, y);
  shoot(b, vx, vy);
  const ev = [];
  for (let k = 0, n = Math.ceil(maxT / dt); k < n; k++) {
    stepBall(b, course, t, dt, ev);
    t += dt;
    if (b.holed) return { holed: true, t };
    if (b.falling) return { oob: true, t: t + GOLF.OOB_T };
    if (!b.moving) return { x: b.x, y: b.y, t };
  }
  return { x: b.x, y: b.y, t };
}

export function rate(field, res, startVal) {
  if (res.holed) return 0;
  if (res.oob) return startVal + OOB_PEN;
  return field.at(res.x, res.y);
}

/** Directions worth trying from (x, y): a sweep plus the line points and the cup. */
export function candidateDirs(course, x, y, sweep = 32, offs = [-0.06, -0.02, 0, 0.02, 0.06]) {
  const dirs = [];
  for (let i = 0; i < sweep; i++) dirs.push((i / sweep) * Math.PI * 2);
  const pts = [...(course.line || []), course.cup];
  for (const [px, py] of pts) {
    if (Math.hypot(px - x, py - y) < 0.3) continue;
    const a = Math.atan2(py - y, px - x);
    for (const o of offs) dirs.push(a + o);
  }
  return dirs;
}

/**
 * Choose a shot for a ball at rest at (x, y) at hole time t.
 * Returns [vx, vy] with the brain's error already applied.
 */
export function planShot(course, x, y, t, brain, random = Math.random, dt = 1 / 20) {
  const field = distField(course);
  const v0 = field.at(x, y);
  const cands = [];
  for (const a of candidateDirs(course, x, y)) {
    const c = Math.cos(a), s = Math.sin(a);
    for (const p of POWERS) {
      cands.push({ a, p, v: rate(field, simulate(course, x, y, c * p, s * p, t, dt), v0) });
    }
  }
  cands.sort((m, n) => m.v - n.v);
  // Robustness: the best few again with the bot's own typical error.
  const ae = brain.aimErr, pe = brain.powErr;
  let best = cands[0], bestScore = Infinity;
  for (const cd of cands.slice(0, 10)) {
    let sum = cd.v;
    for (const [da, dp] of [[ae, 0], [-ae, 0], [0, pe], [0, -pe]]) {
      const a = cd.a + da, p = cd.p * (1 + dp);
      sum += rate(field, simulate(course, x, y, Math.cos(a) * p, Math.sin(a) * p, t, dt), v0);
    }
    if (sum / 5 < bestScore) { bestScore = sum / 5; best = cd; }
  }
  const g = () => { // roughly normal, -3..3
    let s = 0;
    for (let i = 0; i < 6; i++) s += random();
    return (s - 3) * Math.SQRT2;
  };
  const a = best.a + g() * ae;
  const p = best.p * (1 + g() * pe);
  return [Math.cos(a) * p, Math.sin(a) * p];
}
