// Knuffkampen – client glue: socket, snapshot interpolation, input, and the
// wiring between the scene, the HUD and the sound. See CONTRACT.md.

import { SIM } from '../shared/sim.js';
import { PHASE, ST, GAME } from '../shared/protocol.js';
import { GOLF, BALL, COURSES } from '../shared/golf.js';
import { createScene } from './scene.js';
import { createHud } from './hud.js';
import { audio } from './audio.js';
import { koText, infoText, golfText, klossText, paketText } from './texts.js';
import {
  KG, KST, SURF, CLUBS, SURFACE, PUTTER, maxStrokes, surfaceAt, predict, bestPower, aimPoint, suggestClub,
} from '../shared/klossgolf.js';
import { KCOURSES } from '../shared/klosscourses.js';
import { P2P, PeerSocket, startRoom } from './p2p.js';

const INTERP_MS = 100;      // how far behind the server we render
const INPUT_MS = 33;        // input send interval
const KEEPALIVE_MS = 200;

const qs = new URLSearchParams(location.search);

// The host key arrives in the link but must not stay in the address bar,
// because the host shares their screen. Keep it in this tab's session instead.
// `?host=KEY` alone is the big screen (not a player). `?k=CODE&host=KEY` joins
// as an ordinary player who also gets the host controls ("playing host").
// On GitHub Pages (P2P) there is no big screen: the host is always a playing host.
const isHost = !P2P && qs.has('host') && !qs.has('k');
let hostKey = '';
if (isHost) {
  hostKey = qs.get('host') || '';
  try {
    if (hostKey.length > 1) sessionStorage.setItem('kk_host', hostKey);
    else hostKey = sessionStorage.getItem('kk_host') || '';
    history.replaceState(null, '', location.pathname + '?host');
  } catch { /* storage or history unavailable: the key stays in the link */ }
}
// Playing host: the key lives in this tab's session; the address bar keeps only
// the room code, so it is safe to show or copy on to the others.
let ctlKey = '';
if (!isHost) {
  ctlKey = qs.get('host') || '';
  // Pages: '&host' needs no key, because the room runs in this very tab.
  if (P2P && qs.has('host') && ctlKey.length <= 1) ctlKey = 'p2p';
  try {
    if (ctlKey.length > 1) sessionStorage.setItem('kk_ctl', ctlKey);
    else ctlKey = sessionStorage.getItem('kk_ctl') || '';
    if (qs.has('host')) {
      const rest = new URLSearchParams(qs);
      rest.delete('host');
      history.replaceState(null, '', location.pathname + '?' + rest.toString());
    }
  } catch { /* storage or history unavailable */ }
}
let amCtl = false;        // this player's socket holds the host controls
// Pages: this tab runs the room itself (room-worker.js); the others connect to it.
const roomHost = P2P && !!ctlKey;
let room = null;
let roomStarting = null;
let roomCodeOpen = '';
let ctlPending = false;   // host key sent after 'joined', answer not yet in
let ctlGreeted = false;

// Storage can throw in private windows; never let that break the game.
const store = {
  get(area, k) { try { return area.getItem(k); } catch { return null; } },
  set(area, k, v) { try { area.setItem(k, v); } catch { /* ignore */ } },
  del(area, k) { try { area.removeItem(k); } catch { /* ignore */ } },
};
const safe = (fn) => { try { fn(); } catch (err) { console.error(err); } };

// ---------------------------------------------------------------- modules

const canvas = document.getElementById('c');
const scene = createScene(canvas, { spectator: isHost });
const hud = createHud(document.getElementById('hud'), {
  host: isHost,
  only: P2P ? GAME.PAKET : null,   // the GitHub Pages site plays Heta paketet only
  on: {
    start() { unlockAudio(); send({ t: 'cmd', c: 'start' }); },
    toLobby() { send({ t: 'cmd', c: 'lobby' }); },
    setBots(n) { send({ t: 'cmd', c: 'bots', v: n }); },
    setRounds(n) { send({ t: 'cmd', c: 'rounds', v: n }); },
    kick(id) { if (id !== myId) send({ t: 'cmd', c: 'kick', v: id }); },
    setGame(game) { send({ t: 'cmd', c: 'game', v: game }); },
    swing(down) { if (down) swingDown(); else swingUp(); },
    club(delta) { nudgeClub(delta); },
    mute(muted) {
      audio.setMuted(!!muted);
      if (!muted) unlockAudio();
    },
  },
});

// ---------------------------------------------------------------- state

let myId = null;
let roomCode = (qs.get('k') || '').toUpperCase().slice(0, 16);
const roster = new Map();          // id -> { id, name, color, bot, score, kos, on }
let settings = { bots: 0, rounds: 3, game: GAME.KNUFF };
let rosterSeen = false;
let curGame = GAME.KNUFF;          // the game the frame being rendered belongs to
const knuffLike = (g) => g === GAME.KNUFF || g === GAME.PAKET;   // bumper cars on the ice arena
const paket = { lastTick: 0 };

const snaps = [];                  // snapshots, oldest first
let clockOff = null;               // estimate of serverTime - performance.now()

const cur = { ph: -1, rd: -1, rn: 0 };   // phase, round and round count of the frame being rendered
const arena = { r0: SIM.LOBBY_RINGS, rg: SIM.LOBBY_RINGS };
let roundTotal = 0;
let amOut = false;                 // local player eliminated this round
let outTimer = 0;
let lastCount = -1;
let lastWarnK = -1;
let warnAnnounced = false;
let pendingRound = null;
let pendingMatch = null;
let musicMode = 'lobby';
let audioUnlocked = false;

const view = {
  time: 0,
  game: GAME.KNUFF,
  phase: PHASE.LOBBY,
  myId: null,
  spectate: true,
  // Knuffkampen
  rings: SIM.LOBBY_RINGS,
  warnIn: -1,
  input: { x: 0, y: 0 },
  players: [],
  carrier: -1,      // Heta paketet: who has the parcel
  fuse: 0,          // ... and how far its fuse has burnt, 0..1
  // minigolf
  course: 0,
  holeTime: 0,
  balls: [],
  aim: null,
  // Klossgolf
  wind: [0, 0],
  intro: 0,
  heading: 0,
};

scene.setArena(SIM.LOBBY_RINGS);

const nameOf = (id) => roster.get(id)?.name ?? '???';

// ---------------------------------------------------------------- audio

let online = false;   // joined or hosting, with the socket up

// Music only plays in a visible tab that is actually in the game, so a page
// left open in the background (or after the server is gone) falls silent.
function applyMusic() {
  if (audioUnlocked) safe(() => audio.music(online && !document.hidden ? musicMode : 'off'));
}
function unlockAudio() {
  safe(() => {
    audio.unlock();
    audioUnlocked = true;
  });
  applyMusic();
}
function setMusic(mode) {
  musicMode = mode;
  applyMusic();
}
function setOnline(v) {
  online = v;
  applyMusic();
}
if (qs.has('mute')) audio.setMuted(true);   // testing aid: start silent
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);

