import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";

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
        model.kind.startsWith("merge_")) &&
        outputHandle("stdout", 84, runtime.portActivity.stdout)}
      {model.kind !== "text" &&
        model.kind !== "display" &&
        outputHandle("stderr", 128, runtime.portActivity.stderr)}

      <div className="node-card">
        <div className="node-comment">
          <textarea
            className="nodrag nopan"
            value={model.comment}
            placeholder="comment"
            onChange={(event) =>
              typedData.onUpdate(model.id, {
                comment: event.target.value,
              })
            }
          />
        </div>
        <input
          className="node-title nodrag nopan"
          value={model.title}
          onChange={(event) =>
            typedData.onUpdate(model.id, { title: event.target.value })
          }
        />
        <div className="node-meta">
          <span>{model.kind.replaceAll("_", " ")}</span>
          <span>{runtime.running ? "running" : "idle"}</span>
        </div>

        {(model.kind === "process" || model.kind === "merge_shell") && (
          <>
            <input
              className="shell-input nodrag nopan"
              value={model.shell ?? "bash"}
              onChange={(event) =>
                typedData.onUpdate(model.id, { shell: event.target.value })
              }
              placeholder="shell"
            />
            <textarea
              className="script-editor nodrag nopan"
              value={model.script ?? ""}
              placeholder="shell snippet"
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
            onChange={(event) =>
              typedData.onUpdate(model.id, { text: event.target.value })
            }
          />
        )}

        {model.kind === "display" && (
          <div className="display-pane">
            <div className="display-label">{display?.label ?? "display"}</div>
            {display?.content ?? (
              <div className="display-empty">stdin is quiet</div>
            )}
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
