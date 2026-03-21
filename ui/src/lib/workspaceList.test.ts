import { describe, expect, it } from "vitest";

import { sortWorkspaceSummaries, upsertWorkspaceSummary } from "./workspaceList";

describe("workspaceList", () => {
  it("sorts workspaces by creation time before name", () => {
    expect(sortWorkspaceSummaries([
      { id: "b", name: "Beta", createdAt: 2, sortOrder: 2 },
      { id: "a", name: "Alpha", createdAt: 1, sortOrder: 1 },
    ])).toEqual([
      { id: "a", name: "Alpha", createdAt: 1, sortOrder: 1 },
      { id: "b", name: "Beta", createdAt: 2, sortOrder: 2 },
    ]);
  });

  it("upserts by id and keeps the list sorted", () => {
    expect(upsertWorkspaceSummary([
      { id: "b", name: "Beta", createdAt: 2, sortOrder: 2 },
      { id: "a", name: "Alpha", createdAt: 1, sortOrder: 1 },
    ], { id: "c", name: "Able", createdAt: 3, sortOrder: 3 })).toEqual([
      { id: "a", name: "Alpha", createdAt: 1, sortOrder: 1 },
      { id: "b", name: "Beta", createdAt: 2, sortOrder: 2 },
      { id: "c", name: "Able", createdAt: 3, sortOrder: 3 },
    ]);

    expect(upsertWorkspaceSummary([
      { id: "b", name: "Beta", createdAt: 2, sortOrder: 2 },
      { id: "a", name: "Alpha", createdAt: 1, sortOrder: 1 },
    ], { id: "b", name: "Bravo", createdAt: 2, sortOrder: 2 })).toEqual([
      { id: "a", name: "Alpha", createdAt: 1, sortOrder: 1 },
      { id: "b", name: "Bravo", createdAt: 2, sortOrder: 2 },
    ]);
  });
});
