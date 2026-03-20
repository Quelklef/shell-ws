import { describe, expect, it } from "vitest";

import { chooseNodePosition, type PlacementRect } from "./nodePlacement";

function rect(x: number, y: number, width = 320, height = 220): PlacementRect {
  return { position: { x, y }, size: { width, height } };
}

describe("chooseNodePosition", () => {
  it("keeps a centered placement when the area is free", () => {
    expect(chooseNodePosition({ x: 100, y: 120 }, { width: 320, height: 220 }, [])).toEqual({
      x: 100,
      y: 120,
    });
  });

  it("moves a new node away from an occupied placement", () => {
    const next = chooseNodePosition(
      { x: 100, y: 120 },
      { width: 320, height: 220 },
      [rect(100, 120)],
    );

    expect(next).not.toEqual({ x: 100, y: 120 });
  });

  it("avoids stacking repeated additions at the same desired position", () => {
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
  });
});
