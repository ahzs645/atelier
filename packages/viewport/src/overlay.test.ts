import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { OverlayLayer } from './overlay';

describe('OverlayLayer point updates', () => {
  it('reuses the position buffer when the point count is unchanged', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Group();
    scene.add(parent);
    const overlays = new OverlayLayer(scene);
    overlays.addPoints(
      'points',
      new Float32Array([0, 0, 0, 1, 1, 1]),
      { color: '#ffffff', size: 4 },
      { parent, depthTest: false, renderOrder: 27 },
    );
    const points = parent.children[0];
    expect(points).toBeInstanceOf(THREE.Points);
    if (!(points instanceof THREE.Points)) throw new Error('Expected points');
    const before = points.geometry.getAttribute('position');

    overlays.updatePoints(
      'points',
      new Float32Array([2, 3, 4, 5, 6, 7]),
    );

    const after = points.geometry.getAttribute('position');
    expect(after).toBe(before);
    expect(after.array).toBe(before.array);
    expect(Array.from(after.array)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(points.material.depthTest).toBe(false);
    expect(points.renderOrder).toBe(27);
    expect(points.parent).toBe(parent);
    overlays.dispose();
  });
});
