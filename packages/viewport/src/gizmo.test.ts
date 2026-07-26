import * as THREE from 'three';
import type { TransformControls } from 'three/addons/controls/TransformControls.js';
import { describe, expect, it, vi } from 'vitest';
import { GizmoService, type GizmoHandleState } from './gizmo';

describe('GizmoService transform state', () => {
  it('sets transform space and publishes axis/drag transitions', () => {
    const scene = new THREE.Scene();
    const service = new GizmoService(
      scene,
      new THREE.PerspectiveCamera(),
    );
    const states: GizmoHandleState[] = [];
    const listener = vi.fn((state: GizmoHandleState) => states.push(state));
    service.onHandleStateChange(listener);
    service.setSpace('local');

    expect(service.space).toBe('local');
    const transform = (
      service as unknown as { transform: TransformControls }
    ).transform;
    transform.axis = 'X';
    transform.dispatchEvent({ type: 'axis-changed', value: 'X' });
    transform.dragging = true;
    transform.dispatchEvent({ type: 'dragging-changed', value: true });
    transform.dragging = false;
    transform.dispatchEvent({ type: 'dragging-changed', value: false });

    expect(states).toEqual([
      { axis: 'X', dragging: false },
      { axis: 'X', dragging: true },
      { axis: 'X', dragging: false },
    ]);
    expect(service.handleState).toEqual({ axis: 'X', dragging: false });
    expect(listener).toHaveBeenCalledTimes(3);
    service.dispose();
  });
});
