import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Id } from '@atelier/core';

export interface LineStyle {
  color: string;
  width: number;
  dashed?: boolean;
  opacity?: number;
}

export interface OverlayOptions {
  depthTest?: boolean;
  renderOrder?: number;
  /** Attach to this app-owned group instead of the layer's scene-root group. */
  parent?: THREE.Group;
}

/** A caller-created label whose lifecycle is transferred to OverlayLayer. */
export interface CustomOverlayLabel {
  object: THREE.Object3D;
  dispose(): void;
}

type OverlayKind = 'lines' | 'label' | 'points';

interface OverlayEntry {
  kind: OverlayKind;
  object: THREE.Object3D;
  style?: LineStyle;
  texture?: THREE.Texture;
  dispose?: () => void;
}

export const overlayLayerInternal: unique symbol = Symbol('OverlayLayer.internal');

export interface OverlayLayerInternal {
  resize(width: number, height: number): void;
}

/** Screen-width lines, labels, and point markers in one disposable group. */
export class OverlayLayer {
  private readonly group = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly element: HTMLElement | null;
  private readonly invalidate: () => void;
  private readonly entries = new Map<Id, OverlayEntry>();
  private width = 1;
  private height = 1;
  readonly [overlayLayerInternal]: OverlayLayerInternal = {
    resize: (width, height) => this.resizeMaterials(width, height),
  };

  constructor(
    scene: THREE.Scene,
    element: HTMLElement | null = null,
    invalidate: () => void = () => {},
  ) {
    this.scene = scene;
    this.element = element;
    this.invalidate = invalidate;
    this.group.name = 'atelier-overlays';
    this.scene.add(this.group);
  }

  addLines(
    id: Id,
    segments: Float32Array,
    style: LineStyle,
    options: OverlayOptions = {},
  ): void {
    this.remove(id);
    const geometry = new LineSegmentsGeometry().setPositions(segments);
    const material = new LineMaterial({
      color: style.color,
      linewidth: Math.max(0, style.width),
      dashed: style.dashed ?? false,
      transparent: (style.opacity ?? 1) < 1,
      opacity: style.opacity ?? 1,
      depthWrite: false,
      worldUnits: false,
    });
    material.resolution.set(this.width, this.height);
    const lines = new LineSegments2(geometry, material);
    if (style.dashed) lines.computeLineDistances();
    lines.frustumCulled = false;
    this.attach(lines, options, 10);
    this.entries.set(id, {
      kind: 'lines',
      object: lines,
      style: { ...style },
    });
    this.invalidate();
  }

  updateLines(id: Id, segments: Float32Array): void {
    const entry = this.entries.get(id);
    if (!entry || !(entry.object instanceof LineSegments2)) return;
    entry.object.geometry.setPositions(segments);
    if (entry.style?.dashed) entry.object.computeLineDistances();
    this.invalidate();
  }

  addLabel(
    id: Id,
    text: string,
    at: THREE.Vector3,
    mode: 'billboard' | 'flat' = 'billboard',
    options: OverlayOptions = {},
  ): void {
    this.remove(id);
    const label = this.createLabelTexture(text);
    const { texture, aspect } = label;
    let object: THREE.Sprite | THREE.Mesh;
    if (mode === 'billboard') {
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      object = new THREE.Sprite(material);
      object.scale.set(aspect * 0.032, 0.032, 1);
    } else {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      object = new THREE.Mesh(
        new THREE.PlaneGeometry(aspect * 0.032, 0.032),
        material,
      );
    }
    object.position.copy(at);
    this.attach(object, options, 12);
    this.entries.set(id, { kind: 'label', object, texture });
    this.invalidate();
  }

  addPoints(
    id: Id,
    positions: Float32Array,
    style: { color: string; size: number },
    options: OverlayOptions = {},
  ): void {
    this.remove(id);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: style.color,
      size: Math.max(0, style.size),
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.attach(points, options, 11);
    this.entries.set(id, { kind: 'points', object: points });
    this.invalidate();
  }