// ---------------------------------------------------------------- socket

let ws = null;
let everIn = false;      // joined or authenticated at least once
let kicked = false;
let retry = 0;
let pendingJoin = null;  // { name, code }

function ensureRoom(code) {
  if (room) return Promise.resolve(room);
  if (!roomStarting) {
    roomCodeOpen = code;
    roomStarting = startRoom(code, GAME.PAKET).then((r) => { room = r; return r; }, (err) => { roomStarting = null; throw err; });
  }
  return roomStarting;
}

function roomFailed(err) {
  const taken = err && err.type === 'unavailable-id';
  hud.setJoinError(taken
    ? 'Ett rum med den koden är redan öppet någon annanstans. Välj en annan kod.'
    : 'Kunde inte öppna rummet: ingen kontakt med kopplingstjänsten. Kolla nätet och försök igen.');
}

function openSocket() {
  if (!P2P) return new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  if (roomHost) return room.localSocket();
  return new PeerSocket((pendingJoin && pendingJoin.code) || roomCode);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (roomHost && !room) {
    const code = (pendingJoin && pendingJoin.code) || roomCode;
    if (code) ensureRoom(code).then(() => connect(), roomFailed);
    return;
  }
  if (roomHost && pendingJoin && pendingJoin.code !== roomCodeOpen) {
    hud.setJoinError(`Rummet är redan öppet med koden ${roomCodeOpen}.`);
    return;
  }
  const sock = openSocket();
  ws = sock;
  sock.onopen = () => {
    if (sock !== ws) return;
    if (isHost) send({ t: 'host', key: hostKey });
    else if (pendingJoin) sendJoin();
  };
  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m && typeof m === 'object') safe(() => onMessage(m));
  };
  sock.onclose = (ev) => {
    if (sock !== ws) return;
    ws = null;
    onClose(ev);
  };
  sock.onerror = () => { /* onclose follows */ };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendJoin() {
  const token = store.get(sessionStorage, 'kk_token');
  const msg = { t: 'join', name: pendingJoin.name, code: pendingJoin.code };
  if (token) msg.token = token;
  send(msg);
}

function setCtl(on) {
  ctlPending = false;
  if (amCtl === on) return;
  amCtl = on;
  hud.setHostCtl(on);
}

function onClose(ev) {
  setOnline(false);
  // The controls belong to the socket; a reconnect asks for them again.
  setCtl(false);
  if (kicked) return;
  if (ev && ev.code === 4001) {
    // Another tab took over this player; reconnecting would only steal it back.
    everIn = false;
    myId = null;
    pendingJoin = null;
    store.del(sessionStorage, 'kk_token');
    showJoin('Du spelar redan i en annan flik.');
    return;
  }
  if (everIn) {
    hud.setConnection('reconnecting');
    setTimeout(connect, Math.min(3000, 600 + retry++ * 500));
  } else if (isHost) {
    setTimeout(connect, 1500);
  } else if (pendingJoin) {
    hud.setJoinError(ev && ev.code === 4004
      ? 'Hittar inget rum med den koden. Kolla koden, eller vänta tills värden har öppnat spelet.'
      : ev && ev.code === 4005
        ? 'Når inte kopplingstjänsten. Kolla nätet och försök igen.'
        : 'Ingen kontakt med servern. Försök igen.');
  }
}

const ERRORS = {
  code: 'Fel kod. Kolla koden på värdens skärm.',
  full: 'Det är fullt just nu. Försök igen om en stund.',
  name: 'Skriv ett smeknamn först.',
  rate: 'För många försök. Vänta en stund och prova igen.',
  key: 'Fel värdnyckel. Öppna värdlänken från terminalen igen.',
};

