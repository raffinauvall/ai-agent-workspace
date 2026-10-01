import * as THREE from "three";
import { expect, it } from "vitest";
import { OfficeNavigation } from "../OfficeNavigation";

it("routes around furniture and through an open doorway", () => {
  const world = new THREE.Group();
  const wall = (x: number, z: number, depth: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.2, 2.8, depth), new THREE.MeshStandardMaterial());
    mesh.position.set(x, 1.4, z); world.add(mesh);
  };
  wall(4, -1.75, 10.5); wall(4, 6.25, 1.5); // Only the middle opening is passable.
  const nav = new OfficeNavigation(world);
  const from = new THREE.Vector3(2, 0, 2), to = new THREE.Vector3(6, 0, 2);
  const path = nav.route(from, to);
  expect(path.at(-1)?.equals(to)).toBe(true);
  const crossing = path.find(p => p.x === 4);
  expect(crossing?.z).toBeGreaterThan(3.5);
  expect(crossing?.z).toBeLessThan(5.5);
  expect(nav.resolve(new THREE.Vector3(4, 0, 2.5)).x).not.toBe(4);
});
