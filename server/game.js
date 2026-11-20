// Knuffkampen – authoritative game logic. No sockets, no timers, no disk:
// the caller drives it with update(dt) and delivers what drain() returns.

import { SIM, step, createBody, placeBody, arenaRadius, ringsForPlayers } from '../shared/sim.js';
import { PHASE, ST, PALETTE, LIMITS, GAME } from '../shared/protocol.js';
import { BOT_NAMES, createBrain, driveBot } from './bots.js';

const GRACE_ROUND = 8;   // seconds a dropped player is kept during a round
const GRACE_IDLE = 30;   // ... otherwise
const MAX_HITS_PER_SNAP = 48;
const SPAWN_FRAC = 0.6;
const START_FRAC = 0.62;

const r2 = (v) => Math.round(v * 100) / 100;

/** Clean a user-supplied nickname. Returns '' when nothing usable is left. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.slice(0, 256).normalize('NFC');
  // Whitespace (incl. invisible "blank" letters) -> single spaces.
  s = s.replace(/[\sᅟᅠㅤﾠ⠀]+/gu, ' ');
  // Control, format (zero-width, bidi overrides), separators, surrogates, private use, unassigned.
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]/gu, '');
  // Tame stacked combining marks ("zalgo").
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');
  s = s.replace(/ +/g, ' ').trim();
  s = Array.from(s).slice(0, LIMITS.NAME_MAX).join('').trim();
  return s;
}

function cut(s, n) {
  return Array.from(s).slice(0, n).join('').trim();
}

export class Game {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.random]   uniform [0,1)
   * @param {() => string} [opts.makeToken] reconnect token generator
   * @param {number} [opts.rounds]
   * @param {number} [opts.bots]
   */
  constructor(opts = {}) {
    this.random = opts.random || Math.random;
    this.makeToken = opts.makeToken || (() => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    this.rounds = clampInt(opts.rounds ?? 3, LIMITS.MIN_ROUNDS, LIMITS.MAX_ROUNDS);
    this.botsWanted = clampInt(opts.bots ?? 0, 0, LIMITS.MAX_BOTS);

    this.now = 0;
    this.phase = PHASE.LOBBY;
    this.phaseT = 0;
    this.rd = 0;
    this.r0 = SIM.LOBBY_RINGS;
    this.rg = SIM.LOBBY_RINGS;
    this.playStart = 0;
    this.nextFallAt = Infinity; // seconds into PLAYING

    this.nextId = 1;
    this.players = new Map();   // id -> player
    this.tokens = new Map();    // token -> id
    this.bodies = new Map();    // id -> sim body
    this.respawnAt = new Map(); // id -> time (free play)

    this.participants = [];
    this.eliminated = new Set();
    this.elimGroups = [];
    this.roundKos = new Map();
    this.coreDist = null;       // id -> distance when the core fell

    this.events = [];
    this.hitCount = 0;
    this.out = [];
    this.rosterDirty = false;
    this.lastRound = null;
    this.lastMatch = null;
    this.botSeq = 0;

    this.setFreeArena();
  }

  // ---------------------------------------------------------------- queries

  get freePlay() {
    return this.phase === PHASE.LOBBY || this.phase === PHASE.MATCH_END;
  }

  humans() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  bots() {
    const out = [];
    for (const p of this.players.values()) if (p.bot) out.push(p);
    return out;
  }

  rosterMsg() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({ id: p.id, name: p.name, color: p.color, bot: p.bot, score: p.score, kos: p.kos, on: p.on });
    }
    return { t: 'roster', game: GAME.KNUFF, players, bots: this.botsWanted, rounds: this.rounds };
  }

  /** Messages for a socket that just joined, reconnected or authenticated as host. */
  welcome() {
    const msgs = [this.rosterMsg()];
    if (this.phase === PHASE.ROUND_END && this.lastRound) msgs.push(this.lastRound);
    if (this.phase === PHASE.MATCH_END && this.lastMatch) msgs.push(this.lastMatch);
    return msgs;
  }

  /** Outgoing messages since the last call: [[to, msg]], to = 'all' or a player id. */
  drain() {
    if (this.rosterDirty) {
      this.rosterDirty = false;
      this.out.push(['all', this.rosterMsg()]);
    }
    const o = this.out;
    this.out = [];
    return o;
  }

  snapshot(tMs) {
    let pt = 0;
    if (this.phase === PHASE.COUNTDOWN) pt = Math.max(0, SIM.COUNTDOWN_T - (this.now - this.phaseT));
    else if (this.phase === PHASE.ROUND_END) pt = Math.max(0, SIM.ROUND_END_T - (this.now - this.phaseT));
    else if (this.phase === PHASE.PLAYING) pt = this.now - this.playStart;
    let wf = -1;
    if (this.phase === PHASE.PLAYING && Number.isFinite(this.nextFallAt)) {
      wf = Math.max(0, this.nextFallAt - (this.now - this.playStart));
    }
    const p = [];
    for (const b of this.bodies.values()) {
      if (b.out) continue;
      const st = (b.falling ? ST.FALLING : 0) | (b.charge > 0 ? ST.CHARGED : 0) | (b.frozen ? ST.FROZEN : 0);
      p.push([b.id, r2(b.x), r2(b.y), r2(b.z), r2(b.face), st, r2(Math.min(1, b.cd / SIM.DASH_CD))]);
    }
    const e = this.events;
    this.events = [];
    this.hitCount = 0;
    return {
      // protocol.js names both the type and the clock `t`; the clock goes in `ts`.
      t: 's', ts: tMs, g: GAME.KNUFF, ph: this.phase, pt: r2(pt), rd: this.rd, rn: this.rounds,
      r0: this.r0, rg: this.rg, wf: r2(wf), p, e,
    };
  }

  // ---------------------------------------------------------------- players

  /** Returns { id, token, rejoined } or { err }. */
  join(rawName, token) {
    if (typeof token === 'string' && token.length <= 64 && this.tokens.has(token)) {
      const p = this.players.get(this.tokens.get(token));
      if (p) {
        p.on = true;
        p.goneAt = null;
        this.rosterDirty = true;
        return { id: p.id, token: p.token, rejoined: true };
      }
    }
    const base = cleanName(rawName);
    if (!base) return { err: 'name' };
    if (this.humans() >= LIMITS.MAX_PLAYERS) return { err: 'full' };

    const p = this.addPlayer(base, false);
    p.token = this.makeToken();
    this.tokens.set(p.token, p.id);
    this.reconcileBots(this.freePlay);
    if (this.freePlay) {
      this.setFreeArena();
      this.spawn(p.id);
    }
    return { id: p.id, token: p.token, rejoined: false };
  }

  /** The player's socket dropped. */
  leave(id) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    p.on = false;
    p.goneAt = this.now;
    const b = this.bodies.get(id);
    if (b) { b.ix = 0; b.iy = 0; b.dash = false; }
    this.rosterDirty = true;
  }

  input(id, x, y, d) {
    const p = this.players.get(id);
    if (!p || p.bot || !p.on) return;
    const b = this.bodies.get(id);
    if (!b) return;
    b.ix = clamp(x, -1, 1);
    b.iy = clamp(y, -1, 1);
    if (d) b.dash = true;
  }

  /** Host command. Returns the id of a kicked human, or -1. */
  command(c, v) {
    switch (c) {
      case 'start':
        if (this.freePlay) this.startMatch();
        return -1;
      case 'lobby':
        this.toLobby();
        return -1;
      case 'bots':
        if (typeof v !== 'number' || !Number.isFinite(v)) return -1;
        this.botsWanted = clampInt(v, 0, LIMITS.MAX_BOTS);
        this.reconcileBots(this.freePlay);
        if (this.freePlay) this.setFreeArena();
        this.rosterDirty = true;
        return -1;
      case 'rounds':
        if (typeof v !== 'number' || !Number.isFinite(v)) return -1;
        this.rounds = clampInt(v, LIMITS.MIN_ROUNDS, LIMITS.MAX_ROUNDS);
        this.rosterDirty = true;
        return -1;
      case 'kick': {
        if (typeof v !== 'number' || !Number.isInteger(v)) return -1;
        const p = this.players.get(v);
        if (!p) return -1;
        if (p.bot) {
          // Kicking a bot lowers the bot count by one.
          this.botsWanted = Math.max(0, this.botsWanted - 1);
          this.removePlayer(v);
          return -1;
        }
        this.out.push([v, { t: 'kicked' }]);
        this.removePlayer(v);
        return v;
      }
      default:
        return -1;
    }
  }

  addPlayer(base, bot) {
    const id = this.nextId++;
    const p = {
      id, bot, name: this.uniqueName(base), color: this.freeColor(),
      score: 0, kos: 0, on: true, token: null, goneAt: null,
      brain: bot ? this.newBrain() : null,
    };
    this.players.set(id, p);
    this.rosterDirty = true;
    return p;
  }

  newBrain() {
    return createBrain(this.random);
  }

  /** Everything another game needs to take over the room (see server/arcade.js). */
  exportState() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id, token: p.token, name: p.name, color: p.color, bot: p.bot, on: p.on,
      goneFor: p.on || p.goneAt === null ? 0 : this.now - p.goneAt,
    }));
    return { players, nextId: this.nextId, botSeq: this.botSeq, rounds: this.rounds, botsWanted: this.botsWanted };
  }

  /** Take over the players and settings of another game; scores start at zero, play in the lobby. */
  adopt(s) {
    this.players.clear();
    this.tokens.clear();
    this.bodies.clear();
    this.respawnAt.clear();
    this.nextId = s.nextId;
    this.botSeq = s.botSeq;
    this.rounds = s.rounds;
    this.botsWanted = s.botsWanted;
    for (const q of s.players) {
      const p = {
        id: q.id, bot: q.bot, name: q.name, color: q.color, score: 0, kos: 0, on: q.on,
        token: q.token, goneAt: q.on ? null : this.now - q.goneFor, brain: q.bot ? this.newBrain() : null,
      };
      this.players.set(p.id, p);
      if (p.token) this.tokens.set(p.token, p.id);
    }
    this.toLobby();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.token) this.tokens.delete(p.token);
    const b = this.bodies.get(id);
    this.bodies.delete(id);
    this.respawnAt.delete(id);
    if ((this.phase === PHASE.COUNTDOWN || this.phase === PHASE.PLAYING) &&
        this.participants.includes(id) && !this.eliminated.has(id)) {
      // Leaving mid-round counts as being eliminated now.
      this.eliminated.add(id);
      this.elimGroups.push([id]);
      if (b && !b.falling && !b.out) this.events.push(['fall', id, -1, this.v()]);
    }
    if (this.freePlay) this.setFreeArena();
    this.rosterDirty = true;
  }

  uniqueName(base) {
    const taken = new Set();
    for (const p of this.players.values()) taken.add(p.name.toLowerCase());
    if (!taken.has(base.toLowerCase())) return base;
    for (let k = 2; ; k++) {
      const suffix = ' ' + k;
      const name = cut(base, LIMITS.NAME_MAX - suffix.length) + suffix;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  freeColor() {
    const uses = new Array(PALETTE.length).fill(0);
    for (const p of this.players.values()) uses[p.color]++;
    let best = 0;
    for (let i = 1; i < uses.length; i++) if (uses[i] < uses[best]) best = i;
    return best;
  }

  /** Keep humans + bots <= MAX_PLAYERS; when `apply`, also match the wanted bot count. */
  reconcileBots(apply) {
    const bots = this.bots();
    const cap = Math.max(0, LIMITS.MAX_PLAYERS - this.humans());
    const want = Math.min(apply ? this.botsWanted : bots.length, cap);
    for (let i = bots.length - 1; i >= want; i--) this.removePlayer(bots[i].id);
    for (let i = bots.length; i < want; i++) {
      const name = BOT_NAMES[this.botSeq++ % BOT_NAMES.length];
      const p = this.addPlayer(name, true);
      if (this.freePlay) this.spawn(p.id);
    }
  }

  v() {
    return Math.floor(this.random() * 100);
  }

  // ---------------------------------------------------------------- arena / bodies

  setFreeArena() {
    const r0 = Math.max(SIM.LOBBY_RINGS, ringsForPlayers(this.players.size));
    this.r0 = r0;
    this.rg = r0;
  }

  spawn(id) {
    let b = this.bodies.get(id);
    if (!b) { b = createBody(id); this.bodies.set(id, b); }
    const R = arenaRadius(this.rg) * SPAWN_FRAC;
    let x = 0, y = 0;
    for (let tries = 0; tries < 16; tries++) {
      const rr = R * Math.sqrt(this.random());
      const a = this.random() * Math.PI * 2;
      x = rr * Math.cos(a); y = rr * Math.sin(a);
      let clear = true;
      for (const o of this.bodies.values()) {
        if (o === b || o.falling || o.out) continue;
        if (Math.hypot(o.x - x, o.y - y) < SIM.PLAYER_R * 2.4) { clear = false; break; }
      }
      if (clear) break;
    }
    placeBody(b, x, y, Math.atan2(-y, -x));
    b.frozen = false;
    this.respawnAt.delete(id);
    this.events.push(['spawn', id]);
  }

  /** Free play for everyone on an intact lobby-sized arena. */
  enterFreePlay() {
    this.setFreeArena();
    this.respawnAt.clear();
    for (const id of this.bodies.keys()) if (!this.players.has(id)) this.bodies.delete(id);
    for (const p of this.players.values()) {
      const b = this.bodies.get(p.id);
      if (!b || b.falling || b.out) this.spawn(p.id);
      else b.frozen = false;
    }
  }

  placeStart(ids) {
    const R = arenaRadius(this.r0);
    const minGap = SIM.PLAYER_R * 2.4;
    const order = ids.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Fill circles from the outside in; each holds as many as fit without overlap.
    let idx = 0;
    let rad = R * START_FRAC;
    while (idx < order.length) {
      const left = order.length - idx;
      const cap = rad < minGap ? 1 : Math.max(1, Math.floor((2 * Math.PI * rad) / minGap));
      const k = Math.min(left, cap);
      const off = this.random() * Math.PI * 2;
      for (let i = 0; i < k; i++) {
        const a = off + (i / k) * Math.PI * 2;
        const x = k === 1 && rad < minGap ? 0 : rad * Math.cos(a);
        const y = k === 1 && rad < minGap ? 0 : rad * Math.sin(a);
        const id = order[idx++];
        const b = createBody(id);
        placeBody(b, x, y, Math.atan2(-y, -x));
        b.frozen = true;
        this.bodies.set(id, b);
      }
      rad -= minGap;
      if (rad < 0) rad = 0;
    }
  }

  // ---------------------------------------------------------------- phases

  startMatch() {
    this.reconcileBots(true);
    const n = this.countParticipants();
    if (n === 0) return;
    for (const p of this.players.values()) { p.score = 0; p.kos = 0; }
    this.lastRound = null;
    this.lastMatch = null;
    this.rosterDirty = true;
    this.startCountdown(1);
  }

  countParticipants() {
    let n = 0;
    for (const p of this.players.values()) if (p.bot || p.on) n++;
    return n;
  }

  startCountdown(rd) {
    this.phase = PHASE.COUNTDOWN; // set first so new bots are not spawned for free play
    this.participants = [];
    this.reconcileBots(true);
    const ids = [];
    for (const p of this.players.values()) if (p.bot || p.on) ids.push(p.id);
    if (ids.length === 0) { this.toLobby(); return; }
    this.phaseT = this.now;
    this.rd = rd;
    this.participants = ids;
    this.eliminated = new Set();
    this.elimGroups = [];
    this.roundKos = new Map();
    this.coreDist = null;
    this.r0 = this.roundRings(ids.length);
    this.rg = this.r0;
    this.nextFallAt = Infinity;
    this.bodies.clear();
    this.respawnAt.clear();
    this.placeStart(ids);
    for (const p of this.players.values()) if (p.brain) {
      p.brain.target = -1; p.brain.nextThink = 0; p.brain.dazeUntil = 0;
    }
    this.rosterDirty = true;
  }

  /** Rings the arena has at the start of a round with n cars. */
  roundRings(n) {
    return ringsForPlayers(n);
  }

  startPlaying() {
    this.phase = PHASE.PLAYING;
    this.phaseT = this.now;
    this.playStart = this.now;
    this.nextFallAt = SIM.FIRST_FALL;
    for (const b of this.bodies.values()) b.frozen = false;
  }

  toLobby() {
    this.phase = PHASE.LOBBY;
    this.phaseT = this.now;
    this.rd = 0;
    this.nextFallAt = Infinity;
    this.participants = [];
    this.lastRound = null;
    this.lastMatch = null;
    this.reconcileBots(true);
    this.enterFreePlay();
    this.rosterDirty = true;
  }

  endRound() {
    const standing = [];
    for (const id of this.participants) {
      const b = this.bodies.get(id);
      if (!this.eliminated.has(id) && b && !b.falling && !b.out) standing.push(id);
    }
    const order = standing.slice();
    for (let i = this.elimGroups.length - 1; i >= 0; i--) order.push(...this.elimGroups[i]);
    for (const id of this.participants) if (!order.includes(id)) order.push(id); // defensive

    const n = this.participants.length;
    const pts = {};
    const present = [];
    order.forEach((id, i) => {
      const p = this.players.get(id);
      if (!p) return;
      const got = (n - 1 - i) + (i === 0 ? 2 : 0) + (this.roundKos.get(id) || 0);
      p.score += got;
      pts[id] = got;
      present.push(id);
    });
    const winner = order.length && this.players.has(order[0]) ? order[0] : -1;

    this.phase = PHASE.ROUND_END;
    this.phaseT = this.now;
    this.nextFallAt = Infinity;
    this.lastRound = { t: 'round', rd: this.rd, winner, order: present, pts };
    this.out.push(['all', this.lastRound]);
    this.rosterDirty = true;
  }

  endMatch() {
    const standings = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, score: p.score, kos: p.kos }))
      .sort((a, b) => b.score - a.score || b.kos - a.kos || a.id - b.id);
    this.phase = PHASE.MATCH_END;
    this.phaseT = this.now;
    this.participants = [];
    this.lastMatch = { t: 'match', standings };
    this.out.push(['all', this.lastMatch]);
    this.reconcileBots(true);
    this.enterFreePlay();
    this.rosterDirty = true;
  }

  // ---------------------------------------------------------------- the step

  update(dt) {
    this.now += dt;
    const now = this.now;

    // Grace periods for dropped players.
    const grace = (this.phase === PHASE.COUNTDOWN || this.phase === PHASE.PLAYING) ? GRACE_ROUND : GRACE_IDLE;
    for (const p of [...this.players.values()]) {
      if (!p.bot && !p.on && now - p.goneAt > grace) this.removePlayer(p.id);
    }

    // Phase clock.
    let coreFell = false;
    if (this.phase === PHASE.COUNTDOWN) {
      if (now - this.phaseT >= SIM.COUNTDOWN_T) this.startPlaying();
    } else if (this.phase === PHASE.ROUND_END) {
      if (now - this.phaseT >= SIM.ROUND_END_T) {
        if (this.rd >= this.rounds) this.endMatch();
        else this.startCountdown(this.rd + 1);
      }
    }
    if (this.phase === PHASE.PLAYING) {
      const el = now - this.playStart;
      if (el >= this.nextFallAt) {
        if (this.rg > 0) {
          this.rg--;
          this.nextFallAt += this.rg > 0 ? SIM.FALL_EVERY : SIM.SUDDEN_T;
        } else {
          this.rg = -1;
          this.nextFallAt = Infinity;
          coreFell = true;
          this.coreDist = new Map();
          for (const b of this.bodies.values()) this.coreDist.set(b.id, Math.hypot(b.x, b.y));
        }
        this.events.push(['ring', this.rg]);
      }
    }

    // Bots.
    const list = [...this.bodies.values()];
    this.driveBots(list);

    // Physics.
    const ev = [];
    step(list, arenaRadius(this.rg), dt, now, ev);

    if (coreFell) {
      // Nothing stands on a missing core, not even a body parked exactly at the centre.
      for (const b of list) {
        if (!b.falling && !b.out) { b.falling = true; b.vz = 0; b.charge = 0; ev.push(['fall', b.id]); }
      }
    }
    this.afterStep(ev, dt);
    const group = [];
    for (const e of ev) {
      if (e[0] === 'hit') {
        if (this.hitCount++ < MAX_HITS_PER_SNAP) this.events.push(['hit', r2(e[1]), r2(e[2]), r2(e[3]), e[4], e[5]]);
      } else if (e[0] === 'dash') {
        this.events.push(e);
      } else if (e[0] === 'fall') {
        this.onFall(e[1], coreFell, group);
      }
    }

    if (group.length) {
      if (coreFell && this.coreDist) {
        group.sort((a, b) => this.coreDist.get(a) - this.coreDist.get(b));
      } else {
        const tie = new Map(group.map((id) => [id, this.random()]));
        group.sort((a, b) => (this.roundKos.get(b) || 0) - (this.roundKos.get(a) || 0) || tie.get(a) - tie.get(b));
      }
      this.elimGroups.push(group);
    }

    // Drop bodies that have fallen out of sight; respawn in free play.
    for (const b of list) {
      if (b.out) {
        this.bodies.delete(b.id);
        if (this.freePlay && this.players.has(b.id) && !this.respawnAt.has(b.id)) {
          this.respawnAt.set(b.id, now + SIM.RESPAWN_T);
        }
      }
    }
    if (this.freePlay) {
      for (const [id, t] of this.respawnAt) {
        if (now >= t) {
          if (this.players.has(id)) this.spawn(id);
          else this.respawnAt.delete(id);
        }
      }
    }

    if (this.phase === PHASE.PLAYING) this.checkRoundEnd();
  }

  /** Steer every bot body for this step (Heta paketet overrides it). */
  driveBots(list) {
    const botPlayers = this.bots();
    if (!botPlayers.length) return;
    const now = this.now;
    const targeted = new Map();
    for (const p of botPlayers) if (p.brain.target >= 0) targeted.set(p.brain.target, (targeted.get(p.brain.target) || 0) + 1);
    let warnIn = -1;
    if (this.phase === PHASE.PLAYING && Number.isFinite(this.nextFallAt)) warnIn = this.nextFallAt - (now - this.playStart);
    const ctx = { now, random: this.random, rings: this.rg, warnIn, freePlay: this.freePlay, bodies: list, targeted };
    for (const p of botPlayers) {
      const b = this.bodies.get(p.id);
      if (b) driveBot(p.brain, b, ctx);
    }
  }

  /** Hook after the physics step, before falls are handled. `ev` = step()'s raw events. */
  afterStep(ev, dt) {}

  onFall(id, coreFell, group) {
    const b = this.bodies.get(id);
    if (!b) return;
    let by = -1;
    if (!coreFell && b.lastHitBy >= 0 && b.lastHitBy !== id &&
        this.now - b.lastHitAt <= SIM.KO_CREDIT_T && this.players.has(b.lastHitBy)) {
      by = b.lastHitBy;
    }
    this.events.push(['fall', id, by, this.v()]);

    if (this.freePlay) {
      this.respawnAt.set(id, this.now + SIM.RESPAWN_T);
      return;
    }
    if (this.phase !== PHASE.PLAYING) return;
    if (!this.participants.includes(id) || this.eliminated.has(id)) return;
    this.eliminated.add(id);
    group.push(id);
    if (by >= 0) {
      const k = this.players.get(by);
      k.kos++;
      this.roundKos.set(by, (this.roundKos.get(by) || 0) + 1);
      this.rosterDirty = true;
    }
  }

  checkRoundEnd() {
    let standing = 0;
    for (const id of this.participants) {
      if (this.eliminated.has(id)) continue;
      const b = this.bodies.get(id);
      if (b && !b.falling && !b.out) standing++;
    }
    const enough = this.participants.length > 1 ? 1 : 0;
    if (standing <= enough) this.endRound();
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v, lo, hi) {
  return clamp(Math.round(v), lo, hi);
}
