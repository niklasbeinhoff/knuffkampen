// Knuffkampen – wire protocol. JSON text frames over one WebSocket at /ws.
// This file is the single source of truth for message shapes.

export const PHASE = Object.freeze({
  LOBBY: 0,      // free play with respawn while people join
  COUNTDOWN: 1,  // bodies placed and frozen, 3-2-1
  PLAYING: 2,    // the round; rings fall, last one standing wins
  ROUND_END: 3,  // a few seconds of results; survivors may keep driving
  MATCH_END: 4,  // final standings; free play with respawn until the host moves on
});

// Which game the server is running. The host picks it in the lobby.
export const GAME = Object.freeze({ KNUFF: 0, GOLF: 1, KLOSS: 2, PAKET: 3 });

// Bit flags in the `st` field of a snapshot body.
export const ST = Object.freeze({
  FALLING: 1,
  CHARGED: 2,
  FROZEN: 4,
});

// Player colours. `color` in the roster is an index into this list.
export const PALETTE = Object.freeze([
  '#ff5a5f', '#ffb400', '#00c2a8', '#3d8bff', '#b46bff', '#ff7ac8', '#7ed321', '#ff8a3d',
  '#00d5ff', '#f5e642', '#8c9eff', '#ff4fa0', '#2fd67b', '#c98bff', '#ffa3a3', '#9be7ff',
]);

export const LIMITS = Object.freeze({
  NAME_MAX: 16,
  MAX_PLAYERS: 40,   // humans + bots
  MAX_BOTS: 12,
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 7,
});

/*
CLIENT -> SERVER

  { t:'join', name, code, token? }
      Join as a player. `code` is the room code (case-insensitive). `token` is the
      reconnect token from an earlier 'joined'; a valid token rebinds the same
      player (score kept) instead of creating a new one.
  { t:'host', key }
      Authenticate this socket as the host / big screen. A host is not a player.
      Sent by a socket that has already joined as a player, it instead gives that
      player the host controls as well ("playing host"): the player keeps playing
      and may send every 'cmd' below except kicking itself. The controls belong to
      the socket, so after a reconnect the client sends the key again.
  { t:'in', x, y, d }
      Player input. x, y in [-1, 1] (sim plane; y = -1 is "up" on screen).
      d = 1 on the frame the dash button was pressed, else 0.
      Sent at up to 30 Hz when it changes, plus a keepalive a few times a second.
  { t:'cmd', c, v? }                       host only
      c = 'start'   start a match (from LOBBY or MATCH_END)
      c = 'lobby'   back to the lobby (from any phase)
      c = 'bots'    v = number of bots wanted (0..MAX_BOTS)
      c = 'rounds'  v = rounds per match (MIN_ROUNDS..MAX_ROUNDS)
      c = 'kick'    v = player id
  { t:'ping', c }
      Answered with { t:'pong', c }.

SERVER -> CLIENT

  { t:'joined', id, token }
  { t:'hosted', code, id? }                id: the player's own id when a joined player became playing host
  { t:'err', m }                           m = 'code' | 'full' | 'name' | 'key' | 'rate'
  { t:'kicked' }
  { t:'pong', c }

  { t:'roster', players:[{ id, name, color, bot, score, kos, on }], bots, rounds }
      Sent to everyone whenever it changes (join, leave, score, settings).
      bot: boolean. on: boolean (socket connected). score/kos are match totals.

  { t:'s', ts, ph, pt, rd, rn, r0, rg, wf, p, e }          the snapshot, SNAP_HZ times a second
      ts  server clock in ms (monotonic)
      ph  PHASE
      pt  seconds: time LEFT in COUNTDOWN / ROUND_END, time ELAPSED in PLAYING, else 0
      rd  current round (1-based; 0 in the lobby)
      rn  rounds per match
      r0  rings the arena has when intact in this phase
      rg  rings alive right now (r0 .. 0, then -1 once the core has fallen)
      wf  seconds until the outermost live ring falls (the core when rg == 0); -1 if nothing is scheduled
      p   bodies: [[id, x, y, z, face, st, cd], ...]
              x, y, z rounded to 0.01; face in radians; st = ST bits;
              cd = dash cooldown left as a fraction 0..1 (0 = ready)
              Only bodies that exist right now are listed (waiting / eliminated
              players whose body is gone are simply absent).
      e   events since the previous snapshot, in order (may be empty):
              ['hit', x, y, strength, idA, idB]
              ['dash', id]
              ['fall', id, byId, v]    byId = who gets the KO credit, or -1; v = small random int
                                       (lets every client pick the same text variant)
              ['ring', rg]             a ring (or the core) just fell; rg = new value
              ['spawn', id]            a body (re)appeared in free play

  { t:'round', rd, winner, order, pts }
      Sent when a round ends. winner = id or -1. order = ids from 1st place to last.
      pts = { [id]: points earned this round }.
  { t:'match', standings:[{ id, name, color, bot, score, kos }] }
      Sent when the match ends, sorted best first.

  A client that joins or reconnects mid-match is sent the roster, and the latest
  'round' / 'match' message if the phase is ROUND_END / MATCH_END.
*/

