// Minigolf – constants, course format and ball physics, shared by server and client.
// The server is authoritative and runs stepBall(); the client reads the courses to
// draw them. Sim space is the same as in sim.js: (x, y) is the ground plane in
// metres, z is height (0 on the green, negative while falling).

export const GOLF = Object.freeze({
  BALL_R: 0.22,
  WALL_T: 0.14,        // half thickness of rails and spinner bars

  MAX_POWER: 15,       // ball speed (m/s) at full power
  MIN_POWER: 1.5,
  FRICTION: 2.4,       // rolling deceleration (m/s^2)
  DRAG: 0.3,           // extra speed-proportional drag (1/s)
  STOP_SPEED: 0.15,
  MAX_SPEED: 26,

  WALL_REST: 0.74,
  SPINNER_REST: 0.85,
  BUMPER_REST: 1.0,
  BUMPER_KICK: 7,      // a bumper sends the ball away at least this fast

  CUP_R: 0.45,         // the ball drops when its centre is this close to the cup...
  CUP_SPEED: 4.5,      // ...and it is slower than this (a full-power ball skips over)
  CUP_PULL_R: 0.68,    // inside this radius the ball is drawn toward the cup
  CUP_PULL: 9,         // m/s^2

  GRAVITY: 30,
  OOB_T: 1.1,          // seconds a ball falls before it is put back
  SUBSTEPS: 4,         // per simulation step

  HOLE_TIME: 50,       // seconds per hole
  MAX_STROKES: 8,
  DNF_PENALTY: 2,      // added to the strokes of a ball that never dropped
  MISSED_HOLE: 2,      // strokes over par for a hole played before you joined
  INTRO_T: 3.5,        // hole introduction (PHASE.COUNTDOWN)
  HOLE_END_T: 6,       // hole results (PHASE.ROUND_END)
  RESPAWN_T: 1.5,      // practice green: back to the tee after holing out
});

// Bit flags in the `st` field of a ball in a golf snapshot.
export const BALL = Object.freeze({ MOVING: 1, HOLED: 2, FALLING: 4 });

/*
COURSE FORMAT (frozen: the scene draws exactly this, the server simulates exactly this)

{
  name: 'Raksträckan',          // Swedish, shown to players
  par: 2,
  tee: [x, y],
  cup: [x, y],
  ground: [                     // the playable surface is the union of these shapes
    { k: 'rect', x, y, w, h, a },     // centre x, y; size w, h; a = rotation in radians (optional)
    { k: 'circle', x, y, r },
  ],
  walls: [[x1, y1, x2, y2], ...],     // rails; the ball bounces off them
  bumpers: [[x, y, r], ...],          // round bouncers that kick the ball away
  spinners: [{ x, y, len, speed, phase }],
      // a bar of length len turning about its centre; angle = phase + speed * t
      // (radians, radians per second, t = seconds the hole has been running)
  boosts: [{ x, y, w, h, a, power }],
      // a rectangle (centre, size, rotation a) that accelerates the ball along
      // its own +x axis; power in m/s^2
  line: [[x, y], ...],          // a sensible route from tee to cup; bots aim along it
}

A ball whose centre is over no ground shape has left the course: it falls and is put
back where its last shot was taken from. Rails are optional, so an open edge is a hazard.
COURSES[0] is the practice green (lobby and after a match). A match plays COURSES[1..].
Lay holes out wider than tall (x is the long axis) and keep them within about 34 x 20 m.
*/

