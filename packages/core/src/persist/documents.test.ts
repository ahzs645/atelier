import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDocumentStore } from './index';

interface StoreState {
  keyPath: string;
  records: Map<IDBValidKey, unknown>;
  indexes: Map<string, string>;
}

class MemoryRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  succeed(result: T): void {
    this.result = result;
    this.onsuccess?.(new Event('success'));
  }
}

class MemoryTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  #pending = 0;

  constructor(readonly stores: Map<string, StoreState>) {}

  objectStore(name: string): IDBObjectStore {
    const state = this.stores.get(name);
    if (!state) throw new Error(`Missing object store ${name}`);
    return new MemoryObjectStore(state, this) as unknown as IDBObjectStore;
  }

  run<T>(operation: () => T): IDBRequest<T> {
    const request = new MemoryRequest<T>();
    this.#pending += 1;
    queueMicrotask(() => {
      request.succeed(operation());
      this.#pending -= 1;
      if (this.#pending === 0) {
        queueMicrotask(() => this.oncomplete?.(new Event('complete')));
      }
    });
    return request as unknown as IDBRequest<T>;
  }
}

class MemoryIndex {
  constructor(
    readonly state: StoreState,
    readonly transaction: MemoryTransaction,
    readonly keyPath: string,
  ) {}

  getAll(key?: IDBValidKey): IDBRequest<unknown[]> {
    return this.transaction.run(() =>
      [...this.state.records.values()].filter((value) => {
        if (key === undefined) return true;
        const record = value as Record<string, unknown>;
        return record[this.keyPath] === key;
      }),
    );
  }
}

class MemoryObjectStore {
  constructor(
    readonly state: StoreState,
    readonly transaction: MemoryTransaction,
  ) {}

  createIndex(name: string, keyPath: string): IDBIndex {
    this.state.indexes.set(name, keyPath);
    return new MemoryIndex(
      this.state,
      this.transaction,
      keyPath,
    ) as unknown as IDBIndex;
  }

  index(name: string): IDBIndex {
    const keyPath = this.state.indexes.get(name);
    if (!keyPath) throw new Error(`Missing index ${name}`);
    return new MemoryIndex(
      this.state,
      this.transaction,
      keyPath,
    ) as unknown as IDBIndex;
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    return this.transaction.run(() => {
      const record = value as Record<string, unknown>;
      const key = record[this.state.keyPath] as IDBValidKey;
      this.state.records.set(key, value);
      return key;
    });
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    return this.transaction.run(() => this.state.records.get(key));
  }

  getAll(): IDBRequest<unknown[]> {
    return this.transaction.run(() => [...this.state.records.values()]);
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.transaction.run(() => {
      this.state.records.delete(key);
      return undefined;
    });
  }
}

class MemoryDatabase {
  readonly stores = new Map<string, StoreState>();
  onversionchange: ((event: Event) => void) | null = null;

  get objectStoreNames(): Pick<DOMStringList, 'contains'> {
    return { contains: (name) => this.stores.has(name) };
  }

  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters,
  ): IDBObjectStore {
    const state: StoreState = {
      keyPath: String(options?.keyPath ?? 'id'),
      records: new Map(),
      indexes: new Map(),
    };
    this.stores.set(name, state);
    return new MemoryObjectStore(
      state,
      new MemoryTransaction(this.stores),
    ) as unknown as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new MemoryTransaction(this.stores) as unknown as IDBTransaction;
  }

  close(): void {}
}

class MemoryOpenRequest extends MemoryRequest<IDBDatabase> {
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class MemoryIndexedDb {
  readonly databases = new Map<string, MemoryDatabase>();

  open(name: string): IDBOpenDBRequest {
    const request = new MemoryOpenRequest();
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const upgrade = database === undefined;
      if (!database) {
        database = new MemoryDatabase();
        this.databases.set(name, database);
      }
      request.result = database as unknown as IDBDatabase;
      if (upgrade) {
        request.onupgradeneeded?.(
          new Event('upgradeneeded') as IDBVersionChangeEvent,
        );
      }
      request.succeed(database as unknown as IDBDatabase);
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

interface TestDocument {
  value: number;
  nested?: { label: string };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new MemoryIndexedDb() as unknown as IDBFactory);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LocalDocumentStore', () => {
  it('saves, lists, loads, and deletes documents', async () => {
    const store = new LocalDocumentStore<TestDocument>({
      dbName: 'documents-crud',
    });
    const metadata = await store.save('doc-1', 'First', {
      value: 1,
      nested: { label: 'saved' },
    });

    expect(metadata).toMatchObject({ id: 'doc-1', name: 'First' });
    expect(await store.load('doc-1')).toEqual({
      value: 1,
      nested: { label: 'saved' },
    });
    expect(await store.list()).toEqual([metadata]);

    await store.delete('doc-1');
    expect(await store.load('doc-1')).toBeNull();
    store.dispose();
  });

  it('saves, lists, loads, and deletes named versions', async () => {
    const store = new LocalDocumentStore<TestDocument>({
      dbName: 'document-versions',
    });
    const first = await store.saveVersion(
      'doc-1',
      'Before edit',
      { value: 1 },
    );
    const second = await store.saveVersion(
      'doc-1',
      'After edit',
      { value: 2 },
    );
    await store.saveVersion('doc-2', 'Other document', { value: 3 });

    expect((await store.listVersions('doc-1')).map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await store.loadVersion(second.id)).toEqual({ value: 2 });

    await store.deleteVersion(second.id);
    expect(await store.loadVersion(second.id)).toBeNull();
    store.dispose();
  });

  it('debounces autosave and preserves an existing document name', async () => {
    vi.useFakeTimers();
    const store = new LocalDocumentStore<TestDocument>({
      dbName: 'document-autosave',
    });
    await store.save('doc-1', 'Named document', { value: 0 });
    let value = 1;
    const getSnapshot = vi.fn(() => ({ value }));
    const autosave = store.autosave('doc-1', getSnapshot, {
      debounceMs: 50,
    });

    value = 2;
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(49);
    expect(getSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1));

    expect(await store.load('doc-1')).toEqual({ value: 2 });
    expect(await store.list()).toMatchObject([
      { id: 'doc-1', name: 'Named document' },
    ]);
    autosave.dispose();
    store.dispose();
  });

  it('cancels a pending autosave on dispose', async () => {
    vi.useFakeTimers();
    const store = new LocalDocumentStore<TestDocument>({
      dbName: 'document-autosave-dispose',
    });
    const getSnapshot = vi.fn(() => ({ value: 1 }));
    const autosave = store.autosave('doc-1', getSnapshot, {
      debounceMs: 20,
    });

    autosave.dispose();
    await vi.advanceTimersByTimeAsync(20);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(await store.load('doc-1')).toBeNull();
    store.dispose();
  });
});
