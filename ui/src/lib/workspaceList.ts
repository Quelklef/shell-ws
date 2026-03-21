import type { WorkspaceSummary } from "./types";

export function sortWorkspaceSummaries(summaries: WorkspaceSummary[]) {
  return [...summaries].sort((left, right) => (left.sortOrder ?? left.createdAt ?? 0) - (right.sortOrder ?? right.createdAt ?? 0) || (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.name.localeCompare(right.name));
}

export function upsertWorkspaceSummary(
  summaries: WorkspaceSummary[],
  next: WorkspaceSummary,
) {
  const remaining = summaries.filter((item) => item.id !== next.id);
  return sortWorkspaceSummaries([...remaining, next]);
}
