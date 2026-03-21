import { describe, expect, it } from "vitest";

import {
  chooseInitialWorkspaceId,
  loadGlobalActiveWorkspaceId,
  readWorkspaceIdFromUrl,
  saveGlobalActiveWorkspaceId,
  writeWorkspaceIdToUrl,
} from "./activeWorkspace";

describe("activeWorkspace", () => {
  it("prefers the url workspace over the stored workspace", () => {
    const summaries = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ];
    expect(chooseInitialWorkspaceId(summaries, "b", "a")).toBe("b");
    expect(chooseInitialWorkspaceId(summaries, "z", "a")).toBe("a");
    expect(chooseInitialWorkspaceId(summaries, null, null)).toBe("a");
  });

  it("stores the active workspace globally", () => {
    window.localStorage.clear();
    saveGlobalActiveWorkspaceId("abc");
    expect(loadGlobalActiveWorkspaceId()).toBe("abc");
  });

  it("reads and writes the workspace query param", () => {
    window.history.replaceState(null, "", "/?workspace=old&x=1");
    expect(readWorkspaceIdFromUrl()).toBe("old");
    writeWorkspaceIdToUrl("new");
    const url = new URL(window.location.href);
    expect(url.searchParams.get("workspace")).toBe("new");
    expect(url.searchParams.get("x")).toBe("1");
  });
});
