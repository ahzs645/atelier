import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Bounds2 } from '@atelier/geometry';
import { docToWorld } from './units';

export type Projection = '2d' | '3d';
export type CameraView =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'isometric'
  | 'reset';
export type CameraKind = 'perspective' | 'orthographic';
export type InputAction = 'rotate' | 'pan' | 'dolly' | 'none';

export interface CameraRigOptions {
  kind?: CameraKind;
  fov?: number;
  projection?: Projection;
}

export interface CameraState {
  kind: CameraKind;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  fov: number;
}

export interface InputMap {
  left: 'rotate' | 'pan' | 'none';
  middle: 'dolly' | 'pan' | 'none';
  right: 'rotate' | 'pan' | 'none';
  modified: Partial<Pick<InputMap, 'left' | 'right'>>;
}

export const DEFAULT_INPUT_MAP: Readonly<InputMap> = {
  left: 'rotate',
  middle: 'dolly',
  right: 'pan',
  modified: { left: 'pan', right: 'rotate' },
};

export const cameraRigInternal: unique symbol = Symbol('CameraRig.internal');

export interface CameraRigInternal {
  update(): boolean;
  resize(width: number, height: number): void;
  setProjection(projection: Projection): void;
}

export function resolveInputAction(
  map: InputMap,
  button: 0 | 1 | 2,
  modified: boolean,
): InputAction {
  if (modified && button !== 1) {
    const key = button === 0 ? 'left' : 'right';
    const action = map.modified[key];
    if (action !== undefined) return action;
  }
  if (button === 0) return map.left;
  if (button === 1) return map.middle;
  return map.right;
}

function cameraKind(camera: THREE.Camera): CameraKind {
  return camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';
}

function fovFor(camera: THREE.Camera, fallback: number): number {
  return camera instanceof THREE.PerspectiveCamera ? camera.fov : fallback;
}

function mouseAction(action: InputAction): THREE.MOUSE | null {
  if (action === 'rotate') return THREE.MOUSE.ROTATE;
  if (action === 'pan') return THREE.MOUSE.PAN;
  if (action === 'dolly') return THREE.MOUSE.DOLLY;
  return null;
}

function mouseActionForModified(action: InputAction, eventHasModifier: boolean): THREE.MOUSE | null {
  if (!eventHasModifier) return mouseAction(action);
  if (action === 'rotate') return THREE.MOUSE.PAN;
  if (action === 'pan') return THREE.MOUSE.ROTATE;
  return mouseAction(action);
}

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

/**
 * Camera and OrbitControls ownership, including serialisation and framing.
 *
 * Passing no element constructs a headless rig for state and framing tests.
 */
export class CameraRig {
  private _camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  private readonly element: HTMLElement | null;
  private readonly invalidate: () => void;
  private readonly listeners = new Set<(state: CameraState) => void>();
  private inputMap: InputMap = {
    ...DEFAULT_INPUT_MAP,
    modified: { ...DEFAULT_INPUT_MAP.modified },
  };
  private aspect = 1;
  private fov: number;
  private projection: Projection;
  private inputDisposer: () => void = () => {};
  private flyFrame = 0;
  private flyResolve: (() => void) | null = null;
  private disposed = false;
  readonly [cameraRigInternal]: CameraRigInternal = {
    update: () => this.updateControls(),
    resize: (width, height) => this.resizeProjection(width, height),
    setProjection: (projection) => this.applyProjection(projection),
  };

