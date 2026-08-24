/**
 * CPU XPBD cloth kernels: distance constraints, dihedral bending with a target
 * fold angle, and a settle loop for quasi-static solves.
 *
 * These are the shared kernels under an app's domain solver, not a domain
 * solver themselves. The distance constraint is the shape LeatherCad's
 * `xpbd-lite` carried and Seamer's WGSL engine dispatches; the bending kernel
 * is a port of Seamer's dihedral shader, which nudges the two vertices
 * opposite a hinge edge around that hinge toward a target dihedral angle and
 * falls back to an opposite-pair distance constraint where no fold is asked
 * for. Keeping the kernels here means a consumer that needs a fold to be
 * *simulated* — bending into contact, not rotated into place — builds only the
 * mesh and the constraint set, and every consumer resolves contact and
 * curvature the same way.
 *
 * Units are the caller's. XPBD compliance is `alpha` in the usual formulation:
 * the constraint is scaled by `alpha / dt²` per substep, so 0 is rigid and
 * larger is softer, in the caller's units squared.
 */

export interface XpbdClothState {
  readonly count: number;
  /** xyz per particle. */
  readonly positions: Float32Array;
  /** Position at the start of the current substep; the friction reference. */
  readonly prevPositions: Float32Array;
  readonly velocities: Float32Array;
  /** 0 pins a particle; pinned particles also serve as static colliders. */
  readonly inverseMasses: Float32Array;
}

export function createClothState(
  positions: ArrayLike<number>,
  inverseMasses?: ArrayLike<number>,
): XpbdClothState {
  const pos = Float32Array.from(positions);
  const count = Math.floor(pos.length / 3);
  const inv = new Float32Array(count).fill(1);
  if (inverseMasses) {
    for (let i = 0; i < count && i < inverseMasses.length; i += 1) {
      inv[i] = inverseMasses[i];
    }
  }
  return {
    count,
    positions: pos,
    prevPositions: pos.slice(),
    velocities: new Float32Array(count * 3),
    inverseMasses: inv,
  };
}

export interface XpbdDistanceConstraint {
  kind: "distance";
  a: number;
  b: number;
  restLength: number;
  compliance: number;
  /** Resist stretch only — a thread through a casing, not a rod. */
  oneSided: boolean;
  lambda: number;
}

export interface XpbdBendConstraint {
  kind: "bend";
  /** The two vertices opposite the hinge edge — the pair the kernel moves. */
  a: number;
  b: number;
  hingeA: number;
  hingeB: number;
  /** Rest separation of `a` and `b`, for the no-fold distance mode. */
  restLength: number;
  compliance: number;
  /** Compliance once the opposite pair separates past rest (stretch regime). */
  complianceBeyond: number;
  /**
   * Target dihedral angle across the hinge, radians. Zero selects the
   * distance mode.
   *
   * Sign convention, and the reason it is stable under relabeling: the hinge
   * is directed `hingeA → hingeB`, and the dihedral is measured as
   * `atan2(dot(cross(n̂a, n̂b), ê), dot(n̂a, n̂b))` with
   * `na = (a−hA)×(a−hB)` and `nb = (b−hB)×(b−hA)`. Flipping the hinge
   * direction while swapping `a`/`b` leaves the measure unchanged, so a
   * builder that always puts `a` on the left of the directed hinge in rest
   * space (as `buildClothConstraints` does) gives every hinge the same signed
   * meaning: with rest (x, y) embedded as (x, 0, y), a positive target folds
   * both faces toward +y; a mirrored embedding mirrors the sign.
   */
  targetAngle: number;
  lambda: number;
}

export interface XpbdAnchorConstraint {
  kind: "anchor";
  index: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  /**
   * 0 pins to the target outright; larger lets other constraints — contact
   * above all — win locally while the anchor keeps pulling the particle
   * toward its target. The soft hold under a posed drape.
   */
  compliance: number;
  lambda: number;
}

