import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { renderDisplay } from "../lib/format";
import { nodeHasArgvPort, nodeHasInputPort, nodePreviewTabs } from "../lib/nodePorts";
import type {
  AutoRunConfig,
  ExecutionMode,
  PortKind,
  ShellNodeData,
} from "../lib/types";
import { clamp } from "../lib/utils";

const PREVIEW_HEIGHT_DELTA = 156;

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
              mode: event.target.value as ExecutionMode,
            })
          }
        >
          <option value="push">push</option>
          <option value="pull">pull</option>
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
    mode: "push" as const,
    intervalMs: 1000,
  };
  const activePreviewTab = model.uiState?.activePreviewTab ?? null;
  const scriptEditorRef = useRef<HTMLDivElement | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const nodeCardRef = useRef<HTMLDivElement | null>(null);
  const previewTabs = typedData.previewTabs ?? nodePreviewTabs(model.kind);
  const htmlBytes = runtime.previews?.stdin?.bytes ?? new Uint8Array();
  const htmlContent = new TextDecoder().decode(htmlBytes);
  const activePreview = activePreviewTab
    ? runtime.previews?.[activePreviewTab]
    : undefined;
  const renderedPreview = activePreviewTab
    ? activePreview
      ? renderDisplay(activePreview.bytes)
      : {
          label: activePreviewTab,
          content: (
            <div className="display-empty">no recent {activePreviewTab}</div>
          ),
        }
    : null;


  const syncEditorHeight = (
    key: "script" | "args" | "text",
    height: number,
  ) => {
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

  useEffect(() => {
    const element = textEditorRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncEditorHeight("text", element.getBoundingClientRect().height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  return (
    <div
      className={`shell-node nopan kind-${model.kind} ${runtime.running ? "is-running" : ""}`}
    >
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
            runtime.portActivity.stdin &&
            Date.now() - runtime.portActivity.stdin < 800
              ? "is-active"
              : ""
          }`}
          style={{ top: nodeHasArgvPort(model.kind) ? 78 : 96 }}
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
              runtime.portActivity.argv &&
              Date.now() - runtime.portActivity.argv < 800
                ? "is-active"
                : ""
            }`}
            style={{ top: 112 + index * 24 }}
          />
        ))}
      {(model.kind === "script" ||
        model.kind === "exec" ||
        model.kind === "file" ||
        model.kind === "text" ||
        model.kind === "passthru" ||
        model.kind === "html" ||
        model.kind.startsWith("merge_")) &&
        outputHandle("stdout", 84, "stdout", runtime.portActivity.stdout)}
      {model.kind === "tee" &&
        (typedData.outputSlots ?? [1]).map((slot, index) =>
          outputHandle(
            "stdout",
            70 + index * 28,
            `stdout-${slot}`,
            runtime.portActivity.stdout,
          ),
        )}
      {(model.kind === "script" ||
        model.kind === "exec" ||
        model.kind === "file") &&
        outputHandle("stderr", 128, "stderr", runtime.portActivity.stderr)}

      <div className="node-comment-floating">
        <textarea
          ref={commentRef}
          className="nodrag nopan"
          value={model.comment}
          placeholder="Add a comment"
          onWheelCapture={(event) => event.stopPropagation()}
          onChange={(event) =>
            typedData.onUpdate(model.id, {
              comment: event.target.value,
            })
          }
        />
      </div>

      <div ref={nodeCardRef} className="node-card">
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

        {(model.kind === "script" || model.kind === "merge_shell") && (
          <>
            <input
              className="shell-input nodrag nopan"
              value={model.shell ?? "bash"}
              onWheelCapture={(event) => event.stopPropagation()}
              onChange={(event) =>
                typedData.onUpdate(model.id, { shell: event.target.value })
              }
              placeholder="shell"
            />
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
                onChange={(value) =>
                  typedData.onUpdate(model.id, { script: value })
                }
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
              onChange={(event) =>
                typedData.onUpdate(model.id, { path: event.target.value })
              }
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
                onClick={() =>
                  typedData.onUpdate(model.id, {
                    args: [...(model.args ?? []), ""],
                  })
                }
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
              onChange={(event) =>
                typedData.onUpdate(model.id, { path: event.target.value })
              }
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
            ref={textEditorRef}
            className="script-editor nodrag nopan"
            style={{ height: model.uiState?.editorHeights?.text }}
            value={model.text ?? ""}
            placeholder="text output"
            onWheelCapture={(event) => event.stopPropagation()}
            onChange={(event) =>
              typedData.onUpdate(model.id, { text: event.target.value })
            }
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

        <div className="node-toolbar">
          <button
            className="nodrag nopan"
            type="button"
            onClick={() => typedData.onRun(model.id, "push")}
          >
            push
          </button>
          <button
            className="nodrag nopan"
            type="button"
            onClick={() => typedData.onRun(model.id, "pull")}
          >
            pull
          </button>
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
          >
            auto
          </button>
        </div>

        {model.uiState?.showAutoControls && (
          <AutoRunControls
            config={autoRun}
            onChange={(next) => typedData.onToggleAutorun(model.id, next)}
          />
        )}

        <div className="port-preview-shell">
          <div className="port-preview-tabs">
            {previewTabs.map((port) => (
              <button
                key={port}
                type="button"
                className={`port-preview-tab nodrag nopan ${
                  activePreviewTab === port ? "is-active" : ""
                }`}
                onClick={() => {
                  const nextTab = activePreviewTab === port ? null : port;
                  const opened = activePreviewTab == null && nextTab != null;
                  const closed = activePreviewTab != null && nextTab == null;
                  typedData.onUpdate(model.id, {
                    uiState: {
                      ...(model.uiState ?? {}),
                      activePreviewTab: nextTab,
                    },
                    size:
                      opened || closed
                        ? {
                            ...model.size,
                            height: Math.max(
                              160,
                              model.size.height +
                                (opened
                                  ? PREVIEW_HEIGHT_DELTA
                                  : -PREVIEW_HEIGHT_DELTA),
                            ),
                          }
                        : model.size,
                  });
                }}
              >
                {port}
              </button>
            ))}
          </div>
          {activePreviewTab && renderedPreview && (
            <div
              className="port-preview-pane nodrag nopan"
              onWheelCapture={(event) => event.stopPropagation()}
            >
              <div className="display-label">
                {activePreviewTab} · {renderedPreview.label}
              </div>
              {renderedPreview.content}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
