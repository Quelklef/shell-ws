import { describe, expect, it } from "vitest";

import { nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs } from "./nodePorts";

describe("node port affordances", () => {
  it("gives every node stdout and stderr previews", () => {
    expect(nodePreviewTabs("text")).toEqual(["stdout", "stderr"]);
    expect(nodePreviewTabs("cat")).toEqual(["stdout", "stderr"]);
    expect(nodePreviewTabs("display")).toEqual(["stdin", "stdout", "stderr"]);
    expect(nodePreviewTabs("tee")).toEqual(["stdin", "stdout", "stderr"]);
    expect(nodePreviewTabs("merge_concat")).toEqual([
      "stdin",
      "stdout",
      "stderr",
    ]);
  });

  it("matches stdin affordance to node kind", () => {
    expect(nodeHasInputPort("text")).toBe(false);
    expect(nodeHasInputPort("cat")).toBe(false);
    expect(nodeHasInputPort("script")).toBe(true);
    expect(nodeHasInputPort("display")).toBe(true);
  });

  it("adds argv ports only to command nodes", () => {
    expect(nodeHasArgvPort("script")).toBe(true);
    expect(nodeHasArgvPort("exec")).toBe(true);
    expect(nodeHasArgvPort("display")).toBe(false);
    expect(nodeHasArgvPort("cat")).toBe(false);
  });
});
