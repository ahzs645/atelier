import type { SolverContext } from "./runner";
import type {
  SteadySolverPlugin,
  SteadySolverSession,
} from "./steady";

export type SolveWorkerClientMessage<TInput, TQuery> =
  | { type: "prepare"; input: TInput }
  | { type: "solve"; requestId: number; query: TQuery }
  | { type: "cancel"; requestId: number }
  | { type: "dispose" };

export type SolveWorkerServerMessage<TResult, TProgress> =
  | { type: "ready" }
  | { type: "progress"; requestId: number; progress: TProgress }
  | { type: "result"; requestId: number; result: TResult }
  | { type: "error"; requestId?: number; message: string };

export interface SolveWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface SolveWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface WorkerSteadySolverPluginOptions<TQuery> {
  id: string;
  createWorker: () => SolveWorker;
  /**
   * `message` sends a cooperative cancel and always discards late responses.
   * `terminate` stops the worker immediately and prepares a fresh worker for
   * the next solve.
   */
  cancelMode?: "message" | "terminate";
  transferQuery?: (query: TQuery) => Transferable[];
  mapError?: (message: string) => Error;
}

interface WorkerPending<TResult, TProgress> {
  resolve: (result: TResult) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: TProgress) => void;
  removeAbortListener: () => void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Creates a worker-backed steady plugin using the engine's request-correlated
 * prepare/solve/progress/result/error protocol.
 */
export function createWorkerSteadySolverPlugin<
  TInput,
  TQuery,
  TResult,
  TProgress = never,
