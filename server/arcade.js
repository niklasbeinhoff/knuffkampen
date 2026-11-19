// The room's game cabinet: owns which game is running and switches on the host's
// 'game' command, carrying every player (id, token, name, colour, bot flag,
// connection state) and the bot / round settings over. Scores start at zero.

import { Game } from './game.js';
import { GolfGame } from './golf.js';
import { KlossGame } from './kloss.js';
import { PaketGame } from './paket.js';
import { GAME } from '../shared/protocol.js';

export class Arcade {
  constructor(opts = {}) {
    this.opts = opts;
    this.kind = GAME.KNUFF;
    this.game = new Game(opts);
    this.carry = [];   // messages from a game that was just replaced
    // A room may open in another game (KK_GAME); same path as the host's switch.
    if (opts.startGame != null && opts.startGame !== GAME.KNUFF) {
      this.command('game', opts.startGame);
      this.carry = [];
    }
  }

  join(name, token) { return this.game.join(name, token); }
  leave(id) { this.game.leave(id); }
  input(id, x, y, d) { this.game.input(id, x, y, d); }
  shot(id, x, y) { if (this.game.shot) this.game.shot(id, x, y); }
  swing(id, a, p, c) { if (this.game.swing) this.game.swing(id, a, p, c); }
  welcome() { return this.game.welcome(); }
  update(dt) { this.game.update(dt); }
  snapshot(tMs) { return this.game.snapshot(tMs); }

  drain() {
    const out = this.carry.length ? this.carry.concat(this.game.drain()) : this.game.drain();
    this.carry = [];
    return out;
  }

  /** Host command. Returns the id of a kicked human, or -1. */
  command(c, v) {
    if (c !== 'game') return this.game.command(c, v);
    if ((v !== GAME.KNUFF && v !== GAME.GOLF && v !== GAME.KLOSS && v !== GAME.PAKET) || v === this.kind || !this.game.freePlay) return -1;
    const state = this.game.exportState();
    this.carry.push(...this.game.drain());
    const next = v === GAME.GOLF ? new GolfGame(this.opts)
      : v === GAME.KLOSS ? new KlossGame(this.opts)
      : v === GAME.PAKET ? new PaketGame(this.opts)
      : new Game(this.opts);
    next.adopt(state);
    this.game = next;
    this.kind = v;
    return -1;
  }
}
