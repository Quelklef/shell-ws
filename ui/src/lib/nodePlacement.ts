export type PlacementRect = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const PLACEMENT_GAP_X = 56;
const PLACEMENT_GAP_Y = 40;
const PLACEMENT_STEP_X = 52;
const PLACEMENT_STEP_Y = 38;
const MAX_PLACEMENT_RING = 8;

function overlapsWithGap(candidate: PlacementRect, existing: PlacementRect) {
  const candidateLeft = candidate.position.x;
  const candidateTop = candidate.position.y;
  const candidateRight = candidateLeft + candidate.size.width;
  const candidateBottom = candidateTop + candidate.size.height;
  const existingLeft = existing.position.x - PLACEMENT_GAP_X;
  const existingTop = existing.position.y - PLACEMENT_GAP_Y;
  const existingRight = existing.position.x + existing.size.width + PLACEMENT_GAP_X;
  const existingBottom = existing.position.y + existing.size.height + PLACEMENT_GAP_Y;

  return !(
    candidateRight <= existingLeft ||
    candidateLeft >= existingRight ||
    candidateBottom <= existingTop ||
    candidateTop >= existingBottom
  );
}

function candidateOffsets() {
  const offsets = [{ x: 0, y: 0 }];
  for (let ring = 1; ring <= MAX_PLACEMENT_RING; ring += 1) {
    for (let gridY = -ring; gridY <= ring; gridY += 1) {
      for (let gridX = -ring; gridX <= ring; gridX += 1) {
        if (Math.max(Math.abs(gridX), Math.abs(gridY)) !== ring) {
          continue;
        }
        offsets.push({
          x: gridX * PLACEMENT_STEP_X,
          y: gridY * PLACEMENT_STEP_Y,
        });
      }
    }
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
    if (!existing.some((item) => overlapsWithGap(candidate, item))) {
      return candidate.position;
    }
  }

  const fallback = OFFSETS[OFFSETS.length - 1] ?? { x: 0, y: 0 };
  return {
    x: Math.round(desired.x + fallback.x),
    y: Math.round(desired.y + fallback.y),
  };
}
