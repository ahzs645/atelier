/// <reference types="@webgpu/types" />

export {
  isWebGPUAvailable,
  requestDevice,
  webgpuUnavailableReason,
} from "./device";
export { SolverRunner } from "./runner";
export type {
  SolverContext,
  SolverHandle,
  SolverPlugin,
} from "./runner";
export {
  createSolveHost,
  SolveHostDisposed,
  SolveSuperseded,
} from "./steady";
export type {
  SolveHost,
  SolveHostOptions,
  SolvePluginHostOptions,
  SteadySolverPlugin,
  SteadySolverSession,
} from "./steady";
export {
  garmentParticleCount,
  validatePreparedGarment,
} from "./garment";
export type {
  GarmentCollider,
  GarmentConstraint,
  GarmentConstraintRange,
  GarmentParticles,
  GarmentPiece,
  GarmentSolverState,
  PreparedGarment,
} from "./garment";
export {
  createWorkerSteadySolverPlugin,
  serveSteadySolverPlugin,
} from "./worker";
export {
  createAnchorConstraint,
  createBendConstraint,
  createClothState,
  createDistanceConstraint,
  dihedralAngle,
  settleXpbdCloth,
  stepXpbdCloth,
} from "./xpbdCloth";
export type {
  XpbdAnchorConstraint,
  XpbdBendConstraint,
  XpbdClothConstraint,
  XpbdClothState,
  XpbdClothStepOptions,
  XpbdCollider,
  XpbdDistanceConstraint,
  XpbdSettleOptions,
  XpbdSettleResult,
} from "./xpbdCloth";
export {
  assignCreaseTargets,
  buildClothConstraints,
  creaseChainPose,
  creasePose,
} from "./xpbdMesh";
export type {
  ClothConstraintOptions,
  ClothConstraintSet,
  ClothMeshInput,
  CreaseFold,
} from "./xpbdMesh";
export { createTriangleCollider } from "./xpbdCollision";
export type {
  TriangleCollisionConfig,
  TriangleCollisionParams,
} from "./xpbdCollision";
export type {
  ServeSteadySolverOptions,
  SolveWorker,
  SolveWorkerClientMessage,
  SolveWorkerScope,
  SolveWorkerServerMessage,
  WorkerSteadySolverPluginOptions,
} from "./worker";
