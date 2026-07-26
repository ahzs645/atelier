import { describe, expect, it } from 'vitest';
import {
  CameraRig,
  DEFAULT_INPUT_MAP,
  cameraRigInternal,
  resolveInputAction,
  type CameraState,
  type InputMap,
} from './camera';

describe('CameraRig pure state and framing', () => {
  it('round-trips serialised state across camera kinds', () => {
    const rig = new CameraRig();
    const state: CameraState = {
      kind: 'orthographic',
      position: [2, 3, 4],
      target: [0.5, 0.25, 0],
      zoom: 7.5,
      fov: 61,
    };
    rig.setState(state);
    const restored = rig.getState();
    expect(restored.kind).toBe(state.kind);
    restored.position.forEach((value, index) => {
      expect(value).toBeCloseTo(state.position[index]);
    });
    restored.target.forEach((value, index) => {
      expect(value).toBeCloseTo(state.target[index]);
    });
    expect(restored.zoom).toBe(state.zoom);
    expect(restored.fov).toBe(state.fov);
    rig.dispose();
  });

  it('fits a known document box in an orthographic camera', () => {
    const rig = new CameraRig({ kind: 'orthographic' });
    rig[cameraRigInternal].resize(1000, 1000);
    rig.fitDoc({ minX: 0, minY: 100, maxX: 200, maxY: 200 }, 1);
    const state = rig.getState();
    expect(state.target[0]).toBeCloseTo(0.1);
    expect(state.target[1]).toBeCloseTo(0.15);
    expect(state.target[2]).toBeCloseTo(0);
    expect(state.position[0]).toBeCloseTo(0.1);
    expect(state.position[1]).toBeCloseTo(0.15);
    expect(state.zoom).toBeCloseTo(10);
    rig.dispose();
  });

  it('fits a known document box with perspective FOV maths', () => {
    const rig = new CameraRig({ kind: 'perspective', fov: 90 });
    rig[cameraRigInternal].resize(1000, 1000);
    rig.setState({
      kind: 'perspective',
      position: [0, 0, 2],
      target: [0, 0, 0],
      zoom: 1,
      fov: 90,
    });
    rig.fitDoc({ minX: -1000, minY: -500, maxX: 1000, maxY: 500 }, 1);
    expect(rig.getState().position[2]).toBeCloseTo(1);
    rig.dispose();
  });
});

describe('InputMap resolution', () => {
  it('resolves default pointer and modifier combinations', () => {
    expect(resolveInputAction(DEFAULT_INPUT_MAP as InputMap, 0, false)).toBe('rotate');
    expect(resolveInputAction(DEFAULT_INPUT_MAP as InputMap, 0, true)).toBe('pan');
    expect(resolveInputAction(DEFAULT_INPUT_MAP as InputMap, 1, true)).toBe('dolly');
    expect(resolveInputAction(DEFAULT_INPUT_MAP as InputMap, 2, false)).toBe('pan');
    expect(resolveInputAction(DEFAULT_INPUT_MAP as InputMap, 2, true)).toBe('rotate');
  });

  it('falls back to the base action when a modified override is absent', () => {
    const map: InputMap = {
      left: 'none',
      middle: 'pan',
      right: 'rotate',
      modified: {},
    };
    expect(resolveInputAction(map, 0, true)).toBe('none');
    expect(resolveInputAction(map, 2, true)).toBe('rotate');
  });
});
