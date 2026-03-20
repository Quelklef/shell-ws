import type { Rect } from "@xyflow/react";

export function selectionRectToFlowRect(
  rect: Rect,
  transform: [number, number, number],
): Rect {
  const [translateX, translateY, zoom] = transform;
  return {
    x: (rect.x - translateX) / zoom,
    y: (rect.y - translateY) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
}
