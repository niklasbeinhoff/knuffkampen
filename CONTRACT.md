# Knuffkampen – build contract

A temporary browser party game for roughly 5–30 colleagues in a Google Meet call at a
Swedish media company. Everyone opens a link, types a nickname and a room code, and
drives a little bumper car on a floating ice arena above the clouds. You shove the
others off the edge. The arena loses its outermost ring every few seconds; last one
standing wins the round. Three rounds make a match, which ends with a newspaper
placard ("löpsedel") announcing the winner. The host shares their screen: a spectator
view with the controls to start the match.

Rules that apply to every file:

- Tone is playful and safe for work. No violence beyond bumper cars, no innuendo, no
  jokes at a named player's expense, no invented quotes attributed to players.
- All player-facing text is Swedish. Code, comments and identifiers are English.
- Everything is procedural: no image, audio, font or model files, no CDN, no network
  request other than to our own server. three.js comes from `node_modules` via the
  import map in `public/index.html` (`three`, `three/addons/...`), version 0.187.
- Plain ES modules, no build step, no extra npm dependencies.
- It must run well on an ordinary office laptop that is also in a video call.
- Stay inside the files you own. If the contract is wrong or missing something, do the
  sensible thing in your own files and say so in your final report; do not edit files
  owned by someone else.

## Files and owners

| Path | Owner | Purpose |
|---|---|---|
| `shared/sim.js` | lead | Physics and all tuning constants. Read-only for agents. |
| `shared/protocol.js` | lead | Wire protocol, `PHASE`, `ST`, `PALETTE`, `LIMITS`. Read-only for agents. |
| `server/static.js`, `tools/dev-static.js` | lead | Static file handler; harness server on port 3100. |
| `public/index.html`, `public/js/main.js` | lead | Page shell; client glue: socket, interpolation, input, wiring. |
| `server/server.js`, `server/game.js`, `server/bots.js`, `tools/smoke.js` | server agent | Authoritative game server. |
| `public/js/scene.js`, `public/dev/scene-test.html` | scene agent | Everything rendered with three.js. |
| `public/js/hud.js`, `public/js/texts.js`, `public/css/style.css`, `public/dev/hud-test.html` | HUD agent | DOM overlay, Swedish copy, styling. |
| `public/js/audio.js`, `public/dev/audio-test.html` | audio agent | Synthesised sound. |

## Coordinates

Sim space: `(x, y)` is the ice plane, `z` is height (0 on the ice, negative while
falling). three.js world: `X = sim x`, `Y = sim z`, `Z = sim y`. `face` is
`atan2(dy, dx)` in the sim plane, so the forward vector in the world is
`(cos face, 0, sin face)`.

The player camera never yaws or rolls: screen-up is world `-Z` (sim `-y`), screen-right
is world `+X`. Input `y = -1` therefore means "away from the camera".

## Arena

A centre disc of radius `SIM.CORE_R` plus `r0` concentric rings, each `SIM.RING_W` wide.
Ring `i` (0 = innermost) spans radius `CORE_R + i*RING_W` to `CORE_R + (i+1)*RING_W`.
`rings` is how many are alive; the live radius is `arenaRadius(rings)`. Rings fall from
the outside in. `rings == 0` means only the core is left ("sudden death": when the core
falls, whoever is closest to the centre wins). `rings == -1` means the core is gone.
The visible edge of the platform must match `arenaRadius(rings)`, because a body falls
the moment its centre crosses that radius.

## Module APIs

`main.js` is written against exactly these signatures.

### `public/js/scene.js`

```js
import { createScene } from './scene.js';
const scene = createScene(canvas, { spectator });  // spectator: true on the host screen

scene.setArena(r0)            // (re)build the platform with r0 rings, all intact
scene.upsertPlayer(id, { name, color, isMe, bot })  // create or update; color = index into PALETTE
scene.removePlayer(id)
scene.frame(dt, view)         // once per animation frame; updates and renders
scene.resize()                // after the window size changes
scene.setQuality(q)           // 'auto' (default) | 'low' | 'medium' | 'high'
scene.getStats()              // -> { fps, quality }

scene.fx.hit(x, y, strength)  // sim position; strength is an impulse, about 2 (nudge) to 30 (huge)
scene.fx.dash(id)
scene.fx.fall(id)             // this body just left the platform
scene.fx.confetti(x, y)       // celebration burst above a sim position
scene.fx.shake(amount)        // camera shake, 0..1
```