export const COURSES = [
  {
    name: 'Övningsgreenen',
    par: 2,
    tee: [-6.5, 0],
    cup: [6.5, 0],
    ground: [{ k: 'rect', x: 0, y: 0, w: 19, h: 10 }],
    walls: [
      [-9.36, -4.86, 9.36, -4.86], [9.36, -4.86, 9.36, 4.86],
      [9.36, 4.86, -9.36, 4.86], [-9.36, 4.86, -9.36, -4.86],
    ],
    bumpers: [[0, 1.7, 0.75], [1.6, -2.1, 0.6]],
    spinners: [],
    boosts: [],
    line: [[-6.5, 0], [6.5, 0]],
  },
  {
    name: 'Raksträckan',
    par: 2,
    tee: [-9.5, 0],
    cup: [8.6, 0],
    // Open at the far end: too much power and the ball leaves the course.
    ground: [{ k: 'rect', x: 0, y: 0, w: 23, h: 5 }],
    walls: [
      [-11.36, -2.36, 11.5, -2.36], [-11.36, 2.36, 11.5, 2.36], [-11.36, -2.36, -11.36, 2.36],
    ],
    bumpers: [],
    spinners: [],
    boosts: [],
    line: [[-9.5, 0], [8.6, 0]],
  },
  {
    name: 'Hundbenet',
    par: 3,
    tee: [-12, -5],
    cup: [5.5, 4],
    // An L: the slanted rail in the outer corner turns a well-paced ball up the second leg.
    ground: [
      { k: 'rect', x: -3, y: -5, w: 22, h: 5 },
      { k: 'rect', x: 5.5, y: -0.5, w: 5, h: 14 },
    ],
    walls: [
      [-13.86, -7.36, 7.86, -7.36], [-13.86, -7.36, -13.86, -2.64], [-13.86, -2.64, 3.14, -2.64],
      [3.14, -2.64, 3.14, 6.36], [7.86, -7.36, 7.86, 6.36], [3.14, 6.36, 7.86, 6.36],
      [5, -7.36, 7.86, -4.5],
    ],
    bumpers: [],
    spinners: [],
    boosts: [],
    line: [[-12, -5], [5.5, -5], [5.5, 4]],
  },
  {
    name: 'Väderkvarnen',
    par: 3,
    tee: [-11, 0],
    cup: [10.5, 0],
    // A gate with a windmill in it: the sails always cover the middle, so slip
    // through beside them when they lie flat.
    ground: [{ k: 'rect', x: 0, y: 0, w: 26, h: 6 }],
    walls: [
      [-12.86, -2.86, 12.86, -2.86], [12.86, -2.86, 12.86, 2.86],
      [12.86, 2.86, -12.86, 2.86], [-12.86, 2.86, -12.86, -2.86],
      [6, -2.86, 6, -1.6], [6, 1.6, 6, 2.86],
    ],
    bumpers: [],
    spinners: [{ x: 6, y: 0, len: 3, speed: 1.3, phase: 0 }],
    boosts: [],
    line: [[-11, 0], [3, 0.8], [9, 0.8], [10.5, 0]],
  },
  {
    name: 'Flipperspelet',
    par: 3,
    tee: [-11, 0],
    cup: [10, 0],
    // A field of bumpers between tee and cup, and a few more on the way round.
    ground: [{ k: 'rect', x: 0, y: 0, w: 26, h: 14 }],
    walls: [
      [-12.86, -6.86, 12.86, -6.86], [12.86, -6.86, 12.86, 6.86],
      [12.86, 6.86, -12.86, 6.86], [-12.86, 6.86, -12.86, -6.86],
    ],
    bumpers: [
      [-4, -4.2, 0.7], [-4, 0, 0.7], [-4, 4.2, 0.7], [0, -2.1, 0.7], [0, 2.1, 0.7],
      [4, -4.2, 0.7], [4, 0, 0.7], [4, 4.2, 0.7], [7.5, -1.8, 0.6], [7.5, 1.8, 0.6],
      [8.5, -5.4, 0.6], [8.5, 5.4, 0.6], [-8, 6, 0.5], [-8, -6, 0.5],
    ],
    spinners: [],
    boosts: [],
    line: [[-11, 0], [-6, 5], [6, 5.6], [10, 0]],
  },
  {
    name: 'Bron',
    par: 3,
    tee: [-12.5, 0],
    cup: [10.2, 1.2],
    // A narrow bridge without rails over to a round green with a rail at the back.
    ground: [
      { k: 'rect', x: -12.5, y: 0, w: 5, h: 6 },
      { k: 'rect', x: -2, y: 0, w: 16.6, h: 1.6 },
      { k: 'circle', x: 9.5, y: 0, r: 3.5 },
    ],
    walls: [
      [-14.86, -2.86, -14.86, 2.86], [-14.86, 2.86, -10.14, 2.86], [-14.86, -2.86, -10.14, -2.86],
      [11.18, -2.91, 12.41, -1.68], [12.41, -1.68, 12.86, 0], [12.86, 0, 12.41, 1.68], [12.41, 1.68, 11.18, 2.91],
    ],
    bumpers: [],
    spinners: [],
    boosts: [],
    line: [[-12.5, 0], [-2, 0], [8, 0], [10.2, 1.2]],
  },
];

// ---------------------------------------------------------------- geometry

function inRect(s, x, y) {
  const a = s.a || 0;
  let dx = x - s.x, dy = y - s.y;
  if (a) {
    const c = Math.cos(a), n = Math.sin(a);
    const lx = dx * c + dy * n;
    dy = -dx * n + dy * c;
    dx = lx;
  }
  return Math.abs(dx) <= s.w / 2 && Math.abs(dy) <= s.h / 2;
}

/** Is the point over the playable surface? */
export function onGround(course, x, y) {
  for (const s of course.ground) {
    if (s.k === 'circle') {
      const dx = x - s.x, dy = y - s.y;
      if (dx * dx + dy * dy <= s.r * s.r) return true;
    } else if (inRect(s, x, y)) return true;
  }
  return false;
}

