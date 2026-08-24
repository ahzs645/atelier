/**
 * Triangle self-collision for the CPU XPBD cloth: a counting-sort spatial
 * hash over triangle centroids, a per-particle near-triangle gather, and an
 * edge + face contact resolve. A CPU port of Seamer's GPU self-collision
 * pipeline, which is itself the original SeamScape engine's.
 *
 * Everything collides through one collider: cloth against itself, and cloth
 * against anything rigid, because a rigid obstacle is just triangles over
 * pinned particles (inverse mass 0) in the same arrays. Contacts still read
 * those particles' positions; they simply never move.
 *
 * The rest-space filter is what keeps a cloth from colliding with its own
 * immediate neighbourhood: a triangle is skipped when any of its vertices sits
 * within `restMinDistance` of the particle in rest space. Bodies that should
 * always collide (obstacles) get rest positions far from the cloth's.
 */

import type { XpbdClothState, XpbdCollider } from "./xpbdCloth";

export interface TriangleCollisionConfig {
  /** Contact offset for face contacts — how far a particle stays off a face. */
  thickness: number;
  /** Contact offset around triangle edges. Defaults to `thickness`. */
  edgeThickness?: number;
  /** Coulomb-style friction on contact corrections. Default 0. */
  friction?: number;
  /** Spatial-hash cell size. Defaults to 4 × thickness. */
  cellSpacing?: number;
  /** Gather radius around each particle. Defaults to 2 × thickness. */
  searchRadius?: number;
  /**
   * Rest-space neighbourhood exclusion. Defaults to 3 × the search radius;
   * 0 disables the filter entirely.
   */
  restMinDistance?: number;
  /** Candidate triangles kept per particle. Default 16. */
  maxContactsPerParticle?: number;
  /** Hash table size = multiplier × triangle count + 1. Default 5. */
  hashTableMultiplier?: number;
}

export interface TriangleCollisionParams {
  /** Vertex index triplets over the state's particles. */
  triangles: ArrayLike<number>;
  /**
   * xy per particle, rest space, for the neighbourhood filter. Omit to
   * disable the filter (every non-incident triangle is a candidate).
   */
  restPositions?: ArrayLike<number>;
  /** Collision layer per particle; a particle ignores higher-layer triangles. */
  particleLayers?: ArrayLike<number>;
  /** Collision layer per triangle. Default: all 0. */
  triangleLayers?: ArrayLike<number>;
  /** +1/−1 per triangle: outward face sign for cross-layer contacts. */
  triangleOutsideSign?: ArrayLike<number>;
  /** Exclude a particle from gathering contacts (e.g. seam-welded ones). */
  skipParticle?: (index: number) => boolean;
  config: TriangleCollisionConfig;
}

const EPSILON = 1e-9;

function hashCoords(xi: number, yi: number, zi: number, size: number): number {
  const h =
    (Math.imul(xi, 92837111) ^ Math.imul(yi, 689287499) ^ Math.imul(zi, 283923481)) | 0;
  return Math.abs(h) % size;
}

/**
 * Closest point on triangle (p0, p1, p2) to `point` — Eberly's region walk.
 *
 * Note the difference vector is `p0 − point`, the way Eberly's derivation
 * needs it. Seamer's WGSL port flipped it to `point − p0` while keeping the
 * rest, which negates the interior solve and sends centre-of-face queries to
 * a vertex; this port restores the original.
 */
