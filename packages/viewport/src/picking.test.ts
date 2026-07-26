import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PickService, screenToNdc } from './picking';

function fakeElement(): HTMLElement {
  const events = new EventTarget();
  return {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      right: 210,
      bottom: 120,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;
}

describe('PickService pure bookkeeping', () => {
  it('converts client coordinates to NDC', () => {
    expect(screenToNdc(
      { clientX: 110, clientY: 70 },
      { left: 10, top: 20, width: 200, height: 100 },
    ).toArray()).toEqual([0, 0]);
    expect(screenToNdc(
      { clientX: 10, clientY: 20 },
      { left: 10, top: 20, width: 200, height: 100 },
    ).toArray()).toEqual([-1, 1]);
  });

  it('writes and removes stable identity metadata at registration', () => {
    const service = new PickService(new THREE.PerspectiveCamera(), fakeElement());
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    service.register(mesh, 'face_1', 'panel', ['face']);
    expect(mesh.userData.atelierId).toBe('face_1');
    expect(mesh.userData.atelierKind).toBe('panel');
    service.unregister(mesh);
    expect('atelierId' in mesh.userData).toBe(false);
    expect('atelierKind' in mesh.userData).toBe(false);
    service.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it('passes through native intersection fields on semantic hits', () => {
    const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const service = new PickService(camera, fakeElement());
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial(),
    );
    mesh.updateMatrixWorld(true);
    service.register(mesh, 'face_2', 'panel', ['face']);

    const hit = service.pick({ clientX: 110, clientY: 70 });

    expect(hit?.intersection?.object).toBe(mesh);
    expect(hit?.intersection?.point).toEqual(hit?.point);
    expect(hit?.uv).toEqual(hit?.intersection?.uv);
    expect(hit?.barycoord).toEqual(hit?.intersection?.barycoord);
    service.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it('returns the full sorted raw intersection list for explicit objects', () => {
    const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const service = new PickService(camera, fakeElement());
    const material = new THREE.MeshBasicMaterial();
    const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    far.position.z = -2;
    near.updateMatrixWorld(true);
    far.updateMatrixWorld(true);

    const intersections = service.raycast(
      { clientX: 110, clientY: 70 },
      { objects: [far, near] },
    );

    expect(intersections.length).toBeGreaterThanOrEqual(2);
    expect(intersections[0].object).toBe(near);
    expect(intersections.map((hit) => hit.distance)).toEqual(
      [...intersections].map((hit) => hit.distance).sort((a, b) => a - b),
    );
    service.dispose();
    near.geometry.dispose();
    far.geometry.dispose();
    material.dispose();
  });
});
