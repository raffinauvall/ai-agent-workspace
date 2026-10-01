import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GenZAvatar, loadAvatar, avatarStyle, type AvatarStyle, type AvatarPose } from "./GenZAvatar";
import { OfficeNavigation } from "./OfficeNavigation";
import { createCafeRacer } from "./CafeRacer";
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
  avatar: GenZAvatar | null;
  hitBox: THREE.Mesh;
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
  path: THREE.Vector3[];
  walkSpeed: number;
  idleActivity: string;
  idleTargetIndex: number;
  nextIdleMove: number;
  phase: number;
  selected: boolean;
}

export interface ExternalSceneOptions {
  externalData?: boolean;
  onAgentSelected?: (agentId: string) => void;
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

function addCityBuilding(parent: THREE.Object3D, x: number, z: number, width: number, depth: number, height: number, color: number): void {
  const bottom = -2.72;
  const building = box([width, height, depth], color, [x, bottom + height / 2, z], parent);
  building.castShadow = false;
  building.receiveShadow = false;
  const roof = box([width * 0.9, 0.1, depth * 0.9], 0x2c4664, [x, bottom + height + 0.05, z], parent);
  roof.castShadow = false;
  roof.receiveShadow = false;
  for (const row of [0.34, 0.58, 0.82]) {
    for (const column of [-0.3, 0.3]) {
      const window = box(
        [0.16, 0.1, 0.025],
        height > 1.7 ? 0xf1c56d : 0x8fc7df,
        [x + column * width, bottom + height * row, z - depth / 2 - 0.02],
        parent,
      );
      window.castShadow = false;
      window.receiveShadow = false;
      window.material.emissive = new THREE.Color(window.material.color.getHex());
      window.material.emissiveIntensity = 0.35;
    }
  }
}

function addCityBackdrop(parent: THREE.Object3D): void {
  const ground = box([42, 0.18, 30], 0x263b57, [0, -2.82, 0], parent);
  ground.castShadow = false;
  ground.receiveShadow = false;
  const buildings: Array<[number, number, number, number, number, number]> = [
    [-14, -10, 2.4, 2.4, 1.7, 0x465e78],
    [-10, -10, 2.1, 2.5, 2.2, 0x354d69],
    [-6, -10, 2.8, 2.2, 1.3, 0x526a80],
    [-2, -10, 2.2, 2.6, 2.3, 0x3d5873],
    [3, -10, 2.5, 2.3, 1.6, 0x4c647d],
    [8, -10, 2.2, 2.5, 2.0, 0x344b67],
    [13, -10, 2.7, 2.3, 1.4, 0x536b83],
    [-14, -5, 2.3, 2.4, 2.0, 0x3b536d],
    [-14, 0, 2.7, 2.2, 1.4, 0x506982],
    [-14, 5, 2.2, 2.5, 1.8, 0x3e5871],
    [14, -5, 2.4, 2.4, 1.5, 0x4d657d],
    [14, 0, 2.8, 2.2, 2.1, 0x354d69],
    [14, 5, 2.1, 2.5, 1.3, 0x536b83],
    [-12, 10, 2.5, 2.2, 1.5, 0x405a73],
    [-7, 10, 2.8, 2.5, 2.1, 0x526a80],
    [-2, 10, 2.2, 2.3, 1.3, 0x3b536d],
    [3, 10, 2.6, 2.4, 1.9, 0x4d657d],
    [8, 10, 2.1, 2.5, 1.4, 0x354d69],
    [13, 10, 2.8, 2.3, 2.2, 0x536b83],
  ];
  buildings.forEach(([x, z, width, depth, height, color]) => addCityBuilding(parent, x, z, width, depth, height, color));
}

function addCloud(parent: THREE.Object3D, x: number, y: number, z: number, scale: number): void {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.scale.setScalar(scale);
  parent.add(group);
  const cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xf3f7fb, roughness: 1, flatShading: true });
  for (const [offsetX, offsetY, radius] of [[-0.65, 0, 0.55], [0, 0.18, 0.72], [0.7, 0, 0.5]] as const) {
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 1), cloudMaterial);
    puff.position.set(offsetX, offsetY, 0);
    puff.castShadow = false;
    puff.receiveShadow = false;
    group.add(puff);
  }
}