function closestPointOnTriangle(
  p0x: number, p0y: number, p0z: number,
  p1x: number, p1y: number, p1z: number,
  p2x: number, p2y: number, p2z: number,
  px: number, py: number, pz: number,
  out: Float64Array,
): void {
  const e0x = p1x - p0x, e0y = p1y - p0y, e0z = p1z - p0z;
  const e1x = p2x - p0x, e1y = p2y - p0y, e1z = p2z - p0z;
  const v0x = p0x - px, v0y = p0y - py, v0z = p0z - pz;
  const a = e0x * e0x + e0y * e0y + e0z * e0z;
  const b = e0x * e1x + e0y * e1y + e0z * e1z;
  const c = e1x * e1x + e1y * e1y + e1z * e1z;
  const d = e0x * v0x + e0y * v0y + e0z * v0z;
  const e = e1x * v0x + e1y * v0y + e1z * v0z;
  const det = a * c - b * b;
  let s = b * e - c * d;
  let t = b * d - a * e;
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  if (s + t < det) {
    if (s < 0) {
      if (t < 0) {
        if (d < 0) {
          s = clamp01(-d / a);
          t = 0;
        } else {
          s = 0;
          t = clamp01(-e / c);
        }
      } else {
        s = 0;
        t = clamp01(-e / c);
      }
    } else if (t < 0) {
      s = clamp01(-d / a);
      t = 0;
    } else {
      const invDet = 1 / det;
      s *= invDet;
      t *= invDet;
    }
  } else if (s < 0) {
    const tmp0 = b + d;
    const tmp1 = c + e;
    if (tmp1 > tmp0) {
      s = clamp01((tmp1 - tmp0) / (a - 2 * b + c));
      t = 1 - s;
    } else {
      t = clamp01(-e / c);
      s = 0;
    }
  } else if (t < 0) {
    if (a + d > b + e) {
      s = clamp01((c + e - b - d) / (a - 2 * b + c));
      t = 1 - s;
    } else {
      s = clamp01(-e / c);
      t = 0;
    }
  } else {
    s = clamp01((c + e - b - d) / (a - 2 * b + c));
    t = 1 - s;
  }
  out[0] = p0x + s * e0x + t * e1x;
  out[1] = p0y + s * e0y + t * e1y;
  out[2] = p0z + s * e0z + t * e1z;
}

