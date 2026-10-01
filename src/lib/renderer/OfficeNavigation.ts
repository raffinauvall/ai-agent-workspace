import * as THREE from "three";
import { Pathfinder } from "./Pathfinder";
import type { GridPosition } from "$lib/types/office";

// ponytail: fixed half-unit floor grid; rebuild only if the furniture layout changes.
export class OfficeNavigation {
  private readonly grid: boolean[][];
  private readonly finder: Pathfinder;
  constructor(world: THREE.Object3D) {
    world.updateMatrixWorld(true);
    const obstacles: THREE.Box3[] = [];
    world.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      // Ignore floors, overhead lintels, small props and the chairs we sit in.
      if (box.min.y < 1 && box.max.y > .48 && (size.y > 1 || size.x > 1 || size.z > 1)) {
        box.expandByVector(new THREE.Vector3(.2, 0, .2)); obstacles.push(box);
      }
    });
    this.grid = Array.from({length: 29}, (_, row) => Array.from({length: 43}, (_, col) => {
      const {x, z} = this.world({col, row});
      return !obstacles.some(b => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z);
    }));
    this.finder = new Pathfinder(this.grid);
  }
  private cell(point: THREE.Vector3): GridPosition {return {col:Math.round((point.x + 10.5) * 2), row:Math.round((point.z + 7) * 2)};}
  private world(cell: GridPosition): THREE.Vector3 {return new THREE.Vector3(cell.col / 2 - 10.5, 0, cell.row / 2 - 7);}
  private nearest(point: THREE.Vector3): GridPosition {
    const cell = this.cell(point);
    for (let radius = 0; radius < 8; radius++) {
      for (let row = cell.row-radius; row <= cell.row+radius; row++) {
        for (let col = cell.col-radius; col <= cell.col+radius; col++) if (this.grid[row]?.[col]) return {col,row};
      }
    }
    return cell;
  }
  resolve(point: THREE.Vector3): THREE.Vector3 {
    const cell = this.cell(point), nearest = this.nearest(point);
    return cell.col === nearest.col && cell.row === nearest.row ? point.clone() : this.world(nearest);
  }
  route(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const end = this.resolve(to);
    const path = this.finder.findPath(this.nearest(from), this.nearest(end)).map(cell => this.world(cell));
    if (path.length || this.cell(from).col === this.cell(end).col && this.cell(from).row === this.cell(end).row) path.push(end);
    return path;
  }
}
