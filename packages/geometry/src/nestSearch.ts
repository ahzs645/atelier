import {
  bounds,
  offsetPolygon,
  pointInPolygon,
  polygonArea,
} from "./polygon";
import { rotate } from "./vec2";
import type { Bounds2, Polyline, Vec2 } from "./vec2";

export type NestSearchStrategy = "corners" | "nfp";
export type NestSearchGravity = "bottom" | "left" | "right" | "top";

export interface NestSearchItem {
  id: string;
  shape: Polyline;
  reference?: Polyline;
  instanceId?: string;
}

export interface NestSearchOptions {
  binWidth: number;
  spacing: number;
  rotations: number[];
  generations: number;
  population: number;
  strategy: NestSearchStrategy;
  seed?: number;
  /** Douglas-Peucker tolerance for search polygons. Defaults to 1. */
  curveTolerance?: number;
  /** Maximum length per bin. A non-positive or omitted value is unlimited. */
  maxLength?: number;
  gravity?: NestSearchGravity;
}

export interface NestSearchProgress {
  generation: number;
  generations: number;
  bestLength: number;
  efficiency: number;
}

export interface NestSearchPlacement {
  id: string;
  sourceIndex: number;
  instanceId: string;
  shape: Polyline;
  reference: Polyline;
  bounds: { width: number; height: number };
  rotationDeg: number;
  binIndex: number;
}

export interface NestSearchBin {
  start: number;
  usedLength: number;
}