export function createTriangleCollider(params: TriangleCollisionParams): XpbdCollider {
  const triangles = Uint32Array.from(params.triangles as ArrayLike<number>);
  const triangleCount = Math.floor(triangles.length / 3);
  const config = params.config;
  const thickness = config.thickness;
  const edgeThickness = config.edgeThickness ?? thickness;
  const friction = config.friction ?? 0;
  const cellSpacing = config.cellSpacing ?? thickness * 4;
  const searchRadius = config.searchRadius ?? thickness * 2;
  const restMinDistance = config.restMinDistance ?? searchRadius * 3;
  const maxContacts = Math.max(1, config.maxContactsPerParticle ?? 16);
  const hashTableSize = Math.max(
    1,
    Math.floor((config.hashTableMultiplier ?? 5) * triangleCount) + 1,
  );
  const restPositions = params.restPositions
    ? Float32Array.from(params.restPositions as ArrayLike<number>)
    : null;
  const particleLayers = params.particleLayers
    ? Uint32Array.from(params.particleLayers as ArrayLike<number>)
    : null;
  const triangleLayers = params.triangleLayers
    ? Uint32Array.from(params.triangleLayers as ArrayLike<number>)
    : null;
  const outsideSign = params.triangleOutsideSign
    ? Float32Array.from(params.triangleOutsideSign as ArrayLike<number>)
    : null;
  const skipParticle = params.skipParticle;

  // Triangle AABBs, xyz min then xyz max. Hashing the whole box — not the
  // centroid, as the GPU original does — is what lets one large rigid face
  // collide correctly; a centroid hash only ever finds triangles about the
  // size of a cell.
  const triangleBounds = new Float32Array(triangleCount * 6);
  const cellStart = new Int32Array(hashTableSize + 1);
  const cellCursor = new Int32Array(hashTableSize);
  let sortedTriangles = new Int32Array(0);
  // Near list per particle: 0 = empty, ±(triangleIndex + 2); the sign is the
  // side of the face the particle was on at gather time.
  let nearTriangles = new Int32Array(0);
  let corrections = new Float32Array(0);
  const closest = new Float64Array(3);

  const cellIndex = (coord: number): number => Math.floor(coord / cellSpacing);
  const restFar = (particle: number, vertex: number): boolean => {
    if (!restPositions || restMinDistance <= 0) return true;
    const dx = restPositions[vertex * 2] - restPositions[particle * 2];
    const dy = restPositions[vertex * 2 + 1] - restPositions[particle * 2 + 1];
    return dx * dx + dy * dy >= restMinDistance * restMinDistance;
  };

  const gather = (state: XpbdClothState): void => {
    const { positions, count } = state;
    if (nearTriangles.length !== count * maxContacts) {
      nearTriangles = new Int32Array(count * maxContacts);
      corrections = new Float32Array(count * 3);
    }
    nearTriangles.fill(0);
    if (triangleCount === 0) return;

    for (let t = 0; t < triangleCount; t += 1) {
      const a = triangles[t * 3] * 3;
      const b = triangles[t * 3 + 1] * 3;
      const c = triangles[t * 3 + 2] * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        triangleBounds[t * 6 + axis] = Math.min(
          positions[a + axis],
          positions[b + axis],
          positions[c + axis],
        );
        triangleBounds[t * 6 + 3 + axis] = Math.max(
          positions[a + axis],
          positions[b + axis],
          positions[c + axis],
        );
      }
    }

    // Counting sort of (triangle, cell) entries over every cell each
    // triangle's box overlaps.
    cellStart.fill(0);
    let entryCount = 0;
    for (let t = 0; t < triangleCount; t += 1) {
      const x0 = cellIndex(triangleBounds[t * 6]);
      const y0 = cellIndex(triangleBounds[t * 6 + 1]);
      const z0 = cellIndex(triangleBounds[t * 6 + 2]);
      const x1 = cellIndex(triangleBounds[t * 6 + 3]);
      const y1 = cellIndex(triangleBounds[t * 6 + 4]);
      const z1 = cellIndex(triangleBounds[t * 6 + 5]);
      for (let xi = x0; xi <= x1; xi += 1) {
        for (let yi = y0; yi <= y1; yi += 1) {
          for (let zi = z0; zi <= z1; zi += 1) {
            cellStart[hashCoords(xi, yi, zi, hashTableSize) + 1] += 1;
            entryCount += 1;
          }
        }
      }
    }
    for (let i = 0; i < hashTableSize; i += 1) cellStart[i + 1] += cellStart[i];
    for (let i = 0; i < hashTableSize; i += 1) cellCursor[i] = cellStart[i];
    if (sortedTriangles.length < entryCount) sortedTriangles = new Int32Array(entryCount);
    for (let t = 0; t < triangleCount; t += 1) {
      const x0 = cellIndex(triangleBounds[t * 6]);
      const y0 = cellIndex(triangleBounds[t * 6 + 1]);
      const z0 = cellIndex(triangleBounds[t * 6 + 2]);
      const x1 = cellIndex(triangleBounds[t * 6 + 3]);
      const y1 = cellIndex(triangleBounds[t * 6 + 4]);
      const z1 = cellIndex(triangleBounds[t * 6 + 5]);
      for (let xi = x0; xi <= x1; xi += 1) {
        for (let yi = y0; yi <= y1; yi += 1) {
          for (let zi = z0; zi <= z1; zi += 1) {
            const h = hashCoords(xi, yi, zi, hashTableSize);
            sortedTriangles[cellCursor[h]] = t;
            cellCursor[h] += 1;
          }
        }
      }
    }

    for (let index = 0; index < count; index += 1) {
      if (skipParticle?.(index)) continue;
      const px = positions[index * 3];
      const py = positions[index * 3 + 1];
      const pz = positions[index * 3 + 2];
      const x0 = cellIndex(px - searchRadius);
      const y0 = cellIndex(py - searchRadius);
      const z0 = cellIndex(pz - searchRadius);
      const x1 = cellIndex(px + searchRadius);
      const y1 = cellIndex(py + searchRadius);
      const z1 = cellIndex(pz + searchRadius);
      let found = 0;
      outer: for (let xi = x0; xi <= x1; xi += 1) {
        for (let yi = y0; yi <= y1; yi += 1) {
          for (let zi = z0; zi <= z1; zi += 1) {
            const h = hashCoords(xi, yi, zi, hashTableSize);
            for (let slot = cellStart[h]; slot < cellStart[h + 1]; slot += 1) {
              const tri = sortedTriangles[slot];
              if (
                px < triangleBounds[tri * 6] - searchRadius ||
                py < triangleBounds[tri * 6 + 1] - searchRadius ||
                pz < triangleBounds[tri * 6 + 2] - searchRadius ||
                px > triangleBounds[tri * 6 + 3] + searchRadius ||
                py > triangleBounds[tri * 6 + 4] + searchRadius ||
                pz > triangleBounds[tri * 6 + 5] + searchRadius
              ) {
                continue;
              }
              const v0 = triangles[tri * 3];
              const v1 = triangles[tri * 3 + 1];
              const v2 = triangles[tri * 3 + 2];
              if (v0 === index || v1 === index || v2 === index) continue;
              // Different cells can alias to one hash bucket, so the same
              // triangle can come around again — a duplicate contact would
              // double its correction.
              let duplicate = false;
              for (let seen = 0; seen < found; seen += 1) {
                const entry = nearTriangles[index * maxContacts + seen];
                if (entry === tri + 2 || entry === -(tri + 2)) {
                  duplicate = true;
                  break;
                }
              }
              if (duplicate) continue;
              if (!restFar(index, v0) || !restFar(index, v1) || !restFar(index, v2)) {
                continue;
              }
              const nx =
                (positions[v1 * 3 + 1] - positions[v0 * 3 + 1]) *
                  (positions[v2 * 3 + 2] - positions[v0 * 3 + 2]) -
                (positions[v1 * 3 + 2] - positions[v0 * 3 + 2]) *
                  (positions[v2 * 3 + 1] - positions[v0 * 3 + 1]);
              const ny =
                (positions[v1 * 3 + 2] - positions[v0 * 3 + 2]) *
                  (positions[v2 * 3] - positions[v0 * 3]) -
                (positions[v1 * 3] - positions[v0 * 3]) *
                  (positions[v2 * 3 + 2] - positions[v0 * 3 + 2]);
              const nz =
                (positions[v1 * 3] - positions[v0 * 3]) *
                  (positions[v2 * 3 + 1] - positions[v0 * 3 + 1]) -
                (positions[v1 * 3 + 1] - positions[v0 * 3 + 1]) *
                  (positions[v2 * 3] - positions[v0 * 3]);
              const side =
                (px - positions[v0 * 3]) * nx +
                (py - positions[v0 * 3 + 1]) * ny +
                (pz - positions[v0 * 3 + 2]) * nz;
              nearTriangles[index * maxContacts + found] =
                side < 0 ? -(tri + 2) : tri + 2;
              found += 1;
              if (found >= maxContacts) break outer;
            }
          }
        }
      }
    }
  };

  const applyFriction = (
    correction: Float64Array,
    normalX: number, normalY: number, normalZ: number,
    penetration: number,
    particleDeltaX: number, particleDeltaY: number, particleDeltaZ: number,
    surfaceDeltaX: number, surfaceDeltaY: number, surfaceDeltaZ: number,
  ): void => {
    if (friction <= 0 || penetration <= 0) return;
    const relX = particleDeltaX - surfaceDeltaX;
    const relY = particleDeltaY - surfaceDeltaY;
    const relZ = particleDeltaZ - surfaceDeltaZ;
    const normalDot = relX * normalX + relY * normalY + relZ * normalZ;
    const tx = relX - normalX * normalDot;
    const ty = relY - normalY * normalDot;
    const tz = relZ - normalZ * normalDot;
    const tLen = Math.hypot(tx, ty, tz);
    if (tLen <= 1e-6) return;
    const maxF = friction * penetration;
    const scale = -Math.min(tLen, maxF) / tLen;
    correction[0] += tx * scale;
    correction[1] += ty * scale;
    correction[2] += tz * scale;
  };

  const apply = (state: XpbdClothState): void => {
    const { positions, prevPositions, inverseMasses, count } = state;
    if (nearTriangles.length !== count * maxContacts || triangleCount === 0) return;
    corrections.fill(0);
    const correction = new Float64Array(3);

    for (let index = 0; index < count; index += 1) {
      if (inverseMasses[index] <= 0) continue;
      const px = positions[index * 3];
      const py = positions[index * 3 + 1];
      const pz = positions[index * 3 + 2];
      const pdx = px - prevPositions[index * 3];
      const pdy = py - prevPositions[index * 3 + 1];
      const pdz = pz - prevPositions[index * 3 + 2];
      const particleLayer = particleLayers ? particleLayers[index] : 0;

      for (let slot = 0; slot < maxContacts; slot += 1) {
        let encoded = nearTriangles[index * maxContacts + slot];
        if (encoded === 0) break;
        let sideness = 1;
        if (encoded < 0) {
          encoded = -encoded;
          sideness = -1;
        }
        const tri = encoded - 2;
        const triangleLayer = triangleLayers ? triangleLayers[tri] : 0;
        if (particleLayer < triangleLayer) continue;
        const sameLayer = particleLayer === triangleLayer;
        const v0 = triangles[tri * 3];
        const v1 = triangles[tri * 3 + 1];
        const v2 = triangles[tri * 3 + 2];
        const p0x = positions[v0 * 3], p0y = positions[v0 * 3 + 1], p0z = positions[v0 * 3 + 2];
        const p1x = positions[v1 * 3], p1y = positions[v1 * 3 + 1], p1z = positions[v1 * 3 + 2];
        const p2x = positions[v2 * 3], p2y = positions[v2 * 3 + 1], p2z = positions[v2 * 3 + 2];
        const d0x = p0x - prevPositions[v0 * 3];
        const d0y = p0y - prevPositions[v0 * 3 + 1];
        const d0z = p0z - prevPositions[v0 * 3 + 2];
        const d1x = p1x - prevPositions[v1 * 3];
        const d1y = p1y - prevPositions[v1 * 3 + 1];
        const d1z = p1z - prevPositions[v1 * 3 + 2];
        const d2x = p2x - prevPositions[v2 * 3];
        const d2y = p2y - prevPositions[v2 * 3 + 1];
        const d2z = p2z - prevPositions[v2 * 3 + 2];

        // Edge contacts: keep the particle `edgeThickness` off each edge.
        const edge = (
          ax: number, ay: number, az: number,
          bx: number, by: number, bz: number,
          adx: number, ady: number, adz: number,
          bdx: number, bdy: number, bdz: number,
        ): void => {
          const ex = bx - ax, ey = by - ay, ez = bz - az;
          const lenSq = ex * ex + ey * ey + ez * ez;
          if (lenSq < EPSILON) return;
          const len = Math.sqrt(lenSq);
          const projection = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len;
          const clamped = Math.min(len, Math.max(0, projection));
          const cx = ax + (ex / len) * clamped;
          const cy = ay + (ey / len) * clamped;
          const cz = az + (ez / len) * clamped;
          const dx = px - cx, dy = py - cy, dz = pz - cz;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq >= edgeThickness * edgeThickness) return;
          const dist = Math.sqrt(distSq);
          if (dist < EPSILON) return;
          const penetration = edgeThickness - dist;
          if (penetration <= 0) return;
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          correction[0] = nx * 0.5 * penetration;
          correction[1] = ny * 0.5 * penetration;
          correction[2] = nz * 0.5 * penetration;
          const tt = clamped / len;
          applyFriction(
            correction,
            nx, ny, nz,
            penetration,
            pdx, pdy, pdz,
            adx * (1 - tt) + bdx * tt,
            ady * (1 - tt) + bdy * tt,
            adz * (1 - tt) + bdz * tt,
          );
          corrections[index * 3] += correction[0];
          corrections[index * 3 + 1] += correction[1];
          corrections[index * 3 + 2] += correction[2];
        };
        edge(p0x, p0y, p0z, p1x, p1y, p1z, d0x, d0y, d0z, d1x, d1y, d1z);
        edge(p1x, p1y, p1z, p2x, p2y, p2z, d1x, d1y, d1z, d2x, d2y, d2z);
        edge(p2x, p2y, p2z, p0x, p0y, p0z, d2x, d2y, d2z, d0x, d0y, d0z);

        // Face contact: keep the particle `thickness` off the face, on the
        // side it was gathered on (same layer) or the outward side (layers).
        const normalFactor = sameLayer ? sideness : (outsideSign ? outsideSign[tri] : 1);
        let nx =
          (p1y - p0y) * (p2z - p0z) - (p1z - p0z) * (p2y - p0y);
        let ny =
          (p1z - p0z) * (p2x - p0x) - (p1x - p0x) * (p2z - p0z);
        let nz =
          (p1x - p0x) * (p2y - p0y) - (p1y - p0y) * (p2x - p0x);
        const nLen = Math.hypot(nx, ny, nz);
        if (nLen < 1e-4) continue;
        nx = (nx / nLen) * normalFactor;
        ny = (ny / nLen) * normalFactor;
        nz = (nz / nLen) * normalFactor;
        const planeDist = (px - p0x) * nx + (py - p0y) * ny + (pz - p0z) * nz;
        if (planeDist >= thickness) continue;
        closestPointOnTriangle(p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, px, py, pz, closest);
        const dx = px - closest[0], dy = py - closest[1], dz = pz - closest[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        let dirX: number;
        let dirY: number;
        let dirZ: number;
        let penetration: number;
        if (planeDist < 0 && distSq <= planeDist * planeDist * 1.0001 + EPSILON) {
          // The particle is through the face, on the wrong side of the plane
          // for where it was gathered. Pushing away from the closest point —
          // the only move Seamer's shader knows — would push it deeper; the
          // gathered side is the memory of where it came from, so push it
          // back through along the face normal.
          penetration = thickness - planeDist;
          dirX = nx;
          dirY = ny;
          dirZ = nz;
        } else {
          if (distSq >= thickness * thickness) continue;
          const dist = Math.sqrt(distSq);
          if (dist < EPSILON) continue;
          penetration = thickness - dist;
          if (penetration <= 0) continue;
          dirX = dx / dist;
          dirY = dy / dist;
          dirZ = dz / dist;
        }
        correction[0] = dirX * 0.5 * penetration;
        correction[1] = dirY * 0.5 * penetration;
        correction[2] = dirZ * 0.5 * penetration;
        if (friction > 0) {
          // Barycentric surface velocity at the contact point.
          const e0x = p1x - p0x, e0y = p1y - p0y, e0z = p1z - p0z;
          const e1x = p2x - p0x, e1y = p2y - p0y, e1z = p2z - p0z;
          const wx = closest[0] - p0x, wy = closest[1] - p0y, wz = closest[2] - p0z;
          const d00 = e0x * e0x + e0y * e0y + e0z * e0z;
          const d01 = e0x * e1x + e0y * e1y + e0z * e1z;
          const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
          const d20 = wx * e0x + wy * e0y + wz * e0z;
          const d21 = wx * e1x + wy * e1y + wz * e1z;
          const denom = d00 * d11 - d01 * d01;
          let bv = 0;
          let bw = 0;
          if (Math.abs(denom) > 1e-8) {
            bv = (d11 * d20 - d01 * d21) / denom;
            bw = (d00 * d21 - d01 * d20) / denom;
          }
          const bu = 1 - bv - bw;
          applyFriction(
            correction,
            dirX, dirY, dirZ,
            penetration,
            pdx, pdy, pdz,
            d0x * bu + d1x * bv + d2x * bw,
            d0y * bu + d1y * bv + d2y * bw,
            d0z * bu + d1z * bv + d2z * bw,
          );
        }
        corrections[index * 3] += correction[0];
        corrections[index * 3 + 1] += correction[1];
        corrections[index * 3 + 2] += correction[2];
      }
    }

    for (let index = 0; index < count; index += 1) {
      if (inverseMasses[index] <= 0) continue;
      positions[index * 3] += corrections[index * 3];
      positions[index * 3 + 1] += corrections[index * 3 + 1];
      positions[index * 3 + 2] += corrections[index * 3 + 2];
    }
  };

  return { gather, apply };
}