>(
  options: WorkerSteadySolverPluginOptions<TQuery>,
): SteadySolverPlugin<TInput, TQuery, TResult, TProgress> {
  return {
    id: options.id,
    backend: "worker",
    prepare: async (input, context) => {
      let worker: SolveWorker | null = null;
      let ready: Promise<void> = Promise.resolve();
      let nextRequestId = 0;
      let disposed = false;
      const pending = new Map<number, WorkerPending<TResult, TProgress>>();
      const mapError = options.mapError ?? ((message: string) => new Error(message));

      const rejectPending = (error: unknown): void => {
        for (const request of pending.values()) {
          request.removeAbortListener();
          request.reject(error);
        }
        pending.clear();
      };

      const spawn = (): Promise<void> => {
        const nextWorker = options.createWorker();
        worker = nextWorker;
        return new Promise<void>((resolve, reject) => {
          let prepared = false;
          nextWorker.onmessage = (event) => {
            const message = event.data as SolveWorkerServerMessage<
              TResult,
              TProgress
            >;
            if (message.type === "ready") {
              prepared = true;
              resolve();
              return;
            }
            if (message.type === "error" && message.requestId === undefined) {
              const error = mapError(message.message);
              if (!prepared) reject(error);
              rejectPending(error);
              return;
            }
            if (!("requestId" in message)) return;
            const requestId = message.requestId;
            if (requestId === undefined) return;
            const request = pending.get(requestId);
            if (!request) return;
            if (message.type === "progress") {
              request.onProgress?.(message.progress);
            } else if (message.type === "result") {
              pending.delete(requestId);
              request.removeAbortListener();
              request.resolve(message.result);
            } else if (message.type === "error") {
              pending.delete(requestId);
              request.removeAbortListener();
              request.reject(mapError(message.message));
            }
          };
          nextWorker.onerror = (event) => {
            const error = mapError(event.message || "Steady solver worker failed");
            if (!prepared) reject(error);
            rejectPending(error);
          };
          nextWorker.postMessage(
            { type: "prepare", input } satisfies SolveWorkerClientMessage<
              TInput,
              TQuery
            >,
          );
        });
      };

      if (context.signal?.aborted) {
        throw context.signal.reason ?? abortError();
      }
      ready = spawn();
      if (context.signal) {
        const signal = context.signal;
        let rejectAbort = (error: unknown): void => {
          void error;
        };
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        });
        const onAbort = (): void => {
          (worker as SolveWorker | null)?.terminate();
          rejectAbort(signal.reason ?? abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await Promise.race([ready, aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } else {
        await ready;
      }

      const session: SteadySolverSession<TQuery, TResult, TProgress> = {
        solve: async (query, solveOptions = {}) => {
          if (disposed) throw new Error("Steady solver worker disposed");
          await ready;
          if (solveOptions.signal?.aborted) {
            throw solveOptions.signal.reason ?? abortError();
          }
          const requestId = ++nextRequestId;
          return new Promise<TResult>((resolve, reject) => {
            const onAbort = (): void => {
              const request = pending.get(requestId);
              if (!request) return;
              pending.delete(requestId);
              request.removeAbortListener();
              reject(solveOptions.signal?.reason ?? abortError());
              if (options.cancelMode === "terminate") {
                worker?.terminate();
                rejectPending(abortError());
                ready = spawn();
                void ready.catch(() => {
                  // The next solve observes a failed worker restart.
                });
              } else {
                worker?.postMessage({
                  type: "cancel",
                  requestId,
                } satisfies SolveWorkerClientMessage<TInput, TQuery>);
              }
            };
            solveOptions.signal?.addEventListener("abort", onAbort, {
              once: true,
            });
            pending.set(requestId, {
              resolve,
              reject,
              onProgress: solveOptions.onProgress,
              removeAbortListener: () =>
                solveOptions.signal?.removeEventListener("abort", onAbort),
            });
            worker?.postMessage(
              {
                type: "solve",
                requestId,
                query,
              } satisfies SolveWorkerClientMessage<TInput, TQuery>,
              options.transferQuery?.(query),
            );
          });
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          rejectPending(new Error("Steady solver worker disposed"));
          worker?.postMessage({
            type: "dispose",
          } satisfies SolveWorkerClientMessage<TInput, TQuery>);
          worker?.terminate();
          worker = null;
        },
      };
      return session;
    },
  };
}

export interface ServeSteadySolverOptions<TResult> {
  context?: SolverContext;
  transferResult?: (result: TResult) => Transferable[];
}

/**
 * Installs the worker side of the steady solve protocol.
 *
 * Cancel messages abort the session signal cooperatively. A client using
 * terminate cancellation needs no special server behavior.
 */
export function serveSteadySolverPlugin<
  TInput,
  TQuery,
  TResult,
  TProgress = never,
>(
  scope: SolveWorkerScope,
  plugin: SteadySolverPlugin<TInput, TQuery, TResult, TProgress>,
  options: ServeSteadySolverOptions<TResult> = {},
): () => void {
  let session: SteadySolverSession<TQuery, TResult, TProgress> | null = null;
  const controllers = new Map<number, AbortController>();
  let disposed = false;

  const postError = (message: string, requestId?: number): void => {
    scope.postMessage({
      type: "error",
      ...(requestId === undefined ? {} : { requestId }),
      message,
    } satisfies SolveWorkerServerMessage<TResult, TProgress>);
  };

  scope.onmessage = (event) => {
    const message = event.data as SolveWorkerClientMessage<TInput, TQuery>;
    if (message.type === "prepare") {
      void Promise.resolve()
        .then(() => plugin.prepare(message.input, options.context ?? {}))
        .then((prepared) => {
          if (disposed) {
            prepared.dispose();
            return;
          }
          session?.dispose();
          session = prepared;
          scope.postMessage({
            type: "ready",
          } satisfies SolveWorkerServerMessage<TResult, TProgress>);
        })
        .catch((error: unknown) =>
          postError(error instanceof Error ? error.message : String(error)),
        );
      return;
    }
    if (message.type === "cancel") {
      controllers.get(message.requestId)?.abort();
      controllers.delete(message.requestId);
      return;
    }
    if (message.type === "dispose") {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      session?.dispose();
      session = null;
      return;
    }
    const activeSession = session;
    if (!activeSession) {
      postError("Steady solver worker is not prepared", message.requestId);
      return;
    }
    const controller = new AbortController();
    controllers.set(message.requestId, controller);
    void Promise.resolve()
      .then(() =>
        activeSession.solve(message.query, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controllers.has(message.requestId)) return;
            scope.postMessage({
              type: "progress",
              requestId: message.requestId,
              progress,
            } satisfies SolveWorkerServerMessage<TResult, TProgress>);
          },
        }),
      )
      .then((result) => {
        if (!controllers.delete(message.requestId)) return;
        scope.postMessage(
          {
            type: "result",
            requestId: message.requestId,
            result,
          } satisfies SolveWorkerServerMessage<TResult, TProgress>,
          options.transferResult?.(result),
        );
      })
      .catch((error: unknown) => {
        if (!controllers.delete(message.requestId)) return;
        postError(
          error instanceof Error ? error.message : String(error),
          message.requestId,
        );
      });
  };

  return () => {
    disposed = true;
    scope.onmessage = null;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    session?.dispose();
    session = null;
  };
}
