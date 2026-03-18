import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";

import type { FlowEdgeData } from "../lib/types";

export default function WorkspaceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
  });
  const typedData = (data ?? {}) as FlowEdgeData;
  const edgeStyle = {
    stroke: "rgba(242, 192, 120, 0.95)",
    strokeWidth: 3.4,
    filter: "drop-shadow(0 0 8px rgba(242, 192, 120, 0.26))",
    ...(style ?? {}),
  };

  return (
    <>
      <BaseEdge id={id} path={path} style={edgeStyle} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="edge-delete nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          onClick={() => typedData.onDelete?.(id)}
          aria-label="delete wire"
          title="delete wire"
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
