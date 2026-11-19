// Knuffkampen – everything that is rendered in 3D.
//
// Golden hour above a sea of clouds: a round platform of ice slabs floats in the
// sky and little bumper cars shove each other off it. Everything is procedural:
// geometry from code, textures from canvas 2D / typed arrays, no asset files.
//
// World space: X = sim x, Y = sim z (height), Z = sim y.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIM, arenaRadius } from '/shared/sim.js';
import { ST, PALETTE, GAME } from '/shared/protocol.js';
import { GOLF, BALL, COURSES, spinnerEnds, courseBounds, onGround } from '/shared/golf.js';
import { createKloss } from './scene-kloss.js';
import { createPaket } from './scene-paket.js';

// ───────────────────────────────────────────────────────────── helpers

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
const num = (v, d) => (Number.isFinite(v) ? v : d);
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────────────────── constants

const CLOUD_Y = -36;        // top of the cloud sea (bodies die at SIM.KILL_Z just below)
const GAP = 0.09;           // seam between slabs
const BEVEL = 0.07;
const HUB_R = 0.62;         // glowing centre piece
const MAX_CARS = 64;
const MAX_RINGS = 12;
const TAG_W = 384, TAG_H = 96;

const SUN_AZ = new THREE.Vector2(-0.66, -0.75).normalize();   // sun sits behind-left of the player camera
const dirFrom = (elevDeg) => new THREE.Vector3(
  SUN_AZ.x * Math.cos(elevDeg * DEG), Math.sin(elevDeg * DEG), SUN_AZ.y * Math.cos(elevDeg * DEG));
const LIGHT_DIR = dirFrom(27);   // key light (a little higher than the visible sun, for readable shadows)
const SKY_SUN = dirFrom(6.5);    // the sun disc in the sky

const COL = {
  zenith: '#173a8c', mid: '#6a96e2', midWarm: '#f3a48d',
  horWarm: '#f9b87e', horCool: '#9a93d0', glow: '#ff9440',
  cloudLit: '#f7cfa6', cloudShade: '#8478b8', cloudDeep: '#3a4190',
  haze: '#b9a3c4',
  iceA: '#f6fcff', iceB: '#b4e0fa',
  seam: '#42dcff', warn: '#ff5412',
  gold: '#ffd426',
};
const C = (hex) => new THREE.Color(hex);

const TIERS = {
  low:    { maxPR: 1,   maxPixels: 1.15e6, shadow: 0,    bloom: false, env: false, fx: 0.45, motes: false },
  medium: { maxPR: 1.5, maxPixels: 2.3e6,  shadow: 1024, bloom: false, env: true,  fx: 0.75, motes: true },
  high:   { maxPR: 2,   maxPixels: 3.1e6,  shadow: 2048, bloom: true,  env: true,  fx: 1,    motes: true },
};
const TIER_ORDER = ['low', 'medium', 'high'];

// ───────────────────────────────────────────────────────────── procedural textures

/** Tileable cloud noise. R = billowy height, G/B = its gradient, A = stretched wisps. */
function makeNoiseTexture() {
  const S = 256;
  const rnd = mulberry32(20241);
  const lat = (px, py) => { const a = new Float32Array(px * py); for (let i = 0; i < a.length; i++) a[i] = rnd(); return { a, px, py }; };
  const vn = (L, u, v) => {
    const fx = u * L.px, fy = v * L.py;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    x0 = ((x0 % L.px) + L.px) % L.px; y0 = ((y0 % L.py) + L.py) % L.py;
    const x1 = (x0 + 1) % L.px, y1 = (y0 + 1) % L.py;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = L.a[y0 * L.px + x0], b = L.a[y0 * L.px + x1], c = L.a[y1 * L.px + x0], d = L.a[y1 * L.px + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const cells = (c) => { const a = new Float32Array(c * c * 2); for (let i = 0; i < a.length; i++) a[i] = rnd(); return { a, c }; };
  const wor = (K, u, v) => {
    const c = K.c, fx = u * c, fy = v * c, cx = Math.floor(fx), cy = Math.floor(fy);
    let best = 9;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const k = ((((gy % c) + c) % c) * c + (((gx % c) + c) % c)) * 2;
        const dx = gx + K.a[k] - fx, dy = gy + K.a[k + 1] - fy;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  };
  const L4 = lat(4, 4), L8 = lat(8, 8), L16 = lat(16, 16);
  const W1 = lat(3, 12), W2 = lat(6, 24), W3 = lat(12, 48);
  const C1 = cells(4), C2 = cells(9), C3 = cells(19);
  const H = new Float32Array(S * S), A = new Float32Array(S * S);
  let hMin = 1e9, hMax = -1e9;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const wu = u + (vn(L8, u, v) - 0.5) * 0.07;
      const wv = v + (vn(L8, v + 0.31, u + 0.67) - 0.5) * 0.07;
      const d1 = Math.min(1, wor(C1, wu, wv)), d2 = Math.min(1, wor(C2, wu, wv)), d3 = Math.min(1, wor(C3, wu, wv));
      const billow = (1 - d1 * d1) * 0.6 + (1 - d2 * d2) * 0.3 + (1 - d3 * d3) * 0.1;
      const base = vn(L4, u, v) * 0.6 + vn(L8, u, v) * 0.3 + vn(L16, u, v) * 0.1;
      const h = billow * 0.78 + base * 0.34;
      H[y * S + x] = h;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
      A[y * S + x] = vn(W1, u, v) * 0.5 + vn(W2, u, v) * 0.3 + vn(W3, u, v) * 0.2;
    }
  }
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - hMin) / (hMax - hMin);
  const gx = new Float32Array(S * S), gy = new Float32Array(S * S);
  let gMax = 1e-6;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const xm = (x + S - 1) % S, xp = (x + 1) % S, ym = (y + S - 1) % S, yp = (y + 1) % S;
      const a = (H[y * S + xp] - H[y * S + xm]) * S * 0.5;
      const b = (H[yp * S + x] - H[ym * S + x]) * S * 0.5;
      gx[y * S + x] = a; gy[y * S + x] = b;
      gMax = Math.max(gMax, Math.abs(a), Math.abs(b));
    }
  }
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = Math.round(H[i] * 255);
    data[i * 4 + 1] = Math.round(clamp(0.5 + gx[i] / (2 * gMax), 0, 1) * 255);
    data[i * 4 + 2] = Math.round(clamp(0.5 + gy[i] / (2 * gMax), 0, 1) * 255);
    data[i * 4 + 3] = Math.round(clamp(A[i], 0, 1) * 255);
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { tex, gMax };
}

/** Ice surface: RGB = frosty albedo with skate scratches, A = 1 - crack mask (cracks glow during a warning). */
function makeIceTexture() {
  const S = 512;
  const rnd = mulberry32(4242);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return c; };
  const cv = mk(), g = cv.getContext('2d', { willReadFrequently: true });
  const wrap = (ctx, fn) => {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { ctx.save(); ctx.translate(ox * S, oy * S); fn(); ctx.restore(); }
  };
  g.fillStyle = '#f3f8ff';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 54; i++) {            // soft frost blotches
    const x = rnd() * S, y = rnd() * S, r = 26 + rnd() * 90, blue = rnd() < 0.62;
    wrap(g, () => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, blue ? 'rgba(140,200,240,0.22)' : 'rgba(255,255,255,0.5)');
      gr.addColorStop(1, blue ? 'rgba(128,188,236,0)' : 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    });
  }
  for (let i = 0; i < 110; i++) {           // skate scratches: long shallow arcs
    const x = rnd() * S, y = rnd() * S, rad = 50 + rnd() * 380, a0 = rnd() * TAU, len = 0.12 + rnd() * 0.5;
    const light = rnd() < 0.45;
    const style = light ? `rgba(255,255,255,${0.35 + rnd() * 0.4})` : `rgba(92,150,208,${0.14 + rnd() * 0.22})`;
    const lw = 0.7 + rnd() * 1.5;
    wrap(g, () => { g.strokeStyle = style; g.lineWidth = lw; g.beginPath(); g.arc(x, y, rad, a0, a0 + len); g.stroke(); });
  }
  for (let i = 0; i < 1400; i++) {          // sparkle / grit
    const x = rnd() * S, y = rnd() * S, s = 0.6 + rnd() * 1.6;
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.3 + rnd() * 0.5})` : `rgba(110,170,225,${0.12 + rnd() * 0.25})`;
    g.fillRect(x, y, s, s);
  }
  const ck = mk(), k = ck.getContext('2d', { willReadFrequently: true });
  k.fillStyle = '#fff';
  k.fillRect(0, 0, S, S);
  k.lineCap = 'round'; k.lineJoin = 'round';
  for (let i = 0; i < 10; i++) {            // jagged cracks with a branch or two
    let x = rnd() * S, y = rnd() * S, a = rnd() * TAU;
    const pts = [[x, y]];
    const n = 5 + Math.floor(rnd() * 6);
    for (let j = 0; j < n; j++) { a += (rnd() - 0.5) * 1.5; const l = 16 + rnd() * 38; x += Math.cos(a) * l; y += Math.sin(a) * l; pts.push([x, y]); }
    const bi = 1 + Math.floor(rnd() * (pts.length - 2));
    let bx = pts[bi][0], by = pts[bi][1], ba = a + (rnd() < 0.5 ? 1.2 : -1.2);
    const br = [[bx, by]];
    for (let j = 0; j < 3; j++) { ba += (rnd() - 0.5) * 1.2; const l = 12 + rnd() * 26; bx += Math.cos(ba) * l; by += Math.sin(ba) * l; br.push([bx, by]); }
    const path = (p) => { k.beginPath(); k.moveTo(p[0][0], p[0][1]); for (let j = 1; j < p.length; j++) k.lineTo(p[j][0], p[j][1]); k.stroke(); };
    wrap(k, () => {
      k.strokeStyle = 'rgba(0,0,0,0.16)'; k.lineWidth = 8; path(pts); path(br);
      k.strokeStyle = 'rgba(0,0,0,0.85)'; k.lineWidth = 2; path(pts);
      k.lineWidth = 1.4; path(br);
    });
  }
  const a = g.getImageData(0, 0, S, S).data, b = k.getImageData(0, 0, S, S).data;
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = a[i * 4]; data[i * 4 + 1] = a[i * 4 + 1]; data[i * 4 + 2] = a[i * 4 + 2];
    data[i * 4 + 3] = b[i * 4];
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function makeRadialTexture(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) gr.addColorStop(t, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawTag(cv, name, hex, isMe, bot) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (!name) return;
  const font = (s) => `800 ${s}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  let fs = 46;
  g.font = font(fs);
  let tw = g.measureText(name).width;
  const maxW = W - 60;
  if (tw > maxW) { fs = Math.max(22, Math.floor((fs * maxW) / tw)); g.font = font(fs); tw = g.measureText(name).width; }
  const pw = Math.min(W - 8, tw + 54), ph = 68, px = (W - pw) / 2, py = (H - ph) / 2, r = ph / 2;
  g.beginPath();
  g.moveTo(px + r, py); g.lineTo(px + pw - r, py); g.arc(px + pw - r, py + r, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(px + r, py + ph); g.arc(px + r, py + r, r, Math.PI / 2, Math.PI * 1.5);
  g.closePath();
  g.fillStyle = isMe ? COL.gold : 'rgba(13,22,52,0.78)';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = isMe ? '#ffffff' : hex;
  g.stroke();
  g.fillStyle = isMe ? '#131d40' : bot ? '#cfe1ff' : '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, W / 2, H / 2 + 2);
}

// ───────────────────────────────────────────────────────────── sky and cloud shaders

const SKY_COMMON = /* glsl */`
uniform vec3 uSun;
uniform vec3 cHorWarm;
uniform vec3 cHorCool;
float kkAz( vec3 d ) {
  vec2 h = normalize( d.xz + vec2( 1e-5 ) );
  float a = 0.5 + 0.5 * dot( h, normalize( uSun.xz ) );
  return a * a;
}
vec3 kkHorizon( vec3 d ) { return mix( cHorCool, cHorWarm, kkAz( d ) ); }
`;

const SKY_VERT = /* glsl */`
uniform float uRadius;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4( cameraPosition + position * uRadius, 1.0 );
}
`;

const SKY_FRAG = /* glsl */`
${SKY_COMMON}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uSunDisc;
uniform vec3 cZenith;
uniform vec3 cMid;
uniform vec3 cMidWarm;
uniform vec3 cGlow;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float y = d.y;
  float az = kkAz( d );
  vec3 hor = kkHorizon( d );
  vec3 mid = mix( cMid, cMidWarm, az * 0.85 );
  vec3 c = mix( hor, mid, smoothstep( 0.0, 0.26, y ) );
  c = mix( c, cZenith, smoothstep( 0.16, 0.9, y ) );
  float sd = max( dot( d, uSun ), 0.0 );
  c += cGlow * ( pow( sd, 9.0 ) * 0.42 + pow( sd, 70.0 ) * 1.1 );
  c += vec3( 1.0, 0.86, 0.62 ) * smoothstep( 0.99957, 0.99985, sd ) * uSunDisc;
  // high cirrus streaks catching the last light
  float yy = max( y, 0.0 );
  vec2 cuv = d.xz / ( yy + 0.32 ) * vec2( 0.2, 0.52 ) + vec2( uTime * 0.0015, 0.0 );
  float n = texture2D( uNoise, cuv ).a;
  float w = smoothstep( 0.5, 0.82, n ) * smoothstep( 0.02, 0.28, y ) * ( 1.0 - smoothstep( 0.55, 0.95, y ) ) * 0.6;
  c = mix( c, mix( vec3( 1.0, 0.84, 0.82 ), vec3( 1.0, 0.7, 0.46 ), az ), w );
  gl_FragColor = vec4( c, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CLOUD_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const CLOUD_FRAG = /* glsl */`
${SKY_COMMON}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uGrad;
uniform vec3 uSunL;
uniform vec3 cLit;
uniform vec3 cShade;
uniform vec3 cDeep;
uniform vec3 cGlow;
varying vec3 vWorld;
const float S1 = 0.0024;
const float S2 = 0.0071;
void main() {
  vec3 toP = vWorld - cameraPosition;
  float dist = length( toP );
  vec3 V = toP / dist;
  vec2 p = vWorld.xz;
  vec2 wnd = uTime * vec2( 2.6, 0.9 );
  // one parallax step so the billows have depth when the camera moves
  float h0 = texture2D( uNoise, ( p + wnd ) * S1 ).r;
  p += V.xz / max( -V.y, 0.34 ) * ( h0 - 0.5 ) * 22.0;
  vec4 n1 = texture2D( uNoise, ( p + wnd ) * S1 );
  vec4 n2 = texture2D( uNoise, ( p + wnd * 1.6 ) * S2 + vec2( 0.37, 0.11 ) );
  float h = n1.r * 0.64 + n2.r * 0.36;
  vec2 g = ( ( n1.gb - 0.5 ) * ( 0.64 * S1 ) + ( n2.gb - 0.5 ) * ( 0.36 * S2 ) ) * uGrad;
  vec3 N = normalize( vec3( -g.x, 1.0, -g.y ) );
  float ndl = dot( N, uSunL );
  float lit = smoothstep( 0.18, 0.92, ndl );
  // crude self shadowing: is the cloud towards the sun taller than here?
  float hs = texture2D( uNoise, ( p + uSunL.xz * 34.0 + wnd ) * S1 ).r;
  lit *= 1.0 - 0.8 * smoothstep( 0.0, 0.16, hs - n1.r );
  float top = smoothstep( 0.3, 0.8, h );
  vec3 col = mix( cDeep, cShade, smoothstep( 0.12, 0.62, h ) );
  col = mix( col, cLit, clamp( lit * ( 0.3 + 0.7 * top ) + top * 0.1, 0.0, 1.0 ) );
  col += cGlow * pow( max( dot( V, uSun ), 0.0 ), 5.0 ) * 0.5 * h;
  col = mix( col, kkHorizon( V ), 1.0 - exp( -dist * 0.0008 ) );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ───────────────────────────────────────────────────────────── lit material patch

/**
 * Adds to a MeshStandardMaterial: height + distance haze (so things fall away into the
 * clouds), and for kind 'ice' the glowing seams / underside and the hot warning pulse.
 */
function patchStandard(mat, kind, shared) {
  const own = { uWarn: { value: 0 } };
  mat.userData.u = own;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHazeColor = shared.uHazeColor;
    sh.uniforms.uHaze = shared.uHaze;
    if (kind === 'ice') {
      sh.uniforms.uWarn = own.uWarn;
      sh.uniforms.uGlowColor = shared.uGlowColor;
      sh.uniforms.uWarnColor = shared.uWarnColor;
    }
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', `#include <common>
varying float vHzY;
${kind === 'ice' ? 'attribute float aGlow;\nattribute vec2 aUvOff;\nvarying float vGlow;' : ''}`);
    if (kind === 'ice') {
      vs = vs.replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv += aUvOff;
#endif
  vGlow = aGlow;`);
    }
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
  vec4 hzW = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  hzW = instanceMatrix * hzW;
#endif
  vHzY = ( modelMatrix * hzW ).y;`);

    fs = fs.replace('#include <common>', `#include <common>
varying float vHzY;
uniform vec3 uHazeColor;
uniform vec4 uHaze;
${kind === 'ice' ? 'varying float vGlow;\nuniform float uWarn;\nuniform vec3 uGlowColor;\nuniform vec3 uWarnColor;' : ''}`);
    if (kind === 'ice') {
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float crack = 0.0;
    #ifdef USE_MAP
      crack = 1.0 - sampledDiffuseColor.a;
    #endif
    diffuseColor.rgb *= 1.0 - crack * 0.12;
    totalEmissiveRadiance += vec3( 0.0, 0.035, 0.06 ) * ( 1.0 - vGlow );
    totalEmissiveRadiance += uGlowColor * vGlow;
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.0, 0.17, 0.06 ), uWarn );
    totalEmissiveRadiance = mix( totalEmissiveRadiance, uWarnColor * ( 0.5 + vGlow * 1.3 ) + vec3( 1.0, 0.62, 0.2 ) * crack * 3.2, uWarn );
  }`);
    } else if (kind === 'car') {
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * 0.1;`);
    }
    fs = fs.replace('#include <opaque_fragment>', `{
    float hzH = 1.0 - smoothstep( uHaze.y, uHaze.x, vHzY );
    float hzD = 1.0 - exp( -max( length( vViewPosition ) - uHaze.w, 0.0 ) * uHaze.z );
    outgoingLight = mix( outgoingLight, uHazeColor, max( pow( hzH, 1.4 ) * 0.97, hzD ) );
  }
  #include <opaque_fragment>`);
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'kk-' + kind;
  return mat;
}

// ───────────────────────────────────────────────────────────── geometry builders

/** Non-indexed copy without uv, with a per-vertex colour from fn(x, y, z, i) -> [r, g, b]. */
function painted(geo, fn) {
  const src = geo.attributes.position, n = src.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = fn(src.getX(i), src.getY(i), src.getZ(i), i);
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const out = geo.index ? geo.toNonIndexed() : geo;
  out.deleteAttribute('uv');
  return out;
}
const flat = (rgb) => () => rgb;

