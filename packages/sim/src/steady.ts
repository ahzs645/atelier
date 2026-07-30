import type { SolverContext } from "./runner";

export interface SteadySolverPlugin<
  TInput,
  TQuery,
  TResult,
  TProgress = never,
> {
  readonly id: string;
  readonly backend: "cpu" | "webgpu" | "worker";
  prepare(
    input: TInput,
    ctx: SolverContext,
  ): Promise<SteadySolverSession<TQuery, TResult, TProgress>>;
}

export interface SteadySolverSession<TQuery, TResult, TProgress = never> {
  solve(
    query: TQuery,
    opts?: {
      signal?: AbortSignal;
      onProgress?: (progress: TProgress) => void;
    },
  ): Promise<TResult>;
  dispose(): void;
}

export interface SolveHostOptions<TQuery> {
  /** Delay before starting the latest solve. Defaults to no debounce. */
  debounceMs?: number;
  /** Enables an LRU result cache when supplied. */
  cacheKey?: (query: TQuery) => string;
  /** Maximum cached results. Defaults to 100. */
  maxCacheEntries?: number;
}

export interface SolvePluginHostOptions<TInput, TQuery>
  extends SolveHostOptions<TQuery> {
  input: TInput;
  context?: SolverContext;
}

export type SolveHost<TQuery, TResult, TProgress = never> =
  SteadySolverSession<TQuery, TResult, TProgress>;

/**
 * Rejection used when a newer host request replaces a pending or running solve.
 *
 * Latest-request-wins is explicit: callers never receive another query's
 * result, and every superseded promise rejects with this error.
 */
export class SolveSuperseded extends Error {
  constructor() {
    super("Solve superseded by a newer request");
    this.name = "SolveSuperseded";
  }
}

export class SolveHostDisposed extends Error {
  constructor() {
    super("Solve host disposed");
    this.name = "SolveHostDisposed";
  }
}

interface PendingSolve<TResult> {
  id: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  resolve: (result: TResult) => void;
  reject: (error: unknown) => void;
  removeAbortListener: () => void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isPlugin<TInput, TQuery, TResult, TProgress>(
  source:
    | SteadySolverPlugin<TInput, TQuery, TResult, TProgress>
    | SteadySolverSession<TQuery, TResult, TProgress>,
): source is SteadySolverPlugin<TInput, TQuery, TResult, TProgress> {
  return "prepare" in source;
}

/**
 * Wraps a prepared session, or prepares a plugin, with debouncing,
 * latest-request-wins rejection, bounded LRU caching, progress filtering, and
 * AbortSignal forwarding. The host owns and disposes the resulting session.
 */
export async function createSolveHost<TQuery, TResult, TProgress = never>(
  session: SteadySolverSession<TQuery, TResult, TProgress>,
  opts?: SolveHostOptions<TQuery>,
): Promise<SolveHost<TQuery, TResult, TProgress>>;
export async function createSolveHost<
  TInput,
  TQuery,
  TResult,
  TProgress = never,
>(
  plugin: SteadySolverPlugin<TInput, TQuery, TResult, TProgress>,
  opts: SolvePluginHostOptions<TInput, TQuery>,
): Promise<SolveHost<TQuery, TResult, TProgress>>;
export async function createSolveHost<
  TInput,
  TQuery,
  TResult,
  TProgress = never,
>(
  source:
    | SteadySolverPlugin<TInput, TQuery, TResult, TProgress>
    | SteadySolverSession<TQuery, TResult, TProgress>,
  opts: SolvePluginHostOptions<TInput, TQuery> | SolveHostOptions<TQuery> = {},
): Promise<SolveHost<TQuery, TResult, TProgress>> {
  const session = isPlugin(source)
    ? await source.prepare(
        (opts as SolvePluginHostOptions<TInput, TQuery>).input,
        (opts as SolvePluginHostOptions<TInput, TQuery>).context ?? {},
      )
    : source;
  const debounceMs = Math.max(0, opts.debounceMs ?? 0);
  const maxCacheEntries = Math.max(0, opts.maxCacheEntries ?? 100);
  const cache = new Map<string, TResult>();
  let nextId = 0;
  let pending: PendingSolve<TResult> | null = null;
  let disposed = false;

  const settle = (
    request: PendingSolve<TResult>,
    outcome: { result: TResult } | { error: unknown },
  ): void => {
    if (request.settled) return;
    request.settled = true;
    if (request.timer !== null) clearTimeout(request.timer);
    request.removeAbortListener();
    if (pending === request) pending = null;
    if ("result" in outcome) request.resolve(outcome.result);
    else request.reject(outcome.error);
  };

  const supersedePending = (): void => {
    const previous = pending;
    if (!previous) return;
    previous.controller.abort(new SolveSuperseded());
    settle(previous, { error: new SolveSuperseded() });
  };

  return {
    solve: (query, solveOpts = {}) => {
      if (disposed) return Promise.reject(new SolveHostDisposed());
      supersedePending();

      return new Promise<TResult>((resolve, reject) => {
        const controller = new AbortController();
        const signal = solveOpts.signal;
        const request: PendingSolve<TResult> = {
          id: ++nextId,
          controller,
          timer: null,
          settled: false,
          resolve,
          reject,
          removeAbortListener: () => undefined,
        };
        pending = request;

        const onAbort = (): void => {
          controller.abort(signal?.reason);
          settle(request, { error: signal?.reason ?? abortError() });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        request.removeAbortListener = () =>
          signal?.removeEventListener("abort", onAbort);

        const key = opts.cacheKey?.(query);
        if (key !== undefined && cache.has(key)) {
          const cached = cache.get(key) as TResult;
          cache.delete(key);
          cache.set(key, cached);
          settle(request, { result: cached });
          return;
        }

        const run = (): void => {
          request.timer = null;
          void Promise.resolve()
            .then(() =>
              session.solve(query, {
                signal: controller.signal,
                onProgress: (progress) => {
                  if (
                    !request.settled
                    && pending?.id === request.id
                    && !controller.signal.aborted
                  ) {
                    solveOpts.onProgress?.(progress);
                  }
                },
              }),
            )
            .then((result) => {
              if (request.settled || pending?.id !== request.id) return;
              if (key !== undefined && maxCacheEntries > 0) {
                cache.delete(key);
                cache.set(key, result);
                while (cache.size > maxCacheEntries) {
                  const oldest = cache.keys().next().value;
                  if (oldest === undefined) break;
                  cache.delete(oldest);
                }
              }
              settle(request, { result });
            })
            .catch((error: unknown) => {
              if (!request.settled) settle(request, { error });
            });
        };
        request.timer = setTimeout(run, debounceMs);
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const active = pending;
      if (active) {
        active.controller.abort(new SolveHostDisposed());
        settle(active, { error: new SolveHostDisposed() });
      }
      cache.clear();
      session.dispose();
    },
  };
}
