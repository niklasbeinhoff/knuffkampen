// Molngolf – authoritative minigolf logic. Same shape as Game (server/game.js), whose
// player handling (join, tokens, names, colours, bots, kick) it inherits; the rounds
// are holes and the bodies are balls. No sockets, no timers, no disk.
//
// The hole flow (practice, intro, hole clock, strokes, results, standings, late
// joiners) is shared with Klossgolf (server/kloss.js), which subclasses this and
// overrides the hooks in the "game-specific hooks" section.

import { Game } from './game.js';
import { PHASE, GAME } from '../shared/protocol.js';
import {
  GOLF, BALL, COURSES, teeSpot, createBall, placeBall, canShoot, shoot, stepBall,
} from '../shared/golf.js';
import { createGolfBrain, planShot } from './golfbot.js';

const GRACE = 30;            // seconds a dropped player is kept
export const SETTLE_T = 4;          // after the hole clock: time for rolling balls to stop
const MAX_BOUNCES_PER_SNAP = 48;
const PLAN_GAP = 3;          // updates between bot shot searches (each costs ~10-20 ms)

const r2 = (v) => Math.round(v * 100) / 100;

export class GolfGame extends Game {
  constructor(opts = {}) {
    super(opts);
    this.balls = new Map();    // id -> ball
    this.ci = 0;
    this.courseT = 0;
    this.holes = [];
    this.holesDone = 0;
    this.overtime = false;
    this.bounceCount = 0;
    this.spawnSeq = 0;
    this.planWait = 0;
    this.setCourse(0);
  }

  get course() { return this.courses[this.ci]; }

  // ---------------------------------------------------------------- game-specific hooks

  get courses() { return COURSES; }
  get gameId() { return GAME.GOLF; }
  /** Rule constants: INTRO_T, HOLE_END_T, RESPAWN_T, MISSED_HOLE, DNF_PENALTY. */
  get rules() { return GOLF; }
  holeTime() { return GOLF.HOLE_TIME; }
  maxStrokes() { return GOLF.MAX_STROKES; }
  ballCanShoot(b) { return canShoot(b); }
  ballHoled(b) { return b.holed; }
  ballAtRest(b) { return !b.moving && !b.falling; }

  /** Put player `id`'s ball (reused or new) on tee spot i of the current course. */
  teeBall(id, i) {
    let b = this.balls.get(id);
    if (!b) { b = createBall(id); this.balls.set(id, b); }
    const [x, y] = teeSpot(this.course, i);
    placeBall(b, x, y);
    return b;
  }

  /** Move every ball by dt and handle what happened. */
  stepWorld(dt) {
    const ev = [];
    for (const b of this.balls.values()) stepBall(b, this.course, this.courseT, dt, ev);
    for (const e of ev) this.onBallEvent(e);
  }

  // ---------------------------------------------------------------- queries

  holesInMatch() {
    return this.phase === PHASE.LOBBY || !this.holes.length
      ? Math.min(this.rounds, this.courses.length - 1)
      : this.holes.length;
  }

  newBrain() { return createGolfBrain(this.random); }

  addPlayer(base, bot) {
    const p = super.addPlayer(base, bot);
    resetHole(p);
    p.time = 0;
    p.inMatch = false;
    return p;
  }

  setCourse(ci) {
    this.ci = ci;
    this.courseT = 0;
  }

  // Free play arena hooks used by Game: the practice green instead of rings.
  setFreeArena() {}

  spawn(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.teeBall(id, this.spawnSeq++ % 12);
    resetHole(p);
    if (p.brain) p.brain.shootAt = -1;
    this.respawnAt.delete(id);
    this.events.push(['spawn', id]);
    this.rosterDirty = true;
  }

  enterFreePlay() {
    this.setCourse(0);
    this.overtime = false;
    this.respawnAt.clear();
    this.balls.clear();
    for (const p of this.players.values()) this.spawn(p.id);
  }

  // ---------------------------------------------------------------- messages