function onMessage(m) {
  switch (m.t) {
    case 's': onSnapshot(m); break;
    case 'roster': onRoster(m); break;
    case 'joined':
      myId = m.id;
      everIn = true;
      retry = 0;
      setOnline(true);
      store.set(sessionStorage, 'kk_token', String(m.token || ''));
      hud.hideJoin();
      hud.setConnection('ok');
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      for (const p of roster.values()) upsert(p);
      hud.setRoster([...roster.values()], myId);
      if (ctlKey) { ctlPending = true; send({ t: 'host', key: ctlKey }); }
      break;
    case 'hosted':
      if (typeof m.code === 'string') roomCode = m.code;
      if (!isHost) {
        ctlPending = false;
        if (myId === null) break;
        if (!ctlGreeted) {
          hud.ticker(roomHost ? 'Du är värd och spelet körs i den här fliken: stäng den inte' : 'Du är värd: välj spel och starta när alla är med', 'info');
        }
        ctlGreeted = true;
        setCtl(true);
        break;
      }
      everIn = true;
      retry = 0;
      setOnline(true);
      hud.setConnection('ok');
      break;
    case 'err':
      if (ctlPending && myId !== null) {
        // The host key failed, but the player is in and keeps playing.
        ctlPending = false;
        if (m.m === 'key') { ctlKey = ''; store.del(sessionStorage, 'kk_ctl'); }
        hud.ticker(m.m === 'key' ? 'Fel värdnyckel: du spelar som vanlig spelare' : 'Värdkontrollerna gick inte att låsa upp just nu', 'warn');
        break;
      }
      if (m.m === 'code' || m.m === 'rate') store.del(sessionStorage, 'kk_token');
      if (isHost) showJoin(ERRORS[m.m] || 'Något gick fel.');
      else hud.setJoinError(ERRORS[m.m] || 'Något gick fel.');
      break;
    case 'kicked':
      kicked = true;
      myId = null;
      setCtl(false);
      pendingJoin = null;
      store.del(sessionStorage, 'kk_token');
      showJoin('Värden tog bort dig från spelet.');
      break;
    case 'round':
      pendingRound = m;
      maybeShowRound();
      break;
    case 'match':
      pendingMatch = m;
      maybeShowMatch();
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- roster

function upsert(p) {
  scene.upsertPlayer(p.id, { name: p.name, color: p.color, isMe: p.id === myId, bot: !!p.bot });
}

function onRoster(m) {
  if (!Array.isArray(m.players)) return;
  const seen = new Set();
  for (const p of m.players) {
    if (!p || typeof p.id !== 'number') continue;
    seen.add(p.id);
    const old = roster.get(p.id);
    const rec = {
      id: p.id,
      name: String(p.name ?? '').slice(0, 24),
      color: p.color | 0,
      bot: !!p.bot,
      score: p.score | 0,
      kos: p.kos | 0,
      on: p.on !== false,
      hs: p.hs | 0,        // golf: strokes on the current hole
      in: !!p.in,          // golf: ball has dropped
    };
    roster.set(p.id, rec);
    if (!old || old.name !== rec.name || old.color !== rec.color || old.bot !== rec.bot) upsert(rec);
    if (!old && rosterSeen && !rec.bot && rec.id !== myId) {
      hud.ticker(infoText('join', { name: rec.name }), 'info');
      safe(() => audio.join());
    }
  }
  for (const [id, old] of roster) {
    if (seen.has(id)) continue;
    roster.delete(id);
    scene.removePlayer(id);
    if (rosterSeen && !old.bot) hud.ticker(infoText('leave', { name: old.name }), 'info');
  }
  if (Number.isFinite(m.bots)) settings.bots = m.bots;
  if (Number.isFinite(m.rounds)) settings.rounds = m.rounds;
  if (Number.isFinite(m.game)) settings.game = m.game;
  rosterSeen = true;
  hud.setRoster([...roster.values()], myId);
}

// ---------------------------------------------------------------- snapshots

function onSnapshot(m) {
  if (!Number.isFinite(m.ts) || !Array.isArray(m.p)) return;
  m.t = m.ts;   // from here on `t` is the snapshot's server time in ms
  const off = m.t - performance.now();
  if (clockOff === null || off > clockOff) clockOff = off;
  else clockOff += (off - clockOff) * 0.01;

  const byId = new Map();
  for (const b of m.p) if (Array.isArray(b)) byId.set(b[0], b);
  m.byId = byId;
  m.fired = false;
  snaps.push(m);
  if (snaps.length > 150) snaps.splice(0, snaps.length - 150);
}

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Fill view.players / view.balls for render time rt; returns the snapshot that is "now". */
function sample(rt) {
  view.players.length = 0;
  view.balls.length = 0;
  if (!snaps.length) return null;

  let i = snaps.length - 1;
  while (i > 0 && snaps[i].t > rt) i--;
  const a = snaps[i];
  let b = snaps[i + 1];

  // Drop snapshots we are well past (their events have fired).
  let drop = 0;
  while (drop < i - 1 && snaps[drop].t < rt - 600) drop++;
  if (drop) snaps.splice(0, drop);

  // Never blend across a change of game or course.
  const g = a.g | 0;
  if (b && ((b.g | 0) !== g || (g !== GAME.KNUFF && b.ci !== a.ci))) b = undefined;

  const span = b ? b.t - a.t : 0;
  const k = b && span > 0 && span < 250 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : (b && span >= 250 ? 1 : 0);

  if (g === GAME.KLOSS) fillKloss(a, b, k);
  else if (g === GAME.GOLF) fillBalls(a, b, k);
  else fillBodies(a, b, k);
  return a;
}

// Klossgolf: a ball and the figure that runs after it. Neither slides when it is
// put somewhere else (tee, back from a hazard).
function fillKloss(a, b, k) {
  const out = view.balls;
  const snap = k < 0.5 ? 0 : 1;
  for (const pa of a.p) {
    const pb = b ? b.byId.get(pa[0]) : null;
    if (!pb) {
      out.push({ id: pa[0], x: pa[1], y: pa[2], z: pa[3], st: pa[4], strokes: pa[5] | 0, fx: pa[6], fy: pa[7] });
      continue;
    }
    const dx = pb[1] - pa[1], dy = pb[2] - pa[2];
    const gx = pb[6] - pa[6], gy = pb[7] - pa[7];
    const t = dx * dx + dy * dy > 12 ? snap : k;
    const u = gx * gx + gy * gy > 12 ? snap : k;
    const late = t >= 0.5;
    out.push({
      id: pa[0],
      x: pa[1] + dx * t,
      y: pa[2] + dy * t,
      z: pa[3] + (pb[3] - pa[3]) * t,
      st: late ? pb[4] : pa[4],
      strokes: (late ? pb[5] : pa[5]) | 0,
      fx: pa[6] + gx * u,
      fy: pa[7] + gy * u,
    });
  }
}

function fillBalls(a, b, k) {
  const out = view.balls;
  for (const pa of a.p) {
    const pb = b ? b.byId.get(pa[0]) : null;
    if (!pb) {
      out.push({ id: pa[0], x: pa[1], y: pa[2], z: pa[3], st: pa[4], strokes: pa[5] | 0 });
      continue;
    }
    const dx = pb[1] - pa[1], dy = pb[2] - pa[2];
    const jump = dx * dx + dy * dy > 4;       // put back on the green or the tee: do not slide
    const t = jump ? (k < 0.5 ? 0 : 1) : k;
    const late = t >= 0.5;
    out.push({
      id: pa[0],
      x: pa[1] + dx * t,
      y: pa[2] + dy * t,
      z: pa[3] + (pb[3] - pa[3]) * t,
      st: late ? pb[4] : pa[4],
      strokes: (late ? pb[5] : pa[5]) | 0,
    });
  }
}

function fillBodies(a, b, k) {
  const out = view.players;
  for (const pa of a.p) {
    const pb = b ? b.byId.get(pa[0]) : null;
    if (!pb) {
      out.push({ id: pa[0], x: pa[1], y: pa[2], z: pa[3], face: pa[4], st: pa[5], cd: pa[6] });
      continue;
    }
    const dx = pb[1] - pa[1], dy = pb[2] - pa[2];
    const jump = dx * dx + dy * dy > 36;      // respawn or round placement: do not slide
    const t = jump ? (k < 0.5 ? 0 : 1) : k;
    out.push({
      id: pa[0],
      x: pa[1] + dx * t,
      y: pa[2] + dy * t,
      z: pa[3] + (pb[3] - pa[3]) * t,
      face: lerpAngle(pa[4], pb[4], t),
      st: t < 0.5 ? pa[5] : pb[5],
      cd: pa[6] + (pb[6] - pa[6]) * t,
    });
  }
}

// ---------------------------------------------------------------- events

function fireEvents(rt) {
  for (const s of snaps) {
    if (s.t > rt) break;
    if (s.fired) continue;
    s.fired = true;
    if (!Array.isArray(s.e) || rt - s.t > 400) continue;   // stale (tab was hidden)
    for (const e of s.e) if (Array.isArray(e)) safe(() => onEvent(e, s));
  }
}

function onEvent(e, s) {
  if ((s.g | 0) === GAME.KLOSS) { onKlossEvent(e, s); return; }
  if ((s.g | 0) === GAME.GOLF) { onGolfEvent(e, s); return; }
  const playing = s.ph === PHASE.PLAYING;
  switch (e[0]) {
    case 'hit': {
      const [, x, y, strength, a, b] = e;
      scene.fx.hit(x, y, strength);
      const mine = a === myId || b === myId;
      audio.bump(Math.min(1, strength / 22) * (mine ? 1 : 0.7), Math.max(-1, Math.min(1, x / 14)) * 0.7);
      if (mine) scene.fx.shake(Math.min(1, strength / 24));
      break;
    }
    case 'dash':
      scene.fx.dash(e[1]);
      audio.dash(e[1] === myId);
      break;
    case 'fall': {
      const [, id, by, v] = e;
      scene.fx.fall(id);
      audio.fall(id === myId);
      if (!playing) break;
      const byName = by >= 0 && roster.has(by) ? nameOf(by) : null;
      hud.ticker(koText(nameOf(id), byName, v | 0), 'ko');
      audio.ko();
      if (isHost) scene.fx.shake(0.12);
      if (id === myId) {
        let standing = 0;
        for (const b of s.p) if (b[0] !== myId && !(b[5] & ST.FALLING)) standing++;
        hud.eliminated({ place: standing + 1, total: Math.max(roundTotal, standing + 1), byName });
        audio.lose();
        clearTimeout(outTimer);
        outTimer = setTimeout(() => { amOut = true; }, 1500);
      }
      break;
    }
    case 'parcel':
      if (playing) hud.ticker(paketText('parcel', { name: nameOf(e[1]) }, Math.floor(s.t / 1000)), 'warn');
      break;
    case 'pass': {
      const mine = e[1] === myId || e[2] === myId;
      scene.fx.pass(e[1], e[2]);
      audio.pass(mine);
      if (e[2] === myId) scene.fx.shake(0.3);
      break;
    }
    case 'pop': {
      const [, id, v] = e;
      scene.fx.pop(id);
      audio.pop(id === myId);
      if (!playing) break;
      hud.ticker(paketText('pop', { name: nameOf(id) }, v | 0), 'ko');
      if (isHost) scene.fx.shake(0.2);
      if (id === myId) {
        let standing = 0;
        for (const b of s.p) if (b[0] !== myId && !(b[5] & ST.FALLING)) standing++;
        hud.eliminated({ place: standing + 1, total: Math.max(roundTotal, standing + 1), byName: null, reason: 'pop' });
        audio.lose();
        clearTimeout(outTimer);
        outTimer = setTimeout(() => { amOut = true; }, 1500);
      }
      break;
    }
    case 'ring':
      audio.ringFall();
      scene.fx.shake(0.25);
      if (playing && e[1] >= 0) hud.ticker(infoText(e[1] === 0 ? 'sudden' : 'ringFall'), 'warn');
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- phases

function maybeShowRound() {
  if (cur.ph !== PHASE.ROUND_END || !pendingRound) return;
  const m = pendingRound;
  pendingRound = null;
  const order = Array.isArray(m.order) ? m.order : [];
  const pts = m.pts && typeof m.pts === 'object' ? m.pts : {};
  const hasWinner = typeof m.winner === 'number' && m.winner >= 0;
  if (!knuffLike(m.g | 0)) {
    const kl = (m.g | 0) === GAME.KLOSS;
    const c = kl ? kcourseOf(m.ci) : courseOf(m.ci);
    hud.holeEnd({
      hole: m.rd | 0,
      holes: cur.rn,
      name: c.name,
      par: c.par,
      top: order.slice(0, 3).map((id) => ({ name: nameOf(id), color: roster.get(id)?.color ?? 0, strokes: pts[id] | 0 })),
    });
    if (hasWinner) hud.ticker((kl ? klossText : golfText)('holeWin', { name: nameOf(m.winner), strokes: pts[m.winner] | 0 }, m.rd | 0), 'win');
    safe(() => audio.win());
    return;
  }
  hud.roundEnd({
    round: m.rd | 0,
    rounds: settings.rounds,
    winnerName: hasWinner ? nameOf(m.winner) : 'Ingen',
    youWon: hasWinner && m.winner === myId,
    top: order.slice(0, 3).map((id) => ({ name: nameOf(id), color: roster.get(id)?.color ?? 0, pts: pts[id] | 0 })),
  });
  if (hasWinner) {
    hud.ticker(infoText('roundWin', { name: nameOf(m.winner), round: m.rd | 0 }), 'win');
    const body = view.players.find((p) => p.id === m.winner);
    scene.fx.confetti(body ? body.x : 0, body ? body.y : 0);
  }
  safe(() => audio.win());
}

function maybeShowMatch() {
  if (cur.ph !== PHASE.MATCH_END || !pendingMatch) return;
  const m = pendingMatch;
  pendingMatch = null;
  if (!Array.isArray(m.standings)) return;
  hud.matchEnd({ standings: m.standings, myId, game: m.g | 0 });
  if (knuffLike(m.g | 0)) {
    scene.fx.confetti(0, 0);
    setTimeout(() => scene.fx.confetti(2, -1), 350);
    setTimeout(() => scene.fx.confetti(-2, 1), 700);
  }
  safe(() => audio.win());
}

const roundMusic = () => (curGame === GAME.PAKET ? 'paket' : 'game');

function onPhase(ph, s, prev) {
  lastCount = -1;
  lastWarnK = -1;
  warnAnnounced = false;
  switch (ph) {
    case PHASE.LOBBY:
      hud.clearOverlays();
      clearTimeout(outTimer);
      amOut = false;
      setMusic('lobby');
      if (prev !== -1) hud.ticker(curGame === GAME.PAKET ? paketText('lobby', {}) : infoText('lobby'), 'info');
      break;
    case PHASE.COUNTDOWN:
      hud.clearOverlays();
      clearTimeout(outTimer);
      amOut = false;
      roundTotal = s.p.length;
      setMusic(roundMusic());
      if (s.rd === 1) hud.ticker(curGame === GAME.PAKET ? paketText('matchStart', {}, 0) : infoText('matchStart'), 'info');
      break;
    case PHASE.PLAYING:
      roundTotal = Math.max(roundTotal, s.p.length);
      setMusic(roundMusic());
      if (prev === PHASE.COUNTDOWN) {
        hud.countdown(0);
        safe(() => audio.countdown(0));
      }
      break;
    case PHASE.ROUND_END:
      maybeShowRound();
      break;
    case PHASE.MATCH_END:
      hud.clearOverlays();
      clearTimeout(outTimer);
      amOut = false;
      setMusic('lobby');
      maybeShowMatch();
      break;
    default: break;
  }
}

function applyMeta(s) {
  const g = s.g === GAME.GOLF || s.g === GAME.KLOSS || s.g === GAME.PAKET ? s.g : GAME.KNUFF;
  if (g !== curGame) switchGame(g);
  cur.rn = s.rn | 0;
  if (g === GAME.KLOSS) applyKloss(s);
  else if (g === GAME.GOLF) applyGolf(s);
  else applyKnuff(s);
}

function applyKnuff(s) {
  if (s.r0 !== arena.r0 || s.rg > arena.rg) {
    scene.setArena(s.r0);
    arena.r0 = s.r0;
  }
  arena.rg = s.rg;

  if (s.ph !== cur.ph || s.rd !== cur.rd) {
    const prev = cur.ph;
    cur.ph = s.ph;
    cur.rd = s.rd;
    safe(() => onPhase(s.ph, s, prev));
  }

  if (s.ph === PHASE.COUNTDOWN) {
    const n = Math.max(1, Math.min(3, Math.ceil(s.pt - 0.5)));
    if (n !== lastCount) {
      lastCount = n;
      hud.countdown(n);
      safe(() => audio.countdown(n));
    }
  }

  if (s.ph === PHASE.PLAYING && s.wf >= 0 && s.wf <= SIM.WARN_T) {
    const k = Math.ceil(s.wf);
    if (k !== lastWarnK) {
      lastWarnK = k;
      safe(() => audio.ringWarn());
      if (!warnAnnounced) {
        warnAnnounced = true;
        if (s.rg > 0) hud.ticker(infoText('ringWarn'), 'warn');
      }
    }
  } else {
    lastWarnK = -1;
    warnAnnounced = false;
  }

  let standing = 0;
  let me = null;
  for (const p of view.players) {
    if (!(p.st & ST.FALLING)) standing++;
    if (p.id === myId) me = p;
  }
  if (s.ph === PHASE.PLAYING) roundTotal = Math.max(roundTotal, view.players.length);

  const inRound = s.ph === PHASE.COUNTDOWN || s.ph === PHASE.PLAYING || s.ph === PHASE.ROUND_END;
  view.phase = s.ph;
  view.rings = s.rg;
  view.warnIn = s.ph === PHASE.PLAYING ? s.wf : -1;
  view.myId = myId;
  view.spectate = isHost || myId === null || (inRound && (amOut || !me));

  hud.setStatus({
    phase: s.ph,
    round: s.rd,
    rounds: s.rn,
    alive: standing,
    total: inRound ? roundTotal : view.players.length,
    warnIn: view.warnIn,
    sudden: s.ph === PHASE.PLAYING && s.rg === 0,
  });
  hud.setDash(me ? me.cd : 0);

  if (curGame !== GAME.PAKET) { view.carrier = -1; view.fuse = 0; return; }
  const ca = typeof s.ca === 'number' ? s.ca : -1;
  const fu = ca >= 0 ? Math.min(1, Math.max(0, +s.fu || 0)) : 0;
  view.carrier = ca;
  view.fuse = fu;
  // The clock ticks faster the closer it is to going off: once a second down to five times.
  if (s.ph === PHASE.PLAYING && ca >= 0) {
    const now = performance.now();
    if (now - paket.lastTick >= 1000 - 800 * fu * fu) {
      paket.lastTick = now;
      safe(() => audio.tick(fu));
    }
  }
  hud.setPaket({ phase: s.ph, carrierName: ca >= 0 && roster.has(ca) ? nameOf(ca) : null, mine: ca >= 0 && ca === myId, fuse: fu, alive: standing });
}

// ---------------------------------------------------------------- minigolf

const PULL_FULL = 6;               // metres of drag across the green for full power
const golf = { ci: -1, canShoot: false, lastOob: 0, lastClock: -1 };
let aimDrag = null;                // { id, x0, y0, x1, y1 } in client pixels while dragging
let touchEls = null;               // Knuffkampen's touch controls, hidden while golfing

const courseOf = (ci) => COURSES[ci] || COURSES[0];

function switchGame(g) {
  curGame = g;
  view.game = g;
  view.aim = null;
  aimDrag = null;
  cur.ph = -1;
  cur.rd = -1;
  golf.ci = -1;
  kloss.ci = -1;
  kloss.charge = -1;
  aimTurn = null;
  arena.rg = -2;                   // rebuild the arena when Knuffkampen comes back
  hud.clearOverlays();
  safe(() => scene.setGame(g));
  hud.setGame(g);
  if (touchEls) for (const el of touchEls) el.style.display = knuffLike(g) ? '' : 'none';
}

/** The aim the current drag describes: unit shot direction and power 0..1, or null. */
function currentAim() {
  if (!aimDrag) return null;
  const g0 = scene.groundPoint(aimDrag.x0, aimDrag.y0);
  const g1 = scene.groundPoint(aimDrag.x1, aimDrag.y1);
  if (!g0 || !g1) return null;
  const px = g1.x - g0.x, py = g1.y - g0.y;
  const len = Math.hypot(px, py);
  const power = Math.min(1, len / PULL_FULL);
  if (power < 0.05) return null;   // too short a pull: nothing happens on release
  return { x: -px / len, y: -py / len, power };
}

function onGolfPhase(s, prev, course) {
  golf.lastClock = -1;
  switch (s.ph) {
    case PHASE.LOBBY:
      hud.clearOverlays();
      setMusic('golf');
      if (prev !== -1) hud.ticker(golfText('practice', {}, 0), 'info');
      break;
    case PHASE.COUNTDOWN:
      hud.clearOverlays();
      setMusic('golf');
      hud.holeIntro({ hole: s.rd, holes: s.rn, name: course.name, par: course.par });
      if (s.rd === 1) hud.ticker(golfText('matchStart', {}, 0), 'info');
      hud.ticker(golfText('intro', { hole: s.rd, name: course.name, par: course.par }, s.rd | 0), 'info');
      safe(() => audio.countdown(1));
      break;
    case PHASE.PLAYING:
      setMusic('golf');
      if (prev === PHASE.COUNTDOWN) safe(() => audio.countdown(0));
      break;
    case PHASE.ROUND_END:
      maybeShowRound();
      break;
    case PHASE.MATCH_END:
      hud.clearOverlays();
      setMusic('golf');
      maybeShowMatch();
      break;
    default: break;
  }
}

function applyGolf(s) {
  const course = courseOf(s.ci);
  if (s.ci !== golf.ci) {
    golf.ci = s.ci;
    safe(() => scene.setCourse(s.ci));
  }

  if (s.ph !== cur.ph || s.rd !== cur.rd) {
    const prev = cur.ph;
    cur.ph = s.ph;
    cur.rd = s.rd;
    safe(() => onGolfPhase(s, prev, course));
  }

  let me = null;
  for (const b of view.balls) if (b.id === myId) me = b;
  const practice = s.ph === PHASE.LOBBY || s.ph === PHASE.MATCH_END;
  const strokes = me ? me.strokes : 0;
  const holed = !!me && !!(me.st & BALL.HOLED);
  golf.canShoot = !!me && !(me.st & (BALL.MOVING | BALL.HOLED | BALL.FALLING))
    && (practice || (s.ph === PHASE.PLAYING && strokes < GOLF.MAX_STROKES));

  const aim = me && !holed ? currentAim() : null;

  if (s.ph === PHASE.PLAYING && s.tl >= 0 && s.tl <= 5) {
    const k = Math.ceil(s.tl);
    if (k !== golf.lastClock) {
      golf.lastClock = k;
      safe(() => audio.ringWarn());
    }
  } else {
    golf.lastClock = -1;
  }

  view.phase = s.ph;
  view.course = s.ci;
  view.holeTime = s.ht;
  view.myId = myId;
  view.spectate = isHost;
  view.aim = aim;

  hud.setGolf({
    phase: s.ph,
    hole: s.rd,
    holes: s.rn,
    name: course.name,
    par: course.par,
    timeLeft: s.ph === PHASE.PLAYING ? s.tl : -1,
    strokes,
    holed,
    canShoot: golf.canShoot,
  });
  hud.setAim(aim ? aim.power : null);
}

function onGolfEvent(e, s) {
  const playing = s.ph === PHASE.PLAYING;
  switch (e[0]) {
    case 'shot':
      scene.fx.putt(e[1], e[2]);
      if (e[1] !== myId) audio.putt(e[2], false);    // our own putt already sounded on release
      break;
    case 'bounce':
      scene.fx.bounce(e[1], e[2], e[3], e[4]);
      audio.knock(Math.min(1, e[3] / 12), e[4], Math.max(-1, Math.min(1, e[1] / 14)) * 0.6);
      break;
    case 'boost':
      scene.fx.boost(e[1]);
      audio.boost();
      break;
    case 'holed': {
      const [, id, strokes, v] = e;
      scene.fx.holed(id, strokes);
      audio.cup(id === myId);
      if (!playing) break;
      const par = courseOf(s.ci).par;
      if (strokes === 1) audio.holeInOne();
      hud.ticker(golfText('holed', { name: nameOf(id), strokes, par }, v | 0), strokes === 1 ? 'win' : 'info');
      if (id === myId) hud.holed({ strokes, par });
      break;
    }
    case 'oob':
      scene.fx.oob(e[1]);
      audio.oob(e[1] === myId);
      if (playing && s.t - golf.lastOob > 3000) {     // at most one of these lines every few seconds
        golf.lastOob = s.t;
        hud.ticker(golfText('oob', { name: nameOf(e[1]) }, Math.floor(s.t / 1000)), 'ko');
      }
      break;
    default: break;
  }
}

// Aim by dragging anywhere on the picture, slingshot style: pull back, release.
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  if (curGame !== GAME.GOLF || isHost || myId === null || e.button !== 0) return;
  aimDrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not supported: dragging still works inside the canvas */ }
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (!aimDrag || e.pointerId !== aimDrag.id) return;
  aimDrag.x1 = e.clientX;
  aimDrag.y1 = e.clientY;
});
function endAim(e, fire) {
  if (!aimDrag || e.pointerId !== aimDrag.id) return;
  if (fire) { aimDrag.x1 = e.clientX; aimDrag.y1 = e.clientY; }
  const aim = fire ? currentAim() : null;
  aimDrag = null;
  view.aim = null;
  if (!aim || !golf.canShoot) return;
  const speed = GOLF.MIN_POWER + (GOLF.MAX_POWER - GOLF.MIN_POWER) * aim.power;
  send({ t: 'shot', x: Math.round(aim.x * speed * 100) / 100, y: Math.round(aim.y * speed * 100) / 100 });
  safe(() => audio.putt(aim.power, true));
}
canvas.addEventListener('pointerup', (e) => endAim(e, true));
canvas.addEventListener('pointercancel', (e) => endAim(e, false));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && aimDrag) { aimDrag = null; view.aim = null; }
});

