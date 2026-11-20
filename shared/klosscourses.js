// Klossgolf – the holes. KCOURSES[0] is the practice range (lobby and after a match);
// a match plays KCOURSES[1..] in order.
//
// Course format (frozen):
//   name     Swedish, shown to players
//   par      3, 4 or 5
//   time     optional hole clock in seconds (default 20 + 25 * par)
//   bounds   [minX, minY, maxX, maxY]: outside is out of bounds
//   tee      { x, y, a }: centre of the square tee box (side KG.TEE_W) and the
//            direction players face, radians, atan2(dy, dx)
//   cup      [x, y]: must lie on the green
//   line     [[x, y], ...]: the sensible route from the tee to the cup (last point =
//            cup). The caddie aims along it; bots follow it.
//   fairway, green, sand, water
//            lists of shapes; everything else inside the bounds is rough
//   trees    [[x, y, r, h], ...]: leaf radius and height in metres
//
// Shapes:
//   { k: 'circle', x, y, r }
//   { k: 'rect', x, y, w, h, a }       centre, size along its own axes, rotation
//   { k: 'path', pts: [[x, y], ...], w }   a strip of full width w along a polyline
//
// The ground is flat. Sand beats green beats tee beats water beats fairway, so an
// island green is a green shape on top of a water shape.

const UP = Math.PI / 2;

