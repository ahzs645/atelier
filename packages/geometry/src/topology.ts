export interface EdgeTopology {
  edgesVertices: Array<[number, number]>;
  facesEdges: number[][];
  facesVertices: number[][];
  edgeFaces: number[][];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function buildEdgeTopology(facesVertices: number[][]): EdgeTopology {
  const edgesVertices: Array<[number, number]> = [];
  const facesEdges: number[][] = [];
  const edgeFaces: number[][] = [];
  const edgeIndex = new Map<string, number>();
  facesVertices.forEach((face, faceIndex) => {
    const faceEdges: number[] = [];
    for (let i = 0; i < face.length; i += 1) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      let index = edgeIndex.get(key);
      if (index === undefined) {
        index = edgesVertices.length;
        edgeIndex.set(key, index);
        edgesVertices.push([a, b]);
        edgeFaces.push([]);
      }
      faceEdges.push(index);
      edgeFaces[index].push(faceIndex);
    }
    facesEdges.push(faceEdges);
  });
  return {
    edgesVertices,
    facesEdges,
    facesVertices: facesVertices.map((face) => face.slice()),
    edgeFaces,
  };
}

/** Derive an ordered vertex loop for a face from an arbitrarily directed edge list. */
export function faceVertexLoop(
  faceEdges: number[],
  edgesVertices: Array<[number, number]>,
): number[] {
  if (faceEdges.length === 0) return [];
  const first = edgesVertices[faceEdges[0]];
  if (!first) return [];
  const loop = [first[0], first[1]];
  const used = new Set<number>([faceEdges[0]]);
  let current = first[1];
  while (used.size < faceEdges.length) {
    let advanced = false;
    for (const edgeIndex of faceEdges) {
      if (used.has(edgeIndex)) continue;
      const edge = edgesVertices[edgeIndex];
      if (!edge) continue;
      const [a, b] = edge;
      if (a === current || b === current) {
        current = a === current ? b : a;
        loop.push(current);
        used.add(edgeIndex);
        advanced = true;
        break;
      }
    }
    if (!advanced) break; // open/degenerate face; preserve the useful partial walk
  }
  if (loop.length > 1 && loop[loop.length - 1] === loop[0]) loop.pop();
  return loop;
}

/** +1 for a→b, -1 for b→a, 0 when the vertices are not adjacent in the loop. */
function loopEdgeDirection(loop: number[], a: number, b: number): number {
  for (let i = 0; i < loop.length; i += 1) {
    const from = loop[i];
    const to = loop[(i + 1) % loop.length];
    if (from === a && to === b) return 1;
    if (from === b && to === a) return -1;
  }
  return 0;
}

/**
 * Make connected face windings consistent by BFS from `seedFace`: every shared
 * edge is traversed in opposite directions by its two incident faces.
 */
export function orientFacesConsistently(topo: EdgeTopology, seedFace: number): void {
  if (seedFace < 0 || seedFace >= topo.facesVertices.length) return;
  const seen = new Array<boolean>(topo.facesVertices.length).fill(false);
  const queue = [seedFace];
  seen[seedFace] = true;
  while (queue.length > 0) {
    const faceIndex = queue.shift();
    if (faceIndex === undefined) break;
    const loop = topo.facesVertices[faceIndex];
    for (const edgeIndex of topo.facesEdges[faceIndex]) {
      const edge = topo.edgesVertices[edgeIndex];
      if (!edge) continue;
      const direction = loopEdgeDirection(loop, edge[0], edge[1]);
      for (const neighbor of topo.edgeFaces[edgeIndex] ?? []) {
        if (neighbor === faceIndex || seen[neighbor]) continue;
        const neighborLoop = topo.facesVertices[neighbor];
        const neighborDirection = loopEdgeDirection(neighborLoop, edge[0], edge[1]);
        if (direction !== 0 && neighborDirection === direction) neighborLoop.reverse();
        seen[neighbor] = true;
        queue.push(neighbor);
      }
    }
  }
}
