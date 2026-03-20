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
  animated,
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
    stroke: "rgba(242, 192, 120, 0.9)",
    strokeWidth: 3.1,
    filter: "drop-shadow(0 0 4px rgba(242, 192, 120, 0.14))",
    ...(style ?? {}),
  };

  return (
    <>
      <BaseEdge id={id} path={path} style={edgeStyle} markerEnd={markerEnd} className={`workspace-edge-path ${animated ? "is-animated" : ""}`} />
      <EdgeLabelRenderer>
        <div
          className="edge-toolbar nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="edge-buffering nodrag nopan"
            onClick={(event) => {
              event.stopPropagation();
              typedData.onCycle?.(id);
            }}
            aria-label="cycle wire buffering"
            title="cycle wire buffering"
          >
            {String(typedData.buffering ?? "line_or_1024").replaceAll("_", " ")}
          </button>
          <button
            type="button"
            className="edge-delete nodrag nopan"
            onClick={(event) => {
              event.stopPropagation();
              typedData.onDelete?.(id);
            }}
            aria-label="delete wire"
            title="delete wire"
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
