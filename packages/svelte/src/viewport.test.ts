// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

const viewportInstances = vi.hoisted(() => [] as Array<{
  options: unknown;
  resize: ReturnType<typeof vi.fn>;
  setProjection: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>);

vi.mock('@atelier/viewport', () => ({
  Viewport: class {
    readonly resize = vi.fn();
    readonly setProjection = vi.fn();
    readonly dispose = vi.fn();
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
      viewportInstances.push(this);
    }
  },
}));

import { viewport } from './index';

afterEach(() => {
  viewportInstances.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('viewport action', () => {
  it('mounts into the action node, exposes the instance, and applies updates', () => {
    const node = document.createElement('div');
    const onReady = vi.fn();

    const action = viewport(node, { projection: '3d', onReady });
    const instance = viewportInstances[0];
    expect(instance).toBeDefined();
    expect(instance?.options).toMatchObject({ container: node, projection: '3d' });
    expect(onReady).toHaveBeenCalledWith(instance);

    action.update({ projection: '2d' });
    action.update({});
    expect(instance?.setProjection).toHaveBeenNthCalledWith(1, '2d');
    expect(instance?.setProjection).toHaveBeenNthCalledWith(2, '3d');

    action.destroy();
    expect(instance?.dispose).toHaveBeenCalledOnce();
  });

  it('observes resize and disconnects the observer before disposal', () => {
    const node = document.createElement('div');
    const disconnect = vi.fn();
    let resizeCallback: (() => void) | undefined;
    const observe = vi.fn();
    class TestResizeObserver {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }

      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const action = viewport(node, {});
    const instance = viewportInstances[0];
    expect(observe).toHaveBeenCalledWith(node);

    resizeCallback?.();
    expect(instance?.resize).toHaveBeenCalledOnce();

    action.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      instance?.dispose.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
