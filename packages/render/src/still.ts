import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { denoiseImage } from './denoise';
import type { DenoiseQuality } from './denoise';

export type StillRenderStage =
  | 'preparing'
  | 'sampling'
  | 'denoising'
  | 'complete';

export interface StillRenderProgress {
  stage: StillRenderStage;
  progress: number;
  sample: number;
  samples: number;
}

export interface StillRenderSource {
  scene: THREE.Scene;
  camera: THREE.Camera;
}

/** Public controls shared by the live preview and the path-traced still. */
export interface StillStudioSettings {
  backgroundColor: string;
  floorVisible: boolean;
  floorColor: string;
  keyAngle: number;
  keyIntensity: number;
  fillIntensity: number;
  ambientIntensity: number;
  fov: number;
}

export const DEFAULT_STILL_STUDIO_SETTINGS: Readonly<StillStudioSettings> = {
  backgroundColor: '#ffffff',
  floorVisible: true,
  floorColor: '#f4f4f4',
  keyAngle: 60,
  keyIntensity: 8,
  fillIntensity: 4,
  ambientIntensity: 0.25,
  fov: 15,
};

export interface StillRenderOptions {
  width: number;
  height: number;
  samples?: number;
  bounces?: number;
  exposure?: number;
  autoFrame?: boolean;
  studio?: boolean;
  studioSettings?: Partial<StillStudioSettings>;
  /** Camera captured from the live studio preview. */
  studioCamera?: THREE.Camera;
  denoise?: boolean;
  denoiseQuality?: DenoiseQuality;
  denoiseWeightsUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: StillRenderProgress) => void;
}

export interface StillRenderResult {
  blob: Blob;
  image: ImageData;
  samples: number;
  denoised: boolean;
  denoiseError: Error | null;
}

export class RenderCancelledError extends Error {
  constructor() {
    super('Render cancelled.');
    this.name = 'RenderCancelledError';
  }
}

