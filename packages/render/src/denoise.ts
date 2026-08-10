import type { Denoiser } from 'denoiser';

export type DenoiseQuality = 'fast' | 'balanced' | 'high';

export interface DenoiseImageOptions {
  albedo?: ImageData;
  normal?: ImageData;
  quality?: DenoiseQuality;
  weightsUrl?: string;
  fireflyClamp?: boolean;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

const MAX_DENOISE_SIDE = 1024;
const DENOISE_TILE_OVERLAP = 64;
const GUIDED_DENOISER_MODEL_FILE = new URL(
  './assets/rt_ldr_calb_cnrm.tza',
  import.meta.url,
).href;
const COLOR_DENOISER_MODEL_FILE = new URL(
  './assets/rt_ldr.tza',
  import.meta.url,
).href;

/** Directory URL containing the locally bundled OIDN-compatible TZA model. */
export const defaultDenoiserWeightsUrl = GUIDED_DENOISER_MODEL_FILE.slice(
  0,
  GUIDED_DENOISER_MODEL_FILE.lastIndexOf('/'),
);

export function clampFireflies(image: ImageData, threshold = 1.6): ImageData {
  const { data, width, height } = image;
  const output = new Uint8ClampedArray(data);
  const luminance = (offset: number): number =>
    0.2126 * data[offset]
    + 0.7152 * data[offset + 1]
    + 0.0722 * data[offset + 2];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = (y * width + x) * 4;
      const value = luminance(offset);
      if (value < 1) continue;
      let brightestNeighbour = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          brightestNeighbour = Math.max(
            brightestNeighbour,
            luminance(((y + dy) * width + x + dx) * 4),
          );
        }
      }
      if (value <= brightestNeighbour * threshold) continue;
      const scale = brightestNeighbour / value;
      output[offset] = data[offset] * scale;
      output[offset + 1] = data[offset + 1] * scale;
      output[offset + 2] = data[offset + 2] * scale;
    }
  }
  return new ImageData(output, width, height);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function cropPaddedTile(
  source: ImageData,
  x: number,
  y: number,
  width: number,
  height: number,
  tileSide: number,
): ImageData {
  const output = new Uint8ClampedArray(tileSide * tileSide * 4);
  const sourceStride = source.width * 4;
  const outputStride = tileSide * 4;
  for (let row = 0; row < tileSide; row += 1) {
    const sourceRow = y + Math.min(row, height - 1);
    const sourceOffset = sourceRow * sourceStride + x * 4;
    const outputOffset = row * outputStride;
    output.set(source.data.subarray(sourceOffset, sourceOffset + width * 4), outputOffset);
    const lastPixel = outputOffset + (width - 1) * 4;
    for (let column = width; column < tileSide; column += 1) {
      const target = outputOffset + column * 4;
      output[target] = output[lastPixel];
      output[target + 1] = output[lastPixel + 1];
      output[target + 2] = output[lastPixel + 2];
      output[target + 3] = output[lastPixel + 3];
    }
  }
  return new ImageData(output, tileSide, tileSide);
}

function copyTile(
  target: ImageData,
  tile: ImageData,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
  targetX: number,
  targetY: number,
): void {
  const sourceStride = tile.width * 4;
  const targetStride = target.width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (sourceY + row) * sourceStride + sourceX * 4;
    target.data.set(
      tile.data.subarray(sourceOffset, sourceOffset + width * 4),
      (targetY + row) * targetStride + targetX * 4,
    );
  }
}

function createDenoiser(
  DenoiserClass: typeof Denoiser,
  width: number,
  height: number,
  options: DenoiseImageOptions,
): Denoiser {
  const denoiser = new DenoiserClass('webgl');
  denoiser.hdr = false;
  denoiser.srgb = true;
  denoiser.quality = options.quality ?? 'balanced';
  denoiser.height = height;
  denoiser.width = width;
  denoiser.weightsUrl = options.weightsUrl ?? defaultDenoiserWeightsUrl;
  denoiser.inputMode = 'imgData';
  denoiser.outputMode = 'imgData';
  if (options.onProgress) denoiser.onProgress(options.onProgress);
  options.signal?.addEventListener('abort', () => denoiser.abort(), { once: true });
  return denoiser;
}

