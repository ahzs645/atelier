import { describe, expect, it, vi } from 'vitest';
import {
  CommandRegistry,
  Editor,
  History,
  Selection,
  createDoc,
  installAutomationApi,
  makeUid,
  withContent,
  type CommandDef,
  type Doc,
  type HistoryEntry,
  type HistoryPersistence,
} from './index';

interface ToyContent {
  count: number;
  name: string;
}

interface AddParams {
  amount: number;
}

interface RenameParams {
  name: string;
}

function toyDoc(count = 0): Doc<ToyContent> {
  return createDoc(
    { count, name: 'Toy' },
    {
      id: 'toy',
      name: 'Toy',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  );
}

function toyRegistry(): CommandRegistry<ToyContent> {
  const registry = new CommandRegistry<ToyContent>();
  registry.register<AddParams>({
    type: 'count.add',
    category: 'count',
    summary: 'Add count',
    label: 'Add count',
    inputs: ['amount'],
    example: { amount: 1 },
    run: (content, params) => ({
      ...content,
      count: content.count + params.amount,
    }),
  });
  registry.register({
    type: 'content.noop',
    category: 'content',
    summary: 'No operation',
    inputs: [],
    run: (content) => content,
  });
  registry.register({
    type: 'content.deep-equal',
    category: 'content',
    summary: 'Deep equal clone',
    inputs: [],
    run: (content) => ({ ...content }),
  });
  return registry;
}

describe('document identity', () => {
  it('creates a millimetre document with defaults', () => {
    const doc = createDoc({ value: 1 });
    expect(doc.meta).toMatchObject({
      name: 'Untitled',
      revision: 0,
      unit: 'mm',
    });
    expect(doc.meta.id).toMatch(/^doc_[0-9a-f]{9}$/);
    expect(doc.content).toEqual({ value: 1 });
  });

  it('updates content with structural sharing metadata', () => {
    const doc = toyDoc();
    const nextContent = { ...doc.content, count: 1 };
    const next = withContent(doc, nextContent);
    expect(next.content).toBe(nextContent);
    expect(next.meta.revision).toBe(1);
    expect(next.meta.id).toBe(doc.meta.id);
    expect(doc.meta.revision).toBe(0);
  });

  it('makes ids using the seamer prefix convention', () => {
    expect(makeUid('point')).toMatch(/^point_[0-9a-f]{9}$/);
  });
});

describe('Selection', () => {
  it('constructs and queries a multi-kind selection', () => {
    const selection = Selection.of([
      ['point', ['p1', 'p2']],
      ['piece', ['pc1']],
    ]);
    expect(selection.kinds()).toEqual(['point', 'piece']);
    expect(selection.size).toBe(3);
    expect(selection.has('point', 'p2')).toBe(true);
    expect(selection.get('missing').size).toBe(0);
  });

  it('keeps every mutator immutable', () => {
    const original = Selection.of([['point', ['p1', 'p2']]]);
    const added = original.add('point', 'p3');
    const removed = added.remove('point', 'p1');
    const toggled = removed.toggle('point', 'p2');
    const replaced = toggled.replace('piece', ['pc1']);
    const clearedKind = replaced.clear('point');
    const clearedAll = clearedKind.clear();

    expect(added).not.toBe(original);
    expect(removed).not.toBe(added);
    expect(toggled).not.toBe(removed);
    expect(replaced).not.toBe(toggled);
    expect(clearedKind).not.toBe(replaced);
    expect(clearedAll).not.toBe(clearedKind);
    expect([...original.get('point')]).toEqual(['p1', 'p2']);
    expect(original.has('point', 'p3')).toBe(false);
    expect(clearedAll.size).toBe(0);
  });

  it('does not expose its internal sets', () => {
    const selection = Selection.of([['point', ['p1']]]);
    const ids = selection.get('point') as Set<string>;
    const missing = selection.get('missing') as Set<string>;
    ids.add('p2');
    missing.add('ghost');
    expect(selection.has('point', 'p2')).toBe(false);
    expect(selection.has('missing', 'ghost')).toBe(false);
  });

  it('compares by kind and id rather than insertion order', () => {
    const left = Selection.of([
      ['point', ['p1', 'p2']],
      ['piece', ['pc1']],
    ]);
    const right = Selection.of([
      ['piece', ['pc1']],
      ['point', ['p2', 'p1']],
    ]);
    expect(left.equals(right)).toBe(true);
    expect(left.equals(right.remove('point', 'p1'))).toBe(false);
  });
});

describe('CommandRegistry', () => {
  it('retains typed command params at registration', () => {
    const definition: CommandDef<ToyContent, AddParams> = {
      type: 'count.add',
      category: 'count',
      summary: 'Add count',
      inputs: ['amount'],
      run: (content, params) => ({ ...content, count: content.count + params.amount }),
    };
    const registry = new CommandRegistry<ToyContent>().register(definition);
    expect(registry.get('count.add')?.type).toBe('count.add');
  });

  it('returns the serialisable schema shape', () => {
    expect(toyRegistry().schema()).toEqual([
      {
        type: 'count.add',
        category: 'count',
        summary: 'Add count',
        inputs: ['amount'],
        example: { amount: 1 },
      },
      {
        type: 'content.noop',
        category: 'content',
        summary: 'No operation',
        inputs: [],
        example: undefined,
      },
      {
        type: 'content.deep-equal',
        category: 'content',
        summary: 'Deep equal clone',
        inputs: [],
        example: undefined,
      },
    ]);
  });

  it('lists commands in registration order', () => {
    expect(toyRegistry().list().map((command) => command.type)).toEqual([
      'count.add',
      'content.noop',
      'content.deep-equal',
    ]);
  });

  it('registers heterogeneous typed parameter definitions together', () => {
    const add: CommandDef<ToyContent, AddParams> = {
      type: 'count.add',
      category: 'count',
      summary: 'Add',
      inputs: ['amount'],
      example: { amount: 1 },
      run: (content, params) => ({ ...content, count: content.count + params.amount }),
    };
    const rename: CommandDef<ToyContent, RenameParams> = {
      type: 'name.set',
      category: 'name',
      summary: 'Rename',
      inputs: ['name'],
      example: { name: 'New name' },
      run: (content, params) => ({ ...content, name: params.name }),
    };
    const registry = new CommandRegistry<ToyContent>().registerAll([add, rename]);
    expect(registry.list().map((command) => command.type)).toEqual([
      'count.add',
      'name.set',
    ]);
  });
});

describe('History', () => {
  it('coalesces rapid pushes with the same label', () => {
    let time = 1_000;
    const history = new History<ToyContent>({ now: () => time });
    history.push(toyDoc(0), 'Drag');
    time += 100;
    history.push(toyDoc(1), 'Drag');
    time += 100;
    history.push(toyDoc(2), 'Drag');
    expect(history.labels).toEqual(['Drag']);
  });

  it('does not coalesce different labels', () => {
    let time = 1_000;
    const history = new History<ToyContent>({ now: () => time });
    history.push(toyDoc(0), 'Move');
    time += 100;
    history.push(toyDoc(1), 'Rotate');
    time += 100;
    history.push(toyDoc(2), 'Scale');
    expect(history.labels).toEqual(['Move', 'Rotate', 'Scale']);
  });

  it('starts a new entry when the coalescing window has elapsed', () => {
    let time = 1_000;
    const history = new History<ToyContent>({ now: () => time });
    history.push(toyDoc(0), 'Drag');
    time += 800;
    history.push(toyDoc(1), 'Drag');
    expect(history.labels).toEqual(['Drag', 'Drag']);
  });

  it('clears redo even when a push coalesces', () => {
    let time = 1_000;
    const history = new History<ToyContent>({ now: () => time });
    history.push(toyDoc(0), 'First');
    time += 10;
    history.push(toyDoc(1), 'Second');
    expect(history.undo(toyDoc(2))?.content.count).toBe(1);
    expect(history.redoLabel).toBe('Second');
    time += 10;
    history.push(toyDoc(3), 'Second');
    expect(history.redoLabel).toBeNull();
  });

  it('round-trips undo and redo while shuttling the label', () => {
    const history = new History<ToyContent>();
    const before = toyDoc(0);
    const after = toyDoc(1);
    history.push(before, 'Add count');

    expect(history.undo(after)).toBe(before);
    expect(history.undoLabel).toBeNull();
    expect(history.redoLabel).toBe('Add count');
    expect(history.redo(before)).toBe(after);
    expect(history.undoLabel).toBe('Add count');
    expect(history.redoLabel).toBeNull();
  });

  it('evicts the oldest entries at the history limit', () => {
    let time = 0;
    const history = new History<ToyContent>({ limit: 2, now: () => ++time });
    history.push(toyDoc(0), 'One');
    history.push(toyDoc(1), 'Two');
    history.push(toyDoc(2), 'Three');
    expect(history.labels).toEqual(['Two', 'Three']);
    expect(history.undo(toyDoc(3))?.content.count).toBe(2);
    expect(history.undo(toyDoc(2))?.content.count).toBe(1);
    expect(history.undo(toyDoc(1))).toBeNull();
  });

  it('defaults to a 100-entry in-memory limit', () => {
    const history = new History<ToyContent>();
    for (let index = 0; index < 101; index += 1) {
      history.push(toyDoc(index), `Edit ${index}`);
    }
    expect(history.labels).toHaveLength(100);
    expect(history.labels[0]).toBe('Edit 1');
  });

  it('resets both stacks and labels', () => {
    const history = new History<ToyContent>();
    history.push(toyDoc(0), 'Edit');
    history.undo(toyDoc(1));
    history.reset();
    expect(history.labels).toEqual([]);
    expect(history.undoLabel).toBeNull();
    expect(history.redoLabel).toBeNull();
  });

  it('restores injected persistence without IndexedDB', async () => {
    const saved: HistoryEntry<ToyContent> = {
      doc: toyDoc(4),
      label: 'Saved edit',
      at: 20,
    };
    const persistence: HistoryPersistence<unknown> = {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => ({ undo: [saved], redo: [] })),
      delete: vi.fn(async () => {}),
    };
    const history = new History<ToyContent>({ persist: persistence });
    expect(await history.bind('toy')).toBe(true);
    expect(history.undoLabel).toBe('Saved edit');
    history.dispose();
  });

  it('reports persistence load failures without throwing', async () => {
    const errors: string[] = [];
    const persistence: HistoryPersistence<unknown> = {
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {
        throw new Error('storage offline');
      }),
      delete: vi.fn(async () => {}),
    };
    const history = new History<ToyContent>({
      persist: persistence,
      onError: (message) => errors.push(message),
    });
    await expect(history.bind('toy')).resolves.toBe(false);
    expect(errors).toEqual(['Failed to restore history: storage offline']);
  });

  it('debounces persistence for 800ms and caps each persisted stack at 30', async () => {
    vi.useFakeTimers();
    try {
      let savedUndoLength = -1;
      let saveCount = 0;
      const persistence: HistoryPersistence<unknown> = {
        save: async (_docId, undo) => {
          saveCount += 1;
          savedUndoLength = undo.length;
        },
        load: async () => null,
        delete: async () => {},
      };
      const history = new History<ToyContent>({ persist: persistence });
      await history.bind('toy');
      for (let index = 0; index < 35; index += 1) {
        history.push(toyDoc(index), `Edit ${index}`);
      }

      await vi.advanceTimersByTimeAsync(799);
      expect(saveCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(saveCount).toBe(1);
      expect(savedUndoLength).toBe(30);
      history.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Editor', () => {
  it('is driven entirely through execute on a generic content type', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    expect(editor.execute<AddParams>('count.add', { amount: 3 })).toEqual({
      ok: true,
      changed: true,
    });
    expect(editor.content.count).toBe(3);
    expect(editor.doc.meta.revision).toBe(1);
    expect(editor.canUndo).toBe(true);
    editor.dispose();
  });

  it('does not record unchanged or deep-equal reducers', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    expect(editor.execute('content.noop')).toEqual({ ok: true, changed: false });
    expect(editor.execute('content.deep-equal')).toEqual({ ok: true, changed: false });
    expect(editor.canUndo).toBe(false);
    expect(editor.doc.meta.revision).toBe(0);
    editor.dispose();
  });

  it('previews without committing', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    expect(editor.preview<AddParams>('count.add', { amount: 2 })).toEqual({
      ok: true,
      changed: true,
    });
    expect(editor.content.count).toBe(0);
    expect(editor.canUndo).toBe(false);
    editor.dispose();
  });

  it('returns command failures as typed results and emits error', () => {
    const registry = toyRegistry().register({
      type: 'content.fail',
      category: 'content',
      summary: 'Fail',
      inputs: [],
      run: () => {
        throw new Error('bad command');
      },
    });
    const editor = new Editor(toyDoc(), { registry });
    const errors = vi.fn();
    editor.on('error', errors);
    expect(editor.execute('missing')).toEqual({
      ok: false,
      changed: false,
      error: 'Unknown command: missing',
    });
    expect(editor.execute('content.fail')).toEqual({
      ok: false,
      changed: false,
      error: 'bad command',
    });
    expect(errors).toHaveBeenCalledTimes(2);
    editor.dispose();
  });

  it('passes selection and the working document through command context', () => {
    const registry = new CommandRegistry<ToyContent>().register({
      type: 'selection.count',
      category: 'selection',
      summary: 'Count selection',
      inputs: [],
      run: (content, _params, context) => ({
        ...content,
        count: context.selection.size + context.doc.meta.revision,
      }),
    });
    const editor = new Editor(toyDoc(), { registry });
    editor.setSelection(Selection.of([['point', ['p1', 'p2']]]));
    editor.execute('selection.count');
    expect(editor.content.count).toBe(2);
    editor.dispose();
  });

  it('undoes and redoes editor commands', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    editor.execute<AddParams>('count.add', { amount: 5 });
    expect(editor.undo()).toBe(true);
    expect(editor.content.count).toBe(0);
    expect(editor.canRedo).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.content.count).toBe(5);
    editor.dispose();
  });

  it('commits a transaction as exactly one history entry', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    const transaction = editor.transaction('Double add');
    expect(transaction.execute<AddParams>('count.add', { amount: 1 }).changed).toBe(true);
    expect(transaction.execute<AddParams>('count.add', { amount: 2 }).changed).toBe(true);
    expect(transaction.commit()).toBe(true);
    expect(editor.content.count).toBe(3);
    expect(editor.doc.meta.revision).toBe(1);
    expect(editor.undo()).toBe(true);
    expect(editor.content.count).toBe(0);
    expect(editor.undo()).toBe(false);
    editor.dispose();
  });

  it('rolls back a transaction without history', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    const transaction = editor.transaction();
    transaction.execute<AddParams>('count.add', { amount: 4 });
    transaction.rollback();
    expect(editor.content.count).toBe(0);
    expect(editor.canUndo).toBe(false);
    expect(transaction.execute('content.noop')).toEqual({
      ok: false,
      changed: false,
      error: 'Transaction already finished',
    });
    expect(transaction.commit()).toBe(false);
    editor.dispose();
  });

  it('does not record commands declared non-mutating', () => {
    const registry = new CommandRegistry<ToyContent>().register({
      type: 'count.read',
      category: 'count',
      summary: 'Read count',
      inputs: [],
      mutating: false,
      run: (content) => ({ ...content, count: content.count + 1 }),
    });
    const editor = new Editor(toyDoc(), { registry });
    expect(editor.execute('count.read').changed).toBe(true);
    expect(editor.content.count).toBe(1);
    expect(editor.canUndo).toBe(false);
    editor.dispose();
  });

  it('notifies observers and supports unsubscription', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    const docs = vi.fn();
    const history = vi.fn();
    const unsubscribe = editor.on('doc', docs);
    editor.on('history', history);
    editor.execute<AddParams>('count.add', { amount: 1 });
    unsubscribe();
    editor.undo();
    expect(docs).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(2);
    editor.dispose();
  });
});

describe('automation', () => {
  it('installs the generic editor surface and disposes only its own value', () => {
    const editor = new Editor(toyDoc(), { registry: toyRegistry() });
    const key = `atelier_test_${makeUid('api')}`;
    const dispose = installAutomationApi(editor, key);
    const api = (globalThis as Record<string, unknown>)[key] as {
      execute(type: string, params?: unknown): { changed: boolean };
      commands(): Array<{ type: string }>;
      getContent(): ToyContent;
    };

    expect(api.commands()[0]?.type).toBe('count.add');
    expect(api.execute('count.add', { amount: 7 }).changed).toBe(true);
    expect(api.getContent().count).toBe(7);
    dispose();
    expect((globalThis as Record<string, unknown>)[key]).toBeUndefined();
    editor.dispose();
  });
});