`view`, rebuilt by `main.js` every frame:

```js
{
  time,      // seconds, monotonic
  phase,     // PHASE.*
  rings,     // rings alive now (r0 .. -1)
  warnIn,    // seconds until the outermost live ring (the core when rings == 0) falls; < 0 = nothing scheduled
  myId,      // number, or null on the host screen
  spectate,  // true -> overview camera (host screen, or a player who is out)
  input,     // { x, y } the local player's input right now, for instant visual feedback
  players,   // [{ id, x, y, z, face, st, cd }] already interpolated
}
```

Only bodies that exist this frame are in `view.players`; a player that was upserted but
is absent must be hidden. When `0 <= warnIn <= SIM.WARN_T` the piece about to fall must
visibly warn. When `view.rings` drops, the rings with index `>= rings` fall away (and
the core when it reaches -1). `setArena` restores everything.

### `public/js/hud.js`

```js
import { createHud } from './hud.js';
const hud = createHud(document.getElementById('hud'), {
  host,                       // boolean: host / big-screen layout with the host panel
  on: {                       // callbacks, all optional
    start(), toLobby(), setBots(n), setRounds(n), kick(id),   // host panel
    mute(muted),                                              // sound toggle
  },
});

hud.showJoin({ name, code, onSubmit(name, code) })  // join form, fields prefilled
hud.setJoinError(text)        // show an error (null clears it) and re-enable the form
hud.hideJoin()
hud.setConnection(state)      // 'ok' | 'reconnecting'

hud.setRoster(players, myId)  // [{ id, name, color, bot, score, kos, on }]; hud sorts by score
hud.setStatus({ phase, round, rounds, alive, total, warnIn, sudden })  // EVERY frame: diff before touching the DOM
hud.setDash(frac)             // EVERY frame: 0 = ready, 1 = just used
hud.setHostPanel({ phase, url, code, humans, bots, rounds })  // host only; may be called often: diff

hud.ticker(text, kind)        // news-ticker line; kind = 'ko' | 'info' | 'warn' | 'win'
hud.countdown(n)              // 3, 2, 1, then 0 = "KNUFFA!"
hud.eliminated({ place, total, byName })  // the local player is out; byName may be null
hud.roundEnd({ round, rounds, winnerName, youWon, top })  // top = [{ name, color, pts }], best first
hud.matchEnd({ standings, myId })  // standings = [{ id, name, color, bot, score, kos }]; shows the löpsedel
hud.clearOverlays()           // hide countdown / eliminated / roundEnd / matchEnd
```

`#hud` covers the whole window above the canvas. On touch devices `main.js` draws its
own joystick in the bottom-left corner and a dash button in the bottom-right corner
(about 150 px square each): keep those corners free.

### `public/js/texts.js`

```js
export function koText(victim, by, v)   // by = name or null (fell on their own); v = integer picking the variant
export function infoText(kind, data)    // kind: 'ringWarn' | 'ringFall' | 'sudden' | 'matchStart' | 'lobby'
                                        //     | 'roundWin' {name, round} | 'join' {name} | 'leave' {name}
export function makeHeadline(standings) // -> { lines: string[] (max 3, upper case), kicker: string, facts: string[] }
```

### `public/js/audio.js`

```js
import { audio } from './audio.js';

audio.unlock()                 // call from a user gesture; creates / resumes the AudioContext. Safe to repeat.
audio.setMuted(bool)
audio.isMuted()
audio.bump(strength, pan)      // strength 0..1, pan -1..1
audio.dash(own)                // own: boolean, the local player's own sounds are a bit louder
audio.fall(own)
audio.ko()                     // somebody was knocked out
audio.countdown(n)             // 3, 2, 1, and 0 = go
audio.ringWarn()               // one alarm tick; called about once a second during a warning
audio.ringFall()
audio.win()                    // fanfare
audio.lose()                   // the local player is out
audio.join()                   // somebody joined the lobby
audio.music(mode)              // 'lobby' | 'game' | 'off' : a light procedural loop
```

