// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CameraRig,
  DEFAULT_INPUT_MAP,
  cameraRigInternal,
  resolveInputAction,
  type CameraPreset,
  type CameraState,
  type InputMap,
} from './camera';

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('CameraRig views and lifecycle', () => {
  it.each([
    ['front', [1, 2, 6], [0, 1, 0]],
    ['back', [1, 2, 0], [0, 1, 0]],
    ['left', [-2, 2, 3], [0, 1, 0]],
    ['right', [4, 2, 3], [0, 1, 0]],
    ['top', [1, 5, 3], [0, 0, -1]],
    ['bottom', [1, -1, 3], [0, 0, 1]],
    ['isometric', [
      1 + Math.sqrt(3),
      2 + Math.sqrt(3),
      3 + Math.sqrt(3),
    ], [0, 1, 0]],
  ] satisfies Array<[CameraPreset, number[], number[]]>)(
    'maps %s to its standard direction and up vector',
    async (view, expectedPosition, expectedUp) => {
      const rig = new CameraRig();
      rig.setState({
        kind: 'perspective',
        position: [1, 2, 6],
        target: [1, 2, 3],
        zoom: 1,
        fov: 54,
      });

      await rig.flyToView(view, 0);

      rig.getState().position.forEach((value, index) => {
        expect(value).toBeCloseTo(expectedPosition[index] ?? 0);
      });
      rig.camera.up.toArray().forEach((value, index) => {
        expect(value).toBeCloseTo(expectedUp[index] ?? 0);
      });
      expect(rig.getState().target).toEqual([1, 2, 3]);
      rig.dispose();
    },
  );

  it('animates flyToView deterministically from the window frame clock', async () => {
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window.performance, 'now').mockReturnValue(0);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const runNextFrame = (now: number): void => {
      const next = frames.entries().next().value;
      if (!next) throw new Error('Expected a queued animation frame');
      const [id, callback] = next;
      frames.delete(id);
      callback(now);
    };
    const canvas = document.createElement('canvas');
    const rig = new CameraRig(canvas);
    rig.setState({
      kind: 'perspective',
      position: [0, 0, 2],
      target: [0, 0, 0],
      zoom: 1,
      fov: 54,
    });

    const flight = rig.flyToView('right', 1_000);
    runNextFrame(500);
    rig.getState().position.forEach((value, index) => {
      expect(value).toBeCloseTo([1, 0, 1][index] ?? 0);
    });

    runNextFrame(1_000);
    await flight;
    rig.getState().position.forEach((value, index) => {
      expect(value).toBeCloseTo([2, 0, 0][index] ?? 0);
    });
    expect(frames.size).toBe(0);
    rig.dispose();
  });

  it('removes DOM input hooks and listeners on dispose', () => {
    const canvas = document.createElement('canvas');
    const removeElementListener = vi.spyOn(canvas, 'removeEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const rig = new CameraRig(canvas);

    rig.dispose();
    rig.dispose();

    expect(removeElementListener).toHaveBeenCalledWith(
      'pointermove',
      expect.any(Function),
      true,
    );
    expect(removeWindowListener).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
      true,
    );
    expect(removeWindowListener).toHaveBeenCalledWith(
      'blur',
      expect.any(Function),
    );
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
