// Klossgolf – the classic golf game, rendered as a floating voxel island.
//
// scene.js owns the renderer, sky, clouds, lights, particles, name tags and quality
// tiers; it hands the shared pieces to createKloss(ctx) and calls update() every frame
// while GAME.KLOSS is on. Everything here lives in one group that is hidden otherwise.
//
// World space: X = sim x, Y = sim z (height), Z = sim y. A sim angle a is a world
// rotation.y of -a. Looking along heading h, screen-right is sim (-sin h, cos h).

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KG, SURF, CLUBS, PUTTER, KST, surfaceAt, aimPoint, suggestClub } from '/shared/klossgolf.js';
import { KCOURSES } from '/shared/klosscourses.js';
import { PALETTE, PHASE } from '/shared/protocol.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const damp = (dt, tau) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
const num = (v, d) => (Number.isFinite(v) ? v : d);
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeIn = (t) => t * t;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0, 1], lattice spacing `cell` metres. */
function makeNoise(seed, cell) {
  const h = (i, j) => {
    let x = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1442695041);
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy);
    const u = smooth(fx - i), v = smooth(fy - j);
    return lerp(lerp(h(i, j), h(i + 1, j), u), lerp(h(i, j + 1), h(i + 1, j + 1), u), v);
  };
}

// ---------------------------------------------------------------- tuning

const NONE = -100;            // no island here
const BASE_H = 0.16;          // the landscape around the hole
const MARGIN = 24;            // metres of scenery around the bounds (multiple of 4)
const WATER_Y = -0.34;        // water surface
const SURF_H = [0.13, 0, 0.05, -0.3, -0.95, 0.24, 0.16];   // top of the ground by SURF.*
const MAX_FIG = 64;
const HIT_T = 0.34;           // swing start -> club meets ball (no charge shown)

// club: address geometry and camera
const CLUB_LEN = [1.12, 1.02, 0.94, 0.9];
const CLUB_LEAN = [0.3, 0.34, 0.38, 0.44];
const HANDS = [[0.42, 0.74], [0.42, 0.74], [0.4, 0.75], [0.34, 0.8]];
const CAM = [   // back, up, pitch (deg), fov add
  { back: 6.4, up: 2.6, pitch: 11.5 },
  { back: 5.8, up: 2.4, pitch: 12.5 },
  { back: 5.2, up: 2.2, pitch: 14 },
  { back: 5.2, up: 2.3, pitch: 17 },
];
const SKIN = ['#f3c9a3', '#e0ac7e', '#c68a5c', '#9c6a43', '#6e4a33', '#f6d6bd'];

