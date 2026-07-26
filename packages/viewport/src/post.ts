import * as THREE from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export interface PostSettings {
  ao?: {
    enabled: boolean;
    intensity?: number;
    radius?: number;
    falloff?: number;
  };
  dof?: { enabled: boolean; fStop?: number };
  smaa?: boolean;
}

interface BokehUniforms {
  aperture?: THREE.IUniform<number>;
  maxblur?: THREE.IUniform<number>;
  focus?: THREE.IUniform<number>;
}

export const postFxInternal: unique symbol = Symbol('PostFX.internal');

export interface PostFxInternal {
  render(): boolean;
  resize(width: number, height: number): void;
}

/** Guarded post-processing chain with direct-render fallback owned by Viewport. */
export class PostFX {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly getCamera: () => THREE.Camera;
  private readonly getFocusTarget: () => THREE.Vector3 | null;
  private readonly invalidate: () => void;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private aoPass: GTAOPass | null = null;
  private bokehPass: BokehPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private enabled = false;
  private width = 1;
  private height = 1;
  private forceLowEnd = false;
  private smaaScale = 1;
  readonly [postFxInternal]: PostFxInternal = {
    render: () => this.renderComposer(),
    resize: (width, height) => this.resizeTargets(width, height),
  };

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera | (() => THREE.Camera),
    invalidate: () => void = () => {},
    getFocusTarget: () => THREE.Vector3 | null = () => null,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.getCamera = typeof camera === 'function' ? camera : () => camera;
    this.invalidate = invalidate;
    this.getFocusTarget = getFocusTarget;
  }

  setEnabled(on: boolean): boolean {
    if (!on) {
      this.enabled = false;
      this.invalidate();
      return true;
    }
    if (!this.composer && !this.buildComposer()) {
      this.enabled = false;
      return false;
    }
    this.enabled = true;
    this.invalidate();
    return true;
  }

  apply(settings: PostSettings): void {
    if (this.aoPass && settings.ao) {
      this.aoPass.enabled = settings.ao.enabled && !this.forceLowEnd;
      this.aoPass.blendIntensity = THREE.MathUtils.clamp(
        settings.ao.intensity ?? 1,
        0,
        5,
      );
      this.aoPass.updateGtaoMaterial({
        radius: Math.max(0.0001, settings.ao.radius ?? 0.15),
        distanceFallOff: Math.max(0.0001, settings.ao.falloff ?? 1),
        samples: this.forceLowEnd ? 8 : 16,
      });
    }
    if (this.bokehPass && settings.dof) {
      this.bokehPass.enabled = settings.dof.enabled && !this.forceLowEnd;
      const fStop = Math.max(0.1, settings.dof.fStop ?? 2.8);
      const uniforms = this.bokehPass.uniforms as BokehUniforms;
      if (uniforms.aperture) uniforms.aperture.value = Math.min(0.05, 0.025 / fStop);
      if (uniforms.maxblur) uniforms.maxblur.value = 0.01;
    }
    if (this.smaaPass && settings.smaa !== undefined) {
      this.smaaPass.enabled = settings.smaa && !this.forceLowEnd;
    }
    this.invalidate();
  }

  setQuality(options: { forceLowEnd?: boolean; smaaScale?: number }): void {
    this.forceLowEnd = options.forceLowEnd ?? false;
    this.smaaScale = Math.max(0.25, options.smaaScale ?? 1);
    if (this.composer) {
      this.composer.setPixelRatio(this.forceLowEnd ? 1 : this.smaaScale);
      this.composer.setSize(this.width, this.height);
    }
    if (this.aoPass) this.aoPass.enabled = this.aoPass.enabled && !this.forceLowEnd;
    if (this.bokehPass) this.bokehPass.enabled = this.bokehPass.enabled && !this.forceLowEnd;
    if (this.smaaPass) this.smaaPass.enabled = this.smaaPass.enabled && !this.forceLowEnd;
    this.invalidate();
  }

  private renderComposer(): boolean {
    if (!this.enabled || !this.composer) return false;
    const camera = this.getCamera();
    if (this.renderPass) this.renderPass.camera = camera;
    if (this.aoPass) this.aoPass.camera = camera;
    if (this.bokehPass) {
      this.bokehPass.camera = camera;
      const uniforms = this.bokehPass.uniforms as BokehUniforms;
      if (uniforms.focus) {
        const target = this.getFocusTarget();
        uniforms.focus.value = target
          ? Math.max(0.001, camera.position.distanceTo(target))
          : 1;
      }
    }
    this.composer.render();
    return true;
  }

  private resizeTargets(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.composer?.setSize(this.width, this.height);
  }

  dispose(): void {
    this.enabled = false;
    try {
      this.composer?.dispose();
    } catch {
      // Some partially-created addon passes throw while cleaning up.
    }
    this.composer = null;
    this.renderPass = null;
    this.aoPass = null;
    this.bokehPass = null;
    this.smaaPass = null;
  }

  private buildComposer(): boolean {
    try {
      const camera = this.getCamera();
      const composer = new EffectComposer(this.renderer);
      const render = new RenderPass(this.scene, camera);
      const ao = new GTAOPass(this.scene, camera, this.width, this.height);
      ao.blendIntensity = 1;
      ao.updateGtaoMaterial({
        radius: 0.15,
        distanceFallOff: 1,
        samples: this.forceLowEnd ? 8 : 16,
      });
      ao.enabled = !this.forceLowEnd;
      const bokeh = new BokehPass(this.scene, camera, {
        focus: 1,
        aperture: 0,
        maxblur: 0.01,
      });
      bokeh.enabled = false;
      // r181 sizes SMAA through setSize(); its constructor no longer takes width/height.
      const smaa = new SMAAPass();
      smaa.enabled = !this.forceLowEnd;
      composer.addPass(render);
      composer.addPass(ao);
      composer.addPass(bokeh);
      composer.addPass(smaa);
      composer.addPass(new OutputPass());
      composer.setPixelRatio(this.forceLowEnd ? 1 : this.smaaScale);
      composer.setSize(this.width, this.height);
      this.composer = composer;
      this.renderPass = render;
      this.aoPass = ao;
      this.bokehPass = bokeh;
      this.smaaPass = smaa;
      return true;
    } catch {
      this.dispose();
      return false;
    }
  }
}
