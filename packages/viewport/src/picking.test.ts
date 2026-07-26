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
});
