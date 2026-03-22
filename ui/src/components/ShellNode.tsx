import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import katex from "katex";
import { Handle, Position, type NodeProps, useStore, useUpdateNodeInternals } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import ResizablePane from "./ResizablePane";

import { analyzeFormula, FORMULA_SYNTAX_OVERVIEW } from "../lib/formula";
import { renderDisplay } from "../lib/format";
import { ACTIONS } from "../lib/actionIcons";
import { outputPortsForKind } from "../lib/portSchema";
import { nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs } from "../lib/nodePorts";
import { defaultPaneHeight, defaultPaneWidth, paneHeight, paneWidth, previewPaneId } from "../lib/paneLayout";
import type {
  AutoRunConfig,
  ExecutionAction,
  PortKind,
  ShellNodeData,
} from "../lib/types";
import { clamp } from "../lib/utils";

const PORT_SPACING = 30;
const PORT_STACK_TOP = 48;
const PREVIEW_WIDTH_SAMPLE = "MMMMMMMMMM";
const PREVIEW_SCROLLBAR_BUFFER = 16;

function tabExpandedLength(line: string, tabSize: number) {
  let width = 0;
  for (const char of line) {
    if (char === "\t") {
      const spaces = tabSize - (width % tabSize || 0);
      width += spaces;
    } else {
      width += 1;
    }
  }
  return width;
}

function measureMonospaceCharWidth(referenceElement: HTMLElement) {
  const computedStyle = window.getComputedStyle(referenceElement);
  const probe = document.createElement("span");
  probe.textContent = PREVIEW_WIDTH_SAMPLE;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.style.margin = "0";
  probe.style.padding = "0";
  probe.style.border = "0";
  probe.style.fontFamily = computedStyle.fontFamily;
  probe.style.fontSize = computedStyle.fontSize;
  probe.style.fontWeight = computedStyle.fontWeight;
  probe.style.fontStyle = computedStyle.fontStyle;
  probe.style.fontVariant = computedStyle.fontVariant;
  probe.style.letterSpacing = computedStyle.letterSpacing;
  probe.style.textTransform = computedStyle.textTransform;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / PREVIEW_WIDTH_SAMPLE.length;
  probe.remove();
  return width || Math.max(parseFloat(computedStyle.fontSize) * 0.6, 1);
}

function AutoRunControls({
  config,
  onChange,
}: {
  config: AutoRunConfig;
  onChange: (next: AutoRunConfig) => void;
}) {
  return (
    <div className="autorun-shell">
      <div className="autorun-label">auto run</div>
      <div className="autorun-controls">
        <button
          type="button"
          className={`nodrag nopan ${config.enabled ? "is-live" : ""}`}
          onClick={() => onChange({ ...config, enabled: !config.enabled })}
        >
          {config.enabled ? "on" : "off"}
        </button>
        <select
          className="nodrag nopan"
          value={config.mode}
          onWheelCapture={(event) => event.stopPropagation()}
          onChange={(event) =>
            onChange({
              ...config,
              mode: event.target.value as ExecutionAction,
            })
          }
        >
          <option value="pull_inputs">pull inputs</option>
          <option value="pull_run">pull + run</option>
          <option value="rerun">rerun</option>
          <option value="rerun_push">rerun + push</option>
          <option value="repush">repush</option>
        </select>
        <input
          className="nodrag nopan"
          type="number"
          min={100}
          step={100}
          value={config.intervalMs}
          onWheelCapture={(event) => event.stopPropagation()}
          onChange={(event) =>
            onChange({
              ...config,
              intervalMs: clamp(Number(event.target.value) || 1000, 100, 60000),
            })
          }
        />
        <span>ms</span>
      </div>
    </div>
  );
}

function outputHandle(
  port: PortKind,
  top: number,
  handleId: string,
  activeAt?: number,
) {
  const active = activeAt ? Date.now() - activeAt < 800 : false;
  return (
    <Handle
      key={handleId}
      id={handleId}
      type="source"
      position={Position.Right}
      className={`shell-handle shell-handle-${port} ${active ? "is-active" : ""}`}
      style={{ top }}
    />
  );
}

