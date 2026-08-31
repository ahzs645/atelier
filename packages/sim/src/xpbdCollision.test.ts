/**
 * What the triangle collider must not do to the mesh it is colliding.
 *
 * The collider holds surfaces one thickness apart. Two particles joined by a
 * mesh edge shorter than that thickness are a surface it must not hold apart:
 * the distance constraint already owns their separation, and contact fighting
 * it inflates the cloth. A mesh cut finer than it is thick — which is what a
 * crease band is — is where that shows.
 */

import { describe, expect, it } from "vitest";
import {
  createClothState,
  settleXpbdCloth,
  type XpbdClothState,
  type XpbdClothStepOptions,
} from "./xpbdCloth";
import { buildClothConstraints } from "./xpbdMesh";
import { closestPointOnTriangle, createTriangleCollider } from "./xpbdCollision";

const QUASI_STATIC: XpbdClothStepOptions = {
  dt: 1 / 60,
  substeps: 10,
  iterations: 8,
  damping: 0.6,
};

/** Rest xy embedded as (x, 0, y), the convention the rest of the sim uses. */
function embed(rest: number[], height = 0): number[] {
  const positions: number[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    positions.push(rest[index], height, rest[index + 1]);
  }
  return positions;
}

function worstStretch(
  state: XpbdClothState,
  rest: number[],
  edges: ReadonlyArray<readonly [number, number]>,
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

describe("triangle collider topology", () => {
  it("never pushes a particle off a triangle it is a corner of", () => {
    // One triangle, every side of it shorter than the contact offset. A
    // collider with no notion of topology would find each corner well inside
    // the other corners' contact shells and blow the triangle open.
    const rest = [0, 0, 1, 0, 0, 1];
    const triangles = [0, 1, 2];
    const state = createClothState(embed(rest), [1, 1, 1]);
    const before = Float32Array.from(state.positions);
    const collider = createTriangleCollider({ triangles, config: { thickness: 5 } });

    collider.gather(state);
    collider.apply(state);

    expect(Array.from(state.positions)).toEqual(Array.from(before));
  });

  it("does not stretch a mesh edge shorter than the contact offset", () => {
    // Two triangles across one shared edge — the smallest mesh where a
    // particle is not a corner of every triangle. Vertex 1 is not a corner of
    // triangle (0, 3, 2), but it shares edge 0–3 with it, and every one of
    // these edges is a third of the contact offset. Contact must stay out of
    // it: the distance constraints own these lengths.
    //
    // No rest positions are given, so the rest-space neighbourhood filter is
    // off and topology is the only thing keeping contact away.
    const rest = [0, 0, 1, 0, 0, 1, 1, 1];
    const triangles = [0, 1, 3, 0, 3, 2];
    const state = createClothState(embed(rest), [1, 1, 1, 1]);
    const { constraints, edges } = buildClothConstraints(
      { restPositions: rest, triangles },
      { stretchCompliance: 0, bendCompliance: 1e-4 },
    );
    const collider = createTriangleCollider({ triangles, config: { thickness: 3 } });

    settleXpbdCloth(
      state,
      constraints,
      { ...QUASI_STATIC, collider, colliderEveryIteration: true },
      { maxSteps: 60, restDisplacement: 1e-6 },
    );

    expect(worstStretch(state, rest, edges)).toBeLessThan(1e-3);
    // And it is still the square it was cut as, not a square that drifted.
    const span = Math.hypot(
      state.positions[0] - state.positions[3 * 3],
      state.positions[1] - state.positions[3 * 3 + 1],
      state.positions[2] - state.positions[3 * 3 + 2],
    );
    expect(span).toBeCloseTo(Math.SQRT2, 3);
  });

  it("still separates two surfaces that share no vertices", () => {
    // The other half of the contract: excluding topological neighbours must
    // not excuse a second body. A free sheet is dropped onto a pinned slab it
    // shares no vertex with, over the middle of it — more than the contact
    // offset from any of the slab's edges, so a free vertex has exactly one
    // contact and the separation it settles to is the offset itself.
    const spacing = 6;
    const sheetRest = [0, 0, spacing, 0, 0, spacing, spacing, spacing];
    const dropHeight = 8;
    const sheetTriangles = [0, 1, 3, 0, 3, 2];
    // One triangle, wide enough that its own edges are far outside the sheet.
    const slab = [-20, 0, -20, 40, 0, -20, -20, 0, 40];
    const slabTriangles = [4, 5, 6];

    const state = createClothState(
      [...embed(sheetRest, dropHeight), ...slab],
      [1, 1, 1, 1, 0, 0, 0],
    );
    const { constraints, edges } = buildClothConstraints(
      { restPositions: sheetRest, triangles: sheetTriangles },
      { stretchCompliance: 0, bendCompliance: 1e-4 },
    );
    const thickness = 2;
    const collider = createTriangleCollider({
      triangles: [...sheetTriangles, ...slabTriangles],
      config: { thickness },
    });

    const result = settleXpbdCloth(
      state,
      constraints,
      {
        ...QUASI_STATIC,
        gravityY: -500,
        maxVelocity: 50,
        collider,
        colliderEveryIteration: true,
      },
      { maxSteps: 400, restDisplacement: 1e-4 },
    );

    expect(result.settled).toBe(true);
    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = 0; index < 4; index += 1) {
      lowest = Math.min(lowest, state.positions[index * 3 + 1]);
      highest = Math.max(highest, state.positions[index * 3 + 1]);
    }
    // It fell, it stopped on the slab rather than through it, and it stopped
    // one contact offset up.
    expect(lowest).toBeLessThan(dropHeight - 1);
    expect(lowest).toBeCloseTo(thickness, 1);
    expect(highest - lowest).toBeLessThan(1e-2);
    // The slab never moves: it is pinned, and nothing may drag it.
    expect(state.positions[4 * 3 + 1]).toBe(0);
    expect(worstStretch(state, sheetRest, edges)).toBeLessThan(1e-3);
  });
});

