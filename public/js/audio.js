// Knuffkampen sound: everything is synthesised with the Web Audio API.
// Character: soft, round, friendly arcade. Modest level, limiter on the master bus.
//
// Level plan (linear, full scale = 1.0):
//   single sound effect peaks at about 0.15..0.35 before the master gain (0.7)
//   -> roughly -13 .. -7 dBFS; a pile-up is held by the compressor, expected
//   worst case about -3 dBFS. Music sits at about 0.05..0.08 (-24 dBFS).

const MASTER_GAIN = 0.7;
const MAX_VOICES = 36; // simultaneous sfx voices (oscillators + noise sources)
const MAX_BUMPS = 5; // simultaneous bump voices
const BUMP_GAP = 0.012; // seconds: bumps closer than this are dropped
const MAX_KNOCKS = 4; // simultaneous golf knock voices
const KNOCK_GAP = 0.03; // seconds: knocks closer than this are dropped
const MAX_LANDS = 4; // simultaneous Klossgolf touchdown voices
const LAND_GAP = 0.03; // seconds: touchdowns closer than this are dropped
const TICK_GAP = 0.04; // seconds: parcel ticks closer than this are dropped
const SWING_GAP = 0.04; // seconds: other players' swings closer than this are dropped
const LOOKAHEAD = 0.6;
const TICK_MS = 150;

let ctx = null;
let master = null;
let sfxBus = null;
let noiseBuf = null;
let muted = false;
let wantMode = 'off'; // what the caller asked for
let tracks = []; // running music tracks
let timer = null;
let voices = 0;
let bumpLive = 0;
let lastBump = -1;
let knockLive = 0;
let lastKnock = -1;
let landLive = 0;
let lastLand = -1;
let lastSwing = -1;
let lastTick = -1;
let tickFlip = false;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function ready() {
  return !!ctx && !muted && ctx.state === 'running';
}

function makePan(pan) {
  if (!pan || !ctx.createStereoPanner) return null;
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  return p;
}

// Shared clean envelope: short linear attack, exponential decay, hard zero at the end.
function envelope(g, t0, dur, peak, attack) {
  const a = Math.min(attack, dur * 0.5);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.gain.setValueAtTime(0, t0 + dur + 0.005);
}

// Tone: pts = [[offsetSeconds, Hz], ...] pitch path (exponential between points).
// o: { type, pts, t, dur, gain, attack, pan, dest, free (skip voice limit), onend }
function tone(o) {
  if (!o.free && voices >= MAX_VOICES) return;
  const t0 = o.t;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type || 'sine';
  const pts = o.pts;
  osc.frequency.setValueAtTime(pts[0][1], t0);
  for (let i = 1; i < pts.length; i++) {
    osc.frequency.exponentialRampToValueAtTime(pts[i][1], t0 + pts[i][0]);
  }
  envelope(g, t0, o.dur, o.gain, o.attack || 0.005);
  osc.connect(g);
  let tail = g;
  const p = makePan(o.pan);
  if (p) {
    g.connect(p);
    tail = p;
  }
  tail.connect(o.dest || sfxBus);
  if (!o.free) voices++;
  osc.onended = () => {
    if (!o.free) voices--;
    try {
      osc.disconnect();
      g.disconnect();
      if (p) p.disconnect();
    } catch (e) {}
    if (o.onend) o.onend();
  };
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.03);
}

// Filtered noise burst. f = [startHz, endHz], kind = biquad type.
function noise(o) {
  if (!o.free && voices >= MAX_VOICES) return;
  const t0 = o.t;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = o.kind || 'bandpass';
  f.Q.value = o.q || 0.8;
  f.frequency.setValueAtTime(o.f[0], t0);
  if (o.f[1] !== o.f[0]) f.frequency.exponentialRampToValueAtTime(o.f[1], t0 + o.dur);
  const g = ctx.createGain();
  envelope(g, t0, o.dur, o.gain, o.attack || 0.004);
  src.connect(f);
  f.connect(g);
  let tail = g;
  const p = makePan(o.pan);
  if (p) {
    g.connect(p);
    tail = p;
  }
  tail.connect(o.dest || sfxBus);
  if (!o.free) voices++;
  src.onended = () => {
    if (!o.free) voices--;
    try {
      src.disconnect();
      f.disconnect();
      g.disconnect();
      if (p) p.disconnect();
    } catch (e) {}
  };
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + o.dur + 0.03);
}

function build() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_GAIN;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 10;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 1;
  sfxBus.connect(master);
  master.connect(comp);
  comp.connect(ctx.destination);
  // One second of white noise, shared by every noise voice.
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return true;
}

/* ------------------------------------------------------------------ music */

