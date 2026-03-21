import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export interface ReorderDropMarker {
  targetId: string;
  position: "before" | "after";
}

export interface ReorderDragPreview {
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface PendingDrag {
  itemId: string;
  startX: number;
  startY: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export function reorderItemsWithPlacement<T extends { id: string }>(
  items: readonly T[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
) {
  if (draggedId === targetId) {
    return [...items];
  }
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  if (draggedIndex === -1) {
    return [...items];
  }
  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  const targetIndex = next.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) {
    return [...items];
  }
  next.splice(position === "before" ? targetIndex : targetIndex + 1, 0, dragged);
  return next;
}

export function useVerticalReorderDrag({
  itemIds,
  itemRefs,
  onReorder,
  bodyClassName,
}: {
  itemIds: string[];
  itemRefs: RefObject<Map<string, HTMLElement>>;
  onReorder: (draggedId: string, targetId: string, position: "before" | "after") => void;
  bodyClassName?: string;
}) {
  const [pendingDrag, setPendingDrag] = useState<PendingDrag | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropMarker, setDropMarker] = useState<ReorderDropMarker | null>(null);
  const [dragPreview, setDragPreview] = useState<ReorderDragPreview | null>(null);
  const suppressClickRef = useRef<{ itemId: string; until: number } | null>(null);

  const startDrag = useCallback((itemId: string, event: ReactPointerEvent<HTMLElement>, element: HTMLElement | null) => {
    if (event.button !== 0 || !element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    setPendingDrag({
      itemId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    });
  }, []);

  const shouldSuppressClick = useCallback((itemId: string) => {
    const suppressed = suppressClickRef.current;
    if (!suppressed || suppressed.itemId !== itemId || suppressed.until <= Date.now()) {
      return false;
    }
    suppressClickRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    if (!pendingDrag || draggedId) {
      return;
    }
    const handleMove = (event: PointerEvent) => {
      // Do not turn a normal click into a reorder until the pointer has actually moved.
      if (Math.hypot(event.clientX - pendingDrag.startX, event.clientY - pendingDrag.startY) < 6) {
        return;
      }
      setDraggedId(pendingDrag.itemId);
      setDragPreview({
        x: event.clientX - pendingDrag.offsetX * 0.5,
        y: event.clientY - pendingDrag.offsetY * 0.5,
        width: pendingDrag.width,
        height: pendingDrag.height,
        offsetX: pendingDrag.offsetX,
        offsetY: pendingDrag.offsetY,
      });
      setDropMarker({ targetId: pendingDrag.itemId, position: "before" });
      setPendingDrag(null);
    };
    const finish = () => setPendingDrag(null);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [draggedId, pendingDrag]);

  useEffect(() => {
    if (!draggedId || !dragPreview) {
      return;
    }
    const updateMarker = (clientY: number) => {
      const candidates = itemIds.filter((itemId) => itemId !== draggedId);
      if (candidates.length === 0) {
        setDropMarker(null);
        return;
      }
      const refs = itemRefs.current;
      if (!refs) {
        setDropMarker(null);
        return;
      }
      for (const itemId of candidates) {
        const element = refs.get(itemId);
        if (!element) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          setDropMarker({ targetId: itemId, position: "before" });
          return;
        }
      }
      setDropMarker({ targetId: candidates[candidates.length - 1], position: "after" });
    };

    const handleMove = (event: PointerEvent) => {
      setDragPreview((current) =>
        current
          ? {
              ...current,
              x: event.clientX - current.offsetX * 0.5,
              y: event.clientY - current.offsetY * 0.5,
            }
          : current,
      );
      updateMarker(event.clientY);
    };

    const finish = () => {
      // Releasing after a drag can land on the original click target; suppress that follow-up click.
      suppressClickRef.current = { itemId: draggedId, until: Date.now() + 250 };
      if (dropMarker && dropMarker.targetId !== draggedId) {
        onReorder(draggedId, dropMarker.targetId, dropMarker.position);
      }
      setDraggedId(null);
      setDropMarker(null);
      setDragPreview(null);
    };

    if (bodyClassName) {
      document.body.classList.add(bodyClassName);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    return () => {
      if (bodyClassName) {
        document.body.classList.remove(bodyClassName);
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [bodyClassName, dragPreview, draggedId, dropMarker, itemIds, itemRefs, onReorder]);

  return {
    draggedId,
    dragPreview,
    dropMarker,
    startDrag,
    shouldSuppressClick,
  };
}
