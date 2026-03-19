import { describe, expect, it } from "vitest";

import { nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs } from "./nodePorts";

describe("node port affordances", () => {
  it("gives every node stdout and stderr previews", () => {
    expect(nodePreviewTabs("text")).toEqual(["stdout", "stderr"]);
    expect(nodePreviewTabs("file")).toEqual(["stdout", "stderr"]);
    expect(nodePreviewTabs("passthru")).toEqual(["stdin", "stdout", "stderr"]);
    expect(nodePreviewTabs("tee")).toEqual(["stdin", "stdout", "stderr"]);
    expect(nodePreviewTabs("merge_concat")).toEqual([
      "stdin",
      "stdout",
      "stderr",
    ]);
  });

  it("matches stdin affordance to node kind", () => {
    expect(nodeHasInputPort("text")).toBe(false);
    expect(nodeHasInputPort("file")).toBe(false);
    expect(nodeHasInputPort("script")).toBe(true);
    expect(nodeHasInputPort("passthru")).toBe(true);
  });

  it("adds argv ports only to command nodes", () => {
    expect(nodeHasArgvPort("script")).toBe(true);
    expect(nodeHasArgvPort("exec")).toBe(true);
    expect(nodeHasArgvPort("passthru")).toBe(false);
    expect(nodeHasArgvPort("file")).toBe(false);
  });
});
