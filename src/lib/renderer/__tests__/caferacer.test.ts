import * as THREE from "three";
import { expect, it } from "vitest";
import { createCafeRacer } from "../CafeRacer";

it("keeps the reference bike detailed, outward-facing and inside the garage/mobile budget", () => {
  const bike = createCafeRacer();
  expect(bike.userData.tankLettering).toBe("ペオト");
  expect(bike.children.length).toBeLessThanOrEqual(12);
  let triangles = 0;
  for (const child of bike.children) {
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(mesh.material.map).toBeNull(); // No browser canvas/CJK font/network dependency.
    const positions = mesh.geometry.getAttribute("position"), normals = mesh.geometry.getAttribute("normal");
    expect([...positions.array, ...normals.array].every(Number.isFinite)).toBe(true);
    triangles += positions.count / 3;
  }
  expect(triangles).toBeLessThan(14000);
  const bounds = new THREE.Box3().setFromObject(bike), size = bounds.getSize(new THREE.Vector3());
  expect(size.x).toBeLessThan(3); expect(size.z).toBeLessThan(.9);
  expect(bounds.min.y).toBeGreaterThanOrEqual(-.001);
  const tank = bike.getObjectByName("cobalt-paint")!;
  for (const side of [-1, 1]) {
    const hits = new THREE.Raycaster(new THREE.Vector3(0, 1.16, side), new THREE.Vector3(0, 0, -side)).intersectObject(tank);
    expect(hits[0]?.point.z * side).toBeGreaterThan(.2); // Tank must not be inside-out.
  }
  const tyres = (bike.getObjectByName("tyres") as THREE.Mesh).geometry.getAttribute("position");
  for (let i = 0; i < tyres.count; i++) {
    const x = tyres.getX(i), y = tyres.getY(i);
    if (x > .55 || x < -.55) { // Ignore the small rubber footpegs.
      const wheelX = x > 0 ? .94 : -.9;
      expect(Math.hypot(x - wheelX, y - .38)).toBeGreaterThan(.23); // Open centres, not solid cylinders.
    }
  }
  for (const child of bike.children) {
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    mesh.geometry.dispose(); mesh.material.dispose();
  }
});