/** Axis-aligned bounds of everything in the course: { minX, minY, maxX, maxY }. */
export function courseBounds(course) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const s of course.ground) {
    if (s.k === 'circle') {
      add(s.x - s.r, s.y - s.r); add(s.x + s.r, s.y + s.r);
    } else {
      const c = Math.cos(s.a || 0), n = Math.sin(s.a || 0);
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = (u * s.w) / 2, ly = (v * s.h) / 2;
        add(s.x + lx * c - ly * n, s.y + lx * n + ly * c);
      }
    }
  }
  for (const w of course.walls || []) { add(w[0], w[1]); add(w[2], w[3]); }
  return { minX, minY, maxX, maxY };
}

/** Where ball number i of n starts: a small cluster round the tee, always on the green. */
export function teeSpot(course, i) {
  if (i <= 0) return [course.tee[0], course.tee[1]];
  const ang = i * 2.39996, r = Math.min(0.75, 0.2 * Math.sqrt(i));
  const x = course.tee[0] + Math.cos(ang) * r, y = course.tee[1] + Math.sin(ang) * r;
  return onGround(course, x, y) ? [x, y] : [course.tee[0], course.tee[1]];
}

// ---------------------------------------------------------------- balls

export function createBall(id) {
  return {
    id,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    moving: false,
    holed: false,
    falling: false,
    fallT: 0,
    fromX: 0, fromY: 0,   // where the last shot was taken from
    inBoost: false,
  };
}

/** Put a ball at rest on the green. */
export function placeBall(b, x, y) {
  b.x = x; b.y = y; b.z = 0;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.moving = false; b.holed = false; b.falling = false;
  b.fallT = 0; b.inBoost = false;
  b.fromX = x; b.fromY = y;
}

export function canShoot(b) {
  return !b.moving && !b.holed && !b.falling;
}

/**
 * Hit the ball. (vx, vy) is the wanted velocity; its length is clamped to
 * MIN_POWER..MAX_POWER. Returns the power as 0..1, or -1 if the ball cannot be hit now.
 * Counting strokes is the caller's job.
 */
export function shoot(b, vx, vy) {
  if (!canShoot(b)) return -1;
  const sp = Math.hypot(vx, vy);
  if (!(sp > 1e-6)) return -1;
  const want = Math.max(GOLF.MIN_POWER, Math.min(GOLF.MAX_POWER, sp));
  b.fromX = b.x; b.fromY = b.y;
  b.vx = (vx / sp) * want;
  b.vy = (vy / sp) * want;
  b.moving = true;
  return (want - GOLF.MIN_POWER) / (GOLF.MAX_POWER - GOLF.MIN_POWER);
}

/** End points of a spinner bar at hole time t. */
export function spinnerEnds(s, t) {
  const a = s.phase + s.speed * t;
  const hx = (Math.cos(a) * s.len) / 2, hy = (Math.sin(a) * s.len) / 2;
  return [s.x - hx, s.y - hy, s.x + hx, s.y + hy];
}

// Collide the ball with a thick segment. (px, py, omega): the segment turns about
// that point at omega rad/s (0 for a fixed rail).
function hitSegment(b, x1, y1, x2, y2, px, py, omega, rest, kind, events) {
  const ex = x2 - x1, ey = y2 - y1;
  const len2 = ex * ex + ey * ey;
  let u = len2 > 0 ? ((b.x - x1) * ex + (b.y - y1) * ey) / len2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const qx = x1 + ex * u, qy = y1 + ey * u;
  let dx = b.x - qx, dy = b.y - qy;
  const min = GOLF.BALL_R + GOLF.WALL_T;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return false;
  let d = Math.sqrt(d2);
  if (d < 1e-6) {           // dead centre: leave along the segment's normal, against the motion
    const l = Math.sqrt(len2) || 1;
    dx = -ey / l; dy = ex / l;
    if (dx * b.vx + dy * b.vy > 0) { dx = -dx; dy = -dy; }
    d = 1;
  }
  const nx = dx / d, ny = dy / d;
  b.x = qx + nx * min;
  b.y = qy + ny * min;
  const sx = -omega * (qy - py), sy = omega * (qx - px);   // surface velocity at the contact
  const vn = (b.vx - sx) * nx + (b.vy - sy) * ny;
  if (vn < 0) {
    b.vx -= (1 + rest) * vn * nx;
    b.vy -= (1 + rest) * vn * ny;
    if (-vn > 1) events.push(['bounce', qx, qy, -vn, kind]);
  }
  return true;
}

function touchesSpinner(b, course, t) {
  const min = GOLF.BALL_R + GOLF.WALL_T;
  for (const s of course.spinners || []) {
    const [x1, y1, x2, y2] = spinnerEnds(s, t);
    const ex = x2 - x1, ey = y2 - y1;
    let u = ((b.x - x1) * ex + (b.y - y1) * ey) / (ex * ex + ey * ey || 1);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = b.x - (x1 + ex * u), dy = b.y - (y1 + ey * u);
    if (dx * dx + dy * dy < min * min) return true;
  }
  return false;
}

