import type { Doc, Id } from './doc';

export interface HistoryEntry<T> {
  doc: Doc<T>;
  label: string;
  at: number;
}

export interface HistoryPersistence<T> {
  save(
    docId: Id,
    undo: Array<HistoryEntry<T>>,
    redo: Array<HistoryEntry<T>>,
  ): Promise<void>;
  load(
    docId: Id,
  ): Promise<{ undo: Array<HistoryEntry<T>>; redo: Array<HistoryEntry<T>> } | null>;
  delete(docId: Id): Promise<void>;
}

export interface HistoryOptions {
  limit?: number;
  coalesceMs?: number;
  persist?: HistoryPersistence<unknown> | null;
  persistLimit?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;
const PERSIST_LIMIT = 30;
const PERSIST_DEBOUNCE_MS = 800;

export class History<T> {
  readonly #limit: number;
  readonly #coalesceMs: number;
  readonly #persist: HistoryPersistence<unknown> | null;
  readonly #persistLimit: number;
  readonly #now: () => number;
  readonly #onError: ((message: string) => void) | undefined;

  #undo: Array<HistoryEntry<T>> = [];
  #redo: Array<HistoryEntry<T>> = [];
  #docId: Id | null = null;
  #persistTimer: ReturnType<typeof setTimeout> | null = null;
  #restoring = false;
  #disposed = false;
  #lastPushLabel = '';
  #lastPushAt = 0;

  constructor(opts: HistoryOptions = {}) {
    this.#limit = Math.max(0, opts.limit ?? HISTORY_LIMIT);
    this.#coalesceMs = Math.max(0, opts.coalesceMs ?? COALESCE_MS);
    this.#persist = opts.persist ?? null;
    this.#persistLimit = Math.max(0, opts.persistLimit ?? PERSIST_LIMIT);
    this.#now = opts.now ?? Date.now;
    this.#onError = opts.onError;
  }

  push(doc: Doc<T>, label: string): void {
    const now = this.#now();
    const coalesce =
      label === this.#lastPushLabel &&
      now - this.#lastPushAt < this.#coalesceMs &&
      this.#undo.length > 0;

    this.#lastPushLabel = label;
    this.#lastPushAt = now;

    if (coalesce) {
      if (this.#redo.length > 0) {
        this.#redo = [];
        this.schedulePersist();
      }
      return;
    }

    this.#undo.push({ doc, label, at: now });
    this.#redo = [];
    this.enforceLimit(this.#undo);
    this.schedulePersist();
  }

  undo(current: Doc<T>): Doc<T> | null {
    const entry = this.#undo.pop();
    if (!entry) return null;
    this.#redo.push({
      doc: current,
      label: entry.label,
      at: this.#now(),
    });
    this.schedulePersist();
    return entry.doc;
  }

  redo(current: Doc<T>): Doc<T> | null {
    const entry = this.#redo.pop();
    if (!entry) return null;
    this.#undo.push({
      doc: current,
      label: entry.label,
      at: this.#now(),
    });
    this.enforceLimit(this.#undo);
    this.schedulePersist();
    return entry.doc;
  }

  get undoLabel(): string | null {
    return this.#undo.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.#redo.at(-1)?.label ?? null;
  }

  get labels(): readonly string[] {
    return this.#undo.map((entry) => entry.label);
  }

  reset(): void {
    this.#undo = [];
    this.#redo = [];
    this.schedulePersist();
  }

  async bind(docId: Id): Promise<boolean> {
    this.#docId = docId;
    if (!this.#persist || this.#disposed) return false;

    try {
      const record = await this.#persist.load(docId);
      if (!record || (record.undo.length === 0 && record.redo.length === 0)) return false;

      this.#restoring = true;
      this.#undo = (record.undo as Array<HistoryEntry<T>>).slice(-this.#limit);
      this.#redo = (record.redo as Array<HistoryEntry<T>>).slice(-this.#limit);
      this.#restoring = false;
      this.schedulePersist();
      return true;
    } catch (error) {
      this.#restoring = false;
      this.reportError('Failed to restore history', error);
      return false;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
  }

  private enforceLimit(stack: Array<HistoryEntry<T>>): void {
    if (stack.length > this.#limit) stack.splice(0, stack.length - this.#limit);
  }

  private schedulePersist(): void {
    if (
      this.#restoring ||
      this.#disposed ||
      !this.#docId ||
      !this.#persist
    ) {
      return;
    }
    if (this.#persistTimer) clearTimeout(this.#persistTimer);

    const docId = this.#docId;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      const undo: Array<HistoryEntry<unknown>> = this.#undo.slice(-this.#persistLimit);
      const redo: Array<HistoryEntry<unknown>> = this.#redo.slice(-this.#persistLimit);
      void this.#persist?.save(docId, undo, redo).catch((error: unknown) => {
        this.reportError('Failed to persist history', error);
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  private reportError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#onError?.(`${message}: ${detail}`);
  }
}