/*
MINIGOLF (GAME.GOLF) – additions. Everything above still holds for GAME.KNUFF.

Both games share players, tokens, colours, the room code, the host key and the
phases. The host switches game with a command; players keep their id and token.

CLIENT -> SERVER
  { t:'cmd', c:'game', v }      host only, in LOBBY or MATCH_END. v = GAME.KNUFF | GAME.GOLF
  { t:'shot', x, y }            hit your ball. (x, y) = wanted ball velocity in m/s in the
                                sim plane; the server clamps its length (GOLF.MIN_POWER ..
                                MAX_POWER) and ignores it unless your ball is at rest.

SERVER -> CLIENT
  roster    gains `game` (GAME.*). In golf each player also has
            hs = strokes on the current hole, in = true once their ball has dropped,
            and score = total strokes in the match so far (lower is better).
  snapshot  every snapshot gains g = GAME.*. With g = GAME.GOLF its shape is:
  { t:'s', ts, g:1, ph, pt, rd, rn, ci, ht, tl, p, e }
      ph  PHASE: LOBBY = practice green, COUNTDOWN = hole introduction,
          PLAYING = the hole, ROUND_END = hole results, MATCH_END = final results
          (practice green again)
      pt  seconds left in COUNTDOWN / ROUND_END, else 0
      rd  hole number in the match (1-based; 0 on the practice green)
      rn  holes in the match
      ci  index into COURSES (shared/golf.js) of the course being played
      ht  seconds this course has been running; drives the spinners
      tl  seconds left on the hole clock; -1 when there is none
      p   balls: [[id, x, y, z, st, strokes], ...]   st = BALL bits (shared/golf.js)
      e   events since the previous snapshot:
              ['shot', id, power]          power 0..1
              ['bounce', x, y, speed, kind]   kind 0 = rail, 1 = bumper, 2 = spinner
              ['boost', id]
              ['holed', id, strokes, v]    v = small random int for text variants
              ['oob', id]                  the ball left the course and is falling
              ['reset', id]                the ball is back where it was hit from
              ['spawn', id]                a ball appeared on the tee
  { t:'round', g:1, rd, ci, winner, order, pts }
      After each hole. pts = { [id]: strokes counted for this hole }, order best first.
  { t:'match', g:1, standings:[{ id, name, color, bot, score, kos }] }
      score = total strokes, best (lowest) first. kos = holes in one.
*/

/*
KLOSSGOLF (GAME.KLOSS) – classic golf with block figures. Rules and physics are in
shared/klossgolf.js, the holes in shared/klosscourses.js. Players, tokens, phases,
'roster' (hs, in, score = total strokes), 'round' and 'match' work as in minigolf,
with g = 2.

CLIENT -> SERVER
  { t:'cmd', c:'game', v }      v may also be GAME.KLOSS
  { t:'swing', a, p, c }        hit your ball. a = direction in the sim plane (radians,
                                atan2(dy, dx)), p = power 0..1, c = club (index into
                                CLUBS). Ignored unless your ball is READY.

SERVER -> CLIENT
  { t:'s', ts, g:2, ph, pt, rd, rn, ci, tl, w, p, e }
      ph, pt, rd, rn, tl   as in minigolf (LOBBY and MATCH_END are the practice range)
      ci  index into KCOURSES
      w   wind on this hole: [wx, wy] in m/s, rounded to 0.1
      p   [[id, x, y, z, st, strokes, fx, fy], ...]
              x, y, z = the ball. st = KST bits. (fx, fy) = where that player's
              figure stands or runs.
      e   events since the previous snapshot:
              ['shot', id, club, power, angle]   power and angle as actually played
              ['land', id, x, y, surf, speed]    touchdown; surf = SURF.*, speed = downward m/s
              ['tree', id, x, y, z]
              ['splash', id, x, y]               into water: +1 stroke
              ['oob', id, x, y]                  out of bounds: +1 stroke
              ['reset', id]                      the ball is back where it was hit from
              ['holed', id, strokes, v, dunk]    v = small random int for text variants;
                                                 dunk = 1 when it flew straight in
              ['spawn', id]                      a ball appeared on the tee
  { t:'round', g:2, rd, ci, winner, order, pts }
  { t:'match', g:2, standings }
*/

/*
HETA PAKETET (GAME.PAKET) – hot potato on the Knuffkampen arena. Rules' numbers are
in shared/paket.js. Everything in the Knuffkampen section holds (join, 'in', the
snapshot shape, 'roster', 'round', 'match'), with g = 3, plus:

  { t:'cmd', c:'game', v }   v may also be GAME.PAKET

  snapshot gains
      ca  id of the player carrying the parcel, or -1 (lobby, between parcels)
      fu  how far the fuse has burnt, 0..1 (1 = it pops now); 0 while ca is -1
      rg stays at r0 for the whole round and wf is -1: no rings fall.
  events, besides 'hit', 'dash', 'fall' and 'spawn':
      ['parcel', id]         a fresh parcel was handed to this player
      ['pass', fromId, toId] the parcel changed cars in a collision
      ['pop', id, v]         the fuse ran out on this player, who is out of the round;
                             v = small random int for text variants
*/
