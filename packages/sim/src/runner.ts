export interface SolverHandle<TState> {
  /**
   * Advances the solver by the runner's fixed timestep (`1 / targetHz`).
   * The value is advisory: plugins whose update is not time-based may ignore it.
   */
  step(dt: number): Promise<void> | void;
  read(out?: Float32Array): Float32Array;
  state(): TState;
  reset(): void;
  dispose(): void;
}

export interface SolverPlugin<TInput, TState> {
  readonly id: string;
  readonly backend: "cpu" | "webgpu" | "worker";
  build(
    input: TInput,
    ctx: SolverContext,
  ): Promise<SolverHandle<TState>>;
}

export interface SolverContext {
  device?: GPUDevice;
  signal?: AbortSignal;
}

/**
 * Drives a solver with a fixed timestep derived from `targetHz`.
 *
 * Scheduling uses wall-clock delays, but `step()` always receives
 * `1 / targetHz`; plugins may treat that value as advisory.
 */
export class SolverRunner<TState> {
  readonly #handle: SolverHandle<TState>;
  readonly #intervalMs: number;
  readonly #dt: number;
  readonly #listeners = new Set<(state: TState) => void>();
  #active = false;
  #disposed = false;
  #version = 0;
  #loop: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #resolveDelay: (() => void) | null = null;

  constructor(
    handle: SolverHandle<TState>,
    opts: { targetHz?: number } = {},
  ) {
    const targetHz = opts.targetHz ?? 60;
    if (!Number.isFinite(targetHz) || targetHz <= 0) {
      throw new Error("SolverRunner targetHz must be a positive finite number");
    }
    this.#handle = handle;
    this.#intervalMs = 1000 / targetHz;
    this.#dt = 1 / targetHz;
  }

  start(): void {
    if (this.#disposed || this.#active) return;
    this.#active = true;
    this.#version += 1;
    if (!this.#loop) this.#launchLoop();
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#version += 1;
    this.#cancelDelay();
  }

  get running(): boolean {
    return this.#active;
  }

  onFrame(fn: (state: TState) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#listeners.clear();
    this.#handle.dispose();
  }

  #launchLoop(): void {
    this.#loop = this.#runLoop().finally(() => {
      this.#loop = null;
      if (this.#active && !this.#disposed) this.#launchLoop();
    });
  }

  async #runLoop(): Promise<void> {
    while (this.#active && !this.#disposed) {
      const version = this.#version;
      const startedAt = Date.now();
      try {
        await this.#handle.step(this.#dt);
      } catch {
        this.stop();
        return;
      }
      if (
        !this.#active
        || this.#disposed
        || version !== this.#version
      ) continue;
      const state = this.#handle.state();
      for (const listener of [...this.#listeners]) listener(state);
      const remaining = Math.max(
        0,
        this.#intervalMs - (Date.now() - startedAt),
      );
      await this.#delay(remaining);
    }
  }

  #delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.#active || this.#disposed) {
        resolve();
        return;
      }
      this.#resolveDelay = resolve;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#resolveDelay = null;
        resolve();
      }, milliseconds);
    });
  }

  #cancelDelay(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const resolve = this.#resolveDelay;
    this.#resolveDelay = null;
    resolve?.();
  }
}
