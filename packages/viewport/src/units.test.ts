import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MM_PER_M, docToWorld, worldToDoc } from './units';

describe('document/world units', () => {
  it('round-trips millimetres while keeping document Y positive-up', () => {
    expect(MM_PER_M).toBe(1000);
    const world = docToWorld({ x: 1250, y: 750 }, 0.25);
    expect(world.toArray()).toEqual([1.25, 0.75, 0.25]);
    expect(worldToDoc(world)).toEqual({ x: 1250, y: 750 });
  });

  it('does not introduce a document Y-axis flip', () => {
    const up = docToWorld({ x: 0, y: 1000 });
    expect(up.y).toBe(1);
    expect(worldToDoc(new THREE.Vector3(0, -2, 8)).y).toBe(-2000);
  });
});
