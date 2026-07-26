export { IndexedDbHistoryPersistence } from './indexeddb';

export interface Persisted<T> {
  get(): T;
  set(value: T): void;
  update(fn: (value: T) => T): void;
  subscribe(fn: (value: T) => void): () => void;
  dispose(): void;
}

export function persisted<T>(key: string, initial: T): Persisted<T> {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();
  let disposed = false;

  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) value = JSON.parse(raw) as T;
    } catch {
      // Storage can be unavailable even when the global exists.
    }
  }

  const save = (next: T): void => {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Settings persistence is best-effort, matching seamer's helper.
    }
  };

  save(value);

  return {
    get: () => value,
    set: (next) => {
      if (disposed || Object.is(value, next)) return;
      value = next;
      save(value);
      for (const subscriber of [...subscribers]) subscriber(value);
    },
    update: (fn) => {
      if (disposed) return;
      const next = fn(value);
      if (Object.is(value, next)) return;
      value = next;
      save(value);
      for (const subscriber of [...subscribers]) subscriber(value);
    },
    subscribe: (fn) => {
      if (disposed) return () => {};
      subscribers.add(fn);
      fn(value);
      return () => subscribers.delete(fn);
    },
    dispose: () => {
      disposed = true;
      subscribers.clear();
    },
  };
}