export type XpbdClothConstraint =
  | XpbdDistanceConstraint
  | XpbdBendConstraint
  | XpbdAnchorConstraint;

export function createDistanceConstraint(params: {
  a: number;
  b: number;
  restLength: number;
  compliance?: number;
  oneSided?: boolean;
}): XpbdDistanceConstraint {
  return {
    kind: "distance",
    a: params.a,
    b: params.b,
    restLength: params.restLength,
    compliance: params.compliance ?? 0,
    oneSided: params.oneSided ?? false,
    lambda: 0,
  };
}

export function createAnchorConstraint(params: {
  index: number;
  target: readonly [number, number, number];
  compliance?: number;
}): XpbdAnchorConstraint {
  return {
    kind: "anchor",
    index: params.index,
    targetX: params.target[0],
    targetY: params.target[1],
    targetZ: params.target[2],
    compliance: params.compliance ?? 0,
    lambda: 0,
  };
}

export function createBendConstraint(params: {
  a: number;
  b: number;
  hingeA: number;
  hingeB: number;
  restLength: number;
  compliance?: number;
  complianceBeyond?: number;
  targetAngle?: number;
}): XpbdBendConstraint {
  return {
    kind: "bend",
    a: params.a,
    b: params.b,
    hingeA: params.hingeA,
    hingeB: params.hingeB,
    restLength: params.restLength,
    compliance: params.compliance ?? 0,
    complianceBeyond: params.complianceBeyond ?? params.compliance ?? 0,
    targetAngle: params.targetAngle ?? 0,
    lambda: 0,
  };
}

/**
 * Contact resolution plugged into the substep loop.
 *
 * `gather` builds a broad-phase candidate list from current positions and is
 * called at the cadence the step options ask for; `apply` resolves the
 * gathered contacts against current positions once per substep, after the
 * stretch and bend iterations — the order Seamer's engine dispatches.
 */
export interface XpbdCollider {
  gather(state: XpbdClothState): void;
  apply(state: XpbdClothState): void;
}

export interface XpbdClothStepOptions {
  dt: number;
  substeps: number;
  iterations: number;
  /** Per-substep velocity multiplier: 1 keeps velocity, 0 kills it. */
  damping: number;
  gravityY?: number;
  /** Clamp on particle speed, caller units per second. Unset = unclamped. */
  maxVelocity?: number;
  /**
   * How much of the remaining dihedral error one bend iteration takes up.
   * Seamer's live engine uses 0.01 across 40 substeps a frame; a settle solve
   * wants a larger bite.
   */
  bendAngleGain?: number;
  /** Largest dihedral correction one iteration may apply, radians. */
  bendMaxStepRad?: number;
  collider?: XpbdCollider;
  /** Substeps between collider re-gathers. Default: once per step() call. */
  colliderGatherInterval?: number;
  /**
   * Resolve contacts inside the iteration loop instead of once per substep.
   * Once per substep is Seamer's cadence and fine for free cloth; a solve
   * that also pulls hard toward a pose needs contact answered at the same
   * cadence as the pull, or the pull tunnels the cloth through the surface.
   */
  colliderEveryIteration?: boolean;
}

const DEFAULT_BEND_GAIN = 0.01;
const DEFAULT_BEND_MAX_STEP = 0.01;
const LENGTH_EPSILON = 1e-9;
const NORMAL_EPSILON = 1e-6;

function wrapAngle(angle: number): number {
  if (angle > Math.PI) return angle - 2 * Math.PI;
  if (angle < -Math.PI) return angle + 2 * Math.PI;
  return angle;
}

/**
 * The signed dihedral the bend kernel measures, for positions given as
 * [x, y, z] triples: `a`/`b` are the opposite vertices, the hinge is directed
 * hingeA → hingeB. Exposed so builders can pose a mesh and read off the
 * target angles the kernel will hold it at — one formula, no convention to
 * keep in sync. Returns 0 where a triangle is degenerate.
 */
