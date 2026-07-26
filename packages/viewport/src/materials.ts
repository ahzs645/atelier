import * as THREE from 'three';
import type { Vec2 } from '@atelier/geometry';

export interface SurfaceSpec {
  color: string;
  roughness: number;
  metalness: number;
  opacity?: number;
  alphaCutoff?: number;
  specularIntensity?: number;
  doubleSided?: boolean;
  map?: {
    url: string;
    scaleMm: number;
    rotationDeg?: number;
    offset?: Vec2;
  };
  shellOffset?: number;
}

interface SurfaceRuntime {
  mapUrl: string | null;
  ownedMap: THREE.Texture | null;
  shellUniform: THREE.IUniform<number>;
}

function surfaceRuntime(material: THREE.MeshPhysicalMaterial): SurfaceRuntime {
  const existing: unknown = material.userData.atelierSurface;
  if (
    typeof existing === 'object'
    && existing !== null
    && 'shellUniform' in existing
  ) {
    return existing as SurfaceRuntime;
  }
  const runtime: SurfaceRuntime = {
    mapUrl: null,
    ownedMap: null,
    shellUniform: { value: 0 },
  };
  material.userData.atelierSurface = runtime;
  material.customProgramCacheKey = () => 'atelier-surface-shell-v1';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.atelierShellOffset = runtime.shellUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float atelierShellOffset;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed += objectNormal * atelierShellOffset;',
      );
  };
  material.addEventListener('dispose', () => {
    runtime.ownedMap?.dispose();
    runtime.ownedMap = null;
    runtime.mapUrl = null;
  });
  return runtime;
}

function configureTexture(
  texture: THREE.Texture,
  map: NonNullable<SurfaceSpec['map']>,
): void {
  const scale = Math.max(Number.EPSILON, map.scaleMm);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / scale, 1 / scale);
  texture.rotation = THREE.MathUtils.degToRad(map.rotationDeg ?? 0);
  texture.center.set(0.5, 0.5);
  texture.offset.set(
    (map.offset?.x ?? 0) / scale,
    (map.offset?.y ?? 0) / scale,
  );
  texture.needsUpdate = true;
}

function createMapTexture(map: NonNullable<SurfaceSpec['map']>): THREE.Texture {
  if (typeof document === 'undefined') {
    const texture = new THREE.Texture();
    configureTexture(texture, map);
    return texture;
  }
  const texture = new THREE.TextureLoader().load(
    map.url,
    (loaded) => configureTexture(loaded, map),
    undefined,
    () => {},
  );
  configureTexture(texture, map);
  return texture;
}

export function createSurfaceMaterial(spec: SurfaceSpec): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial();
  surfaceRuntime(material);
  updateSurfaceMaterial(material, spec);
  return material;
}

export function updateSurfaceMaterial(
  material: THREE.MeshPhysicalMaterial,
  spec: SurfaceSpec,
): void {
  const runtime = surfaceRuntime(material);
  material.color.set(spec.color);
  material.roughness = THREE.MathUtils.clamp(spec.roughness, 0, 1);
  material.metalness = THREE.MathUtils.clamp(spec.metalness, 0, 1);
  material.opacity = THREE.MathUtils.clamp(spec.opacity ?? 1, 0, 1);
  material.transparent = material.opacity < 1;
  material.alphaTest = Math.max(0, spec.alphaCutoff ?? 0);
  material.specularIntensity = Math.max(0, spec.specularIntensity ?? 1);
  material.side = spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  material.shadowSide = spec.doubleSided ? THREE.DoubleSide : null;
  runtime.shellUniform.value = spec.shellOffset ?? 0;

  if (!spec.map) {
    runtime.ownedMap?.dispose();
    runtime.ownedMap = null;
    runtime.mapUrl = null;
    material.map = null;
  } else if (runtime.mapUrl === spec.map.url && runtime.ownedMap) {
    configureTexture(runtime.ownedMap, spec.map);
    material.map = runtime.ownedMap;
  } else {
    runtime.ownedMap?.dispose();
    const texture = createMapTexture(spec.map);
    runtime.ownedMap = texture;
    runtime.mapUrl = spec.map.url;
    material.map = texture;
  }
  material.needsUpdate = true;
}