Every call must be a silent no-op before `unlock()` and when muted.

## Harness pages

`npm run dev:static` (or the `knuff-static` launch config) serves the client on
`http://localhost:3100` without the game server. Each client agent builds a harness
page under `public/dev/` that exercises its own module with fake data.

# Second game: minigolf ("Molngolf")

Same app, same link, same lobby. The host switches between Knuffkampen and minigolf
in the lobby; players keep their id. Everyone plays the same hole at the same time,
each with their own ball. Balls do not collide with each other. You aim by dragging
anywhere on the screen like a slingshot (pull back, release), with mouse, trackpad or
touch. Fewest strokes over the match wins. A match is up to five holes; the lobby and
the time after a match are spent on a practice green.

Read `shared/golf.js` (constants, the frozen course format, `COURSES`, ball physics)
and the MINIGOLF section at the end of `shared/protocol.js`. The rules above for every
file still apply. Reuse what exists: sky, clouds, particles, quality tiers, lobby,
scoreboard, ticker, result cards, löpsedel. Knuffkampen must keep working unchanged.

## Owners

| Path | Owner |
|---|---|
| `shared/golf.js` physics, constants, format; `shared/protocol.js`; `public/js/main.js` | lead |
| `COURSES` in `shared/golf.js`; `server/*.js`; `tools/*.js` | server agent |
| `public/js/scene.js`, `public/dev/golf-test.html` | scene agent |
| `public/js/hud.js`, `texts.js`, `audio.js`, `public/css/style.css`, their harness pages | HUD and audio agent |

## Rules (server)

- LOBBY and MATCH_END: practice on `COURSES[0]`. No stroke limit, no clock. A ball that
  drops is put back on the tee after `GOLF.RESPAWN_T` (`spawn` event).
- `start`: holes = `COURSES[1 .. min(rounds, COURSES.length - 1)]`, in order.
- COUNTDOWN (`GOLF.INTRO_T`): everyone's ball is placed with `teeSpot(course, i)`.
- PLAYING: a `shot` counts one stroke when `canShoot`. `oob` then `reset` costs one
  more stroke. The hole ends when every ball has dropped or used `GOLF.MAX_STROKES`
  and is at rest, or when `GOLF.HOLE_TIME` runs out (balls still rolling get up to
  4 s to settle).
- Hole score: strokes if the ball dropped, else `max(strokes, MAX_STROKES) + DNF_PENALTY`.
  Someone who joins mid-match gets `par + MISSED_HOLE` for each hole already played
  and a ball on the tee straight away if a hole is in progress.
- ROUND_END (`GOLF.HOLE_END_T`), then the next hole or MATCH_END. Standings: fewest
  total strokes, ties broken by total time to hole out.
- Bots putt along `course.line` with aim and power error that varies per bot.

## Scene additions (`public/js/scene.js`)

```js
scene.setGame(game)            // GAME.KNUFF | GAME.GOLF: show one game's objects, keep the environment
scene.setCourse(ci)            // golf: build COURSES[ci] (called when the snapshot's ci changes)
scene.groundPoint(clientX, clientY)   // golf: screen point -> { x, y } on the green plane (sim coords), or null

scene.fx.putt(id, power)       // power 0..1
scene.fx.bounce(x, y, speed, kind)    // kind 0 = rail, 1 = bumper, 2 = spinner
scene.fx.boost(id)
scene.fx.holed(id, strokes)    // ball dropped; extra celebration when strokes === 1
scene.fx.oob(id)               // ball left the course
```

`view` in golf (`view.game === GAME.GOLF`; without `game` it is Knuffkampen as before):

