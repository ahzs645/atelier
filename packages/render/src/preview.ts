import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  prepareSceneForPathTracing,
  prepareStudioScene,
  type StillRenderSource,
  type StillStudioSettings,
} from './still';

export interface StillPreviewOptions {
  width?: number;
  height?: number;
  exposure?: number;
  studioSettings?: Partial<StillStudioSettings>;
}

export interface StillPreviewUpdate {
  exposure?: number;
  studioSettings?: Partial<StillStudioSettings>;
}

export interface StillPreview {
  readonly camera: THREE.Camera;
  /** Frozen model geometry and the current preview camera for an exact still. */
  createRenderSource: () => StillRenderSource;
  resize: (width: number, height: number) => void;
  update: (options: StillPreviewUpdate) => void;
  render: () => void;
  dispose: () => void;
}

/**
 * Creates the fast, movable studio preview used to compose a path-traced still.
 * It deliberately prepares the same scene clone and studio rig as renderStill,
 * so the camera captured from this handle can be passed back as studioCamera.
 */
export function createStillPreview(
  source: StillRenderSource,
  canvas: HTMLCanvasElement,
  options: StillPreviewOptions = {},
): StillPreview {
  let width = Math.max(1, Math.round(options.width ?? canvas.clientWidth ?? 1));
  let height = Math.max(1, Math.round(options.height ?? canvas.clientHeight ?? 1));
  let disposed = false;
  // Keep a true model snapshot for the final render. Object3D.clone shares
  // BufferGeometry, while folding playback mutates position attributes in
  // place, so clone each mesh geometry as well as the scene hierarchy.
  const modelScene = source.scene.clone(true);
  const snapshotGeometries = new Set<THREE.BufferGeometry>();
  const snapshotControls: THREE.Object3D[] = [];
  modelScene.traverse((object) => {
    if (object.constructor.name.startsWith('TransformControls')) {
      snapshotControls.push(object);
    } else if (object instanceof THREE.Mesh) {
      object.geometry = object.geometry.clone();
      snapshotGeometries.add(object.geometry);
    }
  });
  snapshotControls.forEach((object) => object.removeFromParent());
  // Keep FrontSide/BackSide selection intact for WebGL. The path tracer makes
  // interior sheets double-sided for ray hits, but doing that in the raster
  // preview exposes normally hidden coplanar faces from rear camera angles.
  const prepared = prepareSceneForPathTracing(source.scene, {
    preserveMaterialSides: true,
  });
  const studio = prepareStudioScene(
    prepared.scene,
    width / height,
    options.studioSettings,
    undefined,
    true,
  );
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = options.exposure ?? 0.6;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Retina's 2x ratio quadruples the shaded pixel count. A 1.5x cap keeps the
  // composition preview crisp without making orbiting needlessly expensive;
  // the exported still continues to render at the requested full resolution.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(width, height, false);

  const controls = new OrbitControls(studio.camera, canvas);
  controls.target.copy(studio.target);
  // OrbitControls already emits `change` throughout drag, zoom and pan. Avoid
  // damping here so an idle preview does not require a perpetual animation
  // frame loop (and continuously redraw shadows while the dialog is open).
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.001;
  controls.maxDistance = 1_000;

  const render = (): void => {
    if (disposed) return;
    renderer.render(prepared.scene, studio.camera);
  };
  controls.update();
  controls.addEventListener('change', render);
  render();

  return {
    get camera() {
      return studio.camera;
    },
    createRenderSource(): StillRenderSource {
      return {
        scene: modelScene,
        camera: studio.camera.clone(),
      };
    },
    resize(nextWidth: number, nextHeight: number): void {
      width = Math.max(1, Math.round(nextWidth));
      height = Math.max(1, Math.round(nextHeight));
      renderer.setSize(width, height, false);
      if (studio.camera instanceof THREE.PerspectiveCamera) {
        studio.camera.aspect = width / height;
        studio.camera.updateProjectionMatrix();
      }
      render();
    },
    update(next: StillPreviewUpdate): void {
      if (next.exposure !== undefined) {
        renderer.toneMappingExposure = next.exposure;
      }
      if (next.studioSettings) studio.update(next.studioSettings);
      render();
    },
    render,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controls.removeEventListener('change', render);
      controls.dispose();
      studio.dispose();
      modelScene.clear();
      snapshotGeometries.forEach((geometry) => geometry.dispose());
      prepared.dispose();
      renderer.dispose();
    },
  };
}
