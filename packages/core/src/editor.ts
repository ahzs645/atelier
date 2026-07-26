import {
  commandError,
  contentChanged,
  type CommandContext,
  type CommandRegistry,
  type CommandResult,
  type CommandSchema,
} from './command';
import { makeUid, withContent, type Doc } from './doc';
import { History, type HistoryOptions } from './history';
import { Selection } from './selection';

export interface EditorOptions<T> {
  registry: CommandRegistry<T>;
  history?: HistoryOptions;
}

export type EditorEvent = 'doc' | 'selection' | 'history' | 'error';

type CommandExecution<T> = {
  result: CommandResult;
  next: T;
  label: string;
  mutating: boolean;
};

type ErasedRun<T> = (
  content: T,
  params: unknown,
  ctx: CommandContext<T>,
) => T;

export const editorAutomation = Symbol('atelier.editorAutomation');
export const editorTransaction = Symbol('atelier.editorTransaction');

export interface EditorAutomation<T> {
  schema(): CommandSchema<T>;
}

interface EditorTransactionHost<T> {
  run<P>(doc: Doc<T>, type: string, params?: P): CommandExecution<T>;
  apply(content: T, label: string, recordHistory: boolean): boolean;
}

export class Editor<T> {
  readonly #registry: CommandRegistry<T>;
  readonly #history: History<T>;
  readonly #listeners = new Map<EditorEvent, Set<(editor: Editor<T>) => void>>();

  #doc: Doc<T>;
  #selection = Selection.empty();
  #disposed = false;

  constructor(initial: Doc<T>, opts: EditorOptions<T>) {
    this.#doc = initial;
    this.#registry = opts.registry;
    this.#history = new History<T>({
      ...opts.history,
      onError: (message) => {
        opts.history?.onError?.(message);
        this.emit('error');
      },
    });
    void this.#history.bind(initial.meta.id).then((restored) => {
      if (restored) this.emit('history');
    });
  }

  get doc(): Doc<T> {
    return this.#doc;
  }

  get content(): T {
    return this.#doc.content;
  }

  get selection(): Selection {
    return this.#selection;
  }

  setSelection(next: Selection): void {
    if (this.#selection.equals(next)) return;
    this.#selection = next;
    this.emit('selection');
  }

  execute<P>(type: string, params?: P): CommandResult {
    const execution = this.run(this.#doc, type, params);
    if (!execution.result.ok) return execution.result;
    if (execution.result.changed) {
      this.apply(execution.next, execution.label, execution.mutating);
    }
    return execution.result;
  }

  preview<P>(type: string, params?: P): CommandResult {
    return this.run(this.#doc, type, params).result;
  }

  transaction(label = 'Transaction'): Transaction<T> {
    return new Transaction(this, label);
  }

  undo(): boolean {
    if (this.#disposed) return false;
    const previous = this.#history.undo(this.#doc);
    if (!previous) return false;
    this.#doc = previous;
    this.emit('doc');
    this.emit('history');
    return true;
  }

  redo(): boolean {
    if (this.#disposed) return false;
    const next = this.#history.redo(this.#doc);
    if (!next) return false;
    this.#doc = next;
    this.emit('doc');
    this.emit('history');
    return true;
  }

  get canUndo(): boolean {
    return this.#history.undoLabel !== null;
  }

  get canRedo(): boolean {
    return this.#history.redoLabel !== null;
  }

  on(event: EditorEvent, fn: (editor: Editor<T>) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(fn);
    this.#listeners.set(event, listeners);
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0) this.#listeners.delete(event);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#history.dispose();
    this.#listeners.clear();
  }

  [editorAutomation](): EditorAutomation<T> {
    return {
      schema: () => this.#registry.schema(),
    };
  }

  [editorTransaction](): EditorTransactionHost<T> {
    return {
      run: (doc, type, params) => this.run(doc, type, params),
      apply: (content, label, recordHistory) =>
        this.apply(content, label, recordHistory),
    };
  }

  private run<P>(doc: Doc<T>, type: string, params?: P): CommandExecution<T> {
    if (this.#disposed) {
      const execution: CommandExecution<T> = {
        result: { ok: false, changed: false, error: 'Editor disposed' },
        next: doc.content,
        label: '',
        mutating: false,
      };
      this.emit('error');
      return execution;
    }

    const def = this.#registry.get(type);
    if (!def) {
      const execution: CommandExecution<T> = {
        result: { ok: false, changed: false, error: `Unknown command: ${type}` },
        next: doc.content,
        label: '',
        mutating: false,
      };
      this.emit('error');
      return execution;
    }

    try {
      const run = def.run as unknown as ErasedRun<T>;
      const next = run(doc.content, params === undefined ? {} : params, {
        selection: this.#selection,
        uid: makeUid,
        doc,
      });
      return {
        result: { ok: true, changed: contentChanged(doc.content, next) },
        next,
        label: def.label ?? def.summary,
        mutating: def.mutating ?? true,
      };
    } catch (error) {
      const execution: CommandExecution<T> = {
        result: commandError(error),
        next: doc.content,
        label: def.label ?? def.summary,
        mutating: def.mutating ?? true,
      };
      this.emit('error');
      return execution;
    }
  }

  private apply(content: T, label: string, recordHistory: boolean): boolean {
    if (this.#disposed) return false;
    if (recordHistory) this.#history.push(this.#doc, label);
    this.#doc = withContent(this.#doc, content);
    this.emit('doc');
    if (recordHistory) this.emit('history');
    return true;
  }

  private emit(event: EditorEvent): void {
    if (this.#disposed) return;
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(this);
  }
}

export class Transaction<T> {
  readonly #host: EditorTransactionHost<T>;
  readonly #label: string;
  #working: Doc<T>;
  #dirty = false;
  #recordHistory = false;
  #done = false;

  constructor(editor: Editor<T>, label: string) {
    this.#host = editor[editorTransaction]();
    this.#label = label;
    this.#working = editor.doc;
  }

  execute<P>(type: string, params?: P): CommandResult {
    if (this.#done) return this.finishedResult();
    const execution = this.#host.run(this.#working, type, params);
    if (execution.result.changed) {
      this.#working = { ...this.#working, content: execution.next };
      this.#dirty = true;
      this.#recordHistory ||= execution.mutating;
    }
    return execution.result;
  }

  preview<P>(type: string, params?: P): CommandResult {
    if (this.#done) return this.finishedResult();
    return this.#host.run(this.#working, type, params).result;
  }

  commit(): boolean {
    if (this.#done) return false;
    this.#done = true;
    if (!this.#dirty) return false;
    return this.#host.apply(this.#working.content, this.#label, this.#recordHistory);
  }

  rollback(): void {
    this.#done = true;
  }

  private finishedResult(): CommandResult {
    return {
      ok: false,
      changed: false,
      error: 'Transaction already finished',
    };
  }
}