/**
 * Advance one ball by dt seconds. t is the hole time at the start of the step.
 * Appends to events:
 *   ['bounce', x, y, speed, kind]   kind 0 = rail, 1 = bumper, 2 = spinner
 *   ['boost', id]                   rolled onto a boost pad
 *   ['holed', id]                   dropped into the cup
 *   ['oob', id]                     left the course and is falling
 *   ['reset', id]                   put back where the last shot was taken from
 */
export function stepBall(b, course, t, dt, events) {
  const G = GOLF;
  if (b.holed) return;

  if (b.falling) {
    b.vz -= G.GRAVITY * dt;
    b.z += b.vz * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.fallT += dt;
    if (b.fallT >= G.OOB_T) {
      placeBall(b, b.fromX, b.fromY);
      events.push(['reset', b.id]);
    }
    return;
  }

  if (!b.moving) {
    if (!touchesSpinner(b, course, t)) return;
    b.moving = true;       // a spinner swept into a resting ball
  }

  const h = dt / G.SUBSTEPS;
  const cupX = course.cup[0], cupY = course.cup[1];

  for (let s = 0; s < G.SUBSTEPS; s++) {
    const ts = t + s * h;

    let boosted = false;
    for (const z of course.boosts || []) {
      const c = Math.cos(z.a || 0), n = Math.sin(z.a || 0);
      const dx = b.x - z.x, dy = b.y - z.y;
      if (Math.abs(dx * c + dy * n) <= z.w / 2 && Math.abs(-dx * n + dy * c) <= z.h / 2) {
        b.vx += c * z.power * h;
        b.vy += n * z.power * h;
        boosted = true;
      }
    }
    if (boosted && !b.inBoost) events.push(['boost', b.id]);
    b.inBoost = boosted;

    const cx = cupX - b.x, cy = cupY - b.y;
    const cd = Math.hypot(cx, cy);
    let sp = Math.hypot(b.vx, b.vy);
    if (cd < G.CUP_R && sp < G.CUP_SPEED) {
      b.x = cupX; b.y = cupY; b.z = -0.25;
      b.vx = 0; b.vy = 0;
      b.moving = false; b.holed = true;
      events.push(['holed', b.id]);
      return;
    }
    const nearCup = cd < G.CUP_PULL_R;
    if (nearCup && cd > 1e-6) {
      b.vx += (cx / cd) * G.CUP_PULL * h;
      b.vy += (cy / cd) * G.CUP_PULL * h;
      sp = Math.hypot(b.vx, b.vy);
    }

    if (sp > 0) {
      let ns = Math.max(0, sp - (G.FRICTION + G.DRAG * sp) * h);
      if (ns > G.MAX_SPEED) ns = G.MAX_SPEED;
      b.vx *= ns / sp;
      b.vy *= ns / sp;
    }
    b.x += b.vx * h;
    b.y += b.vy * h;

    for (const w of course.walls || []) hitSegment(b, w[0], w[1], w[2], w[3], 0, 0, 0, G.WALL_REST, 0, events);
    for (const sn of course.spinners || []) {
      const e = spinnerEnds(sn, ts);
      hitSegment(b, e[0], e[1], e[2], e[3], sn.x, sn.y, sn.speed, G.SPINNER_REST, 2, events);
    }
    for (const m of course.bumpers || []) {
      let dx = b.x - m[0], dy = b.y - m[1];
      const min = m[2] + G.BALL_R;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
      const nx = dx / d, ny = dy / d;
      b.x = m[0] + nx * min;
      b.y = m[1] + ny * min;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= (1 + G.BUMPER_REST) * vn * nx;
        b.vy -= (1 + G.BUMPER_REST) * vn * ny;
      }
      const out = b.vx * nx + b.vy * ny;
      if (out < G.BUMPER_KICK) {
        b.vx += (G.BUMPER_KICK - out) * nx;
        b.vy += (G.BUMPER_KICK - out) * ny;
      }
      events.push(['bounce', b.x - nx * G.BALL_R, b.y - ny * G.BALL_R, Math.max(-vn, G.BUMPER_KICK), 1]);
    }

    if (!onGround(course, b.x, b.y)) {
      b.moving = false;
      b.falling = true;
      b.fallT = 0;
      b.vz = 0;
      b.inBoost = false;
      events.push(['oob', b.id]);
      return;
    }

    if (!boosted && !nearCup && Math.hypot(b.vx, b.vy) < G.STOP_SPEED) {
      b.vx = 0; b.vy = 0;
      b.moving = false;
      return;
    }
  }
}
