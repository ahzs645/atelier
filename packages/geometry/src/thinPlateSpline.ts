import type { Transform2, Vec2 } from "./vec2";

export interface MatchPair {
  src: Vec2;
  dst: Vec2;
}

const SINGULAR = 1e-10;

function invert(matrix: number[][]): number[][] | null {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => {
    const result = row.slice();
    for (let column = 0; column < size; column += 1) {
      result.push(rowIndex === column ? 1 : 0);
    }
    return result;
  });
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotValue = Math.abs(augmented[column][column]);
    for (let row = column + 1; row < size; row += 1) {
      const value = Math.abs(augmented[row][column]);
      if (value > pivotValue) {
        pivotValue = value;
        pivotRow = row;
      }
    }
    if (pivotValue < SINGULAR) return null;
    if (pivotRow !== column) {
      const swap = augmented[pivotRow];
      augmented[pivotRow] = augmented[column];
      augmented[column] = swap;
    }
    const pivot = augmented[column][column];
    for (let index = 0; index < size * 2; index += 1) {
      augmented[column][index] /= pivot;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let index = 0; index < size * 2; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row.slice(size));
}

function multiply(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) =>
    row.reduce((sum, value, index) => sum + value * vector[index], 0),
  );
}

// r² log r, expressed through r² so the zero-radius branch remains finite.
function radialKernel(radiusSquared: number): number {
  return radiusSquared <= 1e-12 ? 0 : 0.5 * radiusSquared * Math.log(radiusSquared);
}

/**
 * Thin-plate-spline world→world warp ported from seamer. One pair is a
 * translation, two are a similarity transform, and three or more use full TPS.
 */
export function buildWarp(pairs: MatchPair[]): Transform2 {
  if (pairs.length === 0) return (point) => ({ ...point });
  if (pairs.length === 1) {
    const dx = pairs[0].dst.x - pairs[0].src.x;
    const dy = pairs[0].dst.y - pairs[0].src.y;
    return (point) => ({ x: point.x + dx, y: point.y + dy });
  }
  if (pairs.length === 2) {
    const [a, b] = pairs;
    const source = { x: b.src.x - a.src.x, y: b.src.y - a.src.y };
    const target = { x: b.dst.x - a.dst.x, y: b.dst.y - a.dst.y };
    const sourceLengthSquared = source.x * source.x + source.y * source.y;
    if (sourceLengthSquared < 1e-12) return buildWarp([a]);
    const real =
      (target.x * source.x + target.y * source.y) / sourceLengthSquared;
    const imaginary =
      (target.y * source.x - target.x * source.y) / sourceLengthSquared;
    return (point) => {
      const x = point.x - a.src.x;
      const y = point.y - a.src.y;
      return {
        x: a.dst.x + x * real - y * imaginary,
        y: a.dst.y + x * imaginary + y * real,
      };
    };
  }

  const count = pairs.length;
  const size = count + 3;
  const matrix: number[][] = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  );
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      const dx = pairs[i].src.x - pairs[j].src.x;
      const dy = pairs[i].src.y - pairs[j].src.y;
      matrix[i][j] = radialKernel(dx * dx + dy * dy);
    }
    // Light regularisation tolerates near-duplicate calibration points.
    matrix[i][i] += 1e-6;
    matrix[i][count] = 1;
    matrix[count][i] = 1;
    matrix[i][count + 1] = pairs[i].src.x;
    matrix[count + 1][i] = pairs[i].src.x;
    matrix[i][count + 2] = pairs[i].src.y;
    matrix[count + 2][i] = pairs[i].src.y;
  }
  const inverse = invert(matrix);
  if (!inverse) return buildWarp(pairs.slice(0, 2));
  const weightsX = multiply(inverse, [
    ...pairs.map((pair) => pair.dst.x),
    0,
    0,
    0,
  ]);
  const weightsY = multiply(inverse, [
    ...pairs.map((pair) => pair.dst.y),
    0,
    0,
    0,
  ]);
  return (point) => {
    let x =
      weightsX[count] +
      weightsX[count + 1] * point.x +
      weightsX[count + 2] * point.y;
    let y =
      weightsY[count] +
      weightsY[count + 1] * point.x +
      weightsY[count + 2] * point.y;
    for (let i = 0; i < count; i += 1) {
      const dx = point.x - pairs[i].src.x;
      const dy = point.y - pairs[i].src.y;
      const radial = radialKernel(dx * dx + dy * dy);
      x += weightsX[i] * radial;
      y += weightsY[i] * radial;
    }
    return { x, y };
  };
}
