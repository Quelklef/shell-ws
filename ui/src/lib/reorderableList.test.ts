import { describe, expect, it } from "vitest";

import { reorderItemsWithPlacement } from "./reorderableList";

describe("reorderableList", () => {
  it("moves items before or after a target", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reorderItemsWithPlacement(items, "c", "a", "before").map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(reorderItemsWithPlacement(items, "a", "c", "after").map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("leaves the list unchanged for invalid moves", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(reorderItemsWithPlacement(items, "a", "a", "before").map((item) => item.id)).toEqual(["a", "b"]);
    expect(reorderItemsWithPlacement(items, "z", "a", "before").map((item) => item.id)).toEqual(["a", "b"]);
  });
});
