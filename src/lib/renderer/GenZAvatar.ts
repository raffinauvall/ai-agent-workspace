import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import avatarData from "./assets/gen-z-avatar.glb?inline";

export type AvatarPose = "idle" | "walk" | "sit" | "work" | "smoke" | "repair";
export type FashionStyle = "hoodie" | "cap" | "beanie" | "headphones" | "streetwear" | "tech_freak";
export interface AvatarStyle { style: FashionStyle; skin: number; outfit: number; accent: number; hair: number; }

let template: Promise<GLTF> | undefined;
export function loadAvatar(): Promise<GLTF> {
  return template ??= new Promise((resolve, reject) => {
    const encoded = avatarData.slice(avatarData.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    new GLTFLoader().parse(bytes.buffer, "", resolve, reject);
  });
}

// ID alone determines appearance, including after reconnects and reordered snapshots.
export function avatarStyle(id: string): AvatarStyle {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  seed >>>= 0;
  const styles: FashionStyle[] = ["hoodie", "cap", "beanie", "headphones", "streetwear", "tech_freak"];
  return {
    style: styles[seed % styles.length],
    skin: [0xf2c7a5, 0xd99a6c, 0xb96f4a, 0x8d5524, 0xf0b88c][(seed >>> 4) % 5],
    outfit: [0x66878a, 0x90677c, 0x597c65, 0xab8057, 0x7d8297, 0x444956][(seed >>> 8) % 6],
    accent: [0x8fd0e8, 0xe8bd72, 0x99d0a5, 0xe5a9bd, 0xc0afe5, 0xd2b48c][(seed >>> 12) % 6],
    hair: [0x29252e, 0x4b3027, 0x805338, 0xa2a3a2][(seed >>> 16) % 4],
  };
}

export class GenZAvatar {
  readonly group: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<AvatarPose, THREE.AnimationAction>();
  private action: THREE.AnimationAction | null = null;
  private readonly materials = new Set<THREE.Material>();
  private readonly cigarette: THREE.Object3D | undefined;
  private readonly wrench: THREE.Object3D | undefined;

  constructor(gltf: GLTF, style: AvatarStyle) {
    this.group = clone(gltf.scene);
    // Geometry/animation clips are shared; skeleton and palette are instance-owned.
    const palette = new Map<THREE.Material, THREE.Material>();
    this.group.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const recolor = (source: THREE.MeshStandardMaterial): THREE.Material => {
          let material = palette.get(source);
          if (!material) {
            const copy = source.clone();
            const color = ({outfit: style.outfit, skin: style.skin, accent: style.accent, hair: style.hair} as Record<string, number>)[source.name];
            if (color !== undefined) copy.color.setHex(color);
            if (style.style === "tech_freak" && source.name === "outfit") copy.roughness = 1;
            palette.set(source, copy); this.materials.add(copy); material = copy;
          }
          return material;
        };
        object.material = Array.isArray(object.material) ? object.material.map(m => recolor(m as THREE.MeshStandardMaterial)) : recolor(object.material as THREE.MeshStandardMaterial);
        object.castShadow = true;
        object.receiveShadow = true;
        // Animated limbs can extend outside the bind-pose bounding volume.
        if (object instanceof THREE.SkinnedMesh) object.frustumCulled = false;
      }
    });
    const visibleAccessories: Record<string, boolean> = {
      Cap: style.style === "cap" || style.style === "streetwear",
      Beanie: style.style === "beanie",
      Headphones: style.style === "headphones" || style.style === "tech_freak",
      Glasses: style.style === "tech_freak",
      Cigarette: false, Wrench: false,
    };
    for (const [name, visible] of Object.entries(visibleAccessories)) {
      const accessory = this.group.getObjectByName(name);
      if (accessory) accessory.visible = visible;
    }
    this.cigarette = this.group.getObjectByName("Cigarette");
    this.wrench = this.group.getObjectByName("Wrench");
    this.mixer = new THREE.AnimationMixer(this.group);
    for (const clip of gltf.animations) this.actions.set(clip.name as AvatarPose, this.mixer.clipAction(clip));
    this.play("idle");
  }

  play(pose: AvatarPose): void {
    const next = this.actions.get(pose);
    if (!next || next === this.action) return;
    next.reset().setEffectiveTimeScale(pose === "walk" ? 1.1 : .65).setEffectiveWeight(1).play();
    if (this.action) this.action.crossFadeTo(next, .22, false);
    this.action = next;
  }

  update(delta: number, pose: AvatarPose, smoking: boolean, walkSpeed = 1): void {
    this.play(pose);
    if (pose === "walk") this.action?.setEffectiveTimeScale(Math.max(.3, walkSpeed));
    if (this.cigarette) this.cigarette.visible = smoking;
    if (this.wrench) this.wrench.visible = pose === "repair";
    this.mixer.update(delta);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.group);
    for (const material of this.materials) material.dispose();
    this.group.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose(); });
    this.group.removeFromParent();
  }
}
