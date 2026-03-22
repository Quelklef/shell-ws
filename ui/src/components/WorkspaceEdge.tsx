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
  selected,
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
    stroke: selected ? "color-mix(in srgb, var(--selection) 82%, white 18%)" : "rgba(242, 192, 120, 0.9)",
    strokeWidth: selected ? 4.2 : 3.1,
    filter: selected
      ? "drop-shadow(0 0 5px color-mix(in srgb, var(--selection) 36%, transparent))"
      : "drop-shadow(0 0 4px rgba(242, 192, 120, 0.14))",
    ...(style ?? {}),
  };

  return (
    <>
      <BaseEdge id={id} path={path} style={edgeStyle} markerEnd={markerEnd} className={`workspace-edge-path ${animated ? "is-animated" : ""} ${selected ? "is-selected" : ""}`} />
      <EdgeLabelRenderer>
        <div
          className={`edge-toolbar nodrag nopan ${selected ? "is-selected" : ""}`}
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
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