```js
{
  time, game, phase, myId, spectate,     // spectate is true on the host screen
  course,                                // ci
  holeTime,                              // ht: spinner angle = phase + speed * holeTime
  balls,                                 // [{ id, x, y, z, st, strokes }] interpolated; identity from upsertPlayer
  aim,                                   // null, or { x, y, power }: unit shot direction (sim plane) and power 0..1
}
```

The whole course is in frame and the player camera does not move while you play,
because aiming needs a steady picture. On a portrait screen turn the view a quarter
turn if the course fits better that way (`groundPoint` hides this from the caller).
The local ball is unmistakable; the aim shows direction and power from that ball.

## HUD additions (`public/js/hud.js`, `texts.js`)

```js
createHud(root, { host, on: { ..., setGame(game) } })

hud.setGame(game)              // switch labels, meters and scoreboard columns
hud.setGolf({ phase, hole, holes, name, par, timeLeft, strokes, holed, canShoot })  // EVERY frame in golf: diff
hud.setAim(power)              // EVERY frame in golf: 0..1 while aiming, else null
hud.holeIntro({ hole, holes, name, par })
hud.holed({ strokes, par })    // the local player's ball dropped
hud.holeEnd({ hole, holes, name, par, top })   // top = [{ name, color, strokes }], best first, max 3

hud.setRoster(players, myId)   // golf: fewest strokes first; show `hs` and a mark when `in`
hud.setHostPanel({ phase, url, code, humans, bots, rounds, game })  // lobby: a game switch; "Rundor" reads "Hål" in golf
hud.matchEnd({ standings, myId, game })

// texts.js
golfText(kind, data, v)        // 'holed' {name, strokes, par} | 'oob' {name} | 'intro' {hole, name, par}
                               // | 'holeWin' {name, strokes} | 'practice' | 'matchStart'
scoreName(strokes, par)        // 'HOLE-IN-ONE', 'EAGLE', 'BIRDIE', 'PAR', 'BOGEY', 'DUBBELBOGEY', '+3' ...
makeHeadline(standings, game)
```

## Audio additions (`public/js/audio.js`)

```js
audio.putt(power, own)         // power 0..1
audio.knock(speed, kind, pan)  // ball against rail (0), bumper (1), spinner (2); speed 0..1
audio.cup(own)                 // ball drops into the cup
audio.holeInOne()
audio.oob(own)
audio.boost()
audio.music('golf')            // a calm, sunny loop
```

# Third game: classic golf ("Klossgolf")

Same app, same link, same lobby: a third choice in the host's game switch. Real golf
holes seen from behind your own figure, in the style of the classic golf video games:
tee, fairway, rough, bunkers, water, a green and a flag. The ball flies, bounces and
rolls. Every player is a blocky figure built from boxes (head, body, arms, legs, a
cap, a club) in their own colour, who swings and then sprints after the ball. The look
is a friendly voxel world of our own: do not copy the characters, textures or look of
any existing game. Everyone plays the same hole at the same time with their own ball;
balls and figures pass through each other. Fewest strokes over the match wins.

How you play (wired in `main.js`): turn the aim with A/D, the arrow keys or by
dragging sideways on the picture. Hold Space or the on-screen swing button and the
meter climbs from 0 to 100 % in `KG.CHARGE_T` seconds, then falls back; release to
hit. While you hold, a landing ring on the course shows where that power puts the
ball. W/S, up/down or on-screen buttons change club; a caddie picks a sensible club
and direction each time the ball comes to rest.

Read `shared/klossgolf.js` (constants, surfaces, clubs, ball physics, `predict`),
`shared/klosscourses.js` (the frozen course format) and the KLOSSGOLF section at the
end of `shared/protocol.js`. The rules at the top of this file still apply. Reuse
what exists: sky, clouds, particles, quality tiers, lobby, scoreboard, ticker, hole
cards, löpsedel. Knuffkampen and Molngolf must keep working unchanged.

## Owners

