import { describe, expect, it } from "vitest";

import { selectionRectToFlowRect } from "./selectionRect";

describe("selectionRectToFlowRect", () => {
  it("converts pane-space selection rectangles into flow-space rectangles", () => {
    expect(
      selectionRectToFlowRect(
        { x: 110, y: 220, width: 60, height: 40 },
        [10, 20, 2],
      ),
    ).toEqual({ x: 50, y: 100, width: 30, height: 20 });
  });
});
