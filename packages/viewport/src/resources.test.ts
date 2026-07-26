import { describe, expect, it } from 'vitest';
import { ResourceScope } from './resources';

describe('ResourceScope', () => {
  it('tracks each resource once and releases idempotently', () => {
    const scope = new ResourceScope();
    let firstDisposals = 0;
    let secondDisposals = 0;
    const first = { dispose: () => { firstDisposals += 1; } };
    const second = { dispose: () => { secondDisposals += 1; } };

    expect(scope.track(first)).toBe(first);
    scope.track(first);
    scope.track(second);
    scope.release();
    scope.release();

    expect(firstDisposals).toBe(1);
    expect(secondDisposals).toBe(1);
  });

  it('can own a new batch after release', () => {
    const scope = new ResourceScope();
    let disposals = 0;
    const resource = { dispose: () => { disposals += 1; } };
    scope.track(resource);
    scope.release();
    scope.track(resource);
    scope.release();
    expect(disposals).toBe(2);
  });
});
