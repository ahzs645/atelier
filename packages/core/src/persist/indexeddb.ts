import type { Id } from '../doc';
import type { HistoryEntry, HistoryPersistence } from '../history';

export interface IndexedDbHistoryPersistenceOptions {
  dbName?: string;
  storeName?: string;
  version?: number;
}

interface StoredHistory<T> {
  docId: Id;
  undo: Array<HistoryEntry<T>>;
  redo: Array<HistoryEntry<T>>;
  savedAt: string;
}

export class IndexedDbHistoryPersistence<T = unknown>
  implements HistoryPersistence<T>
{
  readonly #dbName: string;
  readonly #storeName: string;
  readonly #version: number;
  #database: Promise<IDBDatabase> | null = null;
  #disposed = false;

  constructor(opts: IndexedDbHistoryPersistenceOptions = {}) {
    this.#dbName = opts.dbName ?? 'atelier';
    this.#storeName = opts.storeName ?? 'history';
    this.#version = opts.version ?? 1;
  }

  async save(
    docId: Id,
    undo: Array<HistoryEntry<T>>,
    redo: Array<HistoryEntry<T>>,
  ): Promise<void> {
    const database = await this.open();
    const record = this.toPlain({
      docId,
      undo,
      redo,
      savedAt: new Date().toISOString(),
    });

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(this.#storeName, 'readwrite');
      transaction.objectStore(this.#storeName).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB save failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB save aborted'));
    });
  }

  async load(
    docId: Id,
  ): Promise<{ undo: Array<HistoryEntry<T>>; redo: Array<HistoryEntry<T>> } | null> {
    const database = await this.open();
    const record = await new Promise<StoredHistory<T> | null>((resolve, reject) => {
      const request = database
        .transaction(this.#storeName, 'readonly')
        .objectStore(this.#storeName)
        .get(docId);
      request.onsuccess = () => {
        resolve((request.result as StoredHistory<T> | undefined) ?? null);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB load failed'));
    });

    return record ? { undo: record.undo, redo: record.redo } : null;
  }

  async delete(docId: Id): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(this.#storeName, 'readwrite');
      transaction.objectStore(this.#storeName).delete(docId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB delete failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB delete aborted'));
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#database) {
      void this.#database.then((database) => database.close()).catch(() => {
        // A failed open has no resource to close.
      });
      this.#database = null;
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.#disposed) return Promise.reject(new Error('Persistence disposed'));
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB is unavailable'));
    }
    if (this.#database) return this.#database;

    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(this.#dbName, this.#version);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.#storeName)) {
          database.createObjectStore(this.#storeName, { keyPath: 'docId' });
        }
      };
      request.onsuccess = () => {
        if (blocked || this.#disposed) {
          request.result.close();
          if (this.#disposed) reject(new Error('Persistence disposed'));
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('IndexedDB open blocked'));
      };
    });
    return this.#database;
  }

  private toPlain(record: StoredHistory<T>): StoredHistory<T> {
    return JSON.parse(JSON.stringify(record)) as StoredHistory<T>;
  }
}
