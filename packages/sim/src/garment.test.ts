import { describe, expect, it } from "vitest";
import { garmentParticleCount, validatePreparedGarment } from "./garment";
import type { PreparedGarment } from "./garment";

function square(): PreparedGarment {
  return {
    particles: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      invMass: new Float32Array([1, 1, 1, 1]),
    },
    constraints: [
      { a: 0, b: 1, rest: 1 },
      { a: 1, b: 2, rest: 1 },
      { a: 2, b: 3, rest: 1 },
      { a: 3, b: 0, rest: 1 },
    ],
    unit: "cm",
  };
}

describe("prepared garment", () => {
  it("counts its particles", () => {
    expect(garmentParticleCount(square())).toBe(4);
  });

  it("accepts a garment that holds together", () => {
    expect(validatePreparedGarment(square())).toEqual([]);
  });

  it("refuses positions that are not a whole number of particles", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      particles: {
        positions: new Float32Array(7),
        invMass: garment.particles.invMass,
      },
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/whole number of particles/);
  });

  it("refuses a mass for every particle but one", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      particles: {
        positions: garment.particles.positions,
        invMass: new Float32Array(3),
      },
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/3 inverse masses for 4 particles/);
  });

  it("refuses a constraint that names a particle there is none of", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      constraints: [...garment.constraints, { a: 0, b: 9, rest: 1 }],
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/outside the 4 there are/);
  });

  it("refuses a collider triangle that names a vertex there is none of", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      collider: {
        positions: new Float32Array(9),
        indices: new Uint32Array([0, 1, 5]),
      },
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/outside the 3 it has/);
  });

  it("refuses a piece that claims particles past the end", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      pieces: [{ name: "front", particleStart: 2, particleCount: 4 }],
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/past the 4 there are/);
  });

  it("refuses a constraint whose particle is not a whole number", () => {
    // Both of these are in range as far as an ordering test can tell — NaN
    // because every comparison against it is false, 1.5 because it sits
    // between two particles that do exist — and both index the position array
    // to undefined once multiplied by the stride.
    const garment = square();
    for (const a of [Number.NaN, 1.5]) {
      const broken: PreparedGarment = { ...garment, constraints: [{ a, b: 1, rest: 1 }] };
      expect(validatePreparedGarment(broken)[0]).toMatch(/not both whole numbers/);
    }
  });

  it("refuses a piece that starts before the first particle", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      pieces: [{ name: "front", particleStart: -1, particleCount: 2 }],
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/not a run of them/);
  });

  it("refuses a collider that is not a whole number of vertices", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      collider: { positions: new Float32Array(7), indices: new Uint32Array([0, 1, 2]) },
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/whole number of vertices/);
  });

  it("refuses a collider whose indices do not make whole triangles", () => {
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      collider: { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2, 0]) },
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/whole number of triangles/);
  });

  it("refuses a collider triangle that names a vertex before the first", () => {
    // A garment that crossed an application boundary is not always still
    // holding the typed arrays its type claims: a JSON round-trip leaves plain
    // arrays behind, and those can carry the negative index a Uint32Array
    // would have wrapped into a large positive one.
    const garment = square();
    const broken: PreparedGarment = {
      ...garment,
      collider: {
        positions: new Float32Array(9),
        indices: [0, 1, -5] as unknown as Uint32Array,
      },
    };
    expect(validatePreparedGarment(broken)[0]).toMatch(/outside the 3 it has/);
  });
});
