import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LightingRig } from './lighting';

const lightingMocks = vi.hoisted(() => ({
  loadAsync: vi.fn<(url: string) => Promise<THREE.DataTexture>>(),
  generatedTextures: [] as THREE.Texture[],
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof THREE>();
  return {
    ...actual,
    PMREMGenerator: class {
      compileEquirectangularShader(): void {}

      fromEquirectangular(): { texture: THREE.Texture } {
        const texture = new actual.Texture();
        lightingMocks.generatedTextures.push(texture);
        return { texture };
      }

      dispose(): void {}
    },
  };
});

vi.mock('three/addons/loaders/RGBELoader.js', () => ({
  RGBELoader: class {
    setDataType(): this {
      return this;
    }

    loadAsync(url: string): Promise<THREE.DataTexture> {
      return lightingMocks.loadAsync(url);
    }
  },
}));

function fakeRenderer(): THREE.WebGLRenderer {
  return {
    shadowMap: { enabled: true },
  } as unknown as THREE.WebGLRenderer;
}

describe('LightingRig environments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lightingMocks.generatedTextures.length = 0;
  });

  it('does not install a pending HDRI after clearEnvironment', async () => {
    let resolveLoad: (texture: THREE.DataTexture) => void = () => {};
    lightingMocks.loadAsync.mockImplementation(
      () => new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene, fakeRenderer());

    const pending = rig.setEnvironment({ hdri: '/slow.hdr' });
    rig.clearEnvironment();
    resolveLoad(new THREE.DataTexture());
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      reason: 'Environment request was cancelled.',
    });
    expect(scene.environment).toBeNull();
    expect(lightingMocks.generatedTextures).toHaveLength(0);
    rig.dispose();
  });

  it('reports load failure so a caller can retry', async () => {
    lightingMocks.loadAsync
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(new THREE.DataTexture());
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene, fakeRenderer());

    const first = await rig.setEnvironment({ hdri: '/retry.hdr' });
    const second = first.ok
      ? first
      : await rig.setEnvironment({ hdri: '/retry.hdr' });

    expect(first).toEqual({
      ok: false,
      reason:
        'Failed to load environment "/retry.hdr": temporary network failure',
    });
    expect(second).toEqual({ ok: true });
    expect(lightingMocks.loadAsync).toHaveBeenCalledTimes(2);
    expect(scene.environment).toBe(lightingMocks.generatedTextures[0]);
    rig.dispose();
  });
});
