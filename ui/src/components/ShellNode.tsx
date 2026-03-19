import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { renderDisplay } from "../lib/format";
import { ACTIONS } from "../lib/actionIcons";
import { nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs } from "../lib/nodePorts";
import type {
  AutoRunConfig,
  ExecutionAction,
  PortKind,
  ShellNodeData,
} from "../lib/types";
import { clamp } from "../lib/utils";

const PREVIEW_HEIGHT_DELTA = 156;
const PORT_SPACING = 30;
const STDOUT_PORT_TOP = 84;
const STDERR_PORT_TOP = STDOUT_PORT_TOP + PORT_SPACING;
const STDIN_PORT_TOP = 96;
const ARGV_FIRST_PORT_TOP = STDIN_PORT_TOP + PORT_SPACING;

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

export default function ShellNode({ data, selected }: NodeProps) {
  const typedData = data as unknown as ShellNodeData;
  const { model, runtime } = typedData;
  const shellExtensions = useMemo(() => [StreamLanguage.define(shell)], []);
  const autoRun = model.autoRun ?? {
    enabled: false,
    mode: "rerun_push" as const,
    intervalMs: 1000,
  };
  const openPreviewTabs =
    model.uiState?.openPreviewTabs ??
    (model.uiState?.activePreviewTab ? [model.uiState.activePreviewTab] : []);
  const scriptEditorRef = useRef<HTMLDivElement | null>(null);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const [isEditingComment, setIsEditingComment] = useState(false);
  const previewTabs = typedData.previewTabs ?? nodePreviewTabs(model.kind);
  const getVisiblePreview = (port: string) => runtime.livePreviews?.[port] ?? runtime.previews?.[port];
  const htmlBytes = getVisiblePreview("stdin")?.bytes ?? new Uint8Array();
  const htmlContent = new TextDecoder().decode(htmlBytes);
  const orderedOpenPreviewTabs = previewTabs.filter((port) => openPreviewTabs.includes(port));
  const [commentHeadline, ...commentBodyLines] = model.comment.split("\n");
  const commentBody = commentBodyLines.join("\n").trim();

  const syncEditorHeight = (key: "script" | "args" | "text" | "description", height: number) => {
    const currentHeight = model.uiState?.editorHeights?.[key];
    if (currentHeight && Math.abs(currentHeight - height) < 1) {
      return;
    }
    typedData.onUpdate(model.id, {
      uiState: {
        ...(model.uiState ?? {}),
        editorHeights: {
          ...(model.uiState?.editorHeights ?? {}),
          [key]: height,
        },
      },
    });
  };

  useEffect(() => {
    const element = scriptEditorRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncEditorHeight("script", element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
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

  return (
    <div className={`shell-node nopan kind-${model.kind} ${runtime.running ? "is-running" : ""}`}>
      <NodeResizer
        minWidth={260}
        minHeight={160}
        isVisible={selected}
        lineClassName="node-resizer-line"
        handleClassName="node-resizer-handle"
      />
      {nodeHasInputPort(model.kind) && (
        <Handle
          id="stdin"
          type="target"
          position={Position.Left}
          className={`shell-handle shell-handle-stdin ${
            runtime.portActivity.stdin && Date.now() - runtime.portActivity.stdin < 800
              ? "is-active"
              : ""
          }`}
          style={{ top: STDIN_PORT_TOP }}
        />
      )}
      {nodeHasArgvPort(model.kind) &&
        (typedData.argvSlots ?? [1]).map((slot, index) => (
          <Handle
            key={`argv-${slot}`}
            id={`argv-${slot}`}
            type="target"
            position={Position.Left}
            className={`shell-handle shell-handle-argv ${
              runtime.portActivity.argv && Date.now() - runtime.portActivity.argv < 800
                ? "is-active"
                : ""
            }`}
            style={{ top: ARGV_FIRST_PORT_TOP + index * PORT_SPACING }}
          />
        ))}
      {nodePreviewTabs(model.kind).includes("stdout") &&
        outputHandle("stdout", STDOUT_PORT_TOP, "stdout", runtime.portActivity.stdout)}
      {nodePreviewTabs(model.kind).includes("stderr") &&
        outputHandle("stderr", STDERR_PORT_TOP, "stderr", runtime.portActivity.stderr)}

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
        <button
          type="button"
          className="node-delete nodrag nopan"
          onClick={() => typedData.onDelete(model.id)}
          aria-label="delete node"
          title="delete node"
        >
          ×
        </button>
        <div className="node-meta">
          <span className="node-kind-label">{model.kind.replaceAll("_", " ")}</span>
          <span className={`node-state-pill ${runtime.running ? "is-running" : "is-idle"}`}>
            {runtime.running ? "running" : "idle"}
          </span>
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
                <textarea
                  className="script-editor ai-description-editor nodrag nopan"
                  style={{ height: model.uiState?.editorHeights?.description ?? 72 }}
                  value={model.description ?? ""}
                  placeholder="describe the script you want generated"
                  onWheelCapture={(event) => event.stopPropagation()}
                  onChange={(event) => typedData.onUpdate(model.id, { description: event.target.value })}
                />
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
            <div
              ref={scriptEditorRef}
              className="script-editor-codemirror nodrag nopan"
              style={{ height: model.uiState?.editorHeights?.script ?? 132 }}
              onWheelCapture={(event) => event.stopPropagation()}
            >
              <CodeMirror
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
              />
            </div>
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
              {(model.args ?? []).map((arg, index) => (
                <div key={`${model.id}-arg-${index}`} className="exec-arg-row">
                  <textarea
                    className="exec-arg-editor nodrag nopan"
                    value={arg}
                    placeholder={`arg ${index + 1}`}
                    onWheelCapture={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const nextArgs = [...(model.args ?? [])];
                      nextArgs[index] = event.target.value;
                      typedData.onUpdate(model.id, { args: nextArgs });
                    }}
                  />
                  <button
                    type="button"
                    className="nodrag nopan exec-arg-delete"
                    onClick={() => {
                      const nextArgs = [...(model.args ?? [])];
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
                onClick={() => typedData.onUpdate(model.id, { args: [...(model.args ?? []), ""] })}
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
          <textarea
            className="script-editor nodrag nopan"
            style={{ height: model.uiState?.editorHeights?.text }}
            value={model.text ?? ""}
            placeholder="text output"
            onWheelCapture={(event) => event.stopPropagation()}
            onChange={(event) => typedData.onUpdate(model.id, { text: event.target.value })}
          />
        )}

        {model.kind === "html" && (
          <div className="html-pane nodrag nopan">
            <div className="display-label">html</div>
            <iframe
              className="html-frame"
              sandbox="allow-scripts allow-forms"
              srcDoc={htmlContent}
              title={`html-${model.id}`}
            />
          </div>
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

        <div className="port-preview-shell">
          <div className="port-preview-tabs">
            {previewTabs.map((port) => {
              const isOpen = openPreviewTabs.includes(port);
              const hasData = Boolean(runtime.livePreviews?.[port] ?? runtime.previews?.[port]);
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
                    const openedCountDelta = nextTabs.length - openPreviewTabs.length;
                    typedData.onUpdate(model.id, {
                      uiState: {
                        ...(model.uiState ?? {}),
                        activePreviewTab: null,
                        openPreviewTabs: nextTabs,
                      },
                      size:
                        openedCountDelta !== 0
                          ? {
                              ...model.size,
                              height: Math.max(160, model.size.height + PREVIEW_HEIGHT_DELTA * openedCountDelta),
                            }
                          : model.size,
                    });
                  }}
                >
                  <span>{port}</span>
                  {hasData && <span className={`port-preview-dot port-preview-dot-${portClass}`} />}
                </button>
              );
            })}
          </div>
          {orderedOpenPreviewTabs.map((port) => {
            const preview = getVisiblePreview(port);
            const renderedPreview = preview
              ? renderDisplay(preview.bytes)
              : {
                  label: port,
                  content: <div className="display-empty">no materialized {port}</div>,
                };
            return (
              <div
                key={port}
                className="port-preview-pane nodrag nopan"
                onWheelCapture={(event) => event.stopPropagation()}
              >
                <div className="display-label">
                  {port} · {renderedPreview.label}
                </div>
                {renderedPreview.content}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
