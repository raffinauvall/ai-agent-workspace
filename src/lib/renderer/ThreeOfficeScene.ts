import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentState, Status } from "$lib/types/agent";
import {
  TAURI_EVENTS,
  type AgentFoundPayload,
  type AgentLostPayload,
  type AgentStateChangedPayload,
} from "$lib/types/events";

const WORK_STATUSES: ReadonlySet<Status> = new Set(["thinking", "responding", "tool_use"]);
const ACTIVE_STATUSES: ReadonlySet<Status> = new Set([
  "thinking",
  "responding",
  "tool_use",
  "collaboration",
]);

const STATUS_COLORS: Record<Status, number> = {
  idle: 0x94a3b8,
  walking_to_desk: 0x38bdf8,
  thinking: 0xf59e0b,
  responding: 0x22c55e,
  tool_use: 0xa855f7,
  collaboration: 0x06b6d4,
  task_complete: 0x34d399,
  error: 0xef4444,
  offline: 0x64748b,
};

const STATUS_LABELS: Record<Status, string> = {
  idle: "Idle",
  walking_to_desk: "Moving",
  thinking: "Thinking",
  responding: "Typing",
  tool_use: "Using tool",
  collaboration: "Collaborating",
  task_complete: "Task complete",
  error: "Error",
  offline: "Offline",
};

const TIER_COLORS: Record<AgentState["tier"], number> = {
  expert: 0xfbbf24,
  senior: 0x60a5fa,
  middle: 0x34d399,
  junior: 0xf472b6,
};

const DESK_POSITIONS = [
  new THREE.Vector3(-6.3, 0, -3.2),
  new THREE.Vector3(-2.1, 0, -3.2),
  new THREE.Vector3(2.1, 0, -3.2),
  new THREE.Vector3(-6.3, 0, 0.1),
  new THREE.Vector3(-2.1, 0, 0.1),
  new THREE.Vector3(2.1, 0, 0.1),
];

const IDLE_POSITIONS = [
  new THREE.Vector3(-6.25, 0, 4.25),
  new THREE.Vector3(-7.0, 0, 1.7),
  new THREE.Vector3(-7.0, 0, -1.8),
  new THREE.Vector3(-4.3, 0, 1.8),
  new THREE.Vector3(-1.5, 0, 1.9),
  new THREE.Vector3(1.2, 0, 1.9),
  new THREE.Vector3(3.7, 0, 1.9),
  new THREE.Vector3(6.0, 0, 2.1),
  new THREE.Vector3(5.35, 0, 5.25),
  new THREE.Vector3(4.25, 0, 4.85),
  new THREE.Vector3(2.7, 0, 4.5),
  new THREE.Vector3(0.2, 0, 3.7),
  new THREE.Vector3(-2.3, 0, 3.7),
  new THREE.Vector3(-4.8, 0, 3.7),
];

const IDLE_ACTIVITIES = [
  "Making coffee",
  "Walking around",
  "Stretching",
  "Getting water",
  "Taking a short break",
  "Checking messages",
  "Reading docs",
  "Heading to the garage",
  "Fixing a motorcycle",
  "Taking a smoke break",
  "Checking the screen",
  "Browsing the shelf",
  "Taking a break on the sofa",
  "Getting water",
];

interface AgentVisual {
  state: AgentState;
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  visor: THREE.Mesh;
  antenna: THREE.Mesh;
  antennaLight: THREE.Mesh;
  ring: THREE.Mesh;
  label: THREE.Sprite;
  monitor: THREE.Mesh;
  arms: [THREE.Mesh, THREE.Mesh];
  legs: [THREE.Mesh, THREE.Mesh];
  feet: [THREE.Mesh, THREE.Mesh];
  wrench: THREE.Mesh;
  cigarette: THREE.Mesh;
  smoke: [THREE.Mesh, THREE.Mesh];
  target: THREE.Vector3;
  idleActivity: string;
  idleTargetIndex: number;
  nextIdleMove: number;
  phase: number;
  selected: boolean;
}

function material(color: number, roughness = 0.75): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
}

function dampAngle(current: number, target: number, lambda: number, delta: number): number {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + THREE.MathUtils.damp(0, difference, lambda, delta);
}

function box(
  size: [number, number, number],
  color: number,
  position: [number, number, number],
  parent: THREE.Object3D,
): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addPlant(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.45, 8), material(0x9a6243));
  pot.position.y = 0.23;
  pot.castShadow = true;
  group.add(pot);
  for (let i = 0; i < 5; i += 1) {
    const leaf = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.08, 0.55, 3, 6),
      material(i % 2 === 0 ? 0x2d8a62 : 0x3da56e),
    );
    leaf.position.set(Math.cos(i * 1.25) * 0.13, 0.72, Math.sin(i * 1.25) * 0.13);
    leaf.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.38;
    leaf.rotation.x = (i - 2) * 0.1;
    leaf.castShadow = true;
    group.add(leaf);
  }
}

