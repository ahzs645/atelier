/**
 * The shape a garment arrives at a solver in.
 *
 * Two applications in this workspace make garments and neither makes them the
 * same way. seamer-studio cuts flat panels and sews them; knitterer knits
 * fabric a stitch at a time. They have almost nothing in common until the
 * question becomes *how does it hang*, and then they have everything in
 * common: a garment is particles, the distances between them that the fabric
 * insists on, the seams that hold its pieces to each other, and a body in the
 * way.
 *
 * That is what this describes. It is deliberately not a pattern, not a chart,
 * and not a mesh — it is the least that a solver needs, so that either
 * application's garment can be handed to either application's solver.
 */

/** Particles, and how much each one can be moved. */
export interface GarmentParticles {
  /** xyz per particle, in the garment's own units. */
  readonly positions: Float32Array;
  /**
   * Inverse mass per particle. Zero pins a particle where it is, which is how
   * a garment is held to a hanger, a shoulder or a stitch someone is holding.
   */
  readonly invMass: Float32Array;
}

/**
 * A distance the fabric insists on.
 *
 * Both kinds of garment reduce to these. A woven panel's are the edges of its
 * triangulation; a knitted one's are the edges of its stitches, which the
 * chart already knows because a stitch has a size. `stiffness` below one lets
 * a constraint give, which is what makes a seam a seam rather than a weld.
 */
export interface GarmentConstraint {
  readonly a: number;
  readonly b: number;
  readonly rest: number;
  readonly stiffness?: number;
}

/** A body, or anything else the garment is not allowed to pass through. */
export interface GarmentCollider {
  /** xyz per vertex, in the garment's units. */
  readonly positions: Float32Array;
  /** Triangle vertex indices, three per triangle. */
  readonly indices: Uint32Array;
}

/** Where one range of constraints came from, so a host can talk about them. */
export interface GarmentConstraintRange {
  readonly kind: "fabric" | "self-seam" | "piece-seam";
  readonly start: number;
  readonly count: number;
}

/** One piece of the garment, and which particles are its. */
export interface GarmentPiece {
  readonly name: string;
  readonly kind?: string;
  readonly particleStart: number;
  readonly particleCount: number;
}

export interface PreparedGarment {
  readonly particles: GarmentParticles;
  readonly constraints: readonly GarmentConstraint[];
  /** Optional, and in the same order as `constraints`. */
  readonly ranges?: readonly GarmentConstraintRange[];
  readonly pieces?: readonly GarmentPiece[];
  readonly collider?: GarmentCollider;
  /**
   * Units the positions are in, so a garment measured in centimetres and one
   * measured in metres cannot be quietly mixed. Gravity is the giveaway: get
   * this wrong and the fabric falls a hundred times too fast or not at all.
   */
  readonly unit?: "m" | "cm" | "mm" | "in";
}

/** What a garment solver reports as it runs. */
export interface GarmentSolverState {
  readonly positions: Float32Array;
  /** Particles currently resting against the collider. */
  readonly contacts: number;
  /** Mean and worst fractional error against the constraints' rest lengths. */
  readonly meanStrain: number;
  readonly worstStrain: number;
}

const particleStride = 3;

/** Checks a prepared garment holds together before a solver is built from it. */
export function validatePreparedGarment(garment: PreparedGarment): string[] {
  const problems: string[] = [];
  const { positions, invMass } = garment.particles;
  if (positions.length % particleStride !== 0) {
    problems.push(
      `positions holds ${positions.length} numbers, which is not a whole number of particles`,
    );
  }
  const count = Math.floor(positions.length / particleStride);
  if (invMass.length !== count) {
    problems.push(`${invMass.length} inverse masses for ${count} particles`);
  }
  for (let index = 0; index < garment.constraints.length; index++) {
    const constraint = garment.constraints[index]!;
    if (constraint.a < 0 || constraint.a >= count || constraint.b < 0 || constraint.b >= count) {
      problems.push(
        `constraint ${index} joins particles ${constraint.a} and ${constraint.b}, outside the ${count} there are`,
      );
      break;
    }
    if (!(constraint.rest >= 0)) {
      problems.push(`constraint ${index} has a rest length of ${constraint.rest}`);
      break;
    }
  }
  if (garment.collider) {
    const vertices = Math.floor(garment.collider.positions.length / particleStride);
    for (let index = 0; index < garment.collider.indices.length; index++) {
      if (garment.collider.indices[index]! >= vertices) {
        problems.push(
          `the collider's triangle ${Math.floor(index / 3)} names vertex ${garment.collider.indices[index]}, outside the ${vertices} it has`,
        );
        break;
      }
    }
  }
  for (const piece of garment.pieces ?? []) {
    if (piece.particleStart + piece.particleCount > count) {
      problems.push(
        `piece "${piece.name}" claims particles up to ${piece.particleStart + piece.particleCount}, past the ${count} there are`,
      );
      break;
    }
  }
  return problems;
}

/** How many particles a prepared garment holds. */
export function garmentParticleCount(garment: PreparedGarment): number {
  return Math.floor(garment.particles.positions.length / particleStride);
}
