// @vitest-environment happy-dom
//
// Reactivity contract for the React binding.
//
// Browser verification of `packcad` found the undo/redo toolbar buttons never enabling after an
// edit, while the same commands recorded history correctly when driven headlessly. That gap
// existed because this binding had no reactivity test at all: `useSyncExternalStore` can look
// perfectly correct by inspection and still fail to re-render if the snapshot cache or the
// subscription is subtly wrong. These tests pin the contract.

import { CommandRegistry, Editor, createDoc } from '@atelier/core';
import type { CommandDef } from '@atelier/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useEditor } from './index';

interface Counter {
  value: number;
  label: string;
}

const bump: CommandDef<Counter, { by: number }> = {
  type: 'counter.bump',
  category: 'counter',
  summary: 'Bump the counter',
  inputs: ['by'],
  label: 'Bump counter',
  run: (content, params) => ({ ...content, value: content.value + params.by }),
};

/** A reducer that deliberately returns its input unchanged. */
const noop: CommandDef<Counter, Record<string, never>> = {
  type: 'counter.noop',
  category: 'counter',
  summary: 'Do nothing',
  inputs: [],
  run: (content) => content,
};

function makeEditor(): Editor<Counter> {
  const registry = new CommandRegistry<Counter>().register(bump).register(noop);
  return new Editor<Counter>(createDoc<Counter>({ value: 0, label: 'x' }, { name: 'test' }), {
    registry,
    history: { coalesceMs: 0 },
  });
}

function Probe({ editor }: { editor: Editor<Counter> }): React.ReactElement {
  const state = useEditor(editor);
  return (
    <div>
      <span data-testid="value">{state.content.value}</span>
      <span data-testid="canUndo">{String(state.canUndo)}</span>
      <span data-testid="canRedo">{String(state.canRedo)}</span>
      <span data-testid="undoLabel">{state.undoLabel ?? '-'}</span>
    </div>
  );
}

const read = (id: string): string => screen.getByTestId(id).textContent ?? '';

// vitest does not enable globals here, so testing-library's automatic cleanup never registers.
afterEach(cleanup);

describe('useEditor reactivity', () => {
  it('re-renders with canUndo enabled after a command changes the document', () => {
    const editor = makeEditor();
    render(<Probe editor={editor} />);

    expect(read('value')).toBe('0');
    expect(read('canUndo')).toBe('false');

    act(() => {
      editor.execute('counter.bump', { by: 3 });
    });

    // This is the exact assertion that would have caught the packcad toolbar bug.
    expect(read('value')).toBe('3');
    expect(read('canUndo')).toBe('true');
    expect(read('undoLabel')).toBe('Bump counter');
  });

  it('re-renders through undo and redo', () => {
    const editor = makeEditor();
    render(<Probe editor={editor} />);

    act(() => {
      editor.execute('counter.bump', { by: 5 });
    });
    expect(read('value')).toBe('5');

    act(() => {
      editor.undo();
    });
    expect(read('value')).toBe('0');
    expect(read('canUndo')).toBe('false');
    expect(read('canRedo')).toBe('true');

    act(() => {
      editor.redo();
    });
    expect(read('value')).toBe('5');
    expect(read('canRedo')).toBe('false');
  });

  it('does not enable undo for a reducer that returns the document unchanged', () => {
    const editor = makeEditor();
    render(<Probe editor={editor} />);

    act(() => {
      editor.execute('counter.noop', {});
    });

    expect(read('canUndo')).toBe('false');
  });

  it('tracks a transaction as a single undo entry', () => {
    const editor = makeEditor();
    render(<Probe editor={editor} />);

    act(() => {
      const tx = editor.transaction('Bump twice');
      tx.execute('counter.bump', { by: 1 });
      tx.execute('counter.bump', { by: 1 });
      tx.commit();
    });

    expect(read('value')).toBe('2');
    expect(read('canUndo')).toBe('true');

    act(() => {
      editor.undo();
    });
    expect(read('value')).toBe('0');
  });

  it('stops re-rendering once unmounted', () => {
    const editor = makeEditor();
    const view = render(<Probe editor={editor} />);
    view.unmount();
    // No listeners should remain; executing must not throw.
    expect(() => editor.execute('counter.bump', { by: 1 })).not.toThrow();
  });
});
