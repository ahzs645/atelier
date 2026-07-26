import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export type LightingPreset = 'studio' | 'flat' | 'technical' | 'hdri';

type EnvironmentSource = 'room' | { hdri: string };

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
    this.lights.clear();
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

    if (preset === 'flat') {
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

  async setEnvironment(source: EnvironmentSource, intensity = 1): Promise<void> {
    const request = ++this.environmentRequest;
    const key = source === 'room' ? 'room' : source.hdri;
    this.setEnvironmentIntensity(intensity);
    const cached = this.environmentCache.get(key);
    if (cached) {
      this.applyEnvironment(cached, request);
      return;
    }

    const pmrem = this.getPmrem();
    try {
      let texture: THREE.Texture;
      if (source === 'room') {
        const room = new RoomEnvironment();
        texture = pmrem.fromScene(room, 0.04).texture;
        room.dispose();
      } else {
        const hdr = await new RGBELoader()
          .setDataType(THREE.FloatType)
          .loadAsync(source.hdri);
        if (this.disposed) {
          hdr.dispose();
          return;
        }
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        texture = pmrem.fromEquirectangular(hdr).texture;
        hdr.dispose();
      }
      if (this.disposed) {
        texture.dispose();
        return;
      }
      this.environmentCache.set(key, texture);
      this.applyEnvironment(texture, request);
    } catch {
      // A missing/CORS-blocked HDRI leaves the current direct-light rig active.
    }
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
    this.scene.remove(this.lights);
    if (this.scene.environment === this.activeEnvironment) this.scene.environment = null;
    for (const texture of this.environmentCache.values()) texture.dispose();
    this.environmentCache.clear();
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

  private applyEnvironment(texture: THREE.Texture, request: number): void {
    if (this.disposed || request !== this.environmentRequest) return;
    this.activeEnvironment = texture;
    this.scene.environment = texture;
    this.invalidate();
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