// Chord = [rootMidi, minor?]
const LOBBY = {
  bpm: 84,
  chords: [[48, 0], [45, 1], [41, 0], [43, 0]],
  step(t, dur, i, dest) {
    const ci = Math.floor(i / 8) % 4;
    const s = i % 8;
    const [root, minor] = this.chords[ci];
    const tones = [0, minor ? 3 : 4, 7, 12];
    const arp = [0, 1, 2, 3, 2, 1, 2, 1][s];
    tone({ type: 'sine', pts: [[0, mtof(root + 12 + tones[arp])]], t, dur: dur * 1.7, gain: 0.05, attack: 0.02, dest, free: true });
    if (s === 0 || s === 4) {
      tone({ type: 'sine', pts: [[0, mtof(root)]], t, dur: dur * 3, gain: 0.08, attack: 0.02, dest, free: true });
    }
    if (s === 0) {
      tone({ type: 'triangle', pts: [[0, mtof(root + 24)]], t, dur: dur * 6, gain: 0.018, attack: 0.15, dest, free: true });
    }
  },
};

const GAME = {
  bpm: 132,
  chords: [[45, 1], [41, 0], [48, 0], [43, 0]],
  step(t, dur, i, dest) {
    const ci = Math.floor(i / 8) % 4;
    const s = i % 8;
    const [root, minor] = this.chords[ci];
    const tones = [0, minor ? 3 : 4, 7, 12];
    // bass pulse, octave jump on the off-beats
    tone({ type: 'triangle', pts: [[0, mtof(root - 12 + (s % 2 ? 12 : 0))]], t, dur: dur * 0.85, gain: 0.07, attack: 0.008, dest, free: true });
    // soft kick on every beat
    if (s % 2 === 0) {
      tone({ type: 'sine', pts: [[0, 130], [0.09, 45]], t, dur: 0.12, gain: 0.11, attack: 0.003, dest, free: true });
    }
    // gentle off-beat hat
    if (s % 2 === 1) {
      noise({ kind: 'highpass', f: [7000, 7000], q: 0.5, t, dur: 0.04, gain: 0.018, dest, free: true });
    }
    // syncopated arp
    const arp = [0, -1, 2, 1, -1, 3, 2, -1][s];
    if (arp >= 0) {
      tone({ type: 'triangle', pts: [[0, mtof(root + 24 + tones[arp])]], t, dur: dur * 1.2, gain: 0.035, attack: 0.01, dest, free: true });
    }
  },
};

// Golf: calm and sunny, a slow major pentatonic pluck over a soft pad. Quieter than the others.
const GOLFM = {
  bpm: 76,
  chords: [[48, 0], [53, 0], [55, 0], [48, 0]],
  step(t, dur, i, dest) {
    const ci = Math.floor(i / 8) % 4;
    const s = i % 8;
    const root = this.chords[ci][0];
    const pent = [0, 2, 4, 7, 9, 12];
    const mel = [3, -1, 4, -1, 2, -1, 1, 0][s];
    if (mel >= 0 && (i % 16 < 12)) {
      tone({ type: 'sine', pts: [[0, mtof(root + 12 + pent[mel])]], t, dur: dur * 2.2, gain: 0.04, attack: 0.012, dest, free: true });
    }
    if (s === 0) {
      tone({ type: 'sine', pts: [[0, mtof(root)]], t, dur: dur * 6, gain: 0.06, attack: 0.05, dest, free: true });
      tone({ type: 'triangle', pts: [[0, mtof(root + 16)]], t, dur: dur * 7, gain: 0.014, attack: 0.3, dest, free: true });
    }
    if (s === 4) {
      tone({ type: 'sine', pts: [[0, mtof(root + 7)]], t, dur: dur * 3, gain: 0.03, attack: 0.03, dest, free: true });
    }
  },
};