/** Non-indexed copy without uv, one colour per triangle from fn(cx, cy, cz) at its centroid (crisp stripes). */
function paintedFaces(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3);
  for (let i = 0; i + 2 < n; i += 3) {
    const c = fn((p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3, (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3);
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c[0]; col[(i + k) * 3 + 1] = c[1]; col[(i + k) * 3 + 2] = c[2]; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

/** Putting felt: one 4 m tile with two mowing stripes and a fine fibre grain. */
function makeFeltTexture() {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#5ccfa8'; g.fillRect(0, 0, S / 2, S);
  g.fillStyle = '#4dbd98'; g.fillRect(S / 2, 0, S / 2, S);
  const img = g.getImageData(0, 0, S, S), d = img.data, rnd = mulberry32(7171);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 16 + ((i >> 2) % S % 3 === 0 ? 3 : 0);
    d[i] += n * 0.8; d[i + 1] += n; d[i + 2] += n * 0.9;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeFlagTexture(label) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 168;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 256, 0);
  gr.addColorStop(0, '#ff3d55'); gr.addColorStop(1, '#ff7a45');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 168);
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 0, 256, 10); g.fillRect(0, 158, 256, 10);
  g.font = '900 112px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(90,10,30,0.35)'; g.fillText(label, 132, 92);
  g.fillStyle = '#ffffff'; g.fillText(label, 128, 88);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * A chunky ice block: bevelled top, walls that taper to a keel, glow rising towards the
 * underside. `loops` are 4 outlines (top inset, rim, mid, bottom) with equal point counts.
 */
function prismGeometry(loops, apex, topGlow) {
  const pos = [], col = [], glow = [], uv = [];
  const UVS = 0.21;
  const put = (v) => { pos.push(v[0], v[1], v[2]); col.push(v[3], v[4], v[5]); glow.push(v[6]); uv.push(v[0] * UVS + 0.5, v[2] * UVS + 0.5); };
  const tri = (a, b, c, rx, ry, rz) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * rx + ny * ry + nz * rz < 0) { put(a); put(c); put(b); } else { put(a); put(b); put(c); }
  };
  const M = loops[0].pts.length;
  let cx = 0, cz = 0;
  for (const p of loops[0].pts) { cx += p[0]; cz += p[1]; }
  cx /= M; cz /= M;
  const V = (L, k, c, g) => { const p = loops[L].pts[k % M]; return [p[0], loops[L].y, p[1], c[0], c[1], c[2], g]; };
  const cTop = [1, 1, 1], cBev = [1.13, 1.15, 1.17], cW0 = [0.72, 0.89, 1.0], cW1 = [0.46, 0.75, 1.0], cW2 = [0.28, 0.58, 0.98], cAp = [0.5, 0.86, 1.0];
  const centre = [cx, loops[0].y, cz, 1, 1, 1, topGlow];
  for (let k = 0; k < M; k++) {
    tri(centre, V(0, k, cTop, topGlow), V(0, k + 1, cTop, topGlow), 0, 1, 0);
    const styles = [
      [0, 1, cBev, cBev, 0.03, 0.06],
      [1, 2, cW0, cW1, 0.2, 0.6],
      [2, 3, cW1, cW2, 0.6, 1.0],
    ];
    for (const [la, lb, ca, cb, ga, gb] of styles) {
      const a0 = V(la, k, ca, ga), a1 = V(la, k + 1, ca, ga), b0 = V(lb, k, cb, gb), b1 = V(lb, k + 1, cb, gb);
      const rx = (a0[0] + a1[0]) * 0.5 - cx, rz = (a0[2] + a1[2]) * 0.5 - cz;
      tri(a0, a1, b1, rx, 0.25, rz);
      tri(a0, b1, b0, rx, 0.25, rz);
    }
    tri([apex[0], apex[1], apex[2], cAp[0], cAp[1], cAp[2], 1.35], V(3, k, cW2, 1.0), V(3, k + 1, cW2, 1.0), 0, -1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

function sectorLoop(rIn, rOut, half, segs, insIn, insOut, insSide, taper, rMid) {
  const ri = rIn + insIn, ro = rOut - insOut;
  const ho = half - insSide / ro, hi = half - insSide / ri;
  const pts = [];
  for (let k = 0; k <= segs; k++) { const a = -ho + (2 * ho * k) / segs; pts.push([ro * Math.cos(a), ro * Math.sin(a)]); }
  for (let k = 0; k <= segs; k++) { const a = hi - (2 * hi * k) / segs; pts.push([ri * Math.cos(a), ri * Math.sin(a)]); }
  for (const p of pts) { p[0] = (p[0] - rMid) * taper; p[1] *= taper; }
  return pts;
}

/** One slab of a ring (or a wedge of the core), centred on its own (rMid, 0, 0). */
function slabGeometry(rIn, rOut, count, gapIn, thick, keel, seed) {
  const half = Math.PI / count, rMid = (rIn + rOut) / 2;
  const segs = Math.max(2, Math.ceil((2 * half) / 0.1));
  const rnd = mulberry32(seed);
  const L = (insIn, insOut, insSide, taper) => sectorLoop(rIn, rOut, half, segs, insIn, insOut, insSide, taper, rMid);
  const loops = [
    { y: 0, pts: L(gapIn + BEVEL, BEVEL, GAP / 2 + BEVEL, 1) },
    { y: -BEVEL, pts: L(gapIn, 0, GAP / 2, 1) },
    { y: -thick * 0.5, pts: L(gapIn, 0, GAP / 2, 0.95) },
    { y: -thick, pts: L(gapIn, 0, GAP / 2, 0.62 + rnd() * 0.1) },
  ];
  const span = (rOut - rIn) * 0.2;
  return prismGeometry(loops, [(rnd() - 0.5) * span, -thick - keel, (rnd() - 0.5) * span], 0);
}

function hubGeometry() {
  const loop = (r) => { const pts = []; for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; pts.push([r * Math.cos(a), r * Math.sin(a)]); } return pts; };
  const r = HUB_R - GAP / 2;
  return prismGeometry([
    { y: 0, pts: loop(r - BEVEL) }, { y: -BEVEL, pts: loop(r) }, { y: -0.9, pts: loop(r * 0.9) }, { y: -1.7, pts: loop(r * 0.5) },
  ], [0, -3.4, 0], 0.85);
}

const EYE = { x: 0.46, y: 0.7, z: 0.245, r: 0.2 };
const GAZE = { x: Math.cos(40 * DEG), y: Math.sin(40 * DEG) };

function shellGeometry() {
  const prof = [[0.56, 0.06], [0.75, 0.09], [0.822, 0.22], [0.832, 0.36], [0.795, 0.51], [0.69, 0.665], [0.52, 0.795], [0.29, 0.872], [0.001, 0.9]];
  const pts = new THREE.SplineCurve(prof.map((p) => new THREE.Vector2(p[0], p[1]))).getPoints(22);
  for (const p of pts) p.x = Math.max(0.001, Math.min(p.x, 0.84));
  const shell = painted(new THREE.LatheGeometry(pts, 32), (x, y) => { const s = 0.84 + 0.2 * smooth(y / 0.9); return [s, s, s]; });
  const tor = new THREE.TorusGeometry(0.72, 0.18, 10, 36);   // rubber bumper: outer radius exactly PLAYER_R
  tor.rotateX(Math.PI / 2);
  tor.translate(0, 0.2, 0);
  const belly = new THREE.CircleGeometry(0.74, 24);   // closes the underside, seen while tumbling
  belly.rotateX(Math.PI / 2);
  belly.translate(0, 0.08, 0);
  const s = SIM.PLAYER_R / 0.9;
  const out = mergeGeometries([shell, painted(tor, flat([0.065, 0.065, 0.07])), painted(belly, flat([0.16, 0.16, 0.17]))]);
  out.scale(s, s, s);
  return out;
}

function eyesGeometry() {
  const parts = [];
  for (const sz of [1, -1]) {
    const g = new THREE.SphereGeometry(EYE.r, 16, 12);
    g.translate(EYE.x, EYE.y, EYE.z * sz);
    parts.push(painted(g, flat([1, 1, 1])));
  }
  return mergeGeometries(parts);
}

function pupilGeometry() {
  const parts = [], ang = Math.atan2(GAZE.y, GAZE.x);
  for (const sz of [1, -1]) {
    const p = new THREE.SphereGeometry(0.122, 14, 10);
    p.scale(0.45, 1, 1);
    p.rotateZ(ang);
    p.translate(EYE.x + GAZE.x * 0.172, EYE.y + GAZE.y * 0.172, EYE.z * sz);
    parts.push(painted(p, flat([0.012, 0.014, 0.03])));
    const h = new THREE.SphereGeometry(0.038, 8, 6);
    h.translate(EYE.x + GAZE.x * 0.222 - 0.035, EYE.y + GAZE.y * 0.222 + 0.05, EYE.z * sz - 0.045);
    parts.push(painted(h, flat([1, 1, 1])));
  }
  return mergeGeometries(parts);
}

function visorGeometry() {
  const dark = flat([0.02, 0.028, 0.06]), led = flat([0.25, 2.3, 3.0]);
  const arc = 1.9, R = 0.52, yv = 0.745, tube = 0.125;
  const band = new THREE.TorusGeometry(R, tube, 8, 18, arc);
  band.rotateX(Math.PI / 2);
  band.rotateY(arc / 2);
  band.translate(0, yv, 0);
  const parts = [painted(band, dark)];
  for (const sz of [1, -1]) {
    const cap = new THREE.SphereGeometry(tube, 8, 6);
    cap.translate(R * Math.cos(arc / 2), yv, R * Math.sin(arc / 2) * sz);
    parts.push(painted(cap, dark));
    const e = new THREE.SphereGeometry(0.062, 10, 8);
    e.scale(1, 1, 1.5);
    const az = 0.36 * sz, rr = R + tube * 0.66, yy = yv + tube * 0.7;
    e.translate(rr * Math.cos(az), yy, rr * Math.sin(az));
    parts.push(painted(e, led));
  }
  return mergeGeometries(parts);
}

/** Block of ice around a frozen car: translucent faces, bright frosty edges. */
function iceCubeGeometry() {
  const W = 1.96, H = 1.52, t = 0.1;
  const rgba = (geo, c) => {
    const g = geo.toNonIndexed();
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) col.set(c, i * 4);
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return g;
  };
  const body = new THREE.BoxGeometry(W, H, W);
  body.translate(0, H / 2, 0);
  const parts = [rgba(body, [0.72, 0.9, 1, 0.42])];
  const edge = [1, 1, 1, 0.9], h = W / 2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const v = new THREE.BoxGeometry(t, H, t);
      v.translate(sx * h, H / 2, sz * h);
      parts.push(rgba(v, edge));
    }
    for (const y of [0.02, H]) {
      const a = new THREE.BoxGeometry(W, t, t);
      a.translate(0, y, sx * h);
      const b = new THREE.BoxGeometry(t, t, W);
      b.translate(sx * h, y, 0);
      parts.push(rgba(a, edge), rgba(b, edge));
    }
  }
  return mergeGeometries(parts);
}

function antennaGeometry() {
  const pole = new THREE.CylinderGeometry(0.02, 0.03, 0.72, 6);
  pole.translate(0, 0.36, 0);
  const ball = new THREE.SphereGeometry(0.09, 10, 8);
  ball.translate(0, 0.77, 0);
  return mergeGeometries([painted(pole, flat([0.1, 0.1, 0.11])), painted(ball, flat([1.25, 1.25, 1.25]))]);
}

/** Flat band on the ice with RGBA vertex colours. */
function pushBand(pos, col, r0, r1, a0, a1, y, c0, c1, segs) {
  for (let k = 0; k < segs; k++) {
    const u0 = a0 + ((a1 - a0) * k) / segs, u1 = a0 + ((a1 - a0) * (k + 1)) / segs;
    const p = [[r0, u0, c0], [r1, u0, c1], [r1, u1, c1], [r0, u0, c0], [r1, u1, c1], [r0, u1, c0]];
    for (const [r, a, c] of p) { pos.push(r * Math.cos(a), y, r * Math.sin(a)); col.push(c[0], c[1], c[2], c[3]); }
  }
}
function bandGeometry(pos, col) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return g;
}

function auraGeometry() {
  const pos = [], col = [];
  const hot = [1, 0.93, 0.5, 0.95], out = [1, 0.5, 0.1, 0], inn = [1, 0.9, 0.45, 0];
  pushBand(pos, col, 0.72, 1.1, 0, TAU, 0, inn, hot, 40);
  const n = 12;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU, w = 0.15, tip = k % 2 ? 1.6 : 2.0;
    const P = [[1.1, a - w, hot], [tip, a, out], [1.1, a + w, hot]];
    for (const [r, u, c] of P) { pos.push(r * Math.cos(u), 0, r * Math.sin(u)); col.push(c[0], c[1], c[2], c[3]); }
    pushBand(pos, col, 1.1, 1.22, a + w, a + TAU / n - w, 0, hot, out, 2);
  }
  return bandGeometry(pos, col);
}

function meRingGeometry() {
  const pos = [], col = [];
  const gold = [1, 0.8, 0.05, 1], dark = [0.03, 0.07, 0.22, 0.5];
  const n = 6;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * TAU, a1 = a0 + (TAU / n) * 0.68;
    pushBand(pos, col, 1.08, 1.4, a0 - 0.03, a1 + 0.03, 0, dark, dark, 8);
    pushBand(pos, col, 1.13, 1.35, a0, a1, 0.006, gold, gold, 8);
  }
  return bandGeometry(pos, col);
}

function balloonGeometry(colA, colB) {
  const prof = [[0.5, 0], [1.5, 1.5], [3.0, 3.9], [3.85, 6.3], [3.7, 8.5], [2.7, 10.3], [1.2, 11.35], [0.001, 11.7]];
  const pts = new THREE.SplineCurve(prof.map((p) => new THREE.Vector2(p[0], p[1]))).getPoints(18);
  for (const p of pts) p.x = Math.max(0.001, p.x);
  const segs = 16, per = pts.length;
  const env = painted(new THREE.LatheGeometry(pts, segs), (x, y, z, i) => (Math.floor(i / per) % 4 < 2 ? colA : colB));
  const basket = new THREE.BoxGeometry(1.1, 0.9, 1.1);
  basket.translate(0, -1.5, 0);
  const neck = new THREE.CylinderGeometry(0.5, 0.42, 1.1, 6, 1, true);
  neck.translate(0, -0.55, 0);
  const out = mergeGeometries([env, painted(basket, flat([0.3, 0.17, 0.08])), painted(neck, flat([0.12, 0.09, 0.08]))]);
  out.translate(0, -5, 0);
  return out;
}

