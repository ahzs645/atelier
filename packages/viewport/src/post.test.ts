import * as THREE from 'three';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostFX,
  postFxInternal,
  type AoPass,
  type AoSettings,
} from './post';

const postMocks = vi.hoisted(() => ({
  composerConstructed: vi.fn(),
  composerDisposed: vi.fn(),
  gtaoConstructed: vi.fn(),
  addedPasses: [] as unknown[],
  bokehUniforms: [] as Array<{
    aperture: { value: number };
    maxblur: { value: number };
    focus: { value: number };
  }>,
  renderTargets: [] as Array<{ samples: number }>,
}));

vi.mock('three/addons/postprocessing/EffectComposer.js', () => ({
  EffectComposer: class {
    readonly passes: unknown[] = [];
    readonly renderTarget1 = { samples: 0 };
    readonly renderTarget2 = { samples: 0 };

    constructor(renderer: unknown) {
      postMocks.composerConstructed(renderer);
      postMocks.renderTargets.push(this.renderTarget1, this.renderTarget2);
    }

    addPass(pass: unknown): void {
      this.passes.push(pass);
      postMocks.addedPasses.push(pass);
    }

    setPixelRatio(ratio: number): void {
      void ratio;
    }

    setSize(width: number, height: number): void {
      void width;
      void height;
    }
    render(): void {}

    dispose(): void {
      postMocks.composerDisposed();
    }
  },
}));

vi.mock('three/addons/postprocessing/GTAOPass.js', () => ({
  GTAOPass: class {
    enabled = true;
    blendIntensity = 1;
    camera: unknown;

    constructor(...args: unknown[]) {
      this.camera = args[1];
      postMocks.gtaoConstructed(...args);
    }

    updateGtaoMaterial(settings: unknown): void {
      void settings;
    }

    setSize(width: number, height: number): void {
      void width;
      void height;
    }
    dispose(): void {}
  },
}));

vi.mock('three/addons/postprocessing/RenderPass.js', () => ({
  RenderPass: class {
    camera: unknown;

    constructor(_scene: unknown, camera: unknown) {
      this.camera = camera;
    }
  },
}));

vi.mock('three/addons/postprocessing/BokehPass.js', () => ({
  BokehPass: class {
    enabled = false;
    camera: unknown;
    uniforms = {
      aperture: { value: 0 },
      maxblur: { value: 0 },
      focus: { value: 1 },
    };

    constructor(scene: unknown, camera: unknown, options: unknown) {
      void scene;
      void options;
      this.camera = camera;
      postMocks.bokehUniforms.push(this.uniforms);
    }
  },
}));

vi.mock('three/addons/postprocessing/SMAAPass.js', () => ({
  SMAAPass: class {
    enabled = true;
  },
}));

vi.mock('three/addons/postprocessing/OutputPass.js', () => ({
  OutputPass: class {},
}));

function fakeRenderer(): THREE.WebGLRenderer {
  return {} as unknown as THREE.WebGLRenderer;
}

function fakePass(): Pass {
  return {
    enabled: true,
  } as unknown as Pass;
}

