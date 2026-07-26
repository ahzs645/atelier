import { describe, expect, it } from "vitest";
import {
  buildEdgeTopology,
  faceVertexLoop,
  orientFacesConsistently,
} from "./index";

function edgeDirection(loop: number[], a: number, b: number): number {
  for (let i = 0; i < loop.length; i += 1) {
    const from = loop[i];
    const to = loop[(i + 1) % loop.length];
    if (from === a && to === b) return 1;
    if (from === b && to === a) return -1;
  }
  return 0;
}

describe("face/edge topology", () => {
  it("builds unique edges and face adjacency", () => {
    const topology = buildEdgeTopology([
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ]);
    expect(topology.edgesVertices).toHaveLength(7);
    expect(topology.facesEdges).toHaveLength(2);
    const shared = topology.edgeFaces.findIndex((faces) => faces.length === 2);
    expect(shared).toBeGreaterThanOrEqual(0);
    expect(topology.edgeFaces[shared]).toEqual([0, 1]);
  });

  it("walks an unordered, inconsistently directed edge list into a vertex loop", () => {
    const edges: Array<[number, number]> = [
      [0, 1],
      [2, 1],
      [3, 2],
      [0, 3],
    ];
    expect(faceVertexLoop([0, 2, 1, 3], edges)).toEqual([0, 1, 2, 3]);
  });

  it("orients connected faces to traverse shared edges oppositely", () => {
    const topology = buildEdgeTopology([
      [0, 1, 2, 3],
      [1, 2, 5, 4],
    ]);
    orientFacesConsistently(topology, 0);
    const shared = topology.edgeFaces.findIndex((faces) => faces.length === 2);
    const [a, b] = topology.edgesVertices[shared];
    expect(edgeDirection(topology.facesVertices[0], a, b)).toBe(
      -edgeDirection(topology.facesVertices[1], a, b),
    );
  });
});