async function executeDenoiser(
  DenoiserClass: typeof Denoiser,
  image: ImageData,
  options: DenoiseImageOptions,
): Promise<ImageData> {
  assertNotAborted(options.signal);
  const denoiser = createDenoiser(
    DenoiserClass,
    image.width,
    image.height,
    options,
  );
  let built = false;
  try {
    // Preload the exact collection that execute() will request. Besides
    // handling Vite-fingerprinted package assets, this avoids a denoiser 0.0.11
    // URL-state edge case where its process-wide weights singleton can retain
    // a previous base URL while a new Denoiser instance is being configured.
    const guided = Boolean(options.albedo && options.normal);
    // The package marks raster albedo + normal inputs as clean auxiliaries,
    // so the matching OIDN collection is calb_cnrm (not alb_nrm).
    const collection = guided ? 'rt_ldr_calb_cnrm' : 'rt_ldr';
    const weightsFile = options.weightsUrl
      ? `${options.weightsUrl.replace(/\/$/, '')}/${collection}.tza`
      : guided
        ? GUIDED_DENOISER_MODEL_FILE
        : COLOR_DENOISER_MODEL_FILE;
    const internal = denoiser as unknown as {
      weights: {
        getCollection: (
          name: string,
          overrideUrl?: string,
        ) => Promise<unknown>;
      };
    };
    await internal.weights.getCollection(collection, weightsFile);
    const result = await denoiser.execute(
      image,
      options.albedo,
      options.normal,
    );
    built = true;
    assertNotAborted(options.signal);
    if (!(result instanceof ImageData)) {
      throw new Error('Denoiser returned an unsupported image format.');
    }
    return result;
  } finally {
    // denoiser@0.0.11 assumes its UNet was built and throws from dispose()
    // when model loading failed, which would otherwise hide the useful error.
    if (built) denoiser.dispose();
  }
}

export async function denoiseImage(
  input: ImageData,
  options: DenoiseImageOptions = {},
): Promise<ImageData> {
  const image = options.fireflyClamp === false ? input : clampFireflies(input);
  const { Denoiser: DenoiserClass } = await import('denoiser');
  assertNotAborted(options.signal);
  if (image.width <= MAX_DENOISE_SIDE && image.height <= MAX_DENOISE_SIDE) {
    return executeDenoiser(DenoiserClass, image, options);
  }

  const stride = MAX_DENOISE_SIDE - DENOISE_TILE_OVERLAP * 2;
  const columns = Math.ceil(image.width / stride);
  const rows = Math.ceil(image.height / stride);
  const tileCount = columns * rows;
  const output = new ImageData(image.width, image.height);
  let completed = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      assertNotAborted(options.signal);
      const targetX = column * stride;
      const targetY = row * stride;
      const innerWidth = Math.min(stride, image.width - targetX);
      const innerHeight = Math.min(stride, image.height - targetY);
      const cropX = Math.max(0, targetX - DENOISE_TILE_OVERLAP);
      const cropY = Math.max(0, targetY - DENOISE_TILE_OVERLAP);
      const cropWidth = Math.min(
        MAX_DENOISE_SIDE,
        image.width - cropX,
      );
      const cropHeight = Math.min(
        MAX_DENOISE_SIDE,
        image.height - cropY,
      );
      const tile = cropPaddedTile(
        image,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        MAX_DENOISE_SIDE,
      );
      const albedoTile = options.albedo
        ? cropPaddedTile(
            options.albedo,
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            MAX_DENOISE_SIDE,
          )
        : undefined;
      const normalTile = options.normal
        ? cropPaddedTile(
            options.normal,
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            MAX_DENOISE_SIDE,
          )
        : undefined;
      const denoised = await executeDenoiser(DenoiserClass, tile, {
        ...options,
        albedo: albedoTile,
        normal: normalTile,
        onProgress: options.onProgress
          ? (progress) => options.onProgress?.(
            Math.min(1, (completed + progress) / tileCount),
          )
          : undefined,
      });
      copyTile(
        output,
        denoised,
        targetX - cropX,
        targetY - cropY,
        innerWidth,
        innerHeight,
        targetX,
        targetY,
      );
      completed += 1;
      options.onProgress?.(completed / tileCount);
    }
  }
  return output;
}