// Klossgolf: a bouncy, sunny ska-pop loop. Off-beat chord stabs, a hopping bass, kick
// and clap, and a whistled tune over eight bars: D G A G | Bm G Em A.
const KLOSSM = {
  bpm: 124,
  chords: [[50, 0], [55, 0], [57, 0], [55, 0], [47, 1], [55, 0], [52, 1], [57, 0]],
  // semitones above D5 (D major pentatonic), -1 = rest: four two-bar phrases
  tune: [
    4, -1, 7, 9, -1, 7, 4, -1,    2, -1, 4, 7, 4, 2, 0, -1,
    9, -1, 12, 9, -1, 7, 9, -1,   7, 4, -1, 2, 4, -1, 7, -1,
    4, -1, 7, 9, -1, 12, 14, -1,  12, -1, 9, 7, 9, -1, 7, -1,
    4, 4, -1, 2, 2, -1, 0, -1,    2, 4, 7, 9, 12, -1, -1, -1,
  ],
  step(t, dur, i, dest) {
    const s = i % 8;
    const [root, minor] = this.chords[Math.floor(i / 8) % 8];
    // bass: the root, a hop up the octave, the fifth
    const bass = [0, -1, 12, 7, 0, -1, 12, 7][s];
    if (bass >= 0) {
      tone({ type: 'triangle', pts: [[0, mtof(root - 12 + bass)]], t, dur: dur * 0.8, gain: 0.075, attack: 0.006, dest, free: true });
    }
    // kick on one and three, clap on two and four, hats that lean on the off-beat
    if (s === 0 || s === 4) {
      tone({ type: 'sine', pts: [[0, 140], [0.08, 48]], t, dur: 0.11, gain: 0.11, attack: 0.003, dest, free: true });
    }
    if (s === 2 || s === 6) {
      noise({ kind: 'bandpass', f: [1700, 1700], q: 0.9, t, dur: 0.07, gain: 0.035, dest, free: true });
    }
    noise({ kind: 'highpass', f: [7500, 7500], q: 0.5, t, dur: 0.03, gain: s % 2 ? 0.02 : 0.009, dest, free: true });
    // short chord stabs on every off-beat
    if (s % 2 === 1) {
      for (const n of [0, minor ? 3 : 4, 7]) {
        tone({ type: 'triangle', pts: [[0, mtof(root + 12 + n)]], t, dur: dur * 0.45, gain: 0.016, attack: 0.004, dest, free: true });
      }
    }
    // the tune: a soft whistle with a little scoop into each note
    const n = this.tune[i % 64];
    if (n >= 0) {
      const f = mtof(74 + n);
      tone({ type: 'sine', pts: [[0, f * 0.985], [0.03, f]], t, dur: dur * 0.95, gain: 0.05, attack: 0.008, dest, free: true });
      tone({ type: 'square', pts: [[0, f]], t, dur: dur * 0.5, gain: 0.006, attack: 0.004, dest, free: true });
    }
  },
};

// Heta paketet: a mischievous, bouncy loop with a ticking clock in the percussion.
// Eight bars in A minor with a sneaky E major turn at the end: Am Am F F C G Dm E.
// Woodblock tick-tock on every eighth, plucked staccato tune, off-beat stabs.
const PAKETM = {
  bpm: 136,
  // [chord root midi, minor?, bass root midi]
  chords: [[57, 1, 45], [57, 1, 45], [53, 0, 41], [53, 0, 41], [48, 0, 48], [55, 0, 43], [50, 1, 50], [52, 0, 40]],
  // semitones above A4, 99 = rest
  tune: [
    0, 99, 3, 99, 5, 99, 3, 0,    7, 99, 5, 3, 99, 0, 99, 99,
    0, 99, 3, 99, 8, 99, 7, 3,    5, 99, 3, 0, 99, -4, 99, 99,
    3, 99, 7, 99, 10, 99, 7, 3,   2, 99, 5, 99, 7, 5, 2, 99,
    5, 99, 8, 99, 5, 3, 99, 0,    7, 99, 11, 99, 14, 12, 11, 99,
  ],
  step(t, dur, i, dest) {
    const s = i % 8;
    const [root, minor, bassRoot] = this.chords[Math.floor(i / 8) % 8];
    // the clock: a woodblock tick on every eighth, tock a little lower on the off-beats
    const tock = s % 2 === 1;
    tone({ type: 'sine', pts: [[0, tock ? 1500 : 2000], [0.02, tock ? 1250 : 1650]], t, dur: 0.035, gain: tock ? 0.022 : 0.034, attack: 0.001, dest, free: true });
    noise({ kind: 'bandpass', f: [3600, 3600], q: 2, t, dur: 0.012, gain: 0.02, attack: 0.001, dest, free: true });
    // plucked bass that hops: root, rest, octave, rest ...
    const bass = [0, 99, 12, 99, 0, 7, 12, 99][s];
    if (bass !== 99) {
      tone({ type: 'triangle', pts: [[0, mtof(bassRoot + bass)]], t, dur: dur * 0.6, gain: 0.07, attack: 0.004, dest, free: true });
    }
    // kick on the beat, a snappy clap on two and four
    if (s === 0 || s === 4) {
      tone({ type: 'sine', pts: [[0, 150], [0.07, 50]], t, dur: 0.1, gain: 0.085, attack: 0.003, dest, free: true });
    }
    if (s === 2 || s === 6) {
      noise({ kind: 'bandpass', f: [1900, 1900], q: 0.9, t, dur: 0.06, gain: 0.03, dest, free: true });
    }
    // sneaky off-beat stabs
    if (tock) {
      for (const n of [0, minor ? 3 : 4, 7]) {
        tone({ type: 'triangle', pts: [[0, mtof(root + n)]], t, dur: dur * 0.3, gain: 0.014, attack: 0.003, dest, free: true });
      }
    }
    // the tune: staccato plucks with a little square sparkle on top
    const n = this.tune[i % 64];
    if (n !== 99) {
      const f = mtof(69 + n);
      tone({ type: 'triangle', pts: [[0, f]], t, dur: dur * 0.55, gain: 0.052, attack: 0.003, dest, free: true });
      tone({ type: 'square', pts: [[0, f * 2]], t, dur: dur * 0.2, gain: 0.005, attack: 0.002, dest, free: true });
    }
    // a tiny alarm-clock ding at the start of every second bar pair
    if (i % 32 === 0) {
      tone({ type: 'sine', pts: [[0, 2093]], t, dur: 0.5, gain: 0.014, attack: 0.002, dest, free: true });
    }
  },
};

