// Klossgolf – authoritative classic golf. The hole flow (practice range, intro, hole
// clock, strokes, results, standings, late joiners, bots, game switching) is
// Molngolf's (server/golf.js); this file swaps in the balls that fly, the figures
// that run after them, the READY bit, wind and the Klossgolf wire format.

import { GolfGame } from './golf.js';
import { PHASE, GAME } from '../shared/protocol.js';
import {
  KG, KST, CLUBS, SURFACE, teeSpot, createBall, placeBall, atRest, launch, stepBall,
  surfaceAt, maxStrokes, holeClock,
} from '../shared/klossgolf.js';
import { KCOURSES } from '../shared/klosscourses.js';
import { createKlossBrain, planSwing, botWait } from './klossbot.js';

const MAX_FX_PER_SNAP = 48;       // 'land' + 'tree' events per snapshot
const FIG_BACK = 1;               // a figure stops this far short of its ball
const FIG_CUP = 1.5;              // ... and this far from the cup once holed
const FIRST_WIND = 0.3;           // hole 1: at most this share of KG.MAX_WIND

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class KlossGame extends GolfGame {
  constructor(opts = {}) {
    super(opts);
    this.wind = [0, 0];
    this.acc = 0;
    this.fxCount = 0;
  }

  // ---------------------------------------------------------------- hooks (see golf.js)

  get courses() { return KCOURSES; }
  get gameId() { return GAME.KLOSS; }
  get rules() { return KG; }
  holeTime(course) { return holeClock(course); }
  maxStrokes(course) { return maxStrokes(course); }
  ballCanShoot(b) { return atRest(b); }
  ballHoled(b) { return (b.st & KST.HOLED) !== 0; }
  ballAtRest(b) { return atRest(b); }

  newBrain() { return createKlossBrain(this.random); }

  teeBall(id, i) {
    let b = this.balls.get(id);
    if (!b) { b = createBall(id); this.balls.set(id, b); }
    const c = this.course;
    const [x, y] = teeSpot(c, i);
    placeBall(b, x, y);
    // The figure stands just behind its ball, facing down the hole.
    b.fx = r2(x - Math.cos(c.tee.a) * FIG_BACK);
    b.fy = r2(y - Math.sin(c.tee.a) * FIG_BACK);
    b.runAt = 0;
    return b;
  }

  enterFreePlay() {
    this.wind = [0, 0];
    super.enterFreePlay();
  }

  startCountdown(rd) {
    super.startCountdown(rd);
    if (this.phase !== PHASE.COUNTDOWN) return;
    const a = this.random() * Math.PI * 2;
    const v = this.random() * KG.MAX_WIND * (rd === 1 ? FIRST_WIND : 1);
    this.wind = [r1(Math.cos(a) * v), r1(Math.sin(a) * v)];
    this.acc = 0;
  }

  // ---------------------------------------------------------------- swinging

  /** READY: at rest, the figure has reached the ball and the player may swing. */
  isReady(p, b) {
    if (!b || (!p.bot && !p.on) || this.now < b.runAt || !this.canHit(p)) return false;
    return Math.hypot(b.fx - b.x, b.fy - b.y) <= KG.REACH;
  }

  shot() {}   // Molngolf's message; not used here

  swing(id, a, pw, c) {
    const p = this.players.get(id);
    if (!p || p.bot || !p.on) return;
    this.hitKloss(p, a, pw, c);
  }

  hitKloss(p, a, pw, c) {
    if (typeof a !== 'number' || typeof pw !== 'number' || !Number.isFinite(a) || !Number.isFinite(pw)) return;
    if (!Number.isInteger(c) || c < 0 || c >= CLUBS.length) return;
    const b = this.balls.get(p.id);
    if (!this.isReady(p, b)) return;
    const lie = SURFACE[surfaceAt(this.course, b.x, b.y)];
    const rnd = this.random() * 2 - 1;
    const played = launch(b, this.course, c, Math.min(1, Math.max(0, pw)), a, rnd);
    b.runAt = this.now + KG.RUN_DELAY;
    p.hs++;
    this.events.push(['shot', p.id, c, r2(played), r2(normAngle(a + rnd * lie.scatter))]);
    this.rosterDirty = true;
  }

  driveBots(now) {
    for (const p of this.players.values()) {
      if (!p.bot) continue;
      const b = this.balls.get(p.id);
      if (!this.isReady(p, b)) { p.brain.shootAt = -1; continue; }
      if (p.brain.shootAt < 0) { p.brain.shootAt = now + botWait(p.brain, this.random); continue; }
      if (now < p.brain.shootAt) continue;
      p.brain.shootAt = -1;
      const s = planSwing(this.course, b.x, b.y, this.wind, p.brain, this.random);
      this.hitKloss(p, s.a, s.p, s.c);
    }
  }

  // ---------------------------------------------------------------- the world

  stepWorld(dt) {
    const ev = [];
    const wind = this.freePlay ? [0, 0] : this.wind;
    this.acc += dt;
    while (this.acc >= KG.DT - 1e-9) {
      this.acc -= KG.DT;
      for (const b of this.balls.values()) stepBall(b, this.course, wind, KG.DT, ev);
    }
    for (const e of ev) this.onBallEvent(e);
    this.moveFigures(dt);
  }

  moveFigures(dt) {
    const cup = this.course.cup;
    for (const b of this.balls.values()) {
      if (this.now < b.runAt || (b.st & KST.HAZARD)) continue;
      const holed = (b.st & KST.HOLED) !== 0;
      const tx = holed ? cup[0] : b.x, ty = holed ? cup[1] : b.y;
      const stop = holed ? FIG_CUP : FIG_BACK;
      const dx = tx - b.fx, dy = ty - b.fy;
      const d = Math.hypot(dx, dy);
      if (d <= stop) continue;
      const m = Math.min(KG.RUN_SPEED * dt, d - stop);
      b.fx += dx / d * m;
      b.fy += dy / d * m;
    }
  }

  onBallEvent(e) {
    const kind = e[0];
    if (kind === 'rest') return;
    if (kind === 'land' || kind === 'tree') {
      if (this.fxCount++ < MAX_FX_PER_SNAP) this.events.push(e);
      return;
    }
    const p = this.players.get(e[1]);
    if (!p) return;
    if (kind === 'holed') {
      p.in = true;
      p.holeT = this.now - this.playStart;
      this.events.push(['holed', p.id, p.hs, this.v(), e[2] ? 1 : 0]);
      if (this.freePlay) this.respawnAt.set(p.id, this.now + KG.RESPAWN_T);
      this.rosterDirty = true;
    } else if (kind === 'splash' || kind === 'oob') {
      this.events.push(e);
      if (this.phase === PHASE.PLAYING) { p.hs++; this.rosterDirty = true; }
    } else {
      this.events.push(e); // reset
    }
  }

  // ---------------------------------------------------------------- messages

  snapshot(tMs) {
    let pt = 0;
    if (this.phase === PHASE.COUNTDOWN) pt = Math.max(0, KG.INTRO_T - (this.now - this.phaseT));
    else if (this.phase === PHASE.ROUND_END) pt = Math.max(0, KG.HOLE_END_T - (this.now - this.phaseT));
    const tl = this.phase === PHASE.PLAYING ? Math.max(0, holeClock(this.course) - (this.now - this.playStart)) : -1;
    const p = [];
    for (const b of this.balls.values()) {
      const pl = this.players.get(b.id);
      const st = (b.st & (KST.MOVING | KST.HOLED | KST.HAZARD)) | (pl && this.isReady(pl, b) ? KST.READY : 0);
      p.push([b.id, r2(b.x), r2(b.y), r2(b.z), st, pl ? pl.hs : 0, r2(b.fx), r2(b.fy)]);
    }
    const e = this.events;
    this.events = [];
    this.fxCount = 0;
    const free = this.freePlay;
    return {
      t: 's', ts: tMs, g: GAME.KLOSS, ph: this.phase, pt: r2(pt), rd: this.rd, rn: this.holesInMatch(),
      ci: this.ci, tl: r2(tl), w: free ? [0, 0] : [this.wind[0], this.wind[1]], p, e,
    };
  }
}