function addLamp(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  box([0.16, 1.8, 0.16], 0x3d3030, [0, 0.9, 0], group);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.08, 8), material(0x3d3030));
  base.position.y = 0.04;
  base.castShadow = true;
  group.add(base);
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.46, 0.42, 8, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xe4a45f, emissive: 0x8b4a1e, emissiveIntensity: 0.55, side: THREE.DoubleSide }),
  );
  shade.position.y = 1.92;
  shade.rotation.x = Math.PI;
  shade.castShadow = true;
  group.add(shade);
  const bulb = new THREE.PointLight(0xffb86b, 7, 7, 2);
  bulb.position.y = 1.7;
  group.add(bulb);
}

function addWindow(parent: THREE.Object3D, x: number, y: number, z: number, width: number): void {
  const glass = box([width, 1.5, 0.04], 0x173b68, [x, y, z], parent);
  glass.material.roughness = 0.15;
  glass.material.metalness = 0.3;
  for (const offset of [-width / 4, 0, width / 4]) {
    box([0.035, 1.5, 0.08], 0x9aa6b7, [x + offset, y, z - 0.03], parent);
  }
  box([width, 0.035, 0.08], 0x9aa6b7, [x, y, z - 0.03], parent);
}

function addDesk(parent: THREE.Object3D, position: THREE.Vector3): void {
  const group = new THREE.Group();
  group.position.copy(position);
  parent.add(group);
  box([1.65, 0.12, 0.85], 0x70452d, [0, 1.0, 0], group);
  box([0.08, 1.0, 0.08], 0x3e2a22, [-0.67, 0.5, -0.28], group);
  box([0.08, 1.0, 0.08], 0x3e2a22, [0.67, 0.5, -0.28], group);
  box([0.08, 1.0, 0.08], 0x3e2a22, [-0.67, 0.5, 0.28], group);
  box([0.08, 1.0, 0.08], 0x3e2a22, [0.67, 0.5, 0.28], group);
  box([0.72, 0.52, 0.06], 0x192536, [0, 1.32, -0.18], group);
  box([0.6, 0.38, 0.025], 0x2e8bc6, [0, 1.32, -0.215], group);
  box([0.25, 0.035, 0.38], 0xe4d6b5, [0, 1.09, 0.18], group);
  box([0.7, 0.08, 0.42], 0x46342c, [0, 0.52, 0.2], group);
  const chair = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.62), material(0x26364b));
  chair.position.set(0, 0.55, 0.93);
  chair.castShadow = true;
  group.add(chair);
  box([0.08, 0.65, 0.08], 0x35465c, [0, 0.25, 0.93], group);
}

function addMeetingArea(parent: THREE.Object3D): void {
  const rug = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.04, 3.7), material(0xd8d0bd));
  rug.position.set(5.2, 0.03, 2.35);
  rug.receiveShadow = true;
  parent.add(rug);
  const table = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.18, 1.6), material(0x75482f));
  table.position.set(5.2, 0.82, 2.35);
  table.castShadow = true;
  parent.add(table);
  for (const x of [4.0, 6.4]) {
    box([0.12, 0.8, 0.12], 0x3f2922, [x, 0.4, 1.9], parent);
    box([0.12, 0.8, 0.12], 0x3f2922, [x, 0.4, 2.8], parent);
  }
  for (const [x, z] of [[5.2, 1.0], [5.2, 3.7], [3.35, 2.35], [7.05, 2.35]]) {
    const chair = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.12, 0.62), material(0x26364b));
    chair.position.set(x, 0.55, z);
    chair.castShadow = true;
    parent.add(chair);
  }
}

function addCoffeeStation(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  box([1.65, 0.78, 0.58], 0x68412f, [0, 0.39, 0], group);
  box([0.38, 0.55, 0.34], 0x1b2c42, [-0.35, 1.05, -0.02], group);
  box([0.26, 0.08, 0.24], 0x38bdf8, [-0.35, 1.16, -0.2], group);
  for (const cupX of [0.2, 0.48]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.14, 8), material(0xe8dfcf));
    cup.position.set(cupX, 0.88, -0.17);
    cup.castShadow = true;
    group.add(cup);
  }
  const steam = new THREE.Mesh(
    new THREE.TorusGeometry(0.07, 0.018, 5, 10, Math.PI),
    new THREE.MeshBasicMaterial({ color: 0xd8e8f3, transparent: true, opacity: 0.55 }),
  );
  steam.position.set(0.34, 1.1, -0.17);
  steam.rotation.x = Math.PI / 2;
  group.add(steam);
}

