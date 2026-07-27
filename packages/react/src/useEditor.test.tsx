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
import { StrictMode, useEffect } from 'react';
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

// --- React Strict Mode ------------------------------------------------------
//
// Browser verification of `packcad` found every command inert. The cause was NOT this binding:
// the app held the Editor in `useMemo` and disposed it from an effect cleanup, and Strict Mode's
// development-only effect rehearsal disposed that live instance before the first user command.
//
// The engine behaves correctly here — `execute` on a disposed Editor returns
// `{ ok: false, error: 'Editor disposed' }` rather than silently succeeding. It only *looked*
// silent because the app discarded the result. These tests pin both halves so the footgun
// cannot reappear unnoticed.

describe('Strict Mode', () => {
  it('reports a disposed editor instead of failing silently', () => {
    const editor = makeEditor();
    editor.dispose();
    const result = editor.execute('counter.bump', { by: 1 });
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.error).toBe('Editor disposed');
  });

  it('stays live under Strict Mode when the editor outlives the component', () => {
    // The correct pattern: the Editor's lifetime is owned outside the component tree, so Strict
    // Mode's rehearsed mount/unmount cannot dispose it.
    const editor = makeEditor();
    render(
      <StrictMode>
        <Probe editor={editor} />
      </StrictMode>,
    );

    act(() => {
      editor.execute('counter.bump', { by: 2 });
    });

    expect(read('value')).toBe('2');
    expect(read('canUndo')).toBe('true');
  });

  it('goes inert if an effect cleanup disposes the editor — the packcad failure', () => {
    // Reproduces the original defect exactly: dispose from an effect cleanup under Strict Mode.
    const editor = makeEditor();
    function SelfDisposing(): React.ReactElement {
      useEffect(() => () => editor.dispose(), []);
      return <Probe editor={editor} />;
    }
    render(
      <StrictMode>
        <SelfDisposing />
      </StrictMode>,
    );

    const result = editor.execute('counter.bump', { by: 1 });
    // Strict Mode rehearses mount → unmount → mount, so the cleanup already ran.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Editor disposed');
  });
});