  rosterMsg() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({ id: p.id, name: p.name, color: p.color, bot: p.bot, score: p.score, kos: p.kos, on: p.on, hs: p.hs, in: p.in });
    }
    return { t: 'roster', game: this.gameId, players, bots: this.botsWanted, rounds: this.rounds };
  }

  snapshot(tMs) {
    let pt = 0;
    if (this.phase === PHASE.COUNTDOWN) pt = Math.max(0, GOLF.INTRO_T - (this.now - this.phaseT));
    else if (this.phase === PHASE.ROUND_END) pt = Math.max(0, GOLF.HOLE_END_T - (this.now - this.phaseT));
    const tl = this.phase === PHASE.PLAYING ? Math.max(0, GOLF.HOLE_TIME - (this.now - this.playStart)) : -1;
    const p = [];
    for (const b of this.balls.values()) {
      const pl = this.players.get(b.id);
      const st = (b.moving ? BALL.MOVING : 0) | (b.holed ? BALL.HOLED : 0) | (b.falling ? BALL.FALLING : 0);
      p.push([b.id, r2(b.x), r2(b.y), r2(b.z), st, pl ? pl.hs : 0]);
    }
    const e = this.events;
    this.events = [];
    this.bounceCount = 0;
    return {
      t: 's', ts: tMs, g: GAME.GOLF, ph: this.phase, pt: r2(pt), rd: this.rd, rn: this.holesInMatch(),
      ci: this.ci, ht: r2(this.courseT), tl: r2(tl), p, e,
    };
  }

  // ---------------------------------------------------------------- players

  join(rawName, token) {
    const r = super.join(rawName, token);
    if (!r.err && !r.rejoined && !this.freePlay) this.lateJoin(this.players.get(r.id));
    return r;
  }

  /** A player who arrives mid-match: missed holes cost par + MISSED_HOLE; a ball if a hole is on. */
  lateJoin(p) {
    if (!p || p.inMatch) return;
    p.inMatch = true;
    for (let i = 0; i < this.holesDone; i++) {
      const c = this.courses[this.holes[i]];
      p.score += c.par + this.rules.MISSED_HOLE;
      p.time += this.holeTime(c);
    }
    if (this.phase === PHASE.COUNTDOWN || this.phase === PHASE.PLAYING) {
      this.balls.delete(p.id);
      this.teeBall(p.id, this.participants.length);
      resetHole(p);
      this.participants.push(p.id);
      this.events.push(['spawn', p.id]);
    }
    this.rosterDirty = true;
  }

  input() {}

  shot(id, x, y) {
    const p = this.players.get(id);
    if (!p || p.bot || !p.on) return;
    this.hit(p, x, y);
  }

  canHit(p) {
    const b = this.balls.get(p.id);
    if (!b || !this.ballCanShoot(b)) return false;
    if (this.freePlay) return true;
    return this.phase === PHASE.PLAYING && !this.overtime && p.hs < this.maxStrokes(this.course) &&
      this.participants.includes(p.id);
  }

  hit(p, x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this.canHit(p)) return;
    const pw = shoot(this.balls.get(p.id), x, y);
    if (pw < 0) return;
    p.hs++;
    this.events.push(['shot', p.id, r2(pw)]);
    this.rosterDirty = true;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.token) this.tokens.delete(p.token);
    this.balls.delete(id);
    this.respawnAt.delete(id);
    this.participants = this.participants.filter((q) => q !== id);
    this.rosterDirty = true;
  }

  // ---------------------------------------------------------------- phases

  startMatch() {
    this.holes = [];
    for (let i = 1; i <= Math.min(this.rounds, this.courses.length - 1); i++) this.holes.push(i);
    this.holesDone = 0;
    for (const p of this.players.values()) { p.time = 0; p.inMatch = true; }
    super.startMatch(); // resets score / kos, then startCountdown(1)
  }

  startCountdown(rd) {
    this.phase = PHASE.COUNTDOWN;
    this.participants = [];
    this.reconcileBots(true);
    if (this.countParticipants() === 0 || rd > this.holes.length) { this.toLobby(); return; }
    this.phaseT = this.now;
    this.rd = rd;
    this.overtime = false;
    this.setCourse(this.holes[rd - 1]);
    for (const p of this.players.values()) if (!p.inMatch) this.lateJoin(p);
    this.participants = [];
    this.balls.clear();
    this.respawnAt.clear();
    for (const p of this.players.values()) {
      this.teeBall(p.id, this.participants.length);
      resetHole(p);
      if (p.brain) p.brain.shootAt = -1;
      this.participants.push(p.id);
    }
    this.rosterDirty = true;
  }

  startPlaying() {
    this.phase = PHASE.PLAYING;
    this.phaseT = this.now;
    this.playStart = this.now;
  }

  toLobby() {
    this.holes = [];
    this.holesDone = 0;
    super.toLobby();
  }

  holeScore(p) {
    return p.in ? p.hs : Math.max(p.hs, this.maxStrokes(this.course)) + this.rules.DNF_PENALTY;
  }

  endRound() {
    const pts = {};
    const ids = this.participants.filter((id) => this.players.has(id));
    for (const id of ids) {
      const p = this.players.get(id);
      pts[id] = this.holeScore(p);
      p.score += pts[id];
      p.time += p.in ? p.holeT : this.holeTime(this.course);
      if (p.in && p.hs === 1) p.kos++;
    }
    const tt = (id) => { const p = this.players.get(id); return p.in ? p.holeT : Infinity; };
    const order = ids.slice().sort((a, b) => pts[a] - pts[b] || tt(a) - tt(b) || a - b);
    this.holesDone = this.rd;
    this.phase = PHASE.ROUND_END;
    this.phaseT = this.now;
    this.lastRound = { t: 'round', g: this.gameId, rd: this.rd, ci: this.ci, winner: order.length ? order[0] : -1, order, pts };
    this.out.push(['all', this.lastRound]);
    this.rosterDirty = true;
  }

  endMatch() {
    const time = new Map([...this.players.values()].map((p) => [p.id, p.time]));
    const standings = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, score: p.score, kos: p.kos }))
      .sort((a, b) => a.score - b.score || time.get(a.id) - time.get(b.id) || a.id - b.id);
    this.phase = PHASE.MATCH_END;
    this.phaseT = this.now;
    this.participants = [];
    this.holes = [];
    this.lastMatch = { t: 'match', g: this.gameId, standings };
    this.out.push(['all', this.lastMatch]);
    this.reconcileBots(true);
    this.enterFreePlay();
    this.rosterDirty = true;
  }

  // ---------------------------------------------------------------- the step

  update(dt) {
    this.now += dt;
    const now = this.now;

    for (const p of [...this.players.values()]) {
      if (!p.bot && !p.on && now - p.goneAt > GRACE) this.removePlayer(p.id);
    }

    if (this.phase === PHASE.COUNTDOWN) {
      if (now - this.phaseT >= this.rules.INTRO_T) this.startPlaying();
    } else if (this.phase === PHASE.ROUND_END) {
      if (now - this.phaseT >= this.rules.HOLE_END_T) {
        if (this.rd >= this.holes.length) this.endMatch();
        else this.startCountdown(this.rd + 1);
      }
    }
    if (this.phase === PHASE.PLAYING && !this.overtime && now - this.playStart >= this.holeTime(this.course)) this.overtime = true;

    const live = this.freePlay || this.phase === PHASE.PLAYING;
    if (live) {
      this.driveBots(now);
      this.stepWorld(dt);
    }
    this.courseT += dt;

    if (this.freePlay) {
      for (const [id, t] of this.respawnAt) {
        if (now >= t) {
          if (this.players.has(id)) this.spawn(id);
          else this.respawnAt.delete(id);
        }
      }
    }

    if (this.phase === PHASE.PLAYING) this.checkHoleEnd();
  }

  driveBots(now) {
    if (this.planWait > 0) { this.planWait--; return; }
    for (const p of this.players.values()) {
      if (!p.bot) continue;
      if (!this.canHit(p)) { p.brain.shootAt = -1; continue; }
      if (p.brain.shootAt < 0) { p.brain.shootAt = now + p.brain.think * (0.7 + this.random() * 0.8); continue; }
      if (now < p.brain.shootAt) continue;
      this.planWait = PLAN_GAP;
      p.brain.shootAt = -1;
      const b = this.balls.get(p.id);
      const [vx, vy] = planShot(this.course, b.x, b.y, this.courseT, p.brain, this.random);
      this.hit(p, vx, vy);
      return;
    }
  }

  onBallEvent(e) {
    const kind = e[0];
    if (kind === 'bounce') {
      if (this.bounceCount++ < MAX_BOUNCES_PER_SNAP) this.events.push(['bounce', r2(e[1]), r2(e[2]), r2(e[3]), e[4]]);
      return;
    }
    const p = this.players.get(e[1]);
    if (!p) return;
    if (kind === 'holed') {
      p.in = true;
      p.holeT = this.now - this.playStart;
      this.events.push(['holed', p.id, p.hs, this.v()]);
      if (this.freePlay) this.respawnAt.set(p.id, this.now + this.rules.RESPAWN_T);
      this.rosterDirty = true;
    } else if (kind === 'reset') {
      this.events.push(e);
      if (this.phase === PHASE.PLAYING) { p.hs++; this.rosterDirty = true; }
    } else {
      this.events.push(e); // boost, oob
    }
  }

  checkHoleEnd() {
    const el = this.now - this.playStart;
    const max = this.maxStrokes(this.course);
    let busy = false;
    for (const id of this.participants) {
      const p = this.players.get(id), b = this.balls.get(id);
      if (!p || !b || this.ballHoled(b)) continue;
      const atRest = this.ballAtRest(b);
      if (this.overtime) { if (!atRest) busy = true; continue; }
      if (!p.bot && !p.on) continue;              // a dropped player does not hold up the hole
      if (!(p.hs >= max && atRest)) busy = true;
    }
    if (!busy || el >= this.holeTime(this.course) + SETTLE_T) this.endRound();
  }
}

export function resetHole(p) {
  p.hs = 0;
  p.in = false;
  p.holeT = 0;
}
