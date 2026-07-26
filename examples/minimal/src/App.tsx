import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { JSX } from 'react';
import { Selection } from '@atelier/core';
import {
  ViewportCanvas,
  useCommand,
  useEditor,
  useSelection,
} from '@atelier/react';
import type { Viewport } from '@atelier/viewport';
import {
  createDemoEditor,
  exportSvg,
} from './model';
import type {
  CreateRectangleParams,
  DeleteSelectionParams,
  MoveRectangleParams,
  RectangleContent,
} from './model';
import { createRectangleScene } from './scene';

export function App(): JSX.Element {
  const [editor] = useState(createDemoEditor);
  const state = useEditor(editor);
  const [selection, setSelection] = useSelection(editor);
  const createRectangle =
    useCommand<RectangleContent, CreateRectangleParams>(
      editor,
      'rect.create',
    );
  const deleteSelection =
    useCommand<RectangleContent, DeleteSelectionParams>(
      editor,
      'selection.delete',
    );
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const svg = useMemo(() => exportSvg(state.content), [state.content]);
  const selectedId = [...selection.get('rect')][0];

  useEffect(() => () => editor.dispose(), [editor]);

  useEffect(() => {
    if (!viewport) return;
    const scene = createRectangleScene(viewport);
    scene.update(state.content.rectangles);
    return () => scene.dispose();
  }, [state.content.rectangles, viewport]);

  useEffect(() => {
    if (!viewport) return;
    return viewport.picking.onPick((hit) => {
      setSelection(
        hit
          ? Selection.of([['rect', [hit.id]]])
          : Selection.empty(),
      );
    });
  }, [setSelection, viewport]);

  const handleReady = useCallback((readyViewport: Viewport): void => {
    setViewport(readyViewport);
  }, []);

  const addRectangle = (): void => {
    const index = state.content.rectangles.length + 1;
    createRectangle({
      name: `Rectangle ${index}`,
      x: index * 15,
      y: index * 10,
      width: 60,
      height: 40,
    });
  };

  const moveSelected = (): void => {
    if (!selectedId) return;
    state.execute<MoveRectangleParams>('rect.move', {
      id: selectedId,
      dx: 10,
      dy: 5,
    });
  };

  return (
    <main>
      <section className="toolbar">
        <button type="button" onClick={addRectangle}>Create</button>
        <button type="button" onClick={moveSelected} disabled={!selectedId}>
          Move selected
        </button>
        <button
          type="button"
          onClick={() => deleteSelection({ kind: 'rect' })}
          disabled={selection.size === 0}
        >
          Delete selected
        </button>
        <button type="button" onClick={state.undo} disabled={!state.canUndo}>
          Undo
        </button>
        <button type="button" onClick={state.redo} disabled={!state.canRedo}>
          Redo
        </button>
        <button
          type="button"
          onClick={() => setSelection(Selection.empty())}
          disabled={selection.size === 0}
        >
          Clear selection
        </button>
        <span>
          revision {state.doc.meta.revision}; {state.content.rectangles.length} rectangles
        </span>
      </section>

      <ViewportCanvas
        className="viewport"
        options={{ projection: '2d', postProcessing: false }}
        onReady={handleReady}
      />

      <details>
        <summary>SVG export ({svg.length} characters)</summary>
        <textarea aria-label="SVG export" value={svg} readOnly />
      </details>
    </main>
  );
}