/**
 * Every branch of the region walk, against a reference that cannot share its
 * mistakes.
 *
 * The walk has seven branches and only one of them — the interior — is
 * reachable by the queries a settle happens to generate, which is how two
 * defects survived a port. So aim a query at each region and check the answer
 * against a brute-force minimisation over the triangle, which knows nothing
 * about Eberly.
 */
describe("closestPointOnTriangle", () => {
  const TRIANGLE = [0, 0, 0, 4, 0, 0, 0, 3, 0] as const;

  /** The closest point, found by dense sampling of the barycentric domain. */
  function bruteForce(point: readonly number[]) {
    let best = Infinity;
    let bestAt = [0, 0, 0];
    const steps = 600;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps - i; j += 1) {
        const s = i / steps;
        const t = j / steps;
        const x = TRIANGLE[0] + s * (TRIANGLE[3] - TRIANGLE[0]) + t * (TRIANGLE[6] - TRIANGLE[0]);
        const y = TRIANGLE[1] + s * (TRIANGLE[4] - TRIANGLE[1]) + t * (TRIANGLE[7] - TRIANGLE[1]);
        const z = TRIANGLE[2] + s * (TRIANGLE[5] - TRIANGLE[2]) + t * (TRIANGLE[8] - TRIANGLE[2]);
        const d = (x - point[0]) ** 2 + (y - point[1]) ** 2 + (z - point[2]) ** 2;
        if (d < best) {
          best = d;
          bestAt = [x, y, z];
        }
      }
    }
    return bestAt;
  }

  const cases: Array<[string, number[]]> = [
    ["interior", [1, 1, 2]],
    ["over vertex p0", [-2, -2, 1]],
    ["over vertex p1", [7, -2, 1]],
    ["over vertex p2", [-2, 6, 1]],
    ["over edge p0-p1", [2, -3, 1]],
    ["over edge p0-p2", [-3, 1.5, 1]],
    ["over edge p1-p2", [4, 3, 1]],
    // Region 6: past p1, below the t = 0 edge. Collapsing here must minimise
    // along edge0, not edge1 — the branch that returned p0, the far vertex of
    // the wrong edge, in the kernel this was ported from.
    ["region 6, past p1 below the base", [9, -1, 0]],
    ["region 6, far past p1", [40, -0.5, 0]],
  ];

  for (const [name, query] of cases) {
    it(`lands on the triangle for a query ${name}`, () => {
      const out = new Float64Array(3);
      closestPointOnTriangle(...(TRIANGLE as unknown as [number, number, number, number, number, number, number, number, number]), query[0], query[1], query[2], out);
      const expected = bruteForce(query);
      const off = Math.hypot(out[0] - expected[0], out[1] - expected[1], out[2] - expected[2]);
      expect(off).toBeLessThan(0.02);
    });
  }
});