| Path | Owner |
|---|---|
| `shared/klossgolf.js`, `shared/protocol.js`, `public/js/main.js` | lead |
| `shared/klosscourses.js`, `server/*.js`, `tools/*.js` | server agent |
| `public/js/scene.js`, new `public/js/scene-*.js`, `public/dev/kloss-test.html` | scene agent |
| `public/js/hud.js`, `texts.js`, `audio.js`, `public/css/style.css`, their harness pages | HUD and audio agent |

## Rules (server)

- LOBBY and MATCH_END: practice on `KCOURSES[0]`, no stroke limit, no clock, no wind.
  A holed ball goes back to the tee after `KG.RESPAWN_T` (`spawn`).
- `start`: holes = `KCOURSES[1 .. min(rounds, KCOURSES.length - 1)]`, in order.
- COUNTDOWN (`KG.INTRO_T`): every ball on `teeSpot(course, i)`, every figure at its
  ball. The hole's wind is drawn: any direction, 0 .. `KG.MAX_WIND`, gentle on hole 1.
- PLAYING: a `swing` counts one stroke when the ball is READY; the lie's scatter uses
  the server's random. `splash` and `oob` cost one more stroke. The hole ends when
  every ball is holed, or has used `maxStrokes(course)` and is at rest, or when
  `holeClock(course)` runs out (balls still moving get up to 4 s to settle).
- Figures: each player has a figure position `(fx, fy)`. It stands still for
  `KG.RUN_DELAY` after its swing, then runs straight at its ball at `KG.RUN_SPEED` and
  stops 1 m short. READY = the ball is at rest (not MOVING, HOLED or HAZARD), the
  figure is within `KG.REACH` of it and the player may swing (practice, or PLAYING
  with strokes left). A ball put back after a hazard makes its figure run back. After
  `holed` the figure runs to the cup and stops 1.5 m from it.
- Hole score: strokes if holed, else `max(strokes, maxStrokes(course)) + DNF_PENALTY`.
  Someone who joins mid-match gets `par + MISSED_HOLE` for each hole already played
  and a ball on the tee straight away if a hole is in progress.
- ROUND_END (`KG.HOLE_END_T`), then the next hole or MATCH_END. Standings: fewest
  total strokes, ties broken by total time to hole out.
- Bots use `aimPoint`, `suggestClub` and `bestPower` with an aim and power error that
  varies per bot, and wait 0.8–2.5 s after READY. A decent bot scores around par to
  double bogey and now and then finds the water.

## Scene additions

```js
scene.setGame(GAME.KLOSS)
scene.setCourse(ci)            // in Klossgolf: build KCOURSES[ci]

scene.fx.swing(id, club, power, angle)   // that figure swings along `angle`; the ball leaves
scene.fx.land(id, x, y, surf, speed)     // touchdown: turf, sand spray, a soft thud on the green; speed about 0..20
scene.fx.splash(id, x, y)
scene.fx.tree(x, y, z)                   // leaves rustle
scene.fx.holed(id, strokes)              // existing name: confetti at the cup, the figure cheers
scene.fx.oob(id)                         // existing name
```

`view` in Klossgolf (`view.game === GAME.KLOSS`):

```js
{
  time, game, phase, myId, spectate,     // spectate is true on the host screen
  course,                                // ci
  wind,                                  // [wx, wy] m/s
  intro,                                 // seconds left of the hole introduction (COUNTDOWN), else 0
  balls,                                 // [{ id, x, y, z, st, strokes, fx, fy }] interpolated; (fx, fy) = the figure
  heading,                               // radians: where the local player aims. Always set; the camera looks along it
  aim,                                   // null unless the local player may swing (READY), then
                                         // { angle, club, power, charging, path, land, rest, end }:
                                         //   power: the meter right now while charging, else 1 (full reach)
                                         //   path [[x, y, z], ...], land [x, y], rest [x, y], end: predict() at that power
}
```

World mapping as before: `X = sim x`, `Y = sim z`, `Z = sim y`. Looking along
`heading`, screen-right is sim `(-sin heading, cos heading)`.

