export type PlacementRect = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const EDGE_CLEARANCE = 20;
const OFFSET_STEP = 4;
const MAX_OFFSET_RING = 20;

type Segment = {
  start: number;
  end: number;
};

function overlaps(a: Segment, b: Segment) {
  return a.start < b.end && b.start < a.end;
}

function verticalEdges(rect: PlacementRect) {
  const x = rect.position.x;
  const y = rect.position.y;
  return {
    positions: [x, x + rect.size.width],
    span: { start: y, end: y + rect.size.height },
  };
}

function horizontalEdges(rect: PlacementRect) {
  const x = rect.position.x;
  const y = rect.position.y;
  return {
    positions: [y, y + rect.size.height],
    span: { start: x, end: x + rect.size.width },
  };
}

function hasParallelEdgeConflict(candidate: PlacementRect, existing: PlacementRect) {
  const candidateVertical = verticalEdges(candidate);
  const existingVertical = verticalEdges(existing);
  if (overlaps(candidateVertical.span, existingVertical.span)) {
    for (const candidateEdge of candidateVertical.positions) {
      for (const existingEdge of existingVertical.positions) {
        if (Math.abs(candidateEdge - existingEdge) < EDGE_CLEARANCE) {
          return true;
        }
      }
    }
  }

  const candidateHorizontal = horizontalEdges(candidate);
  const existingHorizontal = horizontalEdges(existing);
  if (overlaps(candidateHorizontal.span, existingHorizontal.span)) {
    for (const candidateEdge of candidateHorizontal.positions) {
      for (const existingEdge of existingHorizontal.positions) {
        if (Math.abs(candidateEdge - existingEdge) < EDGE_CLEARANCE) {
          return true;
        }
      }
    }
  }

  return false;
}

function candidateOffsets() {
  const offsets = [{ x: 0, y: 0 }];
  for (let ring = 1; ring <= MAX_OFFSET_RING; ring += 1) {
    const limit = ring * OFFSET_STEP;
    const ringOffsets: Array<{ x: number; y: number }> = [];
    for (let y = -limit; y <= limit; y += OFFSET_STEP) {
      for (let x = -limit; x <= limit; x += OFFSET_STEP) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== limit) {
          continue;
        }
        ringOffsets.push({ x, y });
      }
    }
    ringOffsets.sort((left, right) => {
      const distance = Math.abs(left.x) + Math.abs(left.y) - (Math.abs(right.x) + Math.abs(right.y));
      if (distance !== 0) {
        return distance;
      }
      const horizontalBias = Math.abs(left.y) - Math.abs(right.y);
      if (horizontalBias !== 0) {
        return horizontalBias;
      }
      return left.x - right.x || left.y - right.y;
    });
    offsets.push(...ringOffsets);
  }
  return offsets;
}

const OFFSETS = candidateOffsets();

export function chooseNodePosition(
  desired: { x: number; y: number },
  size: { width: number; height: number },
  existing: PlacementRect[],
) {
  for (const offset of OFFSETS) {
    const candidate = {
      position: {
        x: Math.round(desired.x + offset.x),
        y: Math.round(desired.y + offset.y),
      },
      size,
    };
    if (!existing.some((item) => hasParallelEdgeConflict(candidate, item))) {
      return candidate.position;
    }
  }

  const fallback = OFFSETS[OFFSETS.length - 1] ?? { x: 0, y: 0 };
  return {
    x: Math.round(desired.x + fallback.x),
    y: Math.round(desired.y + fallback.y),
  };
}
