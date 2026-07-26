import * as THREE from 'three';
import type { ElementKind, Id } from '@atelier/core';
import type { Vec2 } from '@atelier/geometry';
import { worldToDoc } from './units';

export type PickKind = 'face' | 'edge' | 'vertex' | 'object';

export interface PickHit {
  kind: PickKind;
  id: Id;
  elementKind: ElementKind;
  object: THREE.Object3D;
  point: THREE.Vector3;
  docPoint: Vec2;
  distance: number;
  faceIndex?: number;
  edgeIndex?: number;
  /** The unmodified three.js intersection for semantic/editor-specific picking. */
  intersection?: THREE.Intersection;
  uv?: THREE.Vector2;
  barycoord?: THREE.Vector3 | null;
  instanceId?: number;
}

export interface PickOptions {
  kinds?: PickKind[];
  lineThreshold?: number;
  layers?: number[];
  filter?: (object: THREE.Object3D) => boolean;
}

export interface RaycastOptions {
  /** Explicit roots bypass registration and semantic filtering. Defaults to registered roots. */
  objects?: readonly THREE.Object3D[];
  recursive?: boolean;
  lineThreshold?: number;
  layers?: number[];
  filter?: (object: THREE.Object3D) => boolean;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Registration {
  id: Id;
  elementKind: ElementKind;
  kinds: PickKind[];
}

interface PointerCoordinates {
  clientX: number;
  clientY: number;
}

export function screenToNdc(
  point: PointerCoordinates,
  rect: ScreenRect,
  target = new THREE.Vector2(),
): THREE.Vector2 {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  target.set(
    ((point.clientX - rect.left) / width) * 2 - 1,
    -((point.clientY - rect.top) / height) * 2 + 1,
  );
  return target;
}

function defaultKinds(object: THREE.Object3D): PickKind[] {
  if (object instanceof THREE.Points) return ['vertex', 'object'];
  if (object instanceof THREE.Line || object instanceof THREE.LineSegments) {
    return ['edge', 'object'];
  }
  if (object instanceof THREE.Mesh) return ['face', 'object'];
  return ['object'];
}

/** Real raycasting and screen-space marquee selection over registered objects. */
export class PickService {
  private readonly raycaster = new THREE.Raycaster();
  private readonly getCamera: () => THREE.Camera;
  private readonly element: HTMLElement;
  private readonly registrations = new Map<THREE.Object3D, Registration>();
  private readonly hoverListeners = new Set<(hit: PickHit | null) => void>();
  private readonly pickListeners = new Set<(hit: PickHit | null, event: PointerEvent) => void>();
  private disposed = false;

  constructor(
    camera: THREE.Camera | (() => THREE.Camera),
    element: HTMLElement,
  ) {
    this.getCamera = typeof camera === 'function' ? camera : () => camera;
    this.element = element;
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
  }

  pick(
    event: PointerEvent | PointerCoordinates,
    options?: PickOptions,
  ): PickHit | null {
    return this.pickAt(event, options)[0] ?? null;
  }

  pickAll(
    event: PointerEvent | PointerCoordinates,
    options?: PickOptions,
  ): PickHit[] {
    return this.pickAt(event, options);
  }

  /** Return three's full distance-sorted intersections without semantic deduplication. */
  raycast(
    event: PointerEvent | PointerCoordinates,
    options: RaycastOptions = {},
  ): THREE.Intersection[] {
    const ndc = screenToNdc(event, this.element.getBoundingClientRect());
    this.raycaster.params.Line.threshold = options.lineThreshold ?? 0.03;
    if (this.raycaster.params.Line2) {
      this.raycaster.params.Line2.threshold = options.lineThreshold ?? 0.03;
    }
    this.applyLayers(options.layers);
    this.raycaster.setFromCamera(ndc, this.getCamera());
    const roots = [...(options.objects ?? this.registrations.keys())];
    const objects = options.filter ? roots.filter(options.filter) : roots;
    return this.raycaster.intersectObjects(objects, options.recursive ?? true);
  }

  pickRegion(a: Vec2, b: Vec2, options: PickOptions = {}): PickHit[] {
    const rect = this.element.getBoundingClientRect();
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    const camera = this.getCamera();
    camera.updateMatrixWorld(true);
    const hits: PickHit[] = [];

    for (const [object, registration] of this.registrations) {
      if (!object.visible || !this.matchesOptions(object, registration, options)) continue;
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) continue;
      const corners = this.boxCorners(box);
      let objectLeft = Infinity;
      let objectRight = -Infinity;
      let objectTop = Infinity;
      let objectBottom = -Infinity;
      let inDepthRange = false;
      for (const corner of corners) {
        corner.project(camera);
        if (corner.z >= -1 && corner.z <= 1) inDepthRange = true;
        const x = rect.left + ((corner.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - corner.y) / 2) * rect.height;
        objectLeft = Math.min(objectLeft, x);
        objectRight = Math.max(objectRight, x);
        objectTop = Math.min(objectTop, y);
        objectBottom = Math.max(objectBottom, y);
      }
      const overlaps = inDepthRange
        && objectRight >= left
        && objectLeft <= right
        && objectBottom >= top
        && objectTop <= bottom;
      if (!overlaps) continue;
      const point = box.getCenter(new THREE.Vector3());
      const kind = this.preferredKind(registration, options);
      if (!kind) continue;
      hits.push({
        kind,
        id: registration.id,
        elementKind: registration.elementKind,
        object,
        point,
        docPoint: worldToDoc(point),
        distance: camera.position.distanceTo(point),
      });
    }
    return hits.sort((first, second) => first.distance - second.distance);
  }

