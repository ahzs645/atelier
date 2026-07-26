import { describe, expect, it, vi } from 'vitest';
import { RenderLeaseCounter } from './viewport';

describe('RenderLeaseCounter', () => {
  it('reference-counts releases and makes each release idempotent', () => {
    const onFirstAcquire = vi.fn();
    const leases = new RenderLeaseCounter(onFirstAcquire);
    const releaseFirst = leases.acquire();
    const releaseSecond = leases.acquire();

    expect(leases.size).toBe(2);
    expect(onFirstAcquire).toHaveBeenCalledTimes(1);

    releaseFirst();
    releaseFirst();
    expect(leases.size).toBe(1);

    releaseSecond();
    expect(leases.size).toBe(0);
  });

  it('drops every lease on dispose and ignores later acquire/release calls', () => {
    const leases = new RenderLeaseCounter();
    const release = leases.acquire();
    leases.acquire();

    leases.dispose();
    expect(leases.size).toBe(0);

    release();
    const releaseAfterDispose = leases.acquire();
    releaseAfterDispose();
    expect(leases.size).toBe(0);
  });
});
