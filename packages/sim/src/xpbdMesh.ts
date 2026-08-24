/**
 * Cloth constraint sets from a triangle mesh with a flat rest state.
 *
 * Rest lengths come from the 2D rest positions, not from wherever the 3D
 * particles start: the flat pattern is the truth about the material, and the
 * solver's job is to bend it out of plane without stretching it.
 *
 * The extraction is the one Seamer's build step performs: every unique mesh
 * edge becomes a stretch constraint, and every interior edge — one shared by
 * exactly two triangles — becomes a bend constraint whose moved pair is the
 * two opposite vertices and whose hinge is the shared edge. A caller that
 * wants a fold hands in `targetAngleForHinge`; hinges it maps to a non-zero
 * angle bend toward that dihedral, the rest resist bending flat.
 */

import {
  createBendConstraint,
  createDistanceConstraint,
  dihedralAngle,
  type XpbdClothConstraint,
} from "./xpbdCloth";

export interface ClothMeshInput {
  /** xy per vertex, rest (flat) space. */
  restPositions: ArrayLike<number>;
  /** Vertex index triplets. */
  triangles: ArrayLike<number>;
}

export interface ClothConstraintOptions {
  stretchCompliance?: number;
  bendCompliance?: number;
  /** Compliance once an opposite pair separates past rest. Defaults to stretch. */
  bendComplianceBeyond?: number;
  /**
   * Target dihedral angle, radians, for the hinge edge (a, b) — vertex order
   * is the mesh's own. Return 0 for an unfolded hinge.
   */
  targetAngleForHinge?: (hingeA: number, hingeB: number) => number;
}

export interface ClothConstraintSet {
  constraints: XpbdClothConstraint[];
  /** Unique mesh edges, for callers that render or debug the wireframe. */
  edges: Array<[number, number]>;
}

export function buildClothConstraints(
  mesh: ClothMeshInput,
  options: ClothConstraintOptions = {},
): ClothConstraintSet {
  const rest = mesh.restPositions;
  const triangles = mesh.triangles;
  const stretchCompliance = options.stretchCompliance ?? 0;
  const bendCompliance = options.bendCompliance ?? 0;
  const bendComplianceBeyond = options.bendComplianceBeyond ?? stretchCompliance;

  const restDistance = (a: number, b: number): number =>
    Math.hypot(rest[a * 2] - rest[b * 2], rest[a * 2 + 1] - rest[b * 2 + 1]);

  const constraints: XpbdClothConstraint[] = [];
  const edges: Array<[number, number]> = [];
  const seenEdges = new Set<number>();
  const opposite = new Map<number, number[]>();
  let vertexCount = 0;
  for (let i = 0; i < triangles.length; i += 1) {
    if (triangles[i] + 1 > vertexCount) vertexCount = triangles[i] + 1;
  }
  const edgeKey = (a: number, b: number): number =>
    Math.min(a, b) * vertexCount + Math.max(a, b);

  for (let t = 0; t < triangles.length; t += 3) {
    const tri = [triangles[t], triangles[t + 1], triangles[t + 2]];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = edgeKey(a, b);
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push([Math.min(a, b), Math.max(a, b)]);
        constraints.push(
          createDistanceConstraint({
            a,
            b,
            restLength: restDistance(a, b),
            compliance: stretchCompliance,
          }),
        );
      }
      const opposites = opposite.get(key);
      if (opposites) opposites.push(tri[(e + 2) % 3]);
      else opposite.set(key, [tri[(e + 2) % 3]]);
    }
  }

  // Which side of the directed hinge a vertex sits on in rest space, so the
  // bend constraint's opposite pair is always (left, right) and a target
  // angle's sign means the same fold on every hinge.
  const restSide = (hingeA: number, hingeB: number, vertex: number): number => {
    const hx = rest[hingeB * 2] - rest[hingeA * 2];
    const hy = rest[hingeB * 2 + 1] - rest[hingeA * 2 + 1];
    const vx = rest[vertex * 2] - rest[hingeA * 2];
    const vy = rest[vertex * 2 + 1] - rest[hingeA * 2 + 1];
    return hx * vy - hy * vx;
  };

  for (const [key, opposites] of opposite) {
    if (opposites.length !== 2) continue;
    const hingeA = Math.floor(key / vertexCount);
    const hingeB = key % vertexCount;
    const firstIsLeft =
      restSide(hingeA, hingeB, opposites[0]) >= restSide(hingeA, hingeB, opposites[1]);
    constraints.push(
      createBendConstraint({
        a: firstIsLeft ? opposites[0] : opposites[1],
        b: firstIsLeft ? opposites[1] : opposites[0],
        hingeA,
        hingeB,
        restLength: restDistance(opposites[0], opposites[1]),
        compliance: bendCompliance,
        complianceBeyond: bendComplianceBeyond,
        targetAngle: options.targetAngleForHinge?.(hingeA, hingeB) ?? 0,
      }),
    );
  }

  return { constraints, edges };
}

