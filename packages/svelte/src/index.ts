import { Viewport } from '@atelier/viewport';
import type { ViewportOptions } from '@atelier/viewport';

export { editorState } from './editor-state.svelte';
export type { EditorState } from './editor-state.svelte';

export type ViewportMountOptions =
  Omit<ViewportOptions, 'container'>
  & {
    container?: HTMLElement;
    /**
     * Called once with the constructed Viewport. Without this the action is
     * mount-only: a consumer has no route to the instance and cannot add scene
     * objects, register pickables, or drive the camera. Mirrors the React
     * binding's `onReady`.
     */
    onReady?: (viewport: Viewport) => void;
  };

export interface ViewportAction {
  update(options: ViewportMountOptions): void;
  destroy(): void;
}

export function viewport(
  node: HTMLElement,
  options: ViewportMountOptions,
): ViewportAction {
  const instance = new Viewport({ ...options, container: node });
  const ResizeObserverConstructor =
    node.ownerDocument.defaultView?.ResizeObserver;
  const observer = ResizeObserverConstructor
    ? new ResizeObserverConstructor(() => instance.resize())
    : null;
  observer?.observe(node);
  options.onReady?.(instance);

  return {
    update(next): void {
      instance.setProjection(next.projection ?? '3d');
    },
    destroy(): void {
      observer?.disconnect();
      instance.dispose();
    },
  };
}