  constructor(options?: CameraRigOptions);
  constructor(
    element: HTMLElement | null,
    options?: CameraRigOptions,
    invalidate?: () => void,
  );
  constructor(
    elementOrOptions: HTMLElement | CameraRigOptions | null = null,
    options: CameraRigOptions = {},
    invalidate: () => void = () => {},
  ) {
    const headless = elementOrOptions === null
      || !('addEventListener' in elementOrOptions);
    const resolvedOptions = headless
      ? (elementOrOptions ?? options)
      : options;
    this.element = headless ? null : elementOrOptions;
    this.invalidate = invalidate;
    this.fov = THREE.MathUtils.clamp(resolvedOptions.fov ?? 54, 10, 120);
    this.projection = resolvedOptions.projection ?? '3d';
    const kind = this.projection === '2d'
      ? 'orthographic'
      : (resolvedOptions.kind ?? 'perspective');
    this._camera = this.createCamera(kind);
    this.controls = new OrbitControls(this._camera, this.element);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.001;
    this.controls.maxDistance = 1_000;
    this.controls.addEventListener('change', this.handleControlsChange);
    this.applyInputMap();
    if (this.element) this.inputDisposer = this.installInputWorkaround(this.element);
    if (this.projection === '2d') {
      this.controls.enableRotate = false;
      this.setView('front');
    } else if (kind === 'perspective') {
      this._camera.position.set(0.5, 0.9, 1.6);
      this.controls.target.set(0, 0.9, 0);
      this.controls.update();
    } else {
      this._camera.position.set(0, 0, 2);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  get camera(): THREE.Camera {
    return this._camera;
  }

  setKind(kind: CameraKind): void {
    if (cameraKind(this._camera) === kind) return;
    const state = this.getState();
    this._camera = this.createCamera(kind);
    this.controls.object = this._camera;
    this._camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.target);
    this._camera.zoom = state.zoom;
    this._camera.updateProjectionMatrix();
    this.controls.update();
    this.emitChange();
  }

  setView(view: CameraView): void {
    this.cancelFly();
    let target = this.controls.target.clone();
    let position: THREE.Vector3;
    if (view === 'reset') {
      target = new THREE.Vector3(0, this.projection === '2d' ? 0 : 0.9, 0);
      position = this.projection === '2d'
        ? new THREE.Vector3(0, 0, 2)
        : new THREE.Vector3(0.5, 0.9, 1.6);
    } else {
      const distance = Math.max(this._camera.position.distanceTo(target), 1);
      const offsets: Record<Exclude<CameraView, 'reset'>, THREE.Vector3> = {
        front: new THREE.Vector3(0, 0, distance),
        back: new THREE.Vector3(0, 0, -distance),
        left: new THREE.Vector3(-distance, 0, 0),
        right: new THREE.Vector3(distance, 0, 0),
        top: new THREE.Vector3(0, distance, 0.001),
        bottom: new THREE.Vector3(0, -distance, 0.001),
        isometric: new THREE.Vector3(distance, distance, distance).normalize().multiplyScalar(distance),
      };
      position = target.clone().add(offsets[view]);
    }
    this._camera.position.copy(position);
    this.controls.target.copy(target);
    this._camera.up.set(0, 1, 0);
    this._camera.lookAt(target);
    this.controls.update();
    this.emitChange();
  }

  setFov(deg: number): void {
    this.fov = THREE.MathUtils.clamp(deg, 10, 120);
    if (this._camera instanceof THREE.PerspectiveCamera) {
      this._camera.fov = this.fov;
      this._camera.updateProjectionMatrix();
    }
    this.emitChange();
  }

  getFov(): number {
    return fovFor(this._camera, this.fov);
  }

  fit(box: THREE.Box3, padding = 1.2): void {
    if (box.isEmpty()) return;
    const safePadding = Math.max(0.01, padding);
    const center = box.getCenter(new THREE.Vector3());
    const direction = this._camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    direction.normalize();
    this.controls.target.copy(center);

    if (this._camera instanceof THREE.PerspectiveCamera) {
      this._camera.position.copy(center).add(direction);
      this._camera.lookAt(center);
      this._camera.updateMatrixWorld(true);
      const right = new THREE.Vector3().setFromMatrixColumn(this._camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this._camera.matrixWorld, 1);
      let halfWidth = 0;
      let halfHeight = 0;
      for (const corner of boxCorners(box)) {
        const offset = corner.sub(center);
        halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
        halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
      }
      const tangent = Math.tan(THREE.MathUtils.degToRad(this._camera.fov) / 2);
      const distance = Math.max(
        halfHeight / tangent,
        halfWidth / (tangent * Math.max(this.aspect, Number.EPSILON)),
        0.001,
      ) * safePadding;
      this._camera.position.copy(center).addScaledVector(direction, distance);
    } else {
      const distance = Math.max(this._camera.position.distanceTo(center), 1);
      this._camera.position.copy(center).addScaledVector(direction, distance);
      this._camera.lookAt(center);
      this._camera.updateMatrixWorld(true);
      const right = new THREE.Vector3().setFromMatrixColumn(this._camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this._camera.matrixWorld, 1);
      let halfWidth = 0;
      let halfHeight = 0;
      for (const corner of boxCorners(box)) {
        const offset = corner.sub(center);
        halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
        halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
      }
      const width = Math.max(halfWidth * 2, Number.EPSILON);
      const height = Math.max(halfHeight * 2, Number.EPSILON);
      this._camera.zoom = Math.min(
        (this._camera.right - this._camera.left) / (width * safePadding),
        (this._camera.top - this._camera.bottom) / (height * safePadding),
      );
      this._camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.emitChange();
  }

  fitDoc(bounds: Bounds2, padding = 1.2): void {
    const min = docToWorld({ x: bounds.minX, y: bounds.minY });
    const max = docToWorld({ x: bounds.maxX, y: bounds.maxY });
    this.fit(new THREE.Box3(min, max), padding);
  }

  flyTo(
    position: THREE.Vector3,
    target: THREE.Vector3,
    ms = 700,
  ): Promise<void> {
    this.cancelFly();
    const view = this.element?.ownerDocument.defaultView;
    if (!view || ms <= 0) {
      this._camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      this.emitChange();
      return Promise.resolve();
    }
    const fromPosition = this._camera.position.clone();
    const fromTarget = this.controls.target.clone();
    const start = view.performance.now();
    return new Promise<void>((resolve) => {
      this.flyResolve = resolve;
      const step = (now: number): void => {
        if (this.disposed || this.flyResolve !== resolve) return;
        const t = Math.min(1, (now - start) / ms);
        const eased = t * t * (3 - 2 * t);
        this._camera.position.lerpVectors(fromPosition, position, eased);
        this.controls.target.lerpVectors(fromTarget, target, eased);
        this.controls.update();
        this.invalidate();
        if (t < 1) {
          this.flyFrame = view.requestAnimationFrame(step);
        } else {
          this.flyFrame = 0;
          this.flyResolve = null;
          this.emitChange();
          resolve();
        }
      };
      this.flyFrame = view.requestAnimationFrame(step);
    });
  }

  setInputMap(map: Partial<InputMap>): void {
    this.inputMap = {
      ...this.inputMap,
      ...map,
      modified: {
        ...this.inputMap.modified,
        ...map.modified,
      },
    };
    this.applyInputMap();
  }

  onChange(fn: (state: CameraState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState(): CameraState {
    return {
      kind: cameraKind(this._camera),
      position: this._camera.position.toArray(),
      target: this.controls.target.toArray(),
      zoom: this._camera.zoom,
      fov: this.getFov(),
    };
  }

  setState(state: CameraState): void {
    this.cancelFly();
    this.setKind(state.kind);
    this.fov = THREE.MathUtils.clamp(state.fov, 10, 120);
    if (this._camera instanceof THREE.PerspectiveCamera) this._camera.fov = this.fov;
    this._camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.target);
    this._camera.zoom = Math.max(Number.EPSILON, state.zoom);
    this._camera.updateProjectionMatrix();
    this.controls.update();
    this.emitChange();
  }

  private updateControls(): boolean {
    return this.controls.update();
  }

  private resizeProjection(width: number, height: number): void {
    this.aspect = Math.max(1, width) / Math.max(1, height);
    if (this._camera instanceof THREE.PerspectiveCamera) {
      this._camera.aspect = this.aspect;
    } else {
      this._camera.left = -this.aspect;
      this._camera.right = this.aspect;
      this._camera.top = 1;
      this._camera.bottom = -1;
    }
    this._camera.updateProjectionMatrix();
  }

  private applyProjection(projection: Projection): void {
    if (projection === this.projection) return;
    this.projection = projection;
    if (projection === '2d') {
      this.setKind('orthographic');
      this.controls.enableRotate = false;
      this.setView('front');
    } else {
      this.controls.enableRotate = true;
      this.setKind('perspective');
      this.setView('reset');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFly();
    this.inputDisposer();
    this.controls.removeEventListener('change', this.handleControlsChange);
    if (this.element) this.controls.dispose();
    this.listeners.clear();
  }

  private createCamera(kind: CameraKind): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    if (kind === 'orthographic') {
      const camera = new THREE.OrthographicCamera(-this.aspect, this.aspect, 1, -1, 0.001, 1_000);
      camera.position.set(0, 0, 2);
      return camera;
    }
    const camera = new THREE.PerspectiveCamera(this.fov, this.aspect, 0.001, 1_000);
    camera.position.set(0.5, 0.9, 1.6);
    return camera;
  }

  private applyInputMap(): void {
    this.controls.mouseButtons = {
      LEFT: mouseAction(this.inputMap.left),
      MIDDLE: mouseAction(this.inputMap.middle),
      RIGHT: mouseAction(this.inputMap.right),
    };
  }

  private emitChange(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
    this.invalidate();
  }

  private readonly handleControlsChange = (): void => {
    this.emitChange();
  };

  private cancelFly(): void {
    const view = this.element?.ownerDocument.defaultView;
    if (view && this.flyFrame !== 0) view.cancelAnimationFrame(this.flyFrame);
    this.flyFrame = 0;
    const resolve = this.flyResolve;
    this.flyResolve = null;
    resolve?.();
  }

  private installInputWorkaround(element: HTMLElement): () => void {
    const view = element.ownerDocument.defaultView;
    if (!view) return () => {};
    const heldModifiers = { shift: false, meta: false, control: false };
    let activePanPointer: number | null = null;
    let lastPanX = 0;
    let lastPanY = 0;

    const modifiedHeld = (): boolean => (
      heldModifiers.shift || heldModifiers.meta || heldModifiers.control
    );
    const updateModifierState = (event: KeyboardEvent, pressed: boolean): void => {
      if (event.key === 'Shift') heldModifiers.shift = pressed;
      if (event.key === 'Meta') heldModifiers.meta = pressed;
      if (event.key === 'Control') heldModifiers.control = pressed;
      element.style.cursor = modifiedHeld() ? 'grab' : 'default';
    };
    const preparePointer = (event: PointerEvent): void => {
      element.focus({ preventScroll: true });
      const eventModified = event.shiftKey || event.metaKey || event.ctrlKey;
      const modified = eventModified || modifiedHeld();
      const button = event.button;
      if (button !== 0 && button !== 1 && button !== 2) return;
      const action = resolveInputAction(this.inputMap, button, modified);
      element.style.cursor = 'grabbing';
      if (modified && button === 0 && action === 'pan') {
        // Some embedded browser paths report the modifier on keydown but omit
        // it from pointerdown. Own modifier+left panning so that both paths have
        // exactly one pan handler and OrbitControls cannot interpret it as rotate.
        activePanPointer = event.pointerId;
        lastPanX = event.clientX;
        lastPanY = event.clientY;
        element.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const mapped = modified
        ? mouseActionForModified(action, eventModified)
        : mouseAction(action);
      if (button === 0) this.controls.mouseButtons.LEFT = mapped;
      if (button === 1) this.controls.mouseButtons.MIDDLE = mapped;
      if (button === 2) this.controls.mouseButtons.RIGHT = mapped;
      if (action === 'none') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const panPointer = (event: PointerEvent): void => {
      if (activePanPointer !== event.pointerId) return;
      const dx = event.clientX - lastPanX;
      const dy = event.clientY - lastPanY;
      lastPanX = event.clientX;
      lastPanY = event.clientY;
      this._camera.updateMatrix();
      const offset = new THREE.Vector3();
      const horizontal = new THREE.Vector3().setFromMatrixColumn(this._camera.matrix, 0);
      const vertical = new THREE.Vector3().setFromMatrixColumn(this._camera.matrix, 1);
      if (this._camera instanceof THREE.OrthographicCamera) {
        horizontal.multiplyScalar(
          (-dx * (this._camera.right - this._camera.left))
          / (this._camera.zoom * Math.max(1, element.clientWidth)),
        );
        vertical.multiplyScalar(
          (dy * (this._camera.top - this._camera.bottom))
          / (this._camera.zoom * Math.max(1, element.clientHeight)),
        );
      } else {
        const distance = this._camera.position.distanceTo(this.controls.target);
        const worldPerPixel = (
          2 * distance * Math.tan((this._camera.fov * Math.PI) / 360)
        ) / Math.max(1, element.clientHeight);
        horizontal.multiplyScalar(-dx * worldPerPixel);
        vertical.multiplyScalar(dy * worldPerPixel);
      }
      offset.add(horizontal).add(vertical);
      this._camera.position.add(offset);
      this.controls.target.add(offset);
      this.controls.update();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const finishPointer = (event: PointerEvent): void => {
      if (activePanPointer === event.pointerId) {
        activePanPointer = null;
        if (element.hasPointerCapture(event.pointerId)) {
          element.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      this.applyInputMap();
      element.style.cursor = modifiedHeld() ? 'grab' : 'default';
    };
    const handleKeyDown = (event: KeyboardEvent): void => updateModifierState(event, true);
    const handleKeyUp = (event: KeyboardEvent): void => updateModifierState(event, false);
    const clearModifiers = (): void => {
      heldModifiers.shift = false;
      heldModifiers.meta = false;
      heldModifiers.control = false;
      activePanPointer = null;
      this.applyInputMap();
      element.style.cursor = 'default';
    };

    view.addEventListener('keydown', handleKeyDown, true);
    view.addEventListener('keyup', handleKeyUp, true);
    view.addEventListener('blur', clearModifiers);
    element.addEventListener('pointerdown', preparePointer, true);
    element.addEventListener('pointermove', panPointer, true);
    element.addEventListener('pointerup', finishPointer, true);
    element.addEventListener('pointercancel', finishPointer, true);
    this.controls.listenToKeyEvents(element);
    return () => {
      view.removeEventListener('keydown', handleKeyDown, true);
      view.removeEventListener('keyup', handleKeyUp, true);
      view.removeEventListener('blur', clearModifiers);
      element.removeEventListener('pointerdown', preparePointer, true);
      element.removeEventListener('pointermove', panPointer, true);
      element.removeEventListener('pointerup', finishPointer, true);
      element.removeEventListener('pointercancel', finishPointer, true);
      this.controls.stopListenToKeyEvents();
    };
  }
}
