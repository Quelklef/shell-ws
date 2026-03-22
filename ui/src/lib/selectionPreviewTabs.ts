export type PreviewToggleCategory = "stdin" | "stdout" | "stderr" | "argv";

export interface PreviewToggleNode {
  id: string;
  previewTabs: string[];
  openPreviewTabs: string[];
}

function tabsForCategory(previewTabs: string[], category: PreviewToggleCategory) {
  if (category === "argv") {
    return previewTabs.filter((tab) => /^argv-\d+$/.test(tab));
  }
  return previewTabs.filter((tab) => tab === category);
}

export function selectionSupportsPreviewCategory(
  nodes: PreviewToggleNode[],
  category: PreviewToggleCategory,
) {
  return nodes.some((node) => tabsForCategory(node.previewTabs, category).length > 0);
}

export function togglePreviewCategoryForSelection(
  nodes: PreviewToggleNode[],
  category: PreviewToggleCategory,
) {
  const relevantNodes = nodes
    .map((node) => ({ node, categoryTabs: tabsForCategory(node.previewTabs, category) }))
    .filter((entry) => entry.categoryTabs.length > 0);
  if (relevantNodes.length === 0) {
    return new Map<string, string[]>();
  }
  const shouldClose = relevantNodes.every(({ node, categoryTabs }) =>
    categoryTabs.every((tab) => node.openPreviewTabs.includes(tab)),
  );
  return new Map(
    relevantNodes.map(({ node, categoryTabs }) => {
      const nextTabs = shouldClose
        ? node.openPreviewTabs.filter((tab) => !categoryTabs.includes(tab))
        : [...new Set([...node.openPreviewTabs, ...categoryTabs])];
      return [node.id, nextTabs];
    }),
  );
}
