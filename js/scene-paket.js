// Heta paketet – the parcel, the carrier marker and the pass / pop effects.
// Lives on top of Knuffkampen's world: scene.js creates it, calls update() right
// after the cars are animated, and routes fx.pass / fx.pop here.
//
// ctx: { THREE, scene, overlay, camera, parts, cars, K, ST, PALETTE, makeRadialTexture,
//        meArrow, shake(amount), fxMul (getter), vh (getter), floorR() }

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };

// parcel size (m); the car's roof top is about 0.9 above its origin
const PW = 0.92, PH = 0.5, PD = 0.74;
const ROOF = 0.84;
const CLOCK_R = 0.3;
const PSCALE = 1.35;                                  // the whole parcel, for readability from the host view
const PARCEL_TOP = (PH + 0.03 + CLOCK_R * 2 + 0.12) * PSCALE;   // height of the whole stack above the roof
const TAG_LIFT = 1.5;
const HOP_T = 0.34, DROP_T = 0.55, DROP_H = 9;
const NAVY = '#14214f';

// ───────────────────────────────────────────────────────────── textures

function makeNewsprintTexture(THREE) {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#e4d8b9';
  g.fillRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // paper fibres / age spots
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${120 + rnd() * 60 | 0},${110 + rnd() * 50 | 0},${80 + rnd() * 40 | 0},${0.04 + rnd() * 0.05})`;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 3, 1 + rnd() * 2);
  }
  const ink = '#2b2a2e';
  // masthead rule and headline
  g.fillStyle = ink;
  g.fillRect(18, 16, S - 36, 5);
  g.font = '900 104px Georgia, "Times New Roman", serif';
  g.textBaseline = 'top';
  g.fillText('EXTRA!', 22, 26);
  g.fillRect(18, 134, S - 36, 3);
  // sub headline bars
  for (let i = 0; i < 2; i++) g.fillRect(22, 148 + i * 22, 300 - i * 90, 13);
  // photo with halftone dots
  const px = 290, py = 196, pw = 200, ph = 150;
  g.fillStyle = '#c9c1ad';
  g.fillRect(px, py, pw, ph);
  g.fillStyle = 'rgba(40,38,44,0.85)';
  for (let y = 0; y < ph; y += 7) for (let x = 0; x < pw; x += 7) {
    const cx = (x - pw * 0.5) / pw, cy = (y - ph * 0.62) / ph;
    const v = clamp(0.75 - Math.hypot(cx * 1.4, cy * 1.1) * 1.6 + (y > ph * 0.75 ? 0.3 : 0), 0, 1);
    const r = v * 3.2;
    if (r > 0.3) { g.beginPath(); g.arc(px + x + 3, py + y + 3, r, 0, TAU); g.fill(); }
  }
  // text columns
  g.fillStyle = 'rgba(43,42,46,0.72)';
  const col = (x0, y0, w, y1) => {
    for (let y = y0; y < y1; y += 11) {
      if (rnd() < 0.08) continue;      // paragraph gap
      const len = w * (rnd() < 0.15 ? 0.3 + rnd() * 0.5 : 0.92 + rnd() * 0.08);
      g.fillRect(x0, y, len, 5);
    }
  };
  col(22, 200, 120, 500); col(152, 200, 120, 500); col(290, 360, 200, 500);
  g.fillStyle = ink;
  g.fillRect(146, 198, 1.5, 300); g.fillRect(283, 198, 1.5, 300);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeClockFaceTexture(THREE) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const c = S / 2;
  const grd = g.createRadialGradient(c, c * 0.8, 10, c, c, c);
  grd.addColorStop(0, '#fffdf4'); grd.addColorStop(1, '#efe6cf');
  g.fillStyle = grd;
  g.beginPath(); g.arc(c, c, c, 0, TAU); g.fill();
  g.fillStyle = '#26232b';
  for (let i = 0; i < 60; i++) {
    const big = i % 5 === 0;
    g.save();
    g.translate(c, c);
    g.rotate((i / 60) * TAU);
    g.fillRect(big ? -5 : -1.5, -c + 12, big ? 10 : 3, big ? 26 : 10);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMarkerRingTexture(THREE) {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const c = S / 2, R = S / 2 - 6;
  // soft white pool inside
  const grd = g.createRadialGradient(c, c, R * 0.3, c, c, R * 0.82);
  grd.addColorStop(0, 'rgba(255,250,235,0)');
  grd.addColorStop(0.7, 'rgba(255,250,235,0.22)');
  grd.addColorStop(1, 'rgba(255,250,235,0.0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
  // navy band with white dashes (a "breaking news" ticker ring)
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(20,33,79,0.78)';
  g.lineWidth = R * 0.2;
  g.beginPath(); g.arc(c, c, R * 0.88, 0, TAU); g.stroke();
  g.strokeStyle = '#ffffff';
  g.lineWidth = R * 0.12;
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * TAU, a1 = a0 + (TAU / n) * 0.62;
    g.beginPath(); g.arc(c, c, R * 0.88, a0, a1); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makePoffTexture(THREE) {
  const W = 512, H = 320;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const cx = W / 2, cy = H / 2;
  const star = (rOut, rIn, n, fill, stroke, lw) => {
    g.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * TAU - Math.PI / 2, r = i % 2 ? rIn : rOut * (0.86 + 0.14 * Math.sin(i * 2.7));
      g.lineTo(cx + Math.cos(a) * r * 1.45, cy + Math.sin(a) * r * 0.95);
    }
    g.closePath();
    g.fillStyle = fill; g.fill();
    if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.stroke(); }
  };
  star(150, 104, 13, '#ffd84a', NAVY, 10);
  star(118, 92, 13, '#fff3b0', null, 0);
  g.font = '900 112px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(cx, cy + 6);
  g.rotate(-0.08);
  g.lineJoin = 'round';
  g.lineWidth = 18; g.strokeStyle = NAVY; g.strokeText('POFF!', 0, 0);
  g.fillStyle = '#ff4f6d'; g.fillText('POFF!', 0, 0);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: W / H };
}

// ───────────────────────────────────────────────────────────── geometry

/** A pillowy, slightly crumpled box: shared positions move together, so no seams open. */
function parcelGeometry(THREE) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 6, 4, 6);
  const p = geo.attributes.position;
  const hash = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = 1 - 4 * x * x, ay = 1 - 4 * y * y, az = 1 - 4 * z * z;
    const bx = 0.07 * ay * az, by = 0.1 * ax * az, bz = 0.07 * ax * ay;
    const n = (hash(x, y, z) - 0.5) * 0.045;
    x *= 1 + bx + n; y *= 1 + by + n * 0.6; z *= 1 + bz + n;
    p.setXYZ(i, x * PW, y * PH + PH / 2, z * PD);
  }
  geo.computeVertexNormals();
  return geo;
}

function ribbonGeometry(THREE) {
  const N = 28, L = 1.7, R = 0.13, Wd = 0.07, turns = 2.6;
  const pos = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, a = t * turns * TAU, y = (t - 0.5) * L;
    const r = R * (0.6 + 0.4 * Math.sin(t * Math.PI));
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pos.push(x, y - Wd, z, x, y + Wd, z);
    if (i < N) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function arrowGeometry(THREE) {
  const s = new THREE.Shape();
  const P = [[-0.3, 0.55], [0.3, 0.55], [0.3, 0.08], [0.62, 0.08], [0, -0.55], [-0.62, 0.08], [-0.3, 0.08]];
  s.moveTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length; i++) s.lineTo(P[i][0], P[i][1]);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
  geo.translate(0, 0, -0.07);
  return geo;
}

// ───────────────────────────────────────────────────────────── the module

export function createPaket(ctx) {
  const { THREE, scene, overlay, camera, parts, cars, K, ST, PALETTE } = ctx;
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _c = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);

  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  // ---- materials
  const paperTex = makeNewsprintTexture(THREE);
  const paperMat = new THREE.MeshStandardMaterial({ map: paperTex, roughness: 0.92, metalness: 0, emissive: new THREE.Color('#ff3d12'), emissiveIntensity: 0 });
  const stringMat = new THREE.MeshStandardMaterial({ color: '#e0203a', roughness: 0.75, emissive: new THREE.Color('#ff3d12'), emissiveIntensity: 0 });
  const clockMat = new THREE.MeshStandardMaterial({ color: '#e63b2e', roughness: 0.32, metalness: 0.25, emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: '#e9e4da', roughness: 0.22, metalness: 0.85 });
  const bellMat = new THREE.MeshStandardMaterial({ color: '#f2c14e', roughness: 0.25, metalness: 0.8, emissive: new THREE.Color('#ffb020'), emissiveIntensity: 0.08 });
  const faceMat = new THREE.MeshBasicMaterial({ map: makeClockFaceTexture(THREE) });
  const inkMat = new THREE.MeshBasicMaterial({ color: '#1d1b22' });

  // ---- the clock (built by a function so the pop can throw a copy)
  function buildClock(mats) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(CLOCK_R, CLOCK_R, 0.15, 28).rotateX(Math.PI / 2), mats.clock);
    body.castShadow = true;
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(CLOCK_R * 0.8, 0.022, 8, 32), mats.chrome);
    bezel.position.z = 0.075;
    const face = new THREE.Mesh(new THREE.CircleGeometry(CLOCK_R * 0.79, 32), faceMat);
    face.position.z = 0.078;
    const hourH = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.01).translate(0, 0.045, 0), inkMat);
    const minH = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.17, 0.01).translate(0, 0.075, 0), inkMat);
    hourH.position.z = 0.084; minH.position.z = 0.09;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 10).rotateX(Math.PI / 2), mats.clock);
    hub.position.z = 0.09;
    const bells = [];
    for (const sgn of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.rotation.z = -sgn * 0.62;
      const bell = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 8, 0, TAU, 0, Math.PI / 2), mats.bell);
      bell.position.y = CLOCK_R + 0.05;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.08, 6), mats.chrome);
      post.position.y = CLOCK_R + 0.02;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), mats.chrome);
      knob.position.y = CLOCK_R + 0.19;
      pivot.add(bell, post, knob);
      bells.push(pivot);
    }
    const hammer = new THREE.Group();
    hammer.position.y = CLOCK_R - 0.02;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6).translate(0, 0.1, 0), mats.chrome);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.036, 10, 8), mats.chrome);
    ball.position.y = 0.2;
    hammer.add(rod, ball);
    hammer.position.z = -0.02;
    const feet = [];
    for (const sgn of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mats.chrome);
      f.position.set(sgn * 0.15, -CLOCK_R + 0.01, 0);
      feet.push(f);
    }
    g.add(body, bezel, face, hourH, minH, hub, hammer, ...bells, ...feet);
    return { g, bells, hammer, hourH, minH };
  }

  // ---- the parcel rig
  const rig = new THREE.Group();          // follows the roof, faces the camera
  const body = new THREE.Group();         // shake, squash and flips
  rig.scale.setScalar(PSCALE);
  rig.add(body);
  root.add(rig);
  const box = new THREE.Mesh(parcelGeometry(THREE), paperMat);
  box.castShadow = true;
  body.add(box);
  // twine: two bands crossing on top, and a bow
  const band1 = new THREE.Mesh(new THREE.BoxGeometry(0.11, PH * 1.2, PD * 1.16).translate(0, PH / 2, 0), stringMat);
  const band2 = new THREE.Mesh(new THREE.BoxGeometry(PW * 1.16, PH * 1.2, 0.11).translate(0, PH / 2, 0), stringMat);
  body.add(band1, band2);
  const bow = new THREE.Group();
  for (const sgn of [-1, 1]) {
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.04, 6, 16), stringMat);
    loop.scale.set(1.2, 0.7, 1);
    loop.position.set(sgn * 0.11, 0.04, 0);
    loop.rotation.z = sgn * 0.35;
    bow.add(loop);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.02), stringMat);
    tail.position.set(sgn * 0.06, -0.04, 0.02);
    tail.rotation.z = sgn * 0.5;
    bow.add(tail);
  }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), stringMat);
  bow.add(knot);
  bow.position.set(-PW * 0.32, PH * 1.06, PD * 0.5);
  bow.rotation.x = -0.5;
  body.add(bow);
  const clock = buildClock({ clock: clockMat, chrome: chromeMat, bell: bellMat });
  const clockSeat = new THREE.Group();
  clockSeat.position.set(0.04, PH + 0.06 + CLOCK_R, 0.02);
  clockSeat.rotation.x = -0.42;                 // tilt the face up toward the camera
  clockSeat.add(clock.g);
  body.add(clockSeat);

  // hot glow behind the parcel in the last stretch
  const glowTex = ctx.makeRadialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: '#ff6a2a', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  glow.position.y = PH * 0.8;
  glow.renderOrder = 7;
  rig.add(glow);

  // ---- carrier marker: ring on the ice, a soft beam and a bobbing arrow
  const ringMat = new THREE.MeshBasicMaterial({ map: makeMarkerRingTexture(THREE), transparent: true, depthWrite: false, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4).rotateX(-Math.PI / 2), ringMat);
  ring.renderOrder = 3;
  root.add(ring);

  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(1, 0.95, 0.82) } },
    vertexShader: /* glsl */`
      varying float vY; varying float vEdge;
      void main() {
        vY = uv.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vEdge = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uOpacity; uniform vec3 uColor;
      varying float vY; varying float vEdge;
      void main() {
        float a = pow(vEdge, 1.6) * smoothstep(0.0, 0.12, vY) * pow(1.0 - vY, 1.4);
        a *= 0.78 + 0.22 * sin(vY * 46.0 - uTime * 7.0);
        a *= uOpacity;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const BEAM_H = 18;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.35, BEAM_H, 28, 1, true).translate(0, BEAM_H / 2, 0), beamMat);
  beam.renderOrder = 8;
  beam.frustumCulled = false;
  root.add(beam);

  const arrowGeo = arrowGeometry(THREE);
  const arrow = new THREE.Group();
  const arrowFill = new THREE.Mesh(arrowGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: new THREE.Color('#fff4dc'), emissiveIntensity: 0.55, roughness: 0.4 }));
  const arrowLine = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: NAVY, side: THREE.BackSide }));
  arrowLine.scale.set(1.16, 1.12, 1.3);
  arrow.add(arrowLine, arrowFill);
  root.add(arrow);

  // ---- pop props: flying clocks, streamers, the POFF bubble
  const flyMats = { clock: clockMat.clone(), chrome: chromeMat, bell: bellMat };
  flyMats.clock.emissiveIntensity = 0;
  const fliers = [];
  for (let i = 0; i < 2; i++) {
    const c = buildClock(flyMats);
    c.g.visible = false;
    scene.add(c.g);
    fliers.push({ ...c, t: 99, life: 2.6, p: new THREE.Vector3(), v: new THREE.Vector3(), spin: new THREE.Vector3(), sparkAcc: 0 });
  }
  const ribGeo = ribbonGeometry(THREE);
  const ribbons = [];
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(ribGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55, side: THREE.DoubleSide }));
    m.visible = false;
    m.castShadow = false;
    scene.add(m);
    ribbons.push({ m, t: 99, life: 2.8, p: new THREE.Vector3(), v: new THREE.Vector3(), axis: new THREE.Vector3(), spinV: 0, ang: 0 });
  }
  const poff = makePoffTexture(THREE);
  const poffs = [];
  for (let i = 0; i < 2; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: poff.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    s.visible = false;
    s.renderOrder = 25;
    overlay.add(s);
    poffs.push({ s, t: 99, x: 0, y: 0, z: 0, rot: 0 });
  }

  // ---- state
  const S = {
    active: false,
    owner: -1,          // car the parcel belongs to (or is on its way to)
    prevView: -1,       // view.carrier last frame
    shown: 0,           // parcel visibility 0..1
    hop: null,          // { t, from: Vector3, to }
    drop: null,         // { t }
    release: 0,         // seconds since view.carrier went to -1 while we still show it
    popped: -1,
    fuse: 0,
    tickPh: 0, tickKick: 0, hand: 0,
    sq: 0, sqv: 0,
    mark: 0,
    rippleT: 0, steamAcc: 0,
    pos: new THREE.Vector3(),   // where the parcel was drawn last
    have: false,
  };

  function carOk(id) {
    const car = cars.get(id);
    return car && car.visible && car.m4 ? car : null;
  }
  function roofOf(car, out) {
    return out.set(0, ROOF, 0).applyMatrix4(car.m4);
  }

  function scraps(x, y, z, n, up) {
    n = Math.round(n * (0.5 + 0.5 * ctx.fxMul));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = 1.5 + Math.random() * 3.5;
      const grey = Math.random() < 0.3;
      const r = grey ? 0.5 : 0.95, g = grey ? 0.49 : 0.91, b = grey ? 0.5 : 0.8;
      parts.emit(K.CONF, x + Math.cos(a) * 0.3, y, z + Math.sin(a) * 0.3, Math.cos(a) * sp, up + Math.random() * 3, Math.sin(a) * sp,
        1 + Math.random() * 0.8, 0.07 + Math.random() * 0.06, 0, r, g, b, 1, 0, 9, 1.9,
        Math.random() * TAU, (Math.random() - 0.5) * 12, Math.random() * TAU, 2, 1);
    }
  }

  function startHop(toId) {
    const car = carOk(toId);
    if (!car) { S.owner = toId; return; }
    const from = S.have && S.shown > 0.3 ? S.pos.clone() : null;
    S.owner = toId; S.release = 0; S.popped = -1;
    if (!from) { S.hop = null; S.drop = { t: 0 }; return; }
    S.hop = { t: 0, from, to: toId, flip: Math.random() < 0.5 ? 1 : -1 };
    S.drop = null;
    scraps(from.x, from.y + 0.4, from.z, 14, 3.5);
    parts.emit(K.STAR, from.x, from.y + 0.5, from.z, 0, 0.6, 0, 0.2, 0.6, 2.4, 1, 0.85, 0.3, 0.95, 0.1, 0, 0, Math.random() * TAU, 2, 0, 2, 0);
  }

  function startDrop(toId) {
    S.owner = toId; S.hop = null; S.drop = { t: 0 }; S.release = 0; S.popped = -1;
  }

  function hideAll() {
    root.visible = false;
    for (const f of fliers) { f.t = 99; f.g.visible = false; }
    for (const r of ribbons) { r.t = 99; r.m.visible = false; }
    for (const p of poffs) { p.t = 99; p.s.visible = false; }
  }

  function setActive(on) {
    on = !!on;
    if (on === S.active) return;
    S.active = on;
    S.owner = -1; S.prevView = -1; S.hop = null; S.drop = null; S.popped = -1; S.shown = 0; S.mark = 0; S.have = false;
    hideAll();
  }

  // ── per frame ────────────────────────────────────────────────────────
  function update(dt, T, view) {
    if (!S.active) return;
    beamMat.uniforms.uTime.value = T;
    const vc = Number.isFinite(view.carrier) ? view.carrier : -1;
    S.fuse = vc >= 0 ? clamp(Number(view.fuse) || 0, 0, 1) : S.fuse;

    // carrier changes seen in the view (fx.pass may have handled them already)
    if (vc !== S.prevView) {
      if (vc >= 0 && vc !== S.owner) {
        if (S.prevView >= 0 && S.owner >= 0 && carOk(S.owner) && S.popped < 0) startHop(vc);
        else startDrop(vc);
      } else if (vc < 0 && S.owner >= 0) S.release = 1e-4;
      S.prevView = vc;
    }
    if (vc >= 0 && vc === S.owner) S.release = 0;
    if (S.release > 0) S.release += dt;

    const car = S.owner >= 0 ? carOk(S.owner) : null;
    const falling = car ? (car.st & ST.FALLING) !== 0 : false;
    let want = car && S.popped < 0 ? 1 : 0;
    if (S.release > 0 && !falling && S.release > 0.35) want = 0;
    if (want === 0 && S.release > 0.35) S.owner = -1;

    if (want) S.shown = 1; else S.shown = 0;
    root.visible = true;
    rig.visible = S.shown > 0;

    const f = S.fuse;
    let px = 0, py = 0, pz = 0;
    if (car && S.shown > 0) {
      roofOf(car, _v);
      px = _v.x; py = _v.y; pz = _v.z;
      let sx = 0, rotFlip = 0;
      if (S.hop) {
        S.hop.t += dt;
        const e = clamp(S.hop.t / HOP_T, 0, 1), es = smooth(e);
        const fr = S.hop.from;
        px = lerp(fr.x, px, es); pz = lerp(fr.z, pz, es);
        py = lerp(fr.y, py, e) + 2.2 * 4 * e * (1 - e);
        rotFlip = S.hop.flip * TAU * smooth(e);
        sx = Math.sin(e * Math.PI) * 0.15;
        if (e >= 1) {
          S.hop = null;
          S.sqv -= 9;
          scraps(px, py + 0.3, pz, 16, 3);
          parts.emit(K.RING, px, 0.08, pz, 0, 0, 0, 0.35, 0.8, 9, 1, 0.97, 0.88, 0.9, 0.15, 0, 0, 0, 0, 0.22, 0, 0);
          car.qv = (car.qv || 0) + 5;
        }
      } else if (S.drop) {
        S.drop.t += dt;
        const e = clamp(S.drop.t / DROP_T, 0, 1);
        py += DROP_H * (1 - e * e);
        if (e >= 1) {
          S.drop = null;
          S.sqv -= 12;
          car.qv = (car.qv || 0) + 6;
          scraps(px, py + 0.2, pz, 12, 2.5);
          parts.emit(K.RING, px, 0.08, pz, 0, 0, 0, 0.45, 0.8, 10, 1, 0.97, 0.88, 0.9, 0.15, 0, 0, 0, 0, 0.22, 0, 0);
          parts.emit(K.SOFT, px, py + 0.3, pz, 0, 0, 0, 0.14, 1.3, 5, 1.6, 1.5, 1.2, 0.6, 0.6, 0, 0, 0, 0, 0, 0, 0);
        }
      }
      S.pos.set(px, py, pz); S.have = true;

      // squash spring
      const h = Math.min(dt, 0.033);
      S.sqv += (-S.sq * 260 - S.sqv * 11) * h;
      S.sq = clamp(S.sq + S.sqv * h, -0.45, 0.45);

      // ticking: faster and harder as the fuse burns
      const rate = 1.4 + 7.5 * f * f;
      S.tickPh += dt * rate;
      if (S.tickPh >= 1) {
        S.tickPh -= Math.floor(S.tickPh);
        S.tickKick = 1;
        S.hand += TAU / 12;
        S.sqv += 1.2 + 4.5 * f * f;
      }
      S.tickKick = Math.max(0, S.tickKick - dt * 9);

      // orientation: tilt with the car, face the camera
      const yaw = Math.atan2(camera.position.x - px, camera.position.z - pz);
      _q.setFromAxisAngle(Y, yaw);
      const ll = Math.hypot(car.lx || 0, car.lz || 0);
      if (ll > 1e-4) { _q2.setFromAxisAngle(_v2.set(car.lz / ll, 0, -car.lx / ll), ll); _q.premultiply(_q2); }
      rig.quaternion.copy(_q);
      rig.position.set(px, py - 0.05, pz);

      // shake
      const amp = 0.006 + 0.07 * Math.pow(f, 2.4);
      const fq = 34 + 60 * f;
      body.position.set(
        Math.sin(T * fq) * amp + Math.sin(T * fq * 1.7 + 1) * amp * 0.5,
        Math.sin(T * 2.6) * 0.025 + S.tickKick * (0.03 + 0.06 * f),
        Math.sin(T * fq * 1.3 + 2) * amp * 0.6);
      body.rotation.set(rotFlip, 0, Math.sin(T * fq * 0.9) * (0.01 + 0.09 * f * f) + sx);
      body.scale.set(1 + S.sq * 0.55, 1 - S.sq, 1 + S.sq * 0.55);

      // clock: hop on each tick, ringing bells near the end
      const ringing = smooth((f - 0.35) / 0.5);
      clock.g.position.set(Math.sin(T * fq * 1.1) * amp * 1.4, S.tickKick * (0.05 + 0.07 * f), 0);
      clock.g.rotation.z = Math.sin(T * (fq * 0.8)) * (0.03 + 0.18 * ringing);
      clock.hammer.rotation.z = Math.sin(T * (28 + 40 * f)) * (0.12 + 0.55 * ringing);
      for (let k = 0; k < 2; k++) clock.bells[k].rotation.x = Math.sin(T * (50 + 30 * f) + k * 2) * (0.02 + 0.12 * ringing);
      clock.minH.rotation.z = -S.hand;
      clock.hourH.rotation.z = -S.hand / 12 - 1.1;

      // heat: a glow and flashes in the last stretch
      const heat = smooth((f - 0.62) / 0.33);
      const pf = 2 + 9 * f * f;
      const pulse = 0.5 + 0.5 * Math.sin(T * pf * TAU);
      const flash = f > 0.9 ? Math.pow(pulse, 6) : 0;
      paperMat.emissiveIntensity = heat * (0.12 + 0.35 * pulse) + flash * 0.4;
      stringMat.emissiveIntensity = heat * (0.2 + 0.4 * pulse);
      clockMat.emissiveIntensity = heat * (0.25 + 0.75 * pulse) + flash * 0.6;
      glow.material.opacity = heat * (0.35 + 0.5 * pulse) + flash * 0.4;
      glow.scale.setScalar(2.4 + 1.4 * heat * pulse + flash);
      glow.material.color.setRGB(1, 0.42 + 0.4 * flash, 0.16 + 0.5 * flash);

      // a little steam when it is getting hot
      if (f > 0.5 && !S.hop && !S.drop) {
        S.steamAcc += dt * (f - 0.5) * 14 * ctx.fxMul;
        while (S.steamAcc >= 1) {
          S.steamAcc -= 1;
          const a = Math.random() * TAU;
          parts.emit(K.PUFF, px + Math.cos(a) * 0.35, py + PH + 0.3, pz + Math.sin(a) * 0.35, Math.cos(a) * 0.4, 1.6 + Math.random(), Math.sin(a) * 0.4,
            0.7 + Math.random() * 0.4, 0.2 + Math.random() * 0.12, 0.7, 1, 1, 1, 0.55, 0, -0.5, 1.2, Math.random() * TAU, 0, 0, 1, 0);
        }
      }

      // lift the name tag above the parcel, and stand in for the local "this is you" arrow
      if (car.sprite.visible) { car.sprite.position.y += TAG_LIFT; car.tagTop = (car.tagTop || 2.2) + TAG_LIFT; }
      else car.tagTop = Math.max(car.tagTop || 0, py + PARCEL_TOP + 0.2);
      if (ctx.meArrow && (car.isMe || (view.myId != null && car.id === view.myId))) ctx.meArrow.visible = false;
    } else if (!want) {
      S.hop = null; S.drop = null;
    }

    // ---- the marker follows the parcel (it slides across during a hop)
    const markWant = car && S.shown > 0 && !falling ? 1 : 0;
    S.mark += (markWant - S.mark) * damp(dt, markWant ? 0.12 : 0.08);
    const mv = S.mark > 0.02 && car;
    ring.visible = beam.visible = arrow.visible = !!mv;
    if (mv) {
      const mx = S.hop || S.drop ? S.pos.x : car.x + (car.ox || 0), mz = S.hop || S.drop ? S.pos.z : car.z + (car.oz || 0);
      const heat = smooth((S.fuse - 0.62) / 0.33);
      const pulse = 0.5 + 0.5 * Math.sin(T * (3 + 8 * S.fuse * S.fuse) * TAU * 0.5);
      ring.position.set(mx, 0.05, mz);
      ring.rotation.y = -T * 1.1;
      ring.scale.setScalar(S.mark * (1 + 0.06 * Math.sin(T * 5.5)));
      ringMat.color.setRGB(1, 1 - heat * 0.45 * pulse, 1 - heat * 0.6 * pulse);
      ringMat.opacity = S.mark;
      beam.position.set(mx, 0, mz);
      beamMat.uniforms.uOpacity.value = S.mark * ((view.spectate ? 0.62 : 0.4) + 0.12 * Math.sin(T * 3));
      beamMat.uniforms.uColor.value.setRGB(1, 0.95 - heat * 0.35 * pulse, 0.82 - heat * 0.45 * pulse);
      // arrow: above the tag, sized for the distance like the tags
      const top = Math.max(car.tagTop || 2.2, (S.hop || S.drop ? S.pos.y : 0) + PARCEL_TOP);
      const ay = top + 0.75 + Math.abs(Math.sin(T * 3.6)) * 0.45;
      const dist = Math.max(1, _v.set(mx, ay, mz).distanceTo(camera.position));
      const tanHalf = Math.tan((camera.fov * Math.PI / 180) / 2);
      const pxPerM = ctx.vh / (2 * dist * tanHalf);
      const as = clamp(Math.max(30, ctx.vh * 0.045) / pxPerM, 0.5, 3.2) * S.mark;
      arrow.position.set(mx, ay + as * 0.3, mz);
      arrow.quaternion.copy(camera.quaternion);
      arrow.rotateY(Math.sin(T * 2.2) * 0.5);
      arrow.scale.set(as, as * (1 + 0.08 * Math.sin(T * 7.2)), as);
      // ripples on the ice
      S.rippleT -= dt;
      if (S.rippleT <= 0 && markWant) {
        S.rippleT = lerp(1.0, 0.35, S.fuse);
        parts.emit(K.RING, mx, 0.07, mz, 0, 0, 0, 0.9, 1.2, 2.6, 1, 0.97 - heat * 0.4, 0.9 - heat * 0.6, 0.55, 0.2, 0, 0, 0, 0, 0.14, 0, 0);
      }
    }

    updateProps(dt, T);
  }

  // ── pop props ────────────────────────────────────────────────────────
  function updateProps(dt, T) {
    const floorR = ctx.floorR();
    for (const fl of fliers) {
      if (fl.t >= fl.life) { if (fl.g.visible) fl.g.visible = false; continue; }
      fl.t += dt;
      fl.v.y -= 19 * dt;
      fl.p.addScaledVector(fl.v, dt);
      if (fl.p.y < CLOCK_R && fl.v.y < 0 && Math.hypot(fl.p.x, fl.p.z) < floorR) {
        fl.p.y = CLOCK_R; fl.v.y *= -0.45; fl.v.x *= 0.7; fl.v.z *= 0.7; fl.spin.multiplyScalar(0.6);
        if (Math.abs(fl.v.y) > 1.5) parts.emit(K.RING, fl.p.x, 0.07, fl.p.z, 0, 0, 0, 0.3, 0.5, 6, 1, 0.95, 0.8, 0.8, 0.15, 0, 0, 0, 0, 0.22, 0, 0);
      }
      fl.g.position.copy(fl.p);
      fl.g.position.x += Math.sin(T * 70) * 0.03;
      fl.g.rotation.x += fl.spin.x * dt; fl.g.rotation.y += fl.spin.y * dt; fl.g.rotation.z += fl.spin.z * dt;
      fl.hammer.rotation.z = Math.sin(T * 75) * 0.7;
      for (let k = 0; k < 2; k++) fl.bells[k].rotation.x = Math.sin(T * 80 + k * 2) * 0.15;
      const s = fl.t < 0.1 ? 1 : 1 - smooth((fl.t - fl.life + 0.45) / 0.45);
      fl.g.scale.setScalar(1.6 * Math.max(0.001, s));
      fl.g.visible = true;
      // little ringing sparks around the bells
      fl.sparkAcc += dt * 26 * ctx.fxMul * (1 - fl.t / fl.life);
      while (fl.sparkAcc >= 1) {
        fl.sparkAcc -= 1;
        const a = Math.random() * TAU;
        parts.emit(K.STREAK, fl.p.x, fl.p.y + 0.3, fl.p.z, Math.cos(a) * 3, 1.5 + Math.random() * 2.5, Math.sin(a) * 3,
          0.22, 0.04, 0, 2.4, 2.0, 0.9, 1, 0.4, 2, 2, 0, 0, 0.04, 0, 0);
      }
    }
    for (const r of ribbons) {
      if (r.t >= r.life) { if (r.m.visible) r.m.visible = false; continue; }
      r.t += dt;
      const dr = Math.exp(-1.6 * dt);
      r.v.x *= dr; r.v.z *= dr; r.v.y = r.v.y * dr - 7 * dt;
      r.p.addScaledVector(r.v, dt);
      const onFloor = r.p.y < 0.08 && Math.hypot(r.p.x, r.p.z) < floorR;
      if (onFloor) { r.p.y = 0.08; r.v.set(0, 0, 0); r.spinV *= 0.9; }
      r.ang += r.spinV * dt;
      r.m.position.copy(r.p);
      r.m.quaternion.setFromAxisAngle(r.axis, r.ang);
      const grow = smooth(r.t / 0.3), fade = 1 - smooth((r.t - r.life + 0.5) / 0.5);
      r.m.scale.set(1, 0.35 + 0.65 * grow, 1).multiplyScalar(Math.max(0.001, fade * 1.15));
      r.m.visible = true;
    }
    const tanHalf = Math.tan((camera.fov * Math.PI / 180) / 2);
    for (const p of poffs) {
      if (p.t >= 0.8) { if (p.s.visible) p.s.visible = false; continue; }
      p.t += dt;
      const dist = Math.max(1, _v.set(p.x, p.y, p.z).distanceTo(camera.position));
      const pxPerM = ctx.vh / (2 * dist * tanHalf);
      const hh = clamp(Math.max(62, ctx.vh * 0.085) / pxPerM, 1.2, 6);
      const s = easeOutBack(clamp(p.t / 0.2, 0, 1)) * (1 + 0.1 * p.t);
      p.s.scale.set(hh * poff.aspect * s, hh * s, 1);
      p.s.position.set(p.x, p.y + p.t * 0.6, p.z);
      p.s.material.rotation = p.rot + Math.sin(p.t * 18) * 0.04 * (1 - p.t);
      p.s.material.opacity = 1 - smooth((p.t - 0.45) / 0.35);
      p.s.visible = true;
    }
  }

  // ── effects ──────────────────────────────────────────────────────────
  const fx = {
    pass(fromId, toId) {
      if (!S.active || toId == null || toId < 0) return;
      if (S.owner === toId) return;               // the view got there first
      if (!S.have || S.shown <= 0 || !carOk(S.owner)) {
        // nothing on screen to hop from: start from the giver's roof if we can
        const from = carOk(fromId);
        if (from) { roofOf(from, S.pos); S.have = true; S.shown = 1; }
      }
      startHop(toId);
    },
    pop(id) {
      if (!S.active) return;
      const car = cars.get(id);
      let x, y, z;
      if (S.owner === id && S.have && S.shown > 0) { x = S.pos.x; y = S.pos.y; z = S.pos.z; }
      else if (car) { x = car.x; z = car.z; y = (car.h || 0) + ROOF; }
      else return;
      if (S.owner === id) { S.owner = -1; S.hop = null; S.drop = null; }
      S.popped = id;
      S.shown = 0;
      const m = 0.5 + 0.5 * ctx.fxMul;

      // the popper: a cone of confetti upward
      const n = Math.round(240 * m) + 30;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = 1.5 + Math.random() * 6.5;
        if (Math.random() < 0.18) _c.setRGB(1, 0.86, 0.3); else _c.set(PALETTE[(Math.random() * PALETTE.length) | 0]);
        parts.emit(K.CONF, x + Math.cos(a) * 0.3, y + 0.4 + Math.random() * 0.6, z + Math.sin(a) * 0.3, Math.cos(a) * sp, 9 + Math.random() * 11, Math.sin(a) * sp,
          2.6 + Math.random() * 1.8, 0.13 + Math.random() * 0.11, 0, _c.r * 1.15, _c.g * 1.15, _c.b * 1.15, 1, 0, 9, 1.6,
          Math.random() * TAU, (Math.random() - 0.5) * 10, Math.random() * TAU, 2, 1);
      }
      scraps(x, y + 0.4, z, 40, 6);
      // streak sparkle
      const ns = Math.round(30 * m);
      for (let i = 0; i < ns; i++) {
        const a = Math.random() * TAU, el = 0.3 + Math.random() * 1.1, sp = 6 + Math.random() * 9;
        parts.emit(K.STREAK, x, y + 0.6, z, Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp,
          0.3 + Math.random() * 0.3, 0.06, 0, 2.6, 2.1, 1.0, 1, 0.35, 8, 2, 0, 0, 0.04, 0, 0);
      }
      parts.emit(K.STAR, x, y + 1.0, z, 0, 0.6, 0, 0.32, 1.5, 4.5, 1, 0.8, 0.14, 0.95, 0.1, 0, 0, Math.random() * TAU, 2, 0, 2, 0);
      parts.emit(K.SOFT, x, y + 0.8, z, 0, 0, 0, 0.2, 2.2, 8, 1.8, 1.65, 1.25, 0.7, 0.6, 0, 0, 0, 0, 0, 0, 0);
      parts.emit(K.RING, x, 0.08, z, 0, 0, 0, 0.5, 1, 14, 1, 0.95, 0.85, 0.9, 0.15, 0, 0, 0, 0, 0.18, 0, 0);
      // a cartoon cloud where the car was
      const np = Math.round(16 * m) + 5, base = car ? car.h || 0 : 0;
      for (let i = 0; i < np; i++) {
        const a = (i / np) * TAU + Math.random() * 0.4, r = 0.3 + Math.random() * 0.8, sp = 1.4 + Math.random() * 2.4;
        const tint = 0.68 + Math.random() * 0.2;
        parts.emit(K.PUFF, x + Math.cos(a) * r, base + 0.3 + Math.random() * 1.3, z + Math.sin(a) * r,
          Math.cos(a) * sp, 0.6 + Math.random() * 1.8, Math.sin(a) * sp,
          1.1 + Math.random() * 0.7, 1.3 + Math.random() * 0.9, 1.2, tint, tint * 0.96, tint * 1.12, 1, 0, -0.5, 2.4, Math.random() * TAU, 0, 0, 1, 0);
      }
      if (car) {   // a few puffs in the car's own colour: it really did go up in smoke
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU;
          parts.emit(K.PUFF, x + Math.cos(a) * 0.4, base + 0.5, z + Math.sin(a) * 0.4, Math.cos(a) * 2, 1.5 + Math.random(), Math.sin(a) * 2,
            0.9, 0.9 + Math.random() * 0.4, 1.2, car.color.r, car.color.g, car.color.b, 0.95, 0, -0.5, 2.4, Math.random() * TAU, 0, 0, 1, 0);
        }
      }
      // the alarm clock flies off, still ringing
      const fl = fliers.find((f) => f.t >= f.life) || fliers[0];
      const a = Math.atan2(z, x) + (Math.random() - 0.5) * 1.6;
      fl.t = 0; fl.sparkAcc = 0;
      fl.p.set(x, y + PH + CLOCK_R + 0.1, z);
      fl.v.set(Math.cos(a) * (2.5 + Math.random() * 2), 11 + Math.random() * 2.5, Math.sin(a) * (2.5 + Math.random() * 2));
      fl.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 12);
      fl.g.rotation.set(0, Math.atan2(camera.position.x - x, camera.position.z - z), 0);
      // streamers
      let k = 0;
      for (const r of ribbons) {
        if (r.t < r.life) continue;
        if (k++ >= Math.round(8 + 4 * ctx.fxMul)) break;
        const ra = Math.random() * TAU, sp = 2 + Math.random() * 4;
        r.t = 0; r.life = 2.4 + Math.random() * 1.0;
        r.p.set(x, y + 0.6, z);
        r.v.set(Math.cos(ra) * sp, 8 + Math.random() * 6, Math.sin(ra) * sp);
        r.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        r.ang = Math.random() * TAU; r.spinV = (Math.random() - 0.5) * 9;
        r.m.material.color.set(PALETTE[(Math.random() * PALETTE.length) | 0]);
      }
      // the bubble
      const p = poffs.find((q) => q.t >= 0.8) || poffs[0];
      p.t = 0; p.x = x; p.y = y + 3.4; p.z = z; p.rot = (Math.random() - 0.5) * 0.3;
      ctx.shake(0.35);
    },
  };

  return {
    get active() { return S.active; },
    setActive, update, fx,
  };
}
