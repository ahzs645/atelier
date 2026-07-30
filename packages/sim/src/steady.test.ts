import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import {
  createSolveHost,
  SolveSuperseded,
  type SteadySolverSession,
} from "./index";
import type { SolveWorker } from "./index";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (value: T): void => {
    void value;
  };
  let reject = (error: unknown): void => {
    void error;
  };
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeSession
  implements SteadySolverSession<string, string, number>
{
  readonly calls: Array<{
    query: string;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
    result: Deferred<string>;
  }> = [];
  disposeCalls = 0;

  solve(
    query: string,
    opts?: {
      signal?: AbortSignal;
      onProgress?: (progress: number) => void;
    },
  ): Promise<string> {
    const result = deferred<string>();
    this.calls.push({
      query,
      signal: opts?.signal,
      onProgress: opts?.onProgress,
      result,
    });
    return result.promise;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSolveHost", () => {
  it("debounces solves", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const host = await createSolveHost(session, { debounceMs: 50 });
    const result = host.solve("query");

    await vi.advanceTimersByTimeAsync(49);
    expect(session.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.calls).toHaveLength(1);
    session.calls[0].result.resolve("done");
    await expect(result).resolves.toBe("done");
    host.dispose();
  });

  it("rejects a superseded request and ignores its late result", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const host = await createSolveHost(session);
    const first = host.solve("first");
    const firstExpectation = expect(first).rejects.toBeInstanceOf(
      SolveSuperseded,
    );
    await vi.runAllTimersAsync();
    const second = host.solve("second");
    await vi.runAllTimersAsync();

    await firstExpectation;
    expect(session.calls[0].signal?.aborted).toBe(true);
    session.calls[0].result.resolve("stale");
    session.calls[1].result.resolve("latest");
    await expect(second).resolves.toBe("latest");
    host.dispose();
  });

  it("returns cached results without calling the session again", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const host = await createSolveHost(session, {
      cacheKey: (query) => query,
    });
    const first = host.solve("same");
    await vi.runAllTimersAsync();
    session.calls[0].result.resolve("cached");
    await first;

    await expect(host.solve("same")).resolves.toBe("cached");
    expect(session.calls).toHaveLength(1);
    host.dispose();
  });

  it("aborts the session signal and rejects the solve", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const host = await createSolveHost(session);
    const controller = new AbortController();
    const result = host.solve("query", { signal: controller.signal });
    await vi.runAllTimersAsync();

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(session.calls[0].signal?.aborted).toBe(true);
    host.dispose();
  });

  it("forwards progress only while the request is current", async () => {
    vi.useFakeTimers();
    const session = new FakeSession();
    const host = await createSolveHost(session);
    const progress = vi.fn();
    const result = host.solve("query", { onProgress: progress });
    await vi.runAllTimersAsync();

    session.calls[0].onProgress?.(1);
    session.calls[0].onProgress?.(2);
    session.calls[0].result.resolve("done");
    await result;
    session.calls[0].onProgress?.(3);

    expect(progress.mock.calls).toEqual([[1], [2]]);
    host.dispose();
  });
});

describe("worker adapter types", () => {
  it("accepts a standard browser Worker", () => {
    expectTypeOf<Worker>().toMatchTypeOf<SolveWorker>();
  });
});
