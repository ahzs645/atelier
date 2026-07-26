import * as THREE from 'three';
import { bounds, triangulate } from '@atelier/geometry';
import { docToWorld } from '@atelier/viewport';
import type { Viewport } from '@atelier/viewport';
import { rectanglePolygon } from './model';
import type { Rectangle } from './model';

export interface RectangleScene {
  update(rectangles: Rectangle[]): void;
  dispose(): void;
}

export function createRectangleScene(viewport: Viewport): RectangleScene {
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  viewport.scene.add(group);

  const clear = (): void => {
    for (const mesh of meshes.splice(0)) {
      viewport.picking.unregister(mesh);
      group.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    }
  };

  return {
    update(rectangles): void {
      clear();
      const allPoints = rectangles.flatMap(rectanglePolygon);

      for (const rectangle of rectangles) {
        const polygon = rectanglePolygon(rectangle);
        const triangleMesh = triangulate({ outer: polygon });
        const positions = triangleMesh.points.flatMap((point) => {
          const world = docToWorld(point);
          return [world.x, world.y, world.z];
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(positions, 3),
        );
        geometry.setIndex(triangleMesh.triangles);
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color: '#60a5fa',
          metalness: 0,
          roughness: 0.8,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = rectangle.name;
        group.add(mesh);
        meshes.push(mesh);
        viewport.picking.register(mesh, rectangle.id, 'rect', ['face']);
      }

      if (allPoints.length > 0) viewport.camera.fitDoc(bounds(allPoints), 1.25);
      viewport.invalidate();
    },
    dispose(): void {
      clear();
      viewport.scene.remove(group);
      viewport.invalidate();
    },
  };
}