export default function ShellNode({ data }: NodeProps) {
  const typedData = data as unknown as ShellNodeData;
  const { model, runtime } = typedData;
  const refreshNodeInternals = useUpdateNodeInternals();
  const zoom = useStore((store) => store.transform[2]);
  const shellExtensions = useMemo(() => [StreamLanguage.define(shell)], []);
  const autoRun = model.autoRun ?? {
    enabled: false,
    mode: "rerun_push" as const,
    intervalMs: 1000,
  };
  const openPreviewTabs = model.uiState?.openPreviewTabs ?? [];
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [showFormulaHelp, setShowFormulaHelp] = useState(false);
  const previewTabs = typedData.previewTabs ?? nodePreviewTabs(model.kind);
  const previewControlsLocation = typedData.previewControlsLocation ?? "floating";
  const getVisiblePreview = (port: string) => runtime.livePreviews?.[port] ?? runtime.previews?.[port];
  const htmlBytes = getVisiblePreview("stdin")?.bytes ?? new Uint8Array();
  const htmlContent = new TextDecoder().decode(htmlBytes);
  const orderedOpenPreviewTabs = previewTabs.filter((port) => openPreviewTabs.includes(port));
  const openPreviewSignature = orderedOpenPreviewTabs.join("|");
  const [commentHeadline, ...commentBodyLines] = model.comment.split("\n");
  const commentBody = commentBodyLines.join("\n").trim();
  const formulaAnalysis = useMemo(() => analyzeFormula(model.formula ?? ""), [model.formula]);
  const selectionPreviewDisplayWidth = useMemo(() => 2 / Math.max(zoom, 0.01), [zoom]);
  const formulaHtml = useMemo(() => formulaAnalysis.ok ? katex.renderToString(formulaAnalysis.tex, { throwOnError: false, displayMode: true, strict: "ignore" }) : null, [formulaAnalysis]);
  const execArgs = model.args ?? [];
  const paneSizeSignature = useMemo(() => JSON.stringify(model.uiState?.paneSizes ?? {}), [model.uiState?.paneSizes]);
  const handleNodePaneWidthChange = useCallback((width: number) => {
    typedData.onResizeWidth(model.id, width);
  }, [model.id, typedData]);
  const handlePaneHeightChange = useCallback((paneId: string, height: number) => {
    typedData.onResizePaneHeight(model.id, paneId, height);
  }, [model.id, typedData]);
  const handlePaneWidthChange = useCallback((paneId: string, width: number) => {
    typedData.onResizePaneWidth(model.id, paneId, width);
  }, [model.id, typedData]);
  const handleLayoutChange = useCallback(() => {
    refreshNodeInternals(model.id);
  }, [model.id, refreshNodeInternals]);
  const renderResizablePane = useCallback((paneId: string, className: string, children: ReactNode, minHeight?: number) => (
    <ResizablePane
      paneId={paneId}
      width={model.size.width}
      height={paneHeight(model.uiState, paneId)}
      minHeight={minHeight}
      className={className}
      onWidthChange={handleNodePaneWidthChange}
      onHeightChange={handlePaneHeightChange}
      onLayoutChange={handleLayoutChange}
    >
      {children}
    </ResizablePane>
  ), [handleLayoutChange, handleNodePaneWidthChange, handlePaneHeightChange, model.size.width, model.uiState]);
  const leftPorts = useMemo(() => {
    const ports: Array<{ key: string; port: PortKind; slot?: number; activeAt?: number }> = [];
    if (nodeHasInputPort(model.kind)) {
      ports.push({ key: "stdin", port: "stdin", activeAt: runtime.portActivity.stdin });
    }
    if (nodeHasArgvPort(model.kind)) {
      for (const slot of typedData.argvSlots ?? [1]) {
        ports.push({ key: `argv-${slot}`, port: "argv", slot, activeAt: runtime.portActivity.argv });
      }
    }
    return ports;
  }, [model.kind, runtime.portActivity.argv, runtime.portActivity.stdin, typedData.argvSlots]);
  const rightPorts = useMemo(
    () => outputPortsForKind(model.kind).map((port) => ({ key: port, port, activeAt: runtime.portActivity[port] })),
    [model.kind, runtime.portActivity],
  );

  const previewButtons = (
    <div className="port-preview-tabs">
      {previewTabs.map((port) => {
        const isOpen = openPreviewTabs.includes(port);
        const previewState = runtime.livePreviews?.[port] ?? runtime.previews?.[port];
        const hasData = (previewState?.bytes.length ?? 0) > 0;
        const portClass = port.startsWith("argv-") ? "argv" : port;
        return (
          <button
            key={port}
            type="button"
            className={`port-preview-tab port-preview-tab-${portClass} nodrag nopan ${
              isOpen ? "is-active" : ""
            }`}
            onClick={() => {
              const nextTabs = isOpen
                ? openPreviewTabs.filter((entry) => entry !== port)
                : [...openPreviewTabs, port];
              typedData.onUpdate(model.id, {
                uiState: {
                  ...(model.uiState ?? {}),
                  openPreviewTabs: nextTabs,
                },
              });
            }}
          >
            <span>{port}</span>
            {hasData && <span className={`port-preview-dot port-preview-dot-${portClass}`} />}
          </button>
        );
      })}
    </div>
  );

  const floatingPreviewPanes = orderedOpenPreviewTabs.map((port) => {
    const preview = getVisiblePreview(port);
    const previewText = new TextDecoder().decode(preview?.bytes ?? new Uint8Array());
    const renderedPreview = preview
      ? renderDisplay(preview.bytes)
      : {
          label: port,
          content: <div className="display-empty">no materialized {port}</div>,
        };
    const paneId = previewPaneId(port);
    const closePreviewPane = () => {
      typedData.onUpdate(model.id, {
        uiState: {
          ...(model.uiState ?? {}),
          openPreviewTabs: openPreviewTabs.filter((entry) => entry !== port),
        },
      });
    };
    const minimizePreviewPane = () => {
      typedData.onResizePaneWidth(model.id, paneId, defaultPaneWidth(paneId, model.size.width));
      typedData.onResizePaneHeight(model.id, paneId, defaultPaneHeight(paneId));
    };
    const fitPreviewPane = (event: React.MouseEvent<HTMLButtonElement>) => {
      const paneElement = event.currentTarget.closest(".port-preview-pane") as HTMLElement | null;
      const bodyElement = paneElement?.querySelector(".port-preview-body") as HTMLElement | null;
      const headerElement = paneElement?.querySelector(".port-preview-header") as HTMLElement | null;
      const preElement = bodyElement?.querySelector(".display-code") as HTMLElement | null;
      const contentElement = bodyElement?.firstElementChild as HTMLElement | null;
      if (!paneElement || !bodyElement) {
        return;
      }
      const maxWidth = Math.max(180, Math.floor(window.innerWidth * 0.4));
      const maxHeight = Math.max(defaultPaneHeight(paneId), Math.floor(window.innerHeight * 0.45));
      const headerHeight = headerElement?.offsetHeight ?? 0;
      const contentHeight = contentElement ? Math.ceil(contentElement.scrollHeight) : Math.ceil(bodyElement.scrollHeight);
      const heightChrome = Math.max(16, paneElement.offsetHeight - headerHeight - bodyElement.getBoundingClientRect().height);
      let nextWidth = Math.min(maxWidth, Math.max(180, Math.ceil(bodyElement.scrollWidth + (paneElement.offsetWidth - bodyElement.clientWidth))));
      if (preElement) {
        const tabSize = Number.parseInt(window.getComputedStyle(preElement).tabSize || "8", 10) || 8;
        const longestLineColumns = previewText.split(/\r?\n/).reduce((max, line) => {
          return Math.max(max, tabExpandedLength(line, tabSize));
        }, 0);
        const charWidth = measureMonospaceCharWidth(preElement);
        const desiredPreWidth = Math.ceil(longestLineColumns * charWidth);
        const widthChrome = Math.max(24, paneElement.getBoundingClientRect().width - preElement.getBoundingClientRect().width);
        nextWidth = Math.min(maxWidth, Math.max(180, Math.ceil(desiredPreWidth + widthChrome + PREVIEW_SCROLLBAR_BUFFER)));
      }
      const nextHeight = Math.min(maxHeight, Math.max(96, Math.ceil(contentHeight + headerHeight + heightChrome)));
      typedData.onResizePaneWidth(model.id, paneId, nextWidth);
      typedData.onResizePaneHeight(model.id, paneId, nextHeight);
    };
    return (
      <ResizablePane
        key={port}
        paneId={paneId}
        width={paneWidth(model.uiState, paneId, model.size.width)}
        height={paneHeight(model.uiState, paneId)}
        minWidth={180}
        minHeight={96}
        className="resizable-pane port-preview-pane port-preview-floating-pane nodrag nopan"
        widthBehavior="pane"
        onWidthChange={handlePaneWidthChange}
        onHeightChange={handlePaneHeightChange}
        onLayoutChange={handleLayoutChange}
      >
        <div className="port-preview-header">
          <div className="display-label">
            {port} · {renderedPreview.label}
          </div>
          <div className="port-preview-actions">
            <button
              type="button"
              className="port-preview-copy nodrag nopan"
              title={`copy ${port}`}
              aria-label={`copy ${port}`}
              onClick={() => {
                const text = new TextDecoder().decode(preview?.bytes ?? new Uint8Array());
                void navigator.clipboard?.writeText(text);
              }}
            >
              <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                <rect x="5" y="3" width="7" height="9" rx="1.2" />
                <path d="M4 5H3.2A1.2 1.2 0 0 0 2 6.2v6.6A1.2 1.2 0 0 0 3.2 14h5.6A1.2 1.2 0 0 0 10 12.8V12" />
              </svg>
            </button>
            <button
              type="button"
              className="port-preview-copy nodrag nopan"
              title={`minimize ${port}`}
              aria-label={`minimize ${port}`}
              onClick={minimizePreviewPane}
            >
              <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                <path d="M13 3 8.5 7.5" />
                <path d="M9 3h4v4" />
                <path d="M3 13 7.5 8.5" />
                <path d="M3 9v4h4" />
              </svg>
            </button>
            <button
              type="button"
              className="port-preview-copy nodrag nopan"
              title={`fit ${port}`}
              aria-label={`fit ${port}`}
              onClick={fitPreviewPane}
            >
              <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                <path d="M6 2.5H2.5V6" />
                <path d="M10 2.5h3.5V6" />
                <path d="M6 13.5H2.5V10" />
                <path d="M10 13.5h3.5V10" />
              </svg>
            </button>
            <button
              type="button"
              className="port-preview-copy nodrag nopan"
              title={`close ${port}`}
              aria-label={`close ${port}`}
              onClick={closePreviewPane}
            >
              <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true" style={{ transform: "scale(1.15)" }}>
                <path d="M4 4l8 8" />
                <path d="M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
        <div className="port-preview-body">{renderedPreview.content}</div>
      </ResizablePane>
    );
  });

  useLayoutEffect(() => {
    const element = commentRef.current;
    if (!element || !isEditingComment) {
      return;
    }
    const selectionStart = element.selectionStart;
    const selectionEnd = element.selectionEnd;
    // A trailing newline does not reliably contribute a visual line to scrollHeight, so
    // temporarily add a sentinel to size the editor for the final blank line.
    const needsTrailingLineSentinel = model.comment.endsWith("\n");
    if (needsTrailingLineSentinel) {
      element.value = `${model.comment} `;
    }
    element.style.height = "0px";
    element.style.height = `${Math.max(22, element.scrollHeight)}px`;
    if (needsTrailingLineSentinel) {
      element.value = model.comment;
      if (document.activeElement === element) {
        element.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }, [isEditingComment, model.comment]);

  useEffect(() => {
    if (!isEditingComment) {
      return;
    }
    const element = commentRef.current;
    if (!element) {
      return;
    }
    element.focus();
    const length = element.value.length;
    element.setSelectionRange(length, length);
  }, [isEditingComment]);

  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      refreshNodeInternals(model.id);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [
    isEditingComment,
    model.id,
    model.kind,
    model.size.width,
    openPreviewSignature,
    paneSizeSignature,
    previewControlsLocation,
    refreshNodeInternals,
    showFormulaHelp,
  ]);

  return (
    <div
      className={`shell-node nopan kind-${model.kind} ${runtime.running ? "is-running" : ""} ${typedData.selectionPreview ? "is-selection-preview" : ""}`}
      style={{ ["--selection-preview-width" as string]: `${selectionPreviewDisplayWidth}px` }}
    >
      {leftPorts.map(({ key, port, activeAt }, index) => {
        const active = activeAt ? Date.now() - activeAt < 800 : false;
        return (
          <Handle
            key={key}
            id={key}
            type="target"
            position={Position.Left}
            className={`shell-handle shell-handle-${port} ${active ? "is-active" : ""}`}
            style={{ top: PORT_STACK_TOP + index * PORT_SPACING }}
          />
        );
      })}
      {rightPorts.map(({ key, port, activeAt }, index) =>
        outputHandle(port, PORT_STACK_TOP + index * PORT_SPACING, key, activeAt),
      )}

      <div className="node-comment-floating">
        {isEditingComment ? (
          <textarea
            ref={commentRef}
            className="nodrag nopan"
            value={model.comment}
            placeholder="Add a comment"
            onWheelCapture={(event) => event.stopPropagation()}
            onBlur={() => setIsEditingComment(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setIsEditingComment(false);
              }
            }}
            onChange={(event) => typedData.onUpdate(model.id, { comment: event.target.value })}
          />
        ) : (
          <div
            className={`node-comment-display nodrag nopan ${model.comment.trim() ? "has-comment" : "is-empty"}`}
            role="button"
            tabIndex={0}
            onClick={() => setIsEditingComment(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setIsEditingComment(true);
              }
            }}
          >
            {model.comment.trim() ? (
              <>
                <div className="node-comment-headline">{commentHeadline}</div>
                {commentBody && <div className="node-comment-body">{commentBody}</div>}
              </>
            ) : (
              <div className="node-comment-placeholder">Add a comment</div>
            )}
          </div>
        )}
      </div>

      <div className="node-card">
        <div className="node-meta">
          <span className="node-kind-label">{model.kind.replaceAll("_", " ")}</span>
          {model.kind === "formula" && (
            <button
              type="button"
              className={`node-kind-icon-button nodrag nopan ${showFormulaHelp ? "is-open" : ""}`}
              title="formula syntax help"
              aria-label="formula syntax help"
              onClick={() => setShowFormulaHelp((current) => !current)}
            >
              ?
            </button>
          )}
          {(model.kind === "display" || model.kind === "passthru") && (
            <button
              type="button"
              className="node-kind-icon-button nodrag nopan"
              title={model.kind === "display" ? "convert to passthru" : "convert to display"}
              aria-label={model.kind === "display" ? "convert to passthru" : "convert to display"}
              onClick={() => typedData.onConvertKind(model.id, model.kind === "display" ? "passthru" : "display")}
            >
              <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
                <path d="M3 5h7" />
                <path d="M8 3l2 2-2 2" />
                <path d="M13 11H6" />
                <path d="M8 9l-2 2 2 2" />
              </svg>
            </button>
          )}
          <span className={`node-state-pill ${runtime.running ? "is-running" : "is-idle"}`}>
            {runtime.running ? "running" : "idle"}
          </span>
          {model.materialized?.lastExitCode != null && (
            <span className={`node-state-pill node-exit-pill ${model.materialized.lastExitCode === 0 ? "is-success" : "is-failed"}`}>
              exit {model.materialized.lastExitCode}
            </span>
          )}
        </div>

        {(model.kind === "script" || model.kind === "ai_script") && (
          <>
            <input
              className="shell-input nodrag nopan"
              value={model.shell ?? "bash"}
              onWheelCapture={(event) => event.stopPropagation()}
              onChange={(event) => typedData.onUpdate(model.id, { shell: event.target.value })}
              placeholder="shell"
            />
            {model.kind === "ai_script" && (
              <>
                {renderResizablePane(
                  "ai-prompt",
                  "resizable-pane input-pane nodrag nopan",
                  <textarea
                    className="resizable-input script-editor ai-description-editor"
                    value={model.description ?? ""}
                    placeholder="describe the script you want generated"
                    onChange={(event) => typedData.onUpdate(model.id, { description: event.target.value })}
                  />,
                )}
                <div className="ai-generate-shell">
                  <button
                    type="button"
                    className="nodrag nopan"
                    disabled={typedData.generation?.loading}
                    onClick={() => void typedData.onGenerate(model.id)}
                  >
                    {typedData.generation?.loading ? "generating..." : "generate"}
                  </button>
                  <label className="ai-generate-samples nodrag nopan">
                    <input
                      type="checkbox"
                      checked={model.includeSampleInputs ?? false}
                      onChange={(event) =>
                        typedData.onUpdate(model.id, {
                          includeSampleInputs: event.target.checked,
                        })
                      }
                    />
                    <span>include sample inputs from previous execution</span>
                  </label>
                  {typedData.generation?.error && (
                    <div className="node-inline-error">{typedData.generation.error}</div>
                  )}
                </div>
              </>
            )}
            {renderResizablePane(
              "script",
              "resizable-pane codemirror-pane script-editor-codemirror nodrag nopan",
              <CodeMirror
                className="codemirror-host"
                value={model.script ?? ""}
                height="100%"
                theme={oneDark}
                extensions={shellExtensions}
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                }}
                onChange={(value) => typedData.onUpdate(model.id, { script: value })}
              />,
              112,
            )}
          </>
        )}

        {model.kind === "exec" && (
          <>
            <input
              className="shell-input nodrag nopan"
              value={model.path ?? ""}
              onWheelCapture={(event) => event.stopPropagation()}
              onChange={(event) => typedData.onUpdate(model.id, { path: event.target.value })}
              placeholder="binary path"
            />
            <div className="exec-args-shell">
              {execArgs.map((arg, index) => (
                <div key={`${model.id}-arg-${index}`} className="exec-arg-row">
                  <select
                    className="exec-arg-mode nodrag nopan"
                    value={arg.source}
                    onWheelCapture={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const nextArgs = [...execArgs];
                      nextArgs[index] = event.target.value === "argv"
                        ? { source: "argv", slot: 1 }
                        : { source: "literal", value: arg.source === "literal" ? arg.value : "" };
                      typedData.onUpdate(model.id, { args: nextArgs });
                    }}
                  >
                    <option value="literal">text</option>
                    <option value="argv">argv</option>
                  </select>
                  {arg.source === "literal" ? (
                    <textarea
                      className="exec-arg-editor nodrag nopan"
                      value={arg.value}
                      placeholder={`arg ${index + 1}`}
                      onWheelCapture={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const nextArgs = [...execArgs];
                        nextArgs[index] = { ...arg, value: event.target.value };
                        typedData.onUpdate(model.id, { args: nextArgs });
                      }}
                    />
                  ) : (
                    <label className="exec-arg-argv nodrag nopan">
                      <span>argv #</span>
                      <input
                        className="shell-input nodrag nopan"
                        type="number"
                        min={1}
                        value={arg.slot}
                        onWheelCapture={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const nextArgs = [...execArgs];
                          nextArgs[index] = { source: "argv", slot: Math.max(1, Number(event.target.value) || 1) };
                          typedData.onUpdate(model.id, { args: nextArgs });
                        }}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="nodrag nopan exec-arg-delete"
                    onClick={() => {
                      const nextArgs = [...execArgs];
                      nextArgs.splice(index, 1);
                      typedData.onUpdate(model.id, { args: nextArgs });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="nodrag nopan exec-arg-add"
                onClick={() => typedData.onUpdate(model.id, { args: [...execArgs, { source: "literal", value: "" }] })}
              >
                add arg
              </button>
            </div>
          </>
        )}

        {model.kind === "file" && (
          <div className="file-input-row">
            <input
              className="shell-input nodrag nopan"
              value={model.path ?? ""}
              onWheelCapture={(event) => event.stopPropagation()}
              onChange={(event) => typedData.onUpdate(model.id, { path: event.target.value })}
              placeholder="file path"
            />
            <button
              type="button"
              className="nodrag nopan file-picker-button"
              onClick={() => void typedData.onPickFile(model.id)}
            >
              pick
            </button>
          </div>
        )}

        {model.kind === "text" && (
          renderResizablePane(
            "text",
            "resizable-pane input-pane nodrag nopan",
            <textarea
              className="resizable-input script-editor"
              value={model.text ?? ""}
              placeholder="text output"
              onChange={(event) => typedData.onUpdate(model.id, { text: event.target.value })}
            />,
            96,
          )
        )}

        {model.kind === "formula" && (
          <div className="formula-shell">
            {showFormulaHelp && (
              <div className="formula-help-panel nodrag nopan">
                <pre>{FORMULA_SYNTAX_OVERVIEW}</pre>
              </div>
            )}
            {renderResizablePane(
              "formula",
              `resizable-pane codemirror-pane formula-editor-codemirror nodrag nopan ${formulaAnalysis.ok ? "" : "is-invalid"}`,
              <CodeMirror
                className="codemirror-host"
                value={model.formula ?? ""}
                height="100%"
                theme={oneDark}
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                }}
                onChange={(value) => typedData.onUpdate(model.id, { formula: value })}
              />,
              84,
            )}
            {formulaAnalysis.ok ? (
              <div className="formula-preview nodrag nopan" dangerouslySetInnerHTML={{ __html: formulaHtml ?? "" }} />
            ) : (
              <div className="node-inline-error">{formulaAnalysis.error}</div>
            )}
          </div>
        )}

        {model.kind === "html" && (
          renderResizablePane(
            "html",
            "resizable-pane html-pane nodrag nopan",
            <>
              <div className="display-label">html</div>
              <iframe
                className="html-frame"
                sandbox="allow-scripts allow-forms"
                srcDoc={htmlContent}
                title={`html-${model.id}`}
              />
            </>,
            120,
          )
        )}

        <div className="node-toolbar node-action-toolbar">
          {ACTIONS.map(({ action, label, icon }) => {
            const reason = typedData.getActionReason(model.id, action);
            const disabled = reason !== null;
            return (
              <button
                key={action}
                className="nodrag nopan node-action-button"
                type="button"
                disabled={disabled}
                title={disabled ? `${label}: ${reason}` : label}
                aria-label={label}
                onClick={() => typedData.onRun(model.id, action)}
              >
                {icon}
              </button>
            );
          })}
          <button
            type="button"
            className={`nodrag nopan ${model.uiState?.showAutoControls ? "is-live" : ""}`}
            onClick={() =>
              typedData.onUpdate(model.id, {
                uiState: {
                  ...(model.uiState ?? {}),
                  showAutoControls: !model.uiState?.showAutoControls,
                },
              })
            }
            title="toggle auto controls"
          >
            auto
          </button>
        </div>

        {model.uiState?.showAutoControls && (
          <AutoRunControls config={autoRun} onChange={(next) => typedData.onToggleAutorun(model.id, next)} />
        )}

        {previewControlsLocation === "node" && previewButtons}
      </div>

      {(previewControlsLocation === "floating" || floatingPreviewPanes.length > 0) && (
        <div className="port-preview-floating-shell">
          {previewControlsLocation === "floating" && previewButtons}
          {floatingPreviewPanes.length > 0 && (
            <div className="port-preview-floating-panes">{floatingPreviewPanes}</div>
          )}
        </div>
      )}
    </div>
  );
}