// ---------------------------------------------------------------- Klossgolf

const TURN_PX = 0.004;             // radians of aim per pixel dragged
const PUTT_FULL = CLUBS[PUTTER].speed ** 2 / (2 * SURFACE[SURF.GREEN].roll);   // metres a full putt rolls on the green
const kloss = {
  ci: -1,
  heading: 0,        // where the local player aims, radians in the sim plane
  club: 0,
  ready: false,      // the server says we may swing
  charge: -1,        // performance.now() when the swing button went down, or -1
  hold: 0,           // no new swing before this time: our last one is on its way to the server
  spot: '',          // the resting place the caddie last looked at
  target: null,      // [x, y] the caddie aims for
  mark: null,        // meter position that reaches the caddie's target, or null
  scale: 1,          // share of the club a full meter stands for (less than 1 only when putting)
  markKey: '',
  aim: null,
  aimKey: '',
  turnT: 0,
  lastLine: 0,
  lastClock: -1,
};
let aimTurn = null;                // { id, x } while a pointer drags the aim

const kcourseOf = (ci) => KCOURSES[ci] || KCOURSES[0];

/** The swing meter: up to 100 % in CHARGE_T seconds, back down, and up again. */
function meterPower(now) {
  const m = ((now - kloss.charge) / 1000 / KG.CHARGE_T) % 2;
  return m <= 1 ? m : 2 - m;
}