function addClouds(parent: THREE.Object3D): void {
  addCloud(parent, -10, 5.1, -7.8, 1.1);
  addCloud(parent, 9.5, 4.8, -8.4, 1.25);
  addCloud(parent, -11.5, 4.4, 5.2, 0.9);
  addCloud(parent, 11.5, 5.4, 3.4, 1.05);
  addCloud(parent, 0, 6.2, -11.5, 1.35);
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
  const top = box([1.85, 0.1, 0.92], 0xd8dee7, [0, 1.0, 0], group);
  top.material.roughness = 0.42;
  box([1.85, 0.07, 0.06], 0x9aa7b7, [0, 0.94, 0.43], group);
  for (const x of [-0.76, 0.76]) {
    box([0.1, 0.9, 0.1], 0x202938, [x, 0.5, -0.29], group);
    box([0.1, 0.9, 0.1], 0x202938, [x, 0.5, 0.29], group);
  }
  box([1.45, 0.06, 0.08], 0x303b4d, [0, 0.57, 0], group);
  box([0.34, 0.46, 0.52], 0xc2cad5, [-0.58, 0.69, 0.08], group);
  box([0.25, 0.025, 0.025], 0x566579, [-0.58, 0.78, -0.19], group);

  box([0.94, 0.48, 0.06], 0x172236, [0, 1.34, -0.2], group);
  const monitorScreen = box([0.84, 0.38, 0.025], 0x12345a, [0, 1.34, -0.235], group);
  monitorScreen.material.emissive = new THREE.Color(0x0d4e7c);
  monitorScreen.material.emissiveIntensity = 0.65;
  box([0.08, 0.26, 0.08], 0x303b4d, [0, 1.08, -0.2], group);
  box([0.4, 0.035, 0.2], 0x303b4d, [0, 1.04, -0.2], group);
  box([0.26, 0.035, 0.38], 0xf4f1ea, [0.48, 1.08, 0.16], group);

  const chair = new THREE.Group();
  chair.position.set(0, 0, 0.96);
  group.add(chair);
  box([0.68, 0.12, 0.58], 0x26364b, [0, 0.55, 0], chair);
  box([0.56, 0.08, 0.46], 0x35465c, [0, 0.63, -0.01], chair);
  box([0.68, 0.72, 0.1], 0x1d2b40, [0, 0.94, 0.25], chair);
  box([0.08, 0.46, 0.08], 0x50627a, [-0.39, 0.78, 0.08], chair);
  box([0.08, 0.46, 0.08], 0x50627a, [0.39, 0.78, 0.08], chair);
  box([0.12, 0.43, 0.12], 0x303b4d, [0, 0.31, 0], chair);
  const chairBase = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.38, 0.06, 8), material(0x202938));
  chairBase.position.y = 0.08;
  chairBase.castShadow = true;
  chair.add(chairBase);
}

