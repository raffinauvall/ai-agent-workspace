import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Point = [number, number, number];

// Original geometry traced from nox14's five bike references, not a stock motorcycle.
// Front is +X; +Z is the exhaust side. No textures/fonts/network needed on Android.
export function createCafeRacer(): THREE.Group {
  const bike = new THREE.Group();
  bike.name = "nox14-cafe-racer";
  bike.userData.tankLettering = "ペオト";
  const surface = (name: string, color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    m.name = name;
    return m;
  };
  const blue = surface("cobalt-paint", 0x073fc7, .23, .5);
  const frame = surface("black-frame", 0x14191f, .48, .35);
  const rubber = surface("tyres", 0x151518, .96);
  const leather = surface("ribbed-saddle", 0x24262a, .88);
  const chrome = surface("chrome", 0xc8d2dc, .23, .8);
  const spokes = chrome.clone(); spokes.name = "wire-spokes";
  const alloy = surface("engine-alloy", 0x9ca4aa, .45, .65);
  const white = surface("white-pinstripes-and-lettering", 0xeaf1f4, .48, .25);
  const brown = surface("brown-grips", 0x9d552b, .85);
  const bronze = surface("exhaust-header", 0x9f8d73, .27, .75);
  const glass = surface("headlamp-reflector", 0x455468, .28, .5);
  const red = surface("tail-light", 0xb52530, .4);
  const parts = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();

  function add(g: THREE.BufferGeometry, m: THREE.MeshStandardMaterial, pos: Point = [0, 0, 0], rot: Point = [0, 0, 0], scale: Point = [1, 1, 1]): void {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale));
    const transformed = g.index ? g.toNonIndexed() : g;
    if (transformed !== g) g.dispose();
    transformed.applyMatrix4(matrix);
    if (!transformed.hasAttribute("uv")) transformed.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(transformed.getAttribute("position").count * 2), 2));
    transformed.clearGroups();
    const list = parts.get(m) ?? []; list.push(transformed); parts.set(m, list);
  }
  const box = (size: Point, m: THREE.MeshStandardMaterial, pos: Point, rot: Point = [0, 0, 0]) => add(new THREE.BoxGeometry(...size), m, pos, rot);
  function tube(a: Point, b: Point, radius: number, m: THREE.MeshStandardMaterial, segments = 6): void {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), delta = to.clone().sub(from);
    const g = new THREE.CylinderGeometry(radius, radius, delta.length(), segments);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    add(g, m, from.add(to).multiplyScalar(.5).toArray() as Point);
  }
  function curve(points: Point[], radius: number, m: THREE.MeshStandardMaterial, segments = 18, radial = 6): void {
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), segments, radius, radial, false), m);
  }
  const ring = (radius: number, width: number, m: THREE.MeshStandardMaterial, pos: Point, rot: Point = [0, 0, 0], radial = 6) => add(new THREE.TorusGeometry(radius, width, radial, 32), m, pos, rot);
  function patch(vertices: number[], indices: number[], m: THREE.MeshStandardMaterial): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    g.setIndex(indices); g.computeVertexNormals(); add(g, m);
  }

  // Open wire wheels, narrow polished rims, road tyres and drilled brake discs.
  for (const wheelX of [-.9, .94]) {
    ring(.306, .073, rubber, [wheelX, .38, 0], [0, 0, 0], 6);
    tube([wheelX, .38, -.09], [wheelX, .38, .09], .06, chrome, 12);
    for (const side of [-1, 1]) {
      ring(.282, .021, chrome, [wheelX, .38, side * .054]);
      for (let i = 0; i < 16; i++) {
        const angle = i * Math.PI / 8 + (side === 1 ? Math.PI / 16 : 0);
        const hubAngle = angle + side * .45;
        tube([wheelX + Math.cos(hubAngle) * .048, .38 + Math.sin(hubAngle) * .048, side * .049],
          [wheelX + Math.cos(angle) * .275, .38 + Math.sin(angle) * .275, side * .025], .0036, spokes, 4);
      }
    }
    for (const side of [-.042, 0, .042]) ring(.375, .003, frame, [wheelX, .38, side], [0, 0, 0], 3);
    const rotor = new THREE.Shape(); rotor.absarc(0, 0, wheelX > 0 ? .235 : .19, 0, Math.PI * 2, false);
    const hubHole = new THREE.Path(); hubHole.absarc(0, 0, .061, 0, Math.PI * 2, true); rotor.holes.push(hubHole);
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const hole = new THREE.Path(); hole.absarc(Math.cos(a) * (wheelX > 0 ? .199 : .155), Math.sin(a) * (wheelX > 0 ? .199 : .155), .013, 0, Math.PI * 2, true);
      rotor.holes.push(hole);
    }
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5, inner = wheelX > 0 ? .117 : .092, outer = wheelX > 0 ? .177 : .132;
      const vent = new THREE.Path();
      vent.moveTo(Math.cos(angle - .12) * inner, Math.sin(angle - .12) * inner);
      vent.lineTo(Math.cos(angle - .22) * outer, Math.sin(angle - .22) * outer);
      vent.lineTo(Math.cos(angle + .24) * outer, Math.sin(angle + .24) * outer);
      vent.lineTo(Math.cos(angle + .12) * inner, Math.sin(angle + .12) * inner);
      vent.closePath(); rotor.holes.push(vent);
    }
    add(new THREE.ShapeGeometry(rotor, 4), alloy, [wheelX, .38, .094]);
    box([.07, .13, .055], frame, [wheelX - .17, .52, .116]);
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      tube([wheelX + Math.cos(a) * .097, .38 + Math.sin(a) * .097, .098],
        [wheelX + Math.cos(a) * .097, .38 + Math.sin(a) * .097, .105], .012, chrome);
    }
  }

  // Black double cradle around the exposed engine, and rear swingarm.
  for (const side of [-1, 1]) {
    const z = side * .115;
    for (const [a, b] of [
      [[-.61, 1.03, z], [.52, 1.10, z]], [[.52, 1.10, z], [.46, .89, z]],
      [[.46, .89, z], [.14, .30, z]], [[.14, .30, z], [-.46, .30, z]],
      [[-.46, .30, z], [-.61, 1.03, z]], [[-.61, 1.03, z], [-1.22, 1.04, z]],
      [[-.61, 1.03, z], [-.38, .49, z]], [[-.38, .49, z], [.13, .44, z]],
      [[-.38, .49, z], [-.90, .38, side * .15]],
    ] as [Point, Point][]) tube(a, b, .025, frame);
  }
  tube([-.9, .38, -.17], [-.9, .38, .17], .031, chrome);
  curve([[-.36, .45, -.15], [-.48, .55, -.15], [-.90, .47, -.15], [-1.01, .38, -.15], [-.90, .29, -.15], [-.36, .35, -.15]], .009, bronze, 28, 4);

  // Crankcase, single-cylinder cooling fins, head and visible fasteners.
  box([.38, .25, .28], alloy, [-.04, .47, 0]);
  add(new THREE.CylinderGeometry(.19, .19, .29, 20), alloy, [-.24, .55, 0], [Math.PI / 2, 0, 0]);
  add(new THREE.CylinderGeometry(.146, .146, .014, 20), chrome, [-.24, .55, .157], [Math.PI / 2, 0, 0]);
  add(new THREE.CylinderGeometry(.09, .09, .30, 14), alloy, [.035, .52, 0], [Math.PI / 2, 0, 0]);
  box([.22, .24, .19], frame, [.025, .76, 0], [0, 0, -.15]);
  for (let i = 0; i < 9; i++) box([.29, .019, .255], alloy, [.005 + i * .006, .64 + i * .033, 0], [0, 0, -.15]);
  box([.28, .075, .25], alloy, [.075, .96, 0], [0, 0, -.15]);
  for (const x of [-.09, .17]) for (const z of [-.13, .13]) tube([x, .63, z], [x + .05, .94, z], .009, chrome);
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI * 2 / 7;
    tube([-.24 + Math.cos(a) * .163, .55 + Math.sin(a) * .163, .145], [-.24 + Math.cos(a) * .163, .55 + Math.sin(a) * .163, .16], .013, chrome);
  }
  box([.14, .12, .15], alloy, [-.19, .89, 0]);
  curve([[.20, .88, .12], [.27, .98, .1], [.39, 1.05, .08]], .009, frame, 8, 4);

  // Long tapered tank, not the old ellipsoid with seat ribs painted on it.
  const sections = [
    [-.43, 1.06, .095, .085], [-.37, 1.075, .17, .22], [-.22, 1.09, .21, .255],
    [.11, 1.105, .215, .25], [.33, 1.11, .19, .21], [.42, 1.09, .10, .08],
  ]; // x, vertical centre, height radius, half width
  function tankPoint(section: number[], angle: number, offset = 0): Point {
    const [x, y, height, width] = section;
    return [x, y + Math.sin(angle) * (height + offset), Math.cos(angle) * (width + offset)];
  }
  const vertices: number[] = [], indices: number[] = [], segments = 24;
  for (const section of sections) for (let i = 0; i <= segments; i++) vertices.push(...tankPoint(section, i / segments * Math.PI * 2));
  for (let row = 0; row < sections.length - 1; row++) for (let i = 0; i < segments; i++) {
    const a = row * (segments + 1) + i, b = a + segments + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  for (const end of [0, sections.length - 1]) {
    const centre = vertices.length / 3; vertices.push(sections[end][0], sections[end][1], 0);
    for (let i = 0; i < segments; i++) {
      const a = end * (segments + 1) + i;
      indices.push(...(end === 0 ? [centre, a, a + 1] : [centre, a + 1, a]));
    }
  }
  patch(vertices, indices, blue);
  for (const side of [-1, 1]) for (const [a, b] of [[-.36, -.405], [-.46, -.65]]) {
    const v: number[] = [], idx: number[] = [];
    for (const section of sections) for (const theta of [a, b]) v.push(...tankPoint(section, side === 1 ? theta : Math.PI - theta, .003));
    for (let i = 0; i < sections.length - 1; i++) {
      const j = i * 2;
      idx.push(...(side === 1 ? [j, j + 1, j + 2, j + 1, j + 3, j + 2] : [j, j + 2, j + 1, j + 1, j + 2, j + 3]));
    }
    patch(v, idx, white);
  }
  add(new THREE.CylinderGeometry(.054, .054, .018, 16), chrome, [-.05, 1.32, 0]);

  // ペオト is hand-shaped geometry, so lettering is identical without CJK fonts.
  function letteringPoint(x: number, y: number, side: number): Point {
    const i = sections.findIndex(section => section[0] >= x);
    const a = sections[Math.max(0, i - 1)], b = sections[Math.max(0, i)];
    const t = (x - a[0]) / Math.max(b[0] - a[0], .001);
    const centre = THREE.MathUtils.lerp(a[1], b[1], t), height = THREE.MathUtils.lerp(a[2], b[2], t), width = THREE.MathUtils.lerp(a[3], b[3], t);
    return [x, y, side * (width * Math.sqrt(Math.max(0, 1 - ((y - centre) / height) ** 2)) + .006)];
  }
  for (const side of [-1, 1]) {
    const strokes = [
      [[0, .022], [.026, .056], [.063, .010]],
      [[.088, .048], [.149, .048]], [[.125, .074], [.125, .002], [.116, .002]], [[.126, .045], [.084, .004]],
      [[.178, .074], [.178, .003]], [[.178, .048], [.217, .032]],
    ];
    const origin = side === 1 ? .025 : .242;
    const sign = side === 1 ? 1 : -1;
    for (const stroke of strokes) {
      const path = stroke.map(([x, y]) => letteringPoint(origin + x * sign, 1.105 + y, side));
      for (let i = 1; i < path.length; i++) tube(path[i - 1], path[i], .0045, white, 4);
    }
    ring(.007, .0025, white, letteringPoint(origin + .065 * sign, 1.175, side), [0, 0, 0], 4);
  }

  // Striped side covers sit below the saddle on both sides, leaving the engine open.
  for (const side of [-1, 1]) {
    box([.43, .14, .025], blue, [-.47, .93, side * .125], [0, 0, -.07]);
    box([.43, .021, .026], white, [-.47, .877, side * .126], [0, 0, -.07]);
    box([.43, .007, .026], white, [-.47, .900, side * .126], [0, 0, -.07]);
  }
  const seatSections = [[-1.26, 1.105, .045, .065], [-1.21, 1.08, .048, .15], [-1.13, 1.067, .057, .177], [-.52, 1.062, .057, .172], [-.43, 1.059, .040, .10]];
  const seatV: number[] = [], seatIdx: number[] = [], seatSegments = 16;
  for (const section of seatSections) for (let i = 0; i <= seatSegments; i++) seatV.push(...tankPoint(section, i / seatSegments * Math.PI * 2));
  for (let row = 0; row < seatSections.length - 1; row++) for (let i = 0; i < seatSegments; i++) {
    const a = row * (seatSegments + 1) + i, b = a + seatSegments + 1;
    seatIdx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  for (const end of [0, seatSections.length - 1]) {
    const centre = seatV.length / 3; seatV.push(seatSections[end][0], seatSections[end][1], 0);
    for (let i = 0; i < seatSegments; i++) {
      const a = end * (seatSegments + 1) + i;
      seatIdx.push(...(end === 0 ? [centre, a, a + 1] : [centre, a + 1, a]));
    }
  }
  patch(seatV, seatIdx, leather);
  for (let i = 0; i < 13; i++) {
    const x = -1.23 + i * .058, index = seatSections.findIndex(s => s[0] >= x);
    const a = seatSections[index - 1], b = seatSections[index], t = (x - a[0]) / (b[0] - a[0]);
    const section = a.map((v, j) => THREE.MathUtils.lerp(v, b[j], t));
    const seam: Point[] = [];
    for (let j = 0; j <= 10; j++) seam.push(tankPoint(section, Math.PI * j / 10, .002));
    curve(seam, .003, frame, 10, 4);
  }
  box([.06, .04, .20], red, [-1.26, 1.045, 0]);

  // Rear twin coil shocks and the longer raked telescopic fork from the photos.
  tube([.58, 1.18, -.16], [.58, 1.18, .16], .041, alloy);
  for (const side of [-1, 1]) {
    const a = new THREE.Vector3(-.77, 1.02, side * .19), b = new THREE.Vector3(-.91, .45, side * .19);
    const axis = a.clone().sub(b), rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
    tube(a.toArray() as Point, b.toArray() as Point, .021, chrome);
    tube([-.77, 1.02, side * .19], [-.80, .89, side * .19], .048, chrome, 10);
    const coil: Point[] = [];
    for (let i = 0; i <= 72; i++) {
      const t = i / 72, angle = t * Math.PI * 2 * 8;
      const p = new THREE.Vector3(Math.cos(angle) * .047, .11 + t * .34, Math.sin(angle) * .047).applyQuaternion(rotation).add(b);
      coil.push(p.toArray() as Point);
    }
    curve(coil, .007, chrome, 64, 4);
    tube([.58, 1.25, side * .10], [.94, .38, side * .10], .029, chrome, 10);
    tube([.80, .74, side * .10], [.96, .36, side * .10], .047, alloy, 10);
    // Low clip-ons, brown grips, silver levers and black control housings.
    tube([.57, 1.20, side * .09], [.52, 1.22, side * .23], .014, chrome);
    tube([.52, 1.22, side * .23], [.43, 1.19, side * .41], .025, brown, 10);
    const gripA = new THREE.Vector3(.52, 1.22, side * .23), gripB = new THREE.Vector3(.43, 1.19, side * .41);
    const gripAxis = gripB.clone().sub(gripA).normalize();
    for (let i = 1; i < 6; i++) {
      const rib = new THREE.TorusGeometry(.025, .0015, 3, 8);
      rib.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), gripAxis));
      add(rib, brown, gripA.clone().lerp(gripB, i / 6).toArray() as Point);
    }
    box([.055, .06, .055], frame, [.53, 1.22, side * .22]);
    curve([[.53, 1.215, side * .22], [.60, 1.19, side * .26], [.55, 1.17, side * .40]], .009, chrome, 8);
    tube([-.37, .49, side * .15], [-.37, .49, side * .30], .018, rubber, 8);
    const bracket = new THREE.Shape(); bracket.moveTo(-.45, .50); bracket.lineTo(-.55, .68); bracket.lineTo(-.31, .56); bracket.closePath();
    const cutout = new THREE.Path(); cutout.moveTo(-.45, .545); cutout.lineTo(-.49, .615); cutout.lineTo(-.38, .563); cutout.closePath(); bracket.holes.push(cutout);
    add(new THREE.ExtrudeGeometry(bracket, {depth: .014, bevelEnabled: false}), alloy, [0, 0, side * .19 - .007]);
    curve([[.55, 1.16, side * .13], [.58, .93, side * .15], [.76, .62, side * .15]], .005, frame, 12, 4);
  }
  // Small front and rear fenders follow the wheel instead of square blocks.
  for (const wheelX of [-.9, .94]) {
    const v: number[] = [], idx: number[] = [];
    for (let i = 0; i <= 16; i++) {
      const angle = Math.PI * (.17 + i / 16 * .66);
      for (const side of [-1, 1]) v.push(wheelX + Math.cos(angle) * .406, .38 + Math.sin(angle) * .406, side * .074);
    }
    for (let i = 0; i < 16; i++) { const j = i * 2; idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
    patch(v, idx, frame);
  }

  add(new THREE.SphereGeometry(.168, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), chrome, [.883, 1.125, 0], [0, 0, Math.PI / 2]);
  ring(.17, .014, chrome, [.883, 1.125, 0], [0, Math.PI / 2, 0]);
  add(new THREE.CircleGeometry(.154, 24), glass, [.886, 1.125, 0], [0, Math.PI / 2, 0]);
  box([.008, .015, .21], white, [.891, 1.124, 0]);
  box([.008, .025, .045], white, [.891, 1.185, 0]);
  for (const y of [1.065, 1.184]) {
    ring(.039, .006, chrome, [.891, y, 0], [0, Math.PI / 2, 0]);
    add(new THREE.CircleGeometry(.032, 12), glass, [.892, y, 0], [0, Math.PI / 2, 0]);
  }
  for (const side of [-1, 1]) tube([.60, 1.06, side * .105], [.81, 1.12, side * .13], .016, chrome);
  add(new THREE.CylinderGeometry(.043, .043, .035, 12), frame, [.55, 1.26, 0]);

  curve([[.19, .85, .14], [.38, .67, .20], [.39, .36, .21], [.19, .26, .22], [-.50, .27, .23], [-.74, .41, .23]], .029, bronze, 30, 8);
  tube([-.68, .37, .23], [-1.16, .63, .23], .065, chrome, 14);
  tube([-1.16, .63, .23], [-1.20, .65, .23], .047, frame, 12);
  tube([-.9, .49, .22], [-.80, .73, .19], .012, alloy);
  // A real side stand contacts the floor; the bike is not floating in the garage.
  tube([-.36, .33, -.13], [-.47, .015, -.27], .016, frame);
  box([.07, .02, .06], frame, [-.47, .01, -.27]);

  // ponytail: one static batch per finish, not hundreds of per-spoke draw calls.
  for (const [m, geometries] of parts) {
    const geometry = mergeGeometries(geometries);
    geometries.forEach(g => g.dispose());
    if (!geometry) throw new Error(`Cannot merge motorcycle finish: ${m.name}`);
    const mesh = new THREE.Mesh(geometry, m); mesh.name = m.name;
    mesh.castShadow = true; mesh.receiveShadow = true; bike.add(mesh);
  }
  return bike;
}