export function validateStillRenderOptions(options: StillRenderOptions): void {
  if (!Number.isInteger(options.width) || options.width < 16 || options.width > 4096) {
    throw new RangeError('Render width must be an integer from 16 to 4096.');
  }
  if (!Number.isInteger(options.height) || options.height < 16 || options.height > 4096) {
    throw new RangeError('Render height must be an integer from 16 to 4096.');
  }
  const samples = options.samples ?? 64;
  if (!Number.isInteger(samples) || samples < 1 || samples > 4096) {
    throw new RangeError('Render samples must be an integer from 1 to 4096.');
  }
  const bounces = options.bounces ?? 3;
  if (!Number.isInteger(bounces) || bounces < 1 || bounces > 32) {
    throw new RangeError('Render bounces must be an integer from 1 to 32.');
  }
  const exposure = options.exposure ?? 1;
  if (!Number.isFinite(exposure) || exposure < 0.05 || exposure > 4) {
    throw new RangeError('Render exposure must be from 0.05 to 4.');
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelledError();
}

function report(
  options: StillRenderOptions,
  stage: StillRenderStage,
  progress: number,
  sample: number,
  samples: number,
): void {
  options.onProgress?.({
    stage,
    progress: THREE.MathUtils.clamp(progress, 0, 1),
    sample,
    samples,
  });
}

function cloneCameraForAspect(
  source: THREE.Camera,
  aspect: number,
): THREE.Camera {
  const camera = source.clone();
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    const height = Math.abs(camera.top - camera.bottom);
    const center = (camera.left + camera.right) / 2;
    const width = height * aspect;
    camera.left = center - width / 2;
    camera.right = center + width / 2;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld(true);
  return camera;
}

function pathTracingMaterial(
  source: THREE.Material,
  preserveMaterialSides: boolean,
): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | null {
  if (!source.visible) {
    return new THREE.MeshStandardMaterial({
      opacity: 0,
      transparent: true,
    });
  }
  if (
    source instanceof THREE.MeshStandardMaterial
    || source instanceof THREE.MeshPhysicalMaterial
  ) {
    if (!preserveMaterialSides && source.side === THREE.BackSide) {
      const material = source.clone();
      // The direct PackCAD slab keeps both sheets on shared winding and uses
      // BackSide as a raster-only selection device. Trace the inner sheet from
      // either direction; the opaque outer sheet is physically closer from
      // the exterior, while this guarantees that inner stock and its sparse
      // alpha-tested print remain the first valid hits from the interior.
      material.side = THREE.DoubleSide;
      return material;
    }
    return source;
  }
  if (source instanceof THREE.ShadowMaterial) return null;
  const material = source as THREE.Material & {
    alphaMap?: THREE.Texture | null;
    alphaTest?: number;
    color?: THREE.Color;
    map?: THREE.Texture | null;
    opacity?: number;
    transparent?: boolean;
    vertexColors?: boolean;
  };
  return new THREE.MeshStandardMaterial({
    alphaMap: material.alphaMap ?? null,
    alphaTest: material.alphaTest ?? 0,
    color: material.color?.clone() ?? new THREE.Color(0xffffff),
    map: material.map ?? null,
    opacity: material.opacity ?? 1,
    side: source.side,
    transparent: material.transparent ?? false,
    vertexColors: material.vertexColors ?? false,
  });
}

function sliceGeometry(
  source: THREE.BufferGeometry,
  start: number,
  count: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const [name, sourceAttribute] of Object.entries(source.attributes)) {
    const attribute = sourceAttribute as THREE.BufferAttribute;
    const values = new Float32Array(count * attribute.itemSize);
    for (let index = 0; index < count; index += 1) {
      const sourceIndex = start + index;
      const offset = index * attribute.itemSize;
      values[offset] = attribute.getX(sourceIndex);
      if (attribute.itemSize > 1) values[offset + 1] = attribute.getY(sourceIndex);
      if (attribute.itemSize > 2) values[offset + 2] = attribute.getZ(sourceIndex);
      if (attribute.itemSize > 3) values[offset + 3] = attribute.getW(sourceIndex);
    }
    geometry.setAttribute(
      name,
      new THREE.BufferAttribute(values, attribute.itemSize, false),
    );
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function splitMultiMaterialMeshes(
  scene: THREE.Scene,
  ownedGeometries: Set<THREE.BufferGeometry>,
): void {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && Array.isArray(object.material)) {
      meshes.push(object);
    }
  });
  for (const mesh of meshes) {
    const parent = mesh.parent;
    if (!parent || !Array.isArray(mesh.material)) continue;
    const materials = mesh.material;
    const sourceGeometry = mesh.geometry.index
      ? mesh.geometry.toNonIndexed()
      : mesh.geometry;
    const groups = sourceGeometry.groups.length > 0
      ? sourceGeometry.groups
      : [{ start: 0, count: sourceGeometry.getAttribute('position').count, materialIndex: 0 }];
    groups.forEach((group, groupIndex) => {
      const material = materials[group.materialIndex ?? 0];
      if (!material || !material.visible) return;
      const geometry = sliceGeometry(sourceGeometry, group.start, group.count);
      ownedGeometries.add(geometry);
      const primitive = new THREE.Mesh(geometry, material);
      primitive.name = `${mesh.name || 'mesh'} [material ${group.materialIndex ?? groupIndex}]`;
      primitive.position.copy(mesh.position);
      primitive.quaternion.copy(mesh.quaternion);
      primitive.scale.copy(mesh.scale);
      primitive.matrix.copy(mesh.matrix);
      primitive.matrixAutoUpdate = mesh.matrixAutoUpdate;
      primitive.matrixWorldAutoUpdate = mesh.matrixWorldAutoUpdate;
      primitive.castShadow = mesh.castShadow;
      primitive.receiveShadow = mesh.receiveShadow;
      primitive.renderOrder = mesh.renderOrder;
      primitive.frustumCulled = mesh.frustumCulled;
      primitive.layers.mask = mesh.layers.mask;
      primitive.visible = mesh.visible;
      primitive.userData = { ...mesh.userData };
      parent.add(primitive);
    });
    mesh.removeFromParent();
    if (sourceGeometry !== mesh.geometry) sourceGeometry.dispose();
  }
}