export const KCOURSES = [
  // 0: the practice range (lobby and after a match)
  {
    name: 'Rangen',
    par: 3,
    bounds: [-42, -18, 42, 128],
    tee: { x: 0, y: 0, a: UP },
    cup: [0, 96],
    line: [[0, 0], [0, 96]],
    fairway: [{ k: 'path', pts: [[0, 12], [0, 82]], w: 28 }],
    green: [{ k: 'circle', x: 0, y: 96, r: 11 }],
    sand: [{ k: 'circle', x: -14, y: 89, r: 4 }, { k: 'circle', x: 13, y: 102, r: 4 }],
    water: [{ k: 'circle', x: 22, y: 52, r: 7 }],
    trees: [
      [-22, 20, 2.2, 7], [-24, 48, 2.4, 8], [-21, 74, 2.0, 6.5], [22, 18, 2.2, 7],
      [24, 80, 2.4, 7.5], [-12, 116, 2.2, 7], [10, 118, 2.4, 8],
    ],
  },
  // 1: an easy opening par 4, no water, an avenue of birches
  {
    name: 'Björkallén',
    par: 4,
    bounds: [-40, -18, 40, 206],
    tee: { x: 0, y: 0, a: UP },
    cup: [0, 172],
    line: [[0, 0], [2, 96], [0, 172]],
    fairway: [{ k: 'path', pts: [[0, 7], [2, 60], [3, 100], [1, 150]], w: 26 }],
    green: [{ k: 'circle', x: 0, y: 172, r: 11 }],
    sand: [
      { k: 'circle', x: -12.5, y: 166, r: 3.8 }, { k: 'circle', x: 12, y: 179, r: 3.8 },
      { k: 'circle', x: 17, y: 106, r: 4 },
    ],
    water: [],
    trees: [
      [-24, 28, 2.2, 7.5], [-25, 66, 2.4, 8], [-24, 108, 2.2, 7], [-23, 146, 2.3, 7.5],
      [26, 46, 2.3, 7.5], [27, 88, 2.2, 7], [25, 140, 2.4, 8],
      [-15, 195, 2.4, 8], [16, 198, 2.2, 7.5],
    ],
  },
  // 2: par 3 over a pond to a green on a spit of land
  {
    name: 'Udden',
    par: 3,
    bounds: [-38, -18, 36, 124],
    tee: { x: 0, y: 0, a: UP },
    cup: [5, 94],
    line: [[0, 0], [5, 94]],
    fairway: [{ k: 'path', pts: [[5, 66], [5, 82]], w: 20 }],
    green: [{ k: 'circle', x: 5, y: 94, r: 10.5 }],
    sand: [{ k: 'circle', x: 12, y: 106, r: 3.5 }, { k: 'circle', x: 17, y: 89, r: 3 }],
    water: [
      { k: 'rect', x: -3, y: 41, w: 34, h: 38, a: 0 },
      { k: 'circle', x: -12, y: 86, r: 11 },
    ],
    trees: [
      [-20, 10, 2.2, 7], [18, 12, 2.2, 7], [-28, 58, 2.4, 8], [24, 50, 2.2, 7],
      [-6, 116, 2.4, 8], [22, 112, 2.2, 7.5],
    ],
  },
  // 3: dogleg right round a pond; cutting the corner over the water is the gamble
  {
    name: 'Sjösvängen',
    par: 4,
    bounds: [-34, -18, 90, 198],
    tee: { x: 0, y: 0, a: UP },
    cup: [60, 170],
    line: [[0, 0], [0, 98], [60, 170]],
    fairway: [{ k: 'path', pts: [[0, 7], [0, 92], [46, 150]], w: 24 }],
    green: [{ k: 'circle', x: 60, y: 170, r: 11 }],
    sand: [
      { k: 'circle', x: 48, y: 178, r: 4.5 }, { k: 'circle', x: 70, y: 160, r: 4 },
      { k: 'circle', x: -14, y: 108, r: 4.5 },
    ],
    water: [{ k: 'circle', x: 25, y: 99, r: 13.5 }],
    trees: [
      [-20, 30, 2.2, 7], [-20, 62, 2.4, 8], [-24, 96, 2.2, 7], [-8, 132, 2.4, 7.5],
      [17, 45, 2.0, 6.5], [22, 150, 2.2, 7], [72, 190, 2.4, 8], [84, 172, 2.2, 7],
    ],
  },
  // 4: the long one: a creek to carry or lay up short of, a pond on the right
  {
    name: 'Långa gärdet',
    par: 5,
    bounds: [-58, -18, 46, 294],
    tee: { x: 0, y: 0, a: UP },
    cup: [-28, 262],
    line: [[0, 0], [0, 98], [0, 140], [-8, 196], [-28, 262]],
    fairway: [
      { k: 'path', pts: [[0, 7], [0, 145]], w: 26 },
      { k: 'path', pts: [[0, 165], [-6, 200], [-22, 250]], w: 24 },
    ],
    green: [{ k: 'circle', x: -28, y: 262, r: 11.5 }],
    sand: [
      { k: 'circle', x: -40, y: 255, r: 4 }, { k: 'circle', x: -16, y: 273, r: 4 },
      { k: 'circle', x: -19, y: 190, r: 4 },
    ],
    water: [
      { k: 'rect', x: 0, y: 155, w: 60, h: 8, a: 0.12 },
      { k: 'circle', x: 22, y: 205, r: 10 },
    ],
    trees: [
      [-22, 40, 2.2, 7.5], [22, 60, 2.4, 8], [-24, 110, 2.3, 7], [24, 120, 2.2, 7],
      [-30, 215, 2.4, 8], [-46, 278, 2.4, 8], [-10, 288, 2.2, 7],
    ],
  },
  // 5: a short par 3 ringed by bunkers
  {
    name: 'Sandlådan',
    par: 3,
    bounds: [-32, -18, 28, 106],
    tee: { x: 0, y: 0, a: UP },
    cup: [-3, 74],
    line: [[0, 0], [-3, 74]],
    fairway: [{ k: 'path', pts: [[0, 10], [-2, 60]], w: 20 }],
    green: [{ k: 'circle', x: -3, y: 74, r: 10 }],
    sand: [
      { k: 'circle', x: -12, y: 62, r: 4.5 }, { k: 'circle', x: 7, y: 61, r: 4.5 },
      { k: 'circle', x: -1, y: 87, r: 4 }, { k: 'circle', x: 9, y: 78, r: 3 },
    ],
    water: [],
    trees: [
      [-16, 20, 2.2, 7], [15, 26, 2.2, 7], [-22, 70, 2.4, 8], [20, 92, 2.4, 7.5], [-14, 96, 2.2, 7],
    ],
  },
];
