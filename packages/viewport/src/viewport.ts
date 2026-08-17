import * as THREE from 'three';
import { CameraRig, cameraRigInternal } from './camera';
import type { Projection } from './camera';
import { GizmoService, gizmoServiceInternal } from './gizmo';
import { LightingRig } from './lighting';
import { OverlayLayer, overlayLayerInternal } from './overlay';
import { PickService } from './picking';
import { PostFX, postFxInternal } from './post';
import type { AoPassFactory } from './post';

export interface ViewportOptions {
  container: HTMLElement;
  projection?: Projection;
  preserveDrawingBuffer?: boolean;
  antialias?: boolean;
  postProcessing?: boolean;
  /** Supply a custom AO pass (for example N8AO). Omit for the built-in GTAO. */
  aoPassFactory?: AoPassFactory;
  /** Renderer construction boundary for hosts that provide a compatible WebGL renderer. */
  rendererFactory?: (
    parameters: THREE.WebGLRendererParameters,
  ) => THREE.WebGLRenderer;
}

/** Pure reference counter used by Viewport's continuous-render leases. */
export class RenderLeaseCounter {
  private count = 0;
  private disposed = false;
  private readonly onFirstAcquire: () => void;

  // Explicit field assignment rather than a constructor parameter property:
  // the packages are consumed as TypeScript source, so a consumer compiling
  // with `erasableSyntaxOnly` (LeatherCad) would reject the shorthand.
  constructor(onFirstAcquire: () => void = () => {}) {
    this.onFirstAcquire = onFirstAcquire;
  }

  get size(): number {
    return this.count;
  }

  acquire(): () => void {
    if (this.disposed) return () => {};
    this.count += 1;
    if (this.count === 1) this.onFirstAcquire();
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true;
      this.count = Math.max(0, this.count - 1);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.count = 0;
  }
}

/** Facade wiring the independently disposable viewport subsystems. */
export class Viewport {
  readonly scene: THREE.Scene;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: CameraRig;
  readonly lighting: LightingRig;
  readonly post: PostFX;
  readonly picking: PickService;
  readonly overlays: OverlayLayer;
  readonly gizmos: GizmoService;

  private readonly container: HTMLElement;
  private readonly view: Window | null;
  private projection: Projection;
  private frame = 0;
  private dirty = true;
  private disposed = false;
  private readonly renderLeases = new RenderLeaseCounter(() => this.invalidate());

  constructor(options: ViewportOptions) {
    this.container = options.container;
    this.view = this.container.ownerDocument.defaultView;
    this.projection = options.projection ?? '3d';
    this.scene = new THREE.Scene();
    const rendererParameters: THREE.WebGLRendererParameters = {
      antialias: options.antialias ?? true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
    };
    this.renderer = options.rendererFactory
      ? options.rendererFactory(rendererParameters)
      : new THREE.WebGLRenderer(rendererParameters);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.camera = new CameraRig(
      this.renderer.domElement,
      { projection: this.projection },
      () => this.invalidate(),
    );
    this.lighting = new LightingRig(
      this.scene,
      this.renderer,
      () => this.invalidate(),
    );
    this.post = new PostFX(
      this.renderer,
      this.scene,
      () => this.camera.camera,
      () => this.invalidate(),
      () => this.camera.controls.target,
      options.aoPassFactory ?? null,
    );
    this.picking = new PickService(
      () => this.camera.camera,
      this.renderer.domElement,
    );
    this.overlays = new OverlayLayer(
      this.scene,
      this.renderer.domElement,
      () => this.invalidate(),
    );
    this.gizmos = new GizmoService(
      this.scene,
      this.camera.camera,
      this.renderer.domElement,
      this.camera.controls,
      () => this.invalidate(),
    );
    this.lighting.setBackground('#dfe3e8');
    this.resize();
    if (options.postProcessing ?? true) this.post.setEnabled(true);
    this.view?.addEventListener('resize', this.handleWindowResize);
    this.invalidate();
  }

  setProjection(projection: Projection): void {
    if (projection === this.projection) return;
    this.projection = projection;
    this.camera[cameraRigInternal].setProjection(projection);
    this.gizmos[gizmoServiceInternal].setCamera(this.camera.camera);
    this.resize();
    this.invalidate();
  }

  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.frame !== 0) return;
    if (this.view) {
      this.frame = this.view.requestAnimationFrame(this.renderFrame);
    }
  }

  /** Hold the render loop open until the returned idempotent release is called. */
  acquireRenderLease(reason?: string): () => void {
    void reason;
    return this.renderLeases.acquire();
  }

  get renderLeaseCount(): number {
    return this.renderLeases.size;
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const pixelRatio = Math.min(this.view?.devicePixelRatio ?? 1, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera[cameraRigInternal].resize(width, height);
    this.post[postFxInternal].resize(width, height);
    this.overlays[overlayLayerInternal].resize(
      Math.max(1, Math.round(width * pixelRatio)),
      Math.max(1, Math.round(height * pixelRatio)),
    );
    this.invalidate();
  }

  captureImage(mime = 'image/png'): string {
    this.render();
    this.dirty = false;
    return this.renderer.domElement.toDataURL(mime);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.view && this.frame !== 0) this.view.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.renderLeases.dispose();
    this.view?.removeEventListener('resize', this.handleWindowResize);
    this.gizmos.dispose();
    this.picking.dispose();
    this.overlays.dispose();
    this.post.dispose();
    this.lighting.dispose();
    this.camera.dispose();
    this.disposeSceneResources();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  private render(): void {
    if (!this.post[postFxInternal].render()) {
      this.renderer.render(this.scene, this.camera.camera);
    }
  }

  private disposeSceneResources(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const collectTexture = (value: unknown): void => {
      if (value instanceof THREE.Texture) textures.add(value);
    };
    collectTexture(this.scene.background);
    collectTexture(this.scene.environment);
    this.scene.traverse((object) => {
      const renderable = object as THREE.Object3D & {
        geometry?: unknown;
        material?: unknown;
      };
      if (renderable.geometry instanceof THREE.BufferGeometry) {
        geometries.add(renderable.geometry);
      }
      const values = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      for (const value of values) {
        if (!(value instanceof THREE.Material)) continue;
        materials.add(value);
        for (const property of Object.values(value)) collectTexture(property);
      }
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.scene.clear();
  }

  private readonly renderFrame = (): void => {
    this.frame = 0;
    if (this.disposed) return;
    const wasDirty = this.dirty;
    this.dirty = false;
    const controlsChanged = this.camera[cameraRigInternal].update();
    const leased = this.renderLeaseCount > 0;
    if (wasDirty || controlsChanged || this.dirty || leased) this.render();
    if (controlsChanged || this.renderLeaseCount > 0) this.invalidate();
  };

  private readonly handleWindowResize = (): void => {
    this.resize();
  };
}