export interface NestSearchResult {
  binWidth: number;
  usedLength: number;
  spacing: number;
  placements: NestSearchPlacement[];
  efficiency: number;
  /** Present only when a finite maximum length creates multiple bins. */
  bins?: NestSearchBin[];
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2): number =>
    (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

/** True when polygon interiors overlap; exact edge contact is allowed. */
export function searchPolygonsOverlap(a: Polyline, b: Polyline): boolean {
  const boxA = bounds(a);
  const boxB = bounds(b);
  if (
    boxA.maxX < boxB.minX ||
    boxB.maxX < boxA.minX ||
    boxA.maxY < boxB.minY ||
    boxB.maxY < boxA.minY
  ) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (
        segmentsIntersect(
          a[i],
          a[(i + 1) % a.length],
          b[j],
          b[(j + 1) % b.length],
        )
      ) {
        return true;
      }
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Douglas-Peucker simplification for a closed polygon. */
export function simplifyClosedPolygon(
  points: Polyline,
  tolerance: number,
): Polyline {
  if (points.length <= 4 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  let farthest = 1;
  let farthestDistance = -1;
  for (let i = 1; i < points.length; i += 1) {
    const distance = Math.hypot(
      points[i].x - points[0].x,
      points[i].y - points[0].y,
    );
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }
  keep[0] = 1;
  keep[farthest] = 1;
  const distanceToLine = (point: Vec2, a: Vec2, b: Vec2): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) {
      return Math.hypot(point.x - a.x, point.y - a.y);
    }
    return (
      Math.abs(
        dy * point.x - dx * point.y + b.x * a.y - b.y * a.x,
      ) / Math.sqrt(lengthSquared)
    );
  };
  const simplifyRun = (start: number, end: number): void => {
    const stack: Array<[number, number]> = [[start, end]];
    while (stack.length > 0) {
      const pair = stack.pop();
      if (!pair) break;
      const [from, to] = pair;
      const length = (to - from + points.length) % points.length;
      if (length < 2) continue;
      let worst = -1;
      let worstDistance = tolerance;
      for (let offset = 1; offset < length; offset += 1) {
        const index = (from + offset) % points.length;
        const distance = distanceToLine(
          points[index],
          points[from],
          points[to],
        );
        if (distance > worstDistance) {
          worstDistance = distance;
          worst = index;
        }
      }
      if (worst >= 0) {
        keep[worst] = 1;
        stack.push([from, worst], [worst, to]);
      }
    }
  };
  simplifyRun(0, farthest);
  simplifyRun(farthest, 0);
  const simplified = points.filter((_point, index) => keep[index] === 1);
  return simplified.length >= 3 ? simplified : points.slice();
}

function normalizeBy(polyline: Polyline, box: Bounds2): Polyline {
  return polyline.map((point) => ({
    x: point.x - box.minX,
    y: point.y - box.minY,
  }));
}

function translate(polyline: Polyline, offset: Vec2): Polyline {
  return polyline.map((point) => ({
    x: point.x + offset.x,
    y: point.y + offset.y,
  }));
}

const MAX_SEARCH_VERTICES = 48;

function searchPolygonOf(shape: Polyline, tolerance: number): Polyline {
  let simplified = simplifyClosedPolygon(shape, tolerance);
  let nextTolerance = tolerance;
  while (simplified.length > MAX_SEARCH_VERTICES && nextTolerance < 8) {
    nextTolerance *= 1.6;
    simplified = simplifyClosedPolygon(shape, nextTolerance);
  }
  return simplified;
}

interface RotationVariant {
  full: Polyline;
  reference: Polyline;
  search: Polyline;
  inflated: Polyline;
  test: Polyline;
  width: number;
  height: number;
}

interface PreparedItem extends Required<NestSearchItem> {
  sourceIndex: number;
  area: number;
  variants: Map<number, RotationVariant>;
}

const variantCache = new Map<string, Map<number, RotationVariant>>();
const MAX_VARIANT_CACHE_ENTRIES = 200;

function variantKey(
  item: NestSearchItem,
  tolerance: number,
  rotations: number[],
  spacing: number,
): string {
  const round = (value: number): number => Math.round(value * 10);
  return [
    rotations.join(","),
    tolerance,
    spacing,
    item.shape.map((point) => `${round(point.x)},${round(point.y)}`).join(";"),
    (item.reference ?? item.shape)
      .map((point) => `${round(point.x)},${round(point.y)}`)
      .join(";"),
  ].join("|");
}

function prepareItems(
  items: NestSearchItem[],
  tolerance: number,
  rotations: number[],
  spacing: number,
): PreparedItem[] {
  return items.map((item, sourceIndex) => {
    const key = variantKey(item, tolerance, rotations, spacing);
    let variants = variantCache.get(key);
    if (!variants) {
      const searchShape = searchPolygonOf(item.shape, tolerance);
      variants = new Map<number, RotationVariant>();
      for (const rotationDeg of rotations) {
        const rotatedFull = item.shape.map((point) => rotate(point, rotationDeg));
        const box = bounds(rotatedFull);
        const search = normalizeBy(
          searchShape.map((point) => rotate(point, rotationDeg)),
          box,
        );
        const reference = item.reference ?? item.shape;
        variants.set(rotationDeg, {
          full: normalizeBy(rotatedFull, box),
          reference: normalizeBy(
            reference.map((point) => rotate(point, rotationDeg)),
            box,
          ),
          search,
          inflated:
            spacing > 0 ? offsetPolygon(search, spacing) : search.map((p) => ({ ...p })),
          test:
            spacing > 0
              ? offsetPolygon(search, spacing * 0.98)
              : search.map((p) => ({ ...p })),
          width: box.maxX - box.minX,
          height: box.maxY - box.minY,
        });
      }
      if (variantCache.size >= MAX_VARIANT_CACHE_ENTRIES) {
        const oldest = variantCache.keys().next().value;
        if (oldest !== undefined) variantCache.delete(oldest);
      }
      variantCache.set(key, variants);
    }
    return {
      ...item,
      reference: item.reference ?? item.shape,
      instanceId: item.instanceId ?? `${item.id}:${sourceIndex}`,
      sourceIndex,
      area: Math.abs(polygonArea(item.shape)),
      variants,
    };
  });
}

interface PlacedSearchShape {
  search: Polyline;
  inflated: Polyline;
  test: Polyline;
  bounds: Bounds2;
}

interface SearchBin {
  placed: PlacedSearchShape[];
  usedLength: number;
}

function placeOrdered(
  order: PreparedItem[],
  rotationIndices: number[],
  rotations: number[],
  options: NestSearchOptions,
): { placements: NestSearchPlacement[]; binLengths: number[] } {
  const maxLength =
    options.maxLength !== undefined && options.maxLength > 0
      ? options.maxLength
      : Infinity;
  const spacing = Math.max(0, options.spacing);
  const bins: SearchBin[] = [{ placed: [], usedLength: spacing }];
  const placements: NestSearchPlacement[] = [];
  const gravity = options.gravity ?? "bottom";
  const compareCandidates = (a: Vec2, b: Vec2): number => {
    if (gravity === "left") return a.x - b.x || a.y - b.y;
    if (gravity === "right") return b.x - a.x || a.y - b.y;
    if (gravity === "top") return a.y - b.y || b.x - a.x;
    return a.y - b.y || a.x - b.x;
  };

  for (let itemIndex = 0; itemIndex < order.length; itemIndex += 1) {
    const item = order[itemIndex];
    const rotationDeg =
      rotations[rotationIndices[itemIndex] % rotations.length];
    const variant = item.variants.get(rotationDeg);
    if (!variant) throw new Error(`Missing ${rotationDeg} degree variant`);
    const maxX = options.binWidth - variant.width - spacing;
    const yCap = maxLength - variant.height - spacing;

    const findSpot = (bin: SearchBin): Vec2 | null => {
      if (options.strategy === "nfp") {
        const candidates: Vec2[] = [{ x: spacing, y: spacing }];
        if (gravity === "right" && maxX > spacing) {
          candidates.push({ x: maxX, y: spacing });
        }
        for (const placed of bin.placed) {
          for (const contact of placed.inflated) {
            for (const point of variant.search) {
              const candidate = {
                x: contact.x - point.x,
                y: contact.y - point.y,
              };
              if (
                candidate.x >= spacing - 1e-9 &&
                candidate.x <= maxX + 1e-9 &&
                candidate.y >= spacing - 1e-9 &&
                candidate.y <= yCap + 1e-9
              ) {
                candidates.push(candidate);
              }
            }
          }
          candidates.push(
            { x: placed.bounds.maxX + spacing, y: spacing },
            { x: spacing, y: placed.bounds.maxY + spacing },
          );
        }
        candidates.sort(compareCandidates);
        let previousX = Number.NaN;
        let previousY = Number.NaN;
        for (const candidate of candidates) {
          if (
            candidate.x < spacing - 1e-9 ||
            candidate.x > maxX + 1e-9 ||
            candidate.y < spacing - 1e-9 ||
            candidate.y > yCap + 1e-9
          ) {
            continue;
          }
          if (candidate.x === previousX && candidate.y === previousY) continue;
          previousX = candidate.x;
          previousY = candidate.y;
          const translated = translate(variant.search, candidate);
          const candidateBounds = bounds(translated);
          const overlaps = bin.placed.some(
            (placed) =>
              !(
                candidateBounds.maxX < placed.bounds.minX ||
                placed.bounds.maxX < candidateBounds.minX ||
                candidateBounds.maxY < placed.bounds.minY ||
                placed.bounds.maxY < candidateBounds.minY
              ) && searchPolygonsOverlap(translated, placed.test),
          );
          if (!overlaps) return candidate;
        }
        return null;
      }

      const xCandidates = new Set<number>([spacing]);
      const yCandidates = new Set<number>([spacing]);
      for (const placed of bin.placed) {
        xCandidates.add(placed.bounds.maxX + spacing);
        yCandidates.add(placed.bounds.maxY + spacing);
      }
      const sortedY = [...yCandidates]
        .sort((a, b) => a - b)
        .filter((y) => y <= yCap + 1e-9);
      const sortedX = [...xCandidates].sort((a, b) => a - b);
      let best: Vec2 | null = null;
      for (const y of sortedY) {
        for (const x of sortedX) {
          if (x + variant.width + spacing > options.binWidth) continue;
          const translated = translate(variant.search, { x, y });
          const candidateBounds = bounds(translated);
          const overlaps = bin.placed.some(
            (placed) =>
              !(
                candidateBounds.maxX < placed.bounds.minX - spacing ||
                placed.bounds.maxX < candidateBounds.minX - spacing ||
                candidateBounds.maxY < placed.bounds.minY - spacing ||
                placed.bounds.maxY < candidateBounds.minY - spacing
              ) && searchPolygonsOverlap(translated, placed.search),
          );
          if (
            !overlaps &&
            (!best || y < best.y || (y === best.y && x < best.x))
          ) {
            best = { x, y };
            break;
          }
        }
        if (best && best.y <= sortedY[0]) break;
      }
      if (!best && maxLength === Infinity) {
        best = { x: spacing, y: bin.usedLength };
      }
      return best;
    };

    let binIndex = -1;
    let position: Vec2 | null = null;
    for (let index = 0; index < bins.length && !position; index += 1) {
      position = findSpot(bins[index]);
      if (position) binIndex = index;
    }
    if (!position) {
      bins.push({ placed: [], usedLength: spacing });
      binIndex = bins.length - 1;
      position = { x: spacing, y: spacing };
    }

    const bin = bins[binIndex];
    const search = translate(variant.search, position);
    bin.placed.push({
      search,
      inflated: translate(variant.inflated, position),
      test: translate(variant.test, position),
      bounds: bounds(search),
    });
    placements.push({
      id: item.id,
      sourceIndex: item.sourceIndex,
      instanceId: item.instanceId,
      shape: translate(variant.full, position),
      reference: translate(variant.reference, position),
      bounds: { width: variant.width, height: variant.height },
      rotationDeg,
      binIndex,
    });
    bin.usedLength = Math.max(
      bin.usedLength,
      position.y + variant.height + spacing,
    );
  }
  return {
    placements,
    binLengths: bins.map((bin) => bin.usedLength),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface Chromosome {
  order: number[];
  rotations: number[];
}

/**
 * Searches piece order and rotation with order crossover and rotation mutation.
 * A fixed seed makes both the search and returned layout deterministic.
 */
export function nestSearch(
  rawItems: NestSearchItem[],
  options: NestSearchOptions,
  onProgress?: (progress: NestSearchProgress) => void,
): NestSearchResult {
  const rotations = options.rotations.length > 0 ? options.rotations : [0];
  const generations = Math.max(0, options.generations);
  const populationSize = Math.max(4, options.population);
  const random = seededRandom(
    options.seed ?? Math.floor(Math.random() * 0xffffffff),
  );
  const items = prepareItems(
    rawItems,
    options.curveTolerance ?? 1,
    rotations,
    Math.max(0, options.spacing),
  );
  if (items.length === 0) {
    return {
      binWidth: options.binWidth,
      usedLength: Math.max(0, options.spacing),
      spacing: Math.max(0, options.spacing),
      placements: [],
      efficiency: 0,
    };
  }

  const totalArea = items.reduce((sum, item) => sum + item.area, 0);
  const efficiencyOf = (length: number): number =>
    Math.min(
      1,
      totalArea /
        Math.max(
          1,
          options.binWidth * (length - Math.max(0, options.spacing)),
        ),
    );
  const evaluate = (chromosome: Chromosome) =>
    placeOrdered(
      chromosome.order.map((index) => items[index]),
      chromosome.rotations,
      rotations,
      options,
    );
  const fitnessOf = (result: ReturnType<typeof placeOrdered>): number =>
    (result.binLengths.length - 1) * 1e6 +
    result.binLengths.reduce((sum, length) => sum + length, 0);
  const randomIndex = (length: number): number =>
    Math.floor(random() * length);

  const seedOrder = [...items].sort((a, b) => b.area - a.area);
  const population: Chromosome[] = [
    {
      order: seedOrder.map((item) => item.sourceIndex),
      rotations: seedOrder.map(() => 0),
    },
  ];
  while (population.length < populationSize) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = randomIndex(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    population.push({
      order: shuffled.map((item) => item.sourceIndex),
      rotations: shuffled.map(() => randomIndex(rotations.length)),
    });
  }

  const score = (chromosome: Chromosome): number =>
    fitnessOf(evaluate(chromosome));
  let currentPopulation = population;
  let best = currentPopulation[0];
  let bestScore = score(best);
  for (const chromosome of currentPopulation.slice(1)) {
    const chromosomeScore = score(chromosome);
    if (chromosomeScore < bestScore) {
      best = chromosome;
      bestScore = chromosomeScore;
    }
  }
  const lengthOf = (fitness: number): number => fitness % 1e6;
  onProgress?.({
    generation: 0,
    generations,
    bestLength: lengthOf(bestScore),
    efficiency: efficiencyOf(lengthOf(bestScore)),
  });

  for (let generation = 0; generation < generations; generation += 1) {
    const scored = currentPopulation
      .map((chromosome) => ({
        chromosome,
        score: score(chromosome),
      }))
      .sort((a, b) => a.score - b.score);
    if (scored[0].score < bestScore) {
      best = scored[0].chromosome;
      bestScore = scored[0].score;
    }
    const elite = scored
      .slice(0, Math.max(2, Math.floor(populationSize / 4)))
      .map((entry) => entry.chromosome);
    const next: Chromosome[] = [...elite];
    while (next.length < populationSize) {
      const first = elite[randomIndex(elite.length)];
      const second = elite[randomIndex(elite.length)];
      const length = first.order.length;
      const start = randomIndex(length);
      const end = start + randomIndex(length - start);
      const childOrder = new Array<number>(length).fill(-1);
      const taken = new Set<number>();
      for (let index = start; index <= end; index += 1) {
        childOrder[index] = first.order[index];
        taken.add(first.order[index]);
      }
      let fill = 0;
      for (let index = 0; index < length; index += 1) {
        if (childOrder[index] !== -1) continue;
        while (taken.has(second.order[fill])) fill += 1;
        childOrder[index] = second.order[fill];
        fill += 1;
      }
      const childRotations = childOrder.map((_item, index) =>
        random() < 0.5
          ? first.rotations[index % first.rotations.length]
          : second.rotations[index % second.rotations.length],
      );
      if (random() < 0.3) {
        const firstIndex = randomIndex(length);
        const secondIndex = randomIndex(length);
        [childOrder[firstIndex], childOrder[secondIndex]] = [
          childOrder[secondIndex],
          childOrder[firstIndex],
        ];
      }
      if (random() < 0.3 && rotations.length > 1) {
        childRotations[randomIndex(length)] = randomIndex(rotations.length);
      }
      next.push({ order: childOrder, rotations: childRotations });
    }
    currentPopulation = next;
    onProgress?.({
      generation: generation + 1,
      generations,
      bestLength: lengthOf(bestScore),
      efficiency: efficiencyOf(lengthOf(bestScore)),
    });
  }

  const final = evaluate(best);
  const BIN_GAP = 30;
  const multipleBins = final.binLengths.length > 1;
  const bins: NestSearchBin[] = [];
  let start = 0;
  for (const usedLength of final.binLengths) {
    bins.push({ start, usedLength });
    start += usedLength + BIN_GAP;
  }
  const placements = multipleBins
    ? final.placements.map((placement) => {
        const offset = bins[placement.binIndex].start;
        if (offset === 0) return placement;
        return {
          ...placement,
          shape: translate(placement.shape, { x: 0, y: offset }),
          reference: translate(placement.reference, { x: 0, y: offset }),
        };
      })
    : final.placements;
  const totalLength = final.binLengths.reduce(
    (sum, length) => sum + length,
    0,
  );
  return {
    binWidth: options.binWidth,
    usedLength: multipleBins ? start - BIN_GAP : final.binLengths[0],
    spacing: Math.max(0, options.spacing),
    placements,
    efficiency: efficiencyOf(totalLength),
    ...(multipleBins ? { bins } : {}),
  };
}
