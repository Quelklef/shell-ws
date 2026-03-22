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

  useEffect(() => {
    latestWidthRef.current = width;
    latestHeightRef.current = height;
    latestPaneIdRef.current = paneId;
    latestWidthBehaviorRef.current = widthBehavior;
    latestOnWidthChangeRef.current = onWidthChange;
    latestOnHeightChangeRef.current = onHeightChange;
    latestOnLayoutChangeRef.current = onLayoutChange;
  }, [height, onHeightChange, onLayoutChange, onWidthChange, paneId, width, widthBehavior]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    const expectedHeight = `${height}px`;
    if (Math.abs(observedHeightRef.current - height) < 1 && element.style.height !== expectedHeight) {
      element.style.height = expectedHeight;
    }
    if (widthBehavior === "pane") {
      const expectedWidth = `${width}px`;
      if (Math.abs(observedWidthRef.current - width) < 1 && element.style.width !== expectedWidth) {
        element.style.width = expectedWidth;
      }
    }
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
    };
  }, [minWidth]);

  return (
    <div
      ref={elementRef}
      className={className}
      style={{ minHeight, minWidth }}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
