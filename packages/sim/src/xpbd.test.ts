import { describe, expect, it } from "vitest";
import {
  createAnchorConstraint,
  createClothState,
  createDistanceConstraint,
  settleXpbdCloth,
  stepXpbdCloth,
  type XpbdAnchorConstraint,
  type XpbdClothState,
  type XpbdClothStepOptions,
} from "./xpbdCloth";
import {
  buildClothConstraints,
  creaseChainPose,
  creasePose,
  type CreaseFold,
} from "./xpbdMesh";
import { createTriangleCollider, type TriangleCollisionParams } from "./xpbdCollision";

/** Regular grid strip: rest xy in [0,length]×[0,width], embedded as (x,0,y). */
function grid(length: number, width: number, spacing: number) {
  const cols = Math.round(length / spacing) + 1;
  const rows = Math.round(width / spacing) + 1;
  const rest: number[] = [];
  const embedded: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      rest.push(col * spacing, row * spacing);
      embedded.push(col * spacing, 0, row * spacing);
    }
  }
  const triangles: number[] = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      triangles.push(a, b, d, a, d, c);
    }
  }
  return { cols, rows, rest, embedded, triangles };
}

const QUASI_STATIC: XpbdClothStepOptions = {
  dt: 1 / 60,
  substeps: 10,
  iterations: 8,
  damping: 0.6,
  bendAngleGain: 0.3,
  bendMaxStepRad: 0.15,
};

function edgeStretch(
  state: XpbdClothState,
  rest: number[],
  edges: Array<[number, number]>,
): number {
  let worst = 0;
  for (const [a, b] of edges) {
    const restLength = Math.hypot(rest[a * 2] - rest[b * 2], rest[a * 2 + 1] - rest[b * 2 + 1]);
    const length = Math.hypot(
      state.positions[a * 3] - state.positions[b * 3],
      state.positions[a * 3 + 1] - state.positions[b * 3 + 1],
      state.positions[a * 3 + 2] - state.positions[b * 3 + 2],
    );
    worst = Math.max(worst, Math.abs(length - restLength) / restLength);
  }
  return worst;
}

/**
 * The fold recipe an app drives: soft anchors swept along the crease pose
 * from flat to folded, contact answered every iteration. The strip's root
 * (x ≤ 10) is pinned; extra pinned geometry (an obstacle) may ride along.
 */
function foldStrip(params: {
  strip: ReturnType<typeof grid>;
  radius: number;
  extraPositions?: number[];
  extraTriangles?: number[];
  extraRest?: number[];
  collide: boolean;
  thickness?: number;
}) {
  const { strip, radius } = params;
  const clothCount = strip.embedded.length / 3;
  const invMasses = strip.embedded
    .filter((_, index) => index % 3 === 0)
    .map((x) => (x <= 10 ? 0 : 1));
  const extraCount = (params.extraPositions?.length ?? 0) / 3;
  const state = createClothState(
    [...strip.embedded, ...(params.extraPositions ?? [])],
    [...invMasses, ...Array.from({ length: extraCount }, () => 0)],
  );
  const { constraints, edges } = buildClothConstraints(
    { restPositions: strip.rest, triangles: strip.triangles },
    { stretchCompliance: 0, bendCompliance: 1e-4 },
  );

  // Soft hold: weak enough that a contact correction beats it locally.
  const subDt = QUASI_STATIC.dt / QUASI_STATIC.substeps;
  const anchorCompliance = 99 * subDt * subDt;
  const anchors: XpbdAnchorConstraint[] = [];
  for (let index = 0; index < clothCount; index += 1) {
    if (invMasses[index] <= 0) continue;
    const anchor = createAnchorConstraint({
      index,
      target: [
        strip.embedded[index * 3],
        strip.embedded[index * 3 + 1],
        strip.embedded[index * 3 + 2],
      ],
      compliance: anchorCompliance,
    });
    anchors.push(anchor);
    constraints.push(anchor);
  }

  const colliderParams: TriangleCollisionParams = {
    triangles: [...strip.triangles, ...(params.extraTriangles ?? [])],
    restPositions: [...strip.rest, ...(params.extraRest ?? [])],
    config: { thickness: params.thickness ?? 2, friction: 0.1 },
  };
  const collider = params.collide ? createTriangleCollider(colliderParams) : undefined;

  // The crease is directed so the strip's free half (x > 25) is on its left.
  const creaseAt = (t: number): CreaseFold => ({
    start: { x: 25, y: 20 },
    end: { x: 25, y: 0 },
    angleRad: Math.PI * t,
    zoneWidth: Math.max(radius * Math.PI * t, 1e-6),
  });
  const RAMP_STEPS = 150;
  const result = settleXpbdCloth(
    state,
    constraints,
    { ...QUASI_STATIC, collider, colliderEveryIteration: true },
    {
      maxSteps: 400,
      restDisplacement: 1e-2,
      onStep: (step) => {
        const t = Math.min(1, (step + 1) / RAMP_STEPS);
        const pose = creasePose(creaseAt(t));
        for (const anchor of anchors) {
          const [x, y, z] = pose(strip.rest[anchor.index * 2], strip.rest[anchor.index * 2 + 1]);
          anchor.targetX = x;
          anchor.targetY = y;
          anchor.targetZ = z;
        }
        return step >= RAMP_STEPS;
      },
    },
  );
  return { state, result, edges, clothCount };
}

