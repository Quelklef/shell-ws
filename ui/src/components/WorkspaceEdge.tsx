import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

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
  const [hovered, setHovered] = useState(false);
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
  const buffering = String(typedData.buffering ?? "line_or_1024");
  const edgeStroke = selected ? "color-mix(in srgb, var(--selection) 82%, white 18%)" : "rgba(242, 192, 120, 0.9)";
  const edgeGlow = selected
    ? "drop-shadow(0 0 5px color-mix(in srgb, var(--selection) 36%, transparent))"
    : "drop-shadow(0 0 4px rgba(242, 192, 120, 0.14))";
  const edgeStyle = {
    stroke: edgeStroke,
    strokeWidth: selected ? 4.2 : 3.1,
    filter: edgeGlow,
    ...(style ?? {}),
  };
  const completeEdgeStyle = {
    stroke: edgeStroke,
    strokeWidth: selected ? 6.6 : 5.2,
    filter: edgeGlow,
    ...(style ?? {}),
  };
  const completeEdgeCutoutStyle = {
    stroke: "rgba(12, 14, 16, 0.96)",
    strokeWidth: selected ? 2.6 : 2.2,
    ...(style ?? {}),
  };

  return (
    <>
      {buffering === "on_complete" ? (
        <>
          <BaseEdge id={`${id}-complete-outer`} path={path} style={completeEdgeStyle} markerEnd={markerEnd} className={`workspace-edge-path workspace-edge-path-${buffering} ${selected ? "is-selected" : ""}`} />
          <BaseEdge id={`${id}-complete-cutout`} path={path} style={completeEdgeCutoutStyle} className="workspace-edge-path workspace-edge-path-on_complete-cutout" />
        </>
      ) : (
        <BaseEdge id={id} path={path} style={edgeStyle} markerEnd={markerEnd} className={`workspace-edge-path workspace-edge-path-${buffering} ${animated ? "is-animated" : ""} ${selected ? "is-selected" : ""}`} />
      )}
      <path
        d={path}
        className="workspace-edge-hover-target"
        fill="none"
        stroke="currentColor"
        strokeOpacity={0}
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          className={`edge-toolbar nodrag nopan ${selected ? "is-selected" : ""} ${hovered ? "is-visible" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
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
            {buffering.replaceAll("_", " ")}
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