export function dihedralAngle(
  a: readonly number[],
  b: readonly number[],
  hingeA: readonly number[],
  hingeB: readonly number[],
): number {
  const ex = hingeB[0] - hingeA[0];
  const ey = hingeB[1] - hingeA[1];
  const ez = hingeB[2] - hingeA[2];
  const edgeLen = Math.hypot(ex, ey, ez);
  if (edgeLen < NORMAL_EPSILON) return 0;
  const ahx = a[0] - hingeA[0];
  const ahy = a[1] - hingeA[1];
  const ahz = a[2] - hingeA[2];
  const agx = a[0] - hingeB[0];
  const agy = a[1] - hingeB[1];
  const agz = a[2] - hingeB[2];
  let n1x = ahy * agz - ahz * agy;
  let n1y = ahz * agx - ahx * agz;
  let n1z = ahx * agy - ahy * agx;
  const bgx = b[0] - hingeB[0];
  const bgy = b[1] - hingeB[1];
  const bgz = b[2] - hingeB[2];
  const bhx = b[0] - hingeA[0];
  const bhy = b[1] - hingeA[1];
  const bhz = b[2] - hingeA[2];
  let n2x = bgy * bhz - bgz * bhy;
  let n2y = bgz * bhx - bgx * bhz;
  let n2z = bgx * bhy - bgy * bhx;
  const n1Len = Math.hypot(n1x, n1y, n1z);
  const n2Len = Math.hypot(n2x, n2y, n2z);
  if (n1Len < NORMAL_EPSILON || n2Len < NORMAL_EPSILON) return 0;
  n1x /= n1Len;
  n1y /= n1Len;
  n1z /= n1Len;
  n2x /= n2Len;
  n2y /= n2Len;
  n2z /= n2Len;
  const sinPhi =
    ((n1y * n2z - n1z * n2y) * ex +
      (n1z * n2x - n1x * n2z) * ey +
      (n1x * n2y - n1y * n2x) * ez) /
    edgeLen;
  const cosPhi = Math.min(1, Math.max(-1, n1x * n2x + n1y * n2y + n1z * n2z));
  return wrapAngle(Math.atan2(sinPhi, cosPhi));
}

function solveDistance(
  state: XpbdClothState,
  constraint: XpbdDistanceConstraint,
  dt: number,
): void {
  const { positions, inverseMasses } = state;
  const ao = constraint.a * 3;
  const bo = constraint.b * 3;
  const dx = positions[ao] - positions[bo];
  const dy = positions[ao + 1] - positions[bo + 1];
  const dz = positions[ao + 2] - positions[bo + 2];
  const length = Math.hypot(dx, dy, dz);
  if (length <= LENGTH_EPSILON) return;
  if (constraint.oneSided && length <= constraint.restLength) return;

  const wa = inverseMasses[constraint.a];
  const wb = inverseMasses[constraint.b];
  const wSum = wa + wb;
  if (wSum <= LENGTH_EPSILON) return;

  const alphaTilde = constraint.compliance / (dt * dt);
  const c = length - constraint.restLength;
  const deltaLambda = -(c + alphaTilde * constraint.lambda) / (wSum + alphaTilde);
  constraint.lambda += deltaLambda;

  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;
  positions[ao] += wa * deltaLambda * nx;
  positions[ao + 1] += wa * deltaLambda * ny;
  positions[ao + 2] += wa * deltaLambda * nz;
  positions[bo] -= wb * deltaLambda * nx;
  positions[bo + 1] -= wb * deltaLambda * ny;
  positions[bo + 2] -= wb * deltaLambda * nz;
}

function solveAnchor(
  state: XpbdClothState,
  constraint: XpbdAnchorConstraint,
  dt: number,
): void {
  const { positions, inverseMasses } = state;
  const w = inverseMasses[constraint.index];
  if (w <= 0) return;
  const offset = constraint.index * 3;
  const dx = positions[offset] - constraint.targetX;
  const dy = positions[offset + 1] - constraint.targetY;
  const dz = positions[offset + 2] - constraint.targetZ;
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= LENGTH_EPSILON) return;
  const alphaTilde = constraint.compliance / (dt * dt);
  const deltaLambda = -(distance + alphaTilde * constraint.lambda) / (w + alphaTilde);
  constraint.lambda += deltaLambda;
  positions[offset] += (w * deltaLambda * dx) / distance;
  positions[offset + 1] += (w * deltaLambda * dy) / distance;
  positions[offset + 2] += (w * deltaLambda * dz) / distance;
}

