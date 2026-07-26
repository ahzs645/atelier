import * as THREE from 'three';
import type { Vec2 } from '@atelier/geometry';

/** Canonical document millimetres in one world metre. */
export const MM_PER_M = 1000;

/**
 * Convert a document-space point to the world XY plane.
 *
 * Document coordinates are mathematical Y-up. The optional depth is already a
 * world-space metre value; it is not a third document coordinate.
 */
export function docToWorld(p: Vec2, z = 0): THREE.Vector3 {
  return new THREE.Vector3(p.x / MM_PER_M, p.y / MM_PER_M, z);
}

/** Convert a world-space point on the XY document plane back to millimetres. */
export function worldToDoc(v: THREE.Vector3): Vec2 {
  return { x: v.x * MM_PER_M, y: v.y * MM_PER_M };
}
