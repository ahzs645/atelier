import * as THREE from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';

export interface PostSettings {
  ao?: {
    enabled: boolean;
    intensity?: number;
    radius?: number;
    falloff?: number;
  };
  dof?: {
    enabled: boolean;
    fStop?: number;
    /** Called before each active DOF render. Return null to use orbit-target focus. */
    focusProvider?: DofFocusProvider;
  };
  smaa?: boolean;
}

export type AoSettings = NonNullable<PostSettings['ao']>;

export interface DofFocus {
  distance: number;
  /** BokehPass aperture uniform. Omit to keep the f-stop-derived aperture. */
  aperture?: number;
}

export type DofFocusProvider = () => DofFocus | null;

/** Adapter for an app-owned AO implementation inserted into the engine composer. */
export interface AoPass {
  readonly pass: Pass;
  /**
   * Set when the pass renders scene beauty itself (N8AO "Combined" mode). The engine keeps the
   * RenderPass in the chain regardless and disables it only while this pass is enabled, because
   * a pass that replaces the RenderPass stops drawing the scene when it is switched off.
   */
  readonly replacesRenderPass?: boolean;
  apply(settings: AoSettings): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

export type AoPassFactory = (context: {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
}) => AoPass | null;

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
  private readonly aoPassFactory: AoPassFactory | null;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private aoPass: AoPass | null = null;
  private builtInAoPass: GTAOPass | null = null;
  /** True when the injected AO pass renders scene beauty itself (e.g. N8AO "Combined"). */
  private aoReplacesRenderPass = false;
  private bokehPass: BokehPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private enabled = false;
  private width = 1;
  private height = 1;
  private forceLowEnd = false;
  private smaaScale = 1;
  private msaaSamples = 0;
  private dofEnabled = false;
  private dofAperture = Math.min(0.05, 0.025 / 2.8);
  private focusProvider: DofFocusProvider | null = null;
  private aoSettings: AoSettings = {
    enabled: true,
  };
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
    aoPassFactory: AoPassFactory | null = null,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.getCamera = typeof camera === 'function' ? camera : () => camera;
    this.invalidate = invalidate;
    this.getFocusTarget = getFocusTarget;
    this.aoPassFactory = aoPassFactory;
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
    if (settings.ao) {
      this.aoSettings = { ...settings.ao };
      this.applyAoSettings();
    }
    if (settings.dof) {
      this.dofEnabled = settings.dof.enabled;
      this.focusProvider = settings.dof.focusProvider ?? null;
      const fStop = Math.max(0.1, settings.dof.fStop ?? 2.8);
      this.dofAperture = Math.min(0.05, 0.025 / fStop);
      this.applyDofSettings();
    }
    if (this.smaaPass && settings.smaa !== undefined) {
      this.smaaPass.enabled = settings.smaa && !this.forceLowEnd;
    }
    this.invalidate();
  }

  setQuality(options: {
    forceLowEnd?: boolean;
    smaaScale?: number;
    msaaSamples?: number;
  }): void {
    this.forceLowEnd = options.forceLowEnd ?? false;
    this.smaaScale = Math.max(0.25, options.smaaScale ?? 1);
    if (options.msaaSamples !== undefined) {
      this.msaaSamples = Math.max(0, Math.round(options.msaaSamples));
    }
    if (this.composer) {
      const samples = this.forceLowEnd ? 0 : this.msaaSamples;
      this.composer.renderTarget1.samples = samples;
      this.composer.renderTarget2.samples = samples;
      this.composer.setPixelRatio(this.forceLowEnd ? 1 : this.smaaScale);
      this.composer.setSize(this.width, this.height);
      this.resizeAoPass();
    }
    this.applyAoSettings();
    this.applyDofSettings();
    if (this.smaaPass) this.smaaPass.enabled = this.smaaPass.enabled && !this.forceLowEnd;
    this.invalidate();
  }

  /**
   * Exactly one pass must draw the scene. When the injected AO pass replaces the RenderPass it
   * only draws while enabled, so the RenderPass is re-enabled whenever AO is off. Without this
   * a document with AO disabled renders nothing at all and the viewport is black.
   */
  private syncRenderPass(): void {
    if (!this.renderPass) return;
    const aoDrawing = this.aoReplacesRenderPass && (this.aoPass?.pass.enabled ?? false);
    this.renderPass.enabled = !aoDrawing;
  }

  private renderComposer(): boolean {
    if (!this.enabled || !this.composer) return false;
    const camera = this.getCamera();
    if (this.renderPass) this.renderPass.camera = camera;
    if (this.builtInAoPass) this.builtInAoPass.camera = camera;
    if (this.bokehPass) {
      this.bokehPass.camera = camera;
      if (this.bokehPass.enabled) {
        const uniforms = this.bokehPass.uniforms as BokehUniforms;
        let suppliedFocus: DofFocus | null = null;
        try {
          suppliedFocus = this.focusProvider?.() ?? null;
        } catch {
          // A failed app provider falls back to the engine's orbit-target policy.
        }
        if (uniforms.focus) {
          const target = this.getFocusTarget();
          const fallback = target
            ? Math.max(0.001, camera.position.distanceTo(target))
            : 1;
          uniforms.focus.value =
            suppliedFocus && Number.isFinite(suppliedFocus.distance)
              ? Math.max(0.001, suppliedFocus.distance)
              : fallback;
        }
        if (uniforms.aperture) {
          uniforms.aperture.value =
            suppliedFocus?.aperture !== undefined
            && Number.isFinite(suppliedFocus.aperture)
              ? Math.max(0, suppliedFocus.aperture)
              : this.dofAperture;
        }
      }
    }
    this.composer.render();
    return true;
  }

  private resizeTargets(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.composer?.setSize(this.width, this.height);
    this.resizeAoPass();
  }

  dispose(): void {
    this.enabled = false;
    try {
      this.aoPass?.dispose();
    } catch {
      // App-owned passes may be partially constructed when composer creation fails.
    }
    try {
      this.composer?.dispose();
    } catch {
      // Some partially-created addon passes throw while cleaning up.
    }
    this.composer = null;
    this.renderPass = null;
    this.aoPass = null;
    this.builtInAoPass = null;
    this.bokehPass = null;
    this.smaaPass = null;
  }

  private buildComposer(): boolean {
    let composer: EffectComposer | null = null;
    let aoPass: AoPass | null = null;
    try {
      const camera = this.getCamera();
      composer = new EffectComposer(this.renderer);
      const render = new RenderPass(this.scene, camera);
      let builtInAoPass: GTAOPass | null = null;
      if (this.aoPassFactory) {
        aoPass = this.aoPassFactory({
          scene: this.scene,
          camera,
          renderer: this.renderer,
        });
      } else {
        builtInAoPass = new GTAOPass(
          this.scene,
          camera,
          this.width,
          this.height,
        );
        aoPass = this.wrapBuiltInAoPass(builtInAoPass);
      }
      const bokeh = new BokehPass(this.scene, camera, {
        focus: 1,
        aperture: 0,
        maxblur: 0.01,
      });
      bokeh.enabled = false;
      // r181 sizes SMAA through setSize(); its constructor no longer takes width/height.
      const smaa = new SMAAPass();
      smaa.enabled = !this.forceLowEnd;
      // The RenderPass is ALWAYS in the chain, even when an AO pass claims to replace it.
      // A pass that renders scene beauty itself (N8AO's "Combined" mode) only does so while it
      // is enabled; disabling it would otherwise leave nothing drawing the scene and the
      // viewport would go black. `syncRenderPass()` keeps exactly one of the two active.
      composer.addPass(render);
      if (aoPass) composer.addPass(aoPass.pass);
      composer.addPass(bokeh);
      composer.addPass(smaa);
      composer.addPass(new OutputPass());
      const samples = this.forceLowEnd ? 0 : this.msaaSamples;
      composer.renderTarget1.samples = samples;
      composer.renderTarget2.samples = samples;
      composer.setPixelRatio(this.forceLowEnd ? 1 : this.smaaScale);
      composer.setSize(this.width, this.height);
      const scale = this.forceLowEnd ? 1 : this.smaaScale;
      aoPass?.setSize(this.width * scale, this.height * scale);
      aoPass?.apply({
        ...this.aoSettings,
        enabled: this.aoSettings.enabled && !this.forceLowEnd,
      });
      this.composer = composer;
      this.renderPass = render;
      this.aoReplacesRenderPass = aoPass?.replacesRenderPass ?? false;
      this.aoPass = aoPass;
      this.builtInAoPass = builtInAoPass;
      this.bokehPass = bokeh;
      this.smaaPass = smaa;
      this.syncRenderPass();
      this.applyDofSettings();
      return true;
    } catch {
      try {
        aoPass?.dispose();
      } catch {
        // A custom pass can fail after allocating only part of its resources.
      }
      try {
        composer?.dispose();
      } catch {
        // EffectComposer can also be only partially initialized.
      }
      return false;
    }
  }

  private applyAoSettings(): void {
    if (!this.aoPass) return;
    this.aoPass.apply({
      ...this.aoSettings,
      enabled: this.aoSettings.enabled && !this.forceLowEnd,
    });
    // Toggling AO can hand scene drawing between the AO pass and the RenderPass.
    this.syncRenderPass();
  }

  private applyDofSettings(): void {
    if (!this.bokehPass) return;
    this.bokehPass.enabled = this.dofEnabled && !this.forceLowEnd;
    const uniforms = this.bokehPass.uniforms as BokehUniforms;
    if (uniforms.aperture) uniforms.aperture.value = this.dofAperture;
    if (uniforms.maxblur) uniforms.maxblur.value = 0.01;
  }

  private resizeAoPass(): void {
    const scale = this.forceLowEnd ? 1 : this.smaaScale;
    this.aoPass?.setSize(this.width * scale, this.height * scale);
  }

  private wrapBuiltInAoPass(pass: GTAOPass): AoPass {
    return {
      pass,
      apply: (settings) => {
        pass.enabled = settings.enabled;
        pass.blendIntensity = THREE.MathUtils.clamp(
          settings.intensity ?? 1,
          0,
          5,
        );
        pass.updateGtaoMaterial({
          radius: Math.max(0.0001, settings.radius ?? 0.15),
          distanceFallOff: Math.max(0.0001, settings.falloff ?? 1),
          samples: this.forceLowEnd ? 8 : 16,
        });
      },
      setSize: (width, height) => pass.setSize(width, height),
      dispose: () => pass.dispose(),
    };
  }
}