export function prepareSceneForPathTracing(
  source: THREE.Scene,
  options: { preserveMaterialSides?: boolean } = {},
): {
  scene: THREE.Scene;
  dispose: () => void;
} {
  const scene = source.clone(true);
  // Remove controls before asking the cloned scene to update. Their internal
  // helper subtree retains callbacks that expect the original private control
  // owner and will throw while calculating cloned world matrices.
  const clonedControls: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (object.constructor.name.startsWith('TransformControls')) {
      clonedControls.push(object);
    }
  });
  clonedControls.forEach((object) => object.removeFromParent());
  // Raster shadow catchers and editor-only overlays are replaced by the
  // physical studio sweep below. Leaving the catcher in the scene both hides
  // it later (ShadowMaterial is unsupported by the tracer) and incorrectly
  // expands camera framing to the helper's 12-unit square.
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.name === 'PackCAD locked face tint'
      || object.name === 'PackCAD selected face tint') {
      object.visible = false;
      return;
    }
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    // three/examples fat lines (Line2 / LineSegments2) subclass Mesh rather
    // than THREE.Line. Their four-vertex screen-space ribbon geometry becomes
    // a large opaque quad if it is treated as an ordinary surface and its
    // LineMaterial is normalized to MeshStandardMaterial.
    if (materials.some((material) => material.type === 'LineMaterial')) {
      object.visible = false;
      return;
    }
    if (materials.length > 0 && materials.every(
      (material) => material instanceof THREE.ShadowMaterial,
    )) {
      object.visible = false;
    }
  });
  scene.updateMatrixWorld(true);
  const sceneBounds = new THREE.Box3();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && isWorldVisible(object)) {
      sceneBounds.expandByObject(object, true);
    }
  });
  const sceneDiagonal = sceneBounds.isEmpty()
    ? 1
    : sceneBounds.getSize(new THREE.Vector3()).length();
  // The interactive renderer uses polygon offset for print layers. A ray
  // tracer has no depth buffer, so coincident artwork and board triangles race
  // for the same first hit. Use a scale-aware physical separation: large
  // enough to survive BVH precision, but at most one hundredth of a scene unit
  // so it remains visually inseparable from the substrate.
  const printLayerOffset = THREE.MathUtils.clamp(
    sceneDiagonal * 1e-3,
    1e-3,
    2e-2,
  );
  const ownedMaterials = new Set<THREE.Material>();
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  splitMultiMaterialMeshes(scene, ownedGeometries);
  scene.traverse((object) => {
    // TransformControls adds an internal scene subtree whose cloned root no
    // longer has the private control reference used by updateMatrixWorld.
    // Gizmos are editor chrome in any case, so keep them out of stills.
    if (object.constructor.name.startsWith('TransformControls')) {
      return;
    }
    if (
      object instanceof THREE.Line
      || object instanceof THREE.LineSegments
      || object instanceof THREE.Points
      || object instanceof THREE.AxesHelper
      || object instanceof THREE.GridHelper
    ) {
      object.visible = false;
      return;
    }
    if (!(object instanceof THREE.Mesh) || !isWorldVisible(object)) return;
    const sources = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const isOverlay = (material: THREE.Material): boolean =>
      material.transparent
      && material.polygonOffset
      && material.polygonOffsetFactor < 0;
    if (sources.some(isOverlay)) {
      // Raster polygon offset has no equivalent in ray tracing. Give print or
      // decal layers a microscopic normal offset so their coplanar base mesh
      // cannot win the same ray intersection nondeterministically.
      let geometry = ownedGeometries.has(object.geometry)
        ? object.geometry
        : object.geometry.clone();
      if (geometry.index) {
        const nonIndexed = geometry.toNonIndexed();
        if (geometry !== object.geometry) geometry.dispose();
        geometry = nonIndexed;
      }
      const position = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      if (position && normal) {
        const offsetRange = (
          start: number,
          count: number,
          material: THREE.Material,
        ): void => {
          if (!isOverlay(material)) return;
          const configured = material.userData.atelierLayerOffsetDirection;
          const direction = typeof configured === 'number'
            ? Math.sign(configured)
            : material.side === THREE.BackSide
              ? -1
              : 1;
          for (let index = start; index < start + count; index += 1) {
            position.setXYZ(
              index,
              position.getX(index) + normal.getX(index) * printLayerOffset * direction,
              position.getY(index) + normal.getY(index) * printLayerOffset * direction,
              position.getZ(index) + normal.getZ(index) * printLayerOffset * direction,
            );
          }
        };
        if (geometry.groups.length > 0) {
          geometry.groups.forEach((group: {
            start: number;
            count: number;
            materialIndex?: number;
          }) => {
            const material = sources[group.materialIndex ?? 0];
            if (material) offsetRange(group.start, group.count, material);
          });
        } else if (sources[0]) {
          offsetRange(0, position.count, sources[0]);
        }
        position.needsUpdate = true;
        object.geometry = geometry;
        ownedGeometries.add(geometry);
      } else {
        geometry.dispose();
      }
    }
    const converted = sources.map((material) => pathTracingMaterial(
      material,
      options.preserveMaterialSides ?? false,
    ));
    if (converted.some((material) => material === null)) {
      object.visible = false;
      return;
    }
    converted.forEach((material, index) => {
      if (material !== sources[index] && material) ownedMaterials.add(material);
    });
    object.material = Array.isArray(object.material)
      ? converted as THREE.Material[]
      : converted[0] as THREE.Material;
  });
  return {
    scene,
    dispose: () => {
      ownedMaterials.forEach((material) => material.dispose());
      ownedGeometries.forEach((geometry) => geometry.dispose());
      scene.clear();
    },
  };
}