function swingDown() {
  if (curGame !== GAME.KLOSS || myId === null || !kloss.ready || kloss.charge >= 0) return;
  unlockAudio();
  kloss.charge = performance.now();
}

function swingUp() {
  if (kloss.charge < 0) return;
  const now = performance.now();
  const p = meterPower(now);
  kloss.charge = -1;
  if (curGame !== GAME.KLOSS || !kloss.ready || p < 0.05) return;   // a slip of the finger is not a stroke
  const power = Math.max(KG.MIN_POWER, p * kloss.scale);
  send({ t: 'swing', a: Math.round(kloss.heading * 1e4) / 1e4, p: Math.round(power * 1000) / 1000, c: kloss.club });
  safe(() => audio.swing(kloss.club, power, true));
  kloss.ready = false;
  kloss.hold = now + 500;
}

function nudgeClub(delta) {
  if (curGame !== GAME.KLOSS || myId === null) return;
  kloss.club = Math.max(0, Math.min(3, kloss.club + delta));
}

/** Keyboard aim: slow at first for fine work, faster the longer the key is held. */
function turnAim(dt) {
  if (curGame !== GAME.KLOSS || myId === null) return;
  const dir = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
  if (!dir) { kloss.turnT = 0; return; }
  kloss.turnT += dt;
  kloss.heading += dir * Math.min(1.3, 0.2 + kloss.turnT * 1.6) * dt;
}

