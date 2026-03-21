import { describe, expect, it } from "vitest";

import { COLLAPSED_SIDEBAR_WIDTH, SIDEBAR_DEFAULTS, normalizeWorkspaceUi } from "./workspaceUi";

describe("workspaceUi", () => {
  it("fills in default sidebars", () => {
    expect(normalizeWorkspaceUi({ viewportX: 1, viewportY: 2, zoom: 3 }).sidebars).toEqual(SIDEBAR_DEFAULTS);
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