function shardGeometry() {
  const g = new THREE.OctahedronGeometry(1, 1);
  const rnd = mulberry32(99);
  const p = g.attributes.position, seen = new Map();
  for (let i = 0; i < p.count; i++) {     // jitter (identically for coincident vertices) for a rough crystal
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let j = seen.get(key);
    if (!j) { j = [(rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3]; seen.set(key, j); }
    const y = p.getY(i);
    const squeeze = y < 0 ? 1 - 0.35 * -y : 1;
    p.setXYZ(i, (p.getX(i) + j[0]) * squeeze, (y + j[1]) * (y < 0 ? 1.9 : 0.75), (p.getZ(i) + j[2]) * squeeze);
  }
  const n = p.count, col = new Float32Array(n * 3), glow = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = smooth((0.75 - p.getY(i)) / 2.6);
    col[i * 3] = lerp(0.74, 0.26, t); col[i * 3 + 1] = lerp(0.84, 0.55, t); col[i * 3 + 2] = lerp(0.95, 0.9, t);
    glow[i] = t * t * 0.9;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function towerGeometry() {
  const blobs = [[0, 0.85, 0, 1], [1.0, 0.45, 0.2, 0.72], [-0.92, 0.4, -0.2, 0.76], [0.3, 0.5, 0.9, 0.62], [-0.2, 1.6, 0.1, 0.66], [0.5, 1.3, -0.4, 0.52], [-0.5, 0.5, -0.85, 0.6]];
  const parts = blobs.map(([x, y, z, r]) => {
    const s = new THREE.IcosahedronGeometry(r, 2);
    s.translate(x, y, z);
    return painted(s, flat([1, 0.96, 0.92]));
  });
  return mergeGeometries(parts);
}

// ───────────────────────────────────────────────────────────── particles

const K_SOFT = 0, K_STREAK = 1, K_CONF = 2, K_RING = 3, K_PUFF = 4, K_STAR = 5, K_CHIP = 6;
const PS = 24;   // floats per particle in the sim buffer
const PX = 0, PY = 1, PZ = 2, PVX = 3, PVY = 4, PVZ = 5, PAGE = 6, PLIFE = 7, PSIZE = 8, PGROW = 9, PROT = 10, PROTV = 11,
  PR = 12, PG = 13, PB = 14, PA = 15, PKIND = 16, PADD = 17, PGRAV = 18, PDRAG = 19, PST = 20, PFADE = 21, PFLOOR = 22;

const PART_VERT = /* glsl */`
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aCol;
attribute vec4 aPar;
attribute float aAdd;
varying vec2 vUv;
varying vec4 vCol;
varying float vKind;
varying float vAdd;
varying float vSt;
void main() {
  float size = aPar.x;
  float kind = aPar.y;
  float rot = aPar.z;
  float st = aPar.w;
  vec2 c = position.xy;
  vUv = c; vCol = aCol; vKind = kind; vAdd = aAdd; vSt = st;
  vec4 mv;
  if ( kind > 2.5 && kind < 3.5 ) {
    mv = viewMatrix * vec4( aPos + vec3( c.x, 0.0, c.y ) * size, 1.0 );
  } else {
    mv = viewMatrix * vec4( aPos, 1.0 );
    vec2 off;
    if ( kind > 0.5 && kind < 1.5 ) {
      vec3 vv = ( viewMatrix * vec4( aVel, 0.0 ) ).xyz;
      float sp = length( vv.xy );
      vec2 d = sp > 0.001 ? vv.xy / sp : vec2( 1.0, 0.0 );
      off = d * c.x * ( size + sp * st ) + vec2( -d.y, d.x ) * c.y * size;
    } else {
      vec2 q = c;
      if ( kind > 1.5 && kind < 2.5 ) { q.y *= cos( rot * 2.7 + st ); q.x *= 0.62; }
      float cs = cos( rot ), sn = sin( rot );
      off = vec2( q.x * cs - q.y * sn, q.x * sn + q.y * cs ) * size;
    }
    mv.xy += off;
    mv.z += min( size, 1.6 ) * 0.8;
  }
  gl_Position = projectionMatrix * mv;
}
`;

const PART_FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying float vKind;
varying float vAdd;
varying float vSt;
void main() {
  vec2 p = vUv;
  float r = length( p );
  float a = 0.0;
  vec3 col = vCol.rgb;
  if ( vKind < 0.5 ) {
    a = clamp( 1.0 - r, 0.0, 1.0 ); a *= a;
  } else if ( vKind < 1.5 ) {
    a = clamp( 1.0 - abs( p.y ), 0.0, 1.0 ) * smoothstep( 1.0, 0.45, abs( p.x ) );
  } else if ( vKind < 2.5 ) {
    a = 1.0; col *= 0.8 + 0.2 * p.y;
  } else if ( vKind < 3.5 ) {
    float d = abs( r - ( 1.0 - vSt ) );
    a = 1.0 - smoothstep( vSt * 0.3, vSt, d );
  } else if ( vKind < 4.5 ) {
    a = 1.0 - smoothstep( 0.25, 1.0, r );
    col *= 0.74 + 0.36 * smoothstep( -0.7, 0.7, p.y - p.x * 0.35 );
  } else if ( vKind < 5.5 ) {
    float ang = atan( p.y, p.x ) / 6.2831853 + 0.5;
    float tri = abs( fract( ang * 9.0 ) - 0.5 ) * 2.0;
    float edge = mix( 0.98, 0.46, tri ) * ( 0.86 + 0.14 * sin( ang * 56.5 ) );
    a = 1.0 - smoothstep( edge - 0.05, edge, r );
    col = mix( vec3( 1.0, 0.99, 0.88 ), col, smoothstep( 0.05, 0.5, r ) );
    col = mix( col, vec3( 1.0, 0.36, 0.08 ), smoothstep( edge - 0.2, edge - 0.06, r ) );
  } else {
    a = step( abs( p.x ) + abs( p.y ), 1.0 );
    col *= 0.82 + 0.3 * p.y;
  }
  a *= vCol.a;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4( gl_FragColor.rgb * a, a * ( 1.0 - vAdd ) );
}
`;

function makeParticles(max) {
  const sim = new Float32Array(max * PS);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mkAttr = (name, size) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(max * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const aPos = mkAttr('aPos', 3), aVel = mkAttr('aVel', 3), aCol = mkAttr('aCol', 4), aPar = mkAttr('aPar', 4), aAdd = mkAttr('aAdd', 1);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    vertexShader: PART_VERT, fragmentShader: PART_FRAG,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  const api = {
    mesh, count: 0, floorR: 0, floorFn: null,
    emit(kind, x, y, z, vx, vy, vz, life, size, grow, r, g, b, a, add, grav, drag, rot, rotV, st, fade, floor) {
      if (api.count >= max) return;
      const o = api.count++ * PS;
      sim[o + PX] = x; sim[o + PY] = y; sim[o + PZ] = z;
      sim[o + PVX] = vx; sim[o + PVY] = vy; sim[o + PVZ] = vz;
      sim[o + PAGE] = 0; sim[o + PLIFE] = Math.max(0.01, life);
      sim[o + PSIZE] = size; sim[o + PGROW] = grow || 0;
      sim[o + PROT] = rot || 0; sim[o + PROTV] = rotV || 0;
      sim[o + PR] = r; sim[o + PG] = g; sim[o + PB] = b; sim[o + PA] = a;
      sim[o + PKIND] = kind; sim[o + PADD] = add || 0;
      sim[o + PGRAV] = grav || 0; sim[o + PDRAG] = drag || 0;
      sim[o + PST] = st || 0; sim[o + PFADE] = fade || 0; sim[o + PFLOOR] = floor || 0;
    },
    update(dt) {
      const R2 = api.floorR * api.floorR;
      let n = api.count, i = 0;
      const P = aPos.array, Vv = aVel.array, Cc = aCol.array, Q = aPar.array, Ad = aAdd.array;
      while (i < n) {
        const o = i * PS;
        const age = sim[o + PAGE] + dt, life = sim[o + PLIFE];
        if (age >= life) {
          n--;
          if (i !== n) sim.copyWithin(o, n * PS, n * PS + PS);
          continue;
        }
        sim[o + PAGE] = age;
        const dr = sim[o + PDRAG];
        if (dr > 0) { const f = Math.exp(-dr * dt); sim[o + PVX] *= f; sim[o + PVY] *= f; sim[o + PVZ] *= f; }
        sim[o + PVY] -= sim[o + PGRAV] * dt;
        sim[o + PX] += sim[o + PVX] * dt; sim[o + PY] += sim[o + PVY] * dt; sim[o + PZ] += sim[o + PVZ] * dt;
        if (sim[o + PFLOOR] > 0 && sim[o + PY] < 0.04 && sim[o + PVY] < 0 && sim[o + PY] > -0.6) {
          const x = sim[o + PX], z = sim[o + PZ];
          if (api.floorFn ? api.floorFn(x, z) : x * x + z * z < R2) {
            sim[o + PY] = 0.04; sim[o + PVY] *= -0.32; sim[o + PVX] *= 0.55; sim[o + PVZ] *= 0.55; sim[o + PROTV] *= 0.4;
          }
        }
        const size = Math.max(0, (sim[o + PSIZE] += sim[o + PGROW] * dt));
        sim[o + PROT] += sim[o + PROTV] * dt;
        const t = age / life, fade = sim[o + PFADE];
        let al = sim[o + PA];
        if (fade < 0.5) al *= 1 - t;
        else if (fade < 1.5) al *= Math.min(1, t * 7) * (1 - t) * (1 - t);
        else al *= 1 - smooth((t - 0.7) / 0.3);
        P[i * 3] = sim[o + PX]; P[i * 3 + 1] = sim[o + PY]; P[i * 3 + 2] = sim[o + PZ];
        Vv[i * 3] = sim[o + PVX]; Vv[i * 3 + 1] = sim[o + PVY]; Vv[i * 3 + 2] = sim[o + PVZ];
        Cc[i * 4] = sim[o + PR]; Cc[i * 4 + 1] = sim[o + PG]; Cc[i * 4 + 2] = sim[o + PB]; Cc[i * 4 + 3] = al;
        Q[i * 4] = size; Q[i * 4 + 1] = sim[o + PKIND]; Q[i * 4 + 2] = sim[o + PROT]; Q[i * 4 + 3] = sim[o + PST];
        Ad[i] = sim[o + PADD];
        i++;
      }
      api.count = n;
      geo.instanceCount = n;
      for (const [attr, size] of [[aPos, 3], [aVel, 3], [aCol, 4], [aPar, 4], [aAdd, 1]]) {
        attr.clearUpdateRanges();
        if (n > 0) { attr.addUpdateRange(0, n * size); attr.needsUpdate = true; }
      }
      mesh.visible = n > 0;
    },
  };
  return api;
}

// ───────────────────────────────────────────────────────────── canvas layout

// If nothing in CSS sizes the canvas, make it fill the window ourselves.
function ensureCanvasLayout(canvas) {
  try {
    if (!canvas.isConnected) return;
    const w0 = canvas.clientWidth, old = canvas.width;
    canvas.width = old + 7;
    const follows = canvas.clientWidth !== w0;
    canvas.width = old;
    if (follows) Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', display: 'block' });
  } catch { /* not fatal */ }
}

function stubScene() {
  const nop = () => {};
  return {
    setArena: nop, upsertPlayer: nop, removePlayer: nop, frame: nop, resize: nop, setQuality: nop,
    setGame: nop, setCourse: nop, groundPoint: () => null,
    getStats: () => ({ fps: 0, quality: 'low' }),
    fx: { hit: nop, dash: nop, fall: nop, confetti: nop, shake: nop, putt: nop, bounce: nop, boost: nop, holed: nop, oob: nop,
      swing: nop, land: nop, splash: nop, tree: nop, pass: nop, pop: nop },
  };
}

// ───────────────────────────────────────────────────────────── the scene

export function createScene(canvas, options) {
  const hostScreen = !!(options && options.spectator);
  ensureCanvasLayout(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: false, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[scene] WebGL is not available', err);
    return stubScene();
  }
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;    // getStats() reports the whole frame (scene, post and overlay)
  renderer.setClearColor(C(COL.horCool), 1);

  const scene = new THREE.Scene();
  const overlay = new THREE.Scene();   // name tags: drawn after post-processing so they stay crisp
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 7000);
  camera.position.set(0, 30, 30);

  const uTime = { value: 0 };
  const shared = {
    uHazeColor: { value: C(COL.haze) },
    uHaze: { value: new THREE.Vector4(-3, CLOUD_Y + 2, 0.0012, 70) },   // top, bottom, distance density, distance start
    uGlowColor: { value: C(COL.seam).multiplyScalar(1.7) },
    uWarnColor: { value: C(COL.warn).multiplyScalar(1.7) },
  };

  // ── sky, clouds, light ───────────────────────────────────────────────
  const noise = makeNoiseTexture();
  const skyUniforms = (disc) => ({
    uSun: { value: SKY_SUN }, cHorWarm: { value: C(COL.horWarm) }, cHorCool: { value: C(COL.horCool) },
    cZenith: { value: C(COL.zenith) }, cMid: { value: C(COL.mid) }, cMidWarm: { value: C(COL.midWarm) }, cGlow: { value: C(COL.glow) },
    uNoise: { value: noise.tex }, uTime, uSunDisc: { value: disc }, uRadius: { value: 3000 },
  });
  const skyGeo = new THREE.SphereGeometry(1, 32, 20);
  const skyMat = new THREE.ShaderMaterial({ uniforms: skyUniforms(14), vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = 100;     // after the other opaque things, so most of it is rejected by depth
  scene.add(sky);

  const cloudMat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SKY_SUN }, uSunL: { value: LIGHT_DIR }, cHorWarm: { value: C(COL.horWarm) }, cHorCool: { value: C(COL.horCool) },
      cLit: { value: C(COL.cloudLit) }, cShade: { value: C(COL.cloudShade) }, cDeep: { value: C(COL.cloudDeep) }, cGlow: { value: C(COL.glow) },
      uNoise: { value: noise.tex }, uTime, uGrad: { value: 2 * noise.gMax * 30 },
    },
    vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
  });
  const cloudGeo = new THREE.CircleGeometry(3400, 64);
  cloudGeo.rotateX(-Math.PI / 2);
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  clouds.position.y = CLOUD_Y;
  clouds.frustumCulled = false;
  clouds.renderOrder = 90;
  scene.add(clouds);

  const sun = new THREE.DirectionalLight(C('#ffeedc'), 4.3);
  sun.position.copy(LIGHT_DIR).multiplyScalar(90);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 170;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(C('#a9c2ff'), 0.6);
  fill.position.set(0.35, 0.8, 0.9).multiplyScalar(50);
  scene.add(fill);
  const hemi = new THREE.HemisphereLight(C('#a9ccff'), C('#ffc8a2'), 0.4);
  scene.add(hemi);

  // image based light from our own sky (medium / high); built the first time a tier wants it
  let envTex = null, envTried = false;
  function getEnv() {
    if (envTried) return envTex;
    envTried = true;
    try {
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(skyGeo, new THREE.ShaderMaterial({ uniforms: skyUniforms(0), vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false })));
      const pmrem = new THREE.PMREMGenerator(renderer);
      envTex = pmrem.fromScene(envScene, 0, 1, 6000, { size: 128 }).texture;
      pmrem.dispose();
    } catch (err) {
      console.warn('[scene] no environment map', err);
    }
    return envTex;
  }
  scene.environmentIntensity = 0.85;

  // ── materials ────────────────────────────────────────────────────────
  const iceTex = makeIceTexture();
  const makeIceMat = () => patchStandard(new THREE.MeshStandardMaterial({ map: iceTex, vertexColors: true, roughness: 0.58, metalness: 0 }), 'ice', shared);
  const carMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05 }), 'car', shared);
  const eyeMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2 }), 'car', shared);
  const plainMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'plain', shared);
  const shardMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, flatShading: true }), 'ice', shared);
  const unlitMat = new THREE.MeshBasicMaterial({ vertexColors: true });

  // ── arena ────────────────────────────────────────────────────────────
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _c = new THREE.Color();
  const Y_AXIS = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
  const toneA = C(COL.iceA), toneB = C(COL.iceB);

  const arenaGroup = new THREE.Group();
  scene.add(arenaGroup);
  const pieces = new Map();   // key -> piece; keys: 'hub', -1 (core wedges), 0.. (rings)
  const arena = { r0: 0, live: 0, synced: false, warnPhase: 0 };

  function slabCount(i) { return 2 * Math.round((TAU * (SIM.CORE_R + (i + 0.5) * SIM.RING_W)) / 3.3 / 2); }

  function makePiece(key) {
    let geo, count, rMid, idx;
    const rnd = mulberry32(1000 + (key === 'hub' ? 77 : key * 13));
    if (key === 'hub') { geo = hubGeometry(); count = 1; rMid = 0; idx = -1; }
    else if (key === -1) { count = 6; rMid = (HUB_R + SIM.CORE_R) / 2; geo = slabGeometry(HUB_R, SIM.CORE_R, count, GAP / 2, 1.25, 1.5, 5); idx = -1; }
    else {
        const rIn = SIM.CORE_R + key * SIM.RING_W, rOut = rIn + SIM.RING_W;
        count = slabCount(key); rMid = (rIn + rOut) / 2; idx = key;
        geo = slabGeometry(rIn, rOut, count, GAP, 0.95 + (key % 2) * 0.14, 0.45 + rnd() * 0.5, 31 + key);
    }
    const uvOff = new Float32Array(count * 2);
    for (let i = 0; i < uvOff.length; i++) uvOff[i] = rnd();
    geo.setAttribute('aUvOff', new THREE.InstancedBufferAttribute(uvOff, 2));
    const mat = makeIceMat();
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const phase = key === 'hub' ? 0 : key === -1 ? 0.26 : key * 0.41;
    const slabs = [];
    for (let k = 0; k < count; k++) {
      const ang = phase + (k / count) * TAU;
      const tone = key === 'hub' ? toneA.clone() : ((k + (idx + 1)) % 2 ? toneA : toneB).clone().multiplyScalar(0.95 + rnd() * 0.08);
      mesh.setColorAt(k, tone);
      slabs.push({
        ang, cx: rMid * Math.cos(ang), cz: rMid * Math.sin(ang), delay: 0, t: 0, done: false, puffed: false,
        px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, q: new THREE.Quaternion(), wx: 0, wy: 0, wz: 0, jit: rnd() * 100,
      });
    }
    mesh.visible = false;
    arenaGroup.add(mesh);
    return { key, idx, count, rMid, mesh, mat, slabs, state: 'gone', warn: 0, ramp: 0, hot: 0, shaking: false };
  }
  const getPiece = (key) => { let p = pieces.get(key); if (!p) { p = makePiece(key); pieces.set(key, p); } return p; };
  const piecesAt = (i) => (i < 0 ? [getPiece(-1), getPiece('hub')] : [getPiece(i)]);

  function writeIntact(piece) {
    for (let k = 0; k < piece.count; k++) {
      const s = piece.slabs[k];
      _q.setFromAxisAngle(Y_AXIS, -s.ang);
      _m.compose(_p.set(s.cx, 0, s.cz), _q, ONE);
      piece.mesh.setMatrixAt(k, _m);
    }
    piece.mesh.instanceMatrix.needsUpdate = true;
  }

  function setIntact(piece) {
    piece.state = 'intact'; piece.warn = 0; piece.hot = 0; piece.shaking = false;
    piece.mat.userData.u.uWarn.value = 0;
    piece.mesh.visible = true;
    writeIntact(piece);
  }

  function hidePiece(piece) {
    piece.state = 'gone'; piece.warn = 0; piece.hot = 0;
    piece.mat.userData.u.uWarn.value = 0;
    piece.mesh.visible = false;
  }

  function startRise(piece, base) {
    if (piece.state === 'intact' || piece.state === 'rising') return;
    piece.state = 'rising'; piece.warn = 0; piece.hot = 0;
    piece.mat.userData.u.uWarn.value = 0;
    piece.mesh.visible = true;
    const off = Math.random() * TAU;
    for (const s of piece.slabs) {
      s.t = 0; s.done = false;
      s.delay = base + ((((s.ang + off) % TAU) + TAU) % TAU) / TAU * 0.28;
    }
    for (let k = 0; k < piece.count; k++) piece.mesh.setMatrixAt(k, ZERO);
    piece.mesh.instanceMatrix.needsUpdate = true;
  }

  function startFall(piece, base) {
    if (piece.state === 'gone' || piece.state === 'falling') return;
    piece.state = 'falling';
    piece.hot = Math.max(piece.hot, 0.85);
    piece.mesh.visible = true;
    const off = Math.random() * TAU, big = piece.idx < 0;
    for (const s of piece.slabs) {
      s.t = 0; s.done = false; s.puffed = false;
      s.delay = base + ((((s.ang + off) % TAU) + TAU) % TAU) / TAU * 0.24;
      const ox = Math.cos(s.ang), oz = Math.sin(s.ang);
      const out = (big ? 0.6 : 1.4) + Math.random() * 2.4, tan = (Math.random() - 0.5) * 1.6;
      s.px = s.cx; s.py = 0; s.pz = s.cz;
      s.vx = ox * out - oz * tan; s.vz = oz * out + ox * tan; s.vy = -0.5 - Math.random() * 1.5;
      s.q.setFromAxisAngle(Y_AXIS, -s.ang);
      const sp = 0.7 + Math.random() * 1.9;   // tip outwards, with some randomness
      s.wx = (-oz + (Math.random() - 0.5) * 0.9) * sp; s.wy = (Math.random() - 0.5) * 1.2; s.wz = (ox + (Math.random() - 0.5) * 0.9) * sp;
    }
    // ice chips burst along the break line
    const r = piece.rMid, n = Math.round(piece.count * 2.2 * fxMul);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, rr = r + (Math.random() - 0.5) * SIM.RING_W;
      parts.emit(K_CHIP, rr * Math.cos(a), 0.1, rr * Math.sin(a), Math.cos(a) * 2 * Math.random(), 2 + Math.random() * 5, Math.sin(a) * 2 * Math.random(),
        0.6 + Math.random() * 0.6, 0.07 + Math.random() * 0.1, 0, 0.82, 0.94, 1, 1, 0, 16, 0.5, Math.random() * 6, 6, 0, 0, 0);
    }
  }

  function updatePiece(piece, dt, T) {
    const u = piece.mat.userData.u.uWarn;
    if (piece.state === 'gone') return;
    if (piece.state === 'intact') {
      u.value = piece.warn;
      if (piece.warn > 0 || piece.shaking) {
        const amp = piece.warn > 0 ? 0.012 + piece.ramp * piece.ramp * 0.06 : 0;
        for (let k = 0; k < piece.count; k++) {
          const s = piece.slabs[k];
          const jy = Math.sin(T * 43 + s.jit) * amp - piece.ramp * 0.05 * (piece.warn > 0 ? 1 : 0);
          const jr = Math.sin(T * 31 + s.jit * 1.7) * amp * 0.5;
          _q.setFromAxisAngle(Y_AXIS, -s.ang);
          if (amp > 0) { _q2.setFromAxisAngle(_v.set(Math.cos(s.ang), 0, Math.sin(s.ang)), Math.sin(T * 37 + s.jit * 2.3) * amp * 0.35); _q.premultiply(_q2); }
          _m.compose(_p.set(s.cx + Math.cos(s.ang) * jr, jy, s.cz + Math.sin(s.ang) * jr), _q, ONE);
          piece.mesh.setMatrixAt(k, _m);
        }
        piece.mesh.instanceMatrix.needsUpdate = true;
        piece.shaking = piece.warn > 0;
      }
      return;
    }
    if (piece.state === 'rising') {
      let all = true;
      for (let k = 0; k < piece.count; k++) {
        const s = piece.slabs[k];
        s.t += dt;
        const w = clamp((s.t - s.delay) / 0.5, 0, 1);
        if (w < 1) all = false;
        if (w <= 0) { piece.mesh.setMatrixAt(k, ZERO); continue; }
        const e = easeOutBack(w), sc = 0.55 + 0.45 * smooth(w);
        _q.setFromAxisAngle(Y_AXIS, -s.ang + (1 - e) * 0.5);
        _m.compose(_p.set(s.cx, (e - 1) * 8, s.cz), _q, _s.set(sc, sc, sc));
        piece.mesh.setMatrixAt(k, _m);
      }
      piece.mesh.instanceMatrix.needsUpdate = true;
      if (all) setIntact(piece);
      return;
    }
    // falling
    piece.hot = Math.max(0, piece.hot - dt * 0.7);
    u.value = piece.hot;
    let any = false;
    for (let k = 0; k < piece.count; k++) {
      const s = piece.slabs[k];
      if (s.done) continue;
      any = true;
      s.t += dt;
      if (s.t < s.delay) {      // still hanging on, trembling
        _q.setFromAxisAngle(Y_AXIS, -s.ang);
        _m.compose(_p.set(s.cx, Math.sin(T * 50 + s.jit) * 0.05 - 0.06, s.cz), _q, ONE);
        piece.mesh.setMatrixAt(k, _m);
        continue;
      }
      s.vy -= 27 * dt;
      s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;
      const wl = Math.hypot(s.wx, s.wy, s.wz);
      if (wl > 1e-4) { _q2.setFromAxisAngle(_v.set(s.wx / wl, s.wy / wl, s.wz / wl), wl * dt); s.q.premultiply(_q2); }
      if (!s.puffed && s.py < CLOUD_Y + 2.5) {
        s.puffed = true;
        if (Math.random() < 0.3 + 0.5 * fxMul) cloudPuff(s.px, s.pz, 0.5);
      }
      if (s.py < CLOUD_Y - 5) { s.done = true; piece.mesh.setMatrixAt(k, ZERO); continue; }
      _m.compose(_p.set(s.px, s.py, s.pz), s.q, ONE);
      piece.mesh.setMatrixAt(k, _m);
    }
    piece.mesh.instanceMatrix.needsUpdate = true;
    if (!any) hidePiece(piece);
  }

  // soft glow under the island
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: makeRadialTexture([[0, 'rgba(120,236,255,0.7)'], [0.62, 'rgba(96,226,255,0.62)'], [0.8, 'rgba(90,205,255,0.3)'], [1, 'rgba(90,200,255,0)']], 256),
      transparent: true, depthWrite: false, opacity: 0.9,
    }));
  halo.position.y = -2.4;
  halo.renderOrder = 1;
  scene.add(halo);

  // ── distant set pieces ───────────────────────────────────────────────
  const setRnd = mulberry32(555);
  const balloonDefs = [
    { a: 0.55, r: 96, y: 16, s: 1.0, c: ['#ff5a5f', '#fff1dc'] }, { a: 2.3, r: 150, y: 34, s: 1.3, c: ['#ffb400', '#3d8bff'] },
    { a: 3.85, r: 118, y: 9, s: 0.95, c: ['#00c2a8', '#fff1dc'] }, { a: 5.15, r: 205, y: 26, s: 1.5, c: ['#b46bff', '#ffd9a0'] },
    { a: 1.45, r: 270, y: 52, s: 1.7, c: ['#ff8a3d', '#fff1dc'] }, { a: 4.5, r: 84, y: 12, s: 0.8, c: ['#ff7ac8', '#f5e642'] },
  ];
  const balloons = balloonDefs.map((d) => {
    const m = new THREE.Mesh(balloonGeometry(C(d.c[0]).toArray(), C(d.c[1]).toArray()), plainMat);
    m.scale.setScalar(d.s);
    scene.add(m);
    return { m, ...d, ph: setRnd() * TAU };
  });

  const SHARDS = 14;
  const shards = new THREE.InstancedMesh(shardGeometry(), shardMat, SHARDS);
  shards.frustumCulled = false;
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(shards);
  const shardDefs = [];
  function layoutShards(r0) {
    const R = arenaRadius(r0), rnd = mulberry32(31 + r0);
    shardDefs.length = 0;
    for (let i = 0; i < SHARDS; i++) {
      const near = i < 8;
      const a = (i / (near ? 8 : SHARDS - 8)) * TAU + rnd() * 0.6;
      shardDefs.push({
        a, r: near ? R + 12 + rnd() * 18 : 120 + rnd() * 160, y: near ? -15 - rnd() * 14 : -26 + rnd() * 30,
        s: near ? 1.3 + rnd() * 2.2 : 4 + rnd() * 7, sy: 0.9 + rnd() * 0.9, rot: rnd() * TAU, ph: rnd() * TAU, sp: 0.2 + rnd() * 0.3,
      });
    }
  }

  const towerRnd = mulberry32(808);
  const TOWERS = 10;
  const towers = new THREE.InstancedMesh(towerGeometry(), plainMat, TOWERS);
  towers.frustumCulled = false;
  for (let i = 0; i < TOWERS; i++) {
    const a = (i / TOWERS) * TAU + towerRnd() * 0.5, r = 380 + towerRnd() * 700, s = 34 + towerRnd() * 40;
    _q.setFromAxisAngle(Y_AXIS, towerRnd() * TAU);
    _m.compose(_p.set(Math.cos(a) * r, CLOUD_Y - s * 0.2, Math.sin(a) * r), _q, _s.set(s * (1.5 + towerRnd() * 1.1), s * (0.55 + towerRnd() * 0.5), s * (1.5 + towerRnd() * 1.1)));
    towers.setMatrixAt(i, _m);
  }
  scene.add(towers);

  // drifting motes of ice dust in the low sun
  const MOTES = 240;
  const motePos = new Float32Array(MOTES * 3), moteSeed = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (setRnd() - 0.5) * 120; motePos[i * 3 + 1] = -8 + setRnd() * 26; motePos[i * 3 + 2] = (setRnd() - 0.5) * 120;
    moteSeed[i] = setRnd();
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(moteSeed, 1));
  const moteMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uScale: { value: 600 } },
    vertexShader: /* glsl */`
      attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
      void main() {
        vec3 p = position;
        p.x = mod( p.x + uTime * ( 0.6 + aSeed ) + 60.0, 120.0 ) - 60.0;
        p.y += sin( uTime * ( 0.2 + aSeed * 0.3 ) + aSeed * 40.0 ) * 2.0;
        p.z += cos( uTime * 0.17 + aSeed * 25.0 ) * 2.0;
        vec4 mv = viewMatrix * vec4( p, 1.0 );
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max( 1.5, uScale * ( 0.07 + 0.1 * aSeed ) / -mv.z );
        vA = 0.25 + 0.75 * abs( sin( uTime * ( 0.8 + aSeed * 2.0 ) + aSeed * 90.0 ) );
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() {
        float a = clamp( 1.0 - length( gl_PointCoord - 0.5 ) * 2.0, 0.0, 1.0 );
        a = a * a * vA * 0.7;
        gl_FragColor = vec4( vec3( 1.0, 0.93, 0.78 ), 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor = vec4( gl_FragColor.rgb * a, a * 0.5 );
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  motes.renderOrder = 5;
  scene.add(motes);

  // ── particles ────────────────────────────────────────────────────────
  const parts = makeParticles(1800);
  scene.add(parts.mesh);
  let fxMul = 1;

  function cloudPuff(x, z, scale) {
    const n = Math.max(3, Math.round(9 * scale * (0.5 + 0.5 * fxMul)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = (1.5 + Math.random() * 4.5) * scale;
      parts.emit(K_PUFF, x + Math.cos(a) * 0.8, CLOUD_Y + 1.2 + Math.random() * 1.5, z + Math.sin(a) * 0.8,
        Math.cos(a) * sp, 2.5 + Math.random() * 5 * scale, Math.sin(a) * sp,
        1.3 + Math.random() * 0.9, (2.2 + Math.random() * 1.6) * scale, 3.2 * scale,
        1, 0.92, 0.84, 0.95, 0, 2.5, 1.2, Math.random() * TAU, 0, 0, 1, 0);
    }
  }

  // ── bumper cars (instanced: one draw call per part for all cars) ─────
  const cars = new Map();
  const freeSlots = [];
  let slotHigh = 0;
  const instanced = (geo, mat, order) => {
    const m = new THREE.InstancedMesh(geo, mat, MAX_CARS);
    m.count = 0;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (order) m.renderOrder = order;
    scene.add(m);
    return m;
  };
  const shellMesh = instanced(shellGeometry(), carMat);
  shellMesh.castShadow = true;
  const antMesh = instanced(antennaGeometry(), carMat);
  antMesh.castShadow = true;
  const eyeMesh = instanced(eyesGeometry(), eyeMat);
  const pupilMesh = instanced(pupilGeometry(), unlitMat);
  const visorMesh = instanced(visorGeometry(), unlitMat);
  const blobMat = new THREE.MeshBasicMaterial({
    map: makeRadialTexture([[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,0.75)'], [1, 'rgba(255,255,255,0)']]),
    color: C('#07153a'), transparent: true, depthWrite: false, opacity: 0.4,
  });
  const blobMesh = instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blobMat, 2);
  const auraMesh = instanced(auraGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }), 3);
  const iceCubeMesh = instanced(iceCubeGeometry(), patchStandard(new THREE.MeshStandardMaterial({
    vertexColors: true, emissive: C('#3f86c2'), emissiveIntensity: 0.3, roughness: 0.08, metalness: 0,
    transparent: true, depthWrite: false,
  }), 'plain', shared), 4);
  const tinted = [shellMesh, antMesh, auraMesh];
  const allParts = [shellMesh, antMesh, eyeMesh, pupilMesh, visorMesh, blobMesh, auraMesh, iceCubeMesh];
  for (const m of tinted) m.setColorAt(0, _c.set(1, 1, 1));

  const meRing = new THREE.Mesh(meRingGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  meRing.renderOrder = 3;
  meRing.visible = false;
  scene.add(meRing);
  const meArrowGeo = new THREE.ConeGeometry(0.3, 0.56, 4);
  meArrowGeo.rotateX(Math.PI);
  const meArrow = new THREE.Mesh(meArrowGeo, new THREE.MeshStandardMaterial({ color: C(COL.gold), emissive: C(COL.gold), emissiveIntensity: 0.75, roughness: 0.4 }));
  meArrow.visible = false;
  scene.add(meArrow);

  const WHITE = new THREE.Color(1, 1, 1), ICE_TINT = C('#cfeaff');
  const ANT_BASE = new THREE.Vector3(-0.4, 0.81, 0);
  let stamp = 0;

  function createCar(id) {
    let slot = freeSlots.length ? freeSlots.pop() : slotHigh < MAX_CARS ? slotHigh++ : -1;
    if (slot < 0) return null;
    const cv = document.createElement('canvas');
    cv.width = TAG_W; cv.height = TAG_H;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.renderOrder = 20;
    sprite.visible = false;
    overlay.add(sprite);
    const idn = Number.isFinite(+id) ? Math.abs(Math.round(+id)) : 0;
    const car = {
      id, slot, name: '', colorIdx: idn % PALETTE.length, color: C(PALETTE[idn % PALETTE.length]), isMe: false, bot: false,
      visible: false, stamp: -1, seed: Math.random(),
      x: 0, z: 0, h: 0, face: 0, yaw: 0, st: 0,
      vx: 0, vz: 0, ax: 0, az: 0,
      lx: 0, lz: 0, lvx: 0, lvz: 0,          // lean spring
      q: 0, qv: 0,                           // squash spring
      antX: 0, antZ: 0, antVX: 0, antVZ: 0,  // antenna spring
      ox: 0, oz: 0,                          // local lead offset
      blink: 0, nextBlink: 1 + Math.random() * 4, lookS: 0, lookF: 0,
      spawnT: 0, fallT: 0, tAng: 0, tSpd: 0, tAxis: new THREE.Vector3(1, 0, 0), puffed: false,
      glow: 0, frozen: 0, wasFrozen: false, dashT: 0, sprayAcc: 0, trailAcc: 0,
      tagAlpha: 0, tagTop: 2.2, cdFrac: 0, cv, tex, sprite,
    };
    cars.set(id, car);
    return car;
  }

  function hideSlot(i) {
    for (const m of allParts) m.setMatrixAt(i, ZERO);
  }

  function upsertPlayer(id, info) {
    if (id == null) return;
    info = info || {};
    let car = cars.get(id), redraw = false;
    if (!car) { car = createCar(id); if (!car) return; redraw = true; }
    if (typeof info.name === 'string' && info.name !== car.name) { car.name = info.name.slice(0, 24); redraw = true; }
    if (Number.isFinite(info.color)) {
      const idx = ((Math.round(info.color) % PALETTE.length) + PALETTE.length) % PALETTE.length;
      if (idx !== car.colorIdx) { car.colorIdx = idx; car.color.set(PALETTE[idx]); redraw = true; }
    }
    if (info.isMe !== undefined && !!info.isMe !== car.isMe) { car.isMe = !!info.isMe; redraw = true; }
    if (info.bot !== undefined && !!info.bot !== car.bot) { car.bot = !!info.bot; redraw = true; }
    if (redraw) { drawTag(car.cv, car.name, PALETTE[car.colorIdx], car.isMe, car.bot); car.tex.needsUpdate = true; }
  }

  function removePlayer(id) {
    const car = cars.get(id);
    if (!car) return;
    hideSlot(car.slot);
    for (const m of allParts) m.instanceMatrix.needsUpdate = true;
    overlay.remove(car.sprite);
    car.sprite.material.dispose();
    car.tex.dispose();
    freeSlots.push(car.slot);
    cars.delete(id);
  }

  function startTumble(car) {
    const sp = Math.hypot(car.vx, car.vz);
    if (sp > 0.8) { car.tAxis.set(car.vz / sp, 0, -car.vx / sp); car.tSpd = Math.min(9, 3 + sp * 0.45); }
    else { const a = Math.random() * TAU; car.tAxis.set(Math.cos(a), 0.3, Math.sin(a)).normalize(); car.tSpd = 1.6 + Math.random(); }
    car.tAng = 0;
  }

  function readPlayers(dt, view) {
    stamp++;
    const list = Array.isArray(view.players) ? view.players : [];
    const inv = dt > 1e-4 ? 1 / dt : 0;
    for (const p of list) {
      if (!p || p.id == null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      let car = cars.get(p.id);
      if (!car) { car = createCar(p.id); if (!car) continue; }   // not in the roster yet: show it anyway
      const h = num(p.z, 0);
      car.stamp = stamp;
      car.st = p.st | 0;
      car.face = num(p.face, car.face);
      if (!car.visible) {
        car.visible = true;
        car.x = p.x; car.z = p.y; car.h = h; car.yaw = car.face;
        car.vx = car.vz = car.ax = car.az = 0;
        car.lx = car.lz = car.lvx = car.lvz = car.q = car.qv = 0;
        car.antX = car.antZ = car.antVX = car.antVZ = car.ox = car.oz = 0;
        car.spawnT = 0; car.fallT = 0; car.tAng = 0; car.puffed = false; car.dashT = 0; car.glow = 0;
        car.frozen = car.st & ST.FROZEN ? 1 : 0; car.wasFrozen = !!(car.st & ST.FROZEN);
        car.tagAlpha = 0;
        continue;
      }
      const dx = p.x - car.x, dz = p.y - car.z;
      if (dx * dx + dz * dz > 25) {     // teleported (respawn / new round)
        car.vx = car.vz = car.ax = car.az = 0; car.spawnT = 0; car.yaw = car.face;
      } else if (inv > 0) {
        const pvx = car.vx, pvz = car.vz, kv = damp(dt, 0.06), ka = damp(dt, 0.11);
        car.vx += (dx * inv - car.vx) * kv; car.vz += (dz * inv - car.vz) * kv;
        car.ax += ((car.vx - pvx) * inv - car.ax) * ka; car.az += ((car.vz - pvz) * inv - car.az) * ka;
      }
      car.x = p.x; car.z = p.y; car.h = h;
    }
    for (const car of cars.values()) if (car.stamp !== stamp) car.visible = false;
  }

  let vw = 1, vh = 1;           // CSS size of the canvas
  let myCar = null;

  function animateCars(dt, T, view) {
    const inp = view.input || {};
    const inx = clamp(num(inp.x, 0), -1, 1), iny = clamp(num(inp.y, 0), -1, 1);
    const inMag = Math.min(1, Math.hypot(inx, iny));
    const h = Math.min(dt, 0.033);
    const tanHalf = Math.tan((camera.fov * DEG) / 2);
    const shadowsOn = sun.castShadow;
    myCar = null;

    for (const car of cars.values()) {
      const i = car.slot;
      if (!car.visible) { hideSlot(i); car.sprite.visible = false; continue; }
      const st = car.st;
      const falling = (st & ST.FALLING) !== 0, frozen = (st & ST.FROZEN) !== 0 && !falling, charged = (st & ST.CHARGED) !== 0 && !falling;
      const me = car.isMe || (view.myId != null && car.id === view.myId);
      if (me) myCar = car;
      car.spawnT += dt;
      const pop = easeOutBack(clamp(car.spawnT / 0.38, 0, 1));

      if (falling) {
        if (car.fallT === 0) startTumble(car);
        car.fallT += dt;
        car.tAng += car.tSpd * dt;
        if (!car.puffed && car.h < CLOUD_Y + 2) { car.puffed = true; cloudPuff(car.x, car.z, 1); }
      } else if (car.fallT > 0) {
        car.fallT = 0; car.tAng = 0; car.puffed = false; car.spawnT = 0;
      }

      // heading: the local car turns with the input right away
      const control = me && inMag > 0.08 && !falling && !frozen;
      const tf = control ? Math.atan2(iny, inx) : car.face;
      car.yaw += angDiff(tf, car.yaw) * damp(dt, 0.055);

      // lean into the acceleration (the local car: straight from the input)
      let tx = 0, tz = 0;
      if (!falling && !frozen) {
        if (me) { tx = inx * 0.27; tz = iny * 0.27; }
        else { tx = clamp(car.ax * 0.017, -0.3, 0.3); tz = clamp(car.az * 0.017, -0.3, 0.3); }
      }
      const lk = me ? 300 : 170, lc = me ? 21 : 16;
      car.lvx += ((tx - car.lx) * lk - car.lvx * lc) * h; car.lx += car.lvx * h;
      car.lvz += ((tz - car.lz) * lk - car.lvz * lc) * h; car.lz += car.lvz * h;
      car.qv += (-car.q * 330 - car.qv * 13) * h; car.q = clamp(car.q + car.qv * h, -0.28, 0.42);
      car.antVX += (-car.antX * 95 - car.antVX * 3.4 - car.ax * 1.7) * h; car.antX = clamp(car.antX + car.antVX * h, -0.9, 0.9);
      car.antVZ += (-car.antZ * 95 - car.antVZ * 3.4 - car.az * 1.7) * h; car.antZ = clamp(car.antZ + car.antVZ * h, -0.9, 0.9);

      // position: the local car leads a little in the input direction
      const lead = control ? 0.15 : 0;
      car.ox += (inx * lead - car.ox) * damp(dt, 0.05);
      car.oz += (iny * lead - car.oz) * damp(dt, 0.05);
      const px = car.x + (me ? car.ox : 0), pz = car.z + (me ? car.oz : 0);
      const py = falling ? car.h : car.h + Math.sin(T * 2.3 + car.seed * 9) * 0.012;

      if (car.dashT > 0) car.dashT = Math.max(0, car.dashT - dt);
      const ds = smooth(car.dashT / (SIM.CHARGE_T + 0.1));
      let sc = pop;
      if (falling) sc *= lerp(1, 0.5, smooth(-car.h / 40));
      _s.set(sc * (1 + car.q * 0.42 + ds * 0.24), sc * (1 - car.q * 0.62 - ds * 0.08), sc * (1 + car.q * 0.42 - ds * 0.1));

      _q.setFromAxisAngle(Y_AXIS, -car.yaw);
      if (falling) { _q2.setFromAxisAngle(car.tAxis, car.tAng); _q.premultiply(_q2); }
      else {
        const ll = Math.hypot(car.lx, car.lz);
        if (ll > 1e-4) { _q2.setFromAxisAngle(_v.set(car.lz / ll, 0, -car.lx / ll), ll); _q.premultiply(_q2); }
      }
      _m.compose(_p.set(px, py, pz), _q, _s);
      shellMesh.setMatrixAt(i, _m);
      (car.m4 || (car.m4 = new THREE.Matrix4())).copy(_m);   // Heta paketet rides on this

      // colour: charge glow, frost
      const wantGlow = charged || car.dashT > 0.1 ? 1 : 0;
      car.glow += (wantGlow - car.glow) * damp(dt, wantGlow ? 0.03 : 0.16);
      car.frozen += ((frozen ? 1 : 0) - car.frozen) * damp(dt, 0.1);
      if (car.wasFrozen && !frozen && !falling) { car.frozen = 0; shatter(px, pz); car.qv += 5; }
      car.wasFrozen = frozen;
      _c.copy(car.color);
      if (car.glow > 0.01) { _c.lerp(WHITE, 0.1 * car.glow); _c.multiplyScalar(1 + 0.55 * car.glow); }
      if (car.frozen > 0.01) _c.lerp(ICE_TINT, 0.28 * car.frozen);
      shellMesh.setColorAt(i, _c);
      antMesh.setColorAt(i, _c);

      // face
      car.nextBlink -= dt;
      if (car.nextBlink <= 0) { car.blink = 0.16; car.nextBlink = 1.5 + Math.random() * 4.5; }
      if (car.blink > 0) car.blink = Math.max(0, car.blink - dt);
      const lid = falling ? 1 : 1 - 0.92 * Math.sin(clamp(car.blink / 0.16, 0, 1) * Math.PI);
      let ls = clamp(angDiff(tf, car.yaw) * 1.4, -1, 1), lf = clamp(Math.hypot(car.vx, car.vz) / 9, 0, 1) * 0.6;
      if (frozen) { ls = Math.sin(T * 1.9 + car.seed * 20) * 0.9; lf = 0.2; }
      if (falling) { ls = 0; lf = -1; }
      car.lookS += (ls - car.lookS) * damp(dt, 0.09);
      car.lookF += (lf - car.lookF) * damp(dt, 0.09);
      if (car.bot) {
        eyeMesh.setMatrixAt(i, ZERO); pupilMesh.setMatrixAt(i, ZERO);
        visorMesh.setMatrixAt(i, _m);
      } else {
        visorMesh.setMatrixAt(i, ZERO);
        const wide = falling ? 1.1 : 1;
        _m2.makeTranslation(0, EYE.y, 0).multiply(_m3.makeScale(1, lid * wide, 1)).multiply(_m3.makeTranslation(0, -EYE.y, 0));
        _m2.premultiply(_m);
        eyeMesh.setMatrixAt(i, _m2);
        _m2.multiply(_m3.makeTranslation(GAZE.y * 0.045 * car.lookF, -GAZE.x * 0.045 * car.lookF, 0.05 * car.lookS));
        pupilMesh.setMatrixAt(i, _m2);
      }

      // antenna: tilt (world) converted to the car's own frame
      const cf = Math.cos(car.yaw), sf = Math.sin(car.yaw);
      const alx = car.antX * cf + car.antZ * sf, alz = -car.antX * sf + car.antZ * cf;
      _q2.setFromAxisAngle(_v.set(0, 0, 1), 0.22 - alx);
      _q.setFromAxisAngle(_v.set(1, 0, 0), alz).multiply(_q2);
      _m2.compose(ANT_BASE, _q, ONE).premultiply(_m);
      antMesh.setMatrixAt(i, _m2);

      // ground decals
      if (!falling && car.h > -0.5) {
        const bs = 2.5 * pop * (1 + car.q * 0.3);
        _m2.makeScale(bs, 1, bs).setPosition(px + (shadowsOn ? 0 : 0.12), 0.03, pz + (shadowsOn ? 0 : 0.1));
        blobMesh.setMatrixAt(i, _m2);
      } else blobMesh.setMatrixAt(i, ZERO);
      if (car.glow > 0.03 && !falling) {
        const as = 0.6 + 0.4 * car.glow;
        _q.setFromAxisAngle(Y_AXIS, T * 7 + car.seed * 9);
        _m2.compose(_p.set(px, 0.06, pz), _q, _s.set(as, 1, as));
        auraMesh.setMatrixAt(i, _m2);
        auraMesh.setColorAt(i, _c.copy(car.color).lerp(WHITE, 0.45));
      } else auraMesh.setMatrixAt(i, ZERO);
      if (car.frozen > 0.02) {
        const fs = easeOutBack(clamp(car.frozen, 0, 1));
        _q.setFromAxisAngle(Y_AXIS, car.seed * 6);
        _m2.compose(_p.set(px, 0, pz), _q, _s.set(fs, fs, fs));
        iceCubeMesh.setMatrixAt(i, _m2);
      } else iceCubeMesh.setMatrixAt(i, ZERO);

      // name tag: world sized, but never smaller than a readable pixel height
      const tagWant = falling ? 0 : 1;
      car.tagAlpha += (tagWant - car.tagAlpha) * damp(dt, falling ? 0.12 : 0.2);
      if (car.name && car.tagAlpha > 0.02) {
        const dist = Math.max(1, _v.set(px, py + 1.6, pz).distanceTo(camera.position));
        const pxPerM = vh / (2 * dist * tanHalf);
        const minPx = clamp(Math.min(vw, vh) * 0.031, 14, 23) * (TAG_H / 68);
        const hq = clamp(minPx / pxPerM, 0.8, 3.2) * (me ? 1.12 : 1);
        car.sprite.visible = true;
        car.sprite.position.set(px, py + 1.3 * sc + hq * 0.5, pz);
        car.sprite.scale.set(hq * (TAG_W / TAG_H), hq, 1);
        car.sprite.material.opacity = car.tagAlpha;
        car.sprite.renderOrder = me ? 22 : 20;
        car.tagTop = py + 1.3 * sc + hq * 0.86;
      } else { car.sprite.visible = false; car.tagTop = py + 1.9; }

      // trails and spray
      if (!falling && !frozen) {
        const spd = Math.hypot(car.vx, car.vz);
        if (car.dashT > 0 && spd > 2) {
          car.trailAcc += dt * 70 * fxMul;
          const bx = -Math.cos(car.yaw), bz = -Math.sin(car.yaw);
          while (car.trailAcc >= 1) {
            car.trailAcc -= 1;
            const jx = (Math.random() - 0.5) * 0.7, jz = (Math.random() - 0.5) * 0.7;
            parts.emit(K_SOFT, px + bx * 0.5 + jx, 0.35 + Math.random() * 0.4, pz + bz * 0.5 + jz, car.vx * 0.15, 0.3, car.vz * 0.15,
              0.34 + Math.random() * 0.2, 0.55, -1.1, car.color.r * 1.6 + 0.25, car.color.g * 1.6 + 0.25, car.color.b * 1.6 + 0.25, 0.85, 0.3, 0, 1, 0, 0, 0, 0, 0);
            if (Math.random() < 0.5) {
              parts.emit(K_STREAK, px + bx * 0.6 + jx, 0.2 + Math.random() * 0.5, pz + bz * 0.6 + jz, -car.vx * 0.3 + jx * 3, 0.5 + Math.random(), -car.vz * 0.3 + jz * 3,
                0.22 + Math.random() * 0.15, 0.05, 0, 2.2, 2.0, 1.4, 0.9, 0.4, 3, 2, 0, 0, 0.05, 0, 0);
            }
          }
        }
        const push = me ? inMag : clamp((Math.hypot(car.ax, car.az) - 5) / 12, 0, 1);
        if (push > 0.15 && (me || fxMul > 0.5)) {
          car.sprayAcc += dt * (me ? 34 : 12) * push * fxMul;
          let dx = me ? inx : car.ax, dz = me ? iny : car.az;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl; dz /= dl;
          while (car.sprayAcc >= 1) {
            car.sprayAcc -= 1;
            const sx = (Math.random() - 0.5) * 0.9, sz = (Math.random() - 0.5) * 0.9;
            parts.emit(K_CHIP, px - dx * 0.75 + sx * 0.5, 0.08, pz - dz * 0.75 + sz * 0.5, -dx * (2 + Math.random() * 3) + sx * 2, 1 + Math.random() * 2.2, -dz * (2 + Math.random() * 3) + sz * 2,
              0.3 + Math.random() * 0.25, 0.05 + Math.random() * 0.05, 0, 0.78, 0.92, 1, 0.9, 0, 12, 1.5, Math.random() * 6, 8, 0, 0, 0);
          }
        }
      }
    }

    const n = slotHigh;
    for (const m of allParts) { m.count = n; m.instanceMatrix.needsUpdate = true; }
    for (const m of tinted) if (m.instanceColor) m.instanceColor.needsUpdate = true;

    // the local player's marker
    const mc = myCar;
    if (mc && mc.visible && !(mc.st & ST.FALLING)) {
      const px = mc.x + mc.ox, pz = mc.z + mc.oz;
      const ready = mc.cdFrac <= 0.001;
      const pulse = 1 + Math.sin(T * 5) * 0.045;
      meRing.visible = true;
      meRing.position.set(px, 0.045, pz);
      meRing.rotation.y = T * 1.3;
      meRing.scale.setScalar(pulse * easeOutBack(clamp(mc.spawnT / 0.38, 0, 1)));
      meRing.material.opacity = ready ? 1 : 0.55;
      meArrow.visible = true;
      meArrow.position.set(px, (mc.tagTop || 2.2) + 0.42 + Math.sin(T * 4.2) * 0.12, pz);
      meArrow.rotation.y = T * 2.2;
    } else { meRing.visible = false; meArrow.visible = false; }
  }

  // ── effects ──────────────────────────────────────────────────────────
  function shatter(x, z) {
    const n = Math.round(16 * fxMul) + 4;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = 2 + Math.random() * 5;
      parts.emit(K_CHIP, x + Math.cos(a) * 0.7, 0.3 + Math.random() * 1.1, z + Math.sin(a) * 0.7, Math.cos(a) * sp, 2 + Math.random() * 4.5, Math.sin(a) * sp,
        0.55 + Math.random() * 0.5, 0.09 + Math.random() * 0.12, 0, 0.8, 0.93, 1, 0.95, 0, 17, 0.6, Math.random() * 6, 9, 0, 0, 1);
    }
    parts.emit(K_RING, x, 0.07, z, 0, 0, 0, 0.3, 0.9, 6, 0.75, 0.93, 1, 0.8, 0.1, 0, 0, 0, 0, 0.2, 0, 0);
  }

  const fx = {
    hit(x, y, strength) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const s = clamp((num(strength, 4) - 2) / 26, 0, 1);
      const n = Math.round((5 + 36 * s) * fxMul);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, el = Math.random() * 1.0, sp = (3 + 13 * s) * (0.35 + Math.random() * 0.85);
        parts.emit(K_STREAK, x, 0.55, y, Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp * 0.8 + 1, Math.sin(a) * Math.cos(el) * sp,
          0.2 + Math.random() * 0.3 + s * 0.2, 0.045 + 0.05 * s, 0, 2.6, 1.9 + Math.random() * 0.5, 0.7, 1, 0.35, 15, 2.2, 0, 0, 0.035, 0, 0);
      }
      const life = 0.22 + 0.26 * s;
      parts.emit(K_RING, x, 0.08, y, 0, 0, 0, life, 0.7, (2 + 9 * s) / life, 1, 0.84, 0.4, 0.95, 0.15, 0, 0, 0, 0, 0.24, 0, 0);
      parts.emit(K_SOFT, x, 0.7, y, 0, 0, 0, 0.09 + 0.07 * s, 0.7 + 1.3 * s, 3, 1.8, 1.65, 1.25, 0.75, 0.6, 0, 0, 0, 0, 0, 0, 0);
      if (s > 0.28) {
        parts.emit(K_STAR, x, 1.0, y, 0, 0.6, 0, 0.18 + 0.12 * s, 0.55 + 1.05 * s, 2.2, 1, 0.8, 0.14, 0.95, 0.1, 0, 0, Math.random() * TAU, (Math.random() - 0.5) * 3, 0, 2, 0);
      }
      const chips = Math.round(12 * s * fxMul);
      for (let i = 0; i < chips; i++) {
        const a = Math.random() * TAU, sp = 2 + Math.random() * 6 * s;
        parts.emit(K_CHIP, x, 0.2, y, Math.cos(a) * sp, 2 + Math.random() * 5 * s, Math.sin(a) * sp,
          0.5 + Math.random() * 0.4, 0.06 + Math.random() * 0.07, 0, 0.8, 0.93, 1, 0.95, 0, 17, 0.6, Math.random() * 6, 9, 0, 0, 1);
      }
      // squash and rock the bodies around the contact
      const reach = SIM.PLAYER_R * 1.7;
      for (const car of cars.values()) {
        if (!car.visible || car.st & ST.FALLING) continue;
        const dx = car.x - x, dz = car.z - y, d = Math.hypot(dx, dz);
        if (d > reach) continue;
        const k = 1 - d / reach * 0.5;
        car.qv += (2.6 + 6 * s) * k;
        const inv = d > 1e-3 ? 1 / d : 0;
        car.lvx += dx * inv * (0.9 + 2.6 * s); car.lvz += dz * inv * (0.9 + 2.6 * s);
        car.antVX += dx * inv * (3 + 8 * s); car.antVZ += dz * inv * (3 + 8 * s);
        if (s > 0.2) car.blink = 0.16;
      }
    },
    dash(id) {
      const car = cars.get(id);
      if (!car || !car.visible) return;
      car.dashT = SIM.CHARGE_T + 0.1;
      car.glow = 1;
      const fxd = Math.cos(car.yaw), fzd = Math.sin(car.yaw), c = car.color;
      parts.emit(K_RING, car.x, 0.07, car.z, 0, 0, 0, 0.32, 0.9, 9, c.r * 1.2 + 0.2, c.g * 1.2 + 0.2, c.b * 1.2 + 0.2, 0.95, 0.15, 0, 0, 0, 0, 0.2, 0, 0);
      const n = Math.round(16 * fxMul) + 3;
      for (let i = 0; i < n; i++) {
        const sp = 3 + Math.random() * 7, side = (Math.random() - 0.5) * 1.5;
        parts.emit(K_CHIP, car.x - fxd * 0.7, 0.1, car.z - fzd * 0.7, -fxd * sp - fzd * side * 3, 1 + Math.random() * 3.5, -fzd * sp + fxd * side * 3,
          0.4 + Math.random() * 0.35, 0.06 + Math.random() * 0.07, 0, 0.8, 0.93, 1, 0.95, 0, 14, 1.2, Math.random() * 6, 9, 0, 0, 0);
      }
    },
    fall(id) {
      const car = cars.get(id);
      if (!car || !car.visible) return;
      const d = Math.hypot(car.x, car.z) || 1, ox = car.x / d, oz = car.z / d;
      const n = Math.round(10 * fxMul) + 3;
      for (let i = 0; i < n; i++) {
        const sp = 1 + Math.random() * 4, side = (Math.random() - 0.5) * 3;
        parts.emit(K_CHIP, car.x - ox * 0.5, 0.05, car.z - oz * 0.5, ox * sp - oz * side, 1.5 + Math.random() * 3, oz * sp + ox * side,
          0.5 + Math.random() * 0.4, 0.06 + Math.random() * 0.08, 0, 0.8, 0.93, 1, 0.95, 0, 17, 0.6, Math.random() * 6, 9, 0, 0, 0);
      }
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * TAU;
        parts.emit(K_PUFF, car.x + Math.cos(a) * 0.5, 0.3, car.z + Math.sin(a) * 0.5, Math.cos(a) * 1.5 + ox * 2, 0.8 + Math.random(), Math.sin(a) * 1.5 + oz * 2,
          0.5 + Math.random() * 0.3, 0.5, 1.6, 0.86, 0.93, 1, 0.7, 0, 0, 2, Math.random() * TAU, 0, 0, 1, 0);
      }
      car.qv -= 3;
    },
    confetti(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const n = Math.round(150 * fxMul) + 20;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = 2 + Math.random() * 7.5;
        _c.set(PALETTE[(Math.random() * PALETTE.length) | 0]);
        parts.emit(K_CONF, x + Math.cos(a) * 0.4, 1.6 + Math.random() * 1.5, y + Math.sin(a) * 0.4, Math.cos(a) * sp, 8 + Math.random() * 9, Math.sin(a) * sp,
          2.4 + Math.random() * 1.6, 0.13 + Math.random() * 0.1, 0, _c.r * 1.15, _c.g * 1.15, _c.b * 1.15, 1, 0, 9, 1.7,
          Math.random() * TAU, (Math.random() - 0.5) * 9, Math.random() * TAU, 2, 1);
      }
      parts.emit(K_SOFT, x, 2.4, y, 0, 0, 0, 0.22, 1.6, 7, 1.8, 1.65, 1.25, 0.6, 0.6, 0, 0, 0, 0, 0, 0, 0);
    },
    shake(amount) {
      cam.shake = Math.max(cam.shake, clamp(num(amount, 0), 0, 1));
    },
  };

  // ── arena state ──────────────────────────────────────────────────────
  function setArena(r0) {
    r0 = clamp(Math.round(num(+r0, SIM.LOBBY_RINGS)), 0, MAX_RINGS);
    for (const [key, piece] of pieces) if (key !== 'hub' && key >= r0) hidePiece(piece);
    for (let i = -1; i < r0; i++) for (const piece of piecesAt(i)) startRise(piece, (i + 1) * 0.04);
    if (arena.r0 !== r0 || shardDefs.length === 0) layoutShards(r0);
    arena.r0 = r0; arena.live = r0; arena.synced = false;
    const R = arenaRadius(r0) + 2.5, sc = sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R;
    sc.updateProjectionMatrix();
  }

  function updateArena(dt, T, view) {
    let rings = clamp(Math.round(num(view.rings, arena.live)), -1, MAX_RINGS);
    if (rings > arena.r0) setArena(rings);
    if (!arena.synced) {
      for (let i = arena.r0 - 1; i >= rings; i--) for (const piece of piecesAt(i)) hidePiece(piece);
      arena.live = rings; arena.synced = true;
    } else if (rings < arena.live) {
      for (let i = arena.live - 1; i >= rings; i--) for (const piece of piecesAt(i)) startFall(piece, (arena.live - 1 - i) * 0.1);
      cam.shake = Math.max(cam.shake, rings < 0 ? 0.5 : 0.3);
      arena.live = rings;
    } else if (rings > arena.live) {
      for (let i = arena.live; i < rings; i++) for (const piece of piecesAt(i)) startRise(piece, 0);
      arena.live = rings;
    }
    // warning on the piece that falls next
    const warnIn = num(view.warnIn, -1);
    const warning = warnIn >= 0 && warnIn <= SIM.WARN_T && arena.live >= 0;
    let ramp = 0, level = 0;
    if (warning) {
      ramp = 1 - warnIn / SIM.WARN_T;
      arena.warnPhase += dt * TAU * (1.5 + 4.8 * ramp * ramp);
      const pulse = 0.5 - 0.5 * Math.cos(arena.warnPhase);
      level = (0.34 + 0.66 * pulse) * (0.65 + 0.35 * ramp);
    } else arena.warnPhase = 0;
    const target = warning ? arena.live - 1 : -99;
    for (const piece of pieces.values()) {
      const on = piece.idx === target && piece.state === 'intact';
      piece.warn = on ? level : 0;
      piece.ramp = on ? ramp : 0;
      updatePiece(piece, dt, T);
    }
  }

  // ── cameras ──────────────────────────────────────────────────────────
  const cam = {
    w: hostScreen ? 1 : 0, orbit: hostScreen ? 0.7 : 0,
    tp: new THREE.Vector3(), ts: new THREE.Vector3(), dp: 42, ds: 46, vs: 12,
    radius: arenaRadius(SIM.LOBBY_RINGS), shake: 0, snap: true,
  };
  const P_ELEV = 55 * DEG, P_FOV = 40, S_FOV = 54, S_LIFT = 3 * DEG;
  // On the host screen the scoreboard fills the right edge: the spectator picture is
  // shifted left by HOST_SHIFT of the width and framed inside what is left.
  // In the lobby (phase 0) the join panel also fills the left third, so the arena
  // goes in the gap between the two.
  const HOST_SHIFT = 0.13, HOST_LAT = 0.64, LOBBY_SHIFT = -0.025, LOBBY_LAT = 0.31;
  let viewShift = 0, shiftF = 0;

  /** Smallest distance at which a ground circle of radius V around the target is in frame. */
  function fitDist(V, elev, pitch, fovDeg, aspect, latMax = 0.93, upMin = -0.9) {
    const tv = Math.tan((fovDeg * DEG) / 2), th = tv * aspect;
    const sE = Math.sin(elev), cE = Math.cos(elev), sP = Math.sin(pitch), cP = Math.cos(pitch);
    const fits = (d) => {
      const hgt = d * sE, g = d * cE;
      for (let k = 0; k <= 4; k++) {
        const th2 = (k / 4) * Math.PI, gx = g - V * Math.cos(th2), lat = V * Math.sin(th2);
        const depth = gx * cP + hgt * sP;
        if (depth < 1) return false;
        const up = (gx * sP - hgt * cP) / (depth * tv);
        if (up > 0.74 || up < upMin) return false;
        if (lat / (depth * th) > latMax) return false;
      }
      return true;
    };
    let lo = V * 0.4, hi = V * 20;
    for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return hi;
  }

  function updateCamera(dt, T, view) {
    const R = arenaRadius(Math.max(0, arena.live));
    cam.radius += (R - cam.radius) * (cam.snap ? 1 : damp(dt, 1.0));
    const Rr = cam.radius, aspect = camera.aspect;

    // player rig: fixed orientation, follows the local car but keeps the arena in view
    const narrow = 0.62 + 0.38 * clamp(aspect, 0.45, 1);   // portrait screens: show a little less, follow a little more
    const V = Math.min(Rr + 1.6, (0.5 * Rr + 7.6) * narrow);
    const follow = clamp((Rr + 1.6 - V) / Math.max(Rr, 1), 0, 1);
    const me = myCar;
    if (me && me.visible && !(me.st & ST.FALLING)) _v.set(me.x * follow, 0, me.z * follow);
    else _v.copy(cam.tp);
    cam.tp.lerp(_v, cam.snap ? 1 : damp(dt, 0.2));
    const dP = fitDist(V, P_ELEV, P_ELEV, P_FOV, aspect);
    cam.dp += (dP - cam.dp) * (cam.snap ? 1 : damp(dt, 0.6));

    // spectator rig: slow orbit that keeps the standing cars framed
    let sx = 0, sz = 0, n = 0;
    for (const car of cars.values()) if (car.visible && !(car.st & ST.FALLING)) { sx += car.x; sz += car.z; n++; }
    let spread = 0;
    if (n > 0) {
      sx /= n; sz /= n;
      for (const car of cars.values()) if (car.visible && !(car.st & ST.FALLING)) spread = Math.max(spread, Math.hypot(car.x - sx, car.z - sz));
    }
    const Vs = n > 0 ? clamp(Math.max(spread + 3.6, Math.min(Rr + 1.5, 0.7 * Rr + 4)), 7, Rr + 2.6) : Rr + 2;
    const pull = n > 0 ? 0.5 : 0;
    cam.ts.lerp(_v.set(sx * pull, 0, sz * pull), cam.snap ? 1 : damp(dt, 1.2));
    cam.vs += (Vs - cam.vs) * (cam.snap ? 1 : damp(dt, 1.3));
    const sElev = (31 + 4 * Math.sin(T * 0.11)) * DEG;
    const shiftOn = hostScreen && aspect > 1.25;
    const inLobby = view.phase === 0;
    const dS = fitDist(cam.vs, sElev, sElev - S_LIFT, S_FOV, aspect, shiftOn ? (inLobby ? LOBBY_LAT : HOST_LAT) : 0.93, -0.8);
    const shiftWant = shiftOn ? (inLobby ? LOBBY_SHIFT : HOST_SHIFT) : 0;
    shiftF += (shiftWant - shiftF) * (cam.snap ? 1 : damp(dt, 0.7));
    cam.ds += (dS - cam.ds) * (cam.snap ? 1 : damp(dt, 0.9));

    const want = view.spectate ? 1 : 0;
    if (cam.snap) cam.w = want;
    else cam.w = clamp(cam.w + (want > cam.w ? 1 : -1) * dt / 1.6, 0, 1);
    if (want) cam.orbit += dt * 0.075;
    else if (cam.w <= 0) cam.orbit = 0;
    const w = smooth(cam.w);
    const yaw = angDiff(cam.orbit, 0) * w;
    const elev = lerp(P_ELEV, sElev, w), pitch = lerp(P_ELEV, sElev - S_LIFT, w), dist = lerp(cam.dp, cam.ds, w);
    const fov = lerp(P_FOV, S_FOV, w);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    const shift = shiftOn ? Math.round(shiftF * w * vw) : 0;
    if (shift !== viewShift || (shift && (camera.view?.fullWidth !== vw || camera.view?.fullHeight !== vh))) {
      viewShift = shift;
      if (shift) camera.setViewOffset(vw, vh, shift, 0, vw, vh);
      else camera.clearViewOffset();
    }
    _p.lerpVectors(cam.tp, cam.ts, w);
    const cE = Math.cos(elev), sE = Math.sin(elev), sy = Math.sin(yaw), cy = Math.cos(yaw);
    camera.position.set(_p.x + dist * cE * sy, dist * sE, _p.z + dist * cE * cy);
    const cP = Math.cos(pitch), sP = Math.sin(pitch);
    _v.set(camera.position.x - sy * cP, camera.position.y - sP, camera.position.z - cy * cP);
    camera.up.set(0, 1, 0);
    camera.lookAt(_v);
    if (cam.shake > 0.001) {      // translate only: the player camera never rotates
      const a = cam.shake * cam.shake * 0.7;
      camera.position.x += (Math.sin(T * 61.7) + Math.sin(T * 37.3 + 1.3)) * 0.5 * a * cy;
      camera.position.z -= (Math.sin(T * 61.7) + Math.sin(T * 37.3 + 1.3)) * 0.5 * a * sy;
      camera.position.y += (Math.sin(T * 53.1 + 2.1) + Math.sin(T * 41.9)) * 0.5 * a;
      cam.shake = Math.max(0, cam.shake - dt * (1.6 + cam.shake * 2.5));
    } else cam.shake = 0;
    cam.snap = false;
  }

  // ── minigolf ─────────────────────────────────────────────────────────
  // Everything golf lives in golfGroup; sky, clouds, light, set pieces and particles are shared.
  // Sim (x, y) -> world (X, Z). A sim angle a is a world rotation.y of -a.
  const golfGroup = new THREE.Group();
  golfGroup.visible = false;
  scene.add(golfGroup);
  let curGame = GAME.KNUFF;
  const savedShadow = { l: 0, r: 0, t: 0, b: 0 };
  const BR = GOLF.BALL_R, WT = GOLF.WALL_T;
  const feltMat = patchStandard(new THREE.MeshStandardMaterial({ map: makeFeltTexture(), roughness: 0.93, metalness: 0 }), 'plain', shared);
  const propMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0 }), 'plain', shared);
  const golfIceMat = makeIceMat();
  const decal = (color, extra) => new THREE.MeshBasicMaterial({ color: C(color), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra });
  const flatGeo = (geo) => geo.rotateX(-Math.PI / 2);
  const goldRingGeo = meRingGeometry().scale(0.36, 1, 0.36);
  const unitBlobGeo = flatGeo(new THREE.PlaneGeometry(1, 1));
  const ballBlobMat = new THREE.MeshBasicMaterial({ map: blobMat.map, color: C('#06233a'), transparent: true, depthWrite: false, opacity: 0.42 });

  // ---- shared prop geometry
  const RAIL_TOP = [1, 0.96, 0.88], RAIL_SIDE = [0.5, 0.68, 0.98], CORAL = [1, 0.33, 0.36], CREAM = [1, 0.95, 0.86], GOLDC = [1, 0.8, 0.18];
  const bumperGeo = (() => {
    // rows: rubber foot, coral body, white band, gold dome (duplicated rows keep the bands crisp)
    const prof = [[0.001, 0], [1, 0], [1.05, 0.07], [1.05, 0.1], [1.05, 0.28], [1.0, 0.33], [0.98, 0.34], [0.86, 0.42], [0.84, 0.43], [0.52, 0.5], [0.001, 0.52]];
    const cols = [[0.1, 0.1, 0.15], [0.1, 0.1, 0.15], [0.1, 0.1, 0.15], CORAL, CORAL, CORAL, CREAM, CREAM, GOLDC, GOLDC, [1, 0.9, 0.5]];
    const per = prof.length;
    return painted(new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), 28), (x, y, z, i) => cols[i % per]);
  })();
  const sailGeo = (() => {
    const parts = [];
    for (let k = 0; k < 4; k++) {
      const b = new THREE.BoxGeometry(0.15, 0.6, 0.03).translate(0, 0.36, 0).rotateZ(k * Math.PI / 2 + Math.PI / 4);
      parts.push(paintedFaces(b, (x, y) => (Math.hypot(x, y) > 0.5 ? CORAL : CREAM)));
    }
    parts.push(paintedFaces(new THREE.CylinderGeometry(0.08, 0.08, 0.08, 10).rotateX(Math.PI / 2), flat(GOLDC)));
    return mergeGeometries(parts);
  })();
  const flagPoleGeo = mergeGeometries([
    paintedFaces(new THREE.CylinderGeometry(0.04, 0.04, 2.8, 8, 10).translate(0, 1.4, 0), (x, y) => (Math.floor(y / 0.25) % 2 ? CORAL : CREAM)),
    paintedFaces(new THREE.SphereGeometry(0.09, 10, 8).translate(0, 2.82, 0), flat(GOLDC)),
  ]);
  const ballGeo = new THREE.SphereGeometry(BR, 28, 18);

  // ---- course state
  const G = {
    ci: -1, course: null, isle: null, leaving: [], bounds: null,
    bumpers: [], spinners: [], boosts: [], flag: null, cupGlow: null,
    balls: new Map(), stamp: 0, me: null, warned: new Set(), pending: [],
  };

  function shapeOutline(s) {
    const x0 = num(+s.x, 0), y0 = num(+s.y, 0), pts = [];
    if (s.k === 'circle') {
      const r = num(+s.r, 0);
      if (!(r > 0.05)) return null;
      const n = clamp(Math.ceil(r * 7), 18, 64);
      for (let k = 0; k < n; k++) { const a = (k / n) * TAU; pts.push([x0 + Math.cos(a) * r, y0 + Math.sin(a) * r]); }
      return { pts, cx: x0, cy: y0, small: 2 * r, big: 2 * r };
    }
    const w = num(+s.w, 0), h = num(+s.h, 0), a = num(+s.a, 0), c = Math.cos(a), n = Math.sin(a);
    if (!(w > 0.05 && h > 0.05)) return null;
    const cr = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    for (let i = 0; i < 4; i++) {
      const p = cr[i], q = cr[(i + 1) % 4], segs = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 1.6));
      for (let k = 0; k < segs; k++) {
        const lx = lerp(p[0], q[0], k / segs), ly = lerp(p[1], q[1], k / segs);
        pts.push([x0 + lx * c - ly * n, y0 + lx * n + ly * c]);
      }
    }
    return { pts, cx: x0, cy: y0, small: Math.min(w, h), big: Math.max(w, h) };
  }

  function buildIsle(course, ci) {
    const isle = new THREE.Group(), own = [];
    const keep = (x) => { own.push(x); return x; };
    const rnd = mulberry32(9000 + ci * 31);
    // felt tops (fans; overlapping shapes share depth and colour, so overlaps are invisible) and ice bodies
    const fp = [], fu = [], bodies = [];
    for (const s of Array.isArray(course.ground) ? course.ground : []) {
      if (!s) continue;
      const o = shapeOutline(s);
      if (!o) continue;
      const { pts, cx, cy } = o, M = pts.length;
      for (let k = 0; k < M; k++) {
        const a = pts[k], b = pts[(k + 1) % M];
        const ccw = (a[0] - cx) * (b[1] - cy) - (a[1] - cy) * (b[0] - cx) > 0;   // in X/Z: up-facing needs cw in this sense
        const tri = ccw ? [[cx, cy], b, a] : [[cx, cy], a, b];
        for (const v of tri) { fp.push(v[0], 0, v[1]); fu.push(v[0] / 4, v[1] / 4); }
      }
      const D = clamp(o.small * 0.42 + o.big * 0.07, 1.6, 6), E = 0.75;
      const inset = (f, y, jit) => ({ y, pts: pts.map((p) => { const j = f * (1 + (rnd() - 0.5) * jit); return [cx + (p[0] - cx) * j, cy + (p[1] - cy) * j]; }) });
      bodies.push(prismGeometry([{ y: -0.015, pts }, { y: -E, pts }, inset(0.8, -E - D * 0.42, 0.1), inset(0.46, -E - D * 0.85, 0.18)],
        [cx + (rnd() - 0.5) * 0.6, -E - D * 1.3, cy + (rnd() - 0.5) * 0.6], 0));
    }
    if (fp.length) {
      const g = keep(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(fu, 2));
      const nrm = new Float32Array(fp.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      const top = new THREE.Mesh(g, feltMat);
      top.receiveShadow = true;
      isle.add(top);
      const bg = keep(bodies.length > 1 ? mergeGeometries(bodies) : bodies[0]);
      if (bodies.length > 1) for (const b of bodies) b.dispose();
      bg.setAttribute('aUvOff', new THREE.BufferAttribute(new Float32Array(bg.attributes.position.count * 2), 2));
      isle.add(new THREE.Mesh(bg, golfIceMat));
    }

    // rails: chunky boxes with round posts at the ends
    const H = 0.34, railParts = [];
    const railPaint = (x, y) => (y > H - 0.01 ? RAIL_TOP : RAIL_SIDE);
    for (const w of Array.isArray(course.walls) ? course.walls : []) {
      if (!w || ![0, 1, 2, 3].every((i) => Number.isFinite(w[i]))) continue;
      const dx = w[2] - w[0], dy = w[3] - w[1], L = Math.hypot(dx, dy);
      if (L > 1e-3) {
        railParts.push(paintedFaces(new THREE.BoxGeometry(L, H, 2 * WT).rotateY(-Math.atan2(dy, dx)).translate((w[0] + w[2]) / 2, H / 2, (w[1] + w[3]) / 2), railPaint));
      }
      for (const e of [0, 2]) railParts.push(paintedFaces(new THREE.CylinderGeometry(WT * 1.15, WT * 1.15, H + 0.04, 14).translate(w[e], (H + 0.04) / 2, w[e + 1]), (x, y) => (y > H ? CREAM : RAIL_SIDE)));
    }
    if (railParts.length) {
      const rails = new THREE.Mesh(keep(mergeGeometries(railParts)), propMat);
      for (const p of railParts) p.dispose();
      rails.castShadow = true; rails.receiveShadow = true;
      isle.add(rails);
    }

    // bumpers
    const bumpers = [];
    for (const b of Array.isArray(course.bumpers) ? course.bumpers : []) {
      if (!b || !Number.isFinite(b[0]) || !Number.isFinite(b[1]) || !(b[2] > 0)) continue;
      const m = new THREE.Mesh(bumperGeo, propMat);
      m.position.set(b[0], 0, b[1]);
      m.scale.set(b[2], 1, b[2]);
      m.castShadow = true;
      isle.add(m);
      bumpers.push({ m, x: b[0], y: b[1], r: b[2], q: 0, qv: 0 });
    }

    // spinners: a little windmill whose arms are the bar
    const spinners = [];
    for (const s of Array.isArray(course.spinners) ? course.spinners : []) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !(s.len > 0)) continue;
      const root = new THREE.Group(), rot = new THREE.Group();
      root.position.set(s.x, 0, s.y);
      root.add(rot);
      const nseg = Math.max(2, 2 * Math.round(s.len / 0.9));
      const bar = paintedFaces(new THREE.BoxGeometry(s.len, 0.28, 2 * WT, nseg, 1, 1).translate(0, 0.17, 0),
        (x) => (Math.floor((x + s.len / 2) / (s.len / nseg)) % 2 ? CREAM : CORAL));
      const post = paintedFaces(new THREE.CylinderGeometry(0.2, 0.27, 1.05, 10).translate(0, 0.525, 0), flat(CREAM));
      const roof = paintedFaces(new THREE.ConeGeometry(0.42, 0.5, 8).translate(0, 1.3, 0), flat(CORAL));
      const geo = keep(mergeGeometries([bar, post, roof]));
      bar.dispose(); post.dispose(); roof.dispose();
      const mesh = new THREE.Mesh(geo, propMat);
      mesh.castShadow = true;
      rot.add(mesh);
      const sails = new THREE.Mesh(sailGeo, propMat);
      sails.position.set(0, 0.9, 0.3);
      sails.castShadow = true;
      rot.add(sails);
      isle.add(root);
      spinners.push({ s, root, rot, sails, wob: 0, phase: num(+s.phase, 0), speed: num(+s.speed, 0) });
    }

    // boost pads: navy panels with gold chevrons running along +x
    const boosts = [];
    for (const z of Array.isArray(course.boosts) ? course.boosts : []) {
      if (!z || !Number.isFinite(z.x) || !Number.isFinite(z.y) || !(z.w > 0) || !(z.h > 0)) continue;
      const mat = keep(new THREE.ShaderMaterial({
        uniforms: { uTime, uSize: { value: new THREE.Vector2(z.w, z.h) } },
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
        fragmentShader: /* glsl */`
          uniform float uTime; uniform vec2 uSize; varying vec2 vUv;
          void main() {
            vec2 p = ( vUv - 0.5 ) * uSize;
            float e = min( uSize.x * 0.5 - abs( p.x ), uSize.y * 0.5 - abs( p.y ) );
            float border = 1.0 - smoothstep( 0.07, 0.12, e );
            float s = fract( ( p.x + abs( p.y ) * 0.85 ) / 0.85 - uTime * 1.8 );
            float chev = smoothstep( 0.0, 0.07, s ) * ( 1.0 - smoothstep( 0.34, 0.42, s ) );
            float front = 0.45 + 0.55 * smoothstep( -0.5 * uSize.x, 0.5 * uSize.x, p.x );
            vec3 col = mix( vec3( 0.07, 0.13, 0.36 ), vec3( 1.6, 1.15, 0.25 ), chev * front );
            col = mix( col, vec3( 1.0, 0.93, 0.7 ), border );
            gl_FragColor = vec4( col, 1.0 );
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }));
      const m = new THREE.Mesh(keep(flatGeo(new THREE.PlaneGeometry(z.w, z.h))), mat);
      m.position.set(z.x, 0.006, z.y);
      m.rotation.y = -num(+z.a, 0);
      isle.add(m);
      boosts.push(m);
    }

    // tee marker
    const tee = Array.isArray(course.tee) ? course.tee : [0, 0];
    const tx = num(tee[0], 0), ty = num(tee[1], 0);
    const teeMat = keep(decal('#2f9d80'));
    const teeDisc = new THREE.Mesh(keep(flatGeo(new THREE.CircleGeometry(0.62, 32))), teeMat);
    teeDisc.position.set(tx, 0.003, ty);
    const teeRing = new THREE.Mesh(keep(flatGeo(new THREE.RingGeometry(0.62, 0.72, 40))), keep(decal('#f4fff9')));
    teeRing.position.set(tx, 0.004, ty);
    isle.add(teeDisc, teeRing);
    const line = Array.isArray(course.line) && course.line.length > 1 ? course.line : null;
    let ta = 0;
    if (line && Array.isArray(line[1])) ta = Math.atan2(num(line[1][1], ty) - ty, num(line[1][0], tx) - tx);
    for (const sgn of [-1, 1]) {
      const k = new THREE.Mesh(bumperGeo, propMat);
      k.scale.set(0.12, 0.35, 0.12);
      k.position.set(tx - Math.sin(ta) * 0.95 * sgn, 0, ty + Math.cos(ta) * 0.95 * sgn);
      isle.add(k);
    }

    // cup and flag
    const cup = Array.isArray(course.cup) ? course.cup : [0, 0];
    const cx = num(cup[0], 0), cy = num(cup[1], 0);
    const hole = new THREE.Mesh(keep(flatGeo(new THREE.CircleGeometry(0.34, 32))), keep(decal('#050b16')));
    hole.position.set(cx, 0.005, cy);
    const lip = new THREE.Mesh(keep(flatGeo(new THREE.RingGeometry(0.34, 0.41, 40))), keep(decal('#f7fbff')));
    lip.position.set(cx, 0.006, cy);
    const glow = new THREE.Mesh(keep(flatGeo(new THREE.RingGeometry(0.5, 0.78, 48))),
      keep(new THREE.MeshBasicMaterial({ map: blobMat.map, color: C('#fff1a8'), transparent: true, depthWrite: false, opacity: 0.4, toneMapped: false })));
    glow.position.set(cx, 0.007, cy);
    glow.renderOrder = 2;
    isle.add(hole, lip, glow);
    const flagRoot = new THREE.Group();
    flagRoot.position.set(cx, 0, cy);
    const pole = new THREE.Mesh(flagPoleGeo, propMat);
    pole.castShadow = true;
    const clothGeo = keep(new THREE.PlaneGeometry(1.3, 0.85, 12, 4).translate(0.65, 2.32, 0));
    const tex = keep(makeFlagTexture(ci > 0 ? String(ci) : 'Ö'));
    const cloth = new THREE.Mesh(clothGeo, keep(new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75 })));
    cloth.castShadow = true;
    flagRoot.add(pole, cloth);
    isle.add(flagRoot);

    isle.userData.own = own;
    return {
      isle, bumpers, spinners, boosts, cupGlow: glow,
      flag: { root: flagRoot, geo: clothGeo, base: Float32Array.from(clothGeo.attributes.position.array), amp: 0, flutter: 0 },
      cup: [cx, cy],
    };
  }

  function disposeIsle(isle) {
    for (const x of isle.userData.own || []) x.dispose();
    golfGroup.remove(isle);
  }

  function golfShadow() {
    const b = G.bounds;
    if (!b) return;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 2.5;
    sun.target.position.set(cx, 0, cz);
    sun.position.copy(LIGHT_DIR).multiplyScalar(90).add(sun.target.position);
    const sc = sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R;
    sc.updateProjectionMatrix();
  }

  function setCourse(ci) {
    if (curGame === GAME.KLOSS) { kloss.setCourse(ci); return; }
    ci = Math.round(Number(ci));
    const course = COURSES[ci];
    if (!course || typeof course !== 'object') {
      if (!G.warned.has(ci)) { G.warned.add(ci); console.warn('[scene] unknown course', ci); }
      return;
    }
    if (ci === G.ci && G.isle) return;
    let built;
    try { built = buildIsle(course, ci); } catch (err) { console.warn('[scene] course failed to build', ci, err); return; }
    if (G.isle) G.leaving.push({ isle: G.isle, t: 0 });
    const b = courseBounds(course);
    G.bounds = Number.isFinite(b.minX + b.maxX + b.minY + b.maxY) ? b : { minX: -10, maxX: 10, minY: -6, maxY: 6 };
    Object.assign(G, built, { ci, course });
    G.isle.userData.t = golfGroup.visible ? 0 : 1;
    G.isle.position.y = golfGroup.visible ? -10 : 0;
    golfGroup.add(G.isle);
    if (curGame === GAME.GOLF) golfShadow();
    gcam.snap = gcam.snap || !golfGroup.visible;
  }

  const golfFloor = (x, z) => !!G.course && onGround(G.course, x, z);

  function setGame(game) {
    const g = Number(game);
    paket.setActive(g === GAME.PAKET);   // Heta paketet: Knuffkampen plus the parcel
    const golf = g === GAME.GOLF ? GAME.GOLF : g === GAME.KLOSS ? GAME.KLOSS : GAME.KNUFF;
    if (golf === curGame) return;
    const prev = curGame;
    curGame = golf;
    const on = golf === GAME.GOLF;
    golfGroup.visible = on;
    kloss.setActive(golf === GAME.KLOSS);
    arenaGroup.visible = golf === GAME.KNUFF;
    for (const m of allParts) m.visible = golf === GAME.KNUFF;
    shards.visible = golf !== GAME.KLOSS;
    meRing.visible = false; meArrow.visible = false;
    for (const car of cars.values()) car.sprite.visible = false;
    for (const r of G.balls.values()) if (r.car) r.car.sprite.visible = false;
    const sc = sun.shadow.camera;
    if (golf !== GAME.KNUFF) {
      if (prev === GAME.KNUFF) Object.assign(savedShadow, { l: sc.left, r: sc.right, t: sc.top, b: sc.bottom });
      if (on) golfShadow();
      else halo.visible = false;
    } else {
      sun.target.position.set(0, 0, 0);
      sun.position.copy(LIGHT_DIR).multiplyScalar(90);
      sc.left = savedShadow.l; sc.right = savedShadow.r; sc.top = savedShadow.t; sc.bottom = savedShadow.b;
      sc.updateProjectionMatrix();
      halo.position.set(0, -2.4, 0);
    }
    parts.floorFn = on ? golfFloor : golf === GAME.KLOSS ? kloss.floor : null;
    parts.count = 0;
    cam.snap = true; gcam.snap = true;
  }

  // ---- balls
  function makeBall(id) {
    const u = { uStripe: { value: new THREE.Color(1, 1, 1) } };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0, transparent: true, opacity: 1 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uStripe = u.uStripe;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLoc = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc;\nuniform vec3 uStripe;')
        .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 q = vLoc / ${BR.toFixed(4)};
    float band = 1.0 - smoothstep( 0.27, 0.33, abs( q.y ) );
    float dotc = smoothstep( 0.86, 0.9, abs( q.x ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, uStripe, max( band, dotc ) );
  }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.12;');
    };
    mat.customProgramCacheKey = () => 'golf-ball';
    const mesh = new THREE.Mesh(ballGeo, mat);
    mesh.quaternion.setFromEuler(new THREE.Euler(Math.random() * TAU, Math.random() * TAU, 0));
    mesh.renderOrder = 4;
    const blob = new THREE.Mesh(unitBlobGeo, ballBlobMat);
    blob.renderOrder = 2;
    golfGroup.add(mesh, blob);
    const rec = { id, mesh, mat, u, blob, car: null, init: false, x: 0, z: 0, y: BR, vx: 0, vz: 0, st: 0, seen: 0, lost: 0,
      pop: 1, sinkT: 0, fallT: 0, falling: false, puffed: false, me: false, alpha: 1, kick: 0 };
    G.balls.set(id, rec);
    return rec;
  }

  const meBallRing = new THREE.Mesh(goldRingGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  meBallRing.renderOrder = 3;
  const meBallArrow = new THREE.Mesh(meArrowGeo, meArrow.material);
  meBallArrow.scale.setScalar(0.62);
  golfGroup.add(meBallRing, meBallArrow);

  // ---- aim: dark guide strip, marching dots, arrow head
  const AIM_DOTS = 24;
  const aimDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 10, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), AIM_DOTS);
  aimDots.setColorAt(0, _c.set(1, 1, 1));
  aimDots.frustumCulled = false;
  aimDots.renderOrder = 7;
  const aimStrip = new THREE.Mesh(flatGeo(new THREE.PlaneGeometry(1, 1)).translate(0.5, 0, 0),
    new THREE.MeshBasicMaterial({ map: blobMat.map, color: C('#04102c'), transparent: true, depthWrite: false, opacity: 0.38 }));
  aimStrip.renderOrder = 3;
  const headGeo = new THREE.BufferGeometry();
  headGeo.setAttribute('position', new THREE.Float32BufferAttribute([0.36, 0, 0, -0.14, 0, -0.3, -0.14, 0, 0.3, -0.14, 0, -0.3, -0.02, 0, 0, -0.14, 0, 0.3], 3));
  const aimHead = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide }));
  aimHead.renderOrder = 7;
  const aimGroup = new THREE.Group();
  aimGroup.add(aimDots, aimStrip, aimHead);
  golfGroup.add(aimGroup);
  const AIM_LO = C('#ffffff'), AIM_MID = C('#ffd426'), AIM_HI = C('#ff3a24');
  const powerColor = (p, out) => (p < 0.5 ? out.copy(AIM_LO).lerp(AIM_MID, p * 2) : out.copy(AIM_MID).lerp(AIM_HI, (p - 0.5) * 2));

  function updateAim(T, view) {
    const a = view.aim, me = G.me;
    if (!a || !me || !Number.isFinite(a.x) || !Number.isFinite(a.y) || me.st & (BALL.HOLED | BALL.FALLING) || !me.mesh.visible) { aimGroup.visible = false; return; }
    const dl = Math.hypot(a.x, a.y);
    if (!(dl > 1e-6)) { aimGroup.visible = false; return; }
    const dx = a.x / dl, dz = a.y / dl, p = clamp(num(a.power, 0), 0, 1);
    const len = 0.8 + p * 5.4, y0 = (G.isle ? G.isle.position.y : 0);
    aimGroup.visible = true;
    powerColor(p, _c);
    const gap = 0.36, start = BR + 0.14, off = ((T * 1.4) % 1) * gap;
    let n = 0;
    for (let d = start + off; d < start + len - 0.3 && n < AIM_DOTS; d += gap) {
      const f = (d - start) / len, s = 0.75 + f * 0.65;
      _m.compose(_p.set(me.x + dx * d, y0 + 0.09, me.z + dz * d), _q.identity(), _s.set(s, s, s));
      aimDots.setMatrixAt(n, _m);
      aimDots.setColorAt(n, _c);
      n++;
    }
    aimDots.count = n;
    aimDots.instanceMatrix.needsUpdate = true;
    if (aimDots.instanceColor) aimDots.instanceColor.needsUpdate = true;
    const ang = Math.atan2(dz, dx);
    aimStrip.position.set(me.x + dx * start, y0 + 0.012, me.z + dz * start);
    aimStrip.rotation.y = -ang;
    aimStrip.scale.set(len + 0.2, 1, 0.42 + p * 0.2);
    const hs = 0.85 + p * 0.6;
    aimHead.position.set(me.x + dx * (start + len), y0 + 0.1, me.z + dz * (start + len));
    aimHead.rotation.y = -ang;
    aimHead.scale.set(hs, 1, hs);
    aimHead.material.color.copy(_c);
  }

  function updateBalls(dt, T, view) {
    const stamp = ++G.stamp, list = Array.isArray(view.balls) ? view.balls : [];
    const inv = dt > 1e-4 ? 1 / dt : 0, y0 = G.isle ? G.isle.position.y : 0;
    const tanHalf = Math.tan((camera.fov * DEG) / 2);
    G.me = null;
    for (const car of cars.values()) car.sprite.visible = false;
    for (const b of list) {
      if (!b || b.id == null || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const r = G.balls.get(b.id) || makeBall(b.id);
      r.seen = stamp; r.lost = 0;
      const car = cars.get(b.id) || null;
      r.car = car;
      const me = !!(car && car.isMe) || (view.myId != null && b.id === view.myId);
      if (me) G.me = r;
      if (me !== r.me || !r.init) { r.me = me; r.mat.transparent = !me; r.mat.needsUpdate = true; }
      const idn = Number.isFinite(+b.id) ? Math.abs(Math.round(+b.id)) : 0;
      r.u.uStripe.value.copy(car ? car.color : _c.set(PALETTE[idn % PALETTE.length]));
      const st = b.st | 0, z = num(b.z, 0);
      const dx = b.x - r.x, dz = b.y - r.z, d = Math.hypot(dx, dz);
      if (!r.init || d > 3.5) {          // first sight, reset or teleport: pop in
        r.init = true; r.pop = 0; r.vx = r.vz = 0; r.falling = false; r.sinkT = 0;
      } else {
        if (inv > 0) { const k = damp(dt, 0.08); r.vx += (dx * inv - r.vx) * k; r.vz += (dz * inv - r.vz) * k; }
        if (d > 1e-5 && !(st & BALL.HOLED)) {
          _v.set(dz / d, 0, -dx / d);
          _q.setFromAxisAngle(_v, d / BR);
          r.mesh.quaternion.premultiply(_q);
        }
      }
      r.x = b.x; r.z = b.y; r.st = st;
      r.pop = Math.min(1, r.pop + dt / 0.35);
      let y = BR + Math.max(0, z), vis = true, sc = easeOutBack(r.pop);
      if (st & BALL.FALLING) {
        if (!r.falling) { r.falling = true; r.fallT = 0; r.puffed = false; }
        r.fallT += dt;
        y = BR + Math.min(z, -0.5 * 62 * r.fallT * r.fallT);
        if (y < CLOUD_Y + 1.5) { vis = false; if (!r.puffed) { r.puffed = true; cloudPuff(r.x, r.z, 0.55); } }
      } else if (r.falling) { r.falling = false; r.pop = 0; }
      if (st & BALL.HOLED) {
        r.sinkT += dt;
        y = BR - 0.06 - smooth(r.sinkT / 0.3) * 0.5;
        if (r.sinkT > 0.5) vis = false;
      } else if (r.sinkT > 0) { r.sinkT = 0; r.pop = 0; }
      r.kick = Math.max(0, r.kick - dt * 5);
      r.mesh.visible = vis;
      r.mesh.position.set(r.x, y + y0, r.z);
      r.mesh.scale.setScalar(sc * (1 + r.kick * 0.12));
      r.alpha += ((me ? 1 : 0.6) - r.alpha) * damp(dt, 0.2);
      r.mat.opacity = r.alpha;
      const onGreen = !(st & (BALL.FALLING | BALL.HOLED));
      r.blob.visible = vis && onGreen;
      r.blob.position.set(r.x + 0.06, y0 + 0.008, r.z + 0.05);
      r.blob.scale.setScalar(0.72 * sc);
      // name tag (other balls only; the local ball has its marker)
      if (car && car.name && !me && vis && onGreen) {
        const dist = Math.max(1, _v.set(r.x, y0 + 0.6, r.z).distanceTo(camera.position));
        const pxPerM = vh / (2 * dist * tanHalf);
        const hq = clamp((clamp(Math.min(vw, vh) * 0.024, 11, 16) * (TAG_H / 68)) / pxPerM, 0.35, 2.2);
        car.sprite.visible = true;
        car.sprite.position.set(r.x, y0 + 2 * BR + 0.12 + hq * 0.5, r.z);
        car.sprite.scale.set(hq * (TAG_W / TAG_H), hq, 1);
        car.sprite.material.opacity = 0.82 * sc;
        car.sprite.renderOrder = 20;
      }
    }
    for (const [id, r] of G.balls) {
      if (r.seen === stamp) continue;
      r.mesh.visible = false; r.blob.visible = false; r.init = false;
      if ((r.lost += dt) > 10) { golfGroup.remove(r.mesh, r.blob); r.mat.dispose(); G.balls.delete(id); }
    }
    // the local ball's marker
    const m = G.me;
    if (m && m.mesh.visible && !(m.st & (BALL.FALLING | BALL.HOLED))) {
      const moving = (m.st & BALL.MOVING) !== 0;
      meBallRing.visible = true;
      meBallRing.position.set(m.x, y0 + 0.02, m.z);
      meBallRing.rotation.y = T * 1.3;
      meBallRing.scale.setScalar((1 + Math.sin(T * 5) * 0.06) * easeOutBack(m.pop));
      meBallRing.material.opacity = moving ? 0.45 : 1;
      meBallArrow.visible = true;
      meBallArrow.position.set(m.x, y0 + 1.05 + Math.sin(T * 4.2) * 0.1, m.z);
      meBallArrow.rotation.y = T * 2.2;
    } else { meBallRing.visible = false; meBallArrow.visible = false; }
  }

  function updateCourse(dt, T, view) {
    const ht = num(view.holeTime, T);
    if (G.isle) {
      const isle = G.isle, t = (isle.userData.t = Math.min(1, isle.userData.t + dt / 0.95));
      isle.position.y = t >= 1 ? 0 : -10 * (1 - easeOutBack(t));
    }
    for (let i = G.leaving.length - 1; i >= 0; i--) {
      const L = G.leaving[i];
      L.t += dt;
      L.isle.position.y = -22 * L.t * L.t;
      if (L.t > 1.3) { disposeIsle(L.isle); G.leaving.splice(i, 1); }
    }
    const h = Math.min(dt, 0.033);
    for (const b of G.bumpers) {
      b.qv += (-260 * b.q - 11 * b.qv) * h;
      b.q += b.qv * h;
      const q = clamp(b.q, -0.5, 0.6);
      b.m.scale.set(b.r * (1 + q * 0.22), 1 - q * 0.45, b.r * (1 + q * 0.22));
    }
    for (const s of G.spinners) {
      const a = s.phase + s.speed * ht;
      s.rot.rotation.y = -a;
      s.sails.rotation.z = a * 3;
      s.wob = Math.max(0, s.wob - dt * 3);
      s.rot.position.y = Math.abs(Math.sin(T * 38)) * s.wob * 0.06;
    }
    if (G.flag) {
      const f = G.flag, pos = f.geo.attributes.position, B = f.base;
      f.flutter = Math.max(0, f.flutter - dt * 0.45);
      f.root.rotation.y = gcam.yaw;
      const amp = 0.06 + f.flutter * 0.22, sp = 3.2 + f.flutter * 7;
      for (let i = 0; i < pos.count; i++) {
        const x = B[i * 3], k = x / 1.3;
        pos.array[i * 3 + 2] = Math.sin(x * 4.2 - T * sp) * amp * k + Math.sin(x * 7 - T * sp * 1.6) * amp * 0.35 * k;
        pos.array[i * 3 + 1] = B[i * 3 + 1] - k * k * 0.05 * (1 - f.flutter);
      }
      pos.needsUpdate = true;
      f.geo.computeVertexNormals();
    }
    if (G.cupGlow) G.cupGlow.material.opacity = 0.28 + 0.16 * Math.sin(T * 2.6);
    for (let i = G.pending.length - 1; i >= 0; i--) {
      const p = G.pending[i];
      if ((p.t -= dt) <= 0) { G.pending.splice(i, 1); p.fn(); }
    }
  }

  // ---- golf camera: the whole course in frame, still while playing
  const gcam = { tx: 0, tz: 0, d: 40, yaw: 0, elev: 58 * DEG, fov: 40, snap: true, turn: 0 };
  const FIT_PTS = [];
  for (let i = 0; i < 9; i++) FIT_PTS.push(new THREE.Vector3());
  /** Fit the course box (with a little height) at this yaw/elevation; returns { d, tx, tz }. */
  function golfFit(b, yaw, elev, fov, aspect, lat, up, down) {
    const m = 0.5, H = 0.7;
    const pts = FIT_PTS;
    pts[0].set(b.minX - m, 0, b.minY - m); pts[1].set(b.maxX + m, 0, b.minY - m); pts[2].set(b.maxX + m, 0, b.maxY + m); pts[3].set(b.minX - m, 0, b.maxY + m);
    for (let i = 0; i < 4; i++) pts[i + 4].set(pts[i].x, H, pts[i].z);
    const cup = G.course && Array.isArray(G.course.cup) ? G.course.cup : [0, 0];
    pts[8].set(num(cup[0], 0), 3, num(cup[1], 0));
    const tv = Math.tan((fov * DEG) / 2), th = tv * aspect;
    const sE = Math.sin(elev), cE = Math.cos(elev), sy = Math.sin(yaw), cy = Math.cos(yaw);
    const fx = -cE * sy, fy = -sE, fz = -cE * cy, rx = cy, rz = -sy, ux = -sy * sE, uy = cE, uz = -cy * sE;
    let tx = (b.minX + b.maxX) / 2, tz = (b.minY + b.maxY) / 2, d = 30;
    const ext = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const measure = (dd) => {
      const px = tx + dd * cE * sy, py = dd * sE, pz = tz + dd * cE * cy;
      ext.x0 = ext.y0 = Infinity; ext.x1 = ext.y1 = -Infinity;
      for (const q of pts) {
        const ax = q.x - px, ay = q.y - py, az = q.z - pz;
        const depth = ax * fx + ay * fy + az * fz;
        if (depth < 0.5) return false;
        const sx = (ax * rx + az * rz) / (depth * th), su = (ax * ux + ay * uy + az * uz) / (depth * tv);
        if (sx < ext.x0) ext.x0 = sx; if (sx > ext.x1) ext.x1 = sx;
        if (su < ext.y0) ext.y0 = su; if (su > ext.y1) ext.y1 = su;
      }
      return true;
    };
    const fits = (dd) => measure(dd) && ext.x0 >= -lat && ext.x1 <= lat && ext.y1 <= up && ext.y0 >= down;
    for (let it = 0; it < 3; it++) {
      let lo = 2, hi = 600;
      for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
      d = hi;
      if (it === 2 || !measure(d)) break;
      // recentre: move the target so the course sits in the middle of the allowed window
      const xm = (ext.x0 + ext.x1) / 2, ym = (ext.y0 + ext.y1) / 2 - (up + down) / 2;
      tx += rx * xm * d * th; tz += rz * xm * d * th;
      tx += -sy * ym * d * tv / sE; tz += -cy * ym * d * tv / sE;
    }
    return { d, tx, tz };
  }

  function updateGolfCamera(dt, T, view) {
    const b = G.bounds;
    const aspect = camera.aspect, host = !!view.spectate;
    const shiftOn = host && hostScreen && aspect > 1.25, inLobby = view.phase === 0;
    const lat = shiftOn ? (inLobby ? LOBBY_LAT : 0.62) : 0.93;
    const shiftWant = shiftOn ? (inLobby ? LOBBY_SHIFT : 0.155) : 0;
    const fov = host ? 46 : 40;
    const elev = (host ? 47 + Math.sin(T * 0.11) * 2 : 58) * DEG;
    let yaw = 0, fit = null;
    if (b) {
      const up = host ? 0.8 : 0.78, down = host ? -0.86 : -0.84;
      fit = golfFit(b, 0, elev, fov, aspect, lat, up, down);
      if (aspect < 1) {      // portrait: a quarter turn if that frames the course closer
        const alt = golfFit(b, -Math.PI / 2, elev, fov, aspect, lat, up, down);   // tee at the bottom, cup at the top
        const want = alt.d < fit.d * (gcam.turn ? 1.08 : 0.92) ? 1 : 0;
        gcam.turn = want;
        if (want) { fit = alt; yaw = -Math.PI / 2; }
      } else gcam.turn = 0;
      if (host) {             // gentle drift on the host screen
        yaw += Math.sin(T * 0.06) * 0.08;
        fit = golfFit(b, yaw, elev, fov, aspect, lat, up, down);
      }
    }
    const k = gcam.snap ? 1 : damp(dt, 0.4);
    if (fit) {
      gcam.tx += (fit.tx - gcam.tx) * k; gcam.tz += (fit.tz - gcam.tz) * k; gcam.d += (fit.d - gcam.d) * k;
    }
    gcam.yaw += angDiff(yaw, gcam.yaw) * k;
    gcam.elev += (elev - gcam.elev) * k;
    gcam.fov += (fov - gcam.fov) * k;
    if (Math.abs(camera.fov - gcam.fov) > 1e-4) { camera.fov = gcam.fov; camera.updateProjectionMatrix(); }
    shiftF += (shiftWant - shiftF) * k;
    const shift = shiftOn || Math.abs(shiftF) > 1e-3 ? Math.round(shiftF * vw) : 0;
    if (shift !== viewShift || (shift && (camera.view?.fullWidth !== vw || camera.view?.fullHeight !== vh))) {
      viewShift = shift;
      if (shift) camera.setViewOffset(vw, vh, shift, 0, vw, vh);
      else camera.clearViewOffset();
    }
    const cE = Math.cos(gcam.elev), sE = Math.sin(gcam.elev), sy = Math.sin(gcam.yaw), cy = Math.cos(gcam.yaw);
    camera.position.set(gcam.tx + gcam.d * cE * sy, gcam.d * sE, gcam.tz + gcam.d * cE * cy);
    camera.up.set(0, 1, 0);
    camera.lookAt(gcam.tx, 0, gcam.tz);
    gcam.snap = false;
    // the glow under the island follows the course
    if (b) {
      halo.position.set((b.minX + b.maxX) / 2, -2.6, (b.minY + b.maxY) / 2);
      halo.scale.set((b.maxX - b.minX) / 2 + 6, 1, (b.maxY - b.minY) / 2 + 6);
      halo.material.opacity += (0.75 - halo.material.opacity) * damp(dt, 0.5);
      halo.visible = true;
    } else halo.visible = false;
  }

  function updateGolf(dt, T, view) {
    if (Number.isInteger(view.course) && view.course !== G.ci) setCourse(view.course);
    updateCourse(dt, T, view);
    updateBalls(dt, T, view);
    parts.update(dt);
    updateGolfCamera(dt, T, view);
    updateAim(T, view);
  }

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
  function groundPoint(clientX, clientY) {
    try {
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return null;
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      camera.updateMatrixWorld();
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(groundPlane, hitP)) return null;
      return { x: hitP.x, y: hitP.z };
    } catch { return null; }
  }

  // ---- golf effects
  const ballAt = (id) => { const r = G.balls.get(id); return r && r.init ? r : null; };
  function golfConfetti(x, z, n, up) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = 1.5 + Math.random() * 4.5;
      _c.set(PALETTE[(Math.random() * PALETTE.length) | 0]);
      parts.emit(K_CONF, x + Math.cos(a) * 0.2, 0.4 + Math.random() * 0.6, z + Math.sin(a) * 0.2, Math.cos(a) * sp, up * (0.6 + Math.random() * 0.6), Math.sin(a) * sp,
        2 + Math.random() * 1.5, 0.08 + Math.random() * 0.07, 0, _c.r * 1.15, _c.g * 1.15, _c.b * 1.15, 1, 0, 9, 1.7,
        Math.random() * TAU, (Math.random() - 0.5) * 9, Math.random() * TAU, 2, 1);
    }
  }
  Object.assign(fx, {
    putt(id, power) {
      const r = ballAt(id);
      if (!r) return;
      const p = clamp(num(power, 0.5), 0, 1);
      r.kick = 0.4 + p * 0.6;
      parts.emit(K_RING, r.x, 0.03, r.z, 0, 0, 0, 0.3, 0.3, 2.5 + p * 5, 1, 1, 1, 0.9, 0.2, 0, 0, 0, 0, 0.22, 0, 0);
      const n = Math.round((4 + 12 * p) * fxMul) + 2;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = 1 + Math.random() * 3 * (0.4 + p);
        parts.emit(K_CHIP, r.x, 0.06, r.z, Math.cos(a) * sp, 1.2 + Math.random() * 2.4 * (0.5 + p), Math.sin(a) * sp,
          0.35 + Math.random() * 0.3, 0.04 + Math.random() * 0.04, 0, 0.45, 0.95, 0.7, 0.95, 0, 14, 1.2, Math.random() * 6, 9, 0, 0, 1);
      }
    },
    bounce(x, y, speed, kind) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const s = clamp(num(speed, 3) / 14, 0, 1), k = kind | 0;
      const col = k === 1 ? [2.4, 1.3, 0.8] : k === 2 ? [2.4, 2.0, 1.1] : [1.6, 1.9, 2.4];
      const n = Math.round((3 + 14 * s) * fxMul) + 1;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = (2 + 8 * s) * (0.4 + Math.random() * 0.8);
        parts.emit(K_STREAK, x, 0.25, y, Math.cos(a) * sp, 1 + Math.random() * 3 * s, Math.sin(a) * sp,
          0.15 + Math.random() * 0.2, 0.03 + 0.03 * s, 0, col[0], col[1], col[2], 1, 0.4, 10, 2.5, 0, 0, 0.03, 0, 0);
      }
      parts.emit(K_RING, x, 0.05, y, 0, 0, 0, 0.25, 0.25, (1.2 + 3 * s) / 0.25, col[0] / 2.4, col[1] / 2.4, col[2] / 2.4, 0.85, 0.2, 0, 0, 0, 0, 0.25, 0, 0);
      if (k === 1) {
        let best = null, bd = Infinity;
        for (const b of G.bumpers) { const d = Math.hypot(b.x - x, b.y - y) - b.r; if (d < bd) { bd = d; best = b; } }
        if (best && bd < 0.8) best.qv += 3 + 9 * s;
        if (s > 0.3) parts.emit(K_STAR, x, 0.6, y, 0, 0.4, 0, 0.2, 0.35 + 0.4 * s, 2, 1, 0.75, 0.2, 0.95, 0.1, 0, 0, Math.random() * TAU, 2, 0, 2, 0);
      } else if (k === 2) {
        let best = null, bd = Infinity;
        for (const sp of G.spinners) { const d = Math.hypot(sp.s.x - x, sp.s.y - y); if (d < bd) { bd = d; best = sp; } }
        if (best) best.wob = Math.min(1, best.wob + 0.3 + s);
      }
    },
    boost(id) {
      const r = ballAt(id);
      if (!r) return;
      const sp = Math.hypot(r.vx, r.vz), dx = sp > 0.1 ? r.vx / sp : 1, dz = sp > 0.1 ? r.vz / sp : 0;
      parts.emit(K_RING, r.x, 0.04, r.z, 0, 0, 0, 0.3, 0.3, 9, 1, 0.8, 0.2, 0.9, 0.3, 0, 0, 0, 0, 0.2, 0, 0);
      const n = Math.round(14 * fxMul) + 3;
      for (let i = 0; i < n; i++) {
        const j = (Math.random() - 0.5) * 2, v = 3 + Math.random() * 6;
        parts.emit(K_STREAK, r.x - dx * 0.2, 0.15 + Math.random() * 0.3, r.z - dz * 0.2, -dx * v - dz * j * 2, 0.5 + Math.random(), -dz * v + dx * j * 2,
          0.2 + Math.random() * 0.2, 0.04, 0, 2.5, 1.9, 0.6, 1, 0.5, 2, 2, 0, 0, 0.05, 0, 0);
      }
    },
    holed(id, strokes) {
      const cup = G.cup || [0, 0], x = cup[0], z = cup[1];
      const ace = Number(strokes) === 1;
      if (G.flag) G.flag.flutter = ace ? 1 : 0.7;
      const r = ballAt(id);
      if (r) r.kick = 1;
      parts.emit(K_RING, x, 0.05, z, 0, 0, 0, 0.5, 0.4, 7, 1, 0.9, 0.4, 0.95, 0.3, 0, 0, 0, 0, 0.25, 0, 0);
      parts.emit(K_SOFT, x, 0.6, z, 0, 0, 0, 0.25, 0.8, 4, 1.8, 1.65, 1.1, 0.6, 0.6, 0, 0, 0, 0, 0, 0, 0);
      golfConfetti(x, z, Math.round(36 * fxMul) + 10, 7);
      if (ace) {
        for (let w = 0; w < 3; w++) {
          G.pending.push({ t: w * 0.32, fn: () => {
            golfConfetti(x, z, Math.round(110 * fxMul) + 30, 11 + w * 2);
            parts.emit(K_RING, x, 0.08, z, 0, 0, 0, 0.7, 0.6, 12, 1, 0.84, 0.3, 0.95, 0.3, 0, 0, 0, 0, 0.2, 0, 0);
            for (let i = 0; i < 5; i++) {
              const a = Math.random() * TAU;
              parts.emit(K_STAR, x + Math.cos(a) * 1.4, 1.2 + Math.random() * 1.8, z + Math.sin(a) * 1.4, Math.cos(a) * 1.5, 2.5, Math.sin(a) * 1.5,
                0.6 + Math.random() * 0.3, 0.45 + Math.random() * 0.4, 0.4, 1, 0.8, 0.15, 1, 0.2, 2, 0.5, Math.random() * TAU, (Math.random() - 0.5) * 4, 0, 2, 0);
            }
          } });
        }
      }
    },
    oob(id) {
      const r = ballAt(id);
      if (!r) return;
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * TAU;
        parts.emit(K_PUFF, r.x + Math.cos(a) * 0.2, 0.1, r.z + Math.sin(a) * 0.2, Math.cos(a) * 1.2, 0.6 + Math.random(), Math.sin(a) * 1.2,
          0.5 + Math.random() * 0.3, 0.3, 1.2, 0.9, 0.95, 1, 0.75, 0, 0, 2, Math.random() * TAU, 0, 0, 1, 0);
      }
    },
  });

  // ── Klossgolf (public/js/scene-kloss.js) ─────────────────────────────
  function applyShift(want, k) {
    shiftF += (want - shiftF) * k;
    const shift = Math.abs(shiftF) > 1e-3 ? Math.round(shiftF * vw) : 0;
    if (shift !== viewShift || (shift && (camera.view?.fullWidth !== vw || camera.view?.fullHeight !== vh))) {
      viewShift = shift;
      if (shift) camera.setViewOffset(vw, vh, shift, 0, vw, vh);
      else camera.clearViewOffset();
    }
  }
  const kloss = createKloss({
    THREE, scene, overlay, camera, parts, cars, sun, LIGHT_DIR, shared, uTime, hostScreen, skyMat, clouds, towers,
    patchStandard, makeRadialTexture, makeFlagTexture, meRingGeometry, meArrowGeo, meArrowMat: meArrow.material, blobTex: blobMat.map,
    K: { SOFT: K_SOFT, STREAK: K_STREAK, CONF: K_CONF, RING: K_RING, PUFF: K_PUFF, STAR: K_STAR, CHIP: K_CHIP },
    applyShift,
    get fxMul() { return fxMul; }, get vw() { return vw; }, get vh() { return vh; }, get tier() { return tier; },
    hemi, fill, renderer,
  });
  {
    const golfHoled = fx.holed, golfOob = fx.oob;
    Object.assign(fx, {
      holed(id, strokes) { if (curGame === GAME.KLOSS) kloss.fx.holed(id, strokes); else golfHoled(id, strokes); },
      oob(id) { if (curGame === GAME.KLOSS) kloss.fx.oob(id); else golfOob(id); },
      swing: kloss.fx.swing, land: kloss.fx.land, splash: kloss.fx.splash, tree: kloss.fx.tree,
    });
  }

  // ── Heta paketet (public/js/scene-paket.js) ──────────────────────────
  const paket = createPaket({
    THREE, scene, overlay, camera, parts, cars, ST, PALETTE, makeRadialTexture, meArrow,
    K: { SOFT: K_SOFT, STREAK: K_STREAK, CONF: K_CONF, RING: K_RING, PUFF: K_PUFF, STAR: K_STAR, CHIP: K_CHIP },
    shake: (a) => fx.shake(a), floorR: () => arenaRadius(arena.live),
    get fxMul() { return fxMul; }, get vh() { return vh; },
  });
  fx.pass = paket.fx.pass;
  fx.pop = paket.fx.pop;

  // ── quality ──────────────────────────────────────────────────────────
  let tier = 'high', composer = null, bloomPass = null, gradePass = null;
  let cpuMs = 0, renderMs = 0;
  const auto = { on: true, warm: 2.5, t: 0, n: 0, bad: 0, startTier: null, startFps: 0, done: false };
  let fps = 60, lastNow = 0;

  function guessTier() {
    let name = '';
    try {
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch { /* ignore */ }
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
    if (coarse || /intel|mali|adreno|powervr|videocore/i.test(name)) return 'medium';   // phones and integrated graphics
    return 'high';
  }

  function ensureComposer() {
    if (composer) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // No MSAA here by default: multisampled float buffers are what makes post-processing expensive.
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.36, 0.5, 1.12);
    composer.addPass(bloomPass);
    // Klossgolf only: a gentle grade and vignette (off in the other games)
    gradePass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uAspect: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uAspect; varying vec2 vUv;
        void main() {
          vec4 c = texture2D( tDiffuse, vUv );
          float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          c.rgb = mix( vec3( l ), c.rgb, 1.1 );                        // a touch richer
          c.rgb = pow( max( c.rgb, 0.0 ), vec3( 1.07 ) ) * 1.04;          // a little more contrast
          c.rgb *= vec3( 1.02, 1.0, 0.97 );                           // warm
          vec2 q = ( vUv - 0.5 ) * vec2( uAspect, 1.0 );
          c.rgb *= 1.0 - 0.32 * smoothstep( 0.45, 1.05, length( q ) ); // vignette
          gl_FragColor = c;
        }`,
    });
    gradePass.enabled = false;
    composer.addPass(gradePass);
    composer.addPass(new OutputPass());
  }

  function resize() {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth || 1), h = Math.max(1, canvas.clientHeight || window.innerHeight || 1);
    vw = w; vh = h;
    const cfg = TIERS[tier];
    const pr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, cfg.maxPR, Math.sqrt(cfg.maxPixels / (w * h))));
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) {
      // supersampling does the anti-aliasing on dense displays; on 1x displays fall back to MSAA
      const samples = pr >= 1.45 ? 0 : 4;
      for (const rt of [composer.renderTarget1, composer.renderTarget2]) if (rt.samples !== samples) { rt.samples = samples; rt.dispose(); }
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      bloomPass.setSize(Math.round(w * pr * 0.5), Math.round(h * pr * 0.5));   // bloom is blurry anyway: half size
    }
    moteMat.uniforms.uScale.value = (h * pr) / (2 * Math.tan((camera.fov * DEG) / 2));
  }

  function applyTier(t) {
    tier = t;
    const cfg = TIERS[t];
    fxMul = cfg.fx;
    const wantShadow = cfg.shadow > 0;
    if (wantShadow && sun.shadow.mapSize.x !== cfg.shadow) {
      sun.shadow.mapSize.set(cfg.shadow, cfg.shadow);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    sun.castShadow = wantShadow;
    const env = cfg.env ? getEnv() : null;
    scene.environment = env;
    hemi.intensity = env ? 0.4 : 1.25;
    fill.intensity = env ? 0.6 : 0.8;
    blobMat.opacity = wantShadow ? 0.24 : 0.46;
    motes.visible = cfg.motes;
    if (cfg.bloom) ensureComposer();
    resize();
  }

  function setQuality(q) {
    if (q === 'auto') {
      auto.on = true; auto.warm = 2.5; auto.t = auto.n = auto.bad = 0;
      auto.startTier = null; auto.done = false;
      applyTier(guessTier());
    } else if (TIERS[q]) {
      auto.on = false;
      applyTier(q);
    }
  }

  function measure() {
    const now = performance.now();
    const real = lastNow ? (now - lastNow) / 1000 : 0;
    lastNow = now;
    if (real <= 0 || real > 0.25) { auto.t = 0; auto.n = 0; return; }   // first frame, or the tab was asleep
    fps += (1 / real - fps) * Math.min(1, real * 3);
    if (!auto.on || auto.done) return;
    if (auto.warm > 0) { auto.warm -= real; return; }
    auto.t += real; auto.n++;
    if (auto.t < 2) return;
    const avg = auto.n / auto.t;
    auto.t = 0; auto.n = 0;
    auto.bad = avg < 48 ? auto.bad + 1 : 0;
    if (auto.bad >= 2) {
      const ti = TIER_ORDER.indexOf(tier);
      // Too slow twice in a row: step down. Steps only go down, so it cannot oscillate.
      auto.bad = 0; auto.warm = 2;
      if (ti > 0) {
        if (auto.startTier === null) { auto.startTier = tier; auto.startFps = avg; }
        applyTier(TIER_ORDER[ti - 1]);
      } else {
        // Already at the bottom. If none of it helped, the frame rate is capped by something
        // else (a 30 Hz display, a power-saving browser): give the picture back and stop.
        if (auto.startTier !== null && avg < auto.startFps * 1.1) applyTier(auto.startTier);
        auto.done = true;
      }
    }
  }

  // ── frame ────────────────────────────────────────────────────────────
  let T = 0, errors = 0, sizeCheck = 0;

  function frameInner(dt, view) {
    renderer.info.reset();
    dt = clamp(num(dt, 1 / 60), 0, 0.1);
    view = view || {};
    T += dt;
    uTime.value = T;
    measure();
    sizeCheck += dt;
    if (sizeCheck > 1) {
      sizeCheck = 0;
      const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
      if (w !== vw || h !== vh) resize();
    }

    const golfView = view.game === GAME.GOLF, klossView = view.game === GAME.KLOSS;
    const want = golfView ? GAME.GOLF : klossView ? GAME.KLOSS : GAME.KNUFF;
    if (want !== curGame) setGame(want);
    if ((view.game === GAME.PAKET) !== paket.active) paket.setActive(view.game === GAME.PAKET);
    if (golfView) updateGolf(dt, T, view);
    else if (klossView) {
      kloss.update(dt, T, view);
      parts.update(dt);
      halo.visible = false;
    } else {
    parts.floorR = arenaRadius(arena.live);
    readPlayers(dt, view);
    for (const p of Array.isArray(view.players) ? view.players : []) {
      if (!p) continue;
      const car = cars.get(p.id);
      if (car) car.cdFrac = num(p.cd, 0);
    }
    updateArena(dt, T, view);
    animateCars(dt, T, view);
    if (paket.active) paket.update(dt, T, view);
    parts.update(dt);
    updateCamera(dt, T, view);

    // things that follow the island
    const hr = cam.radius + 5.5, coreLeft = arena.live >= 0 ? 1 : 0;
    halo.scale.set(hr, 1, hr);
    halo.material.opacity += (0.9 * coreLeft - halo.material.opacity) * damp(dt, 0.5);
    halo.visible = halo.material.opacity > 0.01;
    }
    for (const b of balloons) {
      const a = b.a + T * 0.004 * (b.r < 120 ? 1.6 : 1);
      b.m.position.set(Math.cos(a) * b.r, b.y + Math.sin(T * 0.35 + b.ph) * 1.6, Math.sin(a) * b.r);
      b.m.rotation.y = T * 0.05 + b.ph;
    }
    for (let i = 0; i < shardDefs.length; i++) {
      const d = shardDefs[i];
      _q.setFromAxisAngle(Y_AXIS, d.rot + T * 0.03 * (i % 2 ? 1 : -1));
      _m.compose(_p.set(Math.cos(d.a) * d.r, d.y + Math.sin(T * d.sp + d.ph) * 0.8, Math.sin(d.a) * d.r), _q, _s.set(d.s, d.s * d.sy, d.s));
      shards.setMatrixAt(i, _m);
    }
    shards.instanceMatrix.needsUpdate = true;

    const r0 = performance.now();
    if (gradePass) { gradePass.enabled = curGame === GAME.KLOSS; gradePass.uniforms.uAspect.value = vw / vh; }
    if (TIERS[tier].bloom && composer) composer.render(dt);
    else renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.render(overlay, camera);
    renderer.autoClear = true;
    renderMs += (performance.now() - r0 - renderMs) * 0.1;
  }

  function frame(dt, view) {
    const t0 = performance.now();
    try {
      frameInner(dt, view);
      cpuMs += (performance.now() - t0 - cpuMs) * 0.1;
    } catch (err) {
      if (errors++ < 5) console.error('[scene] frame failed', err);
    }
  }

  // ── boot ─────────────────────────────────────────────────────────────
  setArena(SIM.LOBBY_RINGS);
  for (const piece of pieces.values()) if (piece.state === 'rising') setIntact(piece);   // no intro before the first real setArena
  setQuality('auto');
  window.addEventListener('resize', resize);
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());

  return {
    setArena, upsertPlayer, removePlayer, frame, resize, setQuality,
    setGame, setCourse, groundPoint,
    getStats: () => ({ fps: Math.round(fps), quality: tier, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      cpuMs: Math.round(cpuMs * 100) / 100, renderMs: Math.round(renderMs * 100) / 100 }),
    fx,
  };
}
