// @vitest-environment happy-dom

import {
  CommandRegistry,
  Editor,
  Selection,
  createDoc,
  type CommandDef,
} from '@atelier/core';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import { editorState, type EditorState } from './editor-state.svelte';

interface Counter {
  value: number;
}

const increment: CommandDef<Counter, { by: number }> = {
  type: 'counter.increment',
  category: 'counter',
  summary: 'Increment counter',
  label: 'Increment',
  inputs: ['by'],
  run: (content, { by }) => ({ value: content.value + by }),
};

function makeEditor(): Editor<Counter> {
  const registry = new CommandRegistry<Counter>().register(increment);
  return new Editor(createDoc({ value: 0 }, { name: 'svelte-test' }), {
    registry,
    history: { coalesceMs: 0 },
  });
}

async function bind(editor: Editor<Counter>): Promise<{
  state: EditorState<Counter>;
  dispose: () => void;
}> {
  let state: EditorState<Counter> | undefined;
  const dispose = $effect.root(() => {
    state = editorState(editor);
  });
  await tick();
  if (!state) throw new Error('Editor state effect did not initialize');
  return { state, dispose };
}

describe('editorState', () => {
  it('tracks document and history changes through execute, undo, and redo', async () => {
    const editor = makeEditor();
    const binding = await bind(editor);

    expect(binding.state.content.value).toBe(0);
    expect(binding.state.canUndo).toBe(false);

    editor.execute('counter.increment', { by: 3 });
    expect(binding.state.content.value).toBe(3);
    expect(binding.state.doc.meta.id).toBe(editor.doc.meta.id);
    expect(binding.state.canUndo).toBe(true);
    expect(binding.state.undoLabel).toBe('Increment');

    editor.undo();
    expect(binding.state.content.value).toBe(0);
    expect(binding.state.canRedo).toBe(true);
    expect(binding.state.redoLabel).toBe('Increment');

    editor.redo();
    expect(binding.state.content.value).toBe(3);
    expect(binding.state.canRedo).toBe(false);

    binding.dispose();
    editor.dispose();
  });

  it('tracks selection replacement used by editor-bound components', async () => {
    const editor = makeEditor();
    const binding = await bind(editor);
    const selection = Selection.empty().add('piece', 'front');

    editor.setSelection(selection);

    expect(binding.state.selection).toBe(selection);
    expect(binding.state.selection.get('piece')).toEqual(new Set(['front']));

    binding.dispose();
    editor.dispose();
  });

  it('unsubscribes every editor channel when its effect scope is disposed', async () => {
    const editor = makeEditor();
    const subscriptions = new Set<() => void>();
    const originalOn = editor.on.bind(editor);
    editor.on = (event, listener) => {
      const unsubscribe = originalOn(event, listener);
      subscriptions.add(unsubscribe);
      return () => {
        subscriptions.delete(unsubscribe);
        unsubscribe();
      };
    };
    const binding = await bind(editor);

    expect(subscriptions.size).toBe(3);
    const initialDoc = binding.state.doc;
    binding.dispose();
    expect(subscriptions.size).toBe(0);

    editor.execute('counter.increment', { by: 2 });
    expect(binding.state.doc).toBe(initialDoc);

    editor.dispose();
  });
});