  register(
    object: THREE.Object3D,
    id: Id,
    elementKind: ElementKind,
    kinds: PickKind[] = defaultKinds(object),
  ): void {
    const uniqueKinds = [...new Set(kinds)];
    this.registrations.set(object, { id, elementKind, kinds: uniqueKinds });
    object.userData.atelierId = id;
    object.userData.atelierKind = elementKind;
  }

  unregister(object: THREE.Object3D): void {
    if (!this.registrations.delete(object)) return;
    delete object.userData.atelierId;
    delete object.userData.atelierKind;
  }

  onHover(fn: (hit: PickHit | null) => void): () => void {
    this.hoverListeners.add(fn);
    return () => this.hoverListeners.delete(fn);
  }

  onPick(fn: (hit: PickHit | null, event: PointerEvent) => void): () => void {
    this.pickListeners.add(fn);
    return () => this.pickListeners.delete(fn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    for (const object of [...this.registrations.keys()]) this.unregister(object);
    this.hoverListeners.clear();
    this.pickListeners.clear();
  }

  private pickAt(point: PointerCoordinates, options: PickOptions = {}): PickHit[] {
    const objects = [...this.registrations.keys()].filter((object) => {
      const registration = this.registrations.get(object);
      return registration !== undefined
        && object.visible
        && this.matchesOptions(object, registration, options);
    });
    const intersections = this.raycast(point, {
      objects,
      recursive: true,
      lineThreshold: options.lineThreshold,
      layers: options.layers,
    });
    const results: PickHit[] = [];
    const seen = new Set<string>();
    for (const intersection of intersections) {
      const registeredObject = this.registeredAncestor(intersection.object);
      if (!registeredObject) continue;
      const registration = this.registrations.get(registeredObject);
      if (!registration) continue;
      const kind = this.intersectionKind(intersection, registration, options);
      if (!kind) continue;
      const key = `${registeredObject.uuid}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit: PickHit = {
        kind,
        id: registration.id,
        elementKind: registration.elementKind,
        object: registeredObject,
        point: intersection.point.clone(),
        docPoint: worldToDoc(intersection.point),
        distance: intersection.distance,
        intersection,
      };
      if (intersection.faceIndex !== undefined && intersection.faceIndex !== null) {
        hit.faceIndex = intersection.faceIndex;
      }
      if (kind === 'edge' && intersection.index !== undefined) {
        hit.edgeIndex = Math.floor(intersection.index / 2);
      }
      if (intersection.uv) hit.uv = intersection.uv;
      if (intersection.barycoord !== undefined) {
        hit.barycoord = intersection.barycoord;
      }
      if (intersection.instanceId !== undefined) {
        hit.instanceId = intersection.instanceId;
      }
      results.push(hit);
    }
    return results;
  }

  private intersectionKind(
    intersection: THREE.Intersection,
    registration: Registration,
    options: PickOptions,
  ): PickKind | null {
    let nativeKind: PickKind = 'object';
    if (intersection.object instanceof THREE.Points) {
      nativeKind = 'vertex';
    } else if (
      intersection.object instanceof THREE.Line
      || intersection.object instanceof THREE.LineSegments
      || registration.kinds.includes('edge') && !registration.kinds.includes('face')
    ) {
      nativeKind = 'edge';
    } else if (intersection.face !== undefined && intersection.face !== null) {
      nativeKind = 'face';
    }
    const allowed = options.kinds ?? registration.kinds;
    if (registration.kinds.includes(nativeKind) && allowed.includes(nativeKind)) {
      return nativeKind;
    }
    return registration.kinds.find((kind) => allowed.includes(kind)) ?? null;
  }

  private preferredKind(
    registration: Registration,
    options: PickOptions,
  ): PickKind | null {
    const allowed = options.kinds ?? registration.kinds;
    return registration.kinds.find((kind) => allowed.includes(kind)) ?? null;
  }

  private matchesOptions(
    object: THREE.Object3D,
    registration: Registration,
    options: PickOptions,
  ): boolean {
    if (options.filter && !options.filter(object)) return false;
    if (options.kinds && !registration.kinds.some((kind) => options.kinds?.includes(kind))) {
      return false;
    }
    if (options.layers && !options.layers.some((layer) => object.layers.isEnabled(layer))) {
      return false;
    }
    return true;
  }

  private applyLayers(layers: number[] | undefined): void {
    if (!layers || layers.length === 0) {
      this.raycaster.layers.enableAll();
      return;
    }
    this.raycaster.layers.disableAll();
    for (const layer of layers) this.raycaster.layers.enable(layer);
  }

  private registeredAncestor(object: THREE.Object3D): THREE.Object3D | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (this.registrations.has(current)) return current;
      current = current.parent;
    }
    return null;
  }

  private boxCorners(box: THREE.Box3): THREE.Vector3[] {
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

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const hit = this.pick(event);
    for (const listener of this.hoverListeners) listener(hit);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const hit = this.pick(event);
    for (const listener of this.pickListeners) listener(hit, event);
  };
}