export interface CreaseFold {
  /** A point on the crease line, rest space. */
  start: { x: number; y: number };
  /**
   * A second point; the line through both is the crease, directed
   * start → end. The side on the LEFT of that direction is the one that
   * swings — orient the line to say which half moves.
   */
  end: { x: number; y: number };
  /**
   * Total fold angle, radians. Positive folds the swinging side toward +y
   * when rest (x, y) is embedded as (x, 0, y); a mirrored embedding mirrors
   * the sign.
   */
  angleRad: number;
  /**
   * Width of the bend zone across the crease, rest units, centred on the
   * line. The fold's curvature is spread across it, which is what gives
   * leather a rolled bend instead of a knife crease: a fold of angle θ and
   * bend radius r rolls through an arc of length r·|θ|, so pass
   * `zoneWidth = r·|θ|` (floored to the mesh spacing so at least one hinge
   * row carries it).
   */
  zoneWidth: number;
}

/**
 * The developable single-crease pose: rest (x, y) → the folded mid-surface.
 *
 * Flat up to the zone, a cylinder arc of radius zoneWidth/|angle| through it,
 * flat again beyond — material-preserving, unlike a renderer that keeps both
 * halves whole and inserts the arc as extra surface. Exposed for callers that
 * want the posed target shape itself (seeding, mapping, debugging).
 */
export function creasePose(
  crease: CreaseFold,
): (x: number, y: number) => [number, number, number] {
  const dx = crease.end.x - crease.start.x;
  const dy = crease.end.y - crease.start.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0 || crease.zoneWidth <= 0 || crease.angleRad === 0) {
    return (x, y) => [x, 0, y];
  }
  const dirX = dx / length;
  const dirY = dy / length;
  const angle = Math.abs(crease.angleRad);
  const sign = Math.sign(crease.angleRad);
  const width = crease.zoneWidth;
  const radius = width / angle;
  const half = width / 2;

  return (x, y) => {
    // Split rest space into the along-crease and across-crease coordinates;
    // the pose only bends the across coordinate, into (across', height).
    const relX = x - crease.start.x;
    const relY = y - crease.start.y;
    const along = relX * dirX + relY * dirY;
    const across = dirX * relY - dirY * relX;
    let acrossPosed: number;
    let height: number;
    if (across <= -half) {
      acrossPosed = across;
      height = 0;
    } else if (across < half) {
      const swept = ((across + half) / width) * angle;
      acrossPosed = -half + radius * Math.sin(swept);
      height = sign * radius * (1 - Math.cos(swept));
    } else {
      acrossPosed = -half + radius * Math.sin(angle) + (across - half) * Math.cos(angle);
      height = sign * (radius * (1 - Math.cos(angle)) + (across - half) * Math.sin(angle));
    }
    // Reassemble: along stays on the crease direction, the posed across
    // coordinate on the rest-space left normal, height on +y.
    const leftX = -dirY;
    const leftY = dirX;
    return [
      crease.start.x + along * dirX + acrossPosed * leftX,
      height,
      crease.start.y + along * dirY + acrossPosed * leftY,
    ];
  };
}

/**
 * Give each bend hinge the target dihedral it has on the creases' posed
 * surface.
 *
 * Posing the rest mesh and measuring every hinge with the kernel's own
 * `dihedralAngle` makes the folded pose the solver's equilibrium exactly,
 * whatever the triangulation: hinges along a crease pick up their share of
 * the turn, hinges running across it measure flat and stay flat. Creases sum,
 * which is exact when their bend zones do not overlap and each quad feels at
 * most one fold — a piece folded twice through the same patch of leather is
 * not a shape this targets.
 */
export function assignCreaseTargets(
  constraints: readonly XpbdClothConstraint[],
  restPositions: ArrayLike<number>,
  creases: readonly CreaseFold[],
): void {
  const poses = creases.map(creasePose);
  const posed = (pose: (typeof poses)[number], vertex: number): [number, number, number] =>
    pose(restPositions[vertex * 2], restPositions[vertex * 2 + 1]);
  for (const constraint of constraints) {
    if (constraint.kind !== "bend") continue;
    let target = 0;
    for (const pose of poses) {
      target += dihedralAngle(
        posed(pose, constraint.a),
        posed(pose, constraint.b),
        posed(pose, constraint.hingeA),
        posed(pose, constraint.hingeB),
      );
    }
    constraint.targetAngle = target;
  }
}
