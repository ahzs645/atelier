import * as THREE from 'three';
import { CameraRig, cameraRigInternal } from './camera';
import type { Projection } from './camera';
import { GizmoService, gizmoServiceInternal } from './gizmo';
import { LightingRig } from './lighting';
import { OverlayLayer, overlayLayerInternal } from './overlay';
import { PickService } from './picking';
import { PostFX, postFxInternal } from './post';

export interface ViewportOptions {
  container: HTMLElement;
  projection?: Projection;
  preserveDrawingBuffer?: boolean;
  antialias?: boolean;
  postProcessing?: boolean;
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

  constructor(options: ViewportOptions) {
    this.container = options.container;
    this.view = this.container.ownerDocument.defaultView;
    this.projection = options.projection ?? '3d';
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({
      antialias: options.antialias ?? true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
    });
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
    this.view?.removeEventListener('resize', this.handleWindowResize);
    this.gizmos.dispose();
    this.picking.dispose();
    this.overlays.dispose();
    this.post.dispose();
    this.lighting.dispose();
    this.camera.dispose();
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

  private readonly renderFrame = (): void => {
    this.frame = 0;
    if (this.disposed) return;
    const wasDirty = this.dirty;
    this.dirty = false;
    const controlsChanged = this.camera[cameraRigInternal].update();
    if (wasDirty || controlsChanged || this.dirty) this.render();
    if (controlsChanged) this.invalidate();
  };

  private readonly handleWindowResize = (): void => {
    this.resize();
  };
}
