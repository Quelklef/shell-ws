import { describe, expect, it } from "vitest";

import { COLLAPSED_SIDEBAR_WIDTH, SIDEBAR_DEFAULTS, loadGlobalSidebarState, normalizeWorkspaceUi, saveGlobalSidebarState } from "./workspaceUi";

describe("workspaceUi", () => {
  it("fills in default sidebars", () => {
    const ui = normalizeWorkspaceUi({ viewportX: 1, viewportY: 2, zoom: 3 });
    expect(ui.sidebars).toEqual(SIDEBAR_DEFAULTS);
    expect(ui.previewControlsLocation).toBe("floating");
  });

  it("clamps sidebar widths and preserves collapse state", () => {
    const ui = normalizeWorkspaceUi({
      viewportX: 0,
      viewportY: 0,
      zoom: 1,
      sidebars: {
        workspaces: { width: 40, collapsed: true },
      },
    });
    expect(ui.sidebars.workspaces.collapsed).toBe(true);
    expect(ui.sidebars.workspaces.width).toBeGreaterThan(COLLAPSED_SIDEBAR_WIDTH);
    expect(ui.sidebars.settings).toEqual(SIDEBAR_DEFAULTS.settings);
  });
});

it("loads and saves sidebar state globally", () => {
  window.localStorage.clear();
  expect(loadGlobalSidebarState()).toEqual(SIDEBAR_DEFAULTS);

  saveGlobalSidebarState({
    ...SIDEBAR_DEFAULTS,
    nodes: { width: 123, collapsed: true },
  });

  expect(loadGlobalSidebarState().nodes).toEqual({ width: 123, collapsed: true });
});