function addWaterCooler(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.72, 8), material(0xe5e7eb));
  base.position.y = 0.36;
  base.castShadow = true;
  group.add(base);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.58, 8), material(0x83c5fd, 0.2));
  tank.position.y = 1.0;
  tank.castShadow = true;
  group.add(tank);
  box([0.38, 0.04, 0.16], 0x1e293b, [0, 0.75, -0.22], group);
}

function addSofa(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  box([1.6, 0.5, 0.72], 0x4c5b78, [0, 0.35, 0], group);
  box([1.6, 0.75, 0.18], 0x3b4964, [0, 0.75, 0.27], group);
  box([0.18, 0.48, 0.72], 0x3b4964, [-0.72, 0.45, 0], group);
  box([0.18, 0.48, 0.72], 0x3b4964, [0.72, 0.45, 0], group);
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.08, 8), material(0x70452d));
  table.position.set(0, 0.7, -0.72);
  table.castShadow = true;
  group.add(table);
}

function addBookshelf(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  box([1.35, 2.0, 0.35], 0x79513b, [0, 1.0, 0], group);
  for (const y of [0.45, 0.95, 1.45]) {
    box([1.08, 0.08, 0.4], 0x3e2a22, [0, y, -0.22], group);
    for (let i = 0; i < 4; i += 1) {
      box([0.12, 0.28 + (i % 2) * 0.08, 0.08], [0x38bdf8, 0xf59e0b, 0xa855f7, 0x34d399][i], [-0.38 + i * 0.25, y + 0.17, -0.22], group);
    }
  }
}

function addWhiteboard(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  box([1.5, 1.25, 0.08], 0x26364b, [0, 1.2, 0], group);
  const screen = box([1.28, 1.02, 0.025], 0x071525, [0, 1.2, 0.055], group);
  screen.material.emissive = new THREE.Color(0x061d3a);
  screen.material.emissiveIntensity = 0.8;
  box([0.2, 0.045, 0.025], 0x38bdf8, [-0.48, 1.57, 0.075], group);
  for (const [y, width, color] of [
    [1.4, 0.76, 0x38bdf8],
    [1.22, 0.58, 0xf59e0b],
    [1.04, 0.92, 0x34d399],
    [0.86, 0.5, 0xa855f7],
  ] as const) {
    box([width, 0.045, 0.025], color, [-0.63 + width / 2, y, 0.075], group);
  }
  box([0.08, 0.9, 0.08], 0x425466, [-0.55, 0.45, 0], group);
  box([0.08, 0.9, 0.08], 0x425466, [0.55, 0.45, 0], group);
}

function addSmokingCorner(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  box([0.72, 0.08, 0.5], 0x75482f, [0, 0.7, 0], group);
  const ashtray = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.08, 8), material(0x64748b));
  ashtray.position.y = 0.78;
  ashtray.castShadow = true;
  group.add(ashtray);
  box([0.08, 0.7, 0.08], 0x475569, [0, 0.35, 0], group);
  const sign = box([0.75, 0.42, 0.06], 0x26364b, [0, 1.55, 0], group);
  sign.material.emissive = new THREE.Color(0x102a43);
  sign.material.emissiveIntensity = 0.6;
}

function addCafeRacer(parent: THREE.Object3D, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  parent.add(group);
  const blue = new THREE.MeshStandardMaterial({ color: 0x1677c8, roughness: 0.28, metalness: 0.45 });
  const dark = material(0x111827, 0.35);
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.2, metalness: 0.85 });
  for (const wheelX of [-0.72, 0.72]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 12), dark);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(wheelX, 0.36, 0);
    wheel.castShadow = true;
    group.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 10), chrome);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(wheelX, 0.36, 0);
    group.add(hub);
  }
  box([1.5, 0.08, 0.08], 0x334155, [0, 0.58, 0], group);
  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 6), blue);
  tank.scale.set(1.25, 0.58, 0.85);
  tank.position.set(-0.05, 0.78, 0);
  tank.castShadow = true;
  group.add(tank);
  for (let ribX = -0.52; ribX <= 0.12; ribX += 0.13) {
    box([0.035, 0.035, 0.34], 0x334155, [ribX, 0.88, 0], group);
  }
  const badgeCanvas = document.createElement("canvas");
  badgeCanvas.width = 320;
  badgeCanvas.height = 96;
  const badgeContext = badgeCanvas.getContext("2d");
  if (badgeContext !== null) {
    badgeContext.strokeStyle = "#e5e7eb";
    badgeContext.lineWidth = 7;
    badgeContext.beginPath();
    badgeContext.moveTo(18, 25);
    badgeContext.lineTo(300, 25);
    badgeContext.moveTo(18, 34);
    badgeContext.lineTo(300, 34);
    badgeContext.stroke();
    badgeContext.fillStyle = "#f8fafc";
    badgeContext.font = "bold 34px sans-serif";
    badgeContext.fillText("ペット", 112, 78);
  }
  const badge = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.21),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(badgeCanvas), transparent: true, side: THREE.DoubleSide }),
  );
  badge.position.set(-0.05, 0.79, 0.3);
  group.add(badge);
  box([0.48, 0.12, 0.34], 0x0f172a, [-0.45, 0.78, 0], group);
  box([0.38, 0.1, 0.12], 0xdbeafe, [0.7, 0.86, 0], group);
  const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.62, 6), chrome);
  handlebar.rotation.z = Math.PI / 2;
  handlebar.position.set(0.7, 1.03, 0);
  group.add(handlebar);
  box([0.12, 0.4, 0.12], 0x475569, [0.72, 0.7, 0], group);
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.75, 8), chrome);
  exhaust.rotation.z = Math.PI / 2;
  exhaust.position.set(-0.2, 0.38, 0.28);
  group.add(exhaust);
}

