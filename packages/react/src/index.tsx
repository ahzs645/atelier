import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { JSX } from 'react';
import type {
  CommandResult,
  Doc,
  Editor,
  Selection,
} from '@atelier/core';
import { Viewport } from '@atelier/viewport';
import type { ViewportOptions } from '@atelier/viewport';

export interface ViewportCanvasProps {
  options: ViewportMountOptions;
  onReady: (viewport: Viewport) => void;
  className?: string;
}

export type ViewportMountOptions =
  Omit<ViewportOptions, 'container'>
  & { container?: HTMLElement };

export function ViewportCanvas({
  options,
  onReady,
  className,
}: ViewportCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport>(null);
  const initialOptionsRef = useRef(options);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const viewport = new Viewport({
      ...initialOptionsRef.current,
      container,
    });
    viewportRef.current = viewport;

    const ResizeObserverConstructor =
      container.ownerDocument.defaultView?.ResizeObserver;
    const observer = ResizeObserverConstructor
      ? new ResizeObserverConstructor(() => viewport.resize())
      : null;
    observer?.observe(container);
    onReadyRef.current(viewport);

    return () => {
      observer?.disconnect();
      viewportRef.current = null;
      viewport.dispose();
    };
  }, []);

  useEffect(() => {
    viewportRef.current?.setProjection(options.projection ?? '3d');
  }, [options.projection]);

  return <div ref={containerRef} className={className} />;
}

export interface EditorState<T> {
  doc: Doc<T>;
  content: T;
  selection: Selection;
  execute: Editor<T>['execute'];
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

interface EditorSnapshot<T> {
  doc: Doc<T>;
  selection: Selection;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export function useEditor<T>(editor: Editor<T>): EditorState<T> {
  const snapshotRef = useRef<EditorSnapshot<T>>(null);

  const subscribe = useCallback((notify: () => void) => {
    const disposeDoc = editor.on('doc', notify);
    const disposeSelection = editor.on('selection', notify);
    const disposeHistory = editor.on('history', notify);
    return () => {
      disposeDoc();
      disposeSelection();
      disposeHistory();
    };
  }, [editor]);

  const getSnapshot = useCallback((): EditorSnapshot<T> => {
    const current = snapshotRef.current;
    if (
      current?.doc === editor.doc
      && current.selection === editor.selection
      && current.canUndo === editor.canUndo
      && current.canRedo === editor.canRedo
      && current.undoLabel === editor.undoLabel
      && current.redoLabel === editor.redoLabel
    ) {
      return current;
    }
    const next: EditorSnapshot<T> = {
      doc: editor.doc,
      selection: editor.selection,
      canUndo: editor.canUndo,
      canRedo: editor.canRedo,
      undoLabel: editor.undoLabel,
      redoLabel: editor.redoLabel,
    };
    snapshotRef.current = next;
    return next;
  }, [editor]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const execute = useCallback(
    <P,>(type: string, params?: P): CommandResult =>
      editor.execute(type, params),
    [editor],
  );
  const undo = useCallback((): void => {
    editor.undo();
  }, [editor]);
  const redo = useCallback((): void => {
    editor.redo();
  }, [editor]);

  return {
    doc: snapshot.doc,
    content: snapshot.doc.content,
    selection: snapshot.selection,
    execute,
    undo,
    redo,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    undoLabel: snapshot.undoLabel,
    redoLabel: snapshot.redoLabel,
  };
}

export function useSelection<T>(
  editor: Editor<T>,
): [Selection, (selection: Selection) => void] {
  const subscribe = useCallback(
    (notify: () => void) => editor.on('selection', notify),
    [editor],
  );
  const getSnapshot = useCallback(() => editor.selection, [editor]);
  const selection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setSelection = useCallback(
    (next: Selection): void => editor.setSelection(next),
    [editor],
  );
  return [selection, setSelection];
}

export function useCommand<T, P>(
  editor: Editor<T>,
  type: string,
): (params?: P) => CommandResult {
  return useCallback(
    (params?: P) => editor.execute(type, params),
    [editor, type],
  );
}
