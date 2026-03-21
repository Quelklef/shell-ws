import { describe, expect, it } from "vitest";

import { sortWorkspaceSummaries, upsertWorkspaceSummary } from "./workspaceList";

describe("workspaceList", () => {
  it("sorts workspaces by name", () => {
    expect(sortWorkspaceSummaries([
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
    ])).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
  });

  it("upserts by id and keeps the list sorted", () => {
    expect(upsertWorkspaceSummary([
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
    ], { id: "c", name: "Able" })).toEqual([
      { id: "c", name: "Able" },
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);

    expect(upsertWorkspaceSummary([
      { id: "b", name: "Beta" },
      { id: "a", name: "Alpha" },
    ], { id: "b", name: "Bravo" })).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ]);
  });
});
