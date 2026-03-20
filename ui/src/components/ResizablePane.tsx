import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { MIN_NODE_WIDTH } from "../lib/paneLayout";

const MAX_OBSERVED_PANE_HEIGHT = 2000;

type ResizablePaneProps = {
  paneId: string;
  height: number;
  minHeight?: number;
  width: number;
  className?: string;
  onWidthChange: (width: number) => void;
  onHeightChange: (paneId: string, height: number) => void;
  onLayoutChange?: () => void;
  children: ReactNode;
};

export default function ResizablePane({
  paneId,
  height,
  minHeight = 72,
  width,
  className,
  onWidthChange,
  onHeightChange,
  onLayoutChange,
  children,
}: ResizablePaneProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const heightCommitTimerRef = useRef<number | null>(null);
  const widthSettleTimerRef = useRef<number | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const observedHeightRef = useRef(height);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    const expectedHeight = `${height}px`;
    // Height is DOM-owned during a live resize. Only push React state back into the
    // element once the persisted pane height catches up to what the browser already sized.
    if (Math.abs(observedHeightRef.current - height) < 1 && element.style.height !== expectedHeight) {
      element.style.height = expectedHeight;
    }
  }, [height]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const notifyLayout = () => {
      if (!onLayoutChange || layoutFrameRef.current !== null) {
        return;
      }
      layoutFrameRef.current = window.requestAnimationFrame(() => {
        layoutFrameRef.current = null;
        onLayoutChange();
      });
    };

    const observer = new ResizeObserver(() => {
      const widthFromDom = Math.round(element.getBoundingClientRect().width);
      const heightFromDom = Math.round(element.getBoundingClientRect().height);
      observedHeightRef.current = heightFromDom;
      notifyLayout();

      // A pane that is actively resizing itself gets an inline width from the browser.
      // Mirror that into the shared node width, then clear the pane-local width once the
      // drag settles so every important box goes back to following the node width in CSS.
      if (element.style.width) {
        const nextWidth = Math.max(MIN_NODE_WIDTH, widthFromDom);
        if (Math.abs(nextWidth - width) >= 1) {
          onWidthChange(nextWidth);
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

      const inlineHeight = Math.round(parseFloat(element.style.height || "0"));
      const browserOwnsHeight = Math.abs(inlineHeight - height) >= 1;
      if (browserOwnsHeight && Math.abs(heightFromDom - height) >= 1) {
        if (heightCommitTimerRef.current !== null) {
          window.clearTimeout(heightCommitTimerRef.current);
        }
        heightCommitTimerRef.current = window.setTimeout(() => {
          // Only persist heights when the browser wrote an inline size from an actual pane resize.
          // Ordinary layout growth (preview toggles, flex sizing, CodeMirror settling) must not
          // rewrite pane state or the observer will ratchet the node taller forever.
          if (heightFromDom > MAX_OBSERVED_PANE_HEIGHT) {
            console.error(
              `[ResizablePane] refusing to persist runaway height for ${paneId}: ${heightFromDom}px`,
            );
            heightCommitTimerRef.current = null;
            return;
          }
          onHeightChange(paneId, heightFromDom);
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
      if (widthSettleTimerRef.current !== null) {
        window.clearTimeout(widthSettleTimerRef.current);
      }
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
      }
    };
  }, [height, onHeightChange, onLayoutChange, onWidthChange, paneId, width]);

  return (
    <div
      ref={elementRef}
      className={className}
      style={{ minHeight }}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
