import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createSurfaceMaterial,
  updateSurfaceMaterial,
  type SurfaceSpec,
} from './materials';

describe('surface materials', () => {
  it('maps scalar and side properties onto MeshPhysicalMaterial', () => {
    const material = createSurfaceMaterial({
      color: '#336699',
      roughness: 0.4,
      metalness: 0.2,
      opacity: 0.6,
      alphaCutoff: 0.15,
      specularIntensity: 0.7,
      doubleSided: true,
      shellOffset: 0.002,
    });
    expect(material.color.getHexString()).toBe('336699');
    expect(material.roughness).toBe(0.4);
    expect(material.metalness).toBe(0.2);
    expect(material.opacity).toBe(0.6);
    expect(material.transparent).toBe(true);
    expect(material.alphaTest).toBe(0.15);
    expect(material.specularIntensity).toBe(0.7);
    expect(material.side).toBe(THREE.DoubleSide);
    material.dispose();
  });

  it('configures document-mm UV repeat, rotation, and offset without GL', () => {
    const spec: SurfaceSpec = {
      color: '#ffffff',
      roughness: 0.8,
      metalness: 0,
      map: {
        url: '/fabric.png',
        scaleMm: 50,
        rotationDeg: 90,
        offset: { x: 25, y: -10 },
      },
    };
    const material = createSurfaceMaterial(spec);
    expect(material.map).not.toBeNull();
    expect(material.map?.repeat.toArray()).toEqual([0.02, 0.02]);
    expect(material.map?.rotation).toBeCloseTo(Math.PI / 2);
    expect(material.map?.offset.toArray()).toEqual([0.5, -0.2]);
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);

    updateSurfaceMaterial(material, { ...spec, map: undefined });
    expect(material.map).toBeNull();
    material.dispose();
  });
});