  /** Replace point positions, reusing the GPU attribute when its length is unchanged. */
  updatePoints(id: Id, positions: Float32Array): void {
    const entry = this.entries.get(id);
    if (!entry || !(entry.object instanceof THREE.Points)) return;
    const current = entry.object.geometry.getAttribute('position');
    if (
      current instanceof THREE.BufferAttribute
      && current.array instanceof Float32Array
      && current.array.length === positions.length
    ) {
      current.array.set(positions);
      current.needsUpdate = true;
    } else {
      entry.object.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions, 3),
      );
    }
    entry.object.geometry.computeBoundingSphere();
    this.invalidate();
  }

  /** Add app-rendered sprite/Object3D label content and assume ownership of its disposer. */
  addCustomLabel(
    id: Id,
    label: CustomOverlayLabel,
    at: THREE.Vector3,
    options: OverlayOptions = {},
  ): void {
    this.remove(id);
    label.object.position.copy(at);
    this.attach(label.object, options, 12);
    this.entries.set(id, {
      kind: 'label',
      object: label.object,
      dispose: () => label.dispose(),
    });
    this.invalidate();
  }

  setVisible(id: Id, visible: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.object.visible = visible;
    this.invalidate();
  }

  setStyle(id: Id, style: Partial<LineStyle>): void {
    const entry = this.entries.get(id);
    if (!entry || !(entry.object instanceof LineSegments2) || !entry.style) return;
    entry.style = { ...entry.style, ...style };
    const material = entry.object.material;
    if (style.color !== undefined) material.color.set(style.color);
    if (style.width !== undefined) material.linewidth = Math.max(0, style.width);
    if (style.opacity !== undefined) {
      material.opacity = style.opacity;
      material.transparent = style.opacity < 1;
    }
    if (style.dashed !== undefined) {
      material.dashed = style.dashed;
      material.needsUpdate = true;
      if (style.dashed) entry.object.computeLineDistances();
    }
    this.invalidate();
  }

  remove(id: Id): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.object.removeFromParent();
    if (entry.dispose) entry.dispose();
    else {
      this.disposeObject(entry.object);
      entry.texture?.dispose();
    }
    this.entries.delete(id);
    this.invalidate();
  }

  clear(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private resizeMaterials(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    for (const entry of this.entries.values()) {
      if (entry.object instanceof LineSegments2) {
        entry.object.material.resolution.set(this.width, this.height);
      }
    }
  }

  private attach(
    object: THREE.Object3D,
    options: OverlayOptions,
    defaultRenderOrder: number,
  ): void {
    object.renderOrder = options.renderOrder ?? defaultRenderOrder;
    if (options.depthTest !== undefined) {
      object.traverse((child) => {
        for (const material of this.getMaterials(child)) {
          material.depthTest = options.depthTest ?? material.depthTest;
          material.needsUpdate = true;
        }
      });
    }
    (options.parent ?? this.group).add(object);
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
  }

  private createLabelTexture(
    text: string,
  ): { texture: THREE.CanvasTexture; aspect: number } {
    const documentRef = this.element?.ownerDocument
      ?? (typeof document === 'undefined' ? null : document);
    if (!documentRef) {
      throw new Error('OverlayLayer.addLabel requires a DOM document');
    }
    const canvas = documentRef.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OverlayLayer.addLabel requires a 2D canvas context');
    context.font = '500 32px sans-serif';
    const measured = Math.ceil(context.measureText(text).width);
    canvas.width = Math.max(64, measured + 32);
    canvas.height = 56;
    context.font = '500 32px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(255,255,255,0.88)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111827';
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return { texture, aspect: canvas.width / canvas.height };
  }

  private disposeObject(object: THREE.Object3D): void {
    if (
      object instanceof THREE.Mesh
      || object instanceof THREE.Points
      || object instanceof THREE.Sprite
    ) {
      if ('geometry' in object && object.geometry instanceof THREE.BufferGeometry) {
        object.geometry.dispose();
      }
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) material.dispose();
    }
  }

  private getMaterials(object: THREE.Object3D): THREE.Material[] {
    if (
      !(object instanceof THREE.Mesh)
      && !(object instanceof THREE.Points)
      && !(object instanceof THREE.Sprite)
      && !(object instanceof THREE.Line)
      && !(object instanceof THREE.LineSegments)
    ) {
      return [];
    }
    return Array.isArray(object.material) ? object.material : [object.material];
  }
}
