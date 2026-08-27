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
import { createTriangleCollider } from "./xpbdCollision";

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