export interface StudioPreparation {
  camera: THREE.Camera;
  target: THREE.Vector3;
  update: (settings: Partial<StillStudioSettings>) => void;
  dispose: () => void;
}

function visibleMeshBounds(scene: THREE.Scene): THREE.Box3 {
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && isWorldVisible(object)) {
      bounds.expandByObject(object, true);
    }
  });
  return bounds;
}

function studioEnvironment(): THREE.DataTexture {
  const width = 128;
  const height = 64;
  const data = new Float32Array(width * height * 4);
  const top = new THREE.Color('#eef4ff');
  const bottom = new THREE.Color('#fefefe');
  const color = new THREE.Color();
  for (let y = 0; y < height; y += 1) {
    const mix = Math.pow(y / (height - 1), 1.7);
    color.copy(top).lerp(bottom, mix);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function resolveStudioSettings(
  settings: Partial<StillStudioSettings> = {},
): StillStudioSettings {
  return { ...DEFAULT_STILL_STUDIO_SETTINGS, ...settings };
}

export function prepareStudioScene(
  scene: THREE.Scene,
  aspect: number,
  initialSettings: Partial<StillStudioSettings> = {},
  cameraOverride?: THREE.Camera,
  rasterShadows = false,
): StudioPreparation {
  let settings = resolveStudioSettings(initialSettings);
  const bounds = visibleMeshBounds(scene);
  if (bounds.isEmpty()) {
    throw new Error('The scene has no visible mesh to render.');
  }
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-4);
  const center = sphere.center;
  const groundBounds = new THREE.Box3();
  const groundVertex = new THREE.Vector3();
  const groundThreshold = bounds.min.y + radius * 0.08;
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !isWorldVisible(object)) return;
    const position = object.geometry.getAttribute('position');
    if (!position) return;
    for (let index = 0; index < position.count; index += 1) {
      groundVertex.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
      if (groundVertex.y <= groundThreshold) groundBounds.expandByPoint(groundVertex);
    }
  });
  const groundCenter = groundBounds.isEmpty()
    ? center.clone()
    : groundBounds.getCenter(new THREE.Vector3());

  // Match the reference renderer's authored 90 mm / 36 x 24 mm camera and
  // default 35° orbit, compensating for PackCAD's graph-to-Atelier axis
  // conversion by rotating the horizontal orbit half a turn. A studio still
  // should be deterministic even when the editor is currently in 2D or its
  // last 3D orbit was left behind the package.
  const fov = settings.fov;
  // Box fitting and the reference worker's sphere fitting express padding in
  // opposite ways. This value matches the reference's visible 1.05 framing.
  const fillRatio = 0.85;
  const camera = cameraOverride
    ? cloneCameraForAspect(cameraOverride, aspect)
    : new THREE.PerspectiveCamera(
        fov,
        aspect,
        Math.max(radius * 1e-3, 1e-5),
        radius * 100,
      );
  const azimuth = THREE.MathUtils.degToRad(35 + 180);
  const elevation = THREE.MathUtils.degToRad(18);
  const horizontal = Math.cos(elevation);
  const direction = new THREE.Vector3(
    horizontal * Math.sin(azimuth),
    Math.sin(elevation),
    horizontal * Math.cos(azimuth),
  );
  if (!cameraOverride) {
    camera.position.copy(center).addScaledVector(direction, radius * 10);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const tanHorizontal = tanVertical * aspect;
    let distance = radius;
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const relative = new THREE.Vector3(x, y, z).sub(center);
          distance = Math.max(
            distance,
            relative.dot(direction) + fillRatio * Math.max(
              Math.abs(relative.dot(right)) / tanHorizontal,
              Math.abs(relative.dot(up)) / tanVertical,
            ),
          );
        }
      }
    }
    camera.position.copy(center).addScaledVector(direction, distance);
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    perspectiveCamera.near = Math.max(distance - radius * 2, radius * 1e-3);
    perspectiveCamera.far = distance + radius * 4;
    camera.lookAt(center);
    perspectiveCamera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  const removedLights: THREE.Light[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Light) removedLights.push(object);
  });
  removedLights.forEach((light) => light.removeFromParent());

  const lightPosition = (
    azimuthDegrees: number,
    elevationDegrees: number,
    distanceRadii: number,
  ): THREE.Vector3 => {
    const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
    const elevation = THREE.MathUtils.degToRad(elevationDegrees);
    const horizontal = Math.cos(elevation) * distanceRadii * radius;
    return center.clone().add(new THREE.Vector3(
      horizontal * Math.sin(azimuth),
      Math.sin(elevation) * distanceRadii * radius,
      horizontal * Math.cos(azimuth),
    ));
  };
  const key = new THREE.RectAreaLight(
    '#eef4ff',
    settings.keyIntensity,
    3.5 * radius,
    3.5 * radius,
  );
  key.name = 'Atelier studio key';
  key.position.copy(lightPosition(settings.keyAngle, 35, 3.4));
  key.lookAt(center);
  const fill = new THREE.RectAreaLight(
    '#fefefe',
    settings.fillIntensity,
    5.6 * radius,
    5.6 * radius,
  );
  fill.name = 'Atelier studio fill';
  fill.position.copy(lightPosition(-30, 18, 6.7));
  fill.lookAt(center);
  scene.add(key, fill);

  // Rect area lights are faithful in the path tracer, but WebGL does not cast
  // shadows from them. The preview gets a low-energy directional surrogate so
  // the automatic studio floor still communicates contact and depth.
  const shadowTarget = new THREE.Object3D();
  shadowTarget.position.copy(center);
  const previewShadow = new THREE.DirectionalLight('#eef4ff', 0);
  previewShadow.name = 'Atelier studio preview shadow';
  previewShadow.target = shadowTarget;
  previewShadow.castShadow = rasterShadows;
  previewShadow.shadow.mapSize.set(1024, 1024);
  previewShadow.shadow.camera.left = -radius * 3;
  previewShadow.shadow.camera.right = radius * 3;
  previewShadow.shadow.camera.top = radius * 3;
  previewShadow.shadow.camera.bottom = -radius * 3;
  previewShadow.shadow.camera.near = radius * 0.01;
  previewShadow.shadow.camera.far = radius * 12;
  previewShadow.shadow.bias = -0.00005;
  previewShadow.shadow.normalBias = radius * 0.00015;
  if (rasterShadows) scene.add(shadowTarget, previewShadow);

  const floorGeometry = new THREE.PlaneGeometry(radius * 12, radius * 12);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: settings.floorColor,
    metalness: 0,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.name = 'Atelier studio sweep';
  floor.rotation.x = -Math.PI / 2;
  // Keep the receiver just below the lowest board surface. The previous 1.5%
  // radius gap was large enough to detach the raster shadow and make the model
  // appear to float at live-preview scale.
  floor.position.set(center.x, bounds.min.y - radius * 0.002, center.z);
  floor.receiveShadow = true;
  scene.add(floor);

  // The path tracer does not reliably composite a plain Scene.background on
  // every low-sample tile. A large emissive studio shell gives primary rays a
  // real, deterministic backdrop while the floor remains the contact surface.
  // This also produces the reference preview's soft gray room instead of a
  // black strip above the finite floor.
  const backdropGeometry = new THREE.SphereGeometry(radius * 30, 48, 24);
  const backdropMaterial = new THREE.MeshStandardMaterial({
    color: settings.backgroundColor,
    emissive: settings.backgroundColor,
    emissiveIntensity: 0.45,
    metalness: 0,
    roughness: 1,
    side: THREE.BackSide,
  });
  const backdrop = new THREE.Mesh(backdropGeometry, backdropMaterial);
  backdrop.name = 'Atelier studio backdrop';
  backdrop.position.copy(center);
  backdrop.receiveShadow = false;
  scene.add(backdrop);

  // The source preview supplements its raster lighting with a soft contact
  // shadow. RectAreaLight has no WebGL shadow map, so use a single transparent
  // receiver decal in the live preview only. Vertex alpha provides the soft
  // falloff in one draw; a dense stack of transparent disks is costly while
  // orbiting and creates visible rings. The final path trace does not add this
  // mesh and calculates the physical area-light shadow.
  const contactShadow = new THREE.Group();
  contactShadow.name = 'Atelier studio contact shadow';
  const contactShadowGeometries: THREE.BufferGeometry[] = [];
  const contactShadowMaterials: THREE.Material[] = [];
  const contactShadowLayers = [{ x: 0.9, z: 0.56 }];
  contactShadowLayers.forEach((layer, index) => {
    const geometry = new THREE.CircleGeometry(1, 64);
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 4);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const radialDistance = Math.min(
        1,
        Math.hypot(position.getX(vertex), position.getY(vertex)),
      );
      const offset = vertex * 4;
      colors[offset] = 1;
      colors[offset + 1] = 1;
      colors[offset + 2] = 1;
      colors[offset + 3] = 0.14 * (1 - radialDistance);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const material = new THREE.MeshBasicMaterial({
      color: '#0e0f13',
      depthWrite: false,
      side: THREE.DoubleSide,
      transparent: true,
      vertexColors: true,
    });
    const layerMesh = new THREE.Mesh(geometry, material);
    layerMesh.name = `Atelier studio contact shadow ${index + 1}`;
    layerMesh.rotation.x = -Math.PI / 2;
    layerMesh.scale.set(radius * layer.x, radius * layer.z, 1);
    layerMesh.renderOrder = 1;
    layerMesh.castShadow = false;
    layerMesh.receiveShadow = false;
    contactShadow.add(layerMesh);
    contactShadowGeometries.push(geometry);
    contactShadowMaterials.push(material);
  });
  if (rasterShadows) scene.add(contactShadow);

  if (rasterShadows) {
    scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh
        && object !== floor
        && object !== backdrop
        && object.parent !== contactShadow
      ) {
        object.castShadow = true;
      }
    });
  }

  const environment = studioEnvironment();
  scene.environment = environment;
  scene.environmentIntensity = settings.ambientIntensity * 4;
  scene.background = new THREE.Color(settings.backgroundColor);

  const update = (next: Partial<StillStudioSettings>): void => {
    settings = { ...settings, ...next };
    // In WebGL, RectAreaLight cannot cast shadows. Transfer part of the key's
    // energy to the directional surrogate rather than adding a nearly
    // invisible shadow light on top of the full area-light contribution.
    key.intensity = rasterShadows
      ? settings.keyIntensity * 0.65
      : settings.keyIntensity;
    key.position.copy(lightPosition(settings.keyAngle, 35, 3.4));
    key.lookAt(center);
    fill.intensity = settings.fillIntensity;
    previewShadow.intensity = rasterShadows ? settings.keyIntensity * 0.35 : 0;
    previewShadow.position.copy(lightPosition(settings.keyAngle, 35, 5));
    previewShadow.target.updateMatrixWorld();
    floor.visible = settings.floorVisible;
    floorMaterial.color.set(settings.floorColor);
    contactShadow.position.set(
      groundCenter.x,
      // Above the receiver, but still below the lowest model vertex. This
      // prevents the decal from clipping through the cardboard while orbiting.
      floor.position.y + radius * 0.0005,
      groundCenter.z,
    );
    contactShadow.visible = rasterShadows && settings.floorVisible;
    backdropMaterial.color.set(settings.backgroundColor);
    backdropMaterial.emissive.set(settings.backgroundColor);
    scene.environmentIntensity = settings.ambientIntensity * 4;
    scene.background = new THREE.Color(settings.backgroundColor);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = settings.fov;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  };
  update(settings);

  return {
    camera,
    target: center.clone(),
    update,
    dispose: () => {
      key.removeFromParent();
      fill.removeFromParent();
      floor.removeFromParent();
      backdrop.removeFromParent();
      contactShadow.removeFromParent();
      previewShadow.removeFromParent();
      shadowTarget.removeFromParent();
      key.dispose();
      fill.dispose();
      floorGeometry.dispose();
      floorMaterial.dispose();
      backdropGeometry.dispose();
      backdropMaterial.dispose();
      contactShadowGeometries.forEach((geometry) => geometry.dispose());
      contactShadowMaterials.forEach((material) => material.dispose());
      previewShadow.dispose();
      environment.dispose();
    },
  };
}