function addAvatarFashion(body: THREE.Mesh, head: THREE.Mesh, style: AvatarStyle): void {
  (body.material as THREE.MeshStandardMaterial).color.setHex(style.outfit);
  (head.material as THREE.MeshStandardMaterial).color.setHex(style.skin);

  const hair = material(style.hair, 0.55);
  const accent = material(style.accent, 0.42);
  const addHead = (mesh: THREE.Mesh): void => {
    mesh.castShadow = true;
    head.add(mesh);
  };

  // Every style gets a readable silhouette first, then one recognizable accessory.
  switch (style.style) {
    case "hoodie": {
      const hood = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.075, 6, 14), accent);
      hood.position.set(0, -0.03, 0.03);
      hood.scale.y = 1.12;
      body.add(hood);
      for (const x of [-0.07, 0.07]) {
        const drawstring = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 5), material(0xe2e8f0));
        drawstring.position.set(x, 0.22, -0.23);
        drawstring.rotation.z = x < 0 ? -0.12 : 0.12;
        body.add(drawstring);
      }
      break;
    }
    case "cap": {
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.14, 8), accent);
      crown.position.set(0, 0.23, 0.02);
      addHead(crown);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.16), accent);
      brim.position.set(0, 0.18, -0.25);
      addHead(brim);
      break;
    }
    case "beanie": {
      const hat = new THREE.Mesh(new THREE.SphereGeometry(0.31, 10, 7), accent);
      hat.scale.y = 0.62;
      hat.position.y = 0.18;
      addHead(hat);
      break;
    }
    case "headphones": {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.035, 6, 16), accent);
      band.scale.y = 1.12;
      band.position.z = 0.01;
      addHead(band);
      for (const x of [-0.3, 0.3]) {
        const earCup = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.08, 8), accent);
        earCup.rotation.z = Math.PI / 2;
        earCup.position.set(x, -0.01, 0);
        addHead(earCup);
      }
      break;
    }
    case "streetwear": {
      const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), hair);
      hairCap.scale.set(1.05, 0.46, 1.05);
      hairCap.position.set(0, 0.16, 0.03);
      addHead(hairCap);
      const chain = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 5, 12), accent);
      chain.position.set(0, 0.02, -0.29);
      chain.rotation.x = Math.PI / 2;
      body.add(chain);
      break;
    }
    case "tech_freak": {
      const messyHair = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.28, 7), hair);
      messyHair.position.y = 0.2;
      messyHair.rotation.z = -0.16;
      addHead(messyHair);
      for (const x of [-0.105, 0.105]) {
        const lens = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.018, 6, 12), accent);
        lens.position.set(x, 0.01, -0.27);
        addHead(lens);
      }
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.018), accent);
      bridge.position.set(0, 0.01, -0.27);
      addHead(bridge);
      const lanyard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.025), accent);
      lanyard.position.set(0, 0.15, -0.25);
      body.add(lanyard);
      break;
    }
  }

  // A small hoodie-like collar keeps the silhouette young even when accessories are occluded.
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 5, 10), accent);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.22, -0.06);
  body.add(collar);
}

