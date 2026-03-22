import { describe, expect, test } from "vitest";

import {
  selectionSupportsPreviewCategory,
  togglePreviewCategoryForSelection,
  type PreviewToggleNode,
} from "./selectionPreviewTabs";

function makeNode(partial: Partial<PreviewToggleNode>): PreviewToggleNode {
  return {
    id: partial.id ?? "node-1",
    previewTabs: partial.previewTabs ?? [],
    openPreviewTabs: partial.openPreviewTabs ?? [],
  };
}

describe("togglePreviewCategoryForSelection", () => {
  test("opens a preview category across selected nodes that support it", () => {
    const next = togglePreviewCategoryForSelection(
      [
        makeNode({ id: "a", previewTabs: ["stdin", "stdout"], openPreviewTabs: [] }),
        makeNode({ id: "b", previewTabs: ["stdout"], openPreviewTabs: [] }),
      ],
      "stdout",
    );
    expect(next.get("a")).toEqual(["stdout"]);
    expect(next.get("b")).toEqual(["stdout"]);
  });

  test("closes a preview category when all relevant nodes already have it open", () => {
    const next = togglePreviewCategoryForSelection(
      [
        makeNode({ id: "a", previewTabs: ["stdout"], openPreviewTabs: ["stdout", "stderr"] }),
        makeNode({ id: "b", previewTabs: ["stdout"], openPreviewTabs: ["stdout"] }),
      ],
      "stdout",
    );
    expect(next.get("a")).toEqual(["stderr"]);
    expect(next.get("b")).toEqual([]);
  });

  test("toggles all argv tabs together", () => {
    const next = togglePreviewCategoryForSelection(
      [makeNode({ id: "a", previewTabs: ["argv-1", "argv-2", "stdout"], openPreviewTabs: ["argv-1"] })],
      "argv",
    );
    expect(next.get("a")).toEqual(["argv-1", "argv-2"]);
  });
});

describe("selectionSupportsPreviewCategory", () => {
  test("detects category support", () => {
    expect(selectionSupportsPreviewCategory([makeNode({ previewTabs: ["stdin"] })], "stdin")).toBe(true);
    expect(selectionSupportsPreviewCategory([makeNode({ previewTabs: ["stdout"] })], "argv")).toBe(false);
  });
});