/** Rodrigues rotation of `v` (3 slots at `offset` in `out`) about unit `axis`. */
function rotateInto(
  out: Float32Array,
  offset: number,
  vx: number,
  vy: number,
  vz: number,
  ax: number,
  ay: number,
  az: number,
  angle: number,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = ax * vx + ay * vy + az * vz;
  out[offset] = vx * cos + (ay * vz - az * vy) * sin + ax * dot * (1 - cos);
  out[offset + 1] = vy * cos + (az * vx - ax * vz) * sin + ay * dot * (1 - cos);
  out[offset + 2] = vz * cos + (ax * vy - ay * vx) * sin + az * dot * (1 - cos);
}

function solveBend(
  state: XpbdClothState,
  constraint: XpbdBendConstraint,
  dt: number,
  gain: number,
  maxStep: number,
): void {
  const { positions, inverseMasses } = state;
  if (constraint.a === constraint.b) return;
  const wa = inverseMasses[constraint.a];
  const wb = inverseMasses[constraint.b];
  const wSum = wa + wb;
  if (wSum <= 0) return;

  const ao = constraint.a * 3;
  const bo = constraint.b * 3;

  if (Math.abs(constraint.targetAngle) > 1e-4) {
    // Angular mode: rotate the opposite vertices about the hinge toward the
    // target dihedral, split by inverse mass. A port of Seamer's kernel.
    const ho = constraint.hingeA * 3;
    const go = constraint.hingeB * 3;
    const hax = positions[ho];
    const hay = positions[ho + 1];
    const haz = positions[ho + 2];
    let ex = positions[go] - hax;
    let ey = positions[go + 1] - hay;
    let ez = positions[go + 2] - haz;
    const edgeLen = Math.hypot(ex, ey, ez);
    if (edgeLen < NORMAL_EPSILON) return;
    ex /= edgeLen;
    ey /= edgeLen;
    ez /= edgeLen;

    const p1hax = positions[ao] - hax;
    const p1hay = positions[ao + 1] - hay;
    const p1haz = positions[ao + 2] - haz;
    const p1hbx = positions[ao] - positions[go];
    const p1hby = positions[ao + 1] - positions[go + 1];
    const p1hbz = positions[ao + 2] - positions[go + 2];
    let n1x = p1hay * p1hbz - p1haz * p1hby;
    let n1y = p1haz * p1hbx - p1hax * p1hbz;
    let n1z = p1hax * p1hby - p1hay * p1hbx;
    const p2hbx = positions[bo] - positions[go];
    const p2hby = positions[bo + 1] - positions[go + 1];
    const p2hbz = positions[bo + 2] - positions[go + 2];
    const p2hax = positions[bo] - hax;
    const p2hay = positions[bo + 1] - hay;
    const p2haz = positions[bo + 2] - haz;
    let n2x = p2hby * p2haz - p2hbz * p2hay;
    let n2y = p2hbz * p2hax - p2hbx * p2haz;
    let n2z = p2hbx * p2hay - p2hby * p2hax;
    const n1Len = Math.hypot(n1x, n1y, n1z);
    const n2Len = Math.hypot(n2x, n2y, n2z);
    if (n1Len < NORMAL_EPSILON || n2Len < NORMAL_EPSILON) return;
    n1x /= n1Len;
    n1y /= n1Len;
    n1z /= n1Len;
    n2x /= n2Len;
    n2y /= n2Len;
    n2z /= n2Len;

    const crossX = n1y * n2z - n1z * n2y;
    const crossY = n1z * n2x - n1x * n2z;
    const crossZ = n1x * n2y - n1y * n2x;
    const sinPhi = crossX * ex + crossY * ey + crossZ * ez;
    const cosPhi = Math.min(1, Math.max(-1, n1x * n2x + n1y * n2y + n1z * n2z));
    // Seamer's shader applies the nudge with the opposite sign and relies on
    // the angle wrap to hold near −target; this kernel rotates the pair the
    // way that shrinks the error, so φ converges to the target itself.
    const phi = wrapAngle(Math.atan2(sinPhi, cosPhi));
    const error = wrapAngle(phi - constraint.targetAngle);
    const step = Math.min(maxStep, Math.max(-maxStep, error * gain));
    if (step === 0) return;

    const midX = hax + (positions[go] - hax) / 2;
    const midY = hay + (positions[go + 1] - hay) / 2;
    const midZ = haz + (positions[go + 2] - haz) / 2;
    if (wa > 0) {
      rotateInto(
        positions,
        ao,
        positions[ao] - midX,
        positions[ao + 1] - midY,
        positions[ao + 2] - midZ,
        ex,
        ey,
        ez,
        step * (wa / wSum),
      );
      positions[ao] += midX;
      positions[ao + 1] += midY;
      positions[ao + 2] += midZ;
    }
    if (wb > 0) {
      rotateInto(
        positions,
        bo,
        positions[bo] - midX,
        positions[bo + 1] - midY,
        positions[bo + 2] - midZ,
        ex,
        ey,
        ez,
        -step * (wb / wSum),
      );
      positions[bo] += midX;
      positions[bo + 1] += midY;
      positions[bo + 2] += midZ;
    }
    return;
  }

  // Distance mode: hold the opposite pair at rest separation, softer within
  // rest than beyond it.
  const dx = positions[ao] - positions[bo];
  const dy = positions[ao + 1] - positions[bo + 1];
  const dz = positions[ao + 2] - positions[bo + 2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-7) return;
  const compliance =
    dist > constraint.restLength ? constraint.complianceBeyond : constraint.compliance;
  const alphaTilde = compliance / (dt * dt);
  const c = dist - constraint.restLength;
  const deltaLambda = -(c + alphaTilde * constraint.lambda) / (wSum + alphaTilde);
  constraint.lambda += deltaLambda;
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  positions[ao] += wa * deltaLambda * nx;
  positions[ao + 1] += wa * deltaLambda * ny;
  positions[ao + 2] += wa * deltaLambda * nz;
  positions[bo] -= wb * deltaLambda * nx;
  positions[bo + 1] -= wb * deltaLambda * ny;
  positions[bo + 2] -= wb * deltaLambda * nz;
}