function addMeetingArea(parent: THREE.Object3D): void {
  const room = new THREE.Group();
  room.position.set(5.3, 0, -2.0);
  parent.add(room);

  box([5.2, 0.08, 3.6], 0x172236, [0, 0, 0], room);
  box([4.8, 0.035, 3.2], 0xddd7c8, [0, 0.06, 0], room);

  const glass = (size: [number, number, number], position: [number, number, number]): THREE.Mesh => {
    const pane = box(size, 0x5c7899, position, room);
    pane.material.transparent = true;
    pane.material.opacity = 0.24;
    pane.material.roughness = 0.2;
    pane.material.metalness = 0.25;
    return pane;
  };

  glass([5.2, 2.7, 0.08], [0, 1.4, -1.78]);
  glass([0.08, 2.7, 3.6], [-2.56, 1.4, 0]);
  glass([0.08, 2.7, 3.6], [2.56, 1.4, 0]);
  glass([1.2, 2.7, 0.08], [-2.0, 1.4, 1.78]);
  glass([1.2, 2.7, 0.08], [2.0, 1.4, 1.78]);

  for (const [x, z, size] of [
    [0, -1.78, [5.3, 0.12, 0.12]],
    [-2.56, 0, [0.12, 2.8, 0.12]],
    [2.56, 0, [0.12, 2.8, 0.12]],
    [-2.0, 1.78, [1.25, 0.12, 0.12]],
    [2.0, 1.78, [1.25, 0.12, 0.12]],
  ] as const) {
    box(size as [number, number, number], 0x26364b, [x, 2.78, z], room);
  }
  box([0.12, 2.7, 0.12], 0x26364b, [-2.56, 1.4, -1.78], room);
  box([0.12, 2.7, 0.12], 0x26364b, [2.56, 1.4, -1.78], room);

  const table = box([3.25, 0.16, 1.3], 0x3d4658, [0, 0.85, -0.05], room);
  table.material.roughness = 0.35;
  for (const [x, z] of [[-1.2, -0.48], [1.2, -0.48], [-1.2, 0.38], [1.2, 0.38]]) {
    box([0.12, 0.82, 0.12], 0x202938, [x, 0.42, z], room);
  }

  const chairPositions: Array<[number, number, number]> = [
    [-1.1, -1.0, Math.PI],
    [0, -1.0, Math.PI],
    [1.1, -1.0, Math.PI],
    [-1.1, 1.0, 0],
    [0, 1.0, 0],
    [1.1, 1.0, 0],
  ];
  for (const [x, z, rotation] of chairPositions) {
    const chair = new THREE.Group();
    chair.position.set(x, 0, z);
    chair.rotation.y = rotation;
    room.add(chair);
    box([0.62, 0.12, 0.62], 0x26364b, [0, 0.55, 0], chair);
    box([0.62, 0.58, 0.12], 0x1d2b40, [0, 0.82, 0.25], chair);
    box([0.08, 0.45, 0.08], 0x3f4f68, [0, 0.28, 0], chair);
  }

  box([2.45, 1.35, 0.08], 0x172236, [0, 1.55, -1.7], room);
  const screen = box([2.2, 1.1, 0.025], 0x0a2345, [0, 1.55, -1.65], room);
  screen.material.emissive = new THREE.Color(0x0b3f76);
  screen.material.emissiveIntensity = 1.2;
  for (const [x, width, color] of [
    [-0.72, 0.65, 0x38bdf8],
    [-0.34, 0.9, 0x34d399],
    [0.1, 0.55, 0xf59e0b],
  ] as const) {
    const bar = box([width, 0.08, 0.025], color, [x + width / 2, 1.55 - (x + 0.72) * 0.35, -1.62], room);
    bar.material.emissive = new THREE.Color(color);
    bar.material.emissiveIntensity = 0.8;
  }

  for (const x of [-1.4, 1.4]) {
    const light = new THREE.PointLight(0xffdca8, 3.5, 4, 2);
    light.position.set(x, 2.55, 0);
    room.add(light);
    box([0.5, 0.04, 0.2], 0xffdca8, [x, 2.72, 0], room);
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
  const group = createCafeRacer();
  group.position.set(x, 0, z);
  parent.add(group);
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

function batchOfficeGeometry(root: THREE.Group): void {
  root.updateMatrixWorld(true);
  const batches = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[]>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
    const m = object.material;
    if (m.transparent || m.map || !object.visible || object.children.length > 0) return;
    const key = [m.color.getHex(), m.roughness, m.metalness, m.emissive.getHex(), m.emissiveIntensity, m.side, object.castShadow, object.receiveShadow].join(":");
    const list = batches.get(key) ?? [];
    list.push(object); batches.set(key, list);
  });
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => {
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      return geometry;
    });
    const merged = mergeGeometries(geometries);
    geometries.forEach(g => g.dispose());
    if (!merged) continue;
    const material = meshes[0].material.clone();
    const batch = new THREE.Mesh(merged, material);
    batch.castShadow = meshes[0].castShadow; batch.receiveShadow = meshes[0].receiveShadow;
    for (const mesh of meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); }
    root.add(batch);
  }
}

