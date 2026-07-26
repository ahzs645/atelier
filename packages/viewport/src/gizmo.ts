import type * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoSpace = 'local' | 'world';
export type GizmoHandle = TransformControls['axis'];

export interface GizmoHandleState {
  axis: GizmoHandle;
  dragging: boolean;
}

type GizmoPlane = 'xy' | 'xz' | 'yz' | null;

export const gizmoServiceInternal: unique symbol = Symbol('GizmoService.internal');

export interface GizmoServiceInternal {
  setCamera(camera: THREE.Camera): void;
}

/** TransformControls wrapper with drag lifecycle and planar constraints. */
export class GizmoService {
  private readonly scene: THREE.Scene;
  private readonly element: HTMLElement | null;
  private readonly orbit: OrbitControls | null;
  private readonly invalidate: () => void;
  private readonly transform: TransformControls;
  private readonly helper: THREE.Object3D;
  private attached: THREE.Object3D | null = null;
  private plane: GizmoPlane = null;
  private planeCoordinate = 0;
  private readonly startListeners = new Set<() => void>();
  private readonly dragListeners = new Set<(object: THREE.Object3D) => void>();
  private readonly endListeners = new Set<(object: THREE.Object3D) => void>();
  private readonly handleStateListeners = new Set<
    (state: GizmoHandleState) => void
  >();
  private handleStateValue: GizmoHandleState = {
    axis: null,
    dragging: false,
  };
  private disposed = false;
  readonly [gizmoServiceInternal]: GizmoServiceInternal = {
    setCamera: (camera) => this.replaceCamera(camera),
  };

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    element: HTMLElement | null = null,
    orbit: OrbitControls | null = null,
    invalidate: () => void = () => {},
  ) {
    this.scene = scene;
    this.element = element;
    this.orbit = orbit;
    this.invalidate = invalidate;
    this.transform = new TransformControls(camera, element);
    this.helper = this.transform.getHelper();
    this.scene.add(this.helper);
    this.transform.addEventListener('mouseDown', this.handleMouseDown);
    this.transform.addEventListener('objectChange', this.handleObjectChange);
    this.transform.addEventListener('mouseUp', this.handleMouseUp);
    this.transform.addEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.addEventListener('axis-changed', this.handleAxisChanged);
  }

  attach(object: THREE.Object3D, mode: GizmoMode = 'translate'): void {
    this.attached = object;
    this.setMode(mode);
    this.transform.attach(object);
    this.invalidate();
  }

  detach(): void {
    this.attached = null;
    this.transform.detach();
    if (this.orbit && this.handleStateValue.dragging) this.orbit.enabled = true;
    this.syncHandleState(null, false);
    this.invalidate();
  }

  setMode(mode: GizmoMode): void {
    this.transform.setMode(mode);
    this.applyPlaneVisibility();
    this.invalidate();
  }

  setSpace(space: GizmoSpace): void {
    this.transform.setSpace(space);
    this.invalidate();
  }

  get space(): GizmoSpace {
    return this.transform.space;
  }

  get handleState(): GizmoHandleState {
    return { ...this.handleStateValue };
  }

  setPlane(plane: GizmoPlane): void {
    this.plane = plane;
    this.applyPlaneVisibility();
    this.invalidate();
  }

  onDragStart(fn: () => void): () => void {
    this.startListeners.add(fn);
    return () => this.startListeners.delete(fn);
  }

  onDrag(fn: (object: THREE.Object3D) => void): () => void {
    this.dragListeners.add(fn);
    return () => this.dragListeners.delete(fn);
  }

  onDragEnd(fn: (object: THREE.Object3D) => void): () => void {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  onHandleStateChange(fn: (state: GizmoHandleState) => void): () => void {
    this.handleStateListeners.add(fn);
    return () => this.handleStateListeners.delete(fn);
  }

  private replaceCamera(camera: THREE.Camera): void {
    this.transform.camera = camera;
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.transform.removeEventListener('mouseDown', this.handleMouseDown);
    this.transform.removeEventListener('objectChange', this.handleObjectChange);
    this.transform.removeEventListener('mouseUp', this.handleMouseUp);
    this.transform.removeEventListener('dragging-changed', this.handleDraggingChanged);
    this.transform.removeEventListener('axis-changed', this.handleAxisChanged);
    this.scene.remove(this.helper);
    if (this.element) this.transform.dispose();
    else if ('dispose' in this.helper && typeof this.helper.dispose === 'function') {
      this.helper.dispose();
    }
    this.startListeners.clear();
    this.dragListeners.clear();
    this.endListeners.clear();
    this.handleStateListeners.clear();
  }

  private applyPlaneVisibility(): void {
    if (this.plane === null) {
      this.transform.showX = true;
      this.transform.showY = true;
      this.transform.showZ = true;
      this.transform.showXY = true;
      this.transform.showXZ = true;
      this.transform.showYZ = true;
      return;
    }
    const rotate = this.transform.getMode() === 'rotate';
    const normal = this.plane === 'xy' ? 'z' : this.plane === 'xz' ? 'y' : 'x';
    this.transform.showX = rotate ? normal === 'x' : normal !== 'x';
    this.transform.showY = rotate ? normal === 'y' : normal !== 'y';
    this.transform.showZ = rotate ? normal === 'z' : normal !== 'z';
    this.transform.showXY = !rotate && this.plane === 'xy';
    this.transform.showXZ = !rotate && this.plane === 'xz';
    this.transform.showYZ = !rotate && this.plane === 'yz';
  }

  private constrainToPlane(object: THREE.Object3D): void {
    if (this.plane === null || this.transform.getMode() !== 'translate') return;
    if (this.plane === 'xy') object.position.z = this.planeCoordinate;
    else if (this.plane === 'xz') object.position.y = this.planeCoordinate;
    else object.position.x = this.planeCoordinate;
  }

  private readonly handleMouseDown = (): void => {
    if (!this.attached) return;
    if (this.plane === 'xy') this.planeCoordinate = this.attached.position.z;
    else if (this.plane === 'xz') this.planeCoordinate = this.attached.position.y;
    else if (this.plane === 'yz') this.planeCoordinate = this.attached.position.x;
    this.syncHandleState();
    for (const listener of this.startListeners) listener();
  };

  private readonly handleObjectChange = (): void => {
    if (!this.attached) return;
    this.constrainToPlane(this.attached);
    for (const listener of this.dragListeners) listener(this.attached);
    this.invalidate();
  };

  private readonly handleMouseUp = (): void => {
    if (!this.attached) return;
    for (const listener of this.endListeners) listener(this.attached);
    this.syncHandleState();
    this.invalidate();
  };

  private readonly handleDraggingChanged = (event: { value: unknown }): void => {
    if (typeof event.value === 'boolean') {
      if (this.orbit) this.orbit.enabled = !event.value;
      this.syncHandleState(this.transform.axis, event.value);
    }
  };

  private readonly handleAxisChanged = (): void => {
    this.syncHandleState();
  };

  private syncHandleState(
    axis: GizmoHandle = this.transform.axis,
    dragging = this.transform.dragging,
  ): void {
    if (
      axis === this.handleStateValue.axis
      && dragging === this.handleStateValue.dragging
    ) {
      return;
    }
    this.handleStateValue = { axis, dragging };
    const state = this.handleState;
    for (const listener of this.handleStateListeners) listener(state);
  }
}
