import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export type LightingPreset = 'studio' | 'flat' | 'technical' | 'hdri' | 'none';

export type RgbColor = readonly [number, number, number];

export interface DirectionalLightSpec {
  position: readonly [number, number, number];
  color: THREE.ColorRepresentation | RgbColor;
  intensity: number;
  castShadow?: boolean;
  shadowMapSize?: number;
}

export type HdriLightAnalyzer = (
  texture: THREE.DataTexture,
  url: string,
) => readonly DirectionalLightSpec[];

export type EnvironmentSource =
  | 'room'
  | {
    hdri: string;
    /** Runs once before PMREM conversion; its directional-light specs are cached by URL. */
    analyzeLights?: HdriLightAnalyzer;
  };

export type EnvironmentResult =
  | { ok: true }
  | { ok: false; reason: string };

interface GroundOptions {
  grid?: boolean;
  shadowCatcher?: boolean;
  size?: number;
}

/** Owns direct lights, image-based lighting, background, and ground helpers. */
export class LightingRig {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly invalidate: () => void;
  private readonly lights = new THREE.Group();
  private readonly environmentCache = new Map<string, THREE.Texture>();
  private readonly analyzedLightCache = new Map<string, readonly DirectionalLightSpec[]>();
  private pmrem: THREE.PMREMGenerator | null = null;
  private ground: THREE.Group | null = null;
  private activeEnvironment: THREE.Texture | null = null;
  private environmentRequest = 0;
  private shadows = true;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    invalidate: () => void = () => {},
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.invalidate = invalidate;
    this.scene.add(this.lights);
    this.setPreset('studio');
  }

  setPreset(preset: LightingPreset): void {
    this.clearLights();
    const addDirectional = (
      color: THREE.ColorRepresentation,
      intensity: number,
      position: [number, number, number],
      shadow = false,
    ): void => {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position);
      light.castShadow = shadow && this.shadows;
      light.userData.atelierCastsShadow = shadow;
      if (shadow) {
        light.shadow.mapSize.set(2048, 2048);
        light.shadow.camera.near = 0.1;
        light.shadow.camera.far = 50;
        light.shadow.camera.left = -10;
        light.shadow.camera.right = 10;
        light.shadow.camera.top = 10;
        light.shadow.camera.bottom = -10;
        light.shadow.bias = 0.0005;
        light.shadow.normalBias = 0.03;
      }
      this.lights.add(light);
    };

    if (preset === 'none') {
      // Environment-only lighting intentionally has no direct-light fallback.
    } else if (preset === 'flat') {
      this.lights.add(new THREE.AmbientLight(0xffffff, 2));
      this.lights.add(new THREE.HemisphereLight(0xffffff, 0xc8b69e, 1.1));
    } else if (preset === 'technical') {
      this.lights.add(new THREE.AmbientLight(0xffffff, 1.8));
      addDirectional(0xffffff, 2.2, [4, 8, 6], true);
    } else if (preset === 'hdri') {
      this.lights.add(new THREE.AmbientLight(0xffffff, 0.2));
      addDirectional(0xffffff, 0.7, [5, 15, 10], true);
    } else {
      this.lights.add(new THREE.AmbientLight(0xffffff, 1.25));
      addDirectional(0xffffff, 2.35, [5, 15, 10], true);
      addDirectional(0xfff3a6, 1.05, [-5, 10, -5]);
      addDirectional(0xffffff, 0.85, [0, 10, -10]);
    }
    this.invalidate();
  }

  /** Replace the direct-light rig with engine-owned directional lights. */
  setLights(specs: readonly DirectionalLightSpec[]): void {
    this.clearLights();
    for (const spec of specs) this.addDirectionalLight(spec);
    this.invalidate();
  }

  async setEnvironment(
    source: EnvironmentSource,
    intensity = 1,
  ): Promise<EnvironmentResult> {
    const request = ++this.environmentRequest;
    const key = source === 'room' ? 'room' : source.hdri;
    this.setEnvironmentIntensity(intensity);
    const cached = this.environmentCache.get(key);
    if (cached) {
      if (source !== 'room') {
        const analyzed = this.analyzedLightCache.get(key);
        if (analyzed) this.setLights(analyzed);
      }
      return this.applyEnvironment(cached, request)
        ? { ok: true }
        : this.cancelledEnvironmentResult();
    }

    try {
      const pmrem = this.getPmrem();
      let texture: THREE.Texture;
      if (source === 'room') {
        const room = new RoomEnvironment();
        try {
          texture = pmrem.fromScene(room, 0.04).texture;
        } finally {
          room.dispose();
        }
      } else {
        const hdr = await new RGBELoader()
          .setDataType(THREE.FloatType)
          .loadAsync(source.hdri);
        if (!this.isCurrentEnvironmentRequest(request)) {
          hdr.dispose();
          return this.cancelledEnvironmentResult();
        }
        try {
          if (source.analyzeLights) {
            let analyzed: readonly DirectionalLightSpec[] = [];
            try {
              analyzed = source.analyzeLights(hdr, source.hdri);
            } catch {
              // A failed app analyzer must not prevent the environment from loading.
            }
            const cachedSpecs = analyzed.map((spec) => this.copyLightSpec(spec));
            this.analyzedLightCache.set(key, cachedSpecs);
            if (request === this.environmentRequest) this.setLights(cachedSpecs);
          }
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          texture = pmrem.fromEquirectangular(hdr).texture;
        } finally {
          hdr.dispose();
        }
      }
      if (!this.isCurrentEnvironmentRequest(request)) {
        texture.dispose();
        return this.cancelledEnvironmentResult();
      }
      this.environmentCache.set(key, texture);
      return this.applyEnvironment(texture, request)
        ? { ok: true }
        : this.cancelledEnvironmentResult();
    } catch (error: unknown) {
      if (!this.isCurrentEnvironmentRequest(request)) {
        return this.cancelledEnvironmentResult();
      }
      return {
        ok: false,
        reason: `Failed to load environment "${key}": ${this.errorMessage(error)}`,
      };
    }
  }

  /**
   * Remove image-based lighting and cancel the active request.
   * Cached PMREM textures remain cache-owned until dispose().
   */
  clearEnvironment(): void {
    if (this.disposed) return;
    this.environmentRequest += 1;
    this.scene.environment = null;
    this.activeEnvironment = null;
    this.invalidate();
  }

  setEnvironmentIntensity(value: number): void {
    this.scene.environmentIntensity = Math.max(0, value);
    this.invalidate();
  }

  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.lights.traverse((object) => {
      if (
        object instanceof THREE.DirectionalLight
        && object.userData.atelierCastsShadow === true
      ) {
        object.castShadow = enabled;
      }
    });
    this.invalidate();
  }

  setBackground(color: string | null): void {
    this.scene.background = color === null ? null : new THREE.Color(color);
    this.invalidate();
  }

  setGround(options: GroundOptions | null): void {
    this.clearGround();
    if (options === null) {
      this.invalidate();
      return;
    }
    const size = Math.max(0.01, options.size ?? 10);
    const group = new THREE.Group();
    if (options.grid) {
      const grid = new THREE.GridHelper(size, 20, 0x64748b, 0x94a3b8);
      group.add(grid);
    }
    if (options.shadowCatcher) {
      const geometry = new THREE.PlaneGeometry(size, size);
      const material = new THREE.ShadowMaterial({
        color: 0x000000,
        opacity: 0.16,
        transparent: true,
      });
      const plane = new THREE.Mesh(geometry, material);
      plane.rotation.x = -Math.PI / 2;
      plane.receiveShadow = true;
      plane.renderOrder = -1;
      group.add(plane);
    }
    this.ground = group;
    this.scene.add(group);
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.environmentRequest += 1;
    this.clearGround();
    this.clearLights();
    this.scene.remove(this.lights);
    if (this.scene.environment === this.activeEnvironment) this.scene.environment = null;
    for (const texture of this.environmentCache.values()) texture.dispose();
    this.environmentCache.clear();
    this.analyzedLightCache.clear();
    this.activeEnvironment = null;
    this.pmrem?.dispose();
    this.pmrem = null;
  }

  private getPmrem(): THREE.PMREMGenerator {
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.pmrem.compileEquirectangularShader();
    }
    return this.pmrem;
  }

  private addDirectionalLight(spec: DirectionalLightSpec): void {
    const color = this.isRgbColor(spec.color)
      ? new THREE.Color(spec.color[0], spec.color[1], spec.color[2])
      : spec.color;
    const light = new THREE.DirectionalLight(
      color,
      Math.max(0, spec.intensity),
    );
    light.position.set(spec.position[0], spec.position[1], spec.position[2]);
    const castsShadow = spec.castShadow ?? false;
    light.castShadow = castsShadow && this.shadows;
    light.userData.atelierCastsShadow = castsShadow;
    if (castsShadow) {
      const size = Math.max(1, Math.round(spec.shadowMapSize ?? 2048));
      light.shadow.mapSize.set(size, size);
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 50;
      light.shadow.camera.left = -10;
      light.shadow.camera.right = 10;
      light.shadow.camera.top = 10;
      light.shadow.camera.bottom = -10;
      light.shadow.bias = 0.0005;
      light.shadow.normalBias = 0.03;
    }
    this.lights.add(light);
  }

  private clearLights(): void {
    for (const child of [...this.lights.children]) {
      this.lights.remove(child);
      if (child instanceof THREE.Light) child.dispose();
    }
  }

  private copyLightSpec(spec: DirectionalLightSpec): DirectionalLightSpec {
    const color = this.isRgbColor(spec.color)
      ? [spec.color[0], spec.color[1], spec.color[2]] as const
      : spec.color;
    return {
      ...spec,
      position: [spec.position[0], spec.position[1], spec.position[2]],
      color,
    };
  }

  private isRgbColor(
    color: THREE.ColorRepresentation | RgbColor,
  ): color is RgbColor {
    return Array.isArray(color)
      && color.length === 3
      && color.every((component) => typeof component === 'number');
  }

  private applyEnvironment(texture: THREE.Texture, request: number): boolean {
    if (!this.isCurrentEnvironmentRequest(request)) return false;
    this.activeEnvironment = texture;
    this.scene.environment = texture;
    this.invalidate();
    return true;
  }

  private isCurrentEnvironmentRequest(request: number): boolean {
    return !this.disposed && request === this.environmentRequest;
  }

  private cancelledEnvironmentResult(): EnvironmentResult {
    return { ok: false, reason: 'Environment request was cancelled.' };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private clearGround(): void {
    if (!this.ground) return;
    this.scene.remove(this.ground);
    this.ground.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.dispose();
      } else if (object instanceof THREE.GridHelper) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    this.ground = null;
  }
}