Cameras. A player sees the hole from behind their own figure, looking along
`heading`, so that the ball, the aim line and the landing ring are in view; closer and
lower with the putter. The camera tracks the player's own ball while it flies, then
follows the figure as it runs. During COUNTDOWN every screen gets a flyover of the
hole from the green back to the tee that ends in the playing view. The host screen is
a TV drone: it keeps every figure still playing and the flag in frame.

## HUD additions

```js
createHud(root, { host, on: { ..., swing(down), club(delta) } })
    // swing(true) when the on-screen swing button is pressed, swing(false) when it is released
    // club(-1 | +1) from the on-screen club buttons

hud.setGame(GAME.KLOSS)
hud.setKloss({ phase, hole, holes, name, par, timeLeft, strokes, maxStrokes, holed, ready,
               club, lie, pin, wind, windDir, power, mark })   // EVERY frame: diff
    // club: index into CLUBS, or -1 when there is no local player (host screen)
    // lie: SURF.* under the local ball. pin: metres from the ball to the cup.
    // wind: m/s. windDir: radians on screen for the wind arrow, 0 = blowing away from
    //   the player (tailwind), positive = clockwise (PI / 2 = blowing to the right).
    // power: the swing meter 0..1 while charging, else null.
    // mark: the power that reaches the caddie's target with this club (0..1), or null.
```

`holeIntro`, `holed`, `holeEnd`, `setRoster`, `matchEnd({ game })` and the ticker work
as in minigolf. `setHostPanel({ ..., game })` shows a three-way game switch. On a
touch screen the swing button sits bottom-right and the club buttons bottom-left; the
middle of the screen stays free for dragging the aim.

```js
// texts.js
klossText(kind, data, v)       // 'intro' {hole, name, par} | 'holed' {name, strokes, par, dunk} | 'water' {name}
                               // | 'oob' {name} | 'sand' {name} | 'holeWin' {name, strokes} | 'practice' | 'matchStart'
makeHeadline(standings, game)  // also for GAME.KLOSS
```

## Audio additions

```js
audio.swing(club, power, own)  // club index: a full whoosh-and-crack for the driver down to a tap for the putter
audio.land(surf, speed, pan)   // SURF.*; speed 0..1; pan -1..1
audio.splash(own)
audio.tree()
// reused: cup, holeInOne, oob, win, music('golf')
```

# Fourth game: hot potato ("Heta paketet")

Same app, lobby and link; a fourth choice in the host's game switch. It is Knuffkampen's
arena, cars, controls and camera with one new idea: one car carries a ticking parcel
and gets rid of it by bumping into somebody else. When the hidden fuse runs out,
confetti pops over whoever holds it and that player is out of the round. A new parcel
is handed out, and so on until one car is left. Light-hearted and safe for work: a
party popper, never an explosion. Read `shared/paket.js` and the HETA PAKETET block at
the end of `shared/protocol.js`. Knuffkampen, Molngolf and Klossgolf must keep working
unchanged.

## Owners

| Path | Owner |
|---|---|
| `shared/paket.js`, `shared/sim.js`, `shared/protocol.js`, `public/js/main.js` | lead |
| `server/*.js`, `tools/*.js` | server agent |
| `public/js/scene.js`, new `public/js/scene-*.js`, `public/dev/paket-test.html` | scene agent |
| `public/js/hud.js`, `texts.js`, `audio.js`, `public/css/style.css`, their harness pages | HUD and audio agent |

## Rules (server)

- LOBBY and MATCH_END: Knuffkampen's free play, no parcel (`ca` = -1).
- A match is `rounds` rounds, scored exactly as Knuffkampen scores a round: the order
  in which players go out decides the points, last car left wins the round.
- COUNTDOWN: cars placed as in Knuffkampen; the first carrier is drawn at random and
  shown already (`ca` set, `fu` 0, a `parcel` event).
- PLAYING: the fuse is `random(FUSE_MIN, FUSE_MAX) * fuseScale(alive)`. The carrier's
  body has `acc = PAKET.CARRIER_ACC` (sim.js reads `b.acc`), everyone else 1. When the
  carrier collides with another live car (a `hit` between the two), the parcel moves
  to that car, unless less than `PASS_CD` has passed since the last pass or that car
  is the one it just came from within `PASS_BACK`. A pass does not reset the fuse.