export function createKloss(ctx) {
  const { THREE, scene, overlay, camera, parts, cars, sun, shared, patchStandard, makeRadialTexture, makeFlagTexture, meRingGeometry, meArrowGeo, meArrowMat, blobTex, K, hostScreen } = ctx;
  const C = (hex) => new THREE.Color(hex);
  const V3 = () => new THREE.Vector3();
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _p = V3(), _s = V3(), _v = V3(), _v2 = V3(), _v3 = V3(), _c = new THREE.Color();
  const Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  let active = false;

  // ── materials ────────────────────────────────────────────────────────
  const tileTex = (() => {
    const S = 64, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const img = g.createImageData(S, S), rnd = mulberry32(7);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const e = Math.min(x, y, S - 1 - x, S - 1 - y);
      let v = 236 + rnd() * 19;
      if (e < 2) v *= 0.9; else if (e < 4) v *= 0.96;
      if (x > S - 6 || y < 5) v *= 1.03;      // a lit bevel
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, v); img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  })();
  const groundMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, map: tileTex, roughness: 0.92, metalness: 0 }), 'plain', shared);
  const propMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }), 'plain', shared);
  const grassMat = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }), 'plain', shared);
  const tuftGeo = (() => {
    const pos = [], col = [], base = [0.22, 0.4, 0.12];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI + 0.3, c = Math.cos(a), n = Math.sin(a), w = 0.07, lean = (k - 1) * 0.06;
      pos.push(-c * w, 0, -n * w, c * w, 0, n * w, lean * n, 0.34 + k * 0.05, -lean * c);
      col.push(...base, ...base, 1, 1, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const nn = g.attributes.normal;
    for (let i = 0; i < nn.count; i++) {   // lit almost like the ground they grow from
      const x = nn.getX(i) * 0.3, z = nn.getZ(i) * 0.3, l = Math.hypot(x, 1, z);
      nn.setXYZ(i, x / l, 1 / l, z / l);
    }
    return g;
  })();  // uniforms the Klossgolf materials share: time, wind, detail by tier (x: fine detail and reflections, y: cloud shadows)
  const KU = { uKTime: ctx.uTime, uKWind: { value: new THREE.Vector2() }, uKDetail: { value: new THREE.Vector2(1, 1) }, uKSky: { value: C('#bcd8f0') } };
  const KNOISE = /* glsl */`
float kHash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
float kCloud( vec2 p ) {   // soft blobs, cheap
  return 0.5 + 0.25 * ( sin( p.x * 1.7 + sin( p.y * 1.3 ) * 1.4 ) + sin( p.y * 1.9 + sin( p.x * 0.8 ) * 1.6 ) );
}`;
  const waterMat = (() => {
    const m = patchStandard(new THREE.MeshStandardMaterial({ color: C('#ffffff'), roughness: 0.12, metalness: 0.0, envMapIntensity: 0.3, transparent: true, opacity: 1, depthWrite: false }), 'plain', shared);
    const base = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      base(sh, r);
      Object.assign(sh.uniforms, KU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aShore;\nvarying float vShore;\nvarying vec3 vKW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vKW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vShore = aShore;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vKW;
varying float vShore;
uniform float uKTime;
uniform vec2 uKDetail;
uniform vec3 uKSky;
${KNOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float deep = smoothstep( 0.05, 0.9, vShore );
    diffuseColor.rgb = mix( vec3( 0.25, 0.62, 0.58 ), vec3( 0.02, 0.17, 0.33 ), deep );
    diffuseColor.a = mix( 0.6, 0.92, deep );
    float wave = 0.5 + 0.5 * sin( vKW.x * 2.1 + vKW.z * 1.6 - uKTime * 1.8 + kHash( floor( vKW.xz * 0.5 ) ) * 3.0 );
    float foam = ( 1.0 - smoothstep( 0.05, 0.3, vShore ) ) * ( 0.4 + 0.6 * wave );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.97, 0.99, 1.0 ), foam * 0.85 );
    diffuseColor.a = max( diffuseColor.a, foam );
  }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    vec2 w = vKW.xz;
    float t = uKTime;
    vec3 wn = vec3( sin( w.x * 1.3 + t * 1.7 ) + 0.6 * sin( w.y * 2.1 - t * 1.3 + w.x * 0.4 ) + 0.35 * sin( w.x * 5.3 - w.y * 3.1 + t * 3.1 ), 0.0,
                    cos( w.y * 1.1 + t * 1.5 ) + 0.6 * cos( w.x * 1.9 + t * 1.1 - w.y * 0.3 ) + 0.35 * cos( w.y * 4.7 + w.x * 2.3 - t * 2.7 ) ) * 0.08;
    normal = normalize( normal + ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
  }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    // the sky reflected by view angle, and glitter where the ripples catch the sun
    float fres = pow( 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 ), 3.0 );
    totalEmissiveRadiance += uKSky * fres * 0.4 * uKDetail.x;
    vec2 gc = floor( vKW.xz * 7.0 );
    float tw = kHash( gc + floor( uKTime * 2.5 + kHash( gc ) * 9.0 ) * 0.37 );
    float twinkle = smoothstep( 0.988, 0.998, tw ) * ( 0.6 + 0.4 * sin( uKTime * 9.0 + kHash( gc.yx ) * 6.3 ) );
    totalEmissiveRadiance += vec3( 1.0, 0.96, 0.85 ) * twinkle * mix( 0.4, 2.4, uKDetail.x ) * smoothstep( 0.15, 0.6, vShore );
  }`);
    };
    m.customProgramCacheKey = () => 'kk-water2';
    return m;
  })();
  // the ground: grain near the camera, rake lines in the sand, cloud shadows sliding over everything
  {
    const base = groundMat.onBeforeCompile;
    groundMat.onBeforeCompile = (sh, r) => {
      base(sh, r);
      Object.assign(sh.uniforms, KU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vKW;\nvarying float vKUp;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vKW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vKUp = normal.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vKW;
varying float vKUp;
uniform float uKTime;
uniform vec2 uKDetail;
uniform vec2 uKWind;
${KNOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float near = ( 1.0 - smoothstep( 20.0, 60.0, length( vViewPosition ) ) ) * uKDetail.x;
    if ( vKUp > 0.5 && near > 0.0 ) {
      float g = kHash( floor( vKW.xz * 6.0 ) );
      float sandy = smoothstep( 0.42, 0.5, diffuseColor.b / max( diffuseColor.g, 0.01 ) );
      diffuseColor.rgb *= 1.0 + ( g - 0.5 ) * mix( 0.13, 0.09, sandy ) * near;
      float rake = smoothstep( 0.55, 1.0, sin( vKW.x * 7.0 + sin( vKW.z * 0.9 ) * 1.8 ) );
      diffuseColor.rgb *= 1.0 - 0.09 * rake * sandy * near;
    }
    vec2 cp = vKW.xz * 0.02 - uKTime * ( vec2( 0.02, 0.007 ) + uKWind * 0.006 );
    diffuseColor.rgb *= 1.0 - 0.28 * uKDetail.y * smoothstep( 0.62, 0.85, kCloud( cp ) );
  }`);
    };
    groundMat.customProgramCacheKey = () => 'kk-ground';
  }
  // tree canopies and grass sway with the wind (vertex shader only)
  const swayPatch = (mat, key, body) => {
    const base = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      base(sh, r);
      Object.assign(sh.uniforms, KU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uKTime;\nuniform vec2 uKWind;\nuniform vec2 uKDetail;\n' + (key === 'kk-prop' ? 'attribute float aSway;' : ''))
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + body);
    };
    mat.customProgramCacheKey = () => key;
  };
  swayPatch(propMat, 'kk-prop', `
  if ( aSway > 0.5 && uKDetail.y > 0.5 ) {
    vec3 ip = vec3( instanceMatrix[ 3 ] );
    float k = position.y + 0.5;
    float w = 0.35 + length( uKWind ) * 0.15;
    float ph = uKTime * 1.4 + ip.x * 0.31 + ip.z * 0.17;
    transformed.x += sin( ph ) * 0.03 * w * k;
    transformed.z += cos( ph * 0.83 ) * 0.022 * w * k;
  }`);
  swayPatch(grassMat, 'kk-grass', `
  {
    vec3 ip = vec3( instanceMatrix[ 3 ] );
    float k = position.y * position.y * 6.0;
    float ph = uKTime * 2.3 + ip.x * 0.7 + ip.z * 0.53;
    vec2 wv = uKWind * 0.035 + vec2( sin( ph ), cos( ph * 0.9 ) ) * ( 0.03 + length( uKWind ) * 0.012 );
    transformed.x += wv.x * k;
    transformed.z += wv.y * k;
  }`);

  // figures: per-vertex tint mask (0 fixed colour, 1 player colour, 2 skin) and a per-instance dither fade
  const figMat = (() => {
    const m = patchStandard(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }), 'plain', shared);
    const base = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      base(sh, r);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aTint;\nattribute vec3 aSkin;\nattribute float aFade;\nattribute float aBlink;\nvarying float vFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  if ( aTint > 2.5 ) transformed.y = mix( transformed.y, 0.35, aBlink * 0.85 );')
        .replace('#include <color_vertex>', `#if defined( USE_COLOR_ALPHA )
  vColor = vec4( 1.0 );
#endif
  vColor.xyz = color.xyz;
  vColor.xyz *= aTint > 2.5 ? vec3( 1.0 ) : aTint > 1.5 ? aSkin : ( aTint > 0.5 ? instanceColor.xyz : vec3( 1.0 ) );
  vFade = aFade;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <clipping_planes_fragment>', `if ( vFade < 0.999 ) {
    float dn = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( vFade <= dn ) discard;
  }
  #include <clipping_planes_fragment>`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.08;');
    };
    m.customProgramCacheKey = () => 'kk-fig';
    return m;
  })();

  // ── world state ──────────────────────────────────────────────────────
  const W = {
    ci: -1, course: null, world: null, warned: new Set(),
    ox: 0, oy: 0, gw: 0, gh: 0, hg: null, sg: null,
    trees: [], flag: null, cup: [0, 0], cupY: 0, tee: null, line: null, holeDir: 0,
    pending: [], leafAcc: 0, curve: null, curveLen: 0,
  };

  /** Visual ground height at sim (x, y); NONE outside the island. */
  function heightAt(x, y) {
    if (!W.hg) return 0;
    const i = Math.floor(x - W.ox), j = Math.floor(y - W.oy);
    if (i < 0 || j < 0 || i >= W.gw || j >= W.gh) {
      const m = W.mid;
      if (!m) return BASE_H;
      const a = Math.floor((x - m.x0) / 8), c = Math.floor((y - m.y0) / 8);
      return a < 0 || c < 0 || a >= m.cw || c >= m.ch ? BASE_H : m.mh[c * m.cw + a];
    }
    return W.hg[j * W.gw + i];
  }
  /** Height to stand on: wading in water, the void counts as the island edge. */
  function standAt(x, y) {
    const h = heightAt(x, y);
    if (!W.sg) return 0;
    const i = Math.floor(x - W.ox), j = Math.floor(y - W.oy);
    if (i < 0 || j < 0 || i >= W.gw || j >= W.gh) return h;
    return W.sg[Math.floor(y - W.oy) * W.gw + Math.floor(x - W.ox)] === SURF.WATER ? WATER_Y - 0.25 : h;
  }

  // ── building a hole ──────────────────────────────────────────────────
  function buildWorld(course, ci) {
    const own = [];
    const keep = (x) => { own.push(x); return x; };
    const root = new THREE.Group();
    const rnd = mulberry32(4242 + ci * 977);
    const b = course.bounds.map(Number);
    const ox = Math.floor(b[0] / 8) * 8 - MARGIN, oy = Math.floor(b[1] / 8) * 8 - MARGIN;
    const gw = Math.ceil((b[2] + MARGIN - ox) / 8) * 8, gh = Math.ceil((b[3] + MARGIN - oy) / 8) * 8;
    const hg = new Float32Array(gw * gh).fill(NONE), sg = new Int8Array(gw * gh).fill(-1);
    Object.assign(W, { ox, oy, gw, gh, hg, sg, mid: null });
    const nHill = makeNoise(23 + ci, 14), nHill2 = makeNoise(5 + ci, 5);
    const outD = (x, y) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
    // low voxel hills between the bounds and the edge of the detailed grid, flat (BASE_H) at both ends
    const sceneryH = (x, y) => {
      const d = outD(x, y), e = Math.min(x - ox, ox + gw - x, y - oy, oy + gh - y);
      const raw = nHill(x, y) * 2.4 + nHill2(x, y) * 0.6 + d * 0.07 - 0.9;
      return BASE_H + Math.max(0, Math.round(clamp(raw * smooth(d / 7) * smooth((e - 1) / 8), 0, 4) / 0.5) * 0.5);
    };

    // tiles: 1 m inside the bounds (plus 2 m), 2 m in the scenery around them
    const tiles = [];   // [x0, y0, size, surf, h]
    const inner = (x, y) => x >= b[0] - 2 && x < b[2] + 2 && y >= b[1] - 2 && y < b[3] + 2;
    for (let j = 0; j < gh; j += 2) {
      for (let i = 0; i < gw; i += 2) {
        const x0 = ox + i, y0 = oy + j;
        if (inner(x0 + 1, y0 + 1) || inner(x0, y0) || inner(x0 + 2, y0 + 2)) {
          for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
            const x = x0 + di + 0.5, y = y0 + dj + 0.5;
            const s = surfaceAt(course, x, y);
            const h = s === SURF.OOB ? sceneryH(x, y) : SURF_H[s];
            tiles.push([x0 + di, y0 + dj, 1, s, h]);
            hg[(j + dj) * gw + i + di] = h; sg[(j + dj) * gw + i + di] = s;
          }
        } else {
          const h = sceneryH(x0 + 1, y0 + 1);
          tiles.push([x0, y0, 2, SURF.OOB, h]);
          for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) { hg[(j + dj) * gw + i + di] = h; sg[(j + dj) * gw + i + di] = SURF.OOB; }
        }
      }
    }

    // colours
    const ta = num(course.tee && course.tee.a, Math.PI / 2), tdx = Math.cos(ta), tdy = Math.sin(ta);
    const P = {
      rough: C('#4a8c33'), fairA: C('#82c94c'), fairB: C('#73bb43'), greenA: C('#9be063'), greenB: C('#90d75a'),
      tee: C('#8ed35b'), teeB: C('#84c955'), sand: C('#f1dba3'), bed: C('#24697a'), scen: C('#5a9a3b'), scenHi: C('#6aa845'),
      dirt: C('#8b5e3c'), dirtDeep: C('#6b4a33'), stone: C('#6f6d78'),
      flowers: [C('#ffd84a'), C('#ff8fb8'), C('#ffffff'), C('#b48cff')],
    };
    const nVar = makeNoise(91 + ci, 4.5);
    const topColor = (s, x, y, h, out) => {
      const j = 1 + (Math.min(2, Math.floor(nVar(x, y) * 3)) - 1) * 0.055;
      switch (s) {
        case SURF.FAIRWAY: {
          const band = Math.floor(((x - course.tee.x) * tdx + (y - course.tee.y) * tdy) / 5);
          out.copy(band & 1 ? P.fairA : P.fairB); break;
        }
        case SURF.GREEN: out.copy((Math.floor(x / 2) + Math.floor(y / 2)) & 1 ? P.greenA : P.greenB); break;
        case SURF.TEE: out.copy((Math.floor(x) + Math.floor(y)) & 1 ? P.tee : P.teeB); break;
        case SURF.SAND: out.copy(P.sand).multiplyScalar(1 + (j - 1) * 0.6); break;
        case SURF.WATER: out.copy(P.bed).multiplyScalar(j); break;
        case SURF.ROUGH: out.copy(P.rough).multiplyScalar(j); break;
        default: {
          if (rnd() < 0.02) { out.copy(P.flowers[(rnd() * 4) | 0]); break; }
          out.copy(P.scen).lerp(P.scenHi, clamp(h / 3, 0, 1)).multiplyScalar(j);
        }
      }
      return out;
    };

    // ground mesh: tops, then side walls down to the lower neighbour
    const pos = [], nrm = [], col = [], uv = [], idx = [];
    const quad = (a, bq, c, d, n, ca, cb, ua) => {
      // a, b, c, d: [x, y, z] in order around the quad; ca for a/d (top edge), cb for b/c
      const base = pos.length / 3;
      for (const p of [a, bq, c, d]) pos.push(p[0], p[1], p[2]);
      for (let k = 0; k < 4; k++) nrm.push(n[0], n[1], n[2]);
      const cs = [ca, cb || ca, cb || ca, ca];
      for (const cc of cs) col.push(cc.r, cc.g, cc.b);
      uv.push(ua[0], ua[1], ua[2], ua[3], ua[4], ua[5], ua[6], ua[7]);
      // winding: make it face n
      const ux = bq[0] - a[0], uy = bq[1] - a[1], uz = bq[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    const cTop = new THREE.Color(), cA = new THREE.Color(), cB = new THREE.Color(), cLip = new THREE.Color();
    const hAt = (x, y) => {
      const i = Math.floor(x - ox), j = Math.floor(y - oy);
      if (i < 0 || j < 0 || i >= gw || j >= gh) return NONE;
      return hg[j * gw + i];
    };
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const sides = new Map(), sideCols = new Map();
    const side = (dx, dy, ax, ay, top, bot, ca, cb) => {
      const key = dx + '|' + dy + '|' + (dx ? ax : ay) + '|' + top.toFixed(3) + '|' + bot.toFixed(3) + '|' + ca.getHexString() + cb.getHexString();
      let l = sides.get(key);
      if (!l) { l = []; sides.set(key, l); sideCols.set(key, [ca.clone(), cb.clone()]); }
      l.push(dx ? ay : ax);
    };
    const waterQuads = [], rows = new Map();
    const sAt = (x, y) => { const i = Math.floor(x - ox), j = Math.floor(y - oy); return i < 0 || j < 0 || i >= gw || j >= gh ? -1 : sg[j * gw + i]; };
    const ROUGH_EDGE = P.rough.clone().lerp(P.fairB, 0.45), COLLAR = C('#86cf55');
    const nEdgeJ = makeNoise(55 + ci, 2.2);
    for (const t of tiles) {
      const [x0, y0, sz, s, h] = t;
      const x1 = x0 + sz, y1 = y0 + sz;
      const cx0 = x0 + sz / 2, cy0 = y0 + sz / 2, o = sz / 2 + 0.5;
      topColor(s, cx0, cy0, h, cTop);
      // a ragged first cut where fairway meets rough, a neat collar round the green
      if (s === SURF.FAIRWAY || s === SURF.GREEN) {
        let edge = false;
        for (const [dx, dy] of DIRS) { const n = sAt(cx0 + dx * o, cy0 + dy * o); if (n !== s && n !== SURF.SAND && (s === SURF.GREEN || n === SURF.ROUGH)) edge = true; }
        if (edge && s === SURF.FAIRWAY && nEdgeJ(cx0, cy0) > 0.35) cTop.copy(ROUGH_EDGE);
        else if (edge && s === SURF.GREEN) cTop.copy(COLLAR);
      }
      // baked ambient occlusion: a block next to a taller one is darker
      let up = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const nh = hAt(cx0 + dx * o, cy0 + dy * o);
        if (nh !== NONE && nh > h + 0.05) up = Math.max(up, Math.min(1, (nh - h) / 0.5) * (dx && dy ? 0.6 : 1));
      }
      if (up > 0) cTop.multiplyScalar(1 - 0.16 * up);
      const rk = y0 * 4 + sz;
      if (!rows.has(rk)) rows.set(rk, []);
      rows.get(rk).push([x0, y0, sz, h, cTop.r, cTop.g, cTop.b]);
      if (s === SURF.WATER) waterQuads.push(x0, y0, sz);
      const grassy = s !== SURF.SAND && s !== SURF.WATER;
      for (const [dx, dy] of DIRS) {
        for (let k = 0; k < sz; k++) {
          // the segment [k, k+1] along this edge, sampled 0.5 m outside
          let sx, sy, ax, ay, bx, by;
          if (dx) { const ex = dx > 0 ? x1 : x0; sx = ex + dx * 0.5; sy = y0 + k + 0.5; ax = ex; ay = y0 + k; bx = ex; by = y0 + k + 1; }
          else { const ey = dy > 0 ? y1 : y0; sy = ey + dy * 0.5; sx = x0 + k + 0.5; ax = x0 + k; ay = ey; bx = x0 + k + 1; by = ey; }
          let nh = hAt(sx, sy);
          if (nh === NONE) nh = BASE_H;     // the landscape beyond the grid starts flat
          if (nh >= h - 1e-3) continue;
          const drop = h - nh;
          if (grassy && drop > 0.32) {
            const lip = Math.min(0.2, drop * 0.5);
            cLip.copy(cTop).multiplyScalar(0.78);
            side(dx, dy, ax, ay, h, h - lip, cLip, cLip);
            cA.copy(P.dirt);
            cB.copy(P.dirt).multiplyScalar(0.62);
            side(dx, dy, ax, ay, h - lip, nh, cA, cB);
          } else {
            cA.copy(s === SURF.SAND ? P.sand : s === SURF.WATER ? P.dirt : cTop).multiplyScalar(s === SURF.SAND ? 0.82 : 0.76);
            if (s === SURF.WATER || (nh <= SURF_H[SURF.WATER] + 0.01)) cB.copy(P.dirtDeep); else cB.copy(cA);
            if (grassy && nh <= SURF_H[SURF.WATER] + 0.01) cA.copy(cTop).multiplyScalar(0.7);
            cB.multiplyScalar(0.8);
            side(dx, dy, ax, ay, h, nh, cA, cB);
          }
        }
      }
    }
    // sides: unit segments on the same line with the same heights and colours merge
    for (const [key, list] of sides) {
      const [dx, dy, line, top, bot] = key.split('|').map(Number);
      const [ca, cb] = sideCols.get(key);
      list.sort((a, c) => a - c);
      for (let i = 0; i < list.length;) {
        let k = i + 1, e = list[i] + 1;
        while (k < list.length && list[k] === e) { e++; k++; }
        const a0 = list[i], len = e - a0, d = top - bot;
        const A = dx ? [line, a0] : [a0, line], B = dx ? [line, e] : [e, line];
        quad([A[0], top, A[1]], [A[0], bot, A[1]], [B[0], bot, B[1]], [B[0], top, B[1]], [dx, 0, dy], ca, cb, [0, 0, 0, d, len, d, len, 0]);
        i = k;
      }
    }
    // tops: runs of equal tiles along x become one quad (the texture keeps the 1 m grid)
    for (const row of rows.values()) {
      row.sort((a, c) => a[0] - c[0]);
      for (let i = 0; i < row.length;) {
        const a = row[i];
        let k = i + 1, x1 = a[0] + a[2];
        while (k < row.length && row[k][0] === x1 && row[k][3] === a[3] && row[k][4] === a[4] && row[k][5] === a[5] && row[k][6] === a[6]) { x1 += a[2]; k++; }
        cTop.setRGB(a[4], a[5], a[6]);
        const y0 = a[1], y1 = y0 + a[2], h = a[3], len = x1 - a[0];
        quad([a[0], h, y0], [a[0], h, y1], [x1, h, y1], [x1, h, y0], [0, 1, 0], cTop, null, [0, 0, 0, a[2], len, a[2], len, 0]);
        i = k;
      }
    }
    // ── the landscape around the hole: 8 m blocks of meadow, fields, woods and lakes,
    //    then flat ground to the horizon; haze does the rest
    const farTrees = [];
    {
      const FAR = 240;
      const mx0 = ox - FAR, my0 = oy - FAR, cw = (gw + 2 * FAR) / 8, ch = (gh + 2 * FAR) / 8;
      const mh = new Float32Array(cw * ch).fill(BASE_H), kind = new Int8Array(cw * ch);   // 0 meadow, 1 field, 2 wood, 3 lake, -1 inside the grid
      const nA = makeNoise(31 + ci, 70), nB = makeNoise(37 + ci, 23), nL = makeNoise(41 + ci, 90), nW = makeNoise(43 + ci, 45), nF = makeNoise(47 + ci, 36);
      const rectD = (x, y) => Math.hypot(Math.max(ox - x, 0, x - (ox + gw)), Math.max(oy - y, 0, y - (oy + gh)));
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
        const x = mx0 + i * 8 + 4, y = my0 + j * 8 + 4, k = j * cw + i;
        if (x > ox && x < ox + gw && y > oy && y < oy + gh) { kind[k] = -1; continue; }
        const d = rectD(x, y);
        const hill = (nA(x, y) * 8 + nB(x, y) * 3 - 4.2) * smooth((d - 12) / 70);
        let h = BASE_H + Math.max(0, Math.round(clamp(hill, 0, 12)));
        let t = 0;
        if (d > 36 && nL(x, y) < 0.27 && hill < 1) { t = 3; h = SURF_H[SURF.WATER]; }
        else if (nW(x, y) > 0.6 && d > 10) t = 2;
        else if (nF(x, y) > 0.55 && h < 2) t = 1;
        mh[k] = h; kind[k] = t;
      }
      W.mid = { x0: mx0, y0: my0, cw, ch, mh };
      const midAt = (x, y) => {
        const i = Math.floor((x - mx0) / 8), j = Math.floor((y - my0) / 8);
        if (i < 0 || j < 0 || i >= cw || j >= ch) return BASE_H;
        return kind[j * cw + i] < 0 ? BASE_H : mh[j * cw + i];
      };
      const FIELDS = [C('#d8c76a'), C('#a7c85a'), C('#c9b45a'), C('#8fbf4f')];
      const MEADOW = C('#62a141'), MEADOW_HI = C('#86ad4e'), WOOD = C('#3f7d34'), LAKEBED = C('#24697a');
      const cc = new THREE.Color(), lip = new THREE.Color(), dirt = new THREE.Color().copy(P.dirt);
      const mrows = new Map();
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
        const k = j * cw + i, t = kind[k];
        if (t < 0) continue;
        const x0 = mx0 + i * 8, y0 = my0 + j * 8, h = mh[k];
        if (t === 3) { cc.copy(LAKEBED); waterQuads.push(x0, y0, 8); }
        else if (t === 2) cc.copy(WOOD);
        else if (t === 1) cc.copy(FIELDS[Math.floor(nB(x0 * 3.1, y0 * 2.7) * 4) % 4]);
        else cc.copy(MEADOW).lerp(MEADOW_HI, clamp((h - BASE_H) / 8, 0, 1)).multiplyScalar(1 + (Math.min(2, Math.floor(nVar(x0, y0) * 3)) - 1) * 0.05);
        if (!mrows.has(j)) mrows.set(j, []);
        mrows.get(j).push([x0, y0, 8, h, cc.r, cc.g, cc.b]);
        if (t === 2 && rnd() < 0.38) farTrees.push([x0 + 2 + rnd() * 4, y0 + 2 + rnd() * 4, h, 2.2 + rnd() * 1.8, 6 + rnd() * 5]);
        for (const [dx, dy] of DIRS) {
          const nh = midAt(x0 + 4 + dx * 8, y0 + 4 + dy * 8);
          if (nh >= h - 1e-3) continue;
          let ax, ay, bx, by;
          if (dx) { const ex = dx > 0 ? x0 + 8 : x0; ax = ex; ay = y0; bx = ex; by = y0 + 8; }
          else { const ey = dy > 0 ? y0 + 8 : y0; ax = x0; ay = ey; bx = x0 + 8; by = ey; }
          const dr = h - nh, l = Math.min(0.25, dr * 0.4);
          lip.copy(cc).multiplyScalar(0.78);
          quad([ax, h, ay], [ax, h - l, ay], [bx, h - l, by], [bx, h, by], [dx, 0, dy], lip, lip, [0, 0, 0, l, 8, l, 8, 0]);
          quad([ax, h - l, ay], [ax, nh, ay], [bx, nh, by], [bx, h - l, by], [dx, 0, dy], dirt, dirt, [0, 0, 0, dr - l, 8, dr - l, 8, 0]);
        }
      }
      for (const row of mrows.values()) {
        row.sort((a, c) => a[0] - c[0]);
        for (let i = 0; i < row.length;) {
          const a = row[i];
          let k = i + 1, x1 = a[0] + 8;
          while (k < row.length && row[k][0] === x1 && row[k][3] === a[3] && row[k][4] === a[4] && row[k][5] === a[5] && row[k][6] === a[6]) { x1 += 8; k++; }
          cc.setRGB(a[4], a[5], a[6]);
          const len = x1 - a[0];
          quad([a[0], a[3], a[1]], [a[0], a[3], a[1] + 8], [x1, a[3], a[1] + 8], [x1, a[3], a[1]], [0, 1, 0], cc, null, [0, 0, 0, 8, len, 8, len, 0]);
          i = k;
        }
      }
      // flat ground from the landscape's edge to the horizon (four quads around it)
      const X0 = mx0, Y0 = my0, X1 = mx0 + cw * 8, Y1 = my0 + ch * 8, cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2, R = 2900;
      const A = cx - R, B = cy - R, Cx = cx + R, D = cy + R, hb = BASE_H;
      cc.copy(MEADOW).multiplyScalar(0.95);
      const flatUv = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
      quad([A, hb, B], [A, hb, Y0], [Cx, hb, Y0], [Cx, hb, B], [0, 1, 0], cc, null, flatUv);
      quad([A, hb, Y1], [A, hb, D], [Cx, hb, D], [Cx, hb, Y1], [0, 1, 0], cc, null, flatUv);
      quad([A, hb, Y0], [A, hb, Y1], [X0, hb, Y1], [X0, hb, Y0], [0, 1, 0], cc, null, flatUv);
      quad([X1, hb, Y0], [X1, hb, Y1], [Cx, hb, Y1], [Cx, hb, Y0], [0, 1, 0], cc, null, flatUv);
      // far hills on the horizon
      const rMin = Math.hypot(X1 - X0, Y1 - Y0) / 2 + 60;
      const HILL = [C('#5f8f4e'), C('#6e9a58'), C('#577f52')];
      for (let k = 0; k < 34; k++) {
        const a = (k / 34) * TAU + rnd() * 0.15, r = rMin + 150 + rnd() * 900;
        const w = 160 + rnd() * 300, hh = 8 + rnd() * 22, hx = cx + Math.cos(a) * r, hy = cy + Math.sin(a) * r;
        const col2 = HILL[(rnd() * 3) | 0];
        farTrees.push([hx, hy, hb - 1, w / 2, hh, col2, a]);
        farTrees.push([hx + (rnd() - 0.5) * w * 0.3, hy + (rnd() - 0.5) * w * 0.3, hb - 1 + hh * 0.95, w * 0.3, hh * 0.45, col2.clone().multiplyScalar(1.08), a]);
      }
    }

    const gGeo = keep(new THREE.BufferGeometry());
    gGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    gGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    gGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    gGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    gGeo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    gGeo.computeBoundingSphere();
    const ground = new THREE.Mesh(gGeo, groundMat);
    ground.receiveShadow = true;
    root.add(ground);

    // water: one quad per water tile at the surface
    if (waterQuads.length) {
      const wp = [], wi = [], ws = [];
      // how far each corner is from dry land (0 at the shore .. 1 out in the open): a pale rim and foam
      const shoreAt = (x, y, R, step) => {
        let best = R;
        for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
          const d = Math.hypot(dx, dy);
          if (d >= best) continue;
          const hh = heightAt(x + dx + (dx >= 0 ? 0.01 : -0.01), y + dy + (dy >= 0 ? 0.01 : -0.01));
          if (hh > -0.5) best = d;
        }
        return best / R;
      };
      for (let k = 0; k < waterQuads.length; k += 3) {
        const x0 = waterQuads[k], y0 = waterQuads[k + 1], s = waterQuads[k + 2], base = wp.length / 3;
        wp.push(x0, WATER_Y, y0, x0, WATER_Y, y0 + s, x0 + s, WATER_Y, y0 + s, x0 + s, WATER_Y, y0);
        const R = s === 1 ? 3.5 : 14, st = s === 1 ? 0.5 : 4;
        ws.push(shoreAt(x0, y0, R, st), shoreAt(x0, y0 + s, R, st), shoreAt(x0 + s, y0 + s, R, st), shoreAt(x0 + s, y0, R, st));
        wi.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const wg = keep(new THREE.BufferGeometry());
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
      const wn = new Float32Array(wp.length); for (let i = 1; i < wn.length; i += 3) wn[i] = 1;
      wg.setAttribute('normal', new THREE.BufferAttribute(wn, 3));
      wg.setAttribute('aShore', new THREE.Float32BufferAttribute(ws, 1));
      wg.setIndex(wi);
      const water = new THREE.Mesh(wg, waterMat);
      water.renderOrder = 2;
      water.receiveShadow = true;
      root.add(water);
    }

    // props: one instanced unit box for trees, tufts, stakes, markers, the flagpole
    const props = [];   // [x, y(world up), z, sx, sy, sz, yaw, color]
    const box = (x, yb, z, sx, sy, sz, yaw, color, sway = 0) => { props.push([x, yb + sy / 2, z, sx, sy, sz, yaw, color, sway]); return props.length - 1; };
    const LEAF = [C('#3f8f3a'), C('#4c9c3c'), C('#367f39'), C('#58a743'), C('#2f7436')];
    const AUTUMN = [C('#e09a33'), C('#d2662f'), C('#e8c04a')];
    const TRUNK = C('#7a5232');
    const trees = [];
    function addTree(x, y, r, h, rr, record) {
      const g = standAt(x, y), yaw = rr() * TAU;
      const autumn = rr() < 0.12, pine = !record && rr() < 0.3;
      const c1 = (autumn ? AUTUMN : LEAF)[(rr() * (autumn ? 3 : 5)) | 0];
      const c2 = c1.clone().multiplyScalar(1.12), c3 = c1.clone().multiplyScalar(1.22);
      const t0 = h * KG.CANOPY_FROM;
      const ids = [];
      box(x, g, y, 0.7, t0 + 0.5, 0.7, yaw, TRUNK);
      if (pine) {
        const dark = LEAF[2].clone().multiplyScalar(0.85);
        ids.push(box(x, g + t0, y, r * 2, (h - t0) * 0.36, r * 2, yaw, dark, 1));
        ids.push(box(x, g + t0 + (h - t0) * 0.33, y, r * 1.45, (h - t0) * 0.36, r * 1.45, yaw + 0.4, dark.clone().multiplyScalar(1.1), 1));
        ids.push(box(x, g + t0 + (h - t0) * 0.66, y, r * 0.85, (h - t0) * 0.34, r * 0.85, yaw, dark.clone().multiplyScalar(1.2), 1));
      } else {
        const s = r * 2 * 0.92;
        ids.push(box(x, g + t0, y, s, (h - t0) * 0.55, s, yaw, c1, 1));
        ids.push(box(x, g + t0 + (h - t0) * 0.5, y, s * 0.74, (h - t0) * 0.36, s * 0.74, yaw + 0.25, c2, 1));
        ids.push(box(x, g + t0 + (h - t0) * 0.82, y, s * 0.42, (h - t0) * 0.18, s * 0.42, yaw - 0.2, c3, 1));
      }
      if (record) trees.push({ x, y, ids, shake: 0, ph: rr() * TAU });
    }
    for (const t of Array.isArray(course.trees) ? course.trees : []) {
      if (!t || ![0, 1, 2, 3].every((k) => Number.isFinite(t[k]))) continue;
      addTree(t[0], t[1], Math.max(0.6, t[2]), Math.max(2, t[3]), rnd, true);
    }
    // scenery: trees, bushes and rocks outside the bounds, tufts in the rough, white stakes along the bounds
    const occ = new Set(), tufts = [];
    const GRASS = [C('#a6d95e'), C('#8fcb4f'), C('#b9dc6a'), C('#7fbf47')];
    for (const t of tiles) {
      const [x0, y0, sz, s, h] = t;
      const cx = x0 + sz / 2, cy = y0 + sz / 2;
      if (s === SURF.OOB) {
        const d = outD(cx, cy);
        if (d > 3 && rnd() < (sz === 2 ? 0.055 : 0.012)) {
          const key = Math.floor(cx / 5) + ',' + Math.floor(cy / 5);
          if (!occ.has(key) && hAt(cx + 1.5, cy) !== NONE && hAt(cx - 1.5, cy) !== NONE && hAt(cx, cy + 1.5) !== NONE && hAt(cx, cy - 1.5) !== NONE) {
            occ.add(key);
            addTree(cx + (rnd() - 0.5) * 0.6, cy + (rnd() - 0.5) * 0.6, 1.6 + rnd() * 1.4, 5.5 + rnd() * 4, rnd, false);
            continue;
          }
        }
        if (rnd() < 0.03) box(cx, h, cy, 0.9 + rnd(), 0.5 + rnd() * 0.5, 0.9 + rnd(), rnd() * TAU, LEAF[(rnd() * 5) | 0].clone().multiplyScalar(0.9));
        else if (rnd() < 0.012) { const g = 0.45 + rnd() * 0.25; box(cx, h - 0.1, cy, 0.8 + rnd() * 0.8, 0.5 + rnd() * 0.5, 0.7 + rnd() * 0.6, rnd() * TAU, P.stone.clone().multiplyScalar(g + 0.6)); }
      }
      if ((s === SURF.ROUGH && rnd() < 0.16) || (s === SURF.OOB && sz === 1 && rnd() < 0.08)) {
        const flower = rnd() < 0.06;
        tufts.push([x0 + 0.15 + rnd() * 0.7, h, y0 + 0.15 + rnd() * 0.7, 0.8 + rnd() * 0.6, rnd() * TAU,
          flower ? P.flowers[(rnd() * 4) | 0] : GRASS[(rnd() * GRASS.length) | 0]]);
      }
    }
    const per = 2 * (b[2] - b[0] + b[3] - b[1]);
    const nStake = Math.max(4, Math.round(per / 9));
    const WHITE = C('#f6f3ea');
    for (let k = 0; k < nStake; k++) {
      let u = (k / nStake) * per, x, y;
      const w = b[2] - b[0], hh = b[3] - b[1];
      if (u < w) { x = b[0] + u; y = b[1]; } else if ((u -= w) < hh) { x = b[2]; y = b[1] + u; } else if ((u -= hh) < w) { x = b[2] - u; y = b[3]; } else { u -= w; x = b[0]; y = b[3] - u; }
      const g = heightAt(x, y);
      if (g === NONE || W.sg[Math.floor(y - oy) * gw + Math.floor(x - ox)] === SURF.WATER) continue;
      box(x, g, y, 0.12, 0.85, 0.12, 0, WHITE);
      box(x, g + 0.85, y, 0.14, 0.12, 0.14, 0, C('#2b2f3a'));
    }
    // tee markers
    const tee = course.tee || { x: 0, y: 0, a: Math.PI / 2 };
    const TB = SURF_H[SURF.TEE], rx = -tdy, ry = tdx;
    for (const sg2 of [-1, 1]) {
      const mx = tee.x + tdx * (KG.TEE_W / 2 - 1.2) + rx * sg2 * (KG.TEE_W / 2 - 0.8), my = tee.y + tdy * (KG.TEE_W / 2 - 1.2) + ry * sg2 * (KG.TEE_W / 2 - 0.8);
      box(mx, TB, my, 0.42, 0.42, 0.42, -ta, C(ci % 2 ? '#3d8bff' : '#ff5a5f'));
      box(mx, TB + 0.42, my, 0.22, 0.12, 0.22, -ta, WHITE);
    }
    // flag pole
    const cup = Array.isArray(course.cup) ? course.cup : [0, 0];
    const cupY = heightAt(cup[0], cup[1]) === NONE ? 0 : heightAt(cup[0], cup[1]);
    const POLE = 3.6;
    box(cup[0], cupY, cup[1], 0.09, POLE, 0.09, 0, WHITE);
    box(cup[0], cupY + POLE, cup[1], 0.16, 0.16, 0.16, 0, C('#ffd426'));

    const unit = keep(new THREE.BoxGeometry(1, 1, 1));
    { // nobody sees the bottom of a box
      const ix = Array.from(unit.index.array);
      ix.splice(18, 6);
      unit.setIndex(ix);
    }
    { // a little ambient occlusion: darker at the bottom
      const p = unit.attributes.position, cc = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const v = 0.74 + (p.getY(i) + 0.5) * 0.26; cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = v; }
      unit.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    }
    const propMesh = new THREE.InstancedMesh(unit, propMat, Math.max(1, props.length));
    propMesh.count = props.length;
    const baseM = [];
    props.forEach((pp, i) => {
      _q.setFromAxisAngle(Y_AXIS, pp[6]);
      _m.compose(_p.set(pp[0], pp[1], pp[2]), _q, _s.set(pp[3], pp[4], pp[5]));
      propMesh.setMatrixAt(i, _m);
      propMesh.setColorAt(i, pp[7]);
      baseM.push(pp);
    });
    propMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    propMesh.castShadow = true; propMesh.receiveShadow = true;
    propMesh.computeBoundingSphere();
    {
      const sw = new Float32Array(Math.max(1, props.length));
      props.forEach((pp, i) => { sw[i] = pp[8] || 0; });
      propMesh.geometry = keep(unit.clone());
      propMesh.geometry.setAttribute('aSway', new THREE.InstancedBufferAttribute(sw, 1));
    }
    // grass tufts and flowers in the rough: three blades each, swaying in the wind
    if (tufts.length) {
      const gm = new THREE.InstancedMesh(tuftGeo, grassMat, tufts.length);
      tufts.forEach((t, i) => {
        _q.setFromAxisAngle(Y_AXIS, t[4]);
        _m.compose(_p.set(t[0], t[1], t[2]), _q, _s.set(t[3], t[3], t[3]));
        gm.setMatrixAt(i, _m); gm.setColorAt(i, t[5]);
      });
      gm.computeBoundingSphere();
      gm.receiveShadow = true;
      root.add(gm);
      own.push({ dispose: () => gm.dispose() });
      W.grass = gm;
    }
    root.add(propMesh);
    // far props (no shadows): woods in the landscape and the hills on the horizon
    if (farTrees.length) {
      const n = farTrees.reduce((a, t) => a + (t.length > 5 ? 1 : 2), 0);
      const fm = new THREE.InstancedMesh(unit, propMat, n);
      let k = 0;
      const tr = C('#6e4b2f');
      for (const t of farTrees) {
        if (t.length > 5) {      // hill block: [x, y, base, half width, height, colour, yaw]
          _q.setFromAxisAngle(Y_AXIS, t[6]);
          _m.compose(_p.set(t[0], t[2] + t[4] / 2, t[1]), _q, _s.set(t[3] * 2, t[4], t[3] * 1.4));
          fm.setMatrixAt(k, _m); fm.setColorAt(k++, t[5]);
        } else {                 // tree: [x, y, ground, radius, height]
          const [x, y, g, r, h] = t;
          _q.setFromAxisAngle(Y_AXIS, x * 0.37);
          _m.compose(_p.set(x, g + h * 0.25, y), _q, _s.set(0.8, h * 0.5, 0.8));
          fm.setMatrixAt(k, _m); fm.setColorAt(k++, tr);
          _m.compose(_p.set(x, g + h * 0.67, y), _q, _s.set(r * 2, h * 0.66, r * 2));
          fm.setMatrixAt(k, _m); fm.setColorAt(k++, LEAF[(Math.abs(Math.round(x * 7 + y * 3))) % 5]);
        }
      }
      fm.computeBoundingSphere();
      root.add(fm);
      own.push({ dispose: () => fm.dispose() });
    }

    // cup
    const cupMat = keep(new THREE.MeshBasicMaterial({ color: C('#0a1208'), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const cupGeo = keep(new THREE.CircleGeometry(0.34, 24).rotateX(-Math.PI / 2));
    const hole = new THREE.Mesh(cupGeo, cupMat);
    hole.position.set(cup[0], cupY + 0.006, cup[1]);
    const lip = new THREE.Mesh(keep(new THREE.RingGeometry(0.34, 0.42, 24).rotateX(-Math.PI / 2)), keep(new THREE.MeshBasicMaterial({ color: C('#f4f7ee'), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
    lip.position.set(cup[0], cupY + 0.007, cup[1]);
    root.add(hole, lip);

    // flag cloth
    const flagRoot = new THREE.Group();
    flagRoot.position.set(cup[0], cupY, cup[1]);
    const clothGeo = keep(new THREE.PlaneGeometry(1.6, 1.05, 12, 4).translate(0.8 + 0.05, POLE - 0.55, 0));
    const tex = keep(makeFlagTexture(ci > 0 ? String(ci) : 'Ö'));
    const cloth = new THREE.Mesh(clothGeo, keep(new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75, emissive: C('#ff4a3a'), emissiveIntensity: 0.18 })));
    cloth.castShadow = true;
    flagRoot.add(cloth);
    root.add(flagRoot);

    // the route for the intro flyover
    const line = Array.isArray(course.line) && course.line.length >= 2 ? course.line : [[tee.x, tee.y], cup];
    const pts = line.map((p) => new THREE.Vector3(num(p[0], 0), 0, num(p[1], 0)));
    if (pts.length === 2) pts.splice(1, 0, pts[0].clone().lerp(pts[1], 0.5));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');

    root.userData.own = own;
    return {
      root, trees, propMesh, baseM, cup: [num(cup[0], 0), num(cup[1], 0)], cupY, tee,
      flag: { root: flagRoot, geo: clothGeo, base: Float32Array.from(clothGeo.attributes.position.array), flutter: 0, dir: 0 },
      curve, curveLen: curve.getLength(), holeDir: Math.atan2(cup[1] - tee.y, cup[0] - tee.x),
    };
  }

  function disposeWorld(w) {
    if (!w) return;
    for (const x of w.root.userData.own || []) x.dispose();
    w.propMesh.dispose();
    group.remove(w.root);
  }

  function setCourse(ci) {
    ci = Math.round(Number(ci));
    const course = KCOURSES[ci];
    if (!course || typeof course !== 'object' || !Array.isArray(course.bounds)) {
      if (!W.warned.has(ci)) { W.warned.add(ci); console.warn('[scene] unknown Klossgolf course', ci); }
      return;
    }
    if (ci === W.ci && W.world) return;
    let built;
    try { built = buildWorld(course, ci); } catch (err) { console.warn('[scene] Klossgolf course failed to build', ci, err); return; }
    disposeWorld(W.world);
    W.world = built;
    Object.assign(W, { ci, course, trees: built.trees, flag: built.flag, cup: built.cup, cupY: built.cupY, tee: built.tee, curve: built.curve, curveLen: built.curveLen, holeDir: built.holeDir });
    group.add(built.root);
    for (const r of balls.values()) { r.hist.length = 0; r.trail.length = 0; r.init = false; r.hold = false; r.playT = null; r.queue.length = 0; }
    for (const f of figs.values()) f.init = false;
    cam.snap = true;
  }

  // ── balls ────────────────────────────────────────────────────────────
  const balls = new Map();   // id -> ball record (also holds the figure state)
  const figs = balls;        // one record per player: ball + figure
  const ballGeo = new THREE.IcosahedronGeometry(1, 2);
  const ballMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0, emissive: C('#ffffff'), emissiveIntensity: 0.05 });
  const ballMesh = new THREE.InstancedMesh(ballGeo, ballMat, MAX_FIG);
  ballMesh.count = 0; ballMesh.frustumCulled = false;
  ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ballMesh.setColorAt(0, _c.set(1, 1, 1));
  ballMesh.renderOrder = 4;
  ballMesh.castShadow = true;
  group.add(ballMesh);
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const ballBlob = new THREE.InstancedMesh(blobGeo, new THREE.MeshBasicMaterial({ map: blobTex, color: C('#08200c'), transparent: true, depthWrite: false, opacity: 0.5 }), MAX_FIG * 2);
  ballBlob.count = 0; ballBlob.frustumCulled = false; ballBlob.renderOrder = 2;
  ballBlob.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(ballBlob);

  const meRing = new THREE.Mesh(meRingGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  meRing.renderOrder = 3;
  const meArrow = new THREE.Mesh(meArrowGeo, meArrowMat);
  const meFigArrow = new THREE.Mesh(meArrowGeo, meArrowMat);
  group.add(meRing, meArrow, meFigArrow);

  function makeRec(id) {
    const idn = Number.isFinite(+id) ? Math.abs(Math.round(+id)) : 0;
    const r = {
      id, idn, init: false, seen: 0, lost: 0, me: false,
      hist: [], disp: { x: 0, y: 0, z: 0, st: 0 }, live: { x: 0, y: 0, z: 0, st: 0 }, base: 0, rad: 0.2, vis: true, pop: 1,
      hold: false, holdPos: [0, 0, 0], holdT: 0, swingT0: 0, playT: null, queue: [], trail: [], sinkT: 0, camDist: 10,
      // figure
      fx: 0, fy: 0, px: 0, pz: 0, py: 0, vx: 0, vz: 0, face: 0, mode: 'idle', modeT: 0,
      swing: null, theta: 0, cheerT: 9, slumpT: 9, blinkIn: 1 + Math.random() * 3, blinkT: 9, blink: 0, cheerKind: 0, cheers: 0, runPh: 0, club: 0, aimA: 0, aimKey: '', shotA: 0, skin: C(SKIN[idn % SKIN.length]),
      pose: null, fade: 1, figScale: 1,
    };
    balls.set(id, r);
    return r;
  }

  function sampleAt(r, t, out) {
    const h = r.hist;
    if (!h.length) return out;
    if (t <= h[0][0]) { const s = h[0]; out.x = s[1]; out.y = s[2]; out.z = s[3]; out.st = s[4]; return out; }
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], c = h[i];
      if (t >= a[0]) {
        const k = c[0] > a[0] ? clamp((t - a[0]) / (c[0] - a[0]), 0, 1) : 1;
        out.x = lerp(a[1], c[1], k); out.y = lerp(a[2], c[2], k); out.z = lerp(a[3], c[3], k); out.st = k < 0.5 ? a[4] : c[4];
        return out;
      }
    }
    const s = h[h.length - 1]; out.x = s[1]; out.y = s[2]; out.z = s[3]; out.st = s[4];
    return out;
  }

  let stamp = 0, myRec = null;
  function readBalls(dt, T, view) {
    stamp++;
    const list = Array.isArray(view.balls) ? view.balls : [];
    myRec = null;
    for (const b of list) {
      if (!b || b.id == null || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const r = balls.get(b.id) || makeRec(b.id);
      r.seen = stamp; r.lost = 0;
      const car = cars.get(b.id) || null;
      r.car = car;
      r.me = !!(car && car.isMe) || (view.myId != null && b.id === view.myId);
      if (r.me) myRec = r;
      const st = b.st | 0, z = Math.max(0, num(b.z, 0));
      const last = r.hist.length ? r.hist[r.hist.length - 1] : null;
      const jump = !last || Math.hypot(b.x - last[1], b.y - last[2]) > 6 && !(st & KST.MOVING);
      if (!r.init || jump) {
        r.hist.length = 0; r.trail.length = 0; r.playT = null; r.hold = false; r.queue.length = 0;
        if (r.init) r.pop = 0;
      }
      r.hist.push([T, b.x, b.y, z, st]);
      while (r.hist.length > 2 && r.hist[0][0] < T - 4) r.hist.shift();
      r.live.x = b.x; r.live.y = b.y; r.live.z = z; r.live.st = st;
      // figure position from the server
      const fx = num(b.fx, b.x), fy = num(b.fy, b.y);
      if (!r.init) {
        r.fx = fx; r.fy = fy; r.vx = r.vz = 0;
        r.px = fx; r.pz = fy; r.py = standAt(fx, fy); r.base = standAt(b.x, b.y);
        r.face = num(view.heading, 0) + Math.PI / 2;
        r.mode = 'idle'; r.swing = null; r.pose = null; r.theta = 0;
        r.init = true;
      } else {
        const inv = dt > 1e-4 ? 1 / dt : 0, k = damp(dt, 0.12);
        const dx = fx - r.fx, dy = fy - r.fy;
        if (dx * dx + dy * dy > 400) { r.vx = r.vz = 0; r.px = fx; r.pz = fy; }
        else if (inv) { r.vx += (dx * inv - r.vx) * k; r.vz += (dy * inv - r.vz) * k; }
        r.fx = fx; r.fy = fy;
      }
      r.strokes = b.strokes | 0;
      // displayed ball: held at address until the club meets it, then a short time-warp catch-up
      if (r.hold) {
        const D = r.disp;
        D.x = r.holdPos[0]; D.y = r.holdPos[1]; D.z = 0; D.st = 0;
        if (T >= r.hitAt) {
          let t0 = null;
          for (const s of r.hist) {
            if (s[0] < r.swingT0 - 0.05) continue;
            if ((s[4] & (KST.MOVING | KST.HAZARD | KST.HOLED)) || Math.hypot(s[1] - r.holdPos[0], s[2] - r.holdPos[1]) > 0.05 || s[3] > 0.01) { t0 = s[0]; break; }
          }
          if (t0 !== null) { r.hold = false; r.playT = Math.max(t0 - 1 / 60, r.hist[0][0]); }
          else if (T - r.hitAt > 1.2) r.hold = false;
        }
      }
      if (!r.hold) {
        if (r.playT !== null) {
          r.playT += dt * 1.45;
          if (r.playT >= T) r.playT = null;
        }
        if (r.playT !== null) sampleAt(r, r.playT, r.disp);
        else { r.disp.x = b.x; r.disp.y = b.y; r.disp.z = z; r.disp.st = st; }
      }
      // queued effects fire when the shown ball has caught up with them
      for (let i = 0; i < r.queue.length; i++) {
        const e = r.queue[i];
        if (r.hold && T - e.t < 2) continue;
        if (r.playT !== null && r.playT < e.t && T - e.t < 1.6) continue;
        r.queue.splice(i--, 1);
        e.fn();
      }
    }
    for (const [id, r] of balls) {
      if (r.seen === stamp) continue;
      r.init = false;
      if ((r.lost += dt) > 10) balls.delete(id);
    }
  }

  // ── figures ──────────────────────────────────────────────────────────
  function geoBox(parts) {
    // parts: [w(x), h(y), d(z), cx, cy, cz, hex | [r,g,b], tint]
    const geos = parts.map(([w, h, d, x, y, z, color, tint]) => {
      const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
      const n = g.attributes.position.count, cc = new Float32Array(n * 3), tt = new Float32Array(n);
      _c.set(color);
      for (let i = 0; i < n; i++) {
        const sh = 0.9 + 0.1 * clamp((g.attributes.position.getY(i) - y) / h + 0.5, 0, 1);
        cc[i * 3] = _c.r * sh; cc[i * 3 + 1] = _c.g * sh; cc[i * 3 + 2] = _c.b * sh; tt[i] = tint || 0;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      g.setAttribute('aTint', new THREE.BufferAttribute(tt, 1));
      g.deleteAttribute('uv');
      return g;
    });
    return mergeGeometries(geos);
  }
  const WH = '#ffffff', DARK = '#1b1d2a';
  const torsoGeo = geoBox([
    [0.34, 0.6, 0.58, 0, 0.36, 0, WH, 1],                     // shirt
    [0.36, 0.11, 0.6, 0, 0.06, 0, '#2a2a35', 0],               // belt
    [0.04, 0.09, 0.09, 0.18, 0.06, 0, '#ffd426', 0],           // buckle
    [0.35, 0.07, 0.59, 0, 0.5, 0, '#f4f4f0', 0],               // chest stripe
    [0.2, 0.06, 0.3, 0.08, 0.66, 0, '#f4f4f0', 0],             // collar
  ]);
  const headGeo = geoBox([
    [0.16, 0.1, 0.16, 0, 0.05, 0, WH, 2],                     // neck
    [0.46, 0.46, 0.46, 0, 0.33, 0, WH, 2],                    // head
    [0.03, 0.1, 0.07, 0.235, 0.35, -0.1, DARK, 3],            // eyes (3: they blink)
    [0.03, 0.1, 0.07, 0.235, 0.35, 0.1, DARK, 3],
    [0.02, 0.035, 0.03, 0.246, 0.38, -0.085, '#ffffff', 0],   // eye glints
    [0.02, 0.035, 0.03, 0.246, 0.38, 0.115, '#ffffff', 0],
    [0.03, 0.035, 0.15, 0.235, 0.2, 0, '#7a2e2e', 0],          // smile
    [0.02, 0.05, 0.07, 0.232, 0.25, -0.17, '#f08c8c', 0],     // cheeks
    [0.02, 0.05, 0.07, 0.232, 0.25, 0.17, '#f08c8c', 0],
    [0.12, 0.3, 0.48, -0.19, 0.38, 0, '#4a3020', 0],          // hair at the back
    [0.5, 0.15, 0.5, 0, 0.62, 0, WH, 1],                     // cap
    [0.26, 0.04, 0.42, 0.34, 0.565, 0, '#d8d8d8', 1],         // brim (a touch darker)
    [0.08, 0.06, 0.08, 0, 0.72, 0, '#ffffff', 0],             // button
  ]);
  const ARM_L = 0.7, LEG_L = 0.82;
  const armGeo = geoBox([
    [0.17, 0.36, 0.17, 0, -0.18, 0, WH, 1],                  // sleeve
    [0.14, 0.3, 0.14, 0, -0.5, 0, WH, 2],                    // forearm
    [0.17, 0.13, 0.17, 0, -0.65, 0, '#f6f6f2', 0],           // glove
  ]);
  const legGeo = geoBox([
    [0.23, 0.68, 0.23, 0, -0.34, 0, '#38445f', 0],          // trousers
    [0.34, 0.12, 0.25, 0.05, -0.73, 0, '#f4f4f0', 0],       // shoe
    [0.35, 0.04, 0.26, 0.05, -0.8, 0, '#2c2c34', 0],        // sole
    [0.1, 0.05, 0.255, 0.16, -0.69, 0, WH, 1],              // a stripe in the player's colour
  ]);
  const clubGeo = geoBox([
    [0.065, 0.26, 0.065, 0, -0.12, 0, '#24242c', 0],        // grip
    [0.035, 0.76, 0.035, 0, -0.62, 0, '#c9ced8', 0],        // shaft
    [0.1, 0.09, 0.24, 0.02, -1.0, 0.07, '#5d6270', 0],      // head
    [0.105, 0.03, 0.245, 0.02, -0.96, 0.07, WH, 1],         // a band in the player's colour
  ]);
  const CLUB_GEO_L = 1.0;
  function figPart(geo, cap) {
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aBlink', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.InstancedMesh(geo, figMat, cap);
    m.count = 0; m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) m.setColorAt(i, _c.set(1, 1, 1));
    m.castShadow = true;
    group.add(m);
    return m;
  }
  const torsoM = figPart(torsoGeo, MAX_FIG), headM = figPart(headGeo, MAX_FIG), armM = figPart(armGeo, MAX_FIG * 2),
    legM = figPart(legGeo, MAX_FIG * 2), clubM = figPart(clubGeo, MAX_FIG);
  const figMeshes = [torsoM, headM, armM, legM, clubM];

  const blobFig = ballBlob;   // figure contact shadows share the blob mesh

  // pose: everything in the figure's own frame (+X forward, +Y up, +Z right), feet at the origin
  const newPose = () => ({ hipY: 0.82, lean: 0, tw: 0, nod: 0, hL: V3().set(0.05, 0.72, -0.4), hR: V3().set(0.05, 0.72, 0.4),
    fL: V3().set(0, 0, -0.15), fR: V3().set(0, 0, 0.15), grip: V3().set(0.05, 0.72, 0.4), cd: V3().set(0.3, -0.7, 0.3).normalize(), clubL: 1 });
  const tgt = newPose();

  function addressGeo(c) {
    const L = CLUB_LEN[c] ?? 1, H = HANDS[c] || HANDS[0];
    const ballX = H[0] + Math.sqrt(Math.max(0.05, L * L - (H[1] - 0.06) * (H[1] - 0.06)));
    return { L, hx: H[0], hy: H[1], ballX };
  }

  const _N = V3(), _P = V3(), _B = V3(), _H0 = V3();
  /** Hands and club direction for swing angle theta (0 = address, < 0 back, > 0 through). */
  function gripPose(out, c, theta) {
    const A = addressGeo(c);
    _P.set(0.12, 1.28 - (c === PUTTER ? 0.05 : 0), 0);
    _B.set(A.ballX, 0.06, 0);
    _H0.set(A.hx, A.hy, 0);
    _N.copy(Z_AXIS).cross(_v.copy(_B).sub(_P)).normalize();
    _q.setFromAxisAngle(_N, theta);
    out.grip.copy(_H0).sub(_P).applyQuaternion(_q).add(_P);
    const hinge = theta < 0 ? theta * 0.4 * smooth(-theta / 1.2) : theta * 0.22;
    _q2.setFromAxisAngle(_N, theta + hinge);
    out.cd.copy(_B).sub(_H0).normalize().applyQuaternion(_q2);
    out.hL.copy(out.grip);
    out.hR.copy(out.grip).addScaledVector(out.cd, 0.1);
    out.clubL = A.L;
    out.lean = CLUB_LEAN[c] ?? 0.4;
    out.tw = theta * 0.28;
    out.hipY = 0.8 - (c === PUTTER ? 0.03 : 0.05);
    out.fL.set(0.02, 0, -0.32); out.fR.set(0.02, 0, 0.32);
    out.nod = theta > 0.4 ? -0.2 : -0.32;
  }

  function swingAmp(c, p) {
    return c === PUTTER ? { back: 0.22 + 0.55 * p, thru: 0.25 + 0.5 * p } : { back: 1.1 + 1.75 * p, thru: 2.5 + 0.35 * p };
  }

  function updateFigures(dt, T, view) {
    const myHeading = num(view.heading, 0);
    for (const r of balls.values()) {
      if (r.seen !== stamp) continue;
      const D = r.disp;
      const speed = Math.hypot(r.vx, r.vz);
      const ballRest = !(D.st & (KST.MOVING | KST.HOLED | KST.HAZARD)) && !(r.live.st & (KST.HAZARD | KST.HOLED));
      const near = Math.hypot(r.fx - r.live.x, r.fy - r.live.y) < KG.REACH + 0.6;
      // which club and which way
      let club = r.club, aimA = r.aimA;
      if (r.me && view.aim) { club = clamp(view.aim.club | 0, 0, CLUBS.length - 1); aimA = num(view.aim.angle, myHeading); }
      else if (r.me) aimA = myHeading;
      else if (!r.swing && ballRest && W.course) {
        const key = r.live.x.toFixed(1) + ',' + r.live.y.toFixed(1);
        if (key !== r.aimKey) {
          r.aimKey = key;
          try {
            const t = aimPoint(W.course, r.live.x, r.live.y);
            aimA = Math.atan2(t[1] - r.live.y, t[0] - r.live.x);
            club = suggestClub(W.course, r.live.x, r.live.y, Math.hypot(t[0] - r.live.x, t[1] - r.live.y));
          } catch { /* keep */ }
        }
      }
      r.club = club; r.aimA = aimA;

      // mode
      let mode;
      if (r.swing) mode = 'swing';
      else if (r.cheerT < 2.6) mode = 'cheer';
      else if (speed > 1.2) mode = 'run';
      else if (r.slumpT < 2.2) mode = 'slump';
      else if (ballRest && near) mode = 'addr';
      else mode = 'idle';
      if (r.swing && speed > 2 && T - r.swing.t0 > r.swing.hit + 0.15) { r.swing = null; mode = 'run'; }
      if (mode !== r.mode) { r.mode = mode; r.modeT = 0; } else r.modeT += dt;
      r.cheerT += dt; r.slumpT += dt;
      // blinking
      if ((r.blinkIn -= dt) <= 0) { r.blinkIn = 1.8 + Math.random() * 3.5; r.blinkT = 0; }
      r.blinkT += dt;
      r.blink = r.blinkT < 0.14 ? Math.sin((r.blinkT / 0.14) * Math.PI) : 0;

      // where the figure stands
      let wx = r.fx, wz = r.fy, faceT = r.face;
      if (mode === 'addr' || mode === 'swing') {
        const c = mode === 'swing' ? r.swing.club : club;
        const a = mode === 'swing' ? r.swing.angle : aimA;
        const A = addressGeo(c);
        const f = a + Math.PI / 2;    // face the ball, target on the left
        const bx = mode === 'swing' ? r.holdPos[0] : r.live.x, by = mode === 'swing' ? r.holdPos[1] : r.live.y;
        wx = bx - Math.cos(f) * A.ballX; wz = by - Math.sin(f) * A.ballX;
        faceT = f;
      } else if (mode === 'run') {
        faceT = Math.atan2(r.vz, r.vx);
      } else if (mode === 'cheer') {
        faceT = Math.atan2(camera.position.z - r.pz, camera.position.x - r.px);   // celebrate towards the camera
        if (r.cheerKind === 2 && r.cheerT < 0.9) faceT += smooth(r.cheerT / 0.9) * TAU;   // a happy spin
      }
      const spin = mode === 'cheer' && r.cheerKind === 2 && r.cheerT < 0.9;
      const kp = mode === 'run' ? damp(dt, 0.05) : mode === 'swing' ? 1 : damp(dt, 0.14);
      r.px += (wx - r.px) * kp; r.pz += (wz - r.pz) * kp;
      if (spin) r.face = faceT;
      else r.face += angDiff(faceT, r.face) * (mode === 'swing' ? 1 : damp(dt, mode === 'run' ? 0.07 : 0.12));
      r.py += (standAt(r.px, r.pz) - r.py) * damp(dt, 0.08);

      // target pose
      const p = tgt;
      let tau = 0.1;
      p.sway = 0;
      if (mode === 'swing' || mode === 'addr') {
        let theta = 0;
        if (mode === 'swing') {
          const s = r.swing, t = T - s.t0;
          if (t < s.tb) theta = lerp(s.th0, -s.back, easeOut(t / s.tb));
          else if (t < s.hit) theta = lerp(-s.back, 0, easeIn((t - s.tb) / (s.hit - s.tb)));
          else theta = lerp(0, s.thru, easeOut(clamp((t - s.hit) / 0.24, 0, 1)));
          if (t >= s.hit && !s.hitDone) { s.hitDone = true; onHit(r, s); }
          if (t > s.hit + 1.6) r.swing = null;
          tau = 0;
          gripPose(p, s.club, theta);
          if (t > s.hit) p.nod = -0.1;
        } else {
          // the local player draws the club back while the meter charges
          if (r.me && view.aim && view.aim.charging) theta = -swingAmp(club, clamp(num(view.aim.power, 0), 0, 1)).back * 0.92;
          else {   // a waggle now and then, and the weight rocking from foot to foot
            const burst = Math.pow(Math.max(0, Math.sin(T * 0.55 + r.idn * 1.7)), 10);
            theta = Math.sin(T * 1.7 + r.idn) * 0.035 + burst * 0.22 * Math.sin(T * 8);
          }
          tau = r.me && view.aim && view.aim.charging ? 0.05 : 0.12;
          gripPose(p, club, theta);
          p.sway = Math.sin(T * 1.1 + r.idn) * 0.035;
        }
        r.theta = theta;
      } else if (mode === 'run') {
        r.runPh += dt * (6 + speed * 0.45);
        const s = Math.sin(r.runPh), a = 0.95 * clamp(speed / 8, 0.4, 1);
        p.hipY = 0.78 + Math.abs(Math.cos(r.runPh)) * 0.06;
        p.lean = 0.28; p.tw = s * 0.12; p.nod = 0.15;
        // the planted foot stays on the ground, the swinging one lifts a little
        p.fL.set(s * a * 0.5, Math.max(0, -s) * 0.24, -0.16);
        p.fR.set(-s * a * 0.5, Math.max(0, s) * 0.24, 0.16);
        p.hL.set(0.18 - s * 0.45, 1.05 + Math.abs(s) * 0.12, -0.38);
        p.hR.set(0.18 + s * 0.45, 1.05 + Math.abs(s) * 0.12, 0.38);
        p.grip.copy(p.hR); p.cd.set(-0.45, 0.85, 0.2).normalize(); p.clubL = 0.95;
        tau = 0.05;
      } else if (mode === 'cheer') {
        const t = r.cheerT, k = r.cheerKind | 0;
        if (k === 1) {          // fist pump with the club, the other hand on the hip
          const pump = Math.abs(Math.sin(t * 7));
          p.hipY = 0.8 - pump * 0.04; p.lean = 0.05; p.tw = -0.25; p.nod = 0.2;
          p.fL.set(0.05, 0, -0.26); p.fR.set(-0.05, 0, 0.26);
          p.hL.set(0.05, 0.85, -0.42);
          p.hR.set(0.15, 1.5 + pump * 0.65, 0.42);
          p.grip.copy(p.hR); p.cd.set(-0.2, 1, 0.1).normalize(); p.clubL = 0.95;
          tau = 0.04;
        } else {                // 0: jumping jacks, 2: a spin, then arms up
          const j = k === 0 && t < 1.8 ? Math.abs(Math.sin(t * 8)) * 0.35 : 0;
          const out = k === 2 && t < 0.9;
          p.hipY = 0.82 + j; p.lean = -0.08; p.tw = Math.sin(t * 6) * 0.15; p.nod = 0.25;
          p.fL.set(0, j * 0.3, -0.2); p.fR.set(0, j * 0.3, 0.2);
          const wave = Math.sin(t * 12) * 0.12;
          if (out) { p.hL.set(0, 1.4, -1.05); p.hR.set(0, 1.4, 1.05); }
          else { p.hL.set(0.05, 2.15 + j + wave, -0.48); p.hR.set(0.05, 2.15 + j - wave, 0.48); }
          p.grip.copy(p.hR); p.cd.set(0.1, 1, 0.25).normalize(); p.clubL = 0.95;
          tau = 0.06;
        }
      } else if (mode === 'slump') {   // the ball found the water
        const t = r.slumpT;
        p.hipY = 0.78; p.lean = 0.5; p.tw = Math.sin(t * 1.5) * 0.06; p.nod = -0.7;
        p.fL.set(0, 0, -0.18); p.fR.set(0, 0, 0.18);
        p.hL.set(0.3, 0.55, -0.25); p.hR.set(0.3, 0.55, 0.25);
        p.grip.copy(p.hR); p.cd.set(0.45, -0.85, 0.1).normalize(); p.clubL = 0.95;
        tau = 0.25;
      } else {
        const br = Math.sin(T * 2 + r.idn) * 0.012;
        p.hipY = 0.82 + br; p.lean = 0.04; p.tw = 0; p.nod = 0;
        p.fL.set(0, 0, -0.17); p.fR.set(0, 0, 0.17);
        p.hL.set(0.06, 0.74 + br, -0.4); p.hR.set(0.12, 0.74 + br, 0.4);
        p.grip.copy(p.hR); p.cd.set(0.35, -0.78, 0.25).normalize(); p.clubL = 0.95;
      }
      if (!r.pose) { r.pose = newPose(); copyPose(r.pose, p); }
      blendPose(r.pose, p, damp(dt, tau));
    }
  }
  function copyPose(a, b) {
    a.sway = b.sway || 0;
    a.hipY = b.hipY; a.lean = b.lean; a.tw = b.tw; a.nod = b.nod; a.clubL = b.clubL;
    a.hL.copy(b.hL); a.hR.copy(b.hR); a.fL.copy(b.fL); a.fR.copy(b.fR); a.grip.copy(b.grip); a.cd.copy(b.cd);
  }
  function blendPose(a, b, k) {
    if (k >= 1) { copyPose(a, b); return; }
    a.sway = (a.sway || 0) + ((b.sway || 0) - (a.sway || 0)) * k;
    a.hipY += (b.hipY - a.hipY) * k; a.lean += (b.lean - a.lean) * k; a.tw += (b.tw - a.tw) * k; a.nod += (b.nod - a.nod) * k; a.clubL += (b.clubL - a.clubL) * k;
    a.hL.lerp(b.hL, k); a.hR.lerp(b.hR, k); a.fL.lerp(b.fL, k); a.fR.lerp(b.fR, k); a.grip.lerp(b.grip, k);
    a.cd.lerp(b.cd, k).normalize();
  }

  // writing instance matrices
  const _X = V3(), _Y = V3(), _Z = V3(), _fwd = V3(), _o = V3(), _e = V3();
  const Mf = new THREE.Matrix4();
  /** Matrix for a part hanging from `start` along -Y to `end` (length L0 in the geometry). */
  function limbMatrix(out, start, end, L0, ref) {
    _Y.copy(start).sub(end);
    const len = _Y.length() || 1e-4;
    _Y.divideScalar(len);
    _X.copy(ref).addScaledVector(_Y, -ref.dot(_Y));
    if (_X.lengthSq() < 1e-6) _X.set(1, 0, 0).addScaledVector(_Y, -_Y.x);
    _X.normalize();
    _Z.crossVectors(_X, _Y);
    out.makeBasis(_X, _Y.multiplyScalar(len / L0), _Z);
    out.setPosition(start);
    return out;
  }

  function writeFigures(T, view) {
    let n = 0, nb = 0;
    const spect = !!view.spectate;
    const camP = camera.position;
    for (const r of balls.values()) {
      if (r.seen !== stamp || !r.pose || n >= MAX_FIG) continue;
      const p = r.pose;
      const dist = Math.hypot(r.px - camP.x, r.py - camP.y, r.pz - camP.z);
      r.camDist = dist;
      const S = r.me && !spect ? 1 : clamp(dist / 34, 1, spect ? 2.4 : 1.8);
      r.figScale += (S - r.figScale) * 0.1;
      // fade other figures that crowd the local player's ball or the camera
      let fade = 1;
      if (!spect && myRec && !r.me) {
        const dm = Math.hypot(r.px - myRec.disp.x, r.pz - myRec.disp.y);
        fade = Math.min(smooth((dm - 2.3) / 1.4), smooth((dist - 2.5) / 3));
        fade = Math.max(fade, 0.0);
      }
      r.fade += (fade - r.fade) * 0.15;
      if (r.fade < 0.03) continue;
      const color = r.car ? r.car.color : _c.set(PALETTE[r.idn % PALETTE.length]);
      _q.setFromAxisAngle(Y_AXIS, -r.face);
      Mf.compose(_p.set(r.px, r.py, r.pz), _q, _s.setScalar(r.figScale));
      // torso
      const qT = _q2.setFromAxisAngle(Y_AXIS, -p.tw);
      _q.setFromAxisAngle(Z_AXIS, -p.lean);
      qT.multiply(_q);
      _m.compose(_o.set(0, p.hipY, p.sway || 0), qT, _s.set(1, 1, 1));
      torsoM.setMatrixAt(n, _m2.multiplyMatrices(Mf, _m));
      // head
      _e.set(0, 0.68, 0).applyQuaternion(qT).add(_o);
      _q.setFromAxisAngle(Z_AXIS, p.nod);
      _m.compose(_e, _q.premultiply(qT), _s.set(1, 1, 1));
      headM.setMatrixAt(n, _m2.multiplyMatrices(Mf, _m));
      // arms
      _fwd.set(1, 0, 0).applyQuaternion(qT);
      for (let side = 0; side < 2; side++) {
        const sz = side ? 0.37 : -0.37;
        const sh = _v.set(0, 0.56, sz).applyQuaternion(qT).add(_o);
        const hand = side ? p.hR : p.hL;
        limbMatrix(_m, sh, hand, ARM_L, _fwd);
        armM.setMatrixAt(n * 2 + side, _m2.multiplyMatrices(Mf, _m));
        // legs
        const hip = _v2.set(0, p.hipY, (side ? 0.15 : -0.15) + (p.sway || 0));
        const foot = _v3.copy(side ? p.fR : p.fL);    // a ground point: the leg's sole ends exactly there
        limbMatrix(_m, hip, foot, LEG_L, _X.set(1, 0, 0));
        legM.setMatrixAt(n * 2 + side, _m2.multiplyMatrices(Mf, _m));
      }
      // club
      _e.copy(p.grip).addScaledVector(p.cd, p.clubL);
      limbMatrix(_m, p.grip, _e, CLUB_GEO_L, _v.set(1, 0, 0));
      clubM.setMatrixAt(n, _m2.multiplyMatrices(Mf, _m));
      // colours and fade
      for (const m of figMeshes) {
        const two = m === armM || m === legM;
        const ks = two ? [n * 2, n * 2 + 1] : [n];
        for (const k of ks) {
          m.setColorAt(k, color);
          const sk = m.geometry.attributes.aSkin, fa = m.geometry.attributes.aFade;
          sk.setXYZ(k, r.skin.r, r.skin.g, r.skin.b);
          fa.setX(k, r.fade);
          m.geometry.attributes.aBlink.setX(k, r.blink || 0);
        }
      }
      // contact shadow
      const bs = 1.3 * r.figScale;
      _m.makeScale(bs, 1, bs).setPosition(r.px + 0.1, r.py + 0.02, r.pz + 0.08);
      blobFig.setMatrixAt(MAX_FIG + nb, _m); nb++;
      r.slot = n;
      n++;
    }
    for (const m of figMeshes) {
      const two = m === armM || m === legM;
      m.count = two ? n * 2 : n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.geometry.attributes.aSkin.needsUpdate = true;
      m.geometry.attributes.aFade.needsUpdate = true;
      m.geometry.attributes.aBlink.needsUpdate = true;
    }
    return nb;
  }

  // ── balls on screen ──────────────────────────────────────────────────
  const tanHalf = () => Math.tan((camera.fov * DEG) / 2);
  function writeBalls(dt, T, view, nFigBlobs) {
    let n = 0;
    const camP = camera.position;
    for (const r of balls.values()) {
      if (r.seen !== stamp || n >= MAX_FIG) continue;
      const D = r.disp;
      const st = D.st;
      const g = standAt(D.x, D.y);
      if (D.z < 0.05) r.base += (g - r.base) * damp(dt, 0.06);
      else r.base += (g - r.base) * damp(dt, 0.5);
      r.pop = Math.min(1, r.pop + dt / 0.35);
      let y = r.base + D.z, vis = !(st & KST.HAZARD);
      if (st & KST.HOLED) { r.sinkT += dt; y = r.base - smooth(r.sinkT / 0.35) * 0.6; if (r.sinkT > 0.45) vis = false; }
      else r.sinkT = 0;
      if (!vis) { r.vis = false; continue; }
      r.vis = true;
      const dist = Math.hypot(D.x - camP.x, y - camP.y, D.y - camP.z);
      const rad = clamp(dist * 0.0062, 0.125, 1.1) * (r.me ? 1.15 : 1) * (0.4 + 0.6 * Math.min(1, r.pop * 1.2));
      r.rad = rad;
      _m.compose(_p.set(D.x, y + rad * 0.85, D.y), _q.identity(), _s.setScalar(rad));
      ballMesh.setMatrixAt(n, _m);
      const color = r.car ? r.car.color : _c.set(PALETTE[r.idn % PALETTE.length]);
      _c.set(1, 1, 1);
      if (!r.me) _c.lerp(color, 0.45);
      ballMesh.setColorAt(n, _c);
      // shadow under the ball (smaller and lighter as it climbs)
      const hs = clamp(1 - D.z / 18, 0.35, 1);
      _m.makeScale(rad * 2.6 * hs, 1, rad * 2.6 * hs).setPosition(D.x, g + 0.025, D.y);
      ballBlob.setMatrixAt(n, _m);
      // trail
      const air = D.z > 0.15 || (st & KST.MOVING && Math.hypot(D.x - (r.lx ?? D.x), D.y - (r.ly ?? D.y)) > dt * 9);
      if (air) {
        const last = r.trail[r.trail.length - 1];
        if (!last || Math.hypot(D.x - last[0], y - last[1], D.y - last[2]) > 0.35) { r.trail.push([D.x, y + rad * 0.85, D.y, T]); if (r.trail.length > 48) r.trail.shift(); }
      }
      while (r.trail.length && T - r.trail[0][3] > 1.1) r.trail.shift();
      r.lx = D.x; r.ly = D.y;
      n++;
    }
    ballMesh.count = n;
    ballMesh.instanceMatrix.needsUpdate = true;
    if (ballMesh.instanceColor) ballMesh.instanceColor.needsUpdate = true;
    // figure blobs were written after MAX_FIG; compact them behind the ball blobs
    for (let i = 0; i < nFigBlobs; i++) { ballBlob.getMatrixAt(MAX_FIG + i, _m); ballBlob.setMatrixAt(n + i, _m); }
    ballBlob.count = n + nFigBlobs;
    ballBlob.instanceMatrix.needsUpdate = true;

    // the local player's markers
    const m = myRec;
    if (m && m.vis && !view.spectate && !(m.disp.st & (KST.MOVING | KST.HOLED | KST.HAZARD)) && !m.hold) {
      const s = clamp(m.rad / 0.18, 1, 4) * 0.38;
      meRing.visible = true;
      meRing.position.set(m.disp.x, standAt(m.disp.x, m.disp.y) + 0.03, m.disp.y);
      meRing.rotation.y = T * 1.3;
      meRing.scale.setScalar(s * (1 + Math.sin(T * 5) * 0.06));
      meArrow.visible = !view.aim;
      meArrow.position.set(m.disp.x, m.base + 1.0 * s / 0.38 + Math.sin(T * 4.2) * 0.1, m.disp.y);
      meArrow.scale.setScalar(0.62 * s / 0.38);
      meArrow.rotation.y = T * 2.2;
    } else { meRing.visible = false; meArrow.visible = false; }
    // a marker above the local figure whenever it is not addressing the ball
    if (m && m.pose && (view.spectate || num(view.intro, 0) > 0 || (m.mode === 'idle' && m.camDist > 12))) {
      meFigArrow.visible = true;
      const s = m.figScale;
      meFigArrow.position.set(m.px, m.py + (2.55 + (m.mode === 'cheer' ? 0.6 : 0)) * s + Math.sin(T * 4.2) * 0.12, m.pz);
      meFigArrow.scale.setScalar(0.85 * s);
      meFigArrow.rotation.y = T * 2.2;
    } else meFigArrow.visible = false;
  }

  // ── strips: trails, the aim arc, the roll line ───────────────────────
  function makeStrips(maxVerts, mat, order) {
    const pos = new Float32Array(maxVerts * 3), col = new Float32Array(maxVerts * 4), idx = new Uint32Array(maxVerts * 3);
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const ca = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    const ia = new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa); geo.setAttribute('color', ca); geo.setIndex(ia);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = order;
    group.add(mesh);
    let nv = 0, ni = 0;
    const T0 = V3(), S0 = V3(), D0 = V3();
    return {
      mesh,
      begin() { nv = 0; ni = 0; },
      /** pts: array of [x, y, z, width, r, g, b, a] (world). faceUp: lie flat instead of facing the camera. */
      strip(pts, faceUp) {
        const n = pts.length;
        if (n < 2 || nv + n * 2 > maxVerts) return;
        const cp = camera.position;
        for (let i = 0; i < n; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], p = pts[i];
          T0.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          if (T0.lengthSq() < 1e-10) T0.set(1, 0, 0);
          if (faceUp) S0.set(-T0.z, 0, T0.x);
          else { D0.set(p[0] - cp.x, p[1] - cp.y, p[2] - cp.z); S0.crossVectors(T0, D0); }
          if (S0.lengthSq() < 1e-10) S0.set(1, 0, 0);
          S0.normalize().multiplyScalar(p[3] / 2);
          const v = nv + i * 2;
          pos[v * 3] = p[0] - S0.x; pos[v * 3 + 1] = p[1] - S0.y; pos[v * 3 + 2] = p[2] - S0.z;
          pos[v * 3 + 3] = p[0] + S0.x; pos[v * 3 + 4] = p[1] + S0.y; pos[v * 3 + 5] = p[2] + S0.z;
          for (let k = 0; k < 2; k++) { col[(v + k) * 4] = p[4]; col[(v + k) * 4 + 1] = p[5]; col[(v + k) * 4 + 2] = p[6]; col[(v + k) * 4 + 3] = p[7]; }
          if (i > 0) { const a0 = v - 2; idx[ni++] = a0; idx[ni++] = a0 + 1; idx[ni++] = v; idx[ni++] = a0 + 1; idx[ni++] = v + 1; idx[ni++] = v; }
        }
        nv += n * 2;
      },
      end() {
        geo.setDrawRange(0, ni);
        pa.needsUpdate = true; ca.needsUpdate = true; ia.needsUpdate = true;
        mesh.visible = ni > 0;
      },
    };
  }
  const stripMat = () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const trails = makeStrips(MAX_FIG * 100, stripMat(), 5);
  const arc = makeStrips(1200, stripMat(), 8);
  const arcGlow = makeStrips(1200, (() => { const m = stripMat(); m.depthTest = false; return m; })(), 7);

  const GOLD = C('#ffd426');
  const tmpPts = [];
  function writeTrails(T) {
    trails.begin();
    for (const r of balls.values()) {
      if (r.seen !== stamp || r.trail.length < 2 || !r.vis) continue;
      const n = r.trail.length;
      const cc = r.me ? GOLD : (r.car ? r.car.color : _c.set(PALETTE[r.idn % PALETTE.length]));
      tmpPts.length = 0;
      for (let i = 0; i < n; i++) {
        const t = r.trail[i], f = (i + 1) / n, age = clamp(1 - (T - t[3]) / 1.1, 0, 1);
        const w = r.rad * 1.5 * f;
        const wr = lerp(1, cc.r, 0.6), wg = lerp(1, cc.g, 0.6), wb = lerp(1, cc.b, 0.6);
        tmpPts.push([t[0], t[1], t[2], w, wr, wg, wb, 0.75 * f * age]);
      }
      // join the head to the ball
      const D = r.disp;
      tmpPts.push([D.x, r.base + D.z + r.rad * 0.85, D.y, r.rad * 1.5, 1, 1, 1, 0.75]);
      trails.strip(tmpPts, false);
    }
    trails.end();
  }

  // ── aim: the arc, the landing ring, the roll line ────────────────────
  const ringTex = makeRadialTexture([[0, 'rgba(255,255,255,0)'], [0.62, 'rgba(255,255,255,0)'], [0.7, 'rgba(255,255,255,1)'], [0.88, 'rgba(255,255,255,1)'], [0.95, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']], 256);
  const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
  const landRing = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMat);
  landRing.renderOrder = 9;
  const dotTex = makeRadialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.95)'], [0.55, 'rgba(255,255,255,0.0)'], [1, 'rgba(255,255,255,0)']], 128);
  const landDot = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: dotTex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide }));
  landDot.renderOrder = 9;
  const shadeRing = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: ringTex, color: C('#0b1a10'), transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  shadeRing.renderOrder = 8;
  const pillarGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  {
    const p = pillarGeo.attributes.position, cc = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) { cc[i * 4] = cc[i * 4 + 1] = cc[i * 4 + 2] = 1; cc[i * 4 + 3] = p.getY(i) < 0.5 ? 0.85 : 0; }
    pillarGeo.setAttribute('color', new THREE.BufferAttribute(cc, 4));
  }
  const pillar = new THREE.Mesh(pillarGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  pillar.renderOrder = 8;
  const aimGroup = new THREE.Group();
  aimGroup.add(landRing, landDot, shadeRing, pillar);
  group.add(aimGroup);
  const AIM_OK = C('#ffffff'), AIM_HOT = C('#ffd426'), AIM_BAD = C('#ff3b30'), AIM_IN = C('#5dff8a');
  let aimVis = 0;

  function writeAim(dt, T, view) {
    const a = view.aim, m = myRec;
    arc.begin(); arcGlow.begin();
    const ok = a && m && !view.spectate && Array.isArray(a.land) && Array.isArray(a.path) && a.path.length >= 2 && !(num(view.intro, 0) > 0) && !(m.disp.st & (KST.MOVING | KST.HOLED | KST.HAZARD)) && !m.hold;
    aimVis += ((ok ? 1 : 0) - aimVis) * damp(dt, 0.12);
    if (!ok) { arc.end(); arcGlow.end(); aimGroup.visible = false; return; }
    aimGroup.visible = true;
    const charging = !!a.charging, pw = clamp(num(a.power, 1), 0, 1);
    const bad = a.end === 'water' || a.end === 'oob', inHole = a.end === 'holed';
    const tone = _c.copy(bad ? AIM_BAD : inHole ? AIM_IN : charging ? AIM_HOT : AIM_OK);
    const camP = camera.position;
    const putt = (a.club | 0) === PUTTER;
    const sx = m.disp.x, sy = m.disp.y, h0 = m.base;
    const L = a.land, lx = num(L[0], sx), ly = num(L[1], sy), hL = standAt(lx, ly);
    const total = Math.max(1e-3, Math.hypot(lx - sx, ly - sy));
    // the arc (ball path up to the first touchdown)
    tmpPts.length = 0;
    const path = a.path, n = path.length;
    const pulse = charging ? 1 : 0.55 + 0.15 * Math.sin(T * 3);
    for (let i = 0; i < n; i++) {
      const p = path[i];
      if (!p) continue;
      const px = num(p[0], sx), pz = num(p[1], sy), py = num(p[2], 0);
      const f = clamp(Math.hypot(px - sx, pz - sy) / total, 0, 1);
      const y = lerp(h0, hL, f) + py + (putt ? 0.06 : 0.12);
      const d = Math.hypot(px - camP.x, y - camP.y, pz - camP.z);
      const w = d * (charging ? 0.0055 : 0.0032) + (charging ? 0.02 : 0.01);
      const dash = putt ? 1 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(f * total * 0.9 - T * 9));
      const fadeIn = smooth(f / 0.04 + 0.2);
      tmpPts.push([px, y, pz, w, tone.r, tone.g, tone.b, (charging ? 0.95 : 0.5) * dash * fadeIn * aimVis * pulse]);
    }
    if (putt) for (const p of tmpPts) p[3] *= 1.6;
    arc.strip(tmpPts, putt);
    // a faint copy on top of everything so the arc never vanishes behind a bump
    for (const p of tmpPts) { p[3] *= 0.7; p[7] *= charging ? 0.3 : 0.2; }
    arcGlow.strip(tmpPts, putt);
    // roll line from touchdown to rest
    const R = Array.isArray(a.rest) ? a.rest : L, rx = num(R[0], lx), ry = num(R[1], ly);
    const rl = Math.hypot(rx - lx, ry - ly);
    if (rl > 0.6 && !putt) {
      tmpPts.length = 0;
      const steps = Math.max(2, Math.ceil(rl / 1.2));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps, x = lerp(lx, rx, f), y = lerp(ly, ry, f), gy = standAt(x, y) + 0.08;
        const d = Math.hypot(x - camP.x, gy - camP.y, y - camP.z);
        const on = (Math.floor(f * rl / 1.2 - T * 2) & 1) ? 1 : 0.35;
        tmpPts.push([x, gy, y, d * 0.004 + 0.03, tone.r, tone.g, tone.b, 0.45 * on * aimVis * (charging ? 1 : 0.6)]);
      }
      arcGlow.strip(tmpPts, true);
    }
    arc.end(); arcGlow.end();

    // the landing ring: flat on the course, tipped a little towards the camera so it reads at a distance
    const dRing = Math.hypot(lx - camP.x, hL - camP.y, ly - camP.z);
    const rr = clamp(dRing * (charging ? 0.03 : 0.024), putt ? 0.45 : 0.9, 6) * (charging ? 1 + 0.05 * Math.sin(T * 10) : 1);
    _v.set(camP.x - lx, 0, camP.z - ly);
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
    _v.normalize();
    const tip = clamp(0.55 - Math.atan2(camP.y - hL, Math.hypot(camP.x - lx, camP.z - ly)), 0, 0.9);   // more tilt at grazing angles
    _v2.set(0, 1, 0).multiplyScalar(Math.cos(tip)).addScaledVector(_v, Math.sin(tip)).normalize();
    _q.setFromUnitVectors(Z_AXIS, _v2);
    for (const [mesh, k, y] of [[landRing, 1, 0.1], [shadeRing, 1.12, 0.08], [landDot, 0.36, 0.11]]) {
      mesh.position.set(lx, hL + y, ly);
      mesh.quaternion.copy(_q);
      mesh.scale.setScalar(rr * k);
    }
    ringMat.color.copy(tone);
    ringMat.opacity = (charging ? 1 : 0.62) * aimVis * (bad ? 0.75 + 0.25 * Math.sin(T * 14) : 1);
    landDot.material.color.copy(tone);
    landDot.material.opacity = (charging ? 0.9 : 0.45) * aimVis;
    shadeRing.material.opacity = 0.35 * aimVis;
    // a light pillar above the ring for long shots
    const far = smooth((dRing - 25) / 40);
    pillar.visible = far > 0.01 && !putt;
    if (pillar.visible) {
      pillar.position.set(lx, hL, ly);
      pillar.rotation.set(0, Math.atan2(camP.x - lx, camP.z - ly), 0);
      pillar.scale.set(dRing * 0.006, dRing * 0.09, 1);
      pillar.material.color.copy(tone);
      pillar.material.opacity = far * (charging ? 0.85 : 0.45) * aimVis;
    }
  }

  // ── name tags ────────────────────────────────────────────────────────
  function writeTags(view) {
    const vw = ctx.vw, vh = ctx.vh, th = tanHalf();
    for (const car of cars.values()) car.sprite.visible = false;
    for (const r of balls.values()) {
      const car = r.car;
      if (r.seen !== stamp || !car || !car.name || !r.pose) continue;
      if (r.me && !view.spectate) continue;
      if (r.fade < 0.5) continue;
      const top = r.py + (r.mode === 'cheer' ? 2.7 : 2.25) * r.figScale;
      const dist = Math.max(1, Math.hypot(r.px - camera.position.x, top - camera.position.y, r.pz - camera.position.z));
      const pxPerM = vh / (2 * dist * th);
      const hq = clamp((clamp(Math.min(vw, vh) * 0.026, 12, 19) * (96 / 68)) / pxPerM, 0.3, 40);
      car.sprite.visible = true;
      car.sprite.position.set(r.px, top + hq * 0.45, r.pz);
      car.sprite.scale.set(hq * 4, hq, 1);
      car.sprite.material.opacity = 0.9 * clamp((r.fade - 0.5) * 3, 0, 1);
      car.sprite.renderOrder = r.me ? 22 : 20;
    }
  }

  // ── cameras ──────────────────────────────────────────────────────────
  const cam = {
    pos: V3().set(0, 20, -30), look: V3(), fov: 50, snap: true, mode: '', settle: 0, yaw: 0, shotYaw: 0,
    dpos: V3(), dlook: V3(), dfov: 50, sx: 0, sz: 0, sd: 80, syaw: 0,
  };
  const FIT = [];
  for (let i = 0; i < MAX_FIG * 2 + 2; i++) FIT.push(V3());
  /** Distance and target that fit pts (with their heights) into the view at yaw/elev. */
  function fitPoints(pts, n, yaw, elev, fov, aspect, lat, up, down) {
    const tv = Math.tan((fov * DEG) / 2), th = tv * aspect;
    const sE = Math.sin(elev), cE = Math.cos(elev), sy = Math.sin(yaw), cy = Math.cos(yaw);
    // camera sits at target + d * (-cE*cos(yaw), sE, -cE*sin(yaw)) and looks along yaw
    const fx = cE * cy, fy = -sE, fz = cE * sy, rx = -sy, rz = cy, ux = sE * cy, uy = cE, uz = sE * sy;
    let tx = 0, tz = 0;
    for (let i = 0; i < n; i++) { tx += pts[i].x; tz += pts[i].z; }
    tx /= n; tz /= n;
    let d = 30;
    const ext = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const measure = (dd) => {
      const px = tx - dd * cE * cy, py = dd * sE, pz = tz - dd * cE * sy;
      ext.x0 = ext.y0 = Infinity; ext.x1 = ext.y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const q = pts[i], ax = q.x - px, ay = q.y - py, az = q.z - pz;
        const depth = ax * fx + ay * fy + az * fz;
        if (depth < 1) return false;
        const sx = (ax * rx + az * rz) / (depth * th), su = (ax * ux + ay * uy + az * uz) / (depth * tv);
        if (sx < ext.x0) ext.x0 = sx; if (sx > ext.x1) ext.x1 = sx;
        if (su < ext.y0) ext.y0 = su; if (su > ext.y1) ext.y1 = su;
      }
      return true;
    };
    const fits = (dd) => measure(dd) && ext.x0 >= -lat && ext.x1 <= lat && ext.y1 <= up && ext.y0 >= down;
    for (let it = 0; it < 3; it++) {
      let lo = 8, hi = 900;
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
      d = hi;
      if (it === 2 || !measure(d)) break;
      const xm = (ext.x0 + ext.x1) / 2, ym = (ext.y0 + ext.y1) / 2 - (up + down) / 2;
      tx += rx * xm * d * th; tz += rz * xm * d * th;
      tx += cy * ym * d * tv / sE; tz += sy * ym * d * tv / sE;
    }
    return { d, tx, tz };
  }

  function playerCamera(dt, T, view, aspect, outPos, outLook) {
    const m = myRec;
    if (!m || !m.pose) return false;
    const D = m.disp;
    const heading = num(view.heading, cam.yaw);
    let mode;
    const flying = !m.hold && (D.st & KST.MOVING) && !(D.st & KST.HOLED);
    const figBall = Math.hypot(m.fx - m.live.x, m.fy - m.live.y);
    if (m.hold) mode = 'addr';
    else if (flying) mode = 'flight';
    else if ((D.st | m.live.st) & KST.HOLED) mode = 'holed';
    else if (figBall > KG.REACH + 1 || m.mode === 'run') mode = 'run';
    else mode = 'addr';
    if (mode !== cam.mode) { cam.mode = mode; cam.settle = 0; if (mode === 'flight') cam.shotYaw = m.shotA; }
    cam.settle = Math.min(1, cam.settle + dt / 1.1);
    const portrait = aspect < 0.9;
    let tauP = 0.4, tauL = 0.25;
    if (mode === 'addr') {
      const c = view.aim ? clamp(view.aim.club | 0, 0, 3) : m.swing ? m.swing.club : m.club;
      const P = CAM[c] || CAM[0];
      cam.yaw += angDiff(m.swing ? m.swing.angle : heading, cam.yaw) * (cam.snap ? 1 : damp(dt, 0.07));
      const bx = m.hold ? m.holdPos[0] : D.x, bz = m.hold ? m.holdPos[1] : D.y;
      const back = P.back * (portrait ? 1.22 : 1), up = P.up * (portrait ? 1.15 : 1);
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      // stand a little to the right of the line so the figure (left of the ball) and the target both show
      const side = portrait ? (c === PUTTER ? 0.1 : -0.3) : (c === PUTTER ? 0.7 : 0.45);
      outPos.set(bx - cy * back - sy * side, m.base + up, bz - sy * back + cy * side);
      const pitch = (P.pitch + (portrait ? 2 : 0)) * DEG;
      outLook.set(outPos.x + cy * Math.cos(pitch) * 10, outPos.y - Math.sin(pitch) * 10, outPos.z + sy * Math.cos(pitch) * 10);
      tauP = lerp(0.5, 0.05, cam.settle); tauL = lerp(0.35, 0.04, cam.settle);
    } else if (mode === 'flight') {
      cam.shotYaw += angDiff(m.shotA, cam.shotYaw) * damp(dt, 0.3);
      const cy = Math.cos(cam.shotYaw), sy = Math.sin(cam.shotYaw);
      const by = m.base + D.z;
      outPos.set(D.x - cy * 12, m.base + 3.2 + D.z * 0.55, D.y - sy * 12);
      outLook.set(D.x + cy * 4, by * 0.85 + 0.3, D.y + sy * 4);
      tauP = 0.28; tauL = 0.07;
    } else if (mode === 'run') {
      let dx = m.live.x - m.px, dz = m.live.y - m.pz;
      const l = Math.hypot(dx, dz);
      if (l > 0.5) { dx /= l; dz /= l; } else { dx = Math.cos(cam.yaw); dz = Math.sin(cam.yaw); }
      cam.yaw += angDiff(Math.atan2(dz, dx), cam.yaw) * damp(dt, 0.4);
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      outPos.set(m.px - cy * 7, m.py + 3.6, m.pz - sy * 7);
      outLook.set(m.px + cy * 10, m.py + 0.2, m.pz + sy * 10);
      tauP = 0.3; tauL = 0.3;
    } else {   // holed: watch the figure celebrate by the flag
      // from the figure's side of the cup, so it celebrates in front of the flag
      const cx = W.cup[0], cz = W.cup[1];
      let dx = m.fx - cx, dz = m.fy - cz;
      const l = Math.hypot(dx, dz);
      if (l > 0.3) { dx /= l; dz /= l; } else { dx = -Math.cos(cam.yaw); dz = -Math.sin(cam.yaw); }
      const c = Math.cos(0.35), sn = Math.sin(0.35), rx = dx * c - dz * sn, rz = dx * sn + dz * c;
      outPos.set(cx + rx * 7.5, W.cupY + 2.4, cz + rz * 7.5);
      outLook.set(lerp(m.px, cx, 0.35), m.py + 1.3, lerp(m.pz, cz, 0.35));
      tauP = 0.8; tauL = 0.5;
    }
    cam.tauP = tauP; cam.tauL = tauL;
    cam.dfov = portrait ? lerp(66, 54, clamp((aspect - 0.45) / 0.45, 0, 1)) : 50;
    return true;
  }

  function droneCamera(dt, T, view, aspect, outPos, outLook) {
    let n = 0;
    const cup = W.cup;
    FIT[n++].set(cup[0], W.cupY + 4, cup[1]);
    FIT[n++].set(cup[0], W.cupY, cup[1]);
    let any = false;
    for (const r of balls.values()) {
      if (r.seen !== stamp || n > FIT.length - 2) continue;
      if (r.live.st & KST.HOLED && r.mode !== 'run') continue;
      any = true;
      FIT[n++].set(r.px, r.py + 2.2 * r.figScale, r.pz);
      if (!(r.disp.st & KST.MOVING) && r.vis) FIT[n++].set(r.disp.x, r.base, r.disp.y);
    }
    if (!any && W.tee) FIT[n++].set(W.tee.x, 0, W.tee.y);
    const shiftOn = hostScreen && aspect > 1.25, inLobby = view.phase === PHASE.LOBBY;
    const lat = shiftOn ? (inLobby ? 0.31 : 0.62) : 0.9;
    const yaw = W.holeDir + Math.sin(T * 0.05) * 0.12;
    const elev = (36 + Math.sin(T * 0.09) * 3) * DEG;
    const fov = 50;
    const fit = fitPoints(FIT, n, yaw, elev, fov, aspect, lat, 0.64, -0.86);   // clear of the bar and pills along the top
    const k = cam.snap ? 1 : damp(dt, 0.5);   // figures sprint at 18 m/s: a slower drone loses them off the edge
    cam.sx += (fit.tx - cam.sx) * k; cam.sz += (fit.tz - cam.sz) * k;
    cam.sd += (Math.max(28, fit.d) - cam.sd) * k;
    cam.syaw += angDiff(yaw, cam.syaw) * k;
    const cE = Math.cos(elev), sE = Math.sin(elev), cy = Math.cos(cam.syaw), sy = Math.sin(cam.syaw);
    outPos.set(cam.sx - cam.sd * cE * cy, cam.sd * sE, cam.sz - cam.sd * cE * sy);
    outLook.set(cam.sx, 0, cam.sz);
    cam.tauP = 0.05; cam.tauL = 0.05;
    cam.dfov = fov;
    ctx.applyShift(shiftOn ? (inLobby ? -0.025 : 0.155) : 0, cam.snap ? 1 : damp(dt, 0.7));
    return true;
  }

  const fly = { pos: V3(), look: V3() };
  function flyover(u, outPos, outLook) {
    const c = W.curve, L = W.curveLen;
    if (!c || !(L > 1)) return false;
    const e = smooth(u);
    const at = (s, out) => {
      if (s <= 0) { c.getPointAt(0, out); c.getTangentAt(0, _v3); return out.addScaledVector(_v3, s); }
      if (s >= L) { c.getPointAt(1, out); c.getTangentAt(1, _v3); return out.addScaledVector(_v3, s - L); }
      return c.getPointAt(s / L, out);
    };
    const sCam = lerp(L - 26, -14, e);
    at(sCam, outPos);
    outPos.y = lerp(15, 5, e) + Math.max(0, standAt(outPos.x, outPos.z));
    at(Math.min(L, sCam + lerp(28, 60, e)), outLook);
    outLook.y = lerp(1.5, 0, e);
    return true;
  }

  function updateCamera(dt, T, view) {
    const aspect = camera.aspect;
    const P = cam.dpos, L = cam.dlook;
    let ok = false;
    if (view.spectate) ok = droneCamera(dt, T, view, aspect, P, L);
    else {
      ctx.applyShift(0, cam.snap ? 1 : damp(dt, 0.5));
      ok = playerCamera(dt, T, view, aspect, P, L);
      if (!ok) ok = droneCamera(dt, T, view, aspect, P, L);
    }
    if (!ok) return;
    // A far jump of the wanted spot (the ball put back on the tee, a cut back to the
    // figure) is a cut, not a swoop along the ground.
    if (cam.wantOk && Math.hypot(P.x - cam.wx, P.y - cam.wy, P.z - cam.wz) > 30) cam.snap = true;
    cam.wx = P.x; cam.wy = P.y; cam.wz = P.z; cam.wantOk = true;
    const kP = cam.snap ? 1 : damp(dt, cam.tauP), kL = cam.snap ? 1 : damp(dt, cam.tauL);
    cam.pos.lerp(P, kP);
    cam.look.lerp(L, kL);
    cam.fov += (cam.dfov - cam.fov) * (cam.snap ? 1 : damp(dt, 0.5));
    // keep out of the ground
    const g = heightAt(cam.pos.x, cam.pos.z);
    if (g !== NONE && cam.pos.y < g + 0.9) cam.pos.y = g + 0.9;
    let px = cam.pos.x, py = cam.pos.y, pz = cam.pos.z, lx = cam.look.x, ly = cam.look.y, lz = cam.look.z, fov = cam.fov;
    // the hole introduction
    const intro = num(view.intro, 0);
    if (view.phase === PHASE.COUNTDOWN && intro > 0 && flyover(clamp(1 - intro / KG.INTRO_T, 0, 1), fly.pos, fly.look)) {
      const u = clamp(1 - intro / KG.INTRO_T, 0, 1), w = smooth((u - 0.68) / 0.3);
      px = lerp(fly.pos.x, px, w); py = lerp(fly.pos.y, py, w); pz = lerp(fly.pos.z, pz, w);
      lx = lerp(fly.look.x, lx, w); ly = lerp(fly.look.y, ly, w); lz = lerp(fly.look.z, lz, w);
      fov = lerp(Math.max(cam.dfov, 55), fov, w);
    }
    camera.position.set(px, py, pz);
    camera.up.set(0, 1, 0);
    camera.lookAt(lx, ly, lz);
    if (cam.kick > 0.002) {   // a short jolt on a full drive
      const k = cam.kick * cam.kick;
      camera.position.y += Math.sin(T * 47) * k * 0.6;
      camera.position.x += Math.sin(T * 39 + 1.3) * k * 0.4;
      cam.kick = Math.max(0, cam.kick - dt * 1.4);
    }
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    cam.snap = false;
  }

  // ── shadows follow what is being looked at ───────────────────────────
  function updateShadow(view) {
    const sc = sun.shadow.camera;
    // player: a box reaching ~70 m ahead of the camera, where the shadows are seen; drone: the framed area
    const far = view.spectate ? clamp(cam.sd * 0.75, 50, 140) : 40;
    let fwx = cam.look.x - camera.position.x, fwz = cam.look.z - camera.position.z;
    const fl = Math.hypot(fwx, fwz) || 1; fwx /= fl; fwz /= fl;
    const fx = view.spectate ? cam.sx : camera.position.x + fwx * 30;
    const fz = view.spectate ? cam.sz : camera.position.z + fwz * 30;
    const soft = ctx.tier === 'high' ? 2.6 : ctx.tier === 'medium' ? 1.6 : 1;
    if (sun.shadow.radius !== soft) sun.shadow.radius = soft;
    const snap = (far * 2) / Math.max(256, sun.shadow.mapSize.x);
    sun.target.position.set(Math.round(fx / snap) * snap, 0, Math.round(fz / snap) * snap);
    sun.position.copy(ctx.LIGHT_DIR).multiplyScalar(160).add(sun.target.position);
    if (sc.right !== far) {
      sc.left = -far; sc.right = far; sc.top = far; sc.bottom = -far;
      sc.near = 40; sc.far = 320;
      sc.updateProjectionMatrix();
    }
  }

  // ── a few birds wheeling high over the hole (one small dynamic mesh) ──
  const BIRDS = 7;
  const birdPos = new Float32Array(BIRDS * 6 * 3);
  const birdGeo = new THREE.BufferGeometry();
  birdGeo.setAttribute('position', new THREE.BufferAttribute(birdPos, 3).setUsage(THREE.DynamicDrawUsage));
  const birds = new THREE.Mesh(birdGeo, new THREE.MeshBasicMaterial({ color: C('#2a3140'), side: THREE.DoubleSide, fog: false }));
  birds.frustumCulled = false;
  group.add(birds);
  const birdSeed = Array.from({ length: BIRDS }, (_, i) => ({ r: 14 + i * 4.5 + Math.random() * 6, h: 26 + Math.random() * 14, ph: Math.random() * TAU, sp: 0.16 + Math.random() * 0.08, fl: Math.random() * TAU }));
  function updateBirds(T) {
    birds.visible = ctx.tier !== 'low';
    if (!birds.visible) return;
    const cx = lerp(camera.position.x, cam.look.x, 0.5), cz = lerp(camera.position.z, cam.look.z, 0.5);
    let o = 0;
    for (const b of birdSeed) {
      const a = b.ph + T * b.sp, x = cx + Math.cos(a) * b.r, z = cz + Math.sin(a) * b.r, y = b.h + Math.sin(T * 0.4 + b.fl) * 2;
      const fx = -Math.sin(a), fz = Math.cos(a), rx = Math.cos(a), rz = Math.sin(a);   // flying along the circle; wings point in and out
      const flap = Math.sin(T * 7 + b.fl) * 0.45, w = 0.75, L = 0.35;
      // two wings: body point, tip, back point
      for (const sgn of [-1, 1]) {
        birdPos[o++] = x + fx * L; birdPos[o++] = y; birdPos[o++] = z + fz * L;
        birdPos[o++] = x + rx * w * sgn; birdPos[o++] = y + flap; birdPos[o++] = z + rz * w * sgn;
        birdPos[o++] = x - fx * L * 0.4; birdPos[o++] = y; birdPos[o++] = z - fz * L * 0.4;
      }
    }
    birdGeo.attributes.position.needsUpdate = true;
  }

  // ── the world ticking along ──────────────────────────────────────────
  function updateWorld(dt, T, view) {
    const wind = Array.isArray(view.wind) ? view.wind : [0, 0];
    const wx = num(wind[0], 0), wy = num(wind[1], 0), ws = Math.hypot(wx, wy), wk = clamp(ws / KG.MAX_WIND, 0, 1);
    const f = W.flag;
    if (f) {
      const pos = f.geo.attributes.position, B = f.base;
      f.flutter = Math.max(0, f.flutter - dt * 0.45);
      const want = ws > 0.2 ? Math.atan2(wy, wx) : f.dir;
      f.dir += angDiff(want, f.dir) * damp(dt, 0.8);
      f.root.rotation.y = -f.dir;
      const amp = 0.04 + wk * 0.14 + f.flutter * 0.2, sp = 2.4 + wk * 6 + f.flutter * 6;
      const droop = (1 - Math.max(wk, f.flutter)) * 0.75;
      for (let i = 0; i < pos.count; i++) {
        const x = B[i * 3], k = (x - 0.05) / 1.6;
        pos.array[i * 3] = x * (1 - droop * 0.35 * k);
        pos.array[i * 3 + 2] = Math.sin(x * 4.2 - T * sp) * amp * k + Math.sin(x * 7 - T * sp * 1.6) * amp * 0.35 * k;
        pos.array[i * 3 + 1] = B[i * 3 + 1] - k * k * droop * 0.9;
      }
      pos.needsUpdate = true;
      f.geo.computeVertexNormals();
    }
    // trees shaken by a ball
    const w = W.world;
    if (w) {
      let dirty = false;
      for (const t of W.trees) {
        if (t.shake <= 0) continue;
        t.shake = Math.max(0, t.shake - dt * 1.6);
        const a = Math.sin(T * 34 + t.ph) * t.shake * 0.09;
        for (const i of t.ids) {
          const pp = w.baseM[i];
          _q.setFromAxisAngle(Y_AXIS, pp[6] + a);
          _q2.setFromAxisAngle(Z_AXIS, a * 0.6);
          _q.multiply(_q2);
          _m.compose(_p.set(pp[0] + a * 0.8, pp[1], pp[2] - a * 0.5), _q, _s.set(pp[3], pp[4], pp[5]));
          w.propMesh.setMatrixAt(i, _m);
        }
        dirty = true;
      }
      if (dirty) w.propMesh.instanceMatrix.needsUpdate = true;
    }
    // drifting leaves show the wind
    if (ws > 0.3) {
      W.leafAcc += dt * (0.8 + ws * 1.4) * (0.4 + 0.6 * ctx.fxMul);
      const cx = camera.position.x, cz = camera.position.z;
      const fx = cam.look.x - cx, fz = cam.look.z - cz, fl = Math.hypot(fx, fz) || 1;
      while (W.leafAcc >= 1) {
        W.leafAcc -= 1;
        const along = 10 + Math.random() * 30, lat = (Math.random() - 0.5) * along * 1.1;
        const x = cx + (fx / fl) * along - (fz / fl) * lat - wx * 1.5, z = cz + (fz / fl) * along + (fx / fl) * lat - wy * 1.5;
        const g = Math.max(0, standAt(x, z));
        const colr = Math.random();
        const c = colr < 0.5 ? [0.45, 0.75, 0.25] : colr < 0.8 ? [0.95, 0.7, 0.2] : [0.9, 0.4, 0.15];
        parts.emit(K.CHIP, x, g + 1.5 + Math.random() * 4, z, wx * (0.8 + Math.random() * 0.5), -0.25 + Math.random() * 0.4, wy * (0.8 + Math.random() * 0.5),
          3 + Math.random() * 2, 0.06 + Math.random() * 0.04, 0, c[0], c[1], c[2], 0.95, 0, 0.15, 0.1, Math.random() * TAU, (Math.random() - 0.5) * 8, 0, 2, 0);
      }
    }
    for (let i = W.pending.length - 1; i >= 0; i--) {
      const p = W.pending[i];
      if ((p.t -= dt) <= 0) { W.pending.splice(i, 1); p.fn(); }
    }
  }

  // ── effects ──────────────────────────────────────────────────────────
  const fxN = (n) => Math.max(1, Math.round(n * ctx.fxMul));
  function chips(x, y, z, n, dirX, dirZ, sp, up, cols, size, life) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = sp * (0.3 + Math.random() * 0.8);
      const c = cols[(Math.random() * cols.length) | 0];
      parts.emit(K.CHIP, x, y, z, Math.cos(a) * s * 0.6 + dirX * sp * Math.random(), up * (0.5 + Math.random() * 0.7), Math.sin(a) * s * 0.6 + dirZ * sp * Math.random(),
        life * (0.7 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.7), 0, c[0], c[1], c[2], 1, 0, 14, 0.8, Math.random() * TAU, (Math.random() - 0.5) * 14, 0, 2, 1);
    }
  }
  const TURF = [[0.36, 0.7, 0.24], [0.45, 0.78, 0.28], [0.48, 0.32, 0.18]];
  const SAND = [[0.98, 0.88, 0.62], [0.93, 0.8, 0.55], [1, 0.93, 0.74]];
  const GREENS = [[0.5, 0.85, 0.35], [0.42, 0.75, 0.3]];
  const LEAVES = [[0.3, 0.62, 0.22], [0.38, 0.7, 0.26], [0.55, 0.8, 0.3]];

  function onHit(r, s) {
    const x = r.holdPos[0], z = r.holdPos[1], y = standAt(x, z) + 0.08;
    const dx = Math.cos(s.angle), dz = Math.sin(s.angle), p = s.power;
    if (r.me && s.club === 0 && p > 0.55) cam.kick = Math.max(cam.kick || 0, 0.12 + 0.18 * p);
    r.shotA = s.angle;
    if (s.club === PUTTER) {
      parts.emit(K.RING, x, y, z, 0, 0, 0, 0.3, 0.2, 2 + p * 3, 1, 1, 1, 0.7, 0.2, 0, 0, 0, 0, 0.2, 0, 0);
      return;
    }
    const lie = W.course ? surfaceAt(W.course, x, z) : SURF.FAIRWAY;
    parts.emit(K.RING, x, y + 0.05, z, 0, 0, 0, 0.28, 0.3, 6 + p * 8, 1, 1, 0.95, 0.9, 0.3, 0, 0, 0, 0, 0.22, 0, 0);
    parts.emit(K.SOFT, x, y + 0.3, z, 0, 0, 0, 0.1, 0.6 + p * 0.6, 4, 1.8, 1.7, 1.4, 0.7, 0.6, 0, 0, 0, 0, 0, 0, 0);
    if (lie === SURF.SAND) {
      chips(x, y, z, fxN(30 + 30 * p), dx, dz, 5 + 4 * p, 5, SAND, 0.08, 0.9);
      for (let i = 0; i < 6; i++) parts.emit(K.PUFF, x + dx * i * 0.3, y + 0.3, z + dz * i * 0.3, dx * 2, 1 + Math.random(), dz * 2, 0.9 + Math.random() * 0.4, 0.5, 1.3, 1, 0.92, 0.75, 0.75, 0, 0, 1.5, Math.random() * TAU, 0, 0, 1, 0);
    } else if (lie !== SURF.TEE || s.club > 0) {
      chips(x, y, z, fxN(8 + 14 * p), dx, dz, 4 + 4 * p, 4, TURF, 0.07, 0.9);
    } else {
      chips(x, y, z, fxN(4 + 4 * p), dx, dz, 3, 3, TURF, 0.05, 0.6);
    }
    if (s.club === 0 && p > 0.75) {
      for (let i = 0; i < fxN(10); i++) {
        const a = s.angle + (Math.random() - 0.5) * 0.8, v = 8 + Math.random() * 10;
        parts.emit(K.STREAK, x, y + 0.2, z, Math.cos(a) * v, 1 + Math.random() * 4, Math.sin(a) * v, 0.2 + Math.random() * 0.15, 0.04, 0, 2.4, 2.1, 1.2, 1, 0.5, 6, 2, 0, 0, 0.03, 0, 0);
      }
      parts.emit(K.STAR, x, y + 0.6, z, 0, 0.3, 0, 0.18, 0.35, 1.2, 1, 0.85, 0.3, 0.9, 0.1, 0, 0, Math.random() * TAU, 2, 0, 2, 0);
    }
  }

  function queue(id, fn) {
    const r = balls.get(id);
    if (!r || !r.init || (!r.hold && r.playT === null)) { fn(); return; }
    r.queue.push({ t: currentT, fn });
  }
  let currentT = 0;

  function confetti(x, y, z, n, up) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = 1.5 + Math.random() * 4.5;
      _c.set(PALETTE[(Math.random() * PALETTE.length) | 0]);
      parts.emit(K.CONF, x + Math.cos(a) * 0.2, y + 0.4 + Math.random() * 0.6, z + Math.sin(a) * 0.2, Math.cos(a) * sp, up * (0.6 + Math.random() * 0.6), Math.sin(a) * sp,
        2.2 + Math.random() * 1.5, 0.1 + Math.random() * 0.08, 0, _c.r * 1.15, _c.g * 1.15, _c.b * 1.15, 1, 0, 9, 1.7,
        Math.random() * TAU, (Math.random() - 0.5) * 9, Math.random() * TAU, 2, 1);
    }
  }

  const fx = {
    swing(id, club, power, angle) {
      const r = balls.get(id);
      if (!r || !r.init) return;
      const c = clamp(Math.round(num(+club, 0)), 0, CLUBS.length - 1), p = clamp(num(+power, 0.7), 0, 1);
      const a = num(+angle, r.aimA);
      const amp = swingAmp(c, p);
      // continue from wherever the club is (the local player may already be at the top)
      const th0 = r.mode === 'addr' ? r.theta : 0;
      const tb = Math.max(0.05, (c === PUTTER ? 0.36 : 0.24) * (1 - clamp(-th0 / amp.back, 0, 1))) ;
      const td = c === PUTTER ? 0.16 : 0.11;
      r.swing = { t0: currentT, club: c, power: p, angle: a, back: amp.back, thru: amp.thru, th0, tb, hit: tb + td, hitDone: false };
      r.mode = 'swing'; r.modeT = 0;
      r.hold = true; r.playT = null;
      r.holdPos[0] = r.disp.x; r.holdPos[1] = r.disp.y;
      r.swingT0 = currentT; r.hitAt = currentT + tb + td;
      r.club = c; r.aimA = a; r.shotA = a;
      r.trail.length = 0;
    },
    land(id, x, y, surf, speed) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      queue(id, () => {
        const s = clamp(num(speed, 6) / 18, 0, 1), g = standAt(x, y) + 0.05, k = surf | 0;
        if (k === SURF.SAND) {
          chips(x, g, y, fxN(12 + 30 * s), 0, 0, 2 + 4 * s, 3 + 5 * s, SAND, 0.07, 1);
          for (let i = 0; i < 3; i++) parts.emit(K.PUFF, x, g + 0.2, y, (Math.random() - 0.5) * 2, 0.8, (Math.random() - 0.5) * 2, 1, 0.45 + s * 0.4, 1.4, 1, 0.93, 0.78, 0.7, 0, 0, 1.5, Math.random() * TAU, 0, 0, 1, 0);
        } else if (k === SURF.GREEN) {
          parts.emit(K.RING, x, g, y, 0, 0, 0, 0.35, 0.2, 2.5 + 3 * s, 0.85, 1, 0.8, 0.6, 0.2, 0, 0, 0, 0, 0.2, 0, 0);
          if (s > 0.3) chips(x, g, y, fxN(4 + 6 * s), 0, 0, 1.5, 2, GREENS, 0.04, 0.6);
        } else {
          chips(x, g, y, fxN(5 + 16 * s), 0, 0, 1.5 + 3 * s, 2 + 4 * s, k === SURF.ROUGH ? [TURF[0], TURF[2]] : TURF, 0.06, 0.8);
          parts.emit(K.PUFF, x, g + 0.15, y, 0, 0.5, 0, 0.6, 0.3 + s * 0.4, 1.2, 0.85, 0.78, 0.6, 0.4 * s + 0.15, 0, 0, 1, Math.random() * TAU, 0, 0, 1, 0);
        }
      });
    },
    splash(id, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      queue(id, () => {
        const g = WATER_Y + 0.02;
        const who = balls.get(id);
        if (who) who.slumpT = 0;
        // a crown of spray, then rings spreading out
        for (let i = 0; i < fxN(16); i++) {
          const a = (i / 16) * TAU + Math.random() * 0.3, sp = 1.6 + Math.random() * 0.8;
          parts.emit(K.STREAK, x + Math.cos(a) * 0.25, g + 0.1, y + Math.sin(a) * 0.25, Math.cos(a) * sp, 3.2 + Math.random() * 1.5, Math.sin(a) * sp,
            0.45 + Math.random() * 0.2, 0.05, 0, 0.9, 0.97, 1.1, 0.95, 0.25, 12, 0.5, 0, 0, 0.04, 0, 0);
        }
        for (let i = 0; i < fxN(34); i++) {
          const a = Math.random() * TAU, sp = 0.5 + Math.random() * 2.2;
          parts.emit(K.CHIP, x, g, y, Math.cos(a) * sp, 4 + Math.random() * 5, Math.sin(a) * sp, 0.8 + Math.random() * 0.5, 0.06 + Math.random() * 0.06, 0,
            0.75, 0.9, 1, 0.95, 0.2, 14, 0.3, Math.random() * TAU, 0, 0, 0, 0);
        }
        parts.emit(K.SOFT, x, g + 0.8, y, 0, 1.5, 0, 0.5, 0.8, 1.5, 0.9, 0.97, 1, 0.6, 0.3, 0, 0, 0, 0, 0, 0, 0);
        for (let k = 0; k < 3; k++) {
          W.pending.push({ t: k * 0.28, fn: () => parts.emit(K.RING, x, g, y, 0, 0, 0, 1.4 + k * 0.3, 0.25, 2.2 - k * 0.4, 0.9, 0.97, 1, 0.85 - k * 0.15, 0.15, 0, 0, 0, 0, 0.1, 0, 0) });
        }
      });
    },
    tree(x, y, z) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const hz = num(z, 3);
      let best = null, bd = Infinity;
      for (const t of W.trees) { const d = Math.hypot(t.x - x, t.y - y); if (d < bd) { bd = d; best = t; } }
      // follow whichever ball is closest to this point so the rustle meets the ball on screen
      let id = null, rd = Infinity;
      for (const r of balls.values()) { const d = Math.hypot(r.live.x - x, r.live.y - y); if (d < rd) { rd = d; id = r.id; } }
      queue(id, () => {
        if (best && bd < 6) best.shake = 1;
        const g = standAt(x, y);
        for (let i = 0; i < fxN(22); i++) {
          const a = Math.random() * TAU, sp = 1 + Math.random() * 3;
          const c = LEAVES[(Math.random() * LEAVES.length) | 0];
          parts.emit(K.CHIP, x + Math.cos(a) * 0.5, g + hz + (Math.random() - 0.3) * 1.2, y + Math.sin(a) * 0.5, Math.cos(a) * sp, 1 + Math.random() * 2, Math.sin(a) * sp,
            1.6 + Math.random() * 1.2, 0.09 + Math.random() * 0.06, 0, c[0], c[1], c[2], 1, 0, 2.2, 1.6, Math.random() * TAU, (Math.random() - 0.5) * 10, 0, 2, 1);
        }
      });
    },
    holed(id, strokes) {
      const x = W.cup[0], z = W.cup[1], y = W.cupY;
      const ace = Number(strokes) === 1;
      const r = balls.get(id);
      const go = () => {
        if (W.flag) W.flag.flutter = ace ? 1 : 0.7;
        if (r) { r.cheerT = 0; r.cheerKind = (r.idn + r.cheers++) % 3; }
        parts.emit(K.RING, x, y + 0.05, z, 0, 0, 0, 0.5, 0.4, 7, 1, 0.9, 0.4, 0.95, 0.3, 0, 0, 0, 0, 0.25, 0, 0);
        parts.emit(K.SOFT, x, y + 0.6, z, 0, 0, 0, 0.25, 0.8, 4, 1.8, 1.65, 1.1, 0.6, 0.6, 0, 0, 0, 0, 0, 0, 0);
        confetti(x, y, z, fxN(40) + 10, 7);
        if (ace) {
          for (let w = 0; w < 3; w++) {
            W.pending.push({ t: w * 0.32, fn: () => {
              confetti(x, y, z, fxN(110) + 30, 11 + w * 2);
              parts.emit(K.RING, x, y + 0.08, z, 0, 0, 0, 0.7, 0.6, 12, 1, 0.84, 0.3, 0.95, 0.3, 0, 0, 0, 0, 0.2, 0, 0);
              for (let i = 0; i < 5; i++) {
                const a = Math.random() * TAU;
                parts.emit(K.STAR, x + Math.cos(a) * 1.4, y + 1.2 + Math.random() * 1.8, z + Math.sin(a) * 1.4, Math.cos(a) * 1.5, 2.5, Math.sin(a) * 1.5,
                  0.6 + Math.random() * 0.3, 0.45 + Math.random() * 0.4, 0.4, 1, 0.8, 0.15, 1, 0.2, 2, 0.5, Math.random() * TAU, (Math.random() - 0.5) * 4, 0, 2, 0);
              }
            } });
          }
        }
      };
      queue(id, go);
    },
    oob(id) {
      const r = balls.get(id);
      if (!r || !r.init) return;
      const x = r.live.x, y = r.live.y;
      queue(id, () => {
        const g = Math.max(standAt(x, y), 0);
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * TAU;
          parts.emit(K.PUFF, x + Math.cos(a) * 0.2, g + 0.2, y + Math.sin(a) * 0.2, Math.cos(a) * 1.2, 0.6 + Math.random(), Math.sin(a) * 1.2,
            0.6 + Math.random() * 0.3, 0.35, 1.2, 0.9, 0.95, 1, 0.75, 0, 0, 2, Math.random() * TAU, 0, 0, 1, 0);
        }
        parts.emit(K.STAR, x, g + 0.8, y, 0, 0.5, 0, 0.3, 0.6, 1, 1, 0.5, 0.3, 0.9, 0.1, 0, 0, Math.random() * TAU, 2, 0, 2, 0);
      });
    },
  };

  // ── activation ───────────────────────────────────────────────────────
  const saved = { near: 1, snear: 20, sfar: 170, sky: {}, sun: null, haze: new THREE.Color(), hz: new THREE.Vector4() };
  // Klossgolf is played on the ground: an ordinary daytime sky, no cloud sea, haze to the horizon
  const DAY = { cZenith: '#2d6fd3', cMid: '#7db3ea', cMidWarm: '#b9d3ef', cHorWarm: '#f2e6cf', cHorCool: '#d4e4f2', cGlow: '#ffd7a0' };
  const DAY_HAZE = C('#d3e1ee'), DAY_SUN = new THREE.Vector3(-0.66, 0, -0.75).normalize().multiplyScalar(Math.cos(34 * DEG)).setY(Math.sin(34 * DEG));
  function daytime(on) {
    const u = ctx.skyMat && ctx.skyMat.uniforms;
    if (ctx.hemi) {
      if (on) {
        saved.hemiSky = ctx.hemi.color.clone(); saved.hemiGround = ctx.hemi.groundColor.clone(); saved.sunCol = sun.color.clone();
        saved.fillCol = ctx.fill.color.clone(); saved.radius = sun.shadow.radius;
        ctx.hemi.color.set('#bfe0ff'); ctx.hemi.groundColor.set('#7d9a52');   // sky above, grass bounce below
        sun.color.set('#fff0d8'); ctx.fill.color.set('#9fc4ff');
      } else if (saved.hemiSky) {
        ctx.hemi.color.copy(saved.hemiSky); ctx.hemi.groundColor.copy(saved.hemiGround); sun.color.copy(saved.sunCol);
        ctx.fill.color.copy(saved.fillCol); sun.shadow.radius = saved.radius;
      }
    }
    if (on) {
      if (u) {
        for (const k in DAY) if (u[k]) { saved.sky[k] = u[k].value.clone(); u[k].value.set(DAY[k]); }
        if (u.uSun) { saved.sun = u.uSun.value; u.uSun.value = DAY_SUN; }
      }
      saved.haze.copy(shared.uHazeColor.value); saved.hz.copy(shared.uHaze.value);
      shared.uHazeColor.value.copy(DAY_HAZE);
      shared.uHaze.value.set(-40, -60, 0.0016, 110);   // no height haze (nothing is below the ground), distance haze to the horizon
      if (ctx.clouds) ctx.clouds.visible = false;
      if (ctx.towers) ctx.towers.visible = false;
    } else {
      if (u) {
        for (const k in saved.sky) u[k].value.copy(saved.sky[k]);
        if (saved.sun) u.uSun.value = saved.sun;
      }
      shared.uHazeColor.value.copy(saved.haze); shared.uHaze.value.copy(saved.hz);
      if (ctx.clouds) ctx.clouds.visible = true;
      if (ctx.towers) ctx.towers.visible = true;
    }
  }
  function setActive(on) {
    if (on === active) return;
    active = on;
    group.visible = on;
    daytime(on);
    const sc = sun.shadow.camera;
    if (on) {
      saved.near = camera.near; saved.snear = sc.near; saved.sfar = sc.far;
      camera.near = 0.3; camera.updateProjectionMatrix();
      cam.snap = true;
      sc.right = -1;    // force the shadow frustum to be set
    } else {
      camera.near = saved.near; camera.updateProjectionMatrix();
      sc.near = saved.snear; sc.far = saved.sfar; sc.updateProjectionMatrix();
      for (const r of balls.values()) if (r.car) r.car.sprite.visible = false;
    }
  }

  function update(dt, T, view) {
    currentT = T;
    const tier = ctx.tier;
    KU.uKDetail.value.set(tier === 'high' ? 1 : tier === 'medium' ? 0.45 : 0, tier === 'low' ? 0 : 1);
    if (Array.isArray(view.wind)) KU.uKWind.value.set(num(view.wind[0], 0), num(view.wind[1], 0));
    if (W.grass) W.grass.visible = tier !== 'low';
    if (Number.isInteger(view.course) && view.course !== W.ci) setCourse(view.course);
    if (!W.world && KCOURSES.length) setCourse(0);
    readBalls(dt, T, view);
    updateFigures(dt, T, view);
    updateCamera(dt, T, view);
    const nb = writeFigures(T, view);
    writeBalls(dt, T, view, nb);
    writeTrails(T);
    writeAim(dt, T, view);
    writeTags(view);
    updateWorld(dt, T, view);
    updateBirds(T);
    updateShadow(view);
  }

  /** Particles bounce on the island (not on water). */
  const floor = (x, z) => { const h = heightAt(x, z); return h !== NONE && h > -0.5; };

  return { group, setActive, setCourse, update, fx, floor, get ci() { return W.ci; } };
}
