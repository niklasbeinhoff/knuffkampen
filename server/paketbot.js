// Heta paketet – bot steering during a round. Pure functions over sim bodies.
//
// Uses the Knuffkampen brain (server/bots.js: skill, reaction, aimErr, margin,
// throttle). Without the parcel a bot keeps its distance from the carrier and stays
// off the edge; with it, it chases the nearest car it may pass to and dashes when close.

import { SIM, arenaRadius } from '../shared/sim.js';

const SAFE_D = 9;      // beyond this distance from the carrier a bot relaxes

function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? [x / l, y / l] : [0, 0];
}

function rotate(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/**
 * ctx: { now, random, rings, bodies (array), carrier (id or -1), blocked (id the carrier
 *        may not pass to right now, or -1) }
 */
export function drivePaketBot(brain, body, ctx) {
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
  const mine = ctx.carrier === b.id;
  // The carrier thinks faster: it has somewhere to be.
  brain.nextThink = now + brain.reaction * (mine ? 0.6 : 0.8) * (0.7 + random() * 0.6);

  const R = arenaRadius(ctx.rings);
  const limit = Math.max(SIM.PLAYER_R, R - SIM.PLAYER_R - brain.margin);
  const look = 0.3 + brain.skill * 0.3;
  const px = b.x + b.vx * look, py = b.y + b.vy * look;
  const pr = Math.hypot(px, py);
  const r = Math.hypot(b.x, b.y);

  // 1. Edge danger beats everything.
  if (pr > limit) {
    let [dx, dy] = norm(-px, -py);
    if (dx === 0 && dy === 0) [dx, dy] = rotate(1, 0, random() * Math.PI * 2);
    [dx, dy] = rotate(dx, dy, (random() - 0.5) * 0.4);
    brain.ix = dx; brain.iy = dy;
    const outward = r > 1e-3 ? (b.vx * b.x + b.vy * b.y) / r : 0;
    if (b.cd <= 0 && pr > R - 0.8 && outward > 3 && random() < brain.skill) brain.dash = true;
    return;
  }

  if (mine) return chase(brain, b, ctx, limit);

  const carrier = ctx.carrier >= 0 ? ctx.bodies.find((o) => o.id === ctx.carrier && !o.falling && !o.out) : null;
  const d = carrier ? Math.hypot(carrier.x - b.x, carrier.y - b.y) : Infinity;

  // 2. Nobody to fear (or far away): drift towards a comfortable spot.
  if (!carrier || d > SAFE_D + brain.skill * 3) {
    if (now >= brain.roamUntil || Math.hypot(brain.roamX - b.x, brain.roamY - b.y) < 1.5) {
      let bx = 0, by = 0;
      for (let tries = 0; tries < 6; tries++) {
        const rr = limit * 0.65 * Math.sqrt(random());
        [bx, by] = rotate(rr, 0, random() * Math.PI * 2);
        if (!carrier || Math.hypot(bx - carrier.x, by - carrier.y) > SAFE_D) break;
      }
      brain.roamX = bx; brain.roamY = by;
      brain.roamUntil = now + 1.5 + random() * 2.5;
    }
    const [dx, dy] = norm(brain.roamX - b.x, brain.roamY - b.y);
    const k = brain.throttle * (carrier ? 0.6 : 0.45);
    brain.ix = dx * k; brain.iy = dy * k;
    return;
  }

  // 3. Flee: away from the carrier (where it is heading), bent along the rim and
  //    inward the closer we are to the edge, so nobody backs off the platform.
  const lead = 0.2 + brain.skill * 0.3;
  const cx = carrier.x + carrier.vx * lead, cy = carrier.y + carrier.vy * lead;
  let [fx, fy] = norm(b.x - cx, b.y - cy);
  if (fx === 0 && fy === 0) [fx, fy] = rotate(1, 0, random() * Math.PI * 2);
  const edgeness = Math.min(1, Math.max(0, (r - limit * 0.4) / (limit * 0.6)));
  const [ix, iy] = r > 1e-3 ? [-b.x / r, -b.y / r] : [0, 0];
  // The tangent that points away from the carrier.
  let tx = -iy, ty = ix;
  if (tx * fx + ty * fy < 0) { tx = -tx; ty = -ty; }
  const outwardFlee = -(fx * ix + fy * iy); // > 0: fleeing would take us outward
  const wTan = edgeness * Math.max(0, outwardFlee) * 1.6;
  const wIn = edgeness * edgeness * 1.3;
  // Keep a little room from the other runners too: crowds get bumped off the edge.
  let sx = 0, sy = 0;
  for (const o of ctx.bodies) {
    if (o === b || o === carrier || o.falling || o.out) continue;
    const ox = b.x - o.x, oy = b.y - o.y;
    const od = Math.hypot(ox, oy);
    if (od > 1e-3 && od < 4) { sx += (ox / od) * (4 - od) / 4; sy += (oy / od) * (4 - od) / 4; }
  }
  const wSep = 0.6 * (1 - edgeness * 0.5);
  let [dx, dy] = norm(fx * (1 - edgeness * 0.5) + tx * wTan + ix * wIn + sx * wSep, fy * (1 - edgeness * 0.5) + ty * wTan + iy * wIn + sy * wSep);
  [dx, dy] = rotate(dx, dy, (random() * 2 - 1) * brain.aimErr * 0.5);
  const urgency = Math.min(1, Math.max(0.55, 1.4 - d / SAFE_D));
  brain.ix = dx * brain.throttle * urgency;
  brain.iy = dy * brain.throttle * urgency;

  // 4. Dodge: a quick dash sideways when the carrier closes in fast.
  if (b.cd <= 0 && d < SIM.PLAYER_R * 2 + 1.6) {
    const closing = ((carrier.vx - b.vx) * (b.x - carrier.x) + (carrier.vy - b.vy) * (b.y - carrier.y)) / Math.max(d, 1e-3);
    if (closing > 3 && random() < 0.15 + brain.skill * 0.45) {
      const ex = b.x + dx * 4, ey = b.y + dy * 4;
      if (Math.hypot(ex, ey) < limit) { brain.ix = dx; brain.iy = dy; brain.dash = true; }
    }
  }
}

function chase(brain, b, ctx, limit) {
  const { now, random } = ctx;
  // Nearest car we may pass to; keep the target for a moment so we do not dither.
  let target = null;
  if (brain.target >= 0 && brain.target !== ctx.blocked && now < brain.retargetAt) {
    target = ctx.bodies.find((o) => o.id === brain.target && !o.falling && !o.out && o.id !== b.id) || null;
  }
  if (!target) {
    let best = Infinity;
    for (const o of ctx.bodies) {
      if (o.id === b.id || o.id === ctx.blocked || o.falling || o.out || o.frozen) continue;
      const score = Math.hypot(o.x - b.x, o.y - b.y) + random() * 3;
      if (score < best) { best = score; target = o; }
    }
    brain.target = target ? target.id : -1;
    brain.retargetAt = now + 0.8 + random() * 1.2;
  }
  if (!target) {
    const [dx, dy] = norm(-b.x, -b.y);
    brain.ix = dx * 0.5; brain.iy = dy * 0.5;
    return;
  }

  const dist = Math.hypot(target.x - b.x, target.y - b.y);
  const lead = Math.min(0.6, 0.12 + brain.skill * 0.3 + dist * 0.02);
  let ax = target.x + target.vx * lead, ay = target.y + target.vy * lead;
  // Never aim past the safe radius: catch them on the way, do not follow them off.
  const ar = Math.hypot(ax, ay);
  if (ar > limit) { ax *= limit / ar; ay *= limit / ar; }
  let [dx, dy] = norm(ax - b.x, ay - b.y);
  [dx, dy] = rotate(dx, dy, (random() * 2 - 1) * brain.aimErr * 0.7);
  const th = Math.min(1, brain.throttle + 0.08);
  brain.ix = dx * th; brain.iy = dy * th;

  // Dash when close, unless that would carry us over the edge.
  if (b.cd <= 0 && dist < SIM.PLAYER_R * 2 + 1.2 + brain.skill * 2.2 && random() < 0.35 + brain.skill * 0.4) {
    const [ux, uy] = norm(ax - b.x, ay - b.y);
    const ex = b.x + ux * (dist + 2.5), ey = b.y + uy * (dist + 2.5);
    if (Math.hypot(ex, ey) < limit + SIM.PLAYER_R) {
      brain.ix = ux; brain.iy = uy;
      brain.dash = true;
    }
  }
}
