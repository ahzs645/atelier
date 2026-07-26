export {
  add,
  cross,
  dist,
  dot,
  len,
  lerp,
  normalize,
  rotate,
  scale,
  sub,
} from "./vec2";
export type {
  Bounds2,
  Polygon,
  Polyline,
  Transform2,
  Vec2,
} from "./vec2";

export {
  cubicAt,
  cubicLength,
  cubicTangentAt,
  flattenCubic,
} from "./curves";
export type { CubicSegment } from "./curves";

export { arcToPolyline, threePointArc } from "./arcs";
export type { Arc } from "./arcs";

export {
  applyCornerJoins,
  bounds,
  boundsUnion,
  convexHull,
  offsetPolygon,
  offsetPolygonVariable,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polylineLength,
  reflectAcrossLine,
  resamplePolyline,
  simplifyPolyline,
} from "./polygon";
export type { CornerJoin } from "./polygon";

export {
  meshDiagonals,
  triangulate,
  triangulateFace,
} from "./triangulate";
export type { TriangulateInput, TriMesh } from "./triangulate";

export {
  buildEdgeTopology,
  faceVertexLoop,
  orientFacesConsistently,
} from "./topology";
export type { EdgeTopology } from "./topology";

export { nest } from "./nest";
export type { NestOptions, NestPlacement } from "./nest";

export { buildWarp } from "./thinPlateSpline";
export type { MatchPair } from "./thinPlateSpline";