function isWorldVisible(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function frameOrthographicCamera(
  camera: THREE.OrthographicCamera,
  scene: THREE.Scene,
  padding = 1.15,
): void {
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && isWorldVisible(object)) {
      bounds.expandByObject(object, true);
    }
  });
  if (bounds.isEmpty()) return;

  const center = bounds.getCenter(new THREE.Vector3());
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const distance = Math.max(camera.position.distanceTo(center), 0.001);
  camera.position.copy(center).addScaledVector(direction, -distance);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);

  const size = bounds.getSize(new THREE.Vector3());
  const boxCenter = bounds.getCenter(new THREE.Vector3());
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) {
        const corner = new THREE.Vector3(
          boxCenter.x + size.x * x,
          boxCenter.y + size.y * y,
          boxCenter.z + size.z * z,
        ).applyMatrix4(camera.matrixWorldInverse);
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
      }
    }
  }
  const projectedWidth = Math.max(maxX - minX, 0.0001);
  const projectedHeight = Math.max(maxY - minY, 0.0001);
  camera.zoom = Math.min(
    Math.abs(camera.right - camera.left) / (projectedWidth * padding),
    Math.abs(camera.top - camera.bottom) / (projectedHeight * padding),
  );
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

function canvasImageData(canvas: HTMLCanvasElement): ImageData {
  const output = document.createElement('canvas');
  output.width = canvas.width;
  output.height = canvas.height;
  const context = output.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create the render output canvas.');
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, output.width, output.height);
}