function addGarage(parent: THREE.Object3D): void {
  const group = new THREE.Group();
  group.position.set(6.35, 0, 4.65);
  parent.add(group);
  box([4.8, 0.06, 3.4], 0x64748b, [0, 0.05, 0], group);
  box([4.8, 2.8, 0.12], 0x334155, [0, 1.4, -1.65], group);
  // The office is on the left side of the garage in the isometric view.
  box([0.12, 2.8, 0.8], 0x334155, [-2.35, 1.4, -1.3], group);
  box([0.12, 2.8, 0.8], 0x334155, [-2.35, 1.4, 1.3], group);
  box([0.12, 0.55, 1.8], 0x334155, [-2.35, 2.52, 0], group);
  box([0.12, 2.8, 3.4], 0x334155, [2.35, 1.4, 0], group);
  box([1.7, 0.9, 0.5], 0x75482f, [1.35, 0.48, -0.8], group);
  box([1.75, 0.95, 0.08], 0x172236, [1.35, 1.15, -0.58], group);
  addCafeRacer(group, -0.35, 0.25);
}

function addIdleStations(parent: THREE.Object3D): void {
  addCoffeeStation(parent, -7.1, 3.7);
  addWaterCooler(parent, -4.8, 3.7);
  addSofa(parent, -2.3, 3.7);
  addBookshelf(parent, 0.2, 3.7);
  addWhiteboard(parent, 2.7, 4.5);
  addSmokingCorner(parent, 4.25, 4.85);
  addGarage(parent);
}

function labelActivity(state: AgentState, activity: string): string {
  return state.status === "idle" ? activity : STATUS_LABELS[state.status];
}

function makeLabel(state: AgentState, activity: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas 2D context unavailable");
  const color = `#${STATUS_COLORS[state.status].toString(16).padStart(6, "0")}`;
  context.fillStyle = "rgba(9, 16, 30, 0.94)";
  context.beginPath();
  context.roundRect(8, 8, 1008, 176, 30);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(24, 36, 24, 120, 10);
  context.fill();
  context.fillStyle = "#f8fafc";
  context.font = "bold 54px system-ui, sans-serif";
  context.fillText(state.name.slice(0, 20), 76, 84);
  context.fillStyle = "#b7c4d8";
  context.font = "44px system-ui, sans-serif";
  context.fillText(labelActivity(state, activity), 76, 144);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  );
  sprite.scale.set(2.6, 0.49, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function refreshLabel(label: THREE.Sprite, state: AgentState, activity: string): void {
  const texture = label.material instanceof THREE.SpriteMaterial ? label.material.map : null;
  const canvas = texture?.image as HTMLCanvasElement | undefined;
  const context = canvas?.getContext("2d");
  if (canvas === undefined || context === undefined || context === null || texture === null) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const color = `#${STATUS_COLORS[state.status].toString(16).padStart(6, "0")}`;
  context.fillStyle = "rgba(9, 16, 30, 0.94)";
  context.beginPath();
  context.roundRect(8, 8, 1008, 176, 30);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(24, 36, 24, 120, 10);
  context.fill();
  context.fillStyle = "#f8fafc";
  context.font = "bold 54px system-ui, sans-serif";
  context.fillText(state.name.slice(0, 20), 76, 84);
  context.fillStyle = "#b7c4d8";
  context.font = "44px system-ui, sans-serif";
  context.fillText(labelActivity(state, activity), 76, 144);
  texture.needsUpdate = true;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.map?.dispose();
        material.dispose();
      }
    }
  });
}

