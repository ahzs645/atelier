import { describe, expect, it, vi } from 'vitest';
import { IndexedDbHistoryPersistence, persisted } from './index';

describe('persisted', () => {
  it('acts as a framework-free store when localStorage is unavailable', () => {
    const value = persisted('test.setting', 1);
    const seen: number[] = [];
    const unsubscribe = value.subscribe((next) => seen.push(next));
    value.set(2);
    value.update((next) => next + 3);
    unsubscribe();
    value.set(10);

    expect(value.get()).toBe(10);
    expect(seen).toEqual([1, 2, 5]);
    value.dispose();
  });

  it('stops updates and notifications after disposal', () => {
    const value = persisted('test.disposed', 'before');
    const listener = vi.fn();
    value.subscribe(listener);
    value.dispose();
    value.set('after');
    expect(value.get()).toBe('before');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('IndexedDbHistoryPersistence', () => {
  it('reports unavailable IndexedDB as a rejected recoverable operation', async () => {
    const persistence = new IndexedDbHistoryPersistence();
    await expect(persistence.load('doc')).rejects.toThrow('IndexedDB is unavailable');
    persistence.dispose();
  });

  it('rejects operations after disposal without touching browser globals', async () => {
    const persistence = new IndexedDbHistoryPersistence();
    persistence.dispose();
    await expect(persistence.delete('doc')).rejects.toThrow('Persistence disposed');
  });
});