function imageDataBlob(image: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the PNG output canvas.');
  context.putImageData(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encoding failed.'));
    }, 'image/png');
  });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16));
}

function rasterGuide(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  kind: 'albedo' | 'normal',
): ImageData {
  const previousToneMapping = renderer.toneMapping;
  const previousOverride = scene.overrideMaterial;
  const replacements: Array<{
    mesh: THREE.Mesh;
    material: THREE.Material | THREE.Material[];
  }> = [];
  const owned: THREE.Material[] = [];
  try {
    renderer.toneMapping = THREE.NoToneMapping;
    if (kind === 'normal') {
      const normalMaterial = new THREE.MeshNormalMaterial();
      normalMaterial.toneMapped = false;
      owned.push(normalMaterial);
      scene.overrideMaterial = normalMaterial;
    } else {
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const original = object.material;
        const sourceMaterials = Array.isArray(original) ? original : [original];
        const guideMaterials = sourceMaterials.map((source) => {
          const material = source as THREE.Material & {
            alphaTest?: number;
            color?: THREE.Color;
            map?: THREE.Texture | null;
            opacity?: number;
            transparent?: boolean;
          };
          const guide = new THREE.MeshBasicMaterial({
            alphaTest: material.alphaTest ?? 0,
            color: material.color?.clone() ?? new THREE.Color(0xffffff),
            map: material.map ?? null,
            opacity: material.opacity ?? 1,
            side: source.side,
            transparent: material.transparent ?? false,
          });
          guide.toneMapped = false;
          owned.push(guide);
          return guide;
        });
        replacements.push({ mesh: object, material: original });
        object.material = Array.isArray(original)
          ? guideMaterials
          : guideMaterials[0];
      });
    }
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, camera);
    return canvasImageData(renderer.domElement);
  } finally {
    scene.overrideMaterial = previousOverride;
    replacements.forEach(({ mesh, material }) => {
      mesh.material = material;
    });
    owned.forEach((material) => material.dispose());
    renderer.toneMapping = previousToneMapping;
  }
}