export class ThreeOfficeScene {
  private container: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private controls: OrbitControls | null = null;
  private scene: THREE.Scene | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame = 0;
  private readonly clock = new THREE.Clock();
  private readonly agents = new Map<string, AgentVisual>();
  private readonly unlisteners: UnlistenFn[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private selectedAgentId: string | null = null;
  private world: THREE.Group | null = null;

  async init(container: HTMLElement): Promise<void> {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1728);
    this.scene.fog = new THREE.Fog(0x0d1728, 24, 36);

    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1);
    this.camera = new THREE.OrthographicCamera(-10 * aspect, 10 * aspect, 10, -10, 0.1, 100);
    this.camera.position.set(15, 13, 15);
    this.camera.lookAt(0, 0, 0);
    this.camera.zoom = 1.05;
    this.camera.updateProjectionMatrix();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.replaceChildren(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minZoom = 0.7;
    this.controls.maxZoom = 2.4;
    this.controls.minPolarAngle = 0.55;
    this.controls.maxPolarAngle = 1.25;
    this.controls.update();

    this.addLights();
    this.buildOffice();
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    try {
      await this.subscribeToEvents();
    } catch {
      // Browser preview has no Tauri event bus; the store fallback still works.
    }
    await this.loadExistingAgents();
    this.animate();
  }

