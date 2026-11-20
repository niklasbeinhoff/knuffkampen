// Heta paketet – hot potato with the Knuffkampen bumper cars. Same round flow,
// placing points and free play as Game (server/game.js); no rings fall. One car
// carries a parcel with a hidden fuse and passes it on by bumping into another car.
// When the fuse runs out the carrier is out of the round, as if it had fallen off.

import { Game } from './game.js';
import { PHASE, GAME } from '../shared/protocol.js';
import { SIM, ringsForPlayers } from '../shared/sim.js';
import { PAKET, fuseScale } from '../shared/paket.js';
import { drivePaketBot } from './paketbot.js';

const r2 = (v) => Math.round(v * 100) / 100;

export class PaketGame extends Game {
  constructor(opts = {}) {
    super(opts);
    this.clearParcel();
  }

  clearParcel() {
    this.carrier = -1;
    this.fuse = 0;          // seconds this parcel burns
    this.burnt = 0;         // seconds burnt so far
    this.lastPassAt = -1e9;
    this.prevCarrier = -1;
    this.nextParcelAt = Infinity;
  }

  // ---------------------------------------------------------------- messages

  rosterMsg() {
    const m = super.rosterMsg();
    m.game = GAME.PAKET;
    return m;
  }

  snapshot(tMs) {
    const s = super.snapshot(tMs);
    s.g = GAME.PAKET;
    s.ca = this.carrier;
    s.fu = this.carrier >= 0 && this.fuse > 0 ? r2(Math.min(1, this.burnt / this.fuse)) : 0;
    return s;
  }

  // ---------------------------------------------------------------- phases

  startCountdown(rd) {
    this.clearParcel();
    super.startCountdown(rd);
    if (this.phase === PHASE.COUNTDOWN) this.handOut();
  }

  /** No rings fall, so the round gets one ring more room than Knuffkampen's. */
  roundRings(n) {
    return Math.min(SIM.MAX_RINGS, ringsForPlayers(n) + 1);
  }

  startPlaying() {
    super.startPlaying();
    this.nextFallAt = Infinity;   // no rings fall in this game
  }

  toLobby() {
    this.clearParcel();
    super.toLobby();
  }

  endRound() {
    this.clearParcel();
    super.endRound();
    this.lastRound.g = GAME.PAKET;
  }

  endMatch() {
    this.clearParcel();
    super.endMatch();
    this.lastMatch.g = GAME.PAKET;
  }

  removePlayer(id) {
    super.removePlayer(id);
    if (id === this.carrier) this.dropParcel();
  }

  leave(id) {
    super.leave(id);
    // Nobody can pass a parcel without a driver: hand out a new one.
    if (id === this.carrier) this.dropParcel();
  }

  // ---------------------------------------------------------------- the parcel

  inRound() {
    return this.phase === PHASE.COUNTDOWN || this.phase === PHASE.PLAYING;
  }

  /** Cars that can be handed a parcel: in the round, on the ice, with someone driving. */
  standing() {
    const ids = [];
    for (const id of this.participants) {
      if (this.eliminated.has(id)) continue;
      const b = this.bodies.get(id);
      if (b && !b.falling && !b.out) ids.push(id);
    }
    return ids;
  }

  /** The carrier is gone: a new parcel after NEXT_T (at once during the countdown). */
  dropParcel() {
    this.carrier = -1;
    this.burnt = 0;
    this.fuse = 0;
    if (this.phase === PHASE.COUNTDOWN) this.handOut();
    else if (this.phase === PHASE.PLAYING) this.nextParcelAt = this.now + PAKET.NEXT_T;
  }

  /** Give a fresh parcel to a random car still in. Returns false if nobody can take it. */
  handOut() {
    const all = this.standing();
    if (all.length === 0) return false;
    const online = all.filter((id) => { const p = this.players.get(id); return p && (p.bot || p.on); });
    const pool = online.length ? online : all;
    const id = pool[Math.floor(this.random() * pool.length)];
    this.carrier = id;
    this.burnt = 0;
    this.fuse = (PAKET.FUSE_MIN + this.random() * (PAKET.FUSE_MAX - PAKET.FUSE_MIN)) * fuseScale(all.length);
    this.lastPassAt = -1e9;
    this.prevCarrier = -1;
    this.nextParcelAt = Infinity;
    this.events.push(['parcel', id]);
    return true;
  }

  // ---------------------------------------------------------------- the step

  update(dt) {
    const playing = this.phase === PHASE.PLAYING;
    for (const b of this.bodies.values()) b.acc = playing && b.id === this.carrier ? PAKET.CARRIER_ACC : 1;
    super.update(dt);
  }

  afterStep(ev, dt) {
    if (this.phase !== PHASE.PLAYING) return;
    const now = this.now;

    if (this.carrier < 0) {
      if (now >= this.nextParcelAt) this.handOut();
      return;
    }
    const cb = this.bodies.get(this.carrier);
    if (!cb || cb.out) { this.dropParcel(); return; }

    // 1. The fuse. A pop wins over a pass in the same tick; a falling carrier just drops it.
    this.burnt += dt;
    if (!cb.falling && this.burnt >= this.fuse) {
      this.pop(this.carrier);
      return;
    }

    // 2. Passing on a collision.
    if (!cb.falling && now - this.lastPassAt >= PAKET.PASS_CD) {
      for (const e of ev) {
        if (e[0] !== 'hit') continue;
        const other = e[4] === this.carrier ? e[5] : e[5] === this.carrier ? e[4] : -1;
        if (other < 0) continue;
        if (other === this.prevCarrier && now - this.lastPassAt < PAKET.PASS_BACK) continue;
        if (!this.participants.includes(other) || this.eliminated.has(other)) continue;
        const ob = this.bodies.get(other);
        if (!ob || ob.out) continue;
        this.events.push(['pass', this.carrier, other]);
        this.prevCarrier = this.carrier;
        this.carrier = other;
        this.lastPassAt = now;
        break;
      }
    }

    // 3. A carrier that falls off takes the parcel with it.
    const nb = this.bodies.get(this.carrier);
    if (!nb || nb.falling || nb.out) this.dropParcel();
  }

  /** The fuse ran out: the carrier is out of the round, the same way a fall puts it out. */
  pop(id) {
    const b = this.bodies.get(id);
    this.events.push(['pop', id, this.v()]);
    if (b) { b.out = true; b.ix = 0; b.iy = 0; b.dash = false; }   // Game.update drops the body
    if (!this.eliminated.has(id) && this.participants.includes(id)) {
      this.eliminated.add(id);
      this.elimGroups.push([id]);
    }
    this.dropParcel();
  }

  // ---------------------------------------------------------------- bots

  driveBots(list) {
    if (!this.inRound()) return super.driveBots(list);
    const now = this.now;
    const blocked = this.prevCarrier >= 0 && now - this.lastPassAt < PAKET.PASS_BACK ? this.prevCarrier : -1;
    const ctx = { now, random: this.random, rings: this.rg, bodies: list, carrier: this.carrier, blocked };
    for (const p of this.bots()) {
      const b = this.bodies.get(p.id);
      if (b) drivePaketBot(p.brain, b, ctx);
    }
  }
}