/**
 * Advance the cloth one frame: `substeps` × (integrate, `iterations` of
 * constraints, contacts, velocity update).
 */
export function stepXpbdCloth(
  state: XpbdClothState,
  constraints: readonly XpbdClothConstraint[],
  options: XpbdClothStepOptions,
): void {
  const substeps = Math.max(1, Math.round(options.substeps));
  const iterations = Math.max(1, Math.round(options.iterations));
  const dt = options.dt / substeps;
  const gravityY = options.gravityY ?? 0;
  const damping = Math.max(0, Math.min(1, options.damping));
  const gain = options.bendAngleGain ?? DEFAULT_BEND_GAIN;
  const maxStep = options.bendMaxStepRad ?? DEFAULT_BEND_MAX_STEP;
  const maxVelocity = options.maxVelocity ?? Number.POSITIVE_INFINITY;
  const gatherInterval = Math.max(
    1,
    Math.round(options.colliderGatherInterval ?? substeps),
  );
  const { positions, prevPositions, velocities, inverseMasses, count } = state;

  for (let substep = 0; substep < substeps; substep += 1) {
    if (options.collider && substep % gatherInterval === 0) {
      options.collider.gather(state);
    }

    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      prevPositions[offset] = positions[offset];
      prevPositions[offset + 1] = positions[offset + 1];
      prevPositions[offset + 2] = positions[offset + 2];
      if (inverseMasses[index] <= 0) continue;
      velocities[offset + 1] += gravityY * dt;
      velocities[offset] *= damping;
      velocities[offset + 1] *= damping;
      velocities[offset + 2] *= damping;
      const speed = Math.hypot(
        velocities[offset],
        velocities[offset + 1],
        velocities[offset + 2],
      );
      if (speed > maxVelocity) {
        const scale = maxVelocity / speed;
        velocities[offset] *= scale;
        velocities[offset + 1] *= scale;
        velocities[offset + 2] *= scale;
      }
      positions[offset] += velocities[offset] * dt;
      positions[offset + 1] += velocities[offset + 1] * dt;
      positions[offset + 2] += velocities[offset + 2] * dt;
    }

    for (const constraint of constraints) constraint.lambda = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const constraint of constraints) {
        if (constraint.kind === "distance") solveDistance(state, constraint, dt);
        else if (constraint.kind === "anchor") solveAnchor(state, constraint, dt);
        else solveBend(state, constraint, dt, gain, maxStep);
      }
      if (options.collider && options.colliderEveryIteration) {
        options.collider.apply(state);
      }
    }

    if (options.collider && !options.colliderEveryIteration) {
      options.collider.apply(state);
    }

    for (let index = 0; index < count; index += 1) {
      if (inverseMasses[index] <= 0) continue;
      const offset = index * 3;
      velocities[offset] = (positions[offset] - prevPositions[offset]) / dt;
      velocities[offset + 1] = (positions[offset + 1] - prevPositions[offset + 1]) / dt;
      velocities[offset + 2] = (positions[offset + 2] - prevPositions[offset + 2]) / dt;
    }
  }
}