export async function renderStill(
  source: StillRenderSource,
  options: StillRenderOptions,
): Promise<StillRenderResult> {
  validateStillRenderOptions(options);
  assertNotAborted(options.signal);
  const samples = options.samples ?? 64;
  const bounces = options.bounces ?? 3;
  report(options, 'preparing', 0, 0, samples);

  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(options.width, options.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = options.exposure ?? (options.studio ? 0.35 : 1);

  let camera = cloneCameraForAspect(
    source.camera,
    options.width / options.height,
  );
  const prepared = prepareSceneForPathTracing(source.scene);
  const studio = options.studio
    ? prepareStudioScene(
        prepared.scene,
        options.width / options.height,
        options.studioSettings,
        options.studioCamera,
      )
    : null;
  if (studio) {
    camera = studio.camera;
  } else if (options.autoFrame && camera instanceof THREE.OrthographicCamera) {
    frameOrthographicCamera(camera, prepared.scene);
  }
  const pathTracer = new WebGLPathTracer(renderer);
  pathTracer.bounces = bounces;
  pathTracer.filterGlossyFactor = 0.5;
  pathTracer.renderDelay = 0;
  pathTracer.fadeDuration = 0;
  pathTracer.minSamples = 1;
  pathTracer.dynamicLowRes = false;
  pathTracer.rasterizeScene = false;
  pathTracer.renderToCanvas = true;
  pathTracer.tiles.set(2, 2);

  try {
    pathTracer.setScene(prepared.scene, camera, {
      onProgress: (progress) => report(
        options,
        'preparing',
        progress,
        0,
        samples,
      ),
    });
    assertNotAborted(options.signal);
    pathTracer.reset();
    let previousSamples = pathTracer.samples;
    let stalledSince = performance.now();
    while (pathTracer.samples < samples) {
      assertNotAborted(options.signal);
      pathTracer.renderSample();
      if (pathTracer.samples > previousSamples) {
        previousSamples = pathTracer.samples;
        stalledSince = performance.now();
      } else if (performance.now() - stalledSince > 30_000) {
        throw new Error('Path tracer did not make progress for 30 seconds.');
      }
      const completed = Math.min(samples, Math.floor(pathTracer.samples));
      report(
        options,
        'sampling',
        Math.min(1, pathTracer.samples / samples),
        completed,
        samples,
      );
      await yieldToBrowser();
    }
    let image = canvasImageData(canvas);
    let denoised = false;
    let denoiseError: Error | null = null;
    if (options.denoise ?? true) {
      report(options, 'denoising', 0, samples, samples);
      try {
        const albedo = rasterGuide(
          renderer,
          prepared.scene,
          camera,
          'albedo',
        );
        const normal = rasterGuide(
          renderer,
          prepared.scene,
          camera,
          'normal',
        );
        image = await denoiseImage(image, {
          albedo,
          normal,
          quality: options.denoiseQuality ?? 'balanced',
          weightsUrl: options.denoiseWeightsUrl,
          signal: options.signal,
          onProgress: (progress) => report(
            options,
            'denoising',
            progress,
            samples,
            samples,
          ),
        });
        denoised = true;
      } catch (error) {
        assertNotAborted(options.signal);
        denoiseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    const blob = await imageDataBlob(image);
    report(options, 'complete', 1, samples, samples);
    return {
      blob,
      image,
      samples,
      denoised,
      denoiseError,
    };
  } finally {
    pathTracer.dispose();
    studio?.dispose();
    prepared.dispose();
    renderer.dispose();
  }
}
