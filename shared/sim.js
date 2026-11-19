// Knuffkampen – shared physics. The server is authoritative and runs step();
// the client only reads the constants (arena size, timings, cooldowns).
//
// Sim space: (x, y) is the ice plane, z is height (0 on the ice, negative while falling).

export const SIM = Object.freeze({
  HZ: 60,            // simulation steps per second
  SNAP_HZ: 30,       // snapshots per second sent to clients

  PLAYER_R: 0.9,     // body radius (m)
  ACCEL: 17,         // input acceleration (m/s^2)
  DRAG: 1.5,         // exponential drag (1/s) -> top speed ~ ACCEL / DRAG
  MAX_SPEED: 32,

  DASH_SPEED: 13,    // instant velocity added by a dash ("knuff")
  DASH_CD: 2.5,      // seconds between dashes
  CHARGE_T: 0.45,    // seconds after a dash during which a hit is "charged"
  CHARGE_MULT: 1.9,  // knockback multiplier dealt by a charged body
  CHARGE_RECOIL: 0.35, // share of the recoil a charged body takes itself

  RESTITUTION: 1.05, // > 1: bumpers add a little energy
  MIN_KICK: 2.2,     // smallest impulse of any contact, so slow nudges still push

  GRAVITY: 30,
  KILL_Z: -45,       // below this a falling body is gone

  CORE_R: 4,         // radius of the centre disc
  RING_W: 2.2,       // width of each ring around it
  MIN_RINGS: 3,
  MAX_RINGS: 8,
  LOBBY_RINGS: 3,

  FIRST_FALL: 11,    // seconds into a round when the outermost ring falls
  FALL_EVERY: 9,     // seconds between ring falls after that
  WARN_T: 3,         // seconds of warning before a ring (or the core) falls
  SUDDEN_T: 14,      // seconds on the bare core before it falls too

  COUNTDOWN_T: 3.5,
  ROUND_END_T: 5,
  KO_CREDIT_T: 4,    // a fall within this long after a hit is credited to the hitter
  RESPAWN_T: 1.2,    // lobby free-play respawn delay
});

/** Radius of the live platform for a given number of live rings (-1 = core gone). */
export function arenaRadius(rings) {
  return rings < 0 ? 0 : SIM.CORE_R + rings * SIM.RING_W;
}

/** How many rings a round starts with for n participants. */
export function ringsForPlayers(n) {
  const wanted = Math.ceil((Math.sqrt((22 * Math.max(1, n)) / Math.PI) - SIM.CORE_R) / SIM.RING_W);
  return Math.max(SIM.MIN_RINGS, Math.min(SIM.MAX_RINGS, wanted));
}

export function createBody(id) {
  return {
    id,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    face: 0,          // heading, atan2(dy, dx) in the sim plane
    ix: 0, iy: 0,     // current input, each in [-1, 1]
    dash: false,      // dash requested (consumed by step)
    cd: 0,            // dash cooldown left (s)
    charge: 0,        // charged time left (s)
    frozen: false,    // true during the countdown
    falling: false,
    out: false,       // fell below KILL_Z
    lastHitBy: -1,
    lastHitAt: -1e9,
  };
}

/** Put a body back on the ice, at rest. */
export function placeBody(b, x, y, face) {
  b.x = x; b.y = y; b.z = 0;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.face = face;
  b.ix = 0; b.iy = 0; b.dash = false;
  b.cd = 0; b.charge = 0;
  b.falling = false; b.out = false;
  b.lastHitBy = -1; b.lastHitAt = -1e9;
}

/**
 * Advance all bodies by dt seconds on a platform of the given radius.
 * Appends to events:
 *   ['dash', id]
 *   ['hit', x, y, strength, idA, idB]   strength = impulse in m/s
 *   ['fall', id]                        body left the platform (cannot come back)
 * `now` is the caller's clock in seconds, used for KO credit.
 */
export function step(bodies, radius, dt, now, events) {
  const S = SIM;
  const drag = Math.exp(-S.DRAG * dt);

  for (const b of bodies) {
    if (b.out) continue;

    if (b.falling) {
      b.vz -= S.GRAVITY * dt;
      b.z += b.vz * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.z < S.KILL_Z) b.out = true;
      continue;
    }

    if (b.cd > 0) b.cd = Math.max(0, b.cd - dt);
    if (b.charge > 0) b.charge = Math.max(0, b.charge - dt);

    if (b.frozen) {
      b.vx = 0; b.vy = 0; b.dash = false;
      continue;
    }

    let ix = b.ix, iy = b.iy;
    const il = Math.hypot(ix, iy);
    if (il > 1) { ix /= il; iy /= il; }
    if (il > 0.05) {
      b.face = Math.atan2(iy, ix);
      const acc = S.ACCEL * (b.acc || 1);   // b.acc: optional per-body multiplier
      b.vx += ix * acc * dt;
      b.vy += iy * acc * dt;
    }

    if (b.dash) {
      b.dash = false;
      if (b.cd <= 0) {
        const dx = il > 0.05 ? b.ix / il : Math.cos(b.face);
        const dy = il > 0.05 ? b.iy / il : Math.sin(b.face);
        b.vx += dx * S.DASH_SPEED;
        b.vy += dy * S.DASH_SPEED;
        b.cd = S.DASH_CD;
        b.charge = S.CHARGE_T;
        events.push(['dash', b.id]);
      }
    }

    b.vx *= drag;
    b.vy *= drag;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > S.MAX_SPEED) {
      b.vx *= S.MAX_SPEED / sp;
      b.vy *= S.MAX_SPEED / sp;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  // Body-body collisions (equal mass circles).
  const minD = S.PLAYER_R * 2;
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    if (a.out || a.falling) continue;
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      if (b.out || b.falling) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
      const nx = dx / d, ny = dy / d;

      const push = (minD - d) / 2;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;

      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn >= 0) continue; // already separating

      const base = Math.max(S.MIN_KICK, (-(1 + S.RESTITUTION) * vn) / 2);
      let ja = base, jb = base;
      const ca = a.charge > 0, cb = b.charge > 0;
      if (ca && !cb) { jb *= S.CHARGE_MULT; ja *= S.CHARGE_RECOIL; }
      else if (cb && !ca) { ja *= S.CHARGE_MULT; jb *= S.CHARGE_RECOIL; }
      a.charge = 0; b.charge = 0;

      a.vx -= nx * ja; a.vy -= ny * ja;
      b.vx += nx * jb; b.vy += ny * jb;

      a.lastHitBy = b.id; a.lastHitAt = now;
      b.lastHitBy = a.id; b.lastHitAt = now;
      events.push(['hit', (a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(ja, jb), a.id, b.id]);
    }
  }

  // Edge: a body whose centre leaves the platform falls.
  for (const b of bodies) {
    if (b.out || b.falling) continue;
    if (Math.hypot(b.x, b.y) > radius) {
      b.falling = true;
      b.vz = 0;
      b.charge = 0;
      events.push(['fall', b.id]);
    }
  }
}