const MODES = { lobby: LOBBY, game: GAME, golf: GOLFM, kloss: KLOSSM, paket: PAKETM };

function startTrack(mode) {
  const def = MODES[mode];
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.2);
  gain.connect(master);
  tracks.push({ mode, def, gain, next: ctx.currentTime + 0.08, i: 0, stepDur: 60 / def.bpm / 2, dead: false });
  if (!timer) timer = setInterval(tick, TICK_MS);
}

function stopTrack(tr, fade) {
  if (tr.dead) return;
  tr.dead = true;
  const t = ctx.currentTime;
  tr.gain.gain.cancelScheduledValues(t);
  tr.gain.gain.setValueAtTime(tr.gain.gain.value, t);
  tr.gain.gain.linearRampToValueAtTime(0, t + fade);
  setTimeout(() => {
    try {
      tr.gain.disconnect();
    } catch (e) {}
    tracks = tracks.filter((x) => x !== tr);
    if (!tracks.length && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, fade * 1000 + 700);
}

function tick() {
  try {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    for (const tr of tracks) {
      if (tr.dead) continue;
      if (tr.next < now - 0.1) tr.next = now + 0.05; // timers were throttled: resync
      while (tr.next < now + LOOKAHEAD) {
        tr.def.step(tr.next, tr.stepDur, tr.i, tr.gain);
        tr.next += tr.stepDur;
        tr.i++;
      }
    }
  } catch (e) {}
}

function applyMusic() {
  if (!ctx) return;
  const live = tracks.filter((t) => !t.dead);
  if (muted || wantMode === 'off' || !MODES[wantMode]) {
    for (const tr of live) stopTrack(tr, muted ? 0.02 : 0.6);
    return;
  }
  if (live.length === 1 && live[0].mode === wantMode) return;
  for (const tr of live) stopTrack(tr, 1.0);
  startTrack(wantMode);
}

/* -------------------------------------------------------------------- API */

function guard(fn) {
  return (...a) => {
    try {
      if (!ready()) return;
      return fn(...a);
    } catch (e) {}
  };
}

export const audio = {
  unlock() {
    try {
      if (!ctx && !build()) return;
      if (ctx.state !== 'running') {
        const r = ctx.resume();
        if (r && r.then) r.then(applyMusic, () => {});
      }
      applyMusic();
    } catch (e) {}
  },

  setMuted(m) {
    try {
      muted = !!m;
      if (!ctx) return;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, t, 0.015);
      applyMusic();
    } catch (e) {}
  },

  isMuted() {
    return muted;
  },

  bump: guard((strength, pan) => {
    const s = clamp(num(strength, 0.5), 0, 1);
    const p = clamp(num(pan, 0), -1, 1);
    const t = ctx.currentTime + 0.005;
    if (t - lastBump < BUMP_GAP || bumpLive >= MAX_BUMPS) return;
    lastBump = t;
    const done = () => bumpLive--;
    bumpLive++;
    // round thud: pitch drops fast, gets lower and longer with strength
    tone({
      type: 'sine',
      pts: [[0, 200 - 80 * s], [0.14 + 0.1 * s, 52]],
      t, dur: 0.16 + 0.14 * s, gain: 0.3 * (0.3 + 0.7 * s), attack: 0.004, pan: p, onend: done,
    });
    // soft tap on top
    noise({ kind: 'bandpass', f: [1100, 500], q: 0.9, t, dur: 0.03 + 0.02 * s, gain: 0.1 * (0.3 + 0.7 * s), pan: p });
    // rubbery boing from medium hits upwards
    if (s > 0.3) {
      tone({
        type: 'triangle',
        pts: [[0, 150], [0.05, 280 + 220 * s], [0.26, 105]],
        t, dur: 0.28, gain: 0.17 * s, attack: 0.006, pan: p,
      });
    }
  }),

  dash: guard((own) => {
    const m = own ? 1.4 : 1;
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [500, 2600], q: 1.1, t, dur: 0.22, gain: 0.13 * m, attack: 0.04 });
    tone({ type: 'sine', pts: [[0, 280], [0.2, 760]], t, dur: 0.2, gain: 0.05 * m, attack: 0.04 });
  }),

  fall: guard((own) => {
    const m = own ? 1.4 : 1;
    const t = ctx.currentTime + 0.005;
    tone({ type: 'sine', pts: [[0, 1250], [0.1, 1500], [0.75, 240]], t, dur: 0.78, gain: 0.12 * m, attack: 0.03 });
    tone({ type: 'triangle', pts: [[0, 625], [0.1, 750], [0.75, 120]], t, dur: 0.78, gain: 0.04 * m, attack: 0.03 });
  }),

  ko: guard(() => {
    const t = ctx.currentTime + 0.005;
    tone({ type: 'sine', pts: [[0, 880], [0.06, 440]], t, dur: 0.1, gain: 0.17 });
    tone({ type: 'sine', pts: [[0, 784]], t: t + 0.07, dur: 0.18, gain: 0.13 });
    tone({ type: 'sine', pts: [[0, 1175]], t: t + 0.14, dur: 0.28, gain: 0.11 });
  }),

  countdown: guard((n) => {
    const t = ctx.currentTime + 0.005;
    if (num(n, 1) > 0) {
      tone({ type: 'sine', pts: [[0, 523]], t, dur: 0.18, gain: 0.2, attack: 0.008 });
    } else {
      tone({ type: 'sine', pts: [[0, 784]], t, dur: 0.55, gain: 0.2, attack: 0.008 });
      tone({ type: 'sine', pts: [[0, 1047]], t, dur: 0.5, gain: 0.13, attack: 0.008 });
      tone({ type: 'triangle', pts: [[0, 1568]], t, dur: 0.4, gain: 0.05, attack: 0.008 });
    }
  }),

  ringWarn: guard(() => {
    const t = ctx.currentTime + 0.005;
    tone({ type: 'sine', pts: [[0, 988]], t, dur: 0.09, gain: 0.12, attack: 0.006 });
  }),

  ringFall: guard(() => {
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [3200, 900], q: 1.2, t, dur: 0.25, gain: 0.18 });
    [0, 0.035, 0.08, 0.12].forEach((o, i) =>
      noise({ kind: 'highpass', f: [4200 - i * 500, 4200 - i * 500], q: 0.7, t: t + o, dur: 0.025, gain: 0.09 }));
    tone({ type: 'sine', pts: [[0, 75], [1.0, 38]], t, dur: 1.0, gain: 0.3, attack: 0.03 });
    noise({ kind: 'lowpass', f: [220, 90], q: 0.7, t, dur: 0.9, gain: 0.18, attack: 0.03 });
  }),

  win: guard(() => {
    const t = ctx.currentTime + 0.005;
    [[72, 0, 0.14], [76, 0.11, 0.14], [79, 0.22, 0.14], [84, 0.33, 0.55]].forEach(([m, o, d]) => {
      tone({ type: 'triangle', pts: [[0, mtof(m)]], t: t + o, dur: d + 0.1, gain: 0.14, attack: 0.008 });
      tone({ type: 'sine', pts: [[0, mtof(m + 12)]], t: t + o, dur: d + 0.1, gain: 0.05, attack: 0.008 });
    });
    tone({ type: 'sine', pts: [[0, mtof(67)]], t: t + 0.33, dur: 0.65, gain: 0.1, attack: 0.01 });
  }),

  lose: guard(() => {
    const t = ctx.currentTime + 0.005;
    [[392, 330, 0], [330, 277, 0.24], [262, 196, 0.48]].forEach(([a, b, o], i) =>
      tone({ type: 'sine', pts: [[0, a], [0.22 + i * 0.08, b]], t: t + o, dur: 0.26 + i * 0.12, gain: 0.15, attack: 0.012 }));
  }),

  join: guard(() => {
    const t = ctx.currentTime + 0.005;
    tone({ type: 'sine', pts: [[0, 700], [0.07, 1000]], t, dur: 0.1, gain: 0.12, attack: 0.006 });
  }),

  // Golf club hits the ball: a short woody tock, harder with power.
  putt: guard((power, own) => {
    const pw = clamp(num(power, 0.5), 0, 1);
    const m = own ? 1.3 : 0.8;
    const t = ctx.currentTime + 0.005;
    tone({ type: 'sine', pts: [[0, 320 + 120 * pw], [0.07, 150]], t, dur: 0.09, gain: 0.2 * m * (0.45 + 0.55 * pw), attack: 0.003 });
    noise({ kind: 'bandpass', f: [2400, 1200], q: 1.2, t, dur: 0.025, gain: 0.1 * m * (0.4 + 0.6 * pw) });
  }),

  // Ball against a rail (0), bumper (1) or spinner (2). Voice limited: arrives many times a second.
  knock: guard((speed, kind, pan) => {
    const s = clamp(num(speed, 0.5), 0, 1);
    const k = kind === 1 || kind === 2 ? kind : 0;
    const p = clamp(num(pan, 0), -1, 1);
    const t = ctx.currentTime + 0.005;
    if (t - lastKnock < KNOCK_GAP || knockLive >= MAX_KNOCKS || voices >= MAX_VOICES - 2 || s < 0.03) return;
    lastKnock = t;
    const done = () => knockLive--;
    knockLive++;
    const a = 0.25 + 0.75 * s;
    if (k === 0) {
      tone({ type: 'triangle', pts: [[0, 260 + 90 * s], [0.06, 130]], t, dur: 0.08, gain: 0.17 * a, attack: 0.003, pan: p, onend: done });
      noise({ kind: 'bandpass', f: [1800, 900], q: 1, t, dur: 0.02, gain: 0.07 * a, pan: p });
    } else if (k === 1) {
      tone({ type: 'sine', pts: [[0, 330], [0.05, 560 + 200 * s], [0.18, 300]], t, dur: 0.2, gain: 0.16 * a, attack: 0.004, pan: p, onend: done });
      noise({ kind: 'bandpass', f: [1500, 700], q: 1, t, dur: 0.02, gain: 0.05 * a, pan: p });
    } else {
      tone({ type: 'triangle', pts: [[0, 190 + 60 * s], [0.1, 95]], t, dur: 0.12, gain: 0.18 * a, attack: 0.004, pan: p, onend: done });
      noise({ kind: 'lowpass', f: [900, 400], q: 0.8, t, dur: 0.04, gain: 0.08 * a, pan: p });
    }
  }),

  // The ball rattles down into the cup.
  cup: guard((own) => {
    const m = own ? 1.3 : 0.8;
    const t = ctx.currentTime + 0.005;
    [0, 0.07, 0.15].forEach((o, i) =>
      tone({ type: 'sine', pts: [[0, 700 - i * 150], [0.05, 420 - i * 90]], t: t + o, dur: 0.07, gain: 0.1 * m, attack: 0.003 }));
    tone({ type: 'sine', pts: [[0, 220], [0.2, 110]], t: t + 0.24, dur: 0.22, gain: 0.16 * m, attack: 0.006 });
    if (own) tone({ type: 'sine', pts: [[0, 784]], t: t + 0.3, dur: 0.35, gain: 0.07, attack: 0.01 });
  }),

  // A bigger celebration than win(): a rising run and a bright held chord.
  holeInOne: guard(() => {
    const t = ctx.currentTime + 0.005;
    [[72, 0], [76, 0.08], [79, 0.16], [84, 0.24], [88, 0.32]].forEach(([m, o]) => {
      tone({ type: 'triangle', pts: [[0, mtof(m)]], t: t + o, dur: 0.22, gain: 0.12, attack: 0.006 });
    });
    [84, 88, 91, 96].forEach((m) => {
      tone({ type: 'sine', pts: [[0, mtof(m)]], t: t + 0.42, dur: 0.9, gain: 0.07, attack: 0.012 });
    });
    tone({ type: 'sine', pts: [[0, mtof(60)]], t: t + 0.42, dur: 0.9, gain: 0.12, attack: 0.012 });
    [0.5, 0.62, 0.74, 0.88].forEach((o, i) =>
      noise({ kind: 'highpass', f: [6000 + i * 600, 6000 + i * 600], q: 0.7, t: t + o, dur: 0.05, gain: 0.05 }));
  }),

  // The ball leaves the course: a soft falling whistle, gentler than fall().
  oob: guard((own) => {
    const m = own ? 1.3 : 0.8;
    const t = ctx.currentTime + 0.005;
    tone({ type: 'sine', pts: [[0, 900], [0.06, 1000], [0.7, 200]], t, dur: 0.72, gain: 0.09 * m, attack: 0.02 });
    tone({ type: 'sine', pts: [[0, 140], [0.7, 70]], t: t + 0.7, dur: 0.15, gain: 0.1 * m, attack: 0.005 });
  }),

  // Speed pad: a quick rising whoosh.
  boost: guard(() => {
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [700, 3200], q: 1.1, t, dur: 0.28, gain: 0.09, attack: 0.05 });
    tone({ type: 'triangle', pts: [[0, 330], [0.26, 880]], t, dur: 0.28, gain: 0.06, attack: 0.04 });
  }),

  // --- Klossgolf -----------------------------------------------------------

  // The swing: a short whoosh, then the hit. Driver = deep crack and a faint metal ring,
  // iron and wedge = smaller, putter = a soft tap only. club = index into CLUBS.
  swing: guard((club, power, own) => {
    const c = clamp(Math.round(num(club, 0)), 0, 3);
    const pw = clamp(num(power, 0.5), 0, 1);
    const m = own ? 1.3 : 0.8;
    const t = ctx.currentTime + 0.005;
    if (!own && t - lastSwing < SWING_GAP) return;
    lastSwing = t;
    const full = [1, 0.8, 0.55, 0][c];
    const eff = (0.35 + 0.65 * pw) * (c === 3 ? 1.8 : 1); // the putter tap needs a lift to be heard
    const lead = full > 0 ? 0.07 + 0.04 * full : 0;
    if (full > 0) {
      noise({ kind: 'bandpass', f: [450, 1800 + 1400 * full], q: 1.1, t, dur: lead + 0.05, gain: 0.12 * m * full * eff, attack: lead * 0.7 });
    }
    const ti = t + lead;
    tone({ type: 'sine', pts: [[0, [250, 290, 350, 420][c]], [0.07, [105, 125, 150, 200][c]]], t: ti, dur: 0.1 + 0.06 * full, gain: 0.22 * m * eff, attack: 0.003 });
    noise({ kind: 'bandpass', f: [3400 - 600 * full, 1700], q: 1.3, t: ti, dur: 0.025 + 0.015 * full, gain: 0.13 * m * eff * (0.5 + 0.5 * full), attack: 0.002 });
    if (full > 0.5) tone({ type: 'triangle', pts: [[0, 1900], [0.12, 1650]], t: ti, dur: 0.13, gain: 0.03 * m * full * eff, attack: 0.002 });
  }),

  // The ball touches down. surf = SURF.*, speed 0..1. Water and out of bounds have
  // their own sounds (splash, oob), so they are silent here.
  land: guard((surf, speed, pan) => {
    const k = Math.round(num(surf, 1));
    const s = clamp(num(speed, 0.5), 0, 1);
    const p = clamp(num(pan, 0), -1, 1);
    if (k === 4 || k === 6 || s < 0.04) return;
    const t = ctx.currentTime + 0.005;
    if (t - lastLand < LAND_GAP || landLive >= MAX_LANDS || voices >= MAX_VOICES - 2) return;
    lastLand = t;
    const done = () => landLive--;
    landLive++;
    const a = 2 * (0.25 + 0.75 * s); // touchdowns are small sounds: keep them audible next to the swing
    if (k === 3) { // bunker: a soft hiss of sand and a muffled thud
      noise({ kind: 'bandpass', f: [1400, 500], q: 0.6, t, dur: 0.14 + 0.1 * s, gain: 0.13 * a, attack: 0.012, pan: p });
      tone({ type: 'sine', pts: [[0, 100], [0.08, 50]], t, dur: 0.1, gain: 0.1 * a, attack: 0.004, pan: p, onend: done });
    } else if (k === 0) { // rough: leaves and grass
      noise({ kind: 'bandpass', f: [2200, 900], q: 0.7, t, dur: 0.09 + 0.05 * s, gain: 0.09 * a, attack: 0.01, pan: p });
      tone({ type: 'sine', pts: [[0, 120], [0.08, 60]], t, dur: 0.1, gain: 0.12 * a, attack: 0.004, pan: p, onend: done });
    } else if (k === 2) { // green: a short, soft, higher thud
      tone({ type: 'sine', pts: [[0, 230], [0.06, 120]], t, dur: 0.08, gain: 0.13 * a, attack: 0.003, pan: p, onend: done });
      noise({ kind: 'bandpass', f: [1800, 900], q: 1, t, dur: 0.02, gain: 0.04 * a, pan: p });
    } else { // fairway and tee: a firm thud
      tone({ type: 'sine', pts: [[0, 170], [0.07, 70]], t, dur: 0.1, gain: 0.2 * a, attack: 0.003, pan: p, onend: done });
      noise({ kind: 'lowpass', f: [900, 300], q: 0.7, t, dur: 0.05, gain: 0.06 * a, pan: p });
    }
  }),

  // A ball into the water: a crash, a plop and a few bubbles.
  splash: guard((own) => {
    const m = own ? 1.3 : 0.8;
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [3000, 700], q: 0.9, t, dur: 0.35, gain: 0.2 * m, attack: 0.008 });
    noise({ kind: 'lowpass', f: [900, 250], q: 0.7, t, dur: 0.6, gain: 0.1 * m, attack: 0.03 });
    tone({ type: 'sine', pts: [[0, 200], [0.12, 90]], t, dur: 0.16, gain: 0.2 * m, attack: 0.004 });
    [0.18, 0.3, 0.42].forEach((o, i) =>
      tone({ type: 'sine', pts: [[0, 350 + i * 60], [0.07, 700 + i * 100]], t: t + o, dur: 0.08, gain: 0.04 * m, attack: 0.006 }));
  }),

  // The ball hits a tree: rustling leaves and a soft wooden knock.
  tree: guard(() => {
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [4200, 3000], q: 0.6, t, dur: 0.35, gain: 0.15, attack: 0.02 });
    [0.05, 0.12, 0.2, 0.27].forEach((o, i) =>
      noise({ kind: 'highpass', f: [5000 + i * 400, 5000 + i * 400], q: 0.7, t: t + o, dur: 0.05, gain: 0.06 }));
    tone({ type: 'sine', pts: [[0, 220], [0.05, 140]], t, dur: 0.07, gain: 0.1, attack: 0.003 });
  }),

  // --- Heta paketet ---------------------------------------------------------

  // One tick of the parcel's clock; urgency 0..1 raises the pitch. Alternates tick and tock.
  tick: guard((urgency) => {
    const u = clamp(num(urgency, 0), 0, 1);
    const t = ctx.currentTime + 0.005;
    if (t - lastTick < TICK_GAP) return;
    lastTick = t;
    tickFlip = !tickFlip;
    const base = (tickFlip ? 1500 : 1150) * (1 + 0.55 * u);
    tone({ type: 'sine', pts: [[0, base], [0.025, base * 0.82]], t, dur: 0.05, gain: 0.22 + 0.1 * u, attack: 0.001 });
    noise({ kind: 'bandpass', f: [3200 + 1500 * u, 3200 + 1500 * u], q: 2.5, t, dur: 0.018, gain: 0.14, attack: 0.001 });
    tone({ type: 'triangle', pts: [[0, base * 0.5]], t, dur: 0.06, gain: 0.08, attack: 0.002 });
  }),

  // The parcel hops to somebody else: a whoosh and a cheeky two-note boing.
  pass: guard((own) => {
    const m = own ? 1.4 : 0.8;
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [600, 2600], q: 1.1, t, dur: 0.16, gain: 0.1 * m, attack: 0.04 });
    tone({ type: 'triangle', pts: [[0, 300], [0.08, 620]], t, dur: 0.1, gain: 0.12 * m, attack: 0.006 });
    tone({ type: 'triangle', pts: [[0, 520], [0.1, 990]], t: t + 0.09, dur: 0.14, gain: 0.12 * m, attack: 0.006 });
    if (own) tone({ type: 'sine', pts: [[0, 1480]], t: t + 0.2, dur: 0.18, gain: 0.05, attack: 0.006 });
  }),

  // The party popper: a pop, a shower of confetti and a rattling alarm bell.
  pop: guard((own) => {
    const m = own ? 1.3 : 0.9;
    const t = ctx.currentTime + 0.005;
    noise({ kind: 'bandpass', f: [2600, 500], q: 0.8, t, dur: 0.07, gain: 0.4 * m, attack: 0.001 });
    tone({ type: 'sine', pts: [[0, 220], [0.08, 60]], t, dur: 0.12, gain: 0.34 * m, attack: 0.002 });
    // confetti: a scatter of tiny bright ticks falling in pitch
    [0.06, 0.1, 0.14, 0.19, 0.24, 0.3, 0.37, 0.45].forEach((o, i) =>
      noise({ kind: 'highpass', f: [7500 - i * 450, 7500 - i * 450], q: 0.7, t: t + o, dur: 0.03, gain: 0.07 * m * (1 - i * 0.08) }));
    // the alarm bell rattles: two alternating pitches, fading
    for (let k = 0; k < 12; k++) {
      tone({ type: 'sine', pts: [[0, k % 2 ? 1760 : 2217]], t: t + 0.08 + k * 0.032, dur: 0.05, gain: 0.07 * m * (1 - k / 14), attack: 0.002 });
    }
    // a little downward slide, "wah-wah", so it ends on a smile
    tone({ type: 'triangle', pts: [[0, 560], [0.35, 300]], t: t + 0.32, dur: 0.38, gain: 0.07 * m, attack: 0.02 });
  }),

  music(mode) {
    try {
      const m = Object.hasOwn(MODES, mode) ? mode : 'off';
      if (m === wantMode) return;
      wantMode = m;
      if (ctx) applyMusic();
    } catch (e) {}
  },
};