export interface XpbdSettleOptions {
  /** Frames to run before giving up. */
  maxSteps?: number;
  /**
   * A frame that moves no particle farther than this counts as settled,
   * caller units.
   */
  restDisplacement?: number;
  /**
   * Called before each frame with the frame index. The continuation hook: a
   * caller folding something moves its anchor targets along the fold path
   * here, so the cloth sweeps through space and contact can catch it on the
   * way — rather than teleporting to an end pose it might already be
   * penetrating. Return false to keep the settle from stopping early (the
   * ramp is still moving even if the cloth momentarily is not).
   */
  onStep?: (step: number) => boolean | void;
}

export interface XpbdSettleResult {
  steps: number;
  settled: boolean;
  /** Largest single-particle displacement of the final frame. */
  maxDisplacement: number;
}

/**
 * Step until the cloth stops moving. Quasi-static: callers pass strong
 * damping and drive shape through constraint targets rather than forces.
 */
export function settleXpbdCloth(
  state: XpbdClothState,
  constraints: readonly XpbdClothConstraint[],
  options: XpbdClothStepOptions,
  settle: XpbdSettleOptions = {},
): XpbdSettleResult {
  const maxSteps = Math.max(1, settle.maxSteps ?? 240);
  const restDisplacement = settle.restDisplacement ?? 1e-4;
  const before = new Float32Array(state.positions.length);
  let maxDisplacement = Number.POSITIVE_INFINITY;

  for (let step = 0; step < maxSteps; step += 1) {
    const mayStop = settle.onStep?.(step) !== false;
    before.set(state.positions);
    stepXpbdCloth(state, constraints, options);
    maxDisplacement = 0;
    for (let index = 0; index < state.count; index += 1) {
      const offset = index * 3;
      const moved = Math.hypot(
        state.positions[offset] - before[offset],
        state.positions[offset + 1] - before[offset + 1],
        state.positions[offset + 2] - before[offset + 2],
      );
      if (moved > maxDisplacement) maxDisplacement = moved;
    }
    if (mayStop && maxDisplacement <= restDisplacement) {
      return { steps: step + 1, settled: true, maxDisplacement };
    }
  }
  return { steps: maxSteps, settled: false, maxDisplacement };
}