/** Point `heading` at an angle without spinning the long way round. */
function faceTowards(angle) {
  let d = (angle - kloss.heading) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  kloss.heading += d;
}

function onKlossPhase(s, prev, course) {
  kloss.lastClock = -1;
  switch (s.ph) {
    case PHASE.LOBBY:
      hud.clearOverlays();
      setMusic('kloss');
      if (prev !== -1) hud.ticker(klossText('practice', {}, 0), 'info');
      break;
    case PHASE.COUNTDOWN:
      hud.clearOverlays();
      setMusic('kloss');
      kloss.spot = '';
      faceTowards(course.tee.a);
      hud.holeIntro({ hole: s.rd, holes: s.rn, name: course.name, par: course.par });
      if (s.rd === 1) hud.ticker(klossText('matchStart', {}, 0), 'info');
      hud.ticker(klossText('intro', { hole: s.rd, name: course.name, par: course.par }, s.rd | 0), 'info');
      safe(() => audio.countdown(1));
      break;
    case PHASE.PLAYING:
      setMusic('kloss');
      if (prev === PHASE.COUNTDOWN) safe(() => audio.countdown(0));
      break;
    case PHASE.ROUND_END:
      maybeShowRound();
      break;
    case PHASE.MATCH_END:
      hud.clearOverlays();
      setMusic('kloss');
      maybeShowMatch();
      break;
    default: break;
  }
}

