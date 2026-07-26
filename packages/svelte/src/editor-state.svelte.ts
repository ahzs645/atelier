/* global $effect, $state */

import type { Doc, Editor, Selection } from '@atelier/core';

export interface EditorState<T> {
  readonly doc: Doc<T>;
  readonly content: T;
  readonly selection: Selection;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

export function editorState<T>(editor: Editor<T>): EditorState<T> {
  let doc = $state(editor.doc);
  let selection = $state(editor.selection);
  let canUndo = $state(editor.canUndo);
  let canRedo = $state(editor.canRedo);
  let undoLabel = $state(editor.undoLabel);
  let redoLabel = $state(editor.redoLabel);

  $effect(() => {
    const syncDoc = (current: Editor<T>): void => {
      doc = current.doc;
    };
    const syncSelection = (current: Editor<T>): void => {
      selection = current.selection;
    };
    const syncHistory = (current: Editor<T>): void => {
      canUndo = current.canUndo;
      canRedo = current.canRedo;
      undoLabel = current.undoLabel;
      redoLabel = current.redoLabel;
    };
    const disposeDoc = editor.on('doc', syncDoc);
    const disposeSelection = editor.on('selection', syncSelection);
    const disposeHistory = editor.on('history', syncHistory);

    return () => {
      disposeDoc();
      disposeSelection();
      disposeHistory();
    };
  });

  return {
    get doc() {
      return doc;
    },
    get content() {
      return doc.content;
    },
    get selection() {
      return selection;
    },
    get canUndo() {
      return canUndo;
    },
    get canRedo() {
      return canRedo;
    },
    get undoLabel() {
      return undoLabel;
    },
    get redoLabel() {
      return redoLabel;
    },
  };
}
