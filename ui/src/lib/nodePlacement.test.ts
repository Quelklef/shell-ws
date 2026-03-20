import { describe, expect, it } from "vitest";

import { chooseNodePosition, type PlacementRect } from "./nodePlacement";

function rect(x: number, y: number, width = 320, height = 220): PlacementRect {
  return { position: { x, y }, size: { width, height } };
}

describe("chooseNodePosition", () => {
  it("keeps a centered placement when nearby edges are already clear", () => {
    expect(chooseNodePosition({ x: 100, y: 120 }, { width: 320, height: 220 }, [])).toEqual({
      x: 100,
      y: 120,
    });
  });

  it("nudges only enough to clear parallel edges", () => {
    const next = chooseNodePosition(
      { x: 100, y: 120 },
      { width: 320, height: 220 },
      [rect(100, 120)],
    );

    expect(next).not.toEqual({ x: 100, y: 120 });
    expect(Math.abs(next.x - 100) + Math.abs(next.y - 120)).toBe(40);
  });

  it("keeps repeated additions distinct without large jumps", () => {
    const existing: PlacementRect[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < 4; index += 1) {
      const position = chooseNodePosition(
        { x: 100, y: 120 },
        { width: 320, height: 220 },
        existing,
      );
      seen.add(`${position.x},${position.y}`);
      existing.push(rect(position.x, position.y));
    }

    expect(seen.size).toBe(4);
    for (const item of existing) {
      expect(Math.abs(item.position.x - 100) + Math.abs(item.position.y - 120)).toBeLessThanOrEqual(80);
    }
  });
});
