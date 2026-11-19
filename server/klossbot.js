// Klossgolf – bot golfers. Pure functions over shared/klossgolf.js; no I/O.
//
// A bot asks the caddie (aimPoint, suggestClub, bestPower) like a player would,
// leans into the wind as well as its skill allows, and then swings with its own
// aim and power error.

import { KG, CLUBS, PUTTER, aimPoint, suggestClub, bestPower, predict } from '../shared/klossgolf.js';

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export function createKlossBrain(random = Math.random) {
  return brainForSkill(0.2 + random() * 0.65);     // same spread as the other bots
}

/**
 * A bot of skill 0..1. Errors are modelled on a person at the keyboard: the caddie's
 * direction is mostly kept, but the swing meter is released early or late (off by
 * several percent of the meter, more on a full swing), distances are misjudged, putts
 * are misread and now and then a shot is plainly mishit.
 */
export function brainForSkill(skill, k = TUNE) {
  const u = 1 - skill;
  return {
    skill,
    aimErr: k.aim0 + u * k.aim1,             // full swings: radians (1 sigma)
    powAbs: k.abs0 + u * k.abs1,             // meter units (1 sigma)
    powFull: k.full0 + u * k.full1,          // extra meter units per unit of power
    distRel: k.rel0 + u * k.rel1,            // misjudged distance, fraction (1 sigma)
    puttAim: k.paim0 + u * k.paim1,          // putts: radians (1 sigma)
    puttRel: k.prel0 + u * k.prel1,          // putts: misjudged length, fraction (1 sigma)
    puttAbs: k.pabs0 + u * k.pabs1,          // putts: meter units (1 sigma)
    mishit: k.mis0 + u * k.mis1,             // chance of a clearly bad full swing
    windSense: 0.45 + skill * 0.55,          // how much of the wind it allows for
    shootAt: -1,
  };
}

/** Error scales for brainForSkill (tuned with tools/kloss-check.js). */
export const TUNE = Object.freeze({
  aim0: 0.011, aim1: 0.028,
  abs0: 0.03, abs1: 0.04,
  full0: 0.035, full1: 0.05,
  rel0: 0.035, rel1: 0.05,
  paim0: 0.035, paim1: 0.1,
  prel0: 0.2, prel1: 0.5,
  pabs0: 0.01, pabs1: 0.05,
  mis0: 0.03, mis1: 0.12,
});

/** Seconds a bot waits after its ball becomes READY (0.8 .. 2.5). */
export function botWait(brain, random = Math.random) {
  return 0.8 + random() * 1.7;
}

/** A roughly normal number in about -3..3. */
export function gauss(random) {
  let s = 0;
  for (let i = 0; i < 6; i++) s += random();
  return (s - 3) * Math.SQRT2;
}

/**
 * The caddie's plan from (x, y) with this wind, without any error:
 * { a, p, c, tx, ty, miss }. windSense 0..1 = how much of the wind is allowed for.
 */
export function caddiePlan(course, x, y, wind, windSense = 1) {
  const [tx, ty] = aimPoint(course, x, y);
  const dist = Math.hypot(tx - x, ty - y);
  const c0 = suggestClub(course, x, y, dist);
  const base = Math.atan2(ty - y, tx - x);
  const calm = !wind || (wind[0] === 0 && wind[1] === 0);
  const opts = { wind };

  const plan = (c) => {
    let a = base;
    let r = bestPower(course, x, y, a, c, tx, ty, opts);
    if (!calm && c !== PUTTER && windSense > 0) {
      for (let k = 0; k < 2; k++) {
        const q = predict(course, x, y, a, c, r.p, opts);
        const off = angDiff(base, Math.atan2(q.rest[1] - y, q.rest[0] - x));
        if (Math.abs(off) < 1e-3) break;
        a += off * windSense;
        r = bestPower(course, x, y, a, c, tx, ty, opts);
      }
    }
    return { a, p: r.p, c, tx, ty, miss: r.miss };
  };

  let best = plan(c0);
  // The suggested club cannot get there without trouble: see if another one can.
  if (best.miss >= 1000 && c0 !== PUTTER) {
    for (let c = 0; c < PUTTER; c++) {
      if (c === c0) continue;
      const alt = plan(c);
      if (alt.miss < best.miss) best = alt;
    }
  }
  return best;
}

/** A bot's swing from (x, y): { a, p, c } with the bot's own error applied. */
export function planSwing(course, x, y, wind, brain, random = Math.random) {
  const pl = caddiePlan(course, x, y, wind, brain.windSense);
  let a = pl.a, p = pl.p;
  if (pl.c === PUTTER) {
    a += gauss(random) * brain.puttAim;
    p = p * (1 + gauss(random) * brain.puttRel) + gauss(random) * brain.puttAbs;
  } else {
    a += gauss(random) * brain.aimErr;
    p = p * (1 + gauss(random) * brain.distRel) + gauss(random) * (brain.powAbs + brain.powFull * p);
    if (random() < brain.mishit) {
      if (random() < 0.5) p *= 0.55 + random() * 0.3;                   // a fat or thin one
      else a += (random() < 0.5 ? -1 : 1) * (0.06 + random() * 0.08);  // a slice or a hook
    }
  }
  p = Math.min(1, Math.max(KG.MIN_POWER, p));
  return { a, p, c: Math.min(CLUBS.length - 1, pl.c) };
}
