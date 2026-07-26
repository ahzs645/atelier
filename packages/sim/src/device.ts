/// <reference types="@webgpu/types" />

let cachedDevice: GPUDevice | null = null;
let pendingDevice: Promise<GPUDevice | null> | null = null;
let unavailableReason: string | null = null;

function environmentReason(): string | null {
  if (typeof navigator === "undefined") {
    return "WebGPU is not available outside a browser environment.";
  }
  if (!("gpu" in navigator) || !navigator.gpu) {
    return "WebGPU is not supported by this browser.";
  }
  return null;
}

export function isWebGPUAvailable(): boolean {
  return environmentReason() === null;
}

function missingFeature(
  supported: GPUSupportedFeatures,
  required: readonly string[],
): string | null {
  for (const name of required) {
    if (!supported.has(name as GPUFeatureName)) return name;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function acquireDevice(
  required: readonly string[],
): Promise<GPUDevice | null> {
  const reason = environmentReason();
  if (reason) {
    unavailableReason = reason;
    return null;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) {
      unavailableReason = "No suitable WebGPU adapter was found.";
      return null;
    }
    const missing = missingFeature(adapter.features, required);
    if (missing) {
      unavailableReason =
        `Required WebGPU feature "${missing}" is unavailable.`;
      return null;
    }
    const device = await adapter.requestDevice({
      requiredFeatures: required as readonly GPUFeatureName[],
    });
    cachedDevice = device;
    unavailableReason = null;
    return device;
  } catch (error: unknown) {
    unavailableReason = `WebGPU device request failed: ${errorMessage(error)}`;
    return null;
  }
}

/**
 * Acquire and cache a WebGPU device. Missing support, adapters, or requested
 * features are recoverable and return null; call webgpuUnavailableReason().
 */
export async function requestDevice(
  opts: { required?: string[] } = {},
): Promise<GPUDevice | null> {
  const required = [...new Set(opts.required ?? [])].sort();
  if (cachedDevice) {
    const missing = missingFeature(cachedDevice.features, required);
    if (!missing) {
      unavailableReason = null;
      return cachedDevice;
    }
    unavailableReason =
      `Cached WebGPU device does not provide required feature "${missing}".`;
    return null;
  }
  if (!pendingDevice) {
    pendingDevice = acquireDevice(required).finally(() => {
      pendingDevice = null;
    });
  }
  const device = await pendingDevice;
  if (!device) return null;
  const missing = missingFeature(device.features, required);
  if (missing) {
    unavailableReason =
      `Cached WebGPU device does not provide required feature "${missing}".`;
    return null;
  }
  return device;
}

export function webgpuUnavailableReason(): string | null {
  return environmentReason() ?? unavailableReason;
}

