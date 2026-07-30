export interface LocalDocumentStoreOptions {
  dbName?: string;
  version?: number;
}

export interface LocalDocumentMetadata {
  id: string;
  name: string;
  updatedAt: string;
}

export interface LocalDocumentVersionMetadata {
  id: string;
  documentId: string;
  name: string;
  savedAt: string;
}

export interface DocumentAutosave {
  /** Restarts the debounce window after a document change. */
  schedule(): void;
  /** Saves the current snapshot immediately. */
  flush(): Promise<void>;
  dispose(): void;
}

export interface DocumentAutosaveOptions {
  debounceMs: number;
}

interface StoredDocument<T> extends LocalDocumentMetadata {
  snapshot: T;
}

interface StoredDocumentVersion<T> extends LocalDocumentVersionMetadata {
  snapshot: T;
}

const DOCUMENTS_STORE = 'documents';
const VERSIONS_STORE = 'versions';
const DOCUMENT_ID_INDEX = 'documentId';

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function versionId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `version_${randomId.replaceAll('-', '')}`;
  return `version_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Browser-local documents and named snapshots.
 *
 * This uses a separate `atelier-documents` database so document schema
 * upgrades cannot conflict with independently configured history persistence.
 */
export class LocalDocumentStore<T> {
  readonly #dbName: string;
  readonly #version: number;
  #database: Promise<IDBDatabase> | null = null;
  #disposed = false;

  constructor(options: LocalDocumentStoreOptions = {}) {
    this.#dbName = options.dbName ?? 'atelier-documents';
    this.#version = options.version ?? 1;
  }

  async save(
    id: string,
    name: string,
    snapshot: T,
  ): Promise<LocalDocumentMetadata> {
    const database = await this.open();
    const metadata: LocalDocumentMetadata = {
      id,
      name,
      updatedAt: new Date().toISOString(),
    };
    const record: StoredDocument<T> = plain({ ...metadata, snapshot });
    const transaction = database.transaction(DOCUMENTS_STORE, 'readwrite');
    transaction.objectStore(DOCUMENTS_STORE).put(record);
    await transactionDone(transaction);
    return metadata;
  }

  async load(id: string): Promise<T | null> {
    const record = await this.loadRecord(id);
    return record?.snapshot ?? null;
  }

  async list(): Promise<LocalDocumentMetadata[]> {
    const database = await this.open();
    const records = await requestResult(
      database
        .transaction(DOCUMENTS_STORE, 'readonly')
        .objectStore(DOCUMENTS_STORE)
        .getAll() as IDBRequest<Array<StoredDocument<T>>>,
    );
    return records
      .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(DOCUMENTS_STORE, 'readwrite');
    transaction.objectStore(DOCUMENTS_STORE).delete(id);
    await transactionDone(transaction);
  }

  async saveVersion(
    documentId: string,
    name: string,
    snapshot: T,
  ): Promise<LocalDocumentVersionMetadata> {
    const database = await this.open();
    const metadata: LocalDocumentVersionMetadata = {
      id: versionId(),
      documentId,
      name,
      savedAt: new Date().toISOString(),
    };
    const record: StoredDocumentVersion<T> = plain({ ...metadata, snapshot });
    const transaction = database.transaction(VERSIONS_STORE, 'readwrite');
    transaction.objectStore(VERSIONS_STORE).put(record);
    await transactionDone(transaction);
    return metadata;
  }

  async listVersions(
    documentId: string,
  ): Promise<LocalDocumentVersionMetadata[]> {
    const database = await this.open();
    const request = database
      .transaction(VERSIONS_STORE, 'readonly')
      .objectStore(VERSIONS_STORE)
      .index(DOCUMENT_ID_INDEX)
      .getAll(documentId) as IDBRequest<Array<StoredDocumentVersion<T>>>;
    const records = await requestResult(request);
    return records
      .map(({ id, documentId: storedDocumentId, name, savedAt }) => ({
        id,
        documentId: storedDocumentId,
        name,
        savedAt,
      }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async loadVersion(id: string): Promise<T | null> {
    const database = await this.open();
    const record = await requestResult(
      database
        .transaction(VERSIONS_STORE, 'readonly')
        .objectStore(VERSIONS_STORE)
        .get(id) as IDBRequest<StoredDocumentVersion<T> | undefined>,
    );
    return record?.snapshot ?? null;
  }

  async deleteVersion(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(VERSIONS_STORE, 'readwrite');
    transaction.objectStore(VERSIONS_STORE).delete(id);
    await transactionDone(transaction);
  }

  /**
   * Creates a debounced autosave and schedules its first save immediately.
   * Call `schedule()` after later changes; `dispose()` cancels pending work.
   */
  autosave(
    documentId: string,
    getSnapshot: () => T,
    options: DocumentAutosaveOptions,
  ): DocumentAutosave {
    const debounceMs = Math.max(0, options.debounceMs);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const flush = async (): Promise<void> => {
      if (disposed) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const existing = await this.loadRecord(documentId);
      if (disposed) return;
      await this.save(
        documentId,
        existing?.name ?? documentId,
        getSnapshot(),
      );
    };
    const schedule = (): void => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush().catch(() => {
          // Timer-driven autosave is best-effort; explicit flush reports errors.
        });
      }, debounceMs);
    };
    schedule();
    return {
      schedule,
      flush,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#database) {
      void this.#database
        .then((database) => database.close())
        .catch(() => {
          // A failed open has no resource to close.
        });
      this.#database = null;
    }
  }

  private async loadRecord(id: string): Promise<StoredDocument<T> | null> {
    const database = await this.open();
    const record = await requestResult(
      database
        .transaction(DOCUMENTS_STORE, 'readonly')
        .objectStore(DOCUMENTS_STORE)
        .get(id) as IDBRequest<StoredDocument<T> | undefined>,
    );
    return record ?? null;
  }

  private open(): Promise<IDBDatabase> {
    if (this.#disposed) {
      return Promise.reject(new Error('Document store disposed'));
    }
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB is unavailable'));
    }
    if (this.#database) return this.#database;

    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open(this.#dbName, this.#version);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
          database.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(VERSIONS_STORE)) {
          const versions = database.createObjectStore(VERSIONS_STORE, {
            keyPath: 'id',
          });
          versions.createIndex(DOCUMENT_ID_INDEX, 'documentId', {
            unique: false,
          });
        }
      };
      request.onsuccess = () => {
        if (blocked || this.#disposed) {
          request.result.close();
          if (this.#disposed) reject(new Error('Document store disposed'));
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => {
        blocked = true;
        reject(new Error('IndexedDB open blocked'));
      };
    });
    return this.#database;
  }
}
