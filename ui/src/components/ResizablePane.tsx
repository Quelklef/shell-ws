import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { MIN_RESIZABLE_PANE_WIDTH } from "../lib/paneLayout";

const MAX_OBSERVED_PANE_HEIGHT = 2000;

type ResizablePaneProps = {
  paneId: string;
  height: number;
  minHeight?: number;
  width: number;
  minWidth?: number;
  className?: string;
  widthBehavior?: "node" | "pane";
  customResizeHandles?: boolean;
  onWidthChange?: ((width: number) => void) | ((paneId: string, width: number) => void);
  onHeightChange: (paneId: string, height: number) => void;
  onLayoutChange?: () => void;
  children: ReactNode;
};

export default function ResizablePane({
  paneId,
  height,
  minHeight = 72,
  width,
  minWidth = MIN_RESIZABLE_PANE_WIDTH,
  className,
  widthBehavior = "node",
  customResizeHandles = false,
  onWidthChange,
  onHeightChange,
  onLayoutChange,
  children,
}: ResizablePaneProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const heightCommitTimerRef = useRef<number | null>(null);
  const widthCommitTimerRef = useRef<number | null>(null);
  const widthSettleTimerRef = useRef<number | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const propResizeFrameRef = useRef<number | null>(null);
  const nativeResizeSettleTimerRef = useRef<number | null>(null);
  const observedHeightRef = useRef(height);
  const observedWidthRef = useRef(width);
  const stableNodeWidthRef = useRef(width);
  const stablePaneWidthRef = useRef(width);
  const latestWidthRef = useRef(width);
  const latestHeightRef = useRef(height);
  const latestPaneIdRef = useRef(paneId);
  const latestWidthBehaviorRef = useRef(widthBehavior);
  const latestOnWidthChangeRef = useRef(onWidthChange);
  const latestOnHeightChangeRef = useRef(onHeightChange);
  const latestOnLayoutChangeRef = useRef(onLayoutChange);
  const applyingPropResizeRef = useRef(false);
  const nativeResizeActiveRef = useRef(false);
  const customResizeDragRef = useRef<{
    pointerId: number;
    resizeWidth: boolean;
    resizeHeight: boolean;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  useEffect(() => {
    latestWidthRef.current = width;
    latestHeightRef.current = height;
    latestPaneIdRef.current = paneId;
    latestWidthBehaviorRef.current = widthBehavior;
    latestOnWidthChangeRef.current = onWidthChange;
    latestOnHeightChangeRef.current = onHeightChange;
    latestOnLayoutChangeRef.current = onLayoutChange;
  }, [height, onHeightChange, onLayoutChange, onWidthChange, paneId, width, widthBehavior]);

  useEffect(() => {
    return () => {
      if (!customResizeDragRef.current) {
        return;
      }
      customResizeDragRef.current = null;
      nativeResizeActiveRef.current = false;
    };
  }, []);

  const startCustomResize = (resizeWidth: boolean, resizeHeight: boolean) =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = elementRef.current;
      if (!element) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      customResizeDragRef.current = {
        pointerId: event.pointerId,
        resizeWidth,
        resizeHeight,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
      };
      nativeResizeActiveRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const updateCustomResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = customResizeDragRef.current;
    const element = elementRef.current;
    if (!drag || !element || event.pointerId !== drag.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (drag.resizeWidth) {
      const nextWidth = Math.max(minWidth, Math.round(drag.startWidth + (event.clientX - drag.startX)));
      element.style.width = `${nextWidth}px`;
    }
    if (drag.resizeHeight) {
      const nextHeight = Math.max(minHeight, Math.round(drag.startHeight + (event.clientY - drag.startY)));
      element.style.height = `${nextHeight}px`;
    }
  };

  const finishCustomResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = customResizeDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    customResizeDragRef.current = null;
    nativeResizeActiveRef.current = false;
    if (nativeResizeSettleTimerRef.current !== null) {
      window.clearTimeout(nativeResizeSettleTimerRef.current);
      nativeResizeSettleTimerRef.current = null;
    }
  };

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || nativeResizeActiveRef.current) {
      return;
    }

    let wrotePropSize = false;
    const expectedHeight = `${height}px`;
    if (element.style.height !== expectedHeight) {
      element.style.height = expectedHeight;
      wrotePropSize = true;
    }
    if (widthBehavior === "pane") {
      const expectedWidth = `${width}px`;
      if (element.style.width !== expectedWidth) {
        element.style.width = expectedWidth;
        wrotePropSize = true;
      }
    }

    if (!wrotePropSize) {
      return;
    }

    // Prop-driven size changes like fit/minimize should update the DOM immediately. The only
    // time we suppress these writes is during an active native resize gesture, where the browser
    // owns the element size and React state is just catching up.
    applyingPropResizeRef.current = true;
    if (propResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(propResizeFrameRef.current);
    }
    propResizeFrameRef.current = window.requestAnimationFrame(() => {
      applyingPropResizeRef.current = false;
      propResizeFrameRef.current = null;
    });
  }, [height, width, widthBehavior]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const notifyLayout = () => {
      if (!latestOnLayoutChangeRef.current || layoutFrameRef.current !== null) {
        return;
      }
      layoutFrameRef.current = window.requestAnimationFrame(() => {
        layoutFrameRef.current = null;
        latestOnLayoutChangeRef.current?.();
      });
    };

    const observer = new ResizeObserver(() => {
      const widthFromDom = Math.round(element.offsetWidth);
      const heightFromDom = Math.round(element.offsetHeight);
      const nodeWidthFromDom = Math.round(
        (element.closest(".react-flow__node") as HTMLElement | null)?.offsetWidth ?? latestWidthRef.current,
      );
      observedHeightRef.current = heightFromDom;
      observedWidthRef.current = widthFromDom;
      notifyLayout();

      if (!applyingPropResizeRef.current && (element.style.width || element.style.height)) {
        nativeResizeActiveRef.current = true;
        if (nativeResizeSettleTimerRef.current !== null) {
          window.clearTimeout(nativeResizeSettleTimerRef.current);
        }
        nativeResizeSettleTimerRef.current = window.setTimeout(() => {
          nativeResizeActiveRef.current = false;
          nativeResizeSettleTimerRef.current = null;
        }, 140);
      }

      if (latestWidthBehaviorRef.current === "node") {
        if (!element.style.width) {
          stableNodeWidthRef.current = nodeWidthFromDom;
          stablePaneWidthRef.current = widthFromDom;
        }
        if (element.style.width) {
          const paneWidth = Math.max(minWidth, widthFromDom);
          const nextWidth = stableNodeWidthRef.current + (paneWidth - stablePaneWidthRef.current);
          if (Math.abs(nextWidth - latestWidthRef.current) >= 1) {
            (latestOnWidthChangeRef.current as ((width: number) => void) | undefined)?.(nextWidth);
          }
          if (widthSettleTimerRef.current !== null) {
            window.clearTimeout(widthSettleTimerRef.current);
          }
          widthSettleTimerRef.current = window.setTimeout(() => {
            if (elementRef.current) {
              elementRef.current.style.width = "";
            }
            notifyLayout();
            widthSettleTimerRef.current = null;
          }, 140);
        }
      } else {
        const inlineWidth = Math.round(parseFloat(element.style.width || "0"));
        const browserOwnsWidth = Math.abs(inlineWidth - latestWidthRef.current) >= 1;
        if (browserOwnsWidth && Math.abs(widthFromDom - latestWidthRef.current) >= 1) {
          if (widthCommitTimerRef.current !== null) {
            window.clearTimeout(widthCommitTimerRef.current);
          }
          widthCommitTimerRef.current = window.setTimeout(() => {
            (latestOnWidthChangeRef.current as ((paneId: string, width: number) => void) | undefined)?.(
              latestPaneIdRef.current,
              Math.max(minWidth, widthFromDom),
            );
            widthCommitTimerRef.current = null;
          }, 140);
        }
      }

      const inlineHeight = Math.round(parseFloat(element.style.height || "0"));
      const browserOwnsHeight = Math.abs(inlineHeight - latestHeightRef.current) >= 1;
      if (browserOwnsHeight && Math.abs(heightFromDom - latestHeightRef.current) >= 1) {
        if (heightCommitTimerRef.current !== null) {
          window.clearTimeout(heightCommitTimerRef.current);
        }
        heightCommitTimerRef.current = window.setTimeout(() => {
          if (heightFromDom > MAX_OBSERVED_PANE_HEIGHT) {
            console.error(
              `[ResizablePane] refusing to persist runaway height for ${latestPaneIdRef.current}: ${heightFromDom}px`,
            );
            heightCommitTimerRef.current = null;
            return;
          }
          latestOnHeightChangeRef.current(latestPaneIdRef.current, heightFromDom);
          heightCommitTimerRef.current = null;
        }, 140);
      }
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
      if (heightCommitTimerRef.current !== null) {
        window.clearTimeout(heightCommitTimerRef.current);
      }
      if (widthCommitTimerRef.current !== null) {
        window.clearTimeout(widthCommitTimerRef.current);
      }
      if (widthSettleTimerRef.current !== null) {
        window.clearTimeout(widthSettleTimerRef.current);
      }
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
      }
      if (propResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(propResizeFrameRef.current);
      }
      if (nativeResizeSettleTimerRef.current !== null) {
        window.clearTimeout(nativeResizeSettleTimerRef.current);
      }
    };
  }, [minWidth]);

  return (
    <div
      ref={elementRef}
      className={`${className ?? ""}${customResizeHandles ? " has-custom-resize-handles" : ""}`}
      style={{ minHeight, minWidth }}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {children}
      {customResizeHandles ? (
        <>
          <div
            className="resizable-pane-handle resizable-pane-handle-right nodrag nopan"
            onPointerDown={startCustomResize(true, false)}
            onPointerMove={updateCustomResize}
            onPointerUp={finishCustomResize}
            onPointerCancel={finishCustomResize}
          />
          <div
            className="resizable-pane-handle resizable-pane-handle-bottom nodrag nopan"
            onPointerDown={startCustomResize(false, true)}
            onPointerMove={updateCustomResize}
            onPointerUp={finishCustomResize}
            onPointerCancel={finishCustomResize}
          />
          <div
            className="resizable-pane-handle resizable-pane-handle-corner nodrag nopan"
            onPointerDown={startCustomResize(true, true)}
            onPointerMove={updateCustomResize}
            onPointerUp={finishCustomResize}
            onPointerCancel={finishCustomResize}
          />
        </>
      ) : null}
    </div>
  );
}