export class ThreeOfficeScene {
  private container: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private controls: OrbitControls | null = null;
  private scene: THREE.Scene | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame = 0;
  private lastFrameTime = 0;
  private elapsed = 0;
  private lastTick = 0;
  private hasRendered = false;
  private readonly agents = new Map<string, AgentVisual>();
  private readonly unlisteners: UnlistenFn[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private selectedAgentId: string | null = null;
  private world: THREE.Group | null = null;
  private externalDataMode = false;
  private onExternalAgentSelected: ((agentId: string) => void) | null = null;
  private avatarTemplate: GLTF | null = null;
  private avatarError: string | null = null;
  private navigation: OfficeNavigation | null = null;
  private gestureStart: {x: number; y: number} | null = null;
  private gestureMoved = false;
  private pointers = new Set<number>();
  private paused = false;
  private frames = 0;
  private fps = 0;
  private metricsTime = 0;

  async init(container: HTMLElement, options: ExternalSceneOptions = {}): Promise<void> {
    this.container = container;
    this.externalDataMode = options.externalData === true;
    this.onExternalAgentSelected = options.onAgentSelected ?? null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x789cbd);
    this.scene.fog = new THREE.Fog(0x789cbd, 26, 44);

    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1);
    this.camera = new THREE.OrthographicCamera(-10 * aspect, 10 * aspect, 10, -10, 0.1, 100);
    this.camera.position.set(15, 13, 15);
    this.camera.lookAt(0, 0, 0);
    this.camera.zoom = 0.9;
    this.camera.updateProjectionMatrix();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.externalData ? 1.25 : 1.5));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerCancel);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    try { this.avatarTemplate = await loadAvatar(); }
    catch (error) { this.avatarError = String(error); console.warn("Avatar fallback:", error); }

    if (!this.externalDataMode) {
      try {
        await this.subscribeToEvents();
      } catch {
        // Browser preview has no Tauri event bus; the store fallback still works.
      }
      await this.loadExistingAgents();
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  syncAgents(states: AgentState[]): void {
    const ids = new Set(states.map((state) => state.id));
    for (const state of states) this.upsertAgent(state);
    for (const id of this.agents.keys()) {
      if (!ids.has(id)) this.removeAgent(id);
    }
  }

  destroy(): void {
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners.length = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.animationFrame);
    this.renderer?.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer?.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer?.domElement.removeEventListener("pointercancel", this.onPointerCancel);
    this.renderer?.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls?.dispose();
    for (const visual of this.agents.values()) visual.avatar?.dispose();
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
    this.externalDataMode = false;
    this.onExternalAgentSelected = null;
  }

  setPaused(paused: boolean): void { this.paused = paused; }

  resetCamera(): void {
    this.camera?.position.set(15, 13, 15);
    this.controls?.target.set(0, .2, 0);
    if (this.camera) { this.camera.zoom = .9; this.camera.updateProjectionMatrix(); }
    this.controls?.update();
  }

  focusAgent(id: string): void {
    const visual = this.agents.get(id);
    if (!visual || !this.camera || !this.controls) return;
    const target = visual.group.position.clone().add(new THREE.Vector3(0, .75, 0));
    this.camera.position.add(target.clone().sub(this.controls.target));
    this.controls.target.copy(target);
    this.camera.zoom = 2.4;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.selectAgent(id);
  }

  getDiagnostics() {
    return {fps: this.fps, agents: this.agents.size, riggedAvatars: [...this.agents.values()].filter(a => a.avatar).length,
      avatarError: this.avatarError, drawCalls: this.renderer?.info.render.calls ?? 0,
      triangles: this.renderer?.info.render.triangles ?? 0, geometries: this.renderer?.info.memory.geometries ?? 0,
      targets: [...this.agents.values()].map(visual => {
        const point = visual.group.position.clone().add(new THREE.Vector3(0, .9, 0));
        if (this.camera) point.project(this.camera);
        const bounds = this.renderer?.domElement.getBoundingClientRect();
        return {id: visual.state.id, position: visual.group.position.toArray(), destination: visual.target.toArray(), moving: visual.path.length > 0,
          x: (point.x + 1) / 2 * (bounds?.width ?? 0), y: (1 - point.y) / 2 * (bounds?.height ?? 0)};
      })};
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
    key.shadow.mapSize.set(1024, 1024);
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
    addCityBackdrop(world);
    addClouds(world);

    box([22.4, 0.3, 15.4], 0x182235, [0, -0.25, 0], world);
    box([22, 0.08, 15], 0x8f9aa6, [0, -0.04, 0], world);
    box([22, 3.8, 0.25], 0x6f7480, [0, 1.8, -7.5], world);
    box([0.25, 3.8, 15], 0x6f7480, [-11, 1.8, 0], world);
    box([22, 0.18, 0.35], 0x3c4350, [0, 3.65, -7.32], world);
    addWindow(world, -7.0, 2.1, -7.34, 4.8);
    addWindow(world, 0, 2.1, -7.34, 4.8);
    addWindow(world, 7.0, 2.1, -7.34, 4.8);

    for (const position of DESK_POSITIONS) addDesk(world, position);
    addMeetingArea(world);
    addIdleStations(world);
    addPlant(world, -10.0, -6.3);
    addPlant(world, -10.0, 6.1);
    addPlant(world, 10.0, -6.3);
    addPlant(world, 10.0, 6.4);
    addLamp(world, -8.4, -6.3);
    addLamp(world, 8.4, -6.3);
    this.addWallDisplay(world);
    this.navigation = new OfficeNavigation(world);
    batchOfficeGeometry(world);
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
      const nameChanged = existing.state.name !== state.name;
      existing.state = state;
      if (statusChanged || state.status !== "idle") {
        const target = this.navigation?.resolve(this.positionFor(state)) ?? this.positionFor(state);
        if (!target.equals(existing.target)) this.setDestination(existing, target);
      }
      if (statusChanged && state.status === "idle") {
        existing.idleTargetIndex = Math.max(0, [...this.agents.keys()].indexOf(state.id)) % IDLE_POSITIONS.length;
        existing.idleActivity = IDLE_ACTIVITIES[existing.idleTargetIndex];
        existing.nextIdleMove = this.elapsed + 5 + Math.random() * 4;
      }
      if (statusChanged || nameChanged) refreshLabel(existing.label, state, existing.idleActivity);
      const monitorMaterial = existing.monitor.material as THREE.MeshStandardMaterial;
      monitorMaterial.color.setHex(STATUS_COLORS[state.status]);
      monitorMaterial.emissive.setHex(STATUS_COLORS[state.status]);
      (existing.ring.material as THREE.MeshBasicMaterial).color.setHex(STATUS_COLORS[state.status]);
      return;
    }

    const group = new THREE.Group();
    const style = avatarStyle(state.id);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.38, 4, 8), material(style.outfit));
    body.position.y = 0.68;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), material(style.skin, 0.6));
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
      new THREE.SphereGeometry(0.055, 8, 6),
      new THREE.MeshStandardMaterial({ color: style.accent, emissive: style.accent, emissiveIntensity: 1.6 }),
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
    addAvatarFashion(body, head, style);
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
    const avatar = this.avatarTemplate ? new GenZAvatar(this.avatarTemplate, style) : null;
    if (avatar) {
      group.add(avatar.group);
      for (const object of [body, head, visor, antenna, antennaLight, monitor, ...arms, ...legs, ...feet]) object.visible = false;
    }
    const hitBox = new THREE.Mesh(new THREE.BoxGeometry(.85, 1.9, .65), new THREE.MeshBasicMaterial());
    hitBox.position.y = .9;
    hitBox.visible = false;
    hitBox.userData.agentId = state.id;
    group.add(hitBox);
    const idleActivity = IDLE_ACTIVITIES[this.agents.size % IDLE_ACTIVITIES.length];
    const label = makeLabel(state, idleActivity);
    label.position.y = 1.98;
    group.add(label);
    group.position.copy(this.navigation?.resolve(this.positionFor(state)) ?? this.positionFor(state));
    group.userData.agentId = state.id;
    body.userData.agentId = state.id;
    head.userData.agentId = state.id;
    this.world?.add(group);
    this.agents.set(state.id, {
      avatar,
      hitBox,
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
      target: group.position.clone(),
      path: [],
      walkSpeed: 0,
      idleActivity,
      idleTargetIndex: this.agents.size % IDLE_POSITIONS.length,
      nextIdleMove: this.elapsed + 5 + Math.random() * 4,
      phase: Math.random() * Math.PI * 2,
      selected: false,
    });
  }

  private removeAgent(id: string): void {
    const visual = this.agents.get(id);
    if (visual === undefined) return;
    this.world?.remove(visual.group);
    visual.avatar?.dispose();
    disposeObject(visual.group);
    this.agents.delete(id);
    if (this.selectedAgentId === id) this.selectAgent(null);
    this.hasRendered = false;
  }

  private setDestination(visual: AgentVisual, target: THREE.Vector3): void {
    visual.path = this.navigation?.route(visual.group.position, target) ?? [target.clone()];
    visual.target.copy(visual.path.at(-1) ?? visual.group.position);
  }

  private positionFor(state: AgentState): THREE.Vector3 {
    const existingIndex = [...this.agents.values()].findIndex((agent) => agent.state.id === state.id);
    const index = existingIndex >= 0 ? existingIndex : this.agents.size;
    if (WORK_STATUSES.has(state.status) || state.status === "walking_to_desk") {
      return DESK_POSITIONS[Math.max(index, 0) % DESK_POSITIONS.length].clone().add(new THREE.Vector3(0, 0, 0.78));
    }
    if (state.status === "collaboration") return new THREE.Vector3(5.3, 0, -2.0);
    return IDLE_POSITIONS[Math.max(index, 0) % IDLE_POSITIONS.length].clone();
  }

  private resize(): void {
    if (this.container === null || this.renderer === null || this.camera === null) return;
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const aspect = width / height;
    const halfHeight = Math.max(10, 13 / aspect);
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.hasRendered = false;
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointers.add(event.pointerId);
    if (this.pointers.size > 1) this.gestureMoved = true;
    else { this.gestureStart = {x: event.clientX, y: event.clientY}; this.gestureMoved = false; }
  };
  private onPointerMove = (event: PointerEvent): void => {
    if (this.gestureStart && Math.hypot(event.clientX - this.gestureStart.x, event.clientY - this.gestureStart.y) > 7) this.gestureMoved = true;
  };
  private onPointerCancel = (event: PointerEvent): void => { this.pointers.delete(event.pointerId); this.gestureMoved = true; };
  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (!this.gestureStart || this.gestureMoved || this.pointers.size > 0) return;
    this.gestureStart = null;
    if (this.renderer === null || this.camera === null) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objects = [...this.agents.values()].map(agent => agent.hitBox);
    const hit = this.raycaster.intersectObjects(objects, false)[0];
    const id = hit?.object.userData.agentId as string | undefined;
    if (id === undefined) {
      this.selectAgent(null);
      window.dispatchEvent(new CustomEvent("office:deselect-agent"));
      return;
    }
    this.selectAgent(id);
    this.onExternalAgentSelected?.(id);
    window.dispatchEvent(new CustomEvent("office:select-agent", { detail: { id } }));
  };

  private animate = (time: number): void => {
    if (this.renderer === null || this.scene === null || this.camera === null) return;
    if (this.paused || document.hidden || time - this.lastFrameTime < 1000 / 30 - .5) {
      if (this.paused || document.hidden) this.lastTick = time;
      this.animationFrame = requestAnimationFrame(this.animate);
      return;
    }
    this.lastFrameTime = time - ((time - this.lastFrameTime) % (1000 / 30));
    const delta = Math.min((time - this.lastTick) / 1000, .1);
    this.lastTick = time;
    const elapsed = this.elapsed += delta;
    for (const visual of this.agents.values()) {
      if (visual.state.status === "idle" && elapsed >= visual.nextIdleMove && visual.group.position.distanceTo(visual.target) < 0.16) {
        const nextIndex = (visual.idleTargetIndex + 1) % IDLE_POSITIONS.length;
        visual.idleTargetIndex = nextIndex;
        this.setDestination(visual, IDLE_POSITIONS[nextIndex]);
        visual.idleActivity = IDLE_ACTIVITIES[nextIndex];
        refreshLabel(visual.label, visual.state, visual.idleActivity);
        visual.nextIdleMove = elapsed + 7 + Math.random() * 6;
      }
      const distance = visual.group.position.distanceTo(visual.target);
      const moving = visual.path.length > 0 && distance > 0.04;
      visual.walkSpeed = THREE.MathUtils.damp(visual.walkSpeed, moving ? Math.min(1.05, Math.max(.25, distance * 1.8)) : 0, 5, delta);
      const waypoint = visual.path[0] ?? visual.target;
      const dx = waypoint.x - visual.group.position.x, dz = waypoint.z - visual.group.position.z;
      const step = Math.min(visual.walkSpeed * delta, Math.hypot(dx, dz));
      if (moving) {
        const length = Math.max(Math.hypot(dx, dz), .001);
        visual.group.position.x += dx / length * step;
        visual.group.position.z += dz / length * step;
        if (visual.group.position.distanceTo(waypoint) < .04) visual.path.shift();
      } else visual.path.length = 0;
      const active = ACTIVE_STATUSES.has(visual.state.status);
      const bob = Math.sin(elapsed * (active ? 4.6 : 2.1) + visual.phase) * (active ? 0.045 : 0.022);
      const seated = WORK_STATUSES.has(visual.state.status) && !moving;
      const smoking = visual.state.status === "idle" && visual.idleActivity === "Taking a smoke break";
      const fixing = visual.state.status === "idle" && visual.idleActivity === "Fixing a motorcycle";
      const smokeCycle = (elapsed + visual.phase) % 3.6;
      const inhaling = smoking && smokeCycle < 0.7;
      const exhaling = smoking && smokeCycle >= 0.7 && smokeCycle < 2.9;
      const pose: AvatarPose = moving ? "walk" : seated ? "work" : fixing ? "repair" : inhaling ? "smoke" : "idle";
      visual.avatar?.update(delta, pose, smoking && !moving, visual.walkSpeed);
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
        const length = Math.max(Math.hypot(dx, dz), 0.001);
        const lateral = THREE.MathUtils.clamp(dx / length, -1, 1);
        const heading = Math.atan2(-dx, -dz);
        visual.group.rotation.y = dampAngle(visual.group.rotation.y, heading, 5, delta);
        visual.body.rotation.z = -lateral * 0.16;
        visual.head.rotation.z = -lateral * 0.08;
      } else {
        const facing = fixing ? Math.atan2(-(6 - visual.group.position.x), -(4.9 - visual.group.position.z)) : 0;
        visual.group.rotation.y = dampAngle(visual.group.rotation.y, facing, 4, delta);
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
      visual.wrench.visible = fixing && !visual.avatar;
      visual.wrench.position.set(0.3, 0.72 + Math.sin(elapsed * 5 + visual.phase) * 0.04, -0.28);
      visual.wrench.rotation.z = Math.sin(elapsed * 5 + visual.phase) * 0.45;
      visual.cigarette.visible = smoking && !visual.avatar;
      visual.cigarette.position.set(inhaling ? 0.22 : 0.37, inhaling ? 1.16 : 0.88 + Math.sin(elapsed * 2 + visual.phase) * 0.03, -0.25);
      visual.cigarette.rotation.z = Math.PI / 2;
      visual.smoke.forEach((particle, index) => {
        particle.visible = exhaling && !moving;
        (particle.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - (smokeCycle - .7) / 2.2) * .5;
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
    const cameraMoved = this.controls?.update();
    if (this.agents.size === 0 && this.hasRendered && !cameraMoved) {
      this.animationFrame = requestAnimationFrame(this.animate);
      return;
    }
    this.renderer.render(this.scene, this.camera);
    this.hasRendered = true;
    this.frames++;
    if (time - this.metricsTime >= 1000) { this.fps = Math.round(this.frames * 1000 / (time - this.metricsTime)); this.frames = 0; this.metricsTime = time; }
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