describe('PostFX AO injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMocks.addedPasses.length = 0;
    postMocks.bokehUniforms.length = 0;
    postMocks.renderTargets.length = 0;
  });

  it('constructs, configures, sizes, and disposes an injected AO pass', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const apply = vi.fn<(settings: AoSettings) => void>();
    const setSize = vi.fn<(width: number, height: number) => void>();
    const dispose = vi.fn<() => void>();
    const ao: AoPass = {
      pass: fakePass(),
      replacesRenderPass: true,
      apply,
      setSize,
      dispose,
    };
    const factory = vi.fn(() => ao);
    const post = new PostFX(
      fakeRenderer(),
      scene,
      camera,
      () => {},
      () => null,
      factory,
    );

    expect(post.setEnabled(true)).toBe(true);
    post.apply({
      ao: { enabled: true, intensity: 3, radius: 0.4, falloff: 2 },
    });
    post[postFxInternal].resize(640, 360);
    post.setQuality({ smaaScale: 2, msaaSamples: 4 });
    post.dispose();

    expect(factory).toHaveBeenCalledWith({
      scene,
      camera,
      renderer: expect.any(Object),
    });
    expect(apply).toHaveBeenLastCalledWith({
      enabled: true,
      intensity: 3,
      radius: 0.4,
      falloff: 2,
    });
    expect(setSize).toHaveBeenCalledWith(640, 360);
    expect(setSize).toHaveBeenLastCalledWith(1280, 720);
    expect(postMocks.renderTargets.map((target) => target.samples)).toEqual([4, 4]);
    expect(dispose).toHaveBeenCalledTimes(1);
    // The RenderPass is always present, immediately before the AO pass, even when the AO pass
    // declares `replacesRenderPass` — see the "renderPass handover" tests below for why.
    expect(postMocks.addedPasses[1]).toBe(ao.pass);
    expect(postMocks.addedPasses).toHaveLength(5);
  });

  it('continues without an AO pass when the factory returns null', () => {
    const post = new PostFX(
      fakeRenderer(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      () => {},
      () => null,
      () => null,
    );

    expect(post.setEnabled(true)).toBe(true);
    expect(() => post.apply({ ao: { enabled: true } })).not.toThrow();
    post.dispose();
  });

  it('constructs the built-in GTAO when no factory is supplied', () => {
    const post = new PostFX(
      fakeRenderer(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );

    expect(post.setEnabled(true)).toBe(true);
    expect(postMocks.gtaoConstructed).toHaveBeenCalledTimes(1);
    expect(postMocks.addedPasses).toHaveLength(5);
    post.dispose();
  });

  it('returns false and releases a custom pass when composer setup fails', () => {
    const dispose = vi.fn<() => void>();
    const post = new PostFX(
      fakeRenderer(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      () => {},
      () => null,
      () => ({
        pass: fakePass(),
        apply: () => {
          throw new Error('configuration failed');
        },
        setSize: () => {},
        dispose,
      }),
    );

    expect(post.setEnabled(true)).toBe(false);
    expect(post[postFxInternal].render()).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('applies focus distance and aperture from the DOF focus provider', () => {
    const focusProvider = vi.fn(() => ({
      distance: 2.75,
      aperture: 0.0075,
    }));
    const post = new PostFX(
      fakeRenderer(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
    );

    expect(post.setEnabled(true)).toBe(true);
    post.apply({
      dof: {
        enabled: true,
        fStop: 11,
        focusProvider,
      },
    });
    expect(post[postFxInternal].render()).toBe(true);

    expect(focusProvider).toHaveBeenCalledTimes(1);
    expect(postMocks.bokehUniforms[0]?.focus.value).toBe(2.75);
    expect(postMocks.bokehUniforms[0]?.aperture.value).toBe(0.0075);
    post.dispose();
  });
});

// Regression: browser verification found seamer-studio's 3D pane completely black on first load,
// clearing only when the user toggled AO on. Cause: an AO pass declaring `replacesRenderPass`
// draws scene beauty ONLY while enabled, and the engine had omitted the RenderPass entirely — so
// a document with AO disabled (createEmptyPattern defaults `n8aoEnabled: false`) had nothing
// drawing the scene at all.
describe('PostFX renderPass handover', () => {
  beforeEach(() => {
    postMocks.addedPasses.length = 0;
  });

  function buildWithReplacingAo(enabled: boolean): { renderPass: Pass; aoPass: Pass } {
    const aoInner = fakePass();
    const ao: AoPass = {
      pass: aoInner,
      replacesRenderPass: true,
      apply: (settings) => {
        aoInner.enabled = settings.enabled;
      },
      setSize: () => {},
      dispose: () => {},
    };
    const post = new PostFX(
      fakeRenderer(),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      () => {},
      () => null,
      () => ao,
    );
    post.setEnabled(true);
    post.apply({ ao: { enabled } });
    const isPass = (value: unknown): value is Pass =>
      typeof value === 'object' && value !== null && 'enabled' in value;
    const renderPass = postMocks.addedPasses.filter(isPass).find((candidate) => candidate !== aoInner);
    if (!renderPass) throw new Error('RenderPass was not added to the composer');
    return { renderPass, aoPass: aoInner };
  }

  it('keeps the RenderPass in the chain even when AO claims to replace it', () => {
    const { renderPass } = buildWithReplacingAo(true);
    expect(renderPass).toBeDefined();
  });

  it('enables the RenderPass when the replacing AO pass is disabled', () => {
    const { renderPass, aoPass } = buildWithReplacingAo(false);
    expect(aoPass.enabled).toBe(false);
    // Something must still draw the scene.
    expect(renderPass.enabled).toBe(true);
  });

  it('disables the RenderPass while the replacing AO pass is drawing', () => {
    const { renderPass, aoPass } = buildWithReplacingAo(true);
    expect(aoPass.enabled).toBe(true);
    // Exactly one pass draws the scene; not both.
    expect(renderPass.enabled).toBe(false);
  });
});