function applyKloss(s) {
  const course = kcourseOf(s.ci);
  if (s.ci !== kloss.ci) {
    kloss.ci = s.ci;
    kloss.spot = '';
    faceTowards(course.tee.a);
    safe(() => scene.setCourse(s.ci));
  }

  if (s.ph !== cur.ph || s.rd !== cur.rd) {
    const prev = cur.ph;
    cur.ph = s.ph;
    cur.rd = s.rd;
    safe(() => onKlossPhase(s, prev, course));
  }

  const now = performance.now();
  let me = null;
  for (const b of view.balls) if (b.id === myId) me = b;
  const practice = s.ph === PHASE.LOBBY || s.ph === PHASE.MATCH_END;
  const strokes = me ? me.strokes : 0;
  const holed = !!me && !!(me.st & KST.HOLED);
  const ready = !!me && !!(me.st & KST.READY) && now >= kloss.hold;
  kloss.ready = ready;
  if (!ready) kloss.charge = -1;

  let aim = null;
  let power = null;
  if (ready) {
    // A new resting place: the caddie picks a direction and a club.
    const spot = s.ci + ':' + Math.round(me.x * 10) + ':' + Math.round(me.y * 10);
    if (spot !== kloss.spot) {
      kloss.spot = spot;
      const t = aimPoint(course, me.x, me.y);
      kloss.target = t;
      faceTowards(Math.atan2(t[1] - me.y, t[0] - me.x));
      kloss.club = suggestClub(course, me.x, me.y, Math.hypot(t[0] - me.x, t[1] - me.y));
    }
    const t = kloss.target;
    const markKey = spot + '|' + kloss.club;
    if (markKey !== kloss.markKey) {
      kloss.markKey = markKey;
      // A full meter with the putter is a putt comfortably past the cup, not the
      // putter's whole 28 metres: short putts would be impossible to dose otherwise.
      const pin = Math.hypot(course.cup[0] - me.x, course.cup[1] - me.y);
      kloss.scale = kloss.club === PUTTER ? Math.min(1, Math.max(0.12, (pin * 1.6 + 2) / PUTT_FULL)) : 1;
      const best = bestPower(course, me.x, me.y, Math.atan2(t[1] - me.y, t[0] - me.x), kloss.club, t[0], t[1]);
      kloss.mark = best.miss < 500 ? Math.min(1, best.p / kloss.scale) : null;
    }

    const charging = kloss.charge >= 0;
    if (charging) power = meterPower(now);
    const p = Math.max(KG.MIN_POWER, (charging ? power : 1) * kloss.scale);
    const aimKey = markKey + '|' + kloss.heading.toFixed(4) + '|' + p.toFixed(3);
    if (aimKey !== kloss.aimKey || !kloss.aim) {
      kloss.aimKey = aimKey;
      const path = [];
      const r = predict(course, me.x, me.y, kloss.heading, kloss.club, p, { path });
      kloss.aim = { angle: kloss.heading, club: kloss.club, power: p, charging, path, land: r.land, rest: r.rest, end: r.end };
    }
    kloss.aim.charging = charging;
    aim = kloss.aim;
  }

  if (s.ph === PHASE.PLAYING && s.tl >= 0 && s.tl <= 5) {
    const k = Math.ceil(s.tl);
    if (k !== kloss.lastClock) {
      kloss.lastClock = k;
      safe(() => audio.ringWarn());
    }
  } else {
    kloss.lastClock = -1;
  }

  const w = Array.isArray(s.w) ? s.w : view.wind;
  const ch = Math.cos(kloss.heading), sh = Math.sin(kloss.heading);

  view.phase = s.ph;
  view.course = s.ci;
  view.wind = w;
  view.intro = s.ph === PHASE.COUNTDOWN ? s.pt : 0;
  view.myId = myId;
  view.spectate = isHost || !me;
  view.heading = kloss.heading;
  view.aim = aim;

  hud.setKloss({
    phase: s.ph,
    hole: s.rd,
    holes: s.rn,
    name: course.name,
    par: course.par,
    timeLeft: s.ph === PHASE.PLAYING ? s.tl : -1,
    strokes,
    maxStrokes: practice ? 0 : maxStrokes(course),
    holed,
    ready,
    club: me ? kloss.club : -1,
    lie: me ? surfaceAt(course, me.x, me.y) : SURF.TEE,
    pin: me ? Math.hypot(course.cup[0] - me.x, course.cup[1] - me.y) : 0,
    wind: Math.hypot(w[0], w[1]),
    windDir: Math.atan2(w[1] * ch - w[0] * sh, w[0] * ch + w[1] * sh),
    power,
    mark: ready ? kloss.mark : null,
  });
}

function onKlossEvent(e, s) {
  const playing = s.ph === PHASE.PLAYING;
  const mine = e[1] === myId;
  // One ticker line about mishaps every few seconds is plenty.
  const mishap = (kind) => {
    if (!playing || s.t - kloss.lastLine < 3000) return;
    kloss.lastLine = s.t;
    hud.ticker(klossText(kind, { name: nameOf(e[1]) }, Math.floor(s.t / 1000)), 'ko');
  };
  switch (e[0]) {
    case 'shot':
      scene.fx.swing(e[1], e[2], e[3], e[4]);
      if (!mine) audio.swing(e[2], e[3], false);      // our own swing already sounded on release
      break;
    case 'land':
      scene.fx.land(e[1], e[2], e[3], e[4], e[5]);
      audio.land(e[4], Math.min(1, e[5] / 18) * (mine ? 1 : 0.6), 0);
      if (e[4] === SURF.SAND && e[5] > 6) mishap('sand');
      break;
    case 'tree':
      scene.fx.tree(e[2], e[3], e[4]);
      audio.tree();
      break;
    case 'splash':
      scene.fx.splash(e[1], e[2], e[3]);
      audio.splash(mine);
      mishap('water');
      break;
    case 'oob':
      scene.fx.oob(e[1]);
      audio.oob(mine);
      mishap('oob');
      break;
    case 'holed': {
      const [, id, strokes, v, dunk] = e;
      scene.fx.holed(id, strokes);
      audio.cup(mine);
      if (!playing) break;
      const par = kcourseOf(s.ci).par;
      if (strokes === 1) audio.holeInOne();
      hud.ticker(klossText('holed', { name: nameOf(id), strokes, par, dunk: !!dunk }, v | 0), strokes <= par - 1 ? 'win' : 'info');
      if (mine) hud.holed({ strokes, par });
      break;
    }
    default: break;
  }
}

// Drag sideways anywhere on the picture to turn the aim.
canvas.addEventListener('pointerdown', (e) => {
  if (curGame !== GAME.KLOSS || isHost || myId === null || e.button !== 0) return;
  aimTurn = { id: e.pointerId, x: e.clientX };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not supported: dragging still works inside the canvas */ }
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (!aimTurn || e.pointerId !== aimTurn.id) return;
  kloss.heading += (e.clientX - aimTurn.x) * TURN_PX;
  aimTurn.x = e.clientX;
});
const endTurn = (e) => { if (aimTurn && e.pointerId === aimTurn.id) aimTurn = null; };
canvas.addEventListener('pointerup', endTurn);
canvas.addEventListener('pointercancel', endTurn);

// ---------------------------------------------------------------- input

const keys = new Set();
const KEYMAP = {
  KeyW: 'u', ArrowUp: 'u',
  KeyS: 'd', ArrowDown: 'd',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};
