import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWebGPUAvailable,
  requestDevice,
  SolverRunner,
  webgpuUnavailableReason,
} from "./index";
import type { SolverHandle } from "./index";

interface State {
  steps: number;
}

class FakeSolver implements SolverHandle<State> {
  steps = 0;
  disposeCalls = 0;

  step(): void {
    this.steps += 1;
  }

  read(out = new Float32Array(3)): Float32Array {
    out[0] = this.steps;
    return out;
  }

  state(): State {
    return { steps: this.steps };
  }

  reset(): void {
    this.steps = 0;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SolverRunner", () => {
  it("starts once, frames once per step, stops, and restarts", async () => {
    vi.useFakeTimers();
    const solver = new FakeSolver();
    const runner = new SolverRunner(solver, { targetHz: 100 });
    const frames: number[] = [];
    runner.onFrame((state) => frames.push(state.steps));

    runner.start();
    runner.start();
    await vi.advanceTimersByTimeAsync(35);
    expect(runner.running).toBe(true);
    expect(solver.steps).toBe(4);
    expect(frames).toEqual([1, 2, 3, 4]);

    runner.stop();
    runner.stop();
    const stoppedAt = solver.steps;
    await vi.advanceTimersByTimeAsync(50);
    expect(runner.running).toBe(false);
    expect(solver.steps).toBe(stoppedAt);

    runner.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(solver.steps).toBe(stoppedAt + 2);
    runner.dispose();
  });

  it("unsubscribe removes a frame listener", async () => {
    vi.useFakeTimers();
    const solver = new FakeSolver();
    const runner = new SolverRunner(solver, { targetHz: 100 });
    const listener = vi.fn();
    const unsubscribe = runner.onFrame(listener);
    unsubscribe();
    runner.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(listener).not.toHaveBeenCalled();
    runner.dispose();
  });

  it("dispose is idempotent and permanently stops the loop", async () => {
    vi.useFakeTimers();
    const solver = new FakeSolver();
    const runner = new SolverRunner(solver, { targetHz: 100 });
    const listener = vi.fn();
    runner.onFrame(listener);
    runner.start();
    await vi.advanceTimersByTimeAsync(5);
    runner.dispose();
    runner.dispose();
    const stoppedAt = solver.steps;
    await vi.advanceTimersByTimeAsync(100);
    runner.start();

    expect(runner.running).toBe(false);
    expect(solver.steps).toBe(stoppedAt);
    expect(solver.disposeCalls).toBe(1);
  });
});

describe("WebGPU acquisition in Node", () => {
  it("reports unavailable and returns null without throwing", async () => {
    expect(isWebGPUAvailable()).toBe(false);
    expect(await requestDevice()).toBeNull();
    expect(webgpuUnavailableReason()).toMatch(/WebGPU is not/);
  });
});

