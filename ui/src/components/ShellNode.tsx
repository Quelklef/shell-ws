import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { useState } from "react";

import { renderDisplay } from "../lib/format";
import { nodeHasInputPort, nodePreviewTabs } from "../lib/nodePorts";
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
    <div className="autorun-shell">
      <div className="autorun-label">auto run</div>
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
  const autoRun = model.autoRun ?? {
    enabled: false,
    mode: "push" as const,
    intervalMs: 1000,
  };
  const display = runtime.display ? renderDisplay(runtime.display.bytes) : null;
  const [activePreviewTab, setActivePreviewTab] = useState<PortKind | null>(
    null,
  );
  const previewTabs = nodePreviewTabs(model.kind);
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
          style={{ top: 96 }}
        />
      )}
      {(model.kind === "script" ||
        model.kind === "exec" ||
        model.kind === "cat" ||
        model.kind === "text" ||
        model.kind === "display" ||
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
        model.kind === "cat") &&
        outputHandle("stderr", 128, "stderr", runtime.portActivity.stderr)}

      <div className="node-comment-floating">
        <textarea
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
          <span>{model.kind.replaceAll("_", " ")}</span>
          <span>{runtime.running ? "running" : "idle"}</span>
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
            <textarea
              className="script-editor nodrag nopan"
              value={(model.args ?? []).join("\n")}
              placeholder="arguments, one per line"
              onWheelCapture={(event) => event.stopPropagation()}
              onChange={(event) =>
                typedData.onUpdate(model.id, {
                  args: event.target.value
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </>
        )}

        {model.kind === "cat" && (
          <input
            className="shell-input nodrag nopan"
            value={model.path ?? ""}
            onWheelCapture={(event) => event.stopPropagation()}
            onChange={(event) =>
              typedData.onUpdate(model.id, { path: event.target.value })
            }
            placeholder="file path"
          />
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
            className="display-pane nodrag nopan"
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div className="display-label">{display?.label ?? "display"}</div>
            {display?.content ?? (
              <div className="display-empty">stdin is quiet</div>
            )}
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
            className={`nodrag nopan ${autoRun.enabled ? "is-live" : ""}`}
            onClick={() =>
              typedData.onToggleAutorun(model.id, {
                ...autoRun,
                enabled: !autoRun.enabled,
              })
            }
          >
            {autoRun.enabled ? "auto on" : "auto"}
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

        {autoRun.enabled && (
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
      </div>
    </div>
  );
}