  destroy(): void {
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners.length = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.animationFrame);
    this.renderer?.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls?.dispose();
    if (this.scene !== null) disposeObject(this.scene);
    this.agents.clear();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.camera = null;
    this.controls = null;
    this.scene = null;
    this.world = null;
    this.container = null;
    this.selectedAgentId = null;
  }

  selectAgent(id: string | null): void {
    if (this.selectedAgentId !== null) {
      const previous = this.agents.get(this.selectedAgentId);
      if (previous !== undefined) {
        previous.selected = false;
        previous.ring.scale.setScalar(1);
      }
    }
    this.selectedAgentId = id;
    const selected = id === null ? undefined : this.agents.get(id);
    if (selected !== undefined) {
      selected.selected = true;
      selected.ring.scale.setScalar(1.35);
    }
  }

  private addLights(): void {
    if (this.scene === null) return;
    this.scene.add(new THREE.HemisphereLight(0xa9c7ff, 0x3b271e, 2.2));
    const key = new THREE.DirectionalLight(0xffe6c2, 3.2);
    key.position.set(-5, 14, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    this.scene.add(key);
    const lamp = new THREE.PointLight(0xffb86b, 14, 12, 2);
    lamp.position.set(3, 4, -1);
    this.scene.add(lamp);
  }

  private buildOffice(): void {
    if (this.scene === null) return;
    const world = new THREE.Group();
    this.world = world;
    this.scene.add(world);

    box([18.4, 0.3, 12.4], 0x182235, [0, -0.25, 0], world);
    box([18, 0.08, 12], 0x9b6746, [0, -0.04, 0], world);
    box([18, 3.8, 0.25], 0x6f7480, [0, 1.8, -6], world);
    box([0.25, 3.8, 12], 0x6f7480, [-9, 1.8, 0], world);
    box([18, 0.18, 0.35], 0x3c4350, [0, 3.65, -5.82], world);
    addWindow(world, -5.8, 2.1, -5.84, 4.4);
    addWindow(world, -0.2, 2.1, -5.84, 4.4);
    addWindow(world, 5.4, 2.1, -5.84, 4.4);

    for (const position of DESK_POSITIONS) addDesk(world, position);
    addMeetingArea(world);
    addIdleStations(world);
    addPlant(world, -8.0, -4.9);
    addPlant(world, -8.0, 4.4);
    addPlant(world, 8.0, -4.9);
    addPlant(world, 8.0, 5.0);
    addLamp(world, -6.8, -4.8);
    addLamp(world, 6.8, -4.8);
    this.addWallDisplay(world);
  }

  private addWallDisplay(parent: THREE.Object3D): void {
    box([0.16, 2.5, 4.4], 0x222b3b, [8.65, 1.9, -1.0], parent);
    const screen = box([0.05, 1.85, 3.7], 0x173b75, [8.55, 1.9, -1.0], parent);
    screen.material.emissive = new THREE.Color(0x0b2e65);
    screen.material.emissiveIntensity = 0.9;
    for (let i = 0; i < 4; i += 1) {
      const bar = box([0.025, 0.14, 0.62], [0x37b7ff, 0xffca5c, 0x64df9a, 0xeb6b9e][i], [8.5, 2.45 - i * 0.35, -1.0], parent);
      bar.material.emissive = new THREE.Color(bar.material.color.getHex());
      bar.material.emissiveIntensity = 0.7;
    }
  }

  private async subscribeToEvents(): Promise<void> {
    this.unlisteners.push(
      await listen<AgentFoundPayload>(TAURI_EVENTS.AGENT_FOUND, (event) => this.upsertAgent(event.payload.agent)),
    );
    this.unlisteners.push(
      await listen<AgentLostPayload>(TAURI_EVENTS.AGENT_LOST, (event) => this.removeAgent(event.payload.id)),
    );
    this.unlisteners.push(
      await listen<AgentStateChangedPayload>(TAURI_EVENTS.AGENT_STATE_CHANGED, (event) => this.upsertAgent(event.payload.agent)),
    );
  }

  private async loadExistingAgents(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const agents = await invoke<AgentState[]>("get_all_agents");
      agents.forEach((agent) => this.upsertAgent(agent));
    } catch {
      try {
        const { getAllAgents } = await import("$lib/stores/agents.svelte");
        getAllAgents().forEach((agent) => this.upsertAgent(agent));
      } catch {
        // No backend in the browser preview.
      }
    }
  }

  private upsertAgent(state: AgentState): void {
    const existing = this.agents.get(state.id);
    if (existing !== undefined) {
      const statusChanged = existing.state.status !== state.status;
      existing.state = state;
      if (statusChanged || state.status !== "idle") {
        existing.target.copy(this.positionFor(state));
      }
      if (statusChanged && state.status === "idle") {
        existing.idleTargetIndex = this.agents.size % IDLE_POSITIONS.length;
        existing.nextIdleMove = 5 + Math.random() * 4;
      }
      refreshLabel(existing.label, state, existing.idleActivity);
      const monitorMaterial = existing.monitor.material as THREE.MeshStandardMaterial;
      monitorMaterial.color.setHex(STATUS_COLORS[state.status]);
      monitorMaterial.emissive.setHex(STATUS_COLORS[state.status]);
      const previousMaterial = existing.ring.material as THREE.Material;
      existing.ring.material = new THREE.MeshBasicMaterial({
        color: STATUS_COLORS[state.status],
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
      });
      previousMaterial.dispose();
      return;
    }

    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.34, 0.5, 6), material(0x172236));
    body.position.y = 0.68;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.29, 1), material(0x0d1626, 0.5));
    head.position.y = 1.38;
    head.castShadow = true;
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0b5e98,
      emissiveIntensity: 1.8,
      metalness: 0.35,
      roughness: 0.25,
    });
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.39, 0.13, 0.035), visorMaterial);
    // The desk is on the -Z side of the chair, so the bot's face points toward it.
    visor.position.set(0, 1.39, -0.25);
    visor.castShadow = true;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 6), material(0x50627a));
    antenna.position.set(0, 1.72, 0);
    const antennaLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.065, 8, 6),
      new THREE.MeshStandardMaterial({ color: TIER_COLORS[state.tier], emissive: TIER_COLORS[state.tier], emissiveIntensity: 1.6 }),
    );
    antennaLight.position.set(0, 1.84, 0);
    const arms: [THREE.Mesh, THREE.Mesh] = [
      new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.24, 3, 6), material(0x2d4058)),
      new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.24, 3, 6), material(0x2d4058)),
    ];
    const legs: [THREE.Mesh, THREE.Mesh] = [
      new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.22, 3, 6), material(0x172236)),
      new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.22, 3, 6), material(0x172236)),
    ];
    const feet: [THREE.Mesh, THREE.Mesh] = [
      new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.25), material(0x0f172a)),
      new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.25), material(0x0f172a)),
    ];
    legs[0].position.set(-0.13, 0.25, 0);
    legs[1].position.set(0.13, 0.25, 0);
    feet[0].position.set(-0.13, 0.1, -0.08);
    feet[1].position.set(0.13, 0.1, -0.08);
    arms[0].position.set(-0.36, 0.78, 0.02);
    arms[1].position.set(0.36, 0.78, 0.02);
    arms[0].rotation.z = -0.32;
    arms[1].rotation.z = 0.32;
    for (const arm of arms) {
      arm.castShadow = true;
      group.add(arm);
    }
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.43, 24),
      new THREE.MeshBasicMaterial({ color: STATUS_COLORS[state.status], transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    const monitor = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.13, 0.035),
      new THREE.MeshStandardMaterial({
        color: STATUS_COLORS[state.status],
        emissive: STATUS_COLORS[state.status],
        emissiveIntensity: 1.5,
        metalness: 0.2,
        roughness: 0.3,
      }),
    );
    monitor.position.set(0, 0.77, 0.31);
    const wrench = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.035), new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.8, roughness: 0.2 }));
    wrench.visible = false;
    const cigarette = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, 0.26, 6),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xf97316, emissiveIntensity: 0.8 }),
    );
    cigarette.visible = false;
    const smoke: [THREE.Mesh, THREE.Mesh] = [
      new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.72 })),
      new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.58 })),
    ];
    wrench.visible = false;
    cigarette.visible = false;
    smoke.forEach((particle) => {
      particle.visible = false;
      group.add(particle);
    });
    group.add(ring, body, head, visor, antenna, antennaLight, monitor, wrench, cigarette, ...legs, ...feet);
    const idleActivity = IDLE_ACTIVITIES[this.agents.size % IDLE_ACTIVITIES.length];
    const label = makeLabel(state, idleActivity);
    label.position.y = 1.98;
    group.add(label);
    group.position.copy(this.positionFor(state));
    group.userData.agentId = state.id;
    body.userData.agentId = state.id;
    head.userData.agentId = state.id;
    this.world?.add(group);
    this.agents.set(state.id, {
      state,
      group,
      body,
      head,
      visor,
      antenna,
      antennaLight,
      ring,
      label,
      monitor,
      arms,
      legs,
      feet,
      wrench,
      cigarette,
      smoke,
      target: this.positionFor(state),
      idleActivity,
      idleTargetIndex: this.agents.size % IDLE_POSITIONS.length,
      nextIdleMove: 5 + Math.random() * 4,
      phase: Math.random() * Math.PI * 2,
      selected: false,
    });
  }

  private removeAgent(id: string): void {
    const visual = this.agents.get(id);
    if (visual === undefined) return;
    this.world?.remove(visual.group);
    disposeObject(visual.group);
    this.agents.delete(id);
    if (this.selectedAgentId === id) this.selectAgent(null);
  }

  private positionFor(state: AgentState): THREE.Vector3 {
    const existingIndex = [...this.agents.values()].findIndex((agent) => agent.state.id === state.id);
    const index = existingIndex >= 0 ? existingIndex : this.agents.size;
    if (WORK_STATUSES.has(state.status) || state.status === "walking_to_desk") {
      return DESK_POSITIONS[Math.max(index, 0) % DESK_POSITIONS.length].clone().add(new THREE.Vector3(0, 0, 0.78));
    }
    if (state.status === "collaboration") return new THREE.Vector3(5.2, 0, 2.35);
    return IDLE_POSITIONS[Math.max(index, 0) % IDLE_POSITIONS.length].clone();
  }

  private resize(): void {
    if (this.container === null || this.renderer === null || this.camera === null) return;
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const aspect = width / height;
    this.camera.left = -10 * aspect;
    this.camera.right = 10 * aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.renderer === null || this.camera === null) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects = [...this.agents.values()].flatMap((agent) => [agent.body, agent.head]);
    const hit = this.raycaster.intersectObjects(objects, false)[0];
    const id = hit?.object.userData.agentId as string | undefined;
    if (id === undefined) {
      this.selectAgent(null);
      window.dispatchEvent(new CustomEvent("office:deselect-agent"));
      return;
    }
    this.selectAgent(id);
    window.dispatchEvent(new CustomEvent("office:select-agent", { detail: { id } }));
  };

  private animate = (): void => {
    if (this.renderer === null || this.scene === null || this.camera === null) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;
    for (const visual of this.agents.values()) {
      if (visual.state.status === "idle" && elapsed >= visual.nextIdleMove && visual.group.position.distanceTo(visual.target) < 0.16) {
        const nextIndex = (visual.idleTargetIndex + 1) % IDLE_POSITIONS.length;
        visual.idleTargetIndex = nextIndex;
        visual.target.copy(IDLE_POSITIONS[nextIndex]);
        visual.idleActivity = IDLE_ACTIVITIES[nextIndex];
        refreshLabel(visual.label, visual.state, visual.idleActivity);
        visual.nextIdleMove = elapsed + 7 + Math.random() * 6;
      }
      const distance = visual.group.position.distanceTo(visual.target);
      const moving = distance > 0.12;
      visual.group.position.x = THREE.MathUtils.damp(visual.group.position.x, visual.target.x, 1.45, delta);
      visual.group.position.y = THREE.MathUtils.damp(visual.group.position.y, visual.target.y, 1.45, delta);
      visual.group.position.z = THREE.MathUtils.damp(visual.group.position.z, visual.target.z, 1.45, delta);
      const active = ACTIVE_STATUSES.has(visual.state.status);
      const bob = Math.sin(elapsed * (active ? 4.6 : 2.1) + visual.phase) * (active ? 0.045 : 0.022);
      const seated = WORK_STATUSES.has(visual.state.status) && !moving;
      const smoking = visual.state.status === "idle" && visual.idleActivity === "Taking a smoke break";
      const fixing = visual.state.status === "idle" && visual.idleActivity === "Fixing a motorcycle";
      const smokeCycle = (elapsed + visual.phase) % 3.6;
      const inhaling = smoking && smokeCycle < 0.7;
      const exhaling = smoking && smokeCycle >= 0.7 && smokeCycle < 2.9;
      const walking = moving;
      const repairSway = fixing ? Math.sin(elapsed * 2.4 + visual.phase) * 0.2 : 0;
      const bodyY = seated ? 0.55 : 0.68;
      const headY = seated ? 1.18 : fixing ? 1.18 : 1.38;
      visual.body.position.x = repairSway;
      visual.head.position.x = repairSway * 0.7;
      visual.body.position.y = bodyY + bob;
      visual.head.position.y = headY + bob * 0.75;
      visual.head.position.z = fixing ? -0.08 : 0;
      visual.visor.position.y = headY + 0.01 + bob * 0.75;
      visual.visor.position.z = fixing ? -0.33 : -0.25;
      visual.antenna.position.y = (seated ? 1.52 : 1.72) + bob * 0.5;
      visual.antennaLight.position.y = (seated ? 1.64 : 1.84) + bob * 0.5;
      visual.monitor.position.y = (seated ? 0.66 : 0.77) + bob * 0.5;
      if (walking) {
        const dx = visual.target.x - visual.group.position.x;
        const dz = visual.target.z - visual.group.position.z;
        const length = Math.max(Math.hypot(dx, dz), 0.001);
        const lateral = THREE.MathUtils.clamp(dx / length, -1, 1);
        const heading = Math.atan2(-dx, -dz);
        visual.group.rotation.y = dampAngle(visual.group.rotation.y, heading, 5, delta);
        visual.body.rotation.z = -lateral * 0.16;
        visual.head.rotation.z = -lateral * 0.08;
      } else {
        visual.group.rotation.y = dampAngle(visual.group.rotation.y, 0, 4, delta);
        visual.body.rotation.z = Math.sin(elapsed * 2.4 + visual.phase) * (active ? 0.045 : fixing ? 0.12 : 0.02);
        visual.head.rotation.z = 0;
      }
      visual.body.rotation.x = fixing ? -0.42 + Math.sin(elapsed * 2.4 + visual.phase) * 0.08 : 0;
      visual.head.rotation.x = fixing ? -0.28 : 0;
      const armSwing = active ? Math.sin(elapsed * 6 + visual.phase) * 0.12 : 0;
      visual.arms[0].position.set(-0.28 + repairSway, seated ? 0.66 : fixing ? 0.62 : 0.78, seated || fixing ? -0.12 : 0.02);
      visual.arms[1].position.set(0.28 + repairSway, seated ? 0.66 : fixing ? 0.62 : 0.78, seated || fixing ? -0.12 : 0.02);
      visual.arms[0].rotation.z = -0.32 - armSwing;
      visual.arms[1].rotation.z = 0.32 + armSwing;
      visual.arms[0].rotation.x = seated || fixing ? -0.9 : 0;
      visual.arms[1].rotation.x = seated || fixing ? -0.9 : 0;
      if (inhaling) {
        visual.arms[1].position.set(0.2, 1.03, -0.22);
        visual.arms[1].rotation.x = -0.35;
        visual.arms[1].rotation.z = 0.55;
      } else if (smoking) {
        visual.arms[1].position.set(0.3, 0.76, -0.14);
        visual.arms[1].rotation.x = -0.75;
        visual.arms[1].rotation.z = 0.35;
      }
      const stride = walking ? Math.sin(elapsed * 5 + visual.phase) * 0.55 : 0;
      visual.legs[0].rotation.x = stride;
      visual.legs[1].rotation.x = -stride;
      visual.feet[0].rotation.x = stride * 0.45;
      visual.feet[1].rotation.x = -stride * 0.45;
      visual.legs[0].position.y = 0.25 + Math.max(0, stride) * 0.07;
      visual.legs[1].position.y = 0.25 + Math.max(0, -stride) * 0.07;
      visual.feet[0].position.z = -0.08 + stride * 0.14;
      visual.feet[1].position.z = -0.08 - stride * 0.14;
      visual.wrench.visible = fixing;
      visual.wrench.position.set(0.3, 0.72 + Math.sin(elapsed * 5 + visual.phase) * 0.04, -0.28);
      visual.wrench.rotation.z = Math.sin(elapsed * 5 + visual.phase) * 0.45;
      visual.cigarette.visible = smoking;
      visual.cigarette.position.set(inhaling ? 0.22 : 0.37, inhaling ? 1.16 : 0.88 + Math.sin(elapsed * 2 + visual.phase) * 0.03, -0.25);
      visual.cigarette.rotation.z = Math.PI / 2;
      visual.smoke.forEach((particle, index) => {
        particle.visible = exhaling;
        particle.position.set(
          0.27 + Math.sin(elapsed * 1.8 + visual.phase + index) * 0.05,
          1.22 + ((smokeCycle * 0.22 + index * 0.18) % 0.58),
          -0.25,
        );
        particle.scale.setScalar(0.75 + ((smokeCycle + index) % 1) * 0.35);
      });
      visual.ring.rotation.z = elapsed * (active ? 0.7 : 0.18);
      visual.ring.visible = active || visual.selected || visual.state.status === "error";
      visual.label.position.y = 1.98 + Math.sin(elapsed * 2 + visual.phase) * 0.025;
      const monitorMaterial = visual.monitor.material as THREE.MeshStandardMaterial;
      monitorMaterial.emissiveIntensity = active ? 1.8 + Math.sin(elapsed * 5 + visual.phase) * 0.45 : 0.8;
    }
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
