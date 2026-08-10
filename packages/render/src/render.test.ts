import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampFireflies } from './denoise';
import {
  prepareSceneForPathTracing,
  prepareStudioScene,
  validateStillRenderOptions,
} from './still';

class TestImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrWidth;
      this.width = widthOrHeight;
      this.height = height ?? 0;
    }
  }
}

const originalImageData = globalThis.ImageData;

beforeEach(() => {
  globalThis.ImageData = TestImageData as unknown as typeof ImageData;
});

afterEach(() => {
  globalThis.ImageData = originalImageData;
});

describe('clampFireflies', () => {
  it('reduces an isolated hot pixel while preserving its alpha', () => {
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = 20;
      data[offset + 1] = 20;
      data[offset + 2] = 20;
      data[offset + 3] = 255;
    }
    const center = (1 * 3 + 1) * 4;
    data[center] = 255;
    data[center + 1] = 255;
    data[center + 2] = 255;

    const result = clampFireflies(new ImageData(data, 3, 3));

    expect(result.data[center]).toBe(20);
    expect(result.data[center + 1]).toBe(20);
    expect(result.data[center + 2]).toBe(20);
    expect(result.data[center + 3]).toBe(255);
  });
});

describe('validateStillRenderOptions', () => {
  it('accepts a bounded render request', () => {
    expect(() => validateStillRenderOptions({
      width: 400,
      height: 300,
      samples: 20,
      bounces: 3,
    })).not.toThrow();
  });

  it('rejects invalid dimensions and sample counts', () => {
    expect(() => validateStillRenderOptions({ width: 0, height: 300 })).toThrow(/width/);
    expect(() => validateStillRenderOptions({ width: 400, height: 300, samples: 0 })).toThrow(/samples/);
  });
});

describe('prepareSceneForPathTracing', () => {
  it('separates raster polygon-offset print layers from their substrate', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
    ], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ], 3));
    const base = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial(),
    );
    const printMaterial = new THREE.MeshStandardMaterial({
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const print = new THREE.Mesh(geometry, printMaterial);
    print.name = 'PackCAD print artwork';
    scene.add(base, print);

    const prepared = prepareSceneForPathTracing(scene);
    const preparedPrint = prepared.scene.getObjectByName(print.name) as THREE.Mesh;
    const preparedPosition = preparedPrint.geometry.getAttribute('position');
    expect(preparedPosition.getZ(0)).toBeGreaterThan(0.001);
    expect((base.geometry.getAttribute('position')).getZ(0)).toBe(0);

    prepared.dispose();
    geometry.dispose();
    base.material.dispose();
    printMaterial.dispose();
  });

  it('separates back-side print in the opposite normal direction', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
    ], 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ], 3));
    const printMaterial = new THREE.MeshStandardMaterial({
      side: THREE.BackSide,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const print = new THREE.Mesh(geometry, printMaterial);
    print.name = 'back print';
    scene.add(print);

    const prepared = prepareSceneForPathTracing(scene);
    const preparedPrint = prepared.scene.getObjectByName(print.name) as THREE.Mesh;
    expect(preparedPrint.geometry.getAttribute('position').getZ(0)).toBeLessThan(-0.001);
    expect((preparedPrint.material as THREE.Material).side).toBe(THREE.DoubleSide);

    prepared.dispose();
    geometry.dispose();
    printMaterial.dispose();
  });

  it('preserves back-side selection for raster preview preparation', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshStandardMaterial({ side: THREE.BackSide });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const prepared = prepareSceneForPathTracing(scene, {
      preserveMaterialSides: true,
    });
    const preparedMesh = prepared.scene.children[0] as THREE.Mesh;
    expect((preparedMesh.material as THREE.Material).side).toBe(THREE.BackSide);

    prepared.dispose();
    geometry.dispose();
    material.dispose();
  });

  it('removes mesh-based fat-line helpers before material conversion', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(100, 100);
    const material = new THREE.MeshBasicMaterial();
    material.type = 'LineMaterial';
    const fatLineHelper = new THREE.Mesh(geometry, material);
    scene.add(fatLineHelper);

    const prepared = prepareSceneForPathTracing(scene);
    expect(prepared.scene.children[0]?.visible).toBe(false);

    prepared.dispose();
    geometry.dispose();
    material.dispose();
  });

  it('splits indexed vertices at path-traced material boundaries', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      1, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    const mesh = new THREE.Mesh(geometry, [
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      new THREE.MeshStandardMaterial({ color: 0x0000ff }),
    ]);
    mesh.name = 'grouped mesh';
    scene.add(mesh);

    const prepared = prepareSceneForPathTracing(scene);
    expect(prepared.scene.getObjectByName(mesh.name)).toBeUndefined();
    const redPrimitive = prepared.scene.getObjectByName(
      `${mesh.name} [material 0]`,
    ) as THREE.Mesh;
    const bluePrimitive = prepared.scene.getObjectByName(
      `${mesh.name} [material 1]`,
    ) as THREE.Mesh;
    expect(redPrimitive.geometry.index).toBeNull();
    expect(bluePrimitive.geometry.index).toBeNull();
    expect(redPrimitive.geometry.getAttribute('position').count).toBe(3);
    expect(bluePrimitive.geometry.getAttribute('position').count).toBe(3);
    expect(redPrimitive.material).toBe(mesh.material[0]);
    expect(bluePrimitive.material).toBe(mesh.material[1]);

    prepared.dispose();
    geometry.dispose();
    for (const material of mesh.material) material.dispose();
  });
});

describe('prepareStudioScene', () => {
  it('applies shared preview and still settings, including the floor', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial();
    scene.add(new THREE.Mesh(geometry, material));

    const studio = prepareStudioScene(scene, 4 / 3, {
      backgroundColor: '#112233',
      floorColor: '#abcdef',
      floorVisible: false,
      fov: 25,
      keyIntensity: 6,
    });

    const floor = scene.getObjectByName('Atelier studio sweep') as THREE.Mesh;
    const key = scene.getObjectByName('Atelier studio key') as THREE.RectAreaLight;
    expect(floor.visible).toBe(false);
    expect((floor.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('abcdef');
    expect((scene.background as THREE.Color).getHexString()).toBe('112233');
    expect(key.intensity).toBe(6);
    expect((studio.camera as THREE.PerspectiveCamera).fov).toBe(25);

    studio.update({ floorVisible: true, keyIntensity: 2 });
    expect(floor.visible).toBe(true);
    expect(key.intensity).toBe(2);

    studio.dispose();
    geometry.dispose();
    material.dispose();
  });
});
