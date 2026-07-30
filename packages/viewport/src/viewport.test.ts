// @vitest-environment happy-dom

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderLeaseCounter, Viewport } from './viewport';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RenderLeaseCounter', () => {
  it('reference-counts releases and makes each release idempotent', () => {
    const onFirstAcquire = vi.fn();
    const leases = new RenderLeaseCounter(onFirstAcquire);
    const releaseFirst = leases.acquire();
    const releaseSecond = leases.acquire();

    expect(leases.size).toBe(2);
    expect(onFirstAcquire).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseFirst();
    expect(leases.size).toBe(1);

    releaseSecond();
    expect(leases.size).toBe(0);
  });

  it('drops every lease on dispose and ignores later acquire/release calls', () => {
    const leases = new RenderLeaseCounter();
    const release = leases.acquire();
    leases.acquire();

    leases.dispose();
    expect(leases.size).toBe(0);

    release();
    const releaseAfterDispose = leases.acquire();
    releaseAfterDispose();
    expect(leases.size).toBe(0);
  });
});

describe('Viewport lifecycle', () => {
  it('constructs, resizes, and disposes renderer and scene resources', () => {
    const container = document.createElement('div');
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 640 },
      clientHeight: { configurable: true, value: 320 },
    });
    const canvas = document.createElement('canvas');
    const setPixelRatio = vi.fn();
    const setSize = vi.fn();
    const render = vi.fn();
    const disposeRenderer = vi.fn();
    const renderer = {
      domElement: canvas,
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 0,
      shadowMap: {
        enabled: false,
        type: THREE.BasicShadowMap,
      },
      setPixelRatio,
      setSize,
      render,
      dispose: disposeRenderer,
    } as unknown as THREE.WebGLRenderer;
    const rendererFactory = vi.fn(() => renderer);
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(41);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});

    const viewport = new Viewport({
      container,
      postProcessing: false,
      rendererFactory,
    });

    expect(rendererFactory).toHaveBeenCalledWith(expect.objectContaining({
      antialias: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }));
    expect(container.firstElementChild).toBe(canvas);
    expect(setSize).toHaveBeenLastCalledWith(640, 320, false);
    expect((viewport.camera.camera as THREE.PerspectiveCamera).aspect).toBe(2);

    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 200 },
    });
    window.dispatchEvent(new Event('resize'));
    expect(setSize).toHaveBeenLastCalledWith(300, 200, false);
    expect((viewport.camera.camera as THREE.PerspectiveCamera).aspect).toBe(1.5);

    const texture = new THREE.Texture();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const disposeTexture = vi.spyOn(texture, 'dispose');
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    viewport.scene.add(new THREE.Mesh(geometry, material));

    viewport.dispose();
    viewport.dispose();

    expect(cancelFrame).toHaveBeenCalledWith(41);
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(disposeRenderer).toHaveBeenCalledOnce();
    expect(viewport.scene.children).toHaveLength(0);
    expect(container.contains(canvas)).toBe(false);

    window.dispatchEvent(new Event('resize'));
    expect(setSize).toHaveBeenCalledTimes(2);
    expect(requestFrame).toHaveBeenCalledOnce();
  });
});