const input = { x: 0, y: 0 };
const touch = { active: false, x: 0, y: 0 };
const debug = { override: null };
let dashPending = false;
let lastSent = { x: 0, y: 0, at: 0 };

function typing(e) {
  const el = e.target;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const dir = KEYMAP[e.code];
  if (dir) {
    keys.add(dir);
    if (myId !== null) e.preventDefault();
    if (curGame === GAME.KLOSS && !e.repeat && (dir === 'u' || dir === 'd')) nudgeClub(dir === 'u' ? -1 : 1);
  } else if (e.code === 'Space') {
    if (myId !== null) {
      e.preventDefault();
      if (!e.repeat) {
        dashPending = true;
        swingDown();
      }
    }
  } else if (e.code === 'Escape') {
    kloss.charge = -1;
  }
});
window.addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.code];
  if (dir) keys.delete(dir);
  else if (e.code === 'Space') swingUp();
});
window.addEventListener('blur', () => { keys.clear(); kloss.charge = -1; });
document.addEventListener('visibilitychange', () => {
  applyMusic();
  if (document.hidden) {
    keys.clear();
    kloss.charge = -1;
  } else {
    // Back from another tab: what queued up while hidden is stale. Start clean.
    snaps.length = 0;
    clockOff = null;
  }
});

function readInput() {
  let x = 0, y = 0;
  if (debug.override) {
    x = debug.override.x; y = debug.override.y;
  } else if (touch.active) {
    x = touch.x; y = touch.y;
  } else {
    if (keys.has('l')) x -= 1;
    if (keys.has('r')) x += 1;
    if (keys.has('u')) y -= 1;
    if (keys.has('d')) y += 1;
  }
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  input.x = x;
  input.y = y;
  view.input.x = x;
  view.input.y = y;
}

function sendInput(now) {
  if (myId === null || !knuffLike(curGame)) { dashPending = false; return; }
  if (now - lastSent.at < INPUT_MS) return;
  const x = Math.round(input.x * 100) / 100;
  const y = Math.round(input.y * 100) / 100;
  const changed = x !== lastSent.x || y !== lastSent.y;
  if (!changed && !dashPending && now - lastSent.at < KEEPALIVE_MS) return;
  send({ t: 'in', x, y, d: dashPending ? 1 : 0 });
  dashPending = false;
  lastSent = { x, y, at: now };
}

// Touch: a joystick in the bottom-left corner and a dash button bottom-right.
function setupTouch() {
  const stick = document.createElement('div');
  const knob = document.createElement('div');
  const btn = document.createElement('div');
  const base = 'position:fixed;z-index:30;touch-action:none;user-select:none;-webkit-user-select:none;border-radius:50%;';
  stick.style.cssText = base + 'left:max(18px,env(safe-area-inset-left));bottom:max(18px,env(safe-area-inset-bottom));width:124px;height:124px;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.45);';
  knob.style.cssText = 'position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;background:rgba(255,255,255,.75);';
  btn.style.cssText = base + 'right:max(18px,env(safe-area-inset-right));bottom:max(24px,env(safe-area-inset-bottom));width:104px;height:104px;background:rgba(255,205,60,.85);border:2px solid rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;font:800 17px system-ui,sans-serif;letter-spacing:.06em;color:#1b1b1b;';
  btn.textContent = 'KNUFF';
  stick.appendChild(knob);
  document.body.append(stick, btn);
  touchEls = [stick, btn];
  if (!knuffLike(curGame)) for (const el of touchEls) el.style.display = 'none';

  let stickId = null;
  const move = (t) => {
    const r = stick.getBoundingClientRect();
    let dx = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    touch.x = dx;
    touch.y = dy;
    knob.style.transform = `translate(${dx * 35}px, ${dy * 35}px)`;
  };
  const end = () => {
    stickId = null;
    touch.active = false;
    touch.x = 0; touch.y = 0;
    knob.style.transform = '';
  };
  stick.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    stickId = t.identifier;
    touch.active = true;
    move(t);
  }, { passive: false });
  stick.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === stickId) move(t);
  }, { passive: false });
  const onEnd = (e) => {
    for (const t of e.changedTouches) if (t.identifier === stickId) end();
  };
  stick.addEventListener('touchend', onEnd);
  stick.addEventListener('touchcancel', onEnd);
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    dashPending = true;
    unlockAudio();
  }, { passive: false });
}
if (!isHost && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)) {
  window.addEventListener('touchstart', setupTouch, { once: true, passive: true });
}

// ---------------------------------------------------------------- join

function showJoin(error) {
  hud.showJoin({
    name: store.get(localStorage, 'kk_name') || '',
    code: roomCode,
    onSubmit(name, code) {
      unlockAudio();
      const clean = String(name || '').trim();
      const c = String(code || '').trim().toUpperCase();
      if (!clean) { hud.setJoinError(ERRORS.name); return; }
      if (!c) { hud.setJoinError('Skriv in koden från värdens skärm.'); return; }
      kicked = false;
      roomCode = c;
      pendingJoin = { name: clean, code: c };
      store.set(localStorage, 'kk_name', clean);
      if (ws && ws.readyState === WebSocket.OPEN) sendJoin();
      else connect();
    },
  });
  if (error) hud.setJoinError(error);
}

// The Pages site is Heta paketet: show its arena behind the join card too.
if (P2P) switchGame(GAME.PAKET);

if (roomHost) {
  // Open the room at once, so the others can get in while the host types a name.
  if (roomCode) ensureRoom(roomCode).catch(roomFailed);
  window.addEventListener('beforeunload', (e) => {
    if (room && room.remoteCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}

if (isHost) {
  connect();
} else {
  showJoin(null);
  // A reload in the same tab gets back into the game without retyping.
  const savedName = store.get(localStorage, 'kk_name');
  if (store.get(sessionStorage, 'kk_token') && savedName && roomCode) {
    pendingJoin = { name: savedName, code: roomCode };
    connect();
  }
}

// ---------------------------------------------------------------- loop

let lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  readInput();
  sendInput(now);
  turnAim(dt);

  if (clockOff !== null) {
    const rt = now + clockOff - INTERP_MS;
    const s = sample(rt);
    if (s) {
      fireEvents(rt);
      safe(() => applyMeta(s));
    }
  }

  if (isHost || amCtl) {
    let humans = 0;
    for (const p of roster.values()) if (!p.bot) humans++;
    hud.setHostPanel({
      phase: view.phase,
      url: location.host,
      code: roomCode,
      humans,
      bots: settings.bots,
      rounds: settings.rounds,
      game: settings.game,
    });
  }

  view.time = now / 1000;
  scene.frame(dt, view);
}

window.addEventListener('resize', () => scene.resize());
requestAnimationFrame(frame);

// Small handle for testing from the console.
window.__kk = {
  hud,
  scene,
  view,
  roster,
  debug,
  dash() { dashPending = true; },
  kloss,
  swing(p, a = kloss.heading, c = kloss.club) { send({ t: 'swing', a, p, c }); },
  stats: () => scene.getStats(),
};