describe("xpbd cloth core", () => {
  it("restores a distance constraint's rest length", () => {
    const state = createClothState([0, 0, 0, 10, 0, 0], [0, 1]);
    const constraint = createDistanceConstraint({ a: 0, b: 1, restLength: 4 });
    settleXpbdCloth(state, [constraint], { dt: 1 / 60, substeps: 4, iterations: 8, damping: 0.5 });
    expect(state.positions[3]).toBeCloseTo(4, 3);
  });

  it("folds a two-triangle sheet to a positive dihedral toward +y", () => {
    // Rest square, hinge down its middle; the hinge is pinned and the two
    // opposite vertices are free. This is the sign convention the docs state:
    // rest (x, y) embedded as (x, 0, y), positive target folds toward +y.
    const rest = [0, 0, 0, 10, -10, 5, 10, 5];
    const positions = [0, 0, 0, 0, 0, 10, -10, 0, 5, 10, 0, 5];
    const triangles = [0, 1, 2, 0, 3, 1];
    const state = createClothState(positions, [0, 0, 1, 1]);
    const { constraints } = buildClothConstraints(
      { restPositions: rest, triangles },
      { stretchCompliance: 0, bendCompliance: 0 },
    );
    for (const constraint of constraints) {
      if (constraint.kind === "bend") constraint.targetAngle = Math.PI / 2;
    }
    const result = settleXpbdCloth(state, constraints, QUASI_STATIC, {
      maxSteps: 400,
      restDisplacement: 1e-4,
    });
    expect(result.settled).toBe(true);
    // Both wings rise toward +y and keep their distance from the hinge.
    expect(state.positions[2 * 3 + 1]).toBeGreaterThan(3);
    expect(state.positions[3 * 3 + 1]).toBeGreaterThan(3);
    const span = Math.hypot(
      state.positions[2 * 3] - state.positions[3 * 3],
      state.positions[2 * 3 + 1] - state.positions[3 * 3 + 1],
      state.positions[2 * 3 + 2] - state.positions[3 * 3 + 2],
    );
    // 90° dihedral between wings of length 10: |a − b| = 10·√2.
    expect(span).toBeCloseTo(10 * Math.SQRT2, 0);
  });

  it("rolls a crease through an arc instead of stretching through it", () => {
    // Strip pinned at its root, folded fully over through a bend zone: the
    // tip comes back over the root, lifted by the bend diameter, and the
    // leather bends — not stretches — through the turn.
    const spacing = 5;
    const strip = grid(60, 20, spacing);
    const radius = 4;
    const { state, result, edges } = foldStrip({ strip, radius, collide: false });
    expect(result.settled).toBe(true);

    // The tip (rest x = 60, mid row) lands on the pose: about (−10, 2r).
    const tip = (2 * strip.cols + strip.cols - 1) * 3;
    expect(state.positions[tip]).toBeCloseTo(-10, 0);
    expect(state.positions[tip + 1]).toBeCloseTo(2 * radius, 0);
    expect(edgeStretch(state, strip.rest, edges)).toBeLessThan(0.05);
  });

  it("drapes a fold over an obstacle it is not attached to", () => {
    // The case an analytic fold cannot do: a flap folded 180° across a
    // taller body it is not sewn to. Without contact it sweeps straight
    // through and lies inside the slab; with the collider it tents against
    // the slab's near wall, lies over its top, and hangs past its far edge.
    const spacing = 5;
    const strip = grid(60, 20, spacing);
    const radius = 4;
    const obstacleTop = 12;
    const base = strip.embedded.length / 3;
    // A slab: top face at y = 12 over x ∈ [0, 20], closed by the side wall
    // at x = 20 that faces the crease — the wall is what the near-crease
    // leather meets, exactly as a wallet flap meets a pocket's edge.
    const extraPositions = [
      0, obstacleTop, -5, 20, obstacleTop, -5, 0, obstacleTop, 25, 20, obstacleTop, 25,
      20, 0, -5, 20, 0, 25,
    ];
    const extraTriangles = [
      base, base + 1, base + 3, base, base + 3, base + 2,
      base + 1, base + 4, base + 5, base + 1, base + 5, base + 3,
    ];
    // Rest positions far from the cloth's, so the rest-space neighbourhood
    // filter never excuses the obstacle from colliding.
    const extraRest = [10000, 0, 10020, 0, 10000, 30, 10020, 30, 10040, 0, 10040, 30];

    const minOverFootprint = (state: XpbdClothState, clothCount: number) => {
      let min = Number.POSITIVE_INFINITY;
      for (let index = 0; index < clothCount; index += 1) {
        const x = state.positions[index * 3];
        if (strip.rest[index * 2] <= 30) continue;
        if (x < 2 || x > 18) continue;
        min = Math.min(min, state.positions[index * 3 + 1]);
      }
      return min;
    };

    const through = foldStrip({ strip, radius, extraPositions, extraTriangles, extraRest, collide: false });
    expect(minOverFootprint(through.state, through.clothCount)).toBeLessThan(obstacleTop - 2);

    const draped = foldStrip({ strip, radius, extraPositions, extraTriangles, extraRest, collide: true });
    expect(minOverFootprint(draped.state, draped.clothCount)).toBeGreaterThan(obstacleTop + 0.5);
  });

  it("keeps folded layers a thickness apart through self-collision", () => {
    // A fold dialled tighter than the material allows: the pose alone would
    // lay the two mid-surfaces 1mm apart; self-collision holds them at the
    // simulated thickness instead.
    const spacing = 5;
    const strip = grid(60, 20, spacing);
    const thickness = 2;
    const tight = foldStrip({ strip, radius: 0.5, collide: true, thickness });
    let checked = 0;
    for (let col = 0; col < strip.cols; col += 1) {
      if (col * spacing <= 35) continue;
      for (let row = 0; row < strip.rows; row += 1) {
        const offset = (row * strip.cols + col) * 3;
        // Only where the flap actually lies over the root — past the root's
        // edge there is nothing beneath it to hold it up.
        const x = tight.state.positions[offset];
        if (x < 2 || x > 24) continue;
        expect(tight.state.positions[offset + 1]).toBeGreaterThan(thickness * 0.7);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("composes a chain of creases like nested fold pivots", () => {
    const foldUp: CreaseFold = {
      start: { x: 20, y: 20 },
      end: { x: 20, y: 0 },
      angleRad: Math.PI / 2,
      zoneWidth: 0.02,
    };
    const foldBack: CreaseFold = {
      start: { x: 40, y: 20 },
      end: { x: 40, y: 0 },
      angleRad: -Math.PI / 2,
      zoneWidth: 0.02,
    };

    // One fold alone: the chain is exactly the single-crease pose.
    const single = creasePose(foldUp);
    const chainOfOne = creaseChainPose([foldUp]);
    for (const [x, y] of [[5, 3], [19, 10], [20.005, 7], [30, 0], [55, 20]]) {
      const a = single(x, y);
      const b = chainOfOne(x, y);
      expect(b[0]).toBeCloseTo(a[0], 6);
      expect(b[1]).toBeCloseTo(a[1], 6);
      expect(b[2]).toBeCloseTo(a[2], 6);
    }

    // Up then back: a Z. The first fold stands x > 20 vertical; the second,
    // turning the opposite way in the frame the first left, brings x > 40
    // horizontal again at the first segment's height.
    const chain = creaseChainPose([foldUp, foldBack]);
    const kneeHeight = chain(40, 10)[1];
    expect(kneeHeight).toBeCloseTo(20, 0);
    const a = chain(45, 10);
    const b = chain(55, 10);
    expect(a[1]).toBeCloseTo(kneeHeight, 1);
    expect(b[1]).toBeCloseTo(kneeHeight, 1);
    // The last segment keeps its rest length.
    expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeCloseTo(10, 3);
  });

  it("steps without moving pinned particles", () => {
    const state = createClothState([0, 0, 0, 5, 0, 0], [0, 1]);
    stepXpbdCloth(state, [createDistanceConstraint({ a: 0, b: 1, restLength: 5 })], {
      dt: 1 / 60,
      substeps: 2,
      iterations: 2,
      damping: 1,
      gravityY: -9.8,
    });
    expect(state.positions[0]).toBe(0);
    expect(state.positions[1]).toBe(0);
    expect(state.positions[4]).toBeLessThan(0);
  });
});
