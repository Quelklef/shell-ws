import { describe, expect, it } from "vitest";

import { defaultPaneHeight, nextPaneSizes, paneHeight, previewPaneId } from "./paneLayout";

describe("paneLayout", () => {
  it("uses shared defaults for preview panes", () => {
    expect(previewPaneId("stdout")).toBe("preview-stdout");
    expect(defaultPaneHeight(previewPaneId("stdout"))).toBe(112);
  });

  it("falls back to pane-type defaults when no persisted height exists", () => {
    expect(paneHeight(undefined, "script")).toBe(132);
    expect(paneHeight(undefined, "ai-prompt")).toBe(72);
    expect(paneHeight(undefined, "formula")).toBe(96);
  });

  it("reads and writes persisted pane heights", () => {
    const uiState = nextPaneSizes(undefined, "script", 180);
    expect(uiState.paneSizes?.script?.height).toBe(180);
    expect(paneHeight(uiState, "script")).toBe(180);
  });
});
