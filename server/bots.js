// Knuffkampen – bot steering. Pure functions over sim bodies; no I/O.
//
// Each bot has a "brain" with its own skill. The brain only re-decides every
// `reaction` seconds (reaction delay) and aims with some error, so bots are
// lively but beatable.

import { SIM, arenaRadius } from '../shared/sim.js';

export const BOT_NAMES = Object.freeze([
  'Rubrik-Bot', 'Notis-Bot', 'Deadline-Bot', 'Ingress-Bot', 'Spalt-Bot', 'Byline-Bot',
  'Scoop-Bot', 'Puff-Bot', 'Krönike-Bot', 'Bildtext-Bot', 'Layout-Bot', 'Korrektur-Bot',
  'Löp-Bot', 'Nattred-Bot', 'Webb-Bot', 'Arkiv-Bot',
]);

export function createBrain(random = Math.random) {
  const skill = 0.2 + random() * 0.65; // 0.2 (sleepy) .. 0.85 (sharp)
  return {
    skill,
    reaction: 0.45 - skill * 0.28 + random() * 0.08, // seconds between decisions
    aimErr: 0.15 + (1 - skill) * 0.45,                // radians
    margin: 1.4 + skill * 1.6 + random() * 0.6,       // metres kept from the edge
    throttle: 0.62 + skill * 0.33,                    // top input magnitude
    dashChance: 0.25 + skill * 0.45,
    aggression: 0.35 + random() * 0.5,
    nextThink: 0,
    retargetAt: 0,
    target: -1,
    roamX: 0, roamY: 0, roamUntil: 0,
    dazeUntil: 0,
    ix: 0, iy: 0,
    dash: false,
  };
}

function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? [x / l, y / l] : [0, 0];
}

function rotate(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Steer one bot body for this step.
 * ctx: { now, random, rings, warnIn, freePlay, bodies (array), targeted (Map id -> count) }
 */
export function driveBot(brain, body, ctx) {
  if (body.falling || body.out || body.frozen) {
    body.ix = 0; body.iy = 0; body.dash = false;
    brain.ix = 0; brain.iy = 0;
    return;
  }
  if (ctx.now >= brain.nextThink) think(brain, body, ctx);
  body.ix = brain.ix;
  body.iy = brain.iy;
  if (brain.dash) { body.dash = true; brain.dash = false; }
}

function think(brain, b, ctx) {
  const { now, random } = ctx;
  brain.nextThink = now + brain.reaction * (0.7 + random() * 0.6);

  if (now < brain.dazeUntil) return; // keep doing whatever we were doing

  // Where is it safe to stand? Shrink early when the outer ring is about to go.
  const rings = ctx.rings;
  let safeR = arenaRadius(rings);
  const lookahead = SIM.WARN_T * (0.4 + brain.skill * 0.6);
  if (!ctx.freePlay && ctx.warnIn >= 0 && ctx.warnIn <= lookahead) {
    safeR = rings > 0 ? arenaRadius(rings - 1) : SIM.PLAYER_R * 2;
  }

  const px = b.x + b.vx * (0.3 + brain.skill * 0.3);
  const py = b.y + b.vy * (0.3 + brain.skill * 0.3);
  const pr = Math.hypot(px, py);
  const r = Math.hypot(b.x, b.y);
  const limit = Math.max(SIM.PLAYER_R, safeR - SIM.PLAYER_R - brain.margin);

  // 1. Edge danger: head inward, maybe panic-dash.
  if (pr > limit) {
    let [dx, dy] = norm(-px, -py);
    if (dx === 0 && dy === 0) [dx, dy] = rotate(1, 0, random() * Math.PI * 2);
    [dx, dy] = rotate(dx, dy, (random() - 0.5) * 0.5);
    brain.ix = dx; brain.iy = dy;
    const outward = r > 1e-3 ? (b.vx * b.x + b.vy * b.y) / r : 0;
    if (b.cd <= 0 && pr > safeR - 0.6 && outward > 3 && random() < brain.skill) brain.dash = true;
    return;
  }

  // 2. Occasionally zone out (weaker bots more often).
  if (random() < (1 - brain.skill) * 0.06) {
    brain.dazeUntil = now + 0.4 + random() * 0.8;
    if (random() < 0.5) { brain.ix = 0; brain.iy = 0; }
    else { [brain.ix, brain.iy] = rotate(brain.throttle * 0.6, 0, random() * Math.PI * 2); }
    return;
  }

  // 3. Pick / keep a target.
  let target = null;
  if (brain.target >= 0) {
    target = ctx.bodies.find((o) => o.id === brain.target && !o.falling && !o.out) || null;
  }
  if (!target || now >= brain.retargetAt) {
    if (target) {
      const prev = ctx.targeted.get(brain.target) || 0;
      if (prev > 0) ctx.targeted.set(brain.target, prev - 1);
    }
    target = null;
    let best = Infinity;
    for (const o of ctx.bodies) {
      if (o.id === b.id || o.falling || o.out) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      const score = d + (ctx.targeted.get(o.id) || 0) * 6 + random() * 5;
      if (score < best) { best = score; target = o; }
    }
    brain.target = target ? target.id : -1;
    if (target) ctx.targeted.set(target.id, (ctx.targeted.get(target.id) || 0) + 1);
    brain.retargetAt = now + 1.5 + random() * 2.5;
  }

  const dist = target ? Math.hypot(target.x - b.x, target.y - b.y) : Infinity;
  const roam = !target || (ctx.freePlay && dist > 10) || random() > brain.aggression + 0.35;

  if (roam) {
    if (now >= brain.roamUntil || Math.hypot(brain.roamX - b.x, brain.roamY - b.y) < 1.5) {
      const rr = limit * 0.6 * Math.sqrt(random());
      [brain.roamX, brain.roamY] = rotate(rr, 0, random() * Math.PI * 2);
      brain.roamUntil = now + 2 + random() * 3;
    }
    const [dx, dy] = norm(brain.roamX - b.x, brain.roamY - b.y);
    brain.ix = dx * brain.throttle * 0.75;
    brain.iy = dy * brain.throttle * 0.75;
    return;
  }

  // 4. Chase. Smarter bots lead the target and try to get between it and the centre.
  const lead = 0.15 + brain.skill * 0.25;
  let ax = target.x + target.vx * lead;
  let ay = target.y + target.vy * lead;
  const tr = Math.hypot(target.x, target.y);
  if (r > tr + 1 && tr > 2 && random() < brain.skill) {
    const k = Math.max(0, tr - 2.2) / tr;
    ax = target.x * k; ay = target.y * k;
  }
  let [dx, dy] = norm(ax - b.x, ay - b.y);
  [dx, dy] = rotate(dx, dy, (random() * 2 - 1) * brain.aimErr);
  brain.ix = dx * brain.throttle;
  brain.iy = dy * brain.throttle;

  // 5. Dash when a hit would shove the target outward and we will not overshoot.
  if (b.cd <= 0 && dist < SIM.PLAYER_R * 2 + 1.5 + brain.skill * 2.5 && tr > 1e-3) {
    const [ux, uy] = norm(target.x - b.x, target.y - b.y);
    const outwardness = (ux * target.x + uy * target.y) / tr;
    const roomBehind = r + 5 < limit;
    if (outwardness > 0.45 - brain.skill * 0.25 && roomBehind && random() < brain.dashChance) {
      brain.ix = ux; brain.iy = uy;
      brain.dash = true;
    }
  }
}
