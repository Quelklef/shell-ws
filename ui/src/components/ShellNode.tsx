import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { useState } from "react";

import { renderDisplay } from "../lib/format";
import type {
  AutoRunConfig,
  ExecutionMode,
  PortKind,
  ShellNodeData,
} from "../lib/types";
import { clamp } from "../lib/utils";

function AutoRunControls({
  config,
  onChange,
}: {
  config: AutoRunConfig;
  onChange: (next: AutoRunConfig) => void;
}) {
  return (
    <div className="autorun-controls">
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
  );
}

function outputHandle(port: PortKind, top: number, activeAt?: number) {
  const active = activeAt ? Date.now() - activeAt < 800 : false;
  return (
    <Handle
      id={port}
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
  const autoRun = model.autoRun ?? {
    enabled: false,
    mode: "push" as const,
    intervalMs: 1000,
  };
  const display = runtime.display ? renderDisplay(runtime.display.bytes) : null;
  const [activePreviewTab, setActivePreviewTab] = useState<PortKind>("stdout");
  const activePreview = runtime.previews?.[activePreviewTab];
  const renderedPreview = activePreview
    ? renderDisplay(activePreview.bytes)
    : {
        label: activePreviewTab,
        content: (
          <div className="display-empty">no recent {activePreviewTab}</div>
        ),
      };

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
      {model.kind !== "text" && (
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
          style={{ top: 96 }}
        />
      )}
      {(model.kind === "process" ||
        model.kind === "text" ||
        model.kind === "tee" ||
        model.kind.startsWith("merge_")) &&
        outputHandle("stdout", 84, runtime.portActivity.stdout)}
      {model.kind !== "text" &&
        model.kind !== "display" &&
        model.kind !== "tee" &&
        outputHandle("stderr", 128, runtime.portActivity.stderr)}

      <div className="node-card">
        <div className="node-comment">
          <textarea
            className="nodrag nopan"
            value={model.comment}
            placeholder="comment"
            onWheelCapture={(event) => event.stopPropagation()}
            onChange={(event) =>
              typedData.onUpdate(model.id, {
                comment: event.target.value,
              })
            }
          />
        </div>
        <div className="node-header-row">
          <div className="node-title">{model.title}</div>
          <button
            type="button"
            className="node-delete nodrag nopan"
            onClick={() => typedData.onDelete(model.id)}
            aria-label="delete node"
            title="delete node"
          >
            ×
          </button>
        </div>
        <div className="node-meta">
          <span>{model.kind.replaceAll("_", " ")}</span>
          <span>{runtime.running ? "running" : "idle"}</span>
        </div>

        {(model.kind === "process" || model.kind === "merge_shell") && (
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
            <textarea
              className="script-editor nodrag nopan"
              value={model.script ?? ""}
              placeholder="shell snippet"
              onWheelCapture={(event) => event.stopPropagation()}
              onChange={(event) =>
                typedData.onUpdate(model.id, { script: event.target.value })
              }
            />
          </>
        )}

        {model.kind === "text" && (
          <textarea
            className="script-editor nodrag nopan"
            value={model.text ?? ""}
            placeholder="text output"
            onWheelCapture={(event) => event.stopPropagation()}
            onChange={(event) =>
              typedData.onUpdate(model.id, { text: event.target.value })
            }
          />
        )}

        {model.kind === "display" && (
          <div
            className="display-pane"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div className="display-label">{display?.label ?? "display"}</div>
            {display?.content ?? (
              <div className="display-empty">stdin is quiet</div>
            )}
          </div>
        )}

        {model.kind === "tee" && (
          <div className="merge-help">
            duplicate stdin onto every connected stdout wire
          </div>
        )}

        {model.kind.startsWith("merge_") && model.kind !== "merge_shell" && (
          <div className="merge-help">
            {model.kind === "merge_concat" &&
              "concatenate upstream inputs in port order"}
            {model.kind === "merge_line" &&
              "interleave upstream inputs line by line"}
            {model.kind === "merge_byte" &&
              "interleave upstream inputs byte by byte"}
          </div>
        )}

        {model.kind === "process" && (
          <div className="port-preview-shell">
            <div className="port-preview-tabs">
              {(["stdin", "stdout", "stderr"] as PortKind[]).map((port) => (
                <button
                  key={port}
                  type="button"
                  className={`port-preview-tab nodrag nopan ${
                    activePreviewTab === port ? "is-active" : ""
                  }`}
                  onClick={() =>
                    setActivePreviewTab((current) =>
                      current === port ? null : port,
                    )
                  }
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
        )}

        <AutoRunControls
          config={autoRun}
          onChange={(next) => typedData.onToggleAutorun(model.id, next)}
        />

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
            className={`nodrag nopan ${autoRun.enabled ? "is-live" : ""}`}
            onClick={() =>
              typedData.onToggleAutorun(model.id, {
                ...autoRun,
                enabled: !autoRun.enabled,
              })
            }
          >
            auto
          </button>
          {runtime.running && (
            <button
              type="button"
              className="nodrag nopan danger"
              onClick={() => typedData.onStop(model.id)}
            >
              stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