- When the fuse runs out: `pop`, and the carrier is out of the round the same way a
  car that falls off is out (its body goes away, it gets its place in the order).
  After `NEXT_T` a new parcel goes to a random car still in, with a new fuse.
- Falling off the arena still puts you out, with the usual KO credit. If the carrier
  falls, a new parcel is handed out after `NEXT_T`. No rings fall in this game.
- Bots run from the carrier and keep away from the edge; a bot that carries the
  parcel chases the nearest car it may pass to and dashes when close.

## Scene additions

```js
scene.setGame(GAME.PAKET)        // Knuffkampen's arena, cars and cameras, plus the parcel
scene.fx.pass(fromId, toId)      // the parcel hops across in a small arc
scene.fx.pop(id)                 // party-popper confetti over that car, which then puffs away
```

`view` is Knuffkampen's (`view.game === GAME.PAKET`) plus `carrier` (id or -1) and
`fuse` (0..1). The parcel rides on the carrier's roof: a parcel wrapped in newsprint
with string and an alarm clock on top that shakes and rings harder as `fuse` nears 1.
Everyone must see at a glance who has it, from the player camera and from the host
screen: mark the carrier clearly (a beam, a ring, a bobbing arrow).

## HUD additions

```js
hud.setGame(GAME.PAKET)
hud.setPaket({ phase, carrierName, mine, fuse, alive })   // EVERY frame in this game: diff
    // mine: the local player carries the parcel. carrierName: null when nobody does.
    // A banner nobody can miss: "DU HAR PAKETET! KNUFFA NÅGON!" when mine, else
    // "<namn> har paketet". A fuse gauge without numbers that pulses faster as fuse nears 1.
hud.eliminated({ place, total, byName, reason })           // reason 'pop': the parcel went off on you
hud.setHostPanel({ ..., game })                            // a four-way game switch; "Rundor" as in Knuffkampen

// texts.js
paketText(kind, data, v)       // 'parcel' {name} | 'pop' {name} | 'matchStart' | 'lobby' | 'roundWin' {name, round}
makeHeadline(standings, game)  // also for GAME.PAKET
```

`setStatus`, `setDash`, `countdown`, `roundEnd`, `matchEnd({ game })` and the ticker work
as in Knuffkampen.

## Audio additions

```js
audio.tick(urgency)            // one tick of the clock; urgency 0..1 raises the pitch. main.js calls it faster and faster
audio.pass(own)                // the parcel changed hands; own = the local player gave or got it
audio.pop(own)                 // party popper and a rattling alarm bell
```

## Playing host (2026-11-19)

The host can play and steer from one screen; the big screen (`/?host=KEY`) is optional.

- Link: `/?k=CODE&host=KEY`. `main.js` moves the key to `sessionStorage` (`kk_ctl`) and
  rewrites the address bar to `/?k=CODE`, so the bar is safe to show or copy on. The
  page is an ordinary player page (join with a name, player camera, touch controls).
- Wire: after `joined` the client sends `{ t:'host', key }` on the same socket. The server
  marks that player socket `ctl` and answers `{ t:'hosted', code, id }`; from then on the
  socket may send every `cmd` (start, lobby, bots, rounds, game, kick) except kicking its
  own player id. A wrong key gives `{ t:'err', m:'key' }` and the socket stays a plain
  player. The flag belongs to the socket: on reconnect the client sends the key again.
- HUD: `hud.setHostCtl(on)` builds the host panel on first use and shows it in a compact
  form (`#hud.ctl`): a foldable lobby card (game, code, players, bots, rounds/holes, start),
  a small "Till lobbyn" that asks once more during play, and "Ny match" / "Till lobbyn"
  after the match. Kick buttons appear on every other row of the scoreboard. On a phone
  in portrait the card and the end buttons sit above the touch controls.
- `main.js` feeds `hud.setHostPanel(...)` every frame when `isHost || amCtl`.
