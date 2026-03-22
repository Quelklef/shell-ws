import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_PANE_WIDTH, MIN_RESIZABLE_PANE_WIDTH, defaultPaneHeight, defaultPaneWidth, nextPaneSizes, paneHeight, paneWidth, previewPaneId } from "./paneLayout";

describe("paneLayout", () => {
  it("exposes a minimum resizable pane width", () => {
    expect(MIN_RESIZABLE_PANE_WIDTH).toBe(150);
  });

  it("uses shared defaults for preview panes", () => {
    expect(previewPaneId("stdout")).toBe("preview-stdout");
    expect(defaultPaneHeight(previewPaneId("stdout"))).toBe(112);
    expect(defaultPaneWidth(previewPaneId("stdout"), 500)).toBe(DEFAULT_PREVIEW_PANE_WIDTH);
  });

  it("uses the fallback width for non-preview panes", () => {
    expect(defaultPaneWidth("script", 500)).toBe(500);
    expect(defaultPaneWidth("script", 120)).toBe(MIN_RESIZABLE_PANE_WIDTH);
  });

  it("falls back to pane-type defaults when no persisted height exists", () => {
    expect(paneHeight(undefined, "script")).toBe(132);
    expect(paneHeight(undefined, "ai-prompt")).toBe(72);
    expect(paneHeight(undefined, "formula")).toBe(96);
  });

  it("reads and writes persisted pane heights", () => {
    const uiState = nextPaneSizes(undefined, "script", { height: 180 });
    expect(uiState.paneSizes?.script?.height).toBe(180);
    expect(paneHeight(uiState, "script")).toBe(180);
  });
});


it("persists pane widths independently", () => {
  const ui = nextPaneSizes(undefined, "preview-stdout", { width: 240 });
  expect(paneWidth(ui, "preview-stdout", 180)).toBe(240);
});
